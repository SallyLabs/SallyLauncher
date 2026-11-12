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
const clientmod = require('./clientmod');

const BUNDLED_MODS_DIR = path.join(__dirname, '..', '..', 'assets', 'mods');
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const MODRINTH_API = 'https://api.modrinth.com/v2';

/* jar mirrored from sallyclient.stream, set by prepareClientMods */
let externalClientJar = '';

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
  return satisfiesMinecraft(range, mcVersion);
}

/** "26.3-rc.1" -> { numbers: [26, 3], pre: ['rc', 1] } */
function versionInfo(value) {
  const clean = String(value || '')
    .trim()
    .replace(/^[vV]/, '')
    .split('+')[0];
  const dash = clean.indexOf('-');
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? [] : clean.slice(dash + 1).split('.').filter(Boolean);
  const numbers = core
    .split('.')
    .filter((part) => part !== '')
    .map((part) => parseInt(part, 10) || 0);
  return { numbers, pre };
}

function versionParts(value) {
  return versionInfo(value).numbers;
}

function compareVersions(a, b) {
  const left = versionInfo(a);
  const right = versionInfo(b);
  const size = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < size; i += 1) {
    const l = left.numbers[i] ?? 0;
    const r = right.numbers[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  /* a release always wins against its own pre-releases (26.3 > 26.3-rc.1) */
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const count = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < count; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
      continue;
    }
    if (lNum !== rNum) return lNum ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Stricter check used before parking someone else's jar: only says "no" when
 * the declared range clearly excludes the version. Understands "||" chains,
 * space separated constraint lists (">=26.3 <27"), wildcards (26.3.x / 26.3.*),
 * pre-releases (>=26.3-rc.1) plus ~, ^, >=, <=, >, < and exact pins.
 */
function satisfiesMinecraft(range, mcVersion) {
  if (!range || range === '*') return true;
  const version = String(mcVersion || '').trim();
  if (!version) return true;
  return String(range)
    .split('||')
    .some((alternative) => {
      const tokens = alternative.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return true;
      return tokens.every((token) => tokenMatchesMinecraft(token, version));
    });
}

function tokenMatchesMinecraft(token, version) {
  const match = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(token);
  if (!match) return true;
  const op = match[1] || '=';
  const raw = match[2].trim();
  if (!raw || raw === '*') return true;
  /* 26.3.x and 26.3.* describe the whole patch line */
  const wildcard = /^(.*?)[.]?[xX*]$/.exec(raw);
  if (wildcard && op === '=') {
    const base = wildcard[1].replace(/[.]+$/, '');
    if (!base) return true;
    return version === base || version.startsWith(`${base}.`) || version.startsWith(`${base}-`);
  }
  const target = raw.replace(/[-+.]+$/, '') || raw;
  const cmp = compareVersions(version, target);
  if (op === '>=') return cmp >= 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  /* ~26.3 / ^26.3 / exact pin: same release line, plus newer patch levels */
  return version === target || version.startsWith(`${target}.`) || version.startsWith(`${target}-`);
}

function readModInfo(full, file) {
  const info = { file, path: full, id: file, name: file.replace(/.jar$/i, ''), version: '', minecraft: '*', requiresFabricApi: false };
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
  return info;
}

function readBundledMods() {
  const mods = [];
  let entries = [];
  try {
    entries = fs.readdirSync(BUNDLED_MODS_DIR).filter((name) => name.toLowerCase().endsWith('.jar'));
  } catch {
    /* the shipped folder is optional – a mirrored jar still counts */
  }
  const jars = entries.map((name) => path.join(BUNDLED_MODS_DIR, name));
  if (externalClientJar && fs.existsSync(externalClientJar)) jars.push(externalClientJar);
  for (const full of jars) {
    const file = path.basename(full);
    /* the mirrored jar replaces the one shipped with the launcher */
    if (externalClientJar && full !== externalClientJar && /^sallyclient-.*.jar$/i.test(file)) continue;
    mods.push(readModInfo(full, file));
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
  /* an older client jar left behind would be a duplicate mod id for Fabric */
  if (externalClientJar) {
    const current = path.basename(externalClientJar);
    for (const name of await fsp.readdir(modsDir).catch(() => [])) {
      if (name === current || !/^sallyclient-.*.jar$/i.test(name)) continue;
      await fsp.rm(path.join(modsDir, name), { force: true }).catch(() => {});
      onLog(`Removed outdated client jar ${name}`);
    }
    for (const name of await fsp.readdir(parkedDir).catch(() => [])) {
      if (!/^sallyclient-.*.jar$/i.test(name)) continue;
      await fsp.rm(path.join(parkedDir, name), { force: true }).catch(() => {});
    }
  }
  return { modsDir, injected, skipped };
}
/**
 * Puts the mirrored client jar into one profile without preparing a launch.
 * Used at startup for every Fabric profile the current build supports.
 */
async function syncClientMod({ gameDir, versionId, onLog = () => {} } = {}) {
  if (!gameDir || !versionId) return null;
  const mcVersion = baseMinecraftVersion(versionId);
  const build = await clientmod.ensure({ onLog });
  if (!build || !build.path || !fs.existsSync(build.path)) return null;
  const file = path.basename(build.path);
  const info = readModInfo(build.path, file);
  if (!matchesMinecraft(info.minecraft, mcVersion)) return null;
  const modsDir = path.join(gameDir, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });
  const changed = await copyIfNeeded(build.path, path.join(modsDir, file));
  externalClientJar = build.path;
  for (const name of await fsp.readdir(modsDir).catch(() => [])) {
    if (name === file || !/^sallyclient-.*.jar$/i.test(name)) continue;
    await fsp.rm(path.join(modsDir, name), { force: true }).catch(() => {});
    onLog('Removed outdated client jar ' + name);
  }
  return { file, version: build.version, updated: changed, modsDir };
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
async function prepareClientMods({ gameDir, versionId, enabled, runtimeDir = '', loader = 'fabric', loaderVersion = '', onLog = () => {} }) {
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

  const kind = String(loader || 'fabric').toLowerCase();
  report.loader = kind;
  if (kind !== 'fabric') {
    /* Forge and vanilla load their jars themselves – nothing is injected or parked. */
    try {
      await fsp.mkdir(path.join(gameDir, 'mods'), { recursive: true });
    } catch {
      /* the game creates the folder on demand anyway */
    }
    return report;
  }

  /* newest client build from sallyclient.stream – never blocks a launch */
  try {
    const build = await clientmod.ensure({ onLog });
    if (build && build.path) {
      externalClientJar = build.path;
      report.clientBuild = { version: build.version, file: build.file, updated: Boolean(build.downloaded) };
      if (build.downloaded) onLog('SallyClient ' + build.version + ' installed from sallyclient.stream');
    }
  } catch (err) {
    onLog('SallyClient update skipped: ' + err.message);
  }

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

/** Points the injector at the jar mirrored from sallyclient.stream. */
function useClientJar(file) {
  externalClientJar = file ? String(file) : '';
  return externalClientJar;
}

module.exports = {
  prepareClientMods,
  syncClientMod,
  useClientJar,
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
