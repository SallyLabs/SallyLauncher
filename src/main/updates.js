'use strict';

/**
 * GitHub release checks for https://github.com/SallyLabs/SallyLauncher.
 *
 * The launcher asks the public GitHub API for the newest release, compares its
 * tag with the running app version and – when the user asks for it – downloads
 * the Windows installer from the release and starts it.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPO = 'SallyLabs/SallyLauncher';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const USER_AGENT = 'SallyLauncher-Updater';

/** "v1.2.3" / "1.2.3-beta" -> [1,2,3] */
function versionParts(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isNewer(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
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

function normalize(release, currentVersion) {
  const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
  return {
    available: isNewer(latestVersion, currentVersion),
    currentVersion,
    latestVersion,
    name: release.name || release.tag_name || latestVersion,
    notes: String(release.body || '').slice(0, 1200),
    publishedAt: release.published_at || null,
    htmlUrl: release.html_url || RELEASES_PAGE,
    prerelease: Boolean(release.prerelease),
    asset: pickAsset(release)
  };
}

async function fetchRelease() {
  const res = await fetch(RELEASE_API, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/vnd.github+json' }
  });
  if (res.status === 404) {
    return {
      error: 'No release found. Publish a release on GitHub to make updates available.',
      missing: true
    };
  }
  if (res.status === 403 || res.status === 429) {
    return { error: 'GitHub is rate-limiting the update check. Try again in a few minutes.' };
  }
  if (!res.ok) return { error: `GitHub answered HTTP ${res.status}.` };
  const release = await res.json();
  if (!release || release.draft) return { error: 'The latest GitHub release is still a draft.' };
  return { release };
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
      error: `Could not reach GitHub: ${err.message}`,
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
  const res = await fetch(update.asset.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
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

module.exports = { REPO, RELEASES_PAGE, check, downloadInstaller, isNewer };
