'use strict';

/**
 * SallyLauncher setup – a fully custom installer window.
 *
 * The setup executable is an electron-builder "portable" build: it unpacks a
 * tiny Electron app to %TEMP% and starts this file. The launcher files live in
 * `resources/payload`, so "installing" is copying that folder, writing the
 * shortcuts and registering the uninstall entry.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
/*
 * Electron patches the fs module so that any path containing ".asar" is
 * resolved *inside* that archive. The payload contains resources/app.asar, so
 * copying it through the patched module fails with ENOENT – the unpatched
 * module is used for everything that touches the payload.
 */
const rawFs = require('original-fs');
const rawFsp = rawFs.promises;
const path = require('node:path');
const { execFile } = require('node:child_process');

const APP_NAME = 'SallyLauncher';
const REG_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`;
/* Keep disk and antivirus activity low while the large Electron payload is copied. */
const COPY_CONCURRENCY = 2;

let mainWindow = null;
let busy = false;
let pendingCleanup = null;

/** Removes the install folder once this process no longer locks it. */
function spawnCleanup(target) {
  if (!target) return;
  /* A .cmd file keeps the quoting out of the command line (spawn + cmd.exe
     mangles nested quotes, which made the folder survive uninstall). */
  const script = path.join(app.getPath('temp'), `sally-cleanup-${Date.now()}.cmd`);
  const body = [
    '@echo off',
    'ping -n 3 127.0.0.1 >nul 2>&1',
    `rmdir /s /q "${target}"`,
    'del "%~f0" >nul 2>&1'
  ].join('\r\n');
  try {
    fs.writeFileSync(script, body, 'utf8');
    require('node:child_process')
      .spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
      .unref();
  } catch {
    /* a folder that stays behind must not break uninstall */
  }
}

/* ------------------------------------------------------------------ paths */

function resourcePath(name) {
  const packaged = path.join(process.resourcesPath || '', name);
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, name);
}

function payloadDir() {
  return resourcePath('payload');
}

function versionInfo() {
  try {
    return JSON.parse(fs.readFileSync(resourcePath('version.json'), 'utf8'));
  } catch {
    return { version: app.getVersion(), name: APP_NAME };
  }
}

function defaultInstallDir() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', APP_NAME);
}

function isUninstallMode() {
  return process.argv.includes('--uninstall');
}

/** When launched from the installed uninstall stub, `--target` wins. */
function uninstallTarget() {
  const index = process.argv.indexOf('--target');
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, '')
    : defaultInstallDir();
}

/* ---------------------------------------------------------------- helpers */

function send(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('setup:event', { type, payload });
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

async function walk(dir, list = []) {
  let names = [];
  try {
    names = await rawFsp.readdir(dir);
  } catch {
    try {
      names = await fsp.readdir(dir);
    } catch {
      return list;
    }
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = await rawFsp.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) await walk(full, list);
    else list.push(full);
  }
  return list;
}

async function supportsHardLinks(sourceFile, target) {
  if (!sourceFile) return false;
  const probe = path.join(target, `.sally-setup-link-${process.pid}-${Date.now()}`);
  try {
    await rawFsp.link(sourceFile, probe);
    return true;
  } catch {
    return false;
  } finally {
    await rawFsp.rm(probe, { force: true }).catch(() => {});
  }
}

async function killLauncher(target) {
  const exe = path.join(target, `${APP_NAME}.exe`);
  if (!fs.existsSync(exe)) return;
  await run('taskkill', ['/IM', `${APP_NAME}.exe`, '/F']);
  await new Promise((resolve) => setTimeout(resolve, 900));
}

async function copyPayload(target, onProgress) {
  const source = payloadDir();
  const files = await walk(source);
  const total = files.length;
  const hardLinks = await supportsHardLinks(files[0], target);
  let requiredBytes = 0;
  if (!hardLinks) {
    for (const from of files) {
      const relative = path.relative(source, from);
      const to = path.join(target, relative);
      const sourceStat = await rawFsp.stat(from).catch(() => null);
      if (!sourceStat) continue;
      const targetStat = await rawFsp.stat(to).catch(() => null);
      requiredBytes += Math.max(0, sourceStat.size - (targetStat?.size || 0));
    }
  }
  const disk = await fsp.statfs(target).catch(() => null);
  const availableBytes = disk ? Number(disk.bavail) * Number(disk.bsize) : Number.NaN;
  const reserveBytes = 160 * 1024 ** 2;
  if (Number.isFinite(availableBytes) && availableBytes < requiredBytes + reserveBytes) {
    const needed = Math.ceil((requiredBytes + reserveBytes) / 1024 ** 3 * 10) / 10;
    throw new Error(`Auf dem Installationslaufwerk ist zu wenig freier Speicher. Bitte mindestens ${needed} GB freigeben und erneut versuchen.`);
  }

  let done = 0;
  let cursor = 0;
  onProgress({ phase: 'copy', done: 0, total, percent: 0, current: 'Dateien werden vorbereitet…' });

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= files.length) return;
      const from = files[index];
      const relative = path.relative(source, from);
      const to = path.join(target, relative);
      await rawFsp.mkdir(path.dirname(to), { recursive: true });
      let linked = false;
      if (hardLinks) {
        try {
          await rawFsp.link(from, to);
          linked = true;
        } catch (error) {
          if (!['EEXIST', 'EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'EMLINK'].includes(error.code)) throw error;
        }
      }
      if (!linked) await rawFsp.copyFile(from, to);
      done += 1;
      if (done % 8 === 0 || done === total) {
        onProgress({
          phase: 'copy',
          done,
          total,
          percent: Math.round((done / total) * 92),
          current: path.basename(relative)
        });
      }
      if (done % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 12));
    }
  };

  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
  return total;
}

/** Copies the running setup exe into the install folder as the uninstaller. */
async function placeUninstaller(target) {
  const stub = process.env.PORTABLE_EXECUTABLE_FILE;
  const dest = path.join(target, `Uninstall ${APP_NAME}.exe`);
  try {
    if (stub && fs.existsSync(stub)) {
      const stat = await fsp.stat(stub);
      const existing = await fsp.stat(dest).catch(() => null);
      if (!existing || existing.size !== stat.size) await fsp.copyFile(stub, dest);
      return dest;
    }
    /* dev mode: fall back to a launcher that opens the app itself */
    await fsp.writeFile(
      path.join(target, 'Uninstall SallyLauncher.cmd'),
      `@echo off\r\nstart "" "${process.execPath}" --uninstall --target "${target}"\r\n`,
      'utf8'
    );
  } catch {
    /* a missing uninstaller must not break the install */
  }
  return null;
}

async function writeShortcut(linkPath, targetExe, onLog) {
  const script = `$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut(${JSON.stringify(linkPath)})
