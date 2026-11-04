'use strict';

/**
 * Mod-loader pipelines for instances.
 *
 * Vanilla needs nothing, Fabric only needs a version JSON next to the vanilla
 * files (and that JSON is published as metadata), Forge ships a headless
 * installer that patches the vanilla client jar – it is started with the Java
 * runtime the launcher already detects, in a staging folder, so the shared
 * runtime keeps a clean vanilla jar.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const USER_AGENT = 'SallyLauncher/1.0 (sallylauncher)';

const LOADERS = [
  { id: 'vanilla', label: 'Vanilla', hint: 'Plain Minecraft, no loader' },
  { id: 'fabric', label: 'Fabric', hint: 'Light and quick – what SallyClient runs on' },
  { id: 'forge', label: 'Forge', hint: 'Classic loader for large modpacks' }
];

/* Metadata is small and stable, so one fetch per session is enough. */
const cache = new Map();

async function fetchText(url) {
  if (!cache.has(url)) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
    cache.set(url, await res.text());
  }
  return cache.get(url);
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function normalizeLoader(value) {
  const id = String(value || '').toLowerCase();
  return LOADERS.some((entry) => entry.id === id) ? id : 'fabric';
}

/** "fabric-loader-0.16.9-1.20.1" / "1.20.1-forge-47.2.0" -> "1.20.1" */
function minecraftVersionOf(versionId) {
  const id = String(versionId || '');
  const fabric = /^(?:fabric|quilt)-loader-[\d.]+-(.+)$/.exec(id);
  if (fabric) return fabric[1];
  const forge = /^(.+)-forge-[\d.]+$/.exec(id);
  if (forge) return forge[1];
  return id;
}

function versionIdFor(loader, mcVersion, loaderVersion) {
  const id = normalizeLoader(loader);
  if (id === 'fabric') return `fabric-loader-${loaderVersion}-${mcVersion}`;
  if (id === 'forge') return `${mcVersion}-forge-${loaderVersion}`;
  return mcVersion;
}

function isInstalled(runtimeDir, versionId) {
  return fs.existsSync(path.join(runtimeDir, 'versions', versionId, `${versionId}.json`));
}

/* --------------------------------------------------------------- metadata */

async function fabricLoaders(mcVersion) {
  const list = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`Fabric has no loader for Minecraft ${mcVersion}`);
  }
  return list
    .map((entry) => ({ version: entry.loader?.version, stable: Boolean(entry.loader?.stable) }))
    .filter((entry) => entry.version);
}

async function forgeLoaders(mcVersion) {
  const [xml, promos] = await Promise.all([
    fetchText(`${FORGE_MAVEN}/maven-metadata.xml`),
    fetchJson(FORGE_PROMOS).catch(() => ({}))
  ]);
  const prefix = `${mcVersion}-`;
  const versions = [];
  for (const match of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
    if (match[1].startsWith(prefix)) versions.push(match[1].slice(prefix.length));
  }
  if (!versions.length) throw new Error(`Forge has no build for Minecraft ${mcVersion}`);
  const recommended = promos?.promos?.[`${mcVersion}-recommended`] || null;
  const latest = promos?.promos?.[`${mcVersion}-latest`] || null;
  return versions.map((version) => ({
    version,
    recommended: version === recommended,
    latest: version === latest
  }));
}

/** Loader builds for one Minecraft version. Vanilla has no builds to choose. */
async function versions({ loader, mcVersion } = {}) {
  const id = normalizeLoader(loader);
  if (!mcVersion) return { loader: id, mcVersion: null, versions: [] };
  if (id === 'vanilla') return { loader: id, mcVersion, versions: [] };
  const list = id === 'fabric' ? await fabricLoaders(mcVersion) : await forgeLoaders(mcVersion);
  return { loader: id, mcVersion, versions: list };
}

function pickVersion(list, requested) {
  if (requested && list.some((entry) => entry.version === requested)) return requested;
  const preferred = list.find((entry) => entry.recommended) || list.find((entry) => entry.stable) || list[0];
  return preferred?.version || null;
}

/* -------------------------------------------------------------- utilities */

async function downloadFile(url, dest, { label = 'Download', onProgress = () => {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let last = 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - last > 200) {
      last = now;
      onProgress({ label, done, total });
    }
  });
  const tmp = `${dest}.part`;
  await pipeline(stream, fs.createWriteStream(tmp));
  await fsp.rm(dest, { force: true });
  await fsp.rename(tmp, dest);
  onProgress({ label, done: done || total, total: total || done, finished: true });
  return dest;
}

/** Copies a tree, keeping files that already exist (libraries are shared). */
async function mergeTree(source, target) {
  let copied = 0;
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copied += await mergeTree(from, to);
      continue;
    }
    if (fs.existsSync(to)) continue;
    await fsp.mkdir(target, { recursive: true });
    await fsp.copyFile(from, to);
    copied += 1;
  }
  return copied;
}

