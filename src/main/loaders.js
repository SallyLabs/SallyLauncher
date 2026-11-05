const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const USER_AGENT = { 'User-Agent': 'SallyLauncher/1.0 (sallylauncher)' };

const LOADERS = [
  {
    id: 'vanilla',
    name: 'Vanilla',
    description: 'Plain Minecraft – no loader, no mods.'
  },
  {
    id: 'fabric',
    name: 'Fabric',
    description: 'Lightweight loader, best for performance and client mods.'
  },
  {
    id: 'forge',
    name: 'Forge',
    description: 'Classic loader for large modpacks.'
  }
];

/** Accepts the ids used by the UI as well as the labels older versions stored. */
function normalizeLoader(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'fabric';
  if (raw === 'forge' || raw === 'neo' || raw === 'neoforge') return 'forge';
  if (raw === 'fabric') return 'fabric';
  if (raw === 'vanilla' || raw === 'none' || raw === 'official') return 'vanilla';
  return 'fabric';
}

function minecraftVersionOf(versionId) {
  const id = String(versionId || '').trim();
  const fabric = /^fabric-loader-[^-]+-(.+)$/i.exec(id);
  if (fabric) return fabric[1];
  const forge = /^(.+?)-forge-.+$/i.exec(id);
  if (forge) return forge[1];
  return id;
}

function forgeVersionOf(versionId) {
  const match = /^.+-forge-(.+)$/i.exec(String(versionId || '').trim());
  return match ? match[1] : '';
}

function isLoaderVersion(versionId) {
  return /^fabric-loader-/i.test(versionId || '') || /-forge-/i.test(versionId || '');
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: USER_AGENT });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: USER_AGENT });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function compareVersions(a, b) {
  const left = String(a).split(/[.\-+]/).map((p) => parseInt(p, 10) || 0);
  const right = String(b).split(/[.\-+]/).map((p) => parseInt(p, 10) || 0);
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** Loader builds offered for one Minecraft version. */
async function versions({ loader, mcVersion } = {}) {
  const kind = normalizeLoader(loader);
  const mc = String(mcVersion || '').trim();
  if (!mc) return { loader: kind, mcVersion: null, versions: [] };
  if (kind === 'vanilla') return { loader: kind, mcVersion: mc, versions: [{ version: mc, stable: true }] };

  if (kind === 'fabric') {
    const list = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`);
    const entries = (Array.isArray(list) ? list : [])
      .map((entry) => ({ version: entry.loader?.version, stable: Boolean(entry.loader?.stable) }))
      .filter((entry) => entry.version);
    const recommended = entries.find((entry) => entry.stable)?.version || entries[0]?.version || '';
    return { loader: kind, mcVersion: mc, versions: entries, recommended };
  }

  /* Forge publishes every build under <mc>-<forge> inside one maven metadata file. */
  const xml = await fetchText(`${FORGE_MAVEN}/maven-metadata.xml`);
  const builds = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim())
    .filter((value) => value.startsWith(`${mc}-`))
    .map((value) => value.slice(mc.length + 1))
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
  let recommended = builds[0] || '';
  try {
    const promos = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    recommended = promos?.promos?.[`${mc}-recommended`] || promos?.promos?.[`${mc}-latest`] || recommended;
  } catch {
    /* the promotions file is optional */
  }
  return {
    loader: kind,
    mcVersion: mc,
    versions: builds.map((version) => ({ version, stable: version === recommended })),
    recommended
  };
}

async function downloadFile(url, dest, { onProgress = () => {} } = {}) {
  const res = await fetch(url, { headers: USER_AGENT });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let received = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (total) onProgress({ percent: Math.round((received / total) * 100), task: path.basename(dest) });
  });
  await pipeline(source, fs.createWriteStream(`${dest}.part`));
  await fsp.rename(`${dest}.part`, dest);
}

/** Fabric's loader profile JSON has to sit next to the vanilla files. */
async function ensureFabric({ mcVersion, loaderVersion = '', runtimeDir, onLog = () => {} }) {
  let chosen = String(loaderVersion || '').trim();
  if (!chosen) {
    const list = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
    const stable = (Array.isArray(list) ? list : []).find((entry) => entry.loader?.stable);
    chosen = stable?.loader?.version || list?.[0]?.loader?.version;
  }
  if (!chosen) throw new Error(`Fabric has no loader for Minecraft ${mcVersion}`);

  const versionId = `fabric-loader-${chosen}-${mcVersion}`;
  const dir = path.join(runtimeDir, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  if (!fs.existsSync(file)) {
    const profile = await fetchJson(
      `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(chosen)}/profile/json`
    );
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
    onLog(`Fabric ${chosen} for Minecraft ${mcVersion} installed`);
  }
  return { versionId, loaderVersion: chosen };
}

function runProcess(command, args, { cwd, onLog = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    child.stdout?.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => onLog(line)));
    child.stderr?.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => onLog(line)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Forge installer exited with code ${code}`));
    });
  });
}

