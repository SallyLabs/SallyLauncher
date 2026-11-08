'use strict';

/**
 * Client-mod pipeline: ensures a Fabric loader exists for the selected
 * Minecraft version, keeps the bundled SallyClient jar (plus Fabric API) in the
 * profile's mods folder, and reports what actually got injected.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const AdmZip = require('adm-zip');

const BUNDLED_MODS_DIR = path.join(__dirname, '..', '..', 'assets', 'mods');
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const MODRINTH_API = 'https://api.modrinth.com/v2';

async function fetchJson(url) {
  const headers = { 'User-Agent': 'SallyLauncher/1.0 (sallylauncher)' };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function baseMinecraftVersion(versionId) {
  const match = /^fabric-loader-[\d.]+-(.+)$/.exec(String(versionId));
  if (match) return match[1];
  const quilt = /^quilt-loader-[\d.]+-(.+)$/.exec(String(versionId));
  if (quilt) return quilt[1];
  return String(versionId);
}

function isLoaderVersion(versionId) {
  return /-loader-/.test(String(versionId));
}

/** Simple match for Fabric dependency ranges such as "~26.3", ">=26.3" or "*". */
function matchesMinecraft(range, mcVersion) {
  if (!range || range === '*') return true;
  const cleaned = String(range).replace(/^[~^>=<]+/, '').trim();
  if (!cleaned) return true;
  return mcVersion === cleaned || mcVersion.startsWith(`${cleaned}.`) || mcVersion.startsWith(cleaned);
}