$shortcut.TargetPath = ${JSON.stringify(targetExe)}
$shortcut.WorkingDirectory = ${JSON.stringify(path.dirname(targetExe))}
$shortcut.IconLocation = ${JSON.stringify(`${targetExe},0`)}
$shortcut.Description = 'SallyLauncher'
$shortcut.Save()
`;
  const scriptPath = path.join(app.getPath('temp'), `sally-shortcut-${Date.now()}.ps1`);
  await fsp.writeFile(scriptPath, script, 'utf8');
  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
  await fsp.rm(scriptPath, { force: true }).catch(() => {});
  if (!result.ok) onLog?.(`Verknüpfung fehlgeschlagen: ${linkPath}`);
  return result.ok;
}

async function createShortcuts(target, { desktop, startMenu }, onLog) {
  const targetExe = path.join(target, `${APP_NAME}.exe`);
  if (desktop) {
    const link = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
    await writeShortcut(link, targetExe, onLog);
  }
  if (startMenu) {
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    await fsp.mkdir(programs, { recursive: true });
    await writeShortcut(path.join(programs, `${APP_NAME}.lnk`), targetExe, onLog);
  }
}

async function removeShortcuts() {
  const desktop = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);
  await fsp.rm(desktop, { force: true }).catch(() => {});
  await fsp.rm(programs, { force: true }).catch(() => {});
}

async function registerUninstall(target, version) {
  const exe = path.join(target, `${APP_NAME}.exe`);
  const uninstaller = path.join(target, `Uninstall ${APP_NAME}.exe`);
  const uninstallTargetExe = fs.existsSync(uninstaller) ? uninstaller : exe;
  const size = await walk(target).then((files) => files.length).catch(() => 0);
  let bytes = 0;
  for (const folder of ['resources', 'locales']) {
    const dir = path.join(target, folder);
    const files = await walk(dir).catch(() => []);
    for (const file of files) bytes += (await rawFsp.stat(file).catch(() => ({ size: 0 }))).size;
  }
  const kb = Math.max(1, Math.round((bytes || size * 4096) / 1024));
  const entries = [
    ['DisplayName', APP_NAME],
    ['DisplayVersion', version],
    ['Publisher', 'SallyLabs'],
    ['DisplayIcon', exe],
    ['InstallLocation', target],
    ['UninstallString', `"${uninstallTargetExe}" --uninstall --target "${target}"`],
    ['QuietUninstallString', `"${uninstallTargetExe}" --uninstall --target "${target}" --silent`],
    ['InstallDate', new Date().toISOString().slice(0, 10).replace(/-/g, '')]
  ];
  for (const [name, value] of entries) {
    await run('reg', ['add', REG_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
  }
  await run('reg', ['add', REG_KEY, '/v', 'EstimatedSize', '/t', 'REG_DWORD', '/d', String(kb), '/f']);
  await run('reg', ['add', REG_KEY, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run('reg', ['add', REG_KEY, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f']);
}

async function removeRegistry() {
  await run('reg', ['delete', REG_KEY, '/f']);
}

/* ---------------------------------------------------------------- install */

async function install({ dir, desktop, startMenu, launch }, onLog) {
  const version = versionInfo().version;
  const target = path.resolve(String(dir || defaultInstallDir()));
  let previousPriority;

  /* Let the desktop and foreground apps keep priority during the large copy. */
  try {
    previousPriority = os.getPriority(process.pid);
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    previousPriority = undefined;
  }

  try {
    send('progress', { phase: 'start', percent: 0, current: 'Laufende Instanz wird geschlossen…' });
    await killLauncher(target);

    await fsp.mkdir(target, { recursive: true });
    const copied = await copyPayload(target, (progress) => send('progress', progress));
    onLog?.(`${copied} Dateien kopiert nach ${target}`);

    send('progress', { phase: 'shortcuts', percent: 94, current: 'Verknüpfungen werden erstellt…' });
    await createShortcuts(target, { desktop, startMenu }, onLog);
    await placeUninstaller(target);

    send('progress', { phase: 'registry', percent: 98, current: 'Deinstallation wird registriert…' });
    await registerUninstall(target, version);

    send('progress', { phase: 'done', percent: 100, current: 'Fertig' });
    return { target, version, launch };
  } finally {
    if (previousPriority !== undefined) {
      try {
        os.setPriority(process.pid, previousPriority);
      } catch {
        /* The installer may be closing already. */
      }
    }
  }
}

/* -------------------------------------------------------------- uninstall */

async function uninstall({ target: requested, keepUserData }, onLog) {
  const target = path.resolve(String(requested || uninstallTarget()));
  send('progress', { phase: 'start', percent: 0, current: 'SallyLauncher wird geschlossen…' });
  await killLauncher(target);

  send('progress', { phase: 'shortcuts', percent: 12, current: 'Verknüpfungen werden entfernt…' });
  await removeShortcuts();
  await removeRegistry();

  if (!keepUserData) {
    send('progress', { phase: 'data', percent: 22, current: 'Profile und Einstellungen werden gelöscht…' });
    const userData = path.join(process.env.APPDATA || app.getPath('appData'), APP_NAME);
    await fsp.rm(userData, { recursive: true, force: true }).catch(() => {});
  }

  const files = await walk(target);
  const stub = path.join(target, `Uninstall ${APP_NAME}.exe`);
  const stubs = [stub, path.join(target, 'Uninstall SallyLauncher.cmd')];
  const removable = files.filter((file) => !stubs.includes(file));
  let done = 0;
  for (const file of removable) {
    await rawFsp.rm(file, { force: true }).catch(() => {});
    done += 1;
    if (done % 12 === 0 || done === removable.length) {
      send('progress', {
        phase: 'remove',
        percent: 25 + Math.round((done / Math.max(1, removable.length)) * 70),
        current: path.basename(file)
      });
    }
  }
  onLog?.(`${done} Dateien entfernt aus ${target}`);

  send('progress', { phase: 'done', percent: 100, current: 'Fertig' });
  /* The uninstaller executable lives inside the folder it removes, so the
     removal has to wait until this process is gone. */
  pendingCleanup = target;
  return { target };
}

/* ------------------------------------------------------------------- ipc */

async function payloadBytes() {
  const files = await walk(payloadDir());
  let total = 0;
  for (const file of files) {
    total += (await rawFsp.stat(file).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function registerIpc() {
  ipcMain.handle('setup:info', async () => {
    const bytes = await payloadBytes().catch(() => 0);
    return {
      version: versionInfo().version,
      installDir: defaultInstallDir(),
      uninstall: isUninstallMode(),
      uninstallDir: isUninstallMode() ? uninstallTarget() : null,
      payloadBytes: bytes,
      estimatedSpaceBytes: bytes ? bytes * 2 + 160 * 1024 ** 2 : 0,
      platform: process.platform
    };
  });

  ipcMain.handle('setup:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Installationsordner wählen',
      defaultPath: defaultInstallDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('setup:install', async (_e, options = {}) => {
    if (busy) throw new Error('Setup läuft bereits.');
    busy = true;
    try {
      const result = await install(options, (line) => send('log', line));
      return result;
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('setup:uninstall', async (_e, options = {}) => {
    if (busy) throw new Error('Setup läuft bereits.');
    busy = true;
    try {
      return await uninstall(options, (line) => send('log', line));
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('setup:launch', async (_e, target) => {
    const exe = path.join(target || defaultInstallDir(), `${APP_NAME}.exe`);
    if (!fs.existsSync(exe)) throw new Error('SallyLauncher.exe wurde nicht gefunden.');
    const failure = await shell.openPath(exe);
    if (failure) throw new Error(failure);
    return true;
  });

  ipcMain.handle('setup:openFolder', async (_e, target) => {
    if (!target) return false;
    await shell.openPath(target);
    return true;
  });

  ipcMain.on('setup:close', () => app.quit());
  ipcMain.on('setup:minimize', () => mainWindow?.minimize());
}

/* ---------------------------------------------------------------- window */

function createWindow() {
  const uninstall = isUninstallMode();
  mainWindow = new BrowserWindow({
    width: 852,
    height: uninstall ? 560 : 600,
    minWidth: 760,
    minHeight: 500,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#100f16',
    title: 'SallyLauncher Setup',
    icon: resourcePath(path.join('assets', 'icon.ico')),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on('will-quit', () => spawnCleanup(pendingCleanup));
app.on('window-all-closed', () => app.quit());
