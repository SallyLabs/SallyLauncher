'use strict';

/**
 * Minecraft core for SallyLauncher: version manifest handling, asset/library
 * downloads, argument building and process launching. Talks to the official
 * Mojang endpoints only.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn, spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES_URL = 'https://resources.download.minecraft.net/';
const LAUNCHER_NAME = 'SallyLauncher';

let manifestCache = null;
/* Version files, libraries and assets are shared by all instances; the game
   itself keeps its own folder per profile. */
let sharedRoot = '';

function setSharedDir(dir) {
  sharedRoot = dir ? String(dir) : '';
}

function runtimeDir(gameDir) {
  return sharedRoot || gameDir;
}

/* ------------------------------------------------------------------ utils */

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': `${LAUNCHER_NAME}/1.0` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function osArch() {
  return process.arch === 'ia32' ? 'x86' : 'x86_64';
}

function artifactPath(name, classifier) {
  const parts = name.split(':');
  const [group, artifact, version] = parts;
  const cls = classifier || parts[3];
  const fileName = `${artifact}-${version}${cls ? '-' + cls : ''}.jar`;
  return path.join(group.replace(/\./g, '/'), artifact, version, fileName);
}

function ruleAllows(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!rule) continue;
    if (rule.action !== 'allow' && rule.action !== 'disallow') continue;
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName()) matches = false;
      if (rule.os.arch && rule.os.arch !== osArch()) matches = false;
      if (rule.os.version && !new RegExp(rule.os.version).test(process.getSystemVersion?.() || '')) matches = false;
    }
    if (rule.features) {
      for (const [key, value] of Object.entries(rule.features)) {
        const actual = Boolean(features[key]);
        if (actual !== Boolean(value)) {
          matches = false;
          break;
        }
      }
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function flattenArgs(list, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (entry && Array.isArray(entry.value)) {
      if (ruleAllows(entry.rules, features)) out.push(...entry.value);
    } else if (entry && typeof entry.value === 'string') {
      if (ruleAllows(entry.rules, features)) out.push(entry.value);
    }
  }
  return out;
}

function substitute(arg, vars) {
  return String(arg).replace(/\$\{([^}]+)\}/g, (_m, key) => (vars[key] === undefined ? '' : String(vars[key])));
}

/* -------------------------------------------------------------- versions */

async function getManifest(gameDir, { refresh = false } = {}) {
  if (!refresh && manifestCache && Date.now() - manifestCache.at < 10 * 60 * 1000) {
    return manifestCache.data;
  }
  const cacheFile = path.join(runtimeDir(gameDir), 'versions', 'version_manifest_v2.json');
  try {
    const data = await fetchJson(MANIFEST_URL);
    manifestCache = { at: Date.now(), data };
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(data), 'utf8');
    } catch {
      /* cache write is best effort */
    }
    return data;
  } catch (err) {
    try {
      const raw = await fsp.readFile(cacheFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      throw new Error(`Mojang servers unreachable and no cached version list: ${err.message}`);
    }
  }
}

async function readLocalVersionJson(gameDir, id) {
  const dir = path.join(runtimeDir(gameDir), 'versions', id);
  const preferred = path.join(dir, `${id}.json`);
  try {
    return { json: JSON.parse(await fsp.readFile(preferred, 'utf8')), file: preferred };
  } catch {
    /* try other json files in the folder */
  }
  try {
    const entries = await fsp.readdir(dir);
    for (const name of entries.filter((n) => n.toLowerCase().endsWith('.json'))) {
      const full = path.join(dir, name);
      try {
        const json = JSON.parse(await fsp.readFile(full, 'utf8'));
        if (json && (json.id || json.inheritsFrom || json.mainClass)) return { json, file: full };
      } catch {
        /* ignore broken file */
      }
    }
  } catch {
    /* directory missing */
  }
  return null;
}

