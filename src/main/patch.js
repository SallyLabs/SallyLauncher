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

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { app } = require('electron');

const { assetRequest } = require('./updates');

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

async function download(asset, dest, { onProgress = () => {}, size = 0 } = {}) {
  const request = assetRequest(asset);
  const res = await fetch(request.url, { headers: request.headers });
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
    'set "TRIES=0"',
    `set "PID=${pid}"`,
    `set "NEW=${source}"`,
    `set "TARGET=${target}"`,
    `set "EXE=${exePath}"`,
    ':wait',
    'ping -n 2 127.0.0.1 >nul',
    'tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul && goto wait',
    ':swap',
    'attrib -R "%TARGET%" >nul 2>&1',
    'move /Y "%NEW%" "%TARGET%" >nul 2>&1',
    'if not errorlevel 1 goto start',
    'set /a TRIES+=1',
    'if %TRIES% GEQ 20 goto start',
    'ping -n 2 127.0.0.1 >nul',
    'goto swap',
    ':start',
    'start "" "%EXE%"',
    'del "%~f0" >nul 2>&1'
  ];
  await fsp.writeFile(script, `${lines.join('\r\n')}\r\n`, 'utf8');
  return script;
}

/**
 * Starts the swap script detached so it keeps running after this process has
 * exited. Without this call the script is only written to disk and nothing ever
 * replaces the asar – the launcher quits and the update silently does nothing.
 */
function launchSwap(script) {
  const child = spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/c', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return child;
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

  const written = await download(asset, staging, { onProgress, size: asset.size });
  if (written < 64 * 1024 || (asset.size && written < asset.size)) {
    await fsp.rm(staging, { force: true });
    throw new Error('The downloaded update looks incomplete – please try again.');
  }

  const exePath = app.getPath('exe');
  const script = await scheduleSwap({ source: staging, target, exePath, pid: process.pid });
  launchSwap(script);

  onProgress({ label: 'SallyLauncher update', done: written, total: written });
  /* The swap script takes over once this process has exited. */
  setTimeout(() => app.quit(), 600);
  return { version: update.latestVersion, bytes: written };
}

module.exports = { canPatch, apply, resourcesDir, packagedAsar };
