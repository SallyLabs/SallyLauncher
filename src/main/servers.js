'use strict';

/**
 * SallyClient server list.
 *
 * The Sally server publishes the curated list from SallyClient-Extras at
 * `/extras/servers.json` together with an ETag, and serves the banners right
 * next to it. The list changes rarely, so the launcher answers from disk and
 * only asks again after the TTL; a 304 keeps the cached copy.
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const USER_AGENT = 'SallyLauncher/1.0 (sallylauncher)';
/* the list is served by the Sally server; the website host is a fallback in
   case the extras get proxied there later */
const HOSTS = ['https://presence.sallyclient.stream', 'https://sallyclient.stream'];
const LIST_PATH = '/extras/servers.json';
const BANNER_PATH = '/extras/banners/';
const TTL = 5 * 60 * 1000;
const TIMEOUT = 10000;

let cacheFile = '';

function resolveCacheFile() {
  if (cacheFile) return cacheFile;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      cacheFile = path.join(app.getPath('userData'), 'servers.json');
      return cacheFile;
    }
  } catch {
    /* plain node – unit tests and scripts */
  }
  cacheFile = path.join(os.tmpdir(), 'sallylauncher-servers.json');
  return cacheFile;
}

function setCacheFile(file) {
  cacheFile = file ? String(file) : '';
}

function normalize(raw, host) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const address = String(raw.address || '').trim();
  if (!name || !address) return null;
  const banner = String(raw.banner || '').trim();
  return {
    id: String(raw.id || address),
    name: name.slice(0, 64),
    address,
    description: String(raw.description || '').slice(0, 200),
    languages: Array.isArray(raw.languages) ? raw.languages.map((lang) => String(lang)).slice(0, 4) : [],
    featured: Boolean(raw.featured),
    banner: banner ? `${host}${BANNER_PATH}${encodeURIComponent(banner)}` : null
  };
}

async function readCache() {
  try {
    return JSON.parse(await fsp.readFile(resolveCacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  const file = resolveCacheFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(payload), 'utf8');
}

function result(servers, fetchedAt, fromCache, error) {
  return { servers, fetchedAt, fromCache, error: error || null };
}

async function list({ force = false } = {}) {
  const cache = await readCache();
  const age = cache?.fetchedAt ? Date.now() - cache.fetchedAt : Infinity;
  if (!force && cache?.servers?.length && age < TTL) {
    return result(cache.servers, cache.fetchedAt, true, null);
  }

  let lastError = null;
  for (const host of HOSTS) {
    try {
      const headers = { 'User-Agent': USER_AGENT, accept: 'application/json' };
      if (cache?.etag) headers['if-none-match'] = cache.etag;
      const res = await fetch(`${host}${LIST_PATH}`, { headers, signal: AbortSignal.timeout(TIMEOUT) });
      if (res.status === 304 && cache?.servers?.length) {
        const stored = { ...cache, fetchedAt: Date.now(), host };
        await writeCache(stored);
        return result(stored.servers, stored.fetchedAt, true, null);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const entries = Array.isArray(body?.servers) ? body.servers : [];
      const servers = entries.map((entry) => normalize(entry, host)).filter(Boolean);
      if (!servers.length) throw new Error('the server list is empty');
      const stored = { etag: res.headers.get('etag') || '', host, fetchedAt: Date.now(), servers };
      await writeCache(stored);
      return result(servers, stored.fetchedAt, false, null);
    } catch (err) {
      lastError = err;
    }
  }

  if (cache?.servers?.length) {
    return result(cache.servers, cache.fetchedAt, true, lastError?.message || null);
  }
  throw new Error(`Could not reach the SallyClient server list: ${lastError?.message || 'unknown error'}`);
}

module.exports = { HOSTS, list, setCacheFile, resolveCacheFile };
