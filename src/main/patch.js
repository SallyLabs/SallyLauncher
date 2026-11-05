'use strict';

/**
 * In-place updates.
 *
 * A release ships the packed `app.asar` as its own asset. Updating means
 * replacing exactly that one file inside the installation instead of running
 * the 180 MB setup again – no reinstall, no wiped settings.
 *
 * The running launcher cannot overwrite its own asar (Electron keeps it open),
 * so the swap runs in a detached batch script that waits for the launcher to
 * exit. Only the launcher process ends: Minecraft runs as its own java process
 * and keeps going.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { app } = require('electron');

const USER_AGENT = 'SallyLauncher-Updater';

/** `<install>/resources` – the folder that holds app.asar and the payload. */
function resourcesDir() {
  return path.dirname(app.getAppPath());
}

function packagedAsar() {
  const file = path.join(resourcesDir(), 'app.asar');
  return fs.existsSync(file) ? file : null;
}

/** Only a packaged installation can be patched in place. */
function canPatch() {
  return app.isPackaged && Boolean(packagedAsar());
}

async function download(url, dest, { onProgress = () => {}, size = 0 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  let done = 0;
  let last = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - last > 150 || done === total) {
      last = now;
      onProgress({ label: 'SallyLauncher update', done, total: total || done });
    }
  });
  await pipeline(stream, fs.createWriteStream(dest));
  return done;
}

/**
 * Writes the batch script that swaps the asar once this process is gone and
 * starts the launcher again.
 */
async function scheduleSwap({ source, target, exePath, pid }) {
  const script = path.join(os.tmpdir(), `sallylauncher-update-${Date.now()}.cmd`);
  const lines = [
    '@echo off',
    'setlocal',
    `set "PID=${pid}"`,
    `set "NEW=${source}"`,
    `set "TARGET=${target}"`,
    `set "EXE=${exePath}"`,
    ':wait',
    'timeout /t 1 /nobreak >nul',
    'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul && goto wait',
    'attrib -R "%TARGET%" >nul 2>&1',
    'move /Y "%NEW%" "%TARGET%" >nul 2>&1',
    'if errorlevel 1 goto retry',
    'goto start',
    ':retry',
    'timeout /t 2 /nobreak >nul',
    'move /Y "%NEW%" "%TARGET%" >nul 2>&1',
    ':start',
    'start "" "%EXE%"',
    'del "%~f0" >nul 2>&1'
  ];
  await fsp.writeFile(script, `${lines.join('\r\n')}\r\n`, 'utf8');
  return script;
}

/**
 * Downloads the new asar, prepares the swap and quits the launcher so the file
 * is free. Running games are untouched.
 */
async function apply(update, { onProgress = () => {} } = {}) {
  if (!canPatch()) throw new Error('This installation cannot be updated in place – use the installer instead.');
  const asset = update?.patch;
  if (!asset?.url) throw new Error('This release has no app.asar attached – open the release page instead.');

  const target = packagedAsar();
  const staging = `${target}.new`;
  await fsp.rm(staging, { force: true });

  const written = await download(asset.url, staging, { onProgress, size: asset.size });
  if (written < 64 * 1024) {
    await fsp.rm(staging, { force: true });
    throw new Error('The downloaded update looks incomplete – please try again.');
  }

  const exePath = app.getPath('exe');
  await scheduleSwap({ source: staging, target, exePath, pid: process.pid });

  onProgress({ label: 'SallyLauncher update', done: written, total: written });
  /* The swap script takes over once this process has exited. */
  setTimeout(() => app.quit(), 600);
  return { version: update.latestVersion, bytes: written };
}

module.exports = { canPatch, apply, resourcesDir, packagedAsar };
