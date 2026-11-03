'use strict';

/**
 * Public Modrinth API integration for project search and mod/modpack installs.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const AdmZip = require('adm-zip');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'SallyLauncher/1.0 (sallylauncher)';

function publicProject(project) {
  if (!project) return null;
  return {
    id: project.project_id || project.id,
    slug: project.slug,
    title: project.title,
    description: project.description || '',
    iconUrl: project.icon_url || null,
    downloads: project.downloads || 0,
    follows: project.followers || 0,
    author: project.author || '',
    categories: project.categories || [],
    projectType: project.project_type || '',
    versions: project.versions || []
  };
}

async function api(pathname, { query } = {}) {
  const url = new URL(`${MODRINTH_API}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const headers = { 'User-Agent': USER_AGENT, accept: 'application/json' };
  const res = await fetch(url, { headers });
  if (res.status === 404) throw new Error('Modrinth could not find that project.');
  if (!res.ok) throw new Error(`Modrinth returned HTTP ${res.status}`);
  return res.json();
}

/* --------------------------------------------------------------- searching */

async function search({ query = '', projectType = 'modpack', gameVersion = '', loader = 'fabric', limit = 12, offset = 0 } = {}) {
  const facets = [];
  if (projectType) facets.push([`project_type:${projectType}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);
  const data = await api('/search', {
    query: {
      query,
      limit: String(limit),
      offset: String(offset),
      index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify(facets)
    }
  });
  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map(publicProject)
  };
}

async function projectVersions(projectId, { gameVersion = '', loader = 'fabric' } = {}) {
  const query = {};
  if (gameVersion) query.game_versions = JSON.stringify([gameVersion]);
  if (loader) query.loaders = JSON.stringify([loader]);
  const versions = await api(`/project/${encodeURIComponent(projectId)}/version`, { query });
  return Array.isArray(versions) ? versions : [];
}

function primaryFile(version) {
  if (!version) return null;
  const files = version.files || [];
  return files.find((file) => file.primary) || files[0] || null;
}

/* -------------------------------------------------------------- downloads */

/** How many files are fetched at the same time – packs often list 100+ files. */
const PACK_CONCURRENCY = 8;

/** Runs `worker` over every item with at most `limit` jobs in flight. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Drops progress updates down to `ms` so IPC and the UI stay smooth. The last
 * value is never lost: it is sent by the timer or by `flush()`.
 */
function throttleProgress(onProgress, ms = 120) {
  let last = 0;
  let pending = null;
  let timer = null;
  const emit = () => {
    if (!pending) return;
    const payload = pending;
    pending = null;
    last = Date.now();
    onProgress(payload);
  };
  const push = (payload) => {
    pending = payload;
    if (Date.now() - last >= ms) emit();
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, ms);
      timer.unref?.();
    }
  };
  push.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    emit();
  };
  return push;
}

async function download(url, dest, { onProgress = () => {}, label = '', attempts = 3 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) – ${label || url}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let done = 0;
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      if (total) {
        const stream = Readable.fromWeb(res.body);
        stream.on('data', (chunk) => {
          done += chunk.length;
          onProgress({ label: label || path.basename(dest), done, total });
        });
        await pipeline(stream, out);
      } else {
        await pipeline(Readable.fromWeb(res.body), out);
      }
      await fsp.rm(dest, { force: true });
      await fsp.rename(tmp, dest);
      return dest;
    } catch (err) {
      lastError = err;
      await fsp.rm(`${dest}.part`, { force: true }).catch(() => {});
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

/** Installs one mod jar into `<gameDir>/mods`. Returns the file name. */
async function installMod({ projectId, versionId, gameDir, gameVersion, loader = 'fabric', onLog = () => {}, onProgress = () => {} }) {
  const versions = await projectVersions(projectId, { gameVersion, loader });
  let version = versions.find((entry) => entry.id === versionId) || versions[0];
  if (!version) {
    throw new Error(
      `No build of this project supports Minecraft ${gameVersion || '(unknown)'}${loader ? ` with ${loader}` : ''}.`
    );
  }
  const file = primaryFile(version);
  if (!file?.url) throw new Error('This version has no downloadable file.');
  const target = path.join(gameDir, 'mods', file.filename);
  onLog(`Downloading ${file.filename}`);
  await download(file.url, target, { onProgress, label: file.filename });
  onLog(`Installed ${file.filename}`);
  return { file: file.filename, version: version.version_number, name: version.name };
}

function readIndex(zip) {
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('This file is not a Modrinth pack (modrinth.index.json is missing).');
  return JSON.parse(zip.readAsText(entry));
}

/** Only the metadata, so a profile can be created before anything is downloaded. */
function readPackIndex(filePath) {
  const zip = new AdmZip(filePath);
  const index = readIndex(zip);
  const dependencies = index.dependencies || {};
  return {
    name: index.name || path.basename(filePath).replace(/\.mrpack$/i, ''),
    packVersion: index.versionId || '1.0.0',
    minecraft: dependencies.minecraft || null,
    fabricLoader: dependencies['fabric-loader'] || null,
    files: (index.files || []).length
  };
}

/**
 * Downloads every file listed in the pack index and unpacks the overrides.
 * Files are fetched concurrently (PACK_CONCURRENCY at a time) and progress is
 * throttled, so a 200-mod pack finishes in a fraction of the old time.
 */
async function applyPack(zip, index, gameDir, { onLog = () => {}, onProgress = () => {} } = {}) {
  const progress = throttleProgress(onProgress);
  const files = (index.files || []).filter((entry) => !entry.env || entry.env.client !== 'unsupported');
  let done = 0;
  const failed = [];

  const report = () => progress({ label: 'Modpack files', done, total: files.length });
  report();

  await mapLimit(files, PACK_CONCURRENCY, async (entry) => {
    const url = (entry.downloads || [])[0];
    const relative = String(entry.path || '').replace(/^\/+/, '');
    if (url && relative && !relative.includes('..')) {
      const target = path.join(gameDir, relative);
      try {
        const stat = await fsp.stat(target).catch(() => null);
        const alreadyThere = stat && entry.fileSize ? stat.size === entry.fileSize : false;
        if (!alreadyThere) await download(url, target, { attempts: 3 });
      } catch (err) {
        failed.push(relative);
        onLog(`Could not download ${relative}: ${err.message}`);
      }
    }
    done += 1;
    report();
  });

  progress.flush();
  onLog(`Pack files ready (${done - failed.length}/${files.length})`);
  if (failed.length && failed.length === files.length) {
    throw new Error('Every pack file failed to download – check your connection and try again.');
  }

  /* overrides: read once, write in parallel batches */
  const overrides = [];
  for (const folder of ['overrides', 'client-overrides']) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.startsWith(`${folder}/`)) continue;
      const relative = entry.entryName.slice(folder.length + 1);
      if (!relative || relative.includes('..')) continue;
      overrides.push({ entry, relative });
    }
  }
  if (overrides.length) {
    let copied = 0;
    progress({ label: 'Pack overrides', done: 0, total: overrides.length });
    await mapLimit(overrides, PACK_CONCURRENCY, async ({ entry, relative }) => {
      const target = path.join(gameDir, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, zip.readFile(entry));
      copied += 1;
      progress({ label: 'Pack overrides', done: copied, total: overrides.length });
    });
    progress.flush();
    onLog(`Pack overrides applied (${copied} files)`);
  }

  return files.length;
}

/** Imports a downloaded .mrpack file straight into an instance folder. */
async function installPackFile({ filePath, gameDir, onLog = () => {}, onProgress = () => {} }) {
  const zip = new AdmZip(filePath);
  const index = readIndex(zip);
  const files = await applyPack(zip, index, gameDir, { onLog, onProgress });
  const dependencies = index.dependencies || {};
  return {
    name: index.name || path.basename(filePath),
    packVersion: index.versionId || '1.0.0',
    minecraft: dependencies.minecraft || null,
    fabricLoader: dependencies['fabric-loader'] || null,
    files
  };
}

/**
 * Imports a Modrinth pack (.mrpack) into an instance folder: downloads every
 * listed file and copies the pack overrides.
 */
async function installModpack({ projectId, versionId, gameDir, gameVersion, loader = 'fabric', onLog = () => {}, onProgress = () => {} }) {
  const versions = await projectVersions(projectId, { gameVersion, loader });
  let version = versions.find((entry) => entry.id === versionId);
  if (!version) version = versions[0];
  if (!version) {
    throw new Error(`This pack has no version for Minecraft ${gameVersion || '(unknown)'}${loader ? ` with ${loader}` : ''}.`);
  }
  const file = primaryFile(version);
  if (!file?.url) throw new Error('This pack version has no downloadable file.');

  const tmpDir = path.join(gameDir, '.sallypack');
  await fsp.mkdir(tmpDir, { recursive: true });
  const packPath = path.join(tmpDir, file.filename);
  onLog(`Downloading pack ${file.filename}`);
  await download(file.url, packPath, { onProgress, label: file.filename });

  const zip = new AdmZip(packPath);
  const index = readIndex(zip);
  const files = await applyPack(zip, index, gameDir, { onLog, onProgress });
  await fsp.rm(packPath, { force: true });

  const dependencies = index.dependencies || {};
  return {
    name: index.name || version.name,
    packVersion: index.versionId || version.version_number,
    minecraft: dependencies.minecraft || gameVersion || null,
    fabricLoader: dependencies['fabric-loader'] || null,
    files
  };
}

module.exports = {
  publicProject,
  search,
  projectVersions,
  installMod,
  installModpack,
  readPackIndex,
  installPackFile
};