function runInstaller(javaPath, args, { cwd, onLog = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(javaPath || 'java', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    let tail = '';
    let lines = 0;
    const absorb = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lines += 1;
        /* The installer is extremely chatty – keep the log readable. */
        if (lines <= 12 || lines % 250 === 0 || /error|fail|success/i.test(trimmed)) onLog(`forge: ${trimmed}`);
      }
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(tail);
        return;
      }
      const detail = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
      reject(new Error(`The Forge installer failed (exit ${code})${detail ? `: ${detail}` : ''}`));
    });
  });
}

/* ---------------------------------------------------------------- install */

async function installFabric({ mcVersion, loaderVersion, runtimeDir, onLog = () => {} }) {
  const list = await fabricLoaders(mcVersion);
  const version = pickVersion(list, loaderVersion);
  const versionId = versionIdFor('fabric', mcVersion, version);
  const dir = path.join(runtimeDir, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  if (!fs.existsSync(file)) {
    const profile = await fetchJson(`${FABRIC_META}/versions/loader/${mcVersion}/${version}/profile/json`);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
    onLog(`Fabric ${version} for Minecraft ${mcVersion} installed`);
  }
  return { versionId, loaderVersion: version };
}

async function installForge({ mcVersion, loaderVersion, runtimeDir, javaPath, onLog = () => {}, onProgress = () => {} }) {
  const list = await forgeLoaders(mcVersion);
  const version = pickVersion(list, loaderVersion);
  const versionId = versionIdFor('forge', mcVersion, version);
  if (isInstalled(runtimeDir, versionId)) {
    return { versionId, loaderVersion: version, installed: true };
  }

  /* The installer patches the vanilla jar in place, so it runs against a
     staging folder and only the results are merged into the shared runtime. */
  const staging = path.join(runtimeDir, 'forge-install', versionId);
  await fsp.mkdir(path.join(staging, 'libraries'), { recursive: true });
  const profilesFile = path.join(staging, 'launcher_profiles.json');
  if (!fs.existsSync(profilesFile)) {
    await fsp.writeFile(profilesFile, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf8');
  }

  const installer = path.join(runtimeDir, 'cache', `forge-${versionId}-installer.jar`);
  if (!fs.existsSync(installer)) {
    const url = `${FORGE_MAVEN}/${mcVersion}-${version}/forge-${mcVersion}-${version}-installer.jar`;
    onLog(`Downloading the Forge ${version} installer for Minecraft ${mcVersion}`);
    await downloadFile(url, installer, { label: 'Forge installer', onProgress });
  }

  onLog(`Installing Forge ${version} for Minecraft ${mcVersion} – this takes a minute`);
  await runInstaller(javaPath, ['-jar', installer, '--installClient', staging], { cwd: staging, onLog });

  const stagedVersion = path.join(staging, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(stagedVersion)) {
    throw new Error(`The Forge installer did not create ${versionId}. Check the log for details.`);
  }
  await mergeTree(path.join(staging, 'versions', versionId), path.join(runtimeDir, 'versions', versionId));
  await mergeTree(path.join(staging, 'libraries'), path.join(runtimeDir, 'libraries'));

  /* Forge patches versions/<minecraft>/<minecraft>.jar – that patched jar
     belongs to the Forge version, the vanilla one stays untouched. */
  const patched = path.join(staging, 'versions', mcVersion, `${mcVersion}.jar`);
  const target = path.join(runtimeDir, 'versions', versionId, `${versionId}.jar`);
  if (fs.existsSync(patched)) {
    await fsp.copyFile(patched, target);
  } else if (!fs.existsSync(target)) {
    onLog(`Forge did not report a patched client jar for ${versionId} – keeping the vanilla one`);
  }

  await fsp.rm(staging, { recursive: true, force: true });
  onLog(`Forge ${version} for Minecraft ${mcVersion} installed`);
  return { versionId, loaderVersion: version, installed: false };
}

/**
 * Makes sure the requested loader build exists in `runtimeDir` and returns the
 * version id the launcher has to start.
 */
async function ensure({ loader, mcVersion, loaderVersion, runtimeDir, javaPath, onLog = () => {}, onProgress = () => {} } = {}) {
  const id = normalizeLoader(loader);
  const mc = minecraftVersionOf(mcVersion);
  if (!mc) throw new Error('Pick a Minecraft version first.');
  if (id === 'vanilla') return { versionId: mc, loaderVersion: null };
  if (id === 'fabric') return installFabric({ mcVersion: mc, loaderVersion, runtimeDir, onLog });
  return installForge({ mcVersion: mc, loaderVersion, runtimeDir, javaPath, onLog, onProgress });
}

module.exports = {
  LOADERS,
  ensure,
  versions,
  isInstalled,
  minecraftVersionOf,
  normalizeLoader,
  versionIdFor
};