async function loadVersionJson(gameDir, id, { onLog = () => {} } = {}) {
  const local = await readLocalVersionJson(gameDir, id);
  if (local) return local.json;

  const manifest = await getManifest(gameDir);
  const entry = (manifest.versions || []).find((v) => v.id === id);
  if (!entry) throw new Error(`Version "${id}" is not in the Mojang version list`);
  onLog(`Downloading version metadata for ${id} …`);
  const json = await fetchJson(entry.url);
  try {
    const dir = path.join(runtimeDir(gameDir), 'versions', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(json, null, 2), 'utf8');
  } catch {
    /* read-only game dir – keep going */
  }
  return json;
}

function libraryKey(lib) {
  const parts = String(lib.name || '').split(':');
  const classifier = parts[3] || (lib.natives ? 'natives' : '');
  return `${parts[0]}:${parts[1]}${classifier ? ':' + classifier : ''}`;
}

async function resolveVersion(gameDir, id, opts = {}) {
  const chain = [];
  let current = id;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const json = await loadVersionJson(gameDir, current, opts);
    chain.push(json);
    current = json.inheritsFrom;
  }

  const base = chain[chain.length - 1];
  const child = chain[0];

  const libraries = new Map();
  for (const meta of [...chain].reverse()) {
    for (const lib of meta.libraries || []) libraries.set(libraryKey(lib), lib);
  }

  const args = { jvm: [], game: [] };
  for (const meta of [...chain].reverse()) {
    if (meta.arguments) {
      args.jvm.push(...(meta.arguments.jvm || []));
      args.game.push(...(meta.arguments.game || []));
    }
  }

  return {
    id,
    chain: chain.map((c) => c.id),
    type: child.type || base.type || 'release',
    mainClass: child.mainClass || base.mainClass,
    minecraftArguments: child.minecraftArguments || base.minecraftArguments || null,
    arguments: args.jvm.length || args.game.length ? args : null,
    libraries: [...libraries.values()],
    downloads: child.downloads || base.downloads,
    assetIndex: child.assetIndex || base.assetIndex,
    assets: child.assets || base.assets || 'legacy',
    javaVersion: child.javaVersion || base.javaVersion || null,
    logging: child.logging || base.logging || null,
    releaseTime: child.releaseTime || base.releaseTime
  };
}

function loaderOf(id) {
  const lower = id.toLowerCase();
  if (lower.includes('fabric')) return 'Fabric';
  if (lower.includes('neoforge')) return 'NeoForge';
  if (lower.includes('forge')) return 'Forge';
  if (lower.includes('quilt')) return 'Quilt';
  return 'Vanilla';
}

async function listVersions(gameDir, { refresh = false } = {}) {
  const installed = [];
  const installedDir = path.join(runtimeDir(gameDir), 'versions');
  try {
    const entries = await fsp.readdir(installedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readLocalVersionJson(gameDir, entry.name);
      if (!meta) continue;
      installed.push({
        id: entry.name,
        loader: loaderOf(entry.name),
        type: meta.json.type || 'release',
        releaseTime: meta.json.releaseTime || null
      });
    }
  } catch {
    /* no versions yet */
  }

  let available = [];
  let manifestError = null;
  try {
    const manifest = await getManifest(gameDir, { refresh });
    available = (manifest.versions || []).map((v) => ({
      id: v.id,
      type: v.type,
      releaseTime: v.releaseTime,
      loader: 'Vanilla'
    }));
  } catch (err) {
    manifestError = err.message;
  }

  return { installed, available, manifestError };
}

/* ------------------------------------------------------------- downloads */

function needsDownload(task) {
  if (!fs.existsSync(task.dest)) return true;
  const size = fs.statSync(task.dest).size;
  if (task.size) return size !== task.size;
  /* Maven artifacts carry no size in the version file – an existing file is
     good enough and avoids rewriting jars a running game may hold open. */
  return size === 0;
}