/**
 * Forge ships an installer instead of a ready profile. It is run headless into
 * the shared runtime folder, so the libraries it needs end up where the
 * launcher resolves them.
 */
async function ensureForge({ mcVersion, loaderVersion = '', runtimeDir, javaPath, onLog = () => {}, onProgress = () => {} }) {
  let chosen = String(loaderVersion || '').trim();
  if (!chosen) {
    const list = await versions({ loader: 'forge', mcVersion });
    chosen = list.recommended || list.versions[0]?.version;
  }
  if (!chosen) throw new Error(`Forge has no build for Minecraft ${mcVersion}`);

  const versionId = `${mcVersion}-forge-${chosen}`;
  const target = path.join(runtimeDir, 'versions', versionId, `${versionId}.json`);
  if (fs.existsSync(target)) return { versionId, loaderVersion: chosen };
  if (!javaPath) throw new Error('Installing Forge needs a Java runtime – set one in Settings.');

  const build = `${mcVersion}-${chosen}`;
  const cacheDir = path.join(runtimeDir, 'forge-installers');
  const jar = path.join(cacheDir, `forge-${build}-installer.jar`);
  if (!fs.existsSync(jar)) {
    onLog(`Downloading Forge ${chosen} for Minecraft ${mcVersion}`);
    await downloadFile(`${FORGE_MAVEN}/${build}/forge-${build}-installer.jar`, jar, { onProgress });
  }

  onLog(`Installing Forge ${chosen} (this can take a minute)`);
  await runProcess(javaPath, ['-jar', jar, '--installClient', runtimeDir], { cwd: cacheDir, onLog });
  if (!fs.existsSync(target)) throw new Error(`Forge installer did not create ${versionId}`);
  onLog(`Forge ${chosen} for Minecraft ${mcVersion} installed`);
  return { versionId, loaderVersion: chosen };
}

/**
 * Makes sure the loader build a profile needs exists locally and returns the
 * version id to launch.
 */
async function ensure({ loader, mcVersion, loaderVersion = '', runtimeDir, javaPath = null, onLog = () => {}, onProgress = () => {} } = {}) {
  const kind = normalizeLoader(loader);
  const mc = String(mcVersion || '').trim();
  if (!mc) throw new Error('Pick a Minecraft version first.');
  if (kind === 'vanilla') return { versionId: mc, loader: kind, loaderVersion: '' };
  if (kind === 'fabric') {
    const info = await ensureFabric({ mcVersion: mc, loaderVersion, runtimeDir, onLog });
    return { ...info, loader: kind };
  }
  const info = await ensureForge({ mcVersion: mc, loaderVersion, runtimeDir, javaPath, onLog, onProgress });
  return { ...info, loader: kind };
}

module.exports = {
  LOADERS,
  normalizeLoader,
  minecraftVersionOf,
  forgeVersionOf,
  isLoaderVersion,
  versions,
  ensure,
  ensureFabric,
  ensureForge
};
