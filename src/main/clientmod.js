'use strict';

/**
 * SallyClient mod distribution.
 *
 * The jar is published on sallyclient.stream: `/api/latest` describes the
 * current build (version, file, size, sha256) and `/download/client/<file>`
 * serves it. The launcher mirrors the newest jar into its userData folder and
 * injects that copy, so a new client mod reaches every installed launcher
 * without shipping a new setup.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BASE_URL = 'https://sallyclient.stream';
const LATEST_URL = `${BASE_URL}/api/latest`;
const USER_AGENT = 'SallyLauncher/1.0 (sallylauncher)';
const CHECK_TTL = 10 * 60 * 1000;
const RETRY_TTL = 60 * 1000;

let cacheRoot = '';
let lastCheck = { at: 0, ok: false, build: null, error: null };

/** Electron's userData folder; a temp folder for plain node (tests). */
function resolveCacheDir() {
  if (cacheRoot) return cacheRoot;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      cacheRoot = path.join(app.getPath('userData'), 'client-mods');
      return cacheRoot;
    }
  } catch {
    /* plain node – unit tests and scripts */
  }
  cacheRoot = path.join(os.tmpdir(), 'sallylauncher-client-mods');
  return cacheRoot;
}

function setCacheDir(dir) {
  cacheRoot = dir ? String(dir) : '';
}

function absolute(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${BASE_URL}${value.startsWith('/') ? '' : '/'}${value}`;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalize(payload) {
  const client = payload && (payload.client || payload);
  if (!client || !client.version) throw new Error('sallyclient.stream returned no client build');
  const url = absolute(client.url);
  if (!url) throw new Error('sallyclient.stream returned no download for the client build');
  let name = String(client.file || '').trim();
  if (!name) {
    try {
      name = path.basename(decodeURIComponent(new URL(url).pathname));
    } catch {
      name = 'sallyclient.jar';
    }
  }
  name = path.basename(name);
  return {
    version: String(client.version),
    minecraft: String(client.minecraft || ''),
    file: name.toLowerCase().endsWith('.jar') ? name : `${name}.jar`,
    size: Number(client.size) || 0,
    sha256: String(client.sha256 || '').toLowerCase(),
    url
  };
}

/** `/api/latest`, remembered for a few minutes so every launch stays cheap. */
async function latest({ force = false } = {}) {
  const age = Date.now() - lastCheck.at;
  const ttl = lastCheck.ok ? CHECK_TTL : RETRY_TTL;
  if (!force && lastCheck.at && age < ttl) {
    if (lastCheck.ok) return lastCheck.build;
    throw new Error(lastCheck.error);
  }
  try {
    const res = await fetch(LATEST_URL, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`sallyclient.stream answered HTTP ${res.status}`);
    const build = normalize(await res.json());
    lastCheck = { at: Date.now(), ok: true, build, error: null };
    return build;
  } catch (err) {
    lastCheck = { at: Date.now(), ok: false, build: lastCheck.build, error: err.message };
    throw err;
  }
}

async function matchesBuild(file, build) {
  try {
    const stat = await fsp.stat(file);
    if (build.size && stat.size !== build.size) return false;
    if (!build.sha256) return true;
    return (await hashFile(file)) === build.sha256;
  } catch {
    return false;
  }
}

async function download(build, { onLog = () => {} } = {}) {
  const dir = resolveCacheDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, build.file);
  const partial = `${target}.part`;
  onLog(`Downloading SallyClient ${build.version}…`);
  const res = await fetch(build.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok || !res.body) {
    throw new Error(`sallyclient.stream answered HTTP ${res.status} for ${build.file}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial));
    const size = (await fsp.stat(partial)).size;
    if (build.size && size !== build.size) {
      throw new Error(`SallyClient ${build.version} arrived with ${size} bytes, expected ${build.size}`);
    }
    if (build.sha256) {
      const digest = await hashFile(partial);
      if (digest !== build.sha256) throw new Error('The downloaded SallyClient build failed its checksum');
    }
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => {});
    throw err;
  }
  await fsp.rm(target, { force: true }).catch(() => {});
  await fsp.rename(partial, target);
  /* exactly one client jar is kept – older builds are dead weight */
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (name === build.file || !/^sallyclient-.*\.jar$/i.test(name)) continue;
    await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
  return { ...build, path: target, downloaded: true };
}


/** Newest complete jar already mirrored to disk, used when the CDN is down. */
async function cachedJar() {
  const dir = resolveCacheDir();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    if (!/^sallyclient-.*.jar$/i.test(name)) continue;
    const file = path.join(dir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile() || !stat.size) continue;
    found.push({ path: file, version: name.replace(/^sallyclient-/i, '').replace(/.jar$/i, ''), at: stat.mtimeMs });
  }
  found.sort((a, b) => b.at - a.at);
  return found[0] || null;
}

/** Newest jar on disk, downloading it when the published build changed. */
async function ensure({ onLog = () => {}, force = false } = {}) {
  let build = null;
  try {
    build = await latest({ force });
  } catch (err) {
    /* Offline or the CDN is down: an already mirrored jar still works. */
    const cached = await cachedJar();
    if (!cached) throw err;
    onLog(`sallyclient.stream unreachable – using cached ${cached.version}`);
    return { ...cached, downloaded: false, stale: true };
  }
  const target = path.join(resolveCacheDir(), build.file);
  if (!force && (await matchesBuild(target, build))) {
    return { ...build, path: target, downloaded: false };
  }
  try {
    return await download(build, { onLog });
  } catch (err) {
    const cached = await cachedJar();
    if (!cached) throw err;
    onLog(`Download failed (${err.message}) – using cached ${cached.version}`);
    return { ...cached, downloaded: false, stale: true };
  }
}

function status() {
  return { ...lastCheck };
}

module.exports = { BASE_URL, ensure, latest, status, setCacheDir, resolveCacheDir, cachedJar };