async function runPool(items, limit, worker) {
  let index = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function downloadOne(task) {
  await fsp.mkdir(path.dirname(task.dest), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(task.url, { headers: { 'User-Agent': `${LAUNCHER_NAME}/1.0` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${task.dest}.part`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      try {
        await fsp.rename(tmp, task.dest);
      } catch (err) {
        /* Windows refuses to replace a jar that a running game has mapped;
           if the file on disk is already complete we simply keep it. */
        const existing = await fsp.stat(task.dest).catch(() => null);
        if (existing && (!task.size || existing.size === task.size)) {
          await fsp.rm(tmp, { force: true });
          return;
        }
        throw err;
      }
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  throw new Error(`Download failed (${task.label || task.url}): ${lastError?.message || 'unknown error'}`);
}

async function downloadTasks(tasks, { label, onProgress = () => {}, concurrency = 8 } = {}) {
  const pending = tasks.filter(needsDownload);
  if (!pending.length) {
    onProgress({ label, done: tasks.length, total: tasks.length, finished: true });
    return;
  }
  const total = tasks.length;
  let done = total - pending.length;
  onProgress({ label, done, total });
  await runPool(pending, concurrency, async (task) => {
    task.label = task.label || path.basename(task.dest);
    await downloadOne(task);
    done += 1;
    onProgress({ label, done, total });
  });
}

function extractNatives(zipFile, targetDir, exclude = []) {
  const zip = new AdmZip(zipFile);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (exclude.some((pattern) => pattern.startsWith('META-INF') && name.startsWith('META-INF'))) continue;
    if (name.startsWith('META-INF/')) continue;
    if (!/\.(dll|so|dylib|jnilib)$/i.test(name)) continue;
    const dest = path.join(targetDir, path.basename(name));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, zip.readFile(entry));
  }
}

/* --------------------------------------------------------------- prepare */

async function prepareLaunch({ gameDir, versionId, settings, onProgress = () => {}, onLog = () => {} }) {
  const runtime = runtimeDir(gameDir);
  const versionDir = path.join(runtime, 'versions', versionId);
  const nativesDir = path.join(versionDir, 'natives');
  const librariesDir = path.join(runtime, 'libraries');
  const assetsDir = path.join(runtime, 'assets');

  onProgress({ label: 'Resolving version', done: 0, total: 1 });
  const meta = await resolveVersion(gameDir, versionId, { onLog });
  if (!meta.mainClass) throw new Error(`Version ${versionId} has no main class – the version file looks broken`);

  const features = {
    is_demo_user: Boolean(settings.demoMode),
    has_custom_resolution: Boolean(settings.customResolution),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };

  /* --- client jar */
  const clientJar = path.join(versionDir, `${versionId}.jar`);
  /* A Forge install brings its own patched client jar – never replace it with
     the vanilla one. */
  const keepClientJar = /forge/i.test(versionId) && fs.existsSync(clientJar);
  const tasks = [];
  if (meta.downloads?.client?.url && !keepClientJar) {
    tasks.push({
      url: meta.downloads.client.url,
      dest: clientJar,
      size: meta.downloads.client.size,
      sha1: meta.downloads.client.sha1,
      label: `${versionId}.jar`
    });
  }

  /* --- libraries */
  const classpath = [];
  const nativeArchives = [];
  for (const lib of meta.libraries) {
    if (!ruleAllows(lib.rules, features)) continue;
    const downloads = lib.downloads || {};
    if (downloads.artifact?.url) {
      const dest = path.join(librariesDir, downloads.artifact.path || artifactPath(lib.name));
      tasks.push({
        url: downloads.artifact.url,
        dest,
        size: downloads.artifact.size,
        sha1: downloads.artifact.sha1
      });
      classpath.push(dest);
    } else if (lib.name) {
      const [group, artifact, version, classifier] = String(lib.name).split(':');
      if (group && artifact && version) {
        const relative = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
        const baseUrl = lib.url || 'https://maven.fabricmc.net/';
        const url = downloads.artifact?.url || `${String(baseUrl).replace(/\/+$/, '')}/${relative}`;
        const dest = path.join(librariesDir, downloads.artifact?.path || relative);
        tasks.push({
          url,
          dest,
          size: downloads.artifact?.size || lib.size,
          sha1: downloads.artifact?.sha1 || lib.sha1
        });
        classpath.push(dest);
      }
    }
    if (lib.natives) {
      let classifier = lib.natives[osName()];
      if (classifier) {
        classifier = classifier.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
        const artifact = downloads.classifiers?.[classifier];
        if (artifact?.url) {
          const dest = path.join(librariesDir, artifact.path || artifactPath(lib.name, classifier));
          tasks.push({ url: artifact.url, dest, size: artifact.size, sha1: artifact.sha1 });
          nativeArchives.push({ dest, extract: lib.extract });
        }
      }
    }
  }

  await downloadTasks(tasks, { label: 'Libraries', onProgress });
  onLog(`Libraries ready (${classpath.length} jars)`);

  /* --- assets */
  const assetIndex = meta.assetIndex;
  const assetsIndexName = assetIndex?.id || meta.assets || 'legacy';
  if (assetIndex?.url) {
    const indexDest = path.join(assetsDir, 'indexes', `${assetIndex.id}.json`);
    await downloadTasks(
      [{ url: assetIndex.url, dest: indexDest, size: assetIndex.size, sha1: assetIndex.sha1, label: `${assetIndex.id}.json` }],
      { label: 'Asset index', onProgress }
    );
    try {
      const index = JSON.parse(await fsp.readFile(indexDest, 'utf8'));
      const objects = Object.values(index.objects || {});
      const assetTasks = objects.map((obj) => ({
        url: `${RESOURCES_URL}${obj.hash.slice(0, 2)}/${obj.hash}`,
        dest: path.join(assetsDir, 'objects', obj.hash.slice(0, 2), obj.hash),
        size: obj.size
      }));
      await downloadTasks(assetTasks, { label: 'Assets', onProgress, concurrency: 16 });
      onLog(`Assets ready (${objects.length} objects)`);
    } catch (err) {
      onLog(`Could not read asset index: ${err.message}`);
    }
  }

  /* --- natives */
  if (nativeArchives.length) {
    await fsp.mkdir(nativesDir, { recursive: true });
    for (const archive of nativeArchives) {
      try {
        extractNatives(archive.dest, nativesDir, archive.extract?.exclude || []);
      } catch (err) {
        onLog(`Natives extraction failed for ${path.basename(archive.dest)}: ${err.message}`);
      }
    }
    onLog(`Natives extracted (${nativeArchives.length} archives)`);
  }

  /* --- arguments */
  if (fs.existsSync(clientJar)) classpath.push(clientJar);

  const vars = {
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: '1.0.0',
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    game_directory: gameDir,
    assets_root: assetsDir,
    game_assets: path.join(assetsDir, 'virtual', 'legacy'),
    assets_index_name: assetsIndexName,
    version_name: versionId,
    version_type: meta.type,
    user_properties: '{}',
    library_directory: librariesDir,
    resolution_width: settings.resolutionWidth,
    resolution_height: settings.resolutionHeight,
    auth_player_name: settings.playerName || 'Player',
    auth_uuid: settings.playerUuid || '0',
    auth_access_token: settings.accessToken || '0',
    auth_session: settings.accessToken || '-',
    clientid: 'sallylauncher',
    auth_xuid: settings.xuid || '0',
    user_type: settings.userType || 'legacy'
  };

  let jvmArgs = meta.arguments ? flattenArgs(meta.arguments.jvm, features) : null;
  if (!jvmArgs || !jvmArgs.length) {
    jvmArgs = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
  }
  let gameArgs = meta.arguments ? flattenArgs(meta.arguments.game, features) : null;
  if (!gameArgs || !gameArgs.length) {
    gameArgs = (meta.minecraftArguments || '').split(/\s+/).filter(Boolean);
  }

  jvmArgs = jvmArgs.map((a) => substitute(a, vars));
  gameArgs = gameArgs.map((a) => substitute(a, vars));

  if (settings.fullscreen && !gameArgs.includes('--fullscreen')) {
    gameArgs.push('--fullscreen');
  }
  if (settings.autoConnect && settings.serverAddress) {
    const [host, port] = String(settings.serverAddress).split(':');
    gameArgs.push('--server', host, '--port', port || '25565');
  }

  const memory = Math.max(1024, Math.min(32768, Number(settings.memoryMb) || 4096));
  const memoryArgs = [`-Xmx${memory}M`, `-Xms${Math.max(512, Math.floor(memory / 2))}M`];
  const extraArgs = String(settings.jvmArgs || '')
    .split(/\s+/)
    .filter(Boolean);

  const finalArgs = [
    ...memoryArgs,
    ...jvmArgs,
    ...extraArgs,
    meta.mainClass,
    ...gameArgs
  ];

  return { meta, args: finalArgs, nativesDir, versionDir, classpath, assetsDir };
}

/* ---------------------------------------------------------------- launch */

/** One session per profile key, so several profiles can play side by side. */
const sessions = new Map();

function launch({ key = 'default', gameDir, versionId, settings, javaPath, account, onProgress, onLog, onExit }) {
  return new Promise(async (resolve, reject) => {
    if (sessions.has(key)) {
      reject(new Error('This profile is already running'));
      return;
    }
    sessions.set(key, { process: null, versionId, startedAt: Date.now() });
    try {
      const prepared = await prepareLaunch({
        gameDir,
        versionId,
        settings: {
          ...settings,
          playerName: account?.name,
          playerUuid: account?.uuid,
          accessToken: account?.accessToken || '',
          userType: account?.type === 'msa' ? 'msa' : 'legacy',
          xuid: account?.xuid || ''
        },
        onProgress,
        onLog
      });

      onProgress({ label: 'Starting Minecraft', done: 1, total: 1 });
      const child = spawn(javaPath, prepared.args, {
        cwd: gameDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const session = sessions.get(key) || {};
      session.process = child;
      session.versionId = versionId;
      session.pid = child.pid;
      sessions.set(key, session);

      const drop = () => {
        if (sessions.get(key)?.process === child) sessions.delete(key);
      };

      child.stdout.on('data', (chunk) => onLog(chunk.toString().replace(/\r/g, '')));
      child.stderr.on('data', (chunk) => onLog(chunk.toString().replace(/\r/g, '')));

      child.on('error', (err) => {
        drop();
        reject(new Error(`Could not start Java: ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        drop();
        onLog(`Minecraft exited (${signal ? `signal ${signal}` : `code ${code}`})`);
        onExit({ code, signal });
      });

      resolve({ pid: child.pid });
    } catch (err) {
      sessions.delete(key);
      reject(err);
    }
  });
}

/**
 * The javapath shim starts the real java.exe as its child, so killing only the
 * spawned pid would leave Minecraft running. Windows needs the whole tree.
 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/** Stops one profile's game, or every running game when no key is given. */
function stop(key) {
  if (key) {
    const session = sessions.get(key);
    if (!session?.process) return false;
    killTree(session.process.pid);
    sessions.delete(key);
    return true;
  }
  let killed = false;
  for (const [id, session] of [...sessions]) {
    if (session.process) {
      killTree(session.process.pid);
      killed = true;
    }
    sessions.delete(id);
  }
  return killed;
}

function status() {
  const instances = [...sessions.entries()].map(([key, session]) => ({
    key,
    versionId: session.versionId,
    pid: session.pid || null,
    startedAt: session.startedAt || null
  }));
  return {
    running: [...sessions.values()].some((session) => Boolean(session.process)),
    versionId: instances.length ? instances[instances.length - 1].versionId : null,
    instances
  };
}

module.exports = {
  setSharedDir,
  listVersions,
  resolveVersion,
  prepareLaunch,
  launch,
  stop,
  status,
  getManifest,
  ruleAllows,
  flattenArgs
};
