'use strict';

/**
 * GitHub release checks for https://github.com/SallyLabs/SallyLauncher.
 *
 * The launcher asks the GitHub API for the newest releases, compares the tag
 * with the running app version and – when the user asks for it – downloads the
 * Windows installer from the release and starts it.
 *
 * The release list is used instead of `/releases/latest`, because that endpoint
 * hides pre-releases. For a private repository a token can be supplied through
 * `SALLY_GITHUB_TOKEN`; without it GitHub answers 404 for anonymous requests.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPO = 'SallyLabs/SallyLauncher';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const USER_AGENT = 'SallyLauncher-Updater';
/* GitHub answers 502/503/504 often enough that one request is not enough. */
const RETRY_DELAYS = [800, 2000, 4000];
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { headers = {}, timeoutMs = 15000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      if (!RETRYABLE_STATUS.has(res.status)) return res;
      lastError = new Error(`GitHub is currently unavailable (HTTP ${res.status}).`);
      await res.arrayBuffer().catch(() => {});
    } catch (error) {
      lastError =
        error?.name === 'AbortError'
          ? new Error('GitHub did not answer in time.')
          : new Error(`Could not reach GitHub: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[attempt]);
  }
  throw lastError || new Error('Could not reach GitHub.');
}

/** "v1.2.3" / "1.2.3-beta" -> [1,2,3]; a tag without a number ("v-b.001") -> null */
function versionParts(value) {
  const match = String(value || '')
    .trim()
    .match(/^v?(\d+(?:\.\d+)*)/i);
  if (!match) return null;
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (!a || !b) return false;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

function pickAsset(release) {
  const assets = release?.assets || [];
  const windows = assets.filter((asset) => /\.(exe|msi)$/i.test(asset.name || ''));
  const preferred =
    windows.find((asset) => /setup|installer|sallylauncher.*\.exe$/i.test(asset.name)) || windows[0] || null;
  if (!preferred) return null;
  return { name: preferred.name, url: preferred.browser_download_url, size: preferred.size || 0 };
}

/**
 * The small update payload: the packed app.asar alone. Replacing it updates the
 * launcher in place instead of reinstalling the whole ~180 MB setup.
 */
function pickPatchAsset(release) {
  const assets = release?.assets || [];
  const asar = assets.find((asset) => /\.asar$/i.test(asset.name || ''));
  if (!asar) return null;
  return { name: asar.name, url: asar.browser_download_url, size: asar.size || 0 };
}

function normalize(release, currentVersion) {
  const tag = String(release.tag_name || '').trim();
  const latestVersion = (tag || String(release.name || '')).replace(/^v(?=\d)/i, '') || currentVersion;
  /* Tags like "v-b.001" carry no comparable version – treat any other tag as an update. */
  const comparable = Boolean(versionParts(latestVersion) && versionParts(currentVersion));
  return {
    available: comparable ? isNewer(latestVersion, currentVersion) : latestVersion !== currentVersion,
    currentVersion,
    latestVersion,
    name: release.name || release.tag_name || latestVersion,
    notes: String(release.body || '').slice(0, 1200),
    publishedAt: release.published_at || null,
    htmlUrl: release.html_url || RELEASES_PAGE,
    prerelease: Boolean(release.prerelease),
    asset: pickAsset(release),
    patch: pickPatchAsset(release)
  };
}

function releaseHeaders() {
  const headers = { 'User-Agent': USER_AGENT, accept: 'application/vnd.github+json' };
  const token = String(process.env.SALLY_GITHUB_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchRelease() {
  const res = await fetchWithRetry(RELEASES_API, { headers: releaseHeaders() });
  if (res.status === 404) {
    return {
      error:
        `GitHub did not answer for ${REPO} (404). A private repository cannot be checked anonymously – ` +
        'make the repository public or set SALLY_GITHUB_TOKEN.',
      missing: true
    };
  }
  if (res.status === 401) {
    return { error: 'The GitHub token for the update check was rejected (401).' };
  }
  if (res.status === 403 || res.status === 429) {
    return { error: 'GitHub is rate-limiting the update check. Try again in a few minutes.' };
  }
  if (!res.ok) return { error: `GitHub answered HTTP ${res.status}.` };
  const body = await res.json();
  const releases = (Array.isArray(body) ? body : [])
    .filter((entry) => entry && !entry.draft)
    .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
  if (!releases.length) {
    return {
      error: 'No release found. Publish a release on GitHub to make updates available.',
      missing: true
    };
  }
  return { release: releases[0] };
}

/** Fetches the newest public release and compares it with `currentVersion`. */
async function check({ currentVersion }) {
  try {
    const result = await fetchRelease();
    if (result.error) {
      return {
        available: false,
        currentVersion,
        latestVersion: currentVersion,
        error: result.error,
        noRelease: Boolean(result.missing),
        checkedAt: new Date().toISOString(),
        repo: REPO,
        releasesUrl: RELEASES_PAGE
      };
    }
    return {
      ...normalize(result.release, currentVersion),
      error: null,
      noRelease: false,
      checkedAt: new Date().toISOString(),
      repo: REPO,
      releasesUrl: RELEASES_PAGE
    };
  } catch (err) {
    return {
      available: false,
      currentVersion,
      latestVersion: currentVersion,
      error: /GitHub/.test(String(err?.message)) ? err.message : `Could not reach GitHub: ${err.message}`,
      checkedAt: new Date().toISOString(),
      repo: REPO,
      releasesUrl: RELEASES_PAGE
    };
  }
}

/** Streams the release installer into the temp folder and returns its path. */
async function downloadInstaller(update, { targetDir, onProgress = () => {} } = {}) {
  if (!update?.asset?.url) {
    throw new Error('This release has no Windows installer attached. Open the release page instead.');
  }
  await fsp.mkdir(targetDir, { recursive: true });
  const dest = path.join(targetDir, update.asset.name.replace(/[^\w.-]+/g, '-'));
  const res = await fetchWithRetry(update.asset.url, { headers: { 'User-Agent': USER_AGENT }, timeoutMs: 30000 });
  if (!res.ok) {
    throw new Error(
      `Download failed (HTTP ${res.status}). Try again later or install the setup file from the release page manually.`
    );
  }
  const total = Number(res.headers.get('content-length')) || update.asset.size || 0;
  let done = 0;
  let last = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - last > 150 || done === total) {
      last = now;
      onProgress({ label: 'SallyLauncher update', done, total });
    }
  });
  const tmp = `${dest}.part`;
  await pipeline(stream, fs.createWriteStream(tmp));
  await fsp.rm(dest, { force: true });
  await fsp.rename(tmp, dest);
  onProgress({ label: 'SallyLauncher update', done: done || total, total: total || done });
  return dest;
}

module.exports = { REPO, RELEASES_PAGE, check, downloadInstaller, isNewer, versionParts };