function versionParts(value) {
  const clean = String(value || '').trim().replace(/^[vV]/, '');
  return clean
    .split(/[.\-+]/)
    .map((part) => {
      const num = parseInt(part, 10);
      return Number.isFinite(num) ? num : 0;
    });
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Stricter check used before parking someone else's jar: only says "no" when
 * the declared range clearly excludes the version. Understands space separated
 * constraint lists (e.g. ">=26.3 <27") plus ~, ^, >=, <=, >, < and exact pins.
 */
function satisfiesMinecraft(range, mcVersion) {
  if (!range || range === '*') return true;
  const version = String(mcVersion || '').trim();
  if (!version) return true;
  const tokens = String(range).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((token) => {
    const match = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(token);
    if (!match) return true;
    const op = match[1] || '=';
    /* ranges such as "~26.3-" carry a trailing separator that is not part of the version */
    const target = match[2].trim().replace(/[-+.]+$/, '');
    if (!target) return true;
    const cmp = compareVersions(version, target);
    if (op === '>=') return cmp >= 0;
    if (op === '<=') return cmp <= 0;
    if (op === '>') return cmp > 0;
    if (op === '<') return cmp < 0;
    /* ~26.3 / ^26.3 / exact pin: the same release line, plus newer patch levels */
    return version === target || version.startsWith(`${target}.`) || version.startsWith(target);
  });
}

function readBundledMods() {
  const mods = [];
  let entries = [];
  try {
    entries = fs.readdirSync(BUNDLED_MODS_DIR).filter((name) => name.toLowerCase().endsWith('.jar'));
  } catch {
    return mods;
  }
  for (const file of entries) {
    const full = path.join(BUNDLED_MODS_DIR, file);
    const info = { file, path: full, id: file, name: file.replace(/\.jar$/i, ''), version: '', minecraft: '*', requiresFabricApi: false };
    try {
      const zip = new AdmZip(full);
      const entry = zip.getEntry('fabric.mod.json');
      if (entry) {
        const manifest = JSON.parse(zip.readAsText(entry));
        info.id = manifest.id || info.id;
        info.name = manifest.name || info.name;
        info.version = manifest.version || '';
        info.minecraft = manifest.depends?.minecraft || '*';
        info.requiresFabricApi = Boolean(manifest.depends?.['fabric-api']);
        info.description = manifest.description || '';
      }
    } catch (err) {
      info.error = err.message;
    }
    mods.push(info);
  }
  return mods;
}

function clientModReport(versionId) {
  const mcVersion = baseMinecraftVersion(versionId || '');
  const mods = readBundledMods().map((mod) => ({
    id: mod.id,
    name: mod.name,
    version: mod.version,
    file: mod.file,
    minecraft: mod.minecraft,
    requiresFabricApi: mod.requiresFabricApi,
    supported: versionId ? matchesMinecraft(mod.minecraft, mcVersion) : null
  }));
  return { mcVersion, mods };
}

async function ensureFabricVersion(gameDir, mcVersion, { onLog = () => {}, versionsDir = '' } = {}) {
  const loaders = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
  if (!Array.isArray(loaders) || !loaders.length) {
    throw new Error(`Fabric has no loader for Minecraft ${mcVersion}`);
  }
  const loader = loaders.find((entry) => entry.loader?.stable) || loaders[0];
  const loaderVersion = loader.loader?.version;
  const versionId = `fabric-loader-${loaderVersion}-${mcVersion}`;
  /* The loader profile has to land next to the vanilla version files, which
     live in the shared runtime folder, not inside the instance. */
  const dir = path.join(versionsDir || gameDir, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  if (!fs.existsSync(file)) {
    const profile = await fetchJson(`${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
    onLog(`Fabric ${loaderVersion} for Minecraft ${mcVersion} installed`);
  }
  return versionId;
}

async function copyIfNeeded(source, target) {
  try {
    const src = await fsp.stat(source);
    const dst = await fsp.stat(target);
    if (src.size === dst.size) return false;
  } catch {
    /* target missing */
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target);
  return true;
}

async function installBundledMods(gameDir, mcVersion, { onLog = () => {} } = {}) {
  const modsDir = path.join(gameDir, 'mods');
  const parkedDir = path.join(gameDir, 'mods-disabled');
  await fsp.mkdir(modsDir, { recursive: true });
  const injected = [];
  const skipped = [];
  for (const mod of readBundledMods()) {
    const supported = matchesMinecraft(mod.minecraft, mcVersion);
    if (supported) {
      const target = path.join(modsDir, mod.file);
      const changed = await copyIfNeeded(mod.path, target);
      injected.push({ ...mod, supported, updated: changed });
      if (changed) onLog(`${mod.name} ${mod.version} added to ${target}`);
      continue;
    }
    /* Fabric refuses to boot when a mod's minecraft dependency is unmet, so an
       unsupported jar is parked instead of breaking the launch. */
    skipped.push(mod);
    const parked = path.join(parkedDir, mod.file);
    try {
      await copyIfNeeded(mod.path, parked);
      await fsp.rm(path.join(modsDir, mod.file), { force: true });
    } catch (err) {
      onLog(`Could not park ${mod.name}: ${err.message}`);
    }
    onLog(`${mod.name} ${mod.version} needs Minecraft ${mod.minecraft} – kept in mods-disabled for ${mcVersion}`);
  }
  return { modsDir, injected, skipped };
}

/** Windows refuses to rename onto an existing file, so parked copies are replaced. */
async function moveFile(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (err) {
      lastError = err;
      if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
        await fsp.rm(target, { force: true });
        continue;
      }
      if (err.code !== 'EBUSY') throw err;
      /* a running game still holds the jar mapped – give Windows a moment */
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Anything already sitting in `mods` that declares a different Minecraft
 * target would make Fabric refuse to boot the whole game, so those jars are
 * moved to `mods-disabled` before the launch. Bundled mods are handled by
 * installBundledMods; this covers foreign jars the user dropped in.
 */
async function parkIncompatibleMods(gameDir, mcVersion, { onLog = () => {}, keep = [] } = {}) {
  const modsDir = path.join(gameDir, 'mods');
  const parkedDir = path.join(gameDir, 'mods-disabled');
  const parked = [];
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir);
  } catch {
    return parked;
  }
  for (const file of entries) {
    if (!file.toLowerCase().endsWith('.jar')) continue;
    if (keep.includes(file)) continue;
    let manifest = null;
    try {
      const zip = new AdmZip(path.join(modsDir, file));
      const entry = zip.getEntry('fabric.mod.json');
      if (!entry) continue;
      manifest = JSON.parse(zip.readAsText(entry));
    } catch {
      continue;
    }
    const range = manifest?.depends?.minecraft;
    if (satisfiesMinecraft(range, mcVersion)) continue;
    const label = manifest?.name || file;
    try {
      await moveFile(path.join(modsDir, file), path.join(parkedDir, file));
      parked.push({ file, name: label, minecraft: range });
      onLog(`${label} needs Minecraft ${range} – moved to mods-disabled for ${mcVersion}`);
    } catch (err) {
      onLog(`Could not park ${label}: ${err.message}`);
    }
  }
  return parked;
}

/**
 * Reverse of parkIncompatibleMods: jars previously parked in `mods-disabled`
 * come back as soon as their Minecraft target matches again. Fabric API and the
 * bundled mods are skipped – those are managed by their own steps.
 */
async function restoreCompatibleMods(gameDir, mcVersion, { onLog = () => {}, skip = [] } = {}) {
  const modsDir = path.join(gameDir, 'mods');
  const parkedDir = path.join(gameDir, 'mods-disabled');
  const restored = [];
  let entries = [];
  try {
    entries = await fsp.readdir(parkedDir);
  } catch {
    return restored;
  }
  for (const file of entries) {
    if (!file.toLowerCase().endsWith('.jar')) continue;
    if (/^fabric-api-/i.test(file)) continue;
    if (skip.includes(file)) continue;
    let manifest = null;
    try {
      const zip = new AdmZip(path.join(parkedDir, file));
      const entry = zip.getEntry('fabric.mod.json');
      if (!entry) continue;
      manifest = JSON.parse(zip.readAsText(entry));
    } catch {
      continue;
    }
    const range = manifest?.depends?.minecraft;
    if (!satisfiesMinecraft(range, mcVersion)) continue;
    try {
      await fsp.mkdir(modsDir, { recursive: true });
      if (fs.existsSync(path.join(modsDir, file))) {
        await fsp.rm(path.join(parkedDir, file), { force: true });
        continue;
      }
      await moveFile(path.join(parkedDir, file), path.join(modsDir, file));
      const label = manifest?.name || file;
      restored.push({ file, name: label, minecraft: range });
      onLog(`${label} reactivated for Minecraft ${mcVersion}`);
    } catch (err) {
      onLog(`Could not restore ${file}: ${err.message}`);
    }
  }
  return restored;
}

async function downloadFile(url, dest) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'SallyLauncher/1.0 (sallylauncher)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error(`Download failed ${url}: ${lastError?.message || 'unknown'}`);
}

async function pruneStaleFabricApi(gameDir, keepName, { mcVersion, onLog = () => {} } = {}) {
  const modsDir = path.join(gameDir, 'mods');
  const parkedDir = path.join(gameDir, 'mods-disabled');
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (keepName && name === keepName) continue;
    if (mcVersion && name.includes(`+${mcVersion}`)) continue;
    if (!/^fabric-api-.*\.jar$/i.test(name)) continue;
    try {
      await moveFile(path.join(modsDir, name), path.join(parkedDir, name));
      onLog(`Fabric API ${name} parked (wrong Minecraft version)`);
    } catch (err) {
      onLog(`Could not park ${name}: ${err.message}`);
    }
  }
}

async function ensureFabricApi(gameDir, mcVersion, { onLog = () => {} } = {}) {
  const modsDir = path.join(gameDir, 'mods');
  const loaders = encodeURIComponent('["fabric"]');
  const gameVersions = encodeURIComponent(JSON.stringify([mcVersion]));
  const versions = await fetchJson(
    `${MODRINTH_API}/project/fabric-api/version?loaders=${loaders}&game_versions=${gameVersions}`
  );
  if (!Array.isArray(versions) || !versions.length) {
    onLog(`Fabric API has no build for Minecraft ${mcVersion} yet`);
    return null;
  }
  const version = versions[0];
  const file = (version.files || []).find((entry) => entry.primary) || version.files?.[0];
  if (!file?.url) return null;
  const target = path.join(modsDir, file.filename);
  await pruneStaleFabricApi(gameDir, file.filename, { mcVersion, onLog });
  const existing = fs.existsSync(target) && fs.statSync(target).size === file.size;
  if (!existing) {
    await downloadFile(file.url, target);
    onLog(`Fabric API ${version.version_number} added to ${target}`);
  }
  return { file: target, version: version.version_number };
}

/** Full preparation step used before a launch. Never throws for mod issues. */
async function prepareClientMods({ gameDir, versionId, enabled, runtimeDir = '', onLog = () => {} }) {
  const mcVersion = baseMinecraftVersion(versionId);
  const report = {
    enabled: Boolean(enabled),
    mcVersion,
    fabricVersionId: null,
    injected: [],
    skipped: [],
    parked: [],
    restored: [],
    fabricApi: null,
    error: null
  };
  if (!enabled) return report;

  try {
    report.fabricVersionId = isLoaderVersion(versionId)
      ? versionId
      : await ensureFabricVersion(gameDir, mcVersion, { onLog, versionsDir: runtimeDir });
    const injected = await installBundledMods(gameDir, mcVersion, { onLog });
    const bundledFiles = injected.injected.map((mod) => mod.file);
    report.restored = await restoreCompatibleMods(gameDir, mcVersion, { onLog, skip: bundledFiles });
    report.injected = injected.injected.map((mod) => ({ name: mod.name, version: mod.version, file: mod.file }));
    report.skipped = injected.skipped.map((mod) => ({ name: mod.name, minecraft: mod.minecraft }));
    report.parked = await parkIncompatibleMods(gameDir, mcVersion, {
      onLog,
      keep: bundledFiles
    });    const needsFabricApi = injected.injected.some((mod) => mod.requiresFabricApi);
    if (needsFabricApi) {
      report.fabricApi = await ensureFabricApi(gameDir, mcVersion, { onLog });
    } else if (injected.skipped.length) {
      /* Nothing of ours runs here – keep foreign Fabric API jars out of the way
         so two builds for different Minecraft versions cannot clash. */
      await pruneStaleFabricApi(gameDir, null, { mcVersion, onLog });
    }
  } catch (err) {
    report.error = err.message;
    onLog(`Client mod setup failed: ${err.message}`);
  }
  return report;
}

module.exports = {
  prepareClientMods,
  clientModReport,
  ensureFabricVersion,
  installBundledMods,
  parkIncompatibleMods,
  restoreCompatibleMods,
  ensureFabricApi,
  baseMinecraftVersion,
  matchesMinecraft,
  satisfiesMinecraft,
  readBundledMods
};
