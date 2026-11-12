'use strict';

const { app, BrowserWindow, ipcMain, protocol, dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AdmZip = require('adm-zip');

const { Store } = require('./src/main/store');
const mojang = require('./src/main/mojang');
const { cpuPercent, memoryStats, detectJava } = require('./src/main/system');
const fabric = require('./src/main/fabric');
const loaders = require('./src/main/loaders');
const modrinth = require('./src/main/modrinth');
const microsoft = require('./src/main/microsoft');
const updates = require('./src/main/updates');
const patch = require('./src/main/patch');
const clientmod = require('./src/main/clientmod');
const servers = require('./src/main/servers');
const cosmetics = require('./src/main/cosmetics');
const rpc = require('./src/main/rpc');
const config = require('./src/main/config');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const store = new Store();

/* A white window or a frozen desktop must never survive a restart: the marker
   written on a GPU/renderer problem turns hardware acceleration and acrylic off
   for the next start. */
const safeStartFile = () => path.join(app.getPath('userData'), 'safe-start.json');
let safeStartMode = (() => {
  try {
    return JSON.parse(fs.readFileSync(safeStartFile(), 'utf8')).active === true;
  } catch {
    return false;
  }
})();
function writeSafeStart(active, reason = '') {
  try {
    fs.writeFileSync(safeStartFile(), JSON.stringify({ active, reason, at: new Date().toISOString() }, null, 2));
  } catch {
    /* a missing marker only costs the fallback, never the launch */
  }
}

let mainWindow = null;
let updateState = null;
let updateCheck = null;
const logBuffer = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'sally', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

/* ------------------------------------------------------------- messaging */

function send(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('event', { type, payload });
  }
}

/**
 * Every line remembers which instance printed it, so the per-instance log in
 * the profile page never mixes two running games. Launcher-wide lines carry
 * `profile: null` and show up in every instance log.
 */
function log(line, profileId = null) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  const entry = { text, profile: profileId || null };
  logBuffer.push(entry);
  if (logBuffer.length > 4000) logBuffer.shift();
  if (process.env.SALLY_DEBUG) console.log(`[sally] ${text}`);
  send('log', entry);
}

process.on('uncaughtException', (error) => {
  log(`Unexpected error: ${error?.stack || error}`);
});

/** One entry per profile that is preparing or running a game. */
const launches = new Map();
let busyState = 'idle';

function launchInstances() {
  return [...launches.entries()].map(([profileId, entry]) => ({ profileId, ...entry }));
}

function currentGameState() {
  const entries = [...launches.values()];
  if (entries.some((entry) => entry.state === 'running')) return 'running';
  if (entries.some((entry) => entry.state === 'preparing') || busyState === 'preparing') return 'preparing';
  return 'idle';
}

function publishGame(extra = {}) {
  updatePresence();
  send('game', { state: currentGameState(), instances: launchInstances(), ...extra });
}

/** Installs and updates are launcher work, not a running game. */
function setGameState(state, extra = {}) {
  busyState = state;
  publishGame(extra);
}

function setLaunch(profileId, patch, extra = {}) {
  launches.set(profileId, { ...(launches.get(profileId) || {}), ...patch });
  publishGame(extra);
}

function clearLaunch(profileId, extra = {}) {
  if (!launches.delete(profileId)) return;
  publishGame(extra);
}

/** Books the running time of a session that just ended onto its profile. */
function finishSession(profileId) {
  const entry = launches.get(profileId);
  if (!entry?.startedAt) return;
  const elapsed = Date.now() - entry.startedAt;
  if (elapsed < 1000) return;
  store.addPlaytime(profileId, elapsed);
  send('state', snapshot());
}

/* -------------------------------------------------------------- presence */

function versionLabel(versionId) {
  return fabric.baseMinecraftVersion(versionId || '') || versionId || '';
}

function updatePresence() {
  const profile = store.getActiveProfile();
  const instances = launchInstances();
  const running = instances.filter((entry) => entry.state === 'running');
  const preparing = instances.find((entry) => entry.state === 'preparing');
  if (running.length) {
    const newest = running[running.length - 1];
    rpc.setPresence({
      kind: 'playing',
      version: versionLabel(newest.versionId),
      profile: newest.name || profile?.name,
      startedAt: newest.startedAt || null,
      count: running.length
    });
  } else if (preparing || busyState === 'preparing') {
    rpc.setPresence({ kind: 'launching', version: versionLabel(preparing?.versionId || profile?.versionId) });
  } else {
    rpc.setPresence({ kind: 'menu', profile: profile?.name });
  }
}

let discordQueue = Promise.resolve();

/** Applies the Discord settings; calls are queued so two saves never race. */
function syncDiscord() {
  discordQueue = discordQueue
    .then(async () => {
      const settings = store.get().settings;
      const clientId = String(config.discordClientId || '').trim();
      if (!settings.discordRpc || !clientId) {
        await rpc.stop({ silent: true });
      } else {
        await rpc.start({
          clientId,
          onLog: log,
          onChange: () => send('state', snapshot())
        });
      }
      updatePresence();
      send('state', snapshot());
      return rpc.status();
    })
    .catch((err) => {
      log(`Discord setup failed: ${err.message}`);
      return rpc.status();
    });
  return discordQueue;
}

function modsInInstance(gameDir) {
  try {
    return fs.readdirSync(path.join(gameDir, 'mods')).filter((name) => name.toLowerCase().endsWith('.jar')).length;
  } catch {
    return 0;
  }
}

function snapshot() {
  const data = store.get();
  const profile = store.getActiveProfile();
  const instanceDir = profile?.gameDir || store.profileDir(profile?.id || 'default');
  return {
    instanceDir,
    modsCount: modsInInstance(instanceDir),
    settings: data.settings,
    profiles: data.profiles,
    activeProfileId: data.activeProfileId,
    activeProfile: profile,
    accounts: store.publicAccounts(),
    activeAccountId: data.activeAccountId,
    activeAccount: store.publicAccount(store.getAccount()),
    selectedVersion: profile?.versionId || null,
    sharedDir: store.sharedDir(),
    update: updateState || {
      available: false,
      currentVersion: app.getVersion(),
      latestVersion: app.getVersion(),
      error: null,
      checkedAt: null,
      noRelease: false,
      repo: updates.REPO,
      releasesUrl: updates.RELEASES_PAGE
    },
    discord: rpc.status(),
    gameState: currentGameState(),
    instances: launchInstances(),
    status: mojang.status(),
    appVersion: app.getVersion(),
    platform: process.platform,
    gameDir: profile?.gameDir || data.settings.gameDir
  };
}

/* ------------------------------------------------------------------ java */

async function pickDefaultVersion(gameDir) {
  const { installed } = await mojang.listVersions(gameDir);
  if (!installed.length) return null;
  installed.sort((a, b) => String(b.releaseTime || '').localeCompare(String(a.releaseTime || '')));
  const vanilla = installed.find((v) => v.loader === 'Vanilla' && v.type === 'release');
  const release = installed.find((v) => v.type === 'release');
  return (vanilla || release || installed[0]).id;
}

let javaCache = { at: 0, key: '', info: null };

async function currentJava(requiredMajor) {
  const { gameDir, javaPath } = store.effectiveSettings(store.getActiveProfile());
  const key = `${gameDir}|${javaPath}|${requiredMajor || 0}`;
  if (javaCache.key === key && Date.now() - javaCache.at < 60_000) return javaCache.info;
  const info = await detectJava(gameDir, javaPath, requiredMajor);
  javaCache = { at: Date.now(), key, info };
  return info;
}

/* -------------------------------------------------------- microsoft auth */

const MC_TOKEN_MARGIN_MS = 10 * 60 * 1000;

function msaClientId(account = {}) {
  return account.clientId || store.get().settings.msaClientId || microsoft.DEFAULT_CLIENT_ID;
}

async function refreshMsaSession(secrets) {
  const { account, msaRefreshToken } = secrets;
  if (!msaRefreshToken) {
    const error = new Error('Microsoft session expired. Sign in with Microsoft again.');
    error.needsLogin = true;
    throw error;
  }
  const clientId = msaClientId(account);
  const flow = account.flow || microsoft.flowOf(clientId);
  const msa = await microsoft.refreshMsaToken({ clientId, flow, refreshToken: msaRefreshToken });
  const resolved = await microsoft.resolveAccount({ msa, clientId, flow });
  const updated = store.updateMsaTokens(account.id, {
    minecraftToken: resolved.minecraftToken,
    minecraftTokenExpiresAt: resolved.minecraftTokenExpiresAt,
    msaRefreshToken: resolved.msaRefreshToken,
    profile: resolved.profile
  });
  log(`Refreshed the Microsoft session for ${resolved.profile.name}`);
  return { account: updated, accessToken: resolved.minecraftToken, name: resolved.profile.name, uuid: microsoft.dashedUuid(resolved.profile.uuid) };
}

/** A launchable session: cached Minecraft token or a fresh one from the MSA refresh token. */
async function ensureMinecraftSession(account) {
  const secrets = store.getAccountSecrets(account.id);
  if (!secrets) throw new Error('Microsoft account data is missing. Sign in again.');
  const expiresAt = Number(secrets.account.minecraftTokenExpiresAt) || 0;
  if (secrets.minecraftToken && expiresAt - Date.now() > MC_TOKEN_MARGIN_MS) {
    return { accessToken: secrets.minecraftToken, name: secrets.account.name, uuid: secrets.account.uuid };
  }
  const refreshed = await refreshMsaSession(secrets);
  return { accessToken: refreshed.accessToken, name: refreshed.name, uuid: refreshed.uuid };
}

/* ------------------------------------------------------------ skin upload */

const MC_SKIN_URL = 'https://api.minecraftservices.com/minecraft/profile/skins';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

/** The skin API only accepts 64×64 and 64×32, so read the PNG header first. */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Returns null on success, 'expired' when the Minecraft token is no longer valid. */
async function uploadSkin(variant, buffer, accessToken) {
  const form = new FormData();
  form.append('variant', variant);
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'skin.png');
  const response = await fetch(MC_SKIN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form
  });
  if (response.ok) return null;
  if (response.status === 401) return 'expired';
  const payload = await response.json().catch(() => null);
  const detail = payload?.errorMessage || payload?.error || `HTTP ${response.status}`;
  throw new Error(`Minecraft rejected the skin: ${detail}`);
}

/* ------------------------------------------------------------------- ipc */

function registerIpc() {
  ipcMain.handle('state:get', () => snapshot());

  /* Frosted glass can be switched off – Windows then paints no acrylic behind us. */
  ipcMain.handle('appearance:glass', (_e, on) => {
    setGlass(on !== false);
    return { material: on === false ? 'none' : 'acrylic' };
  });

  ipcMain.handle('settings:update', (_e, patch) => {
    const settings = store.updateSettings(patch || {});
    if (patch && 'glass' in patch) {
      setGlass(settings.glass !== false);
    }
    javaCache = { at: 0, key: '', info: null };
    if (patch && 'discordRpc' in patch) {
      syncDiscord().catch(() => {});
    }
    send('state', snapshot());
    return settings;
  });

  ipcMain.handle('discord:reconnect', async () => {
    await rpc.stop({ silent: true });
    return syncDiscord();
  });

  ipcMain.handle('java:detect', async () => currentJava());

  ipcMain.handle('system:pickFolder', async (_e, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: defaultPath || store.get().settings.gameDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('system:pickFile', async (_e, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: options.defaultPath || undefined,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : []
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('system:openExternal', async (_e, url) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('system:openPath', async (_e, target) => {
    if (!target) return false;
    try {
      await fsp.mkdir(target, { recursive: true });
    } catch {
      /* ignore */
    }
    const error = await shell.openPath(target);
    return !error;
  });

  ipcMain.handle('versions:list', async (_e, { refresh = false } = {}) => {
    const profile = store.getActiveProfile();
    const gameDir = store.effectiveSettings(profile).gameDir;
    const result = await mojang.listVersions(gameDir, { refresh });
    if (profile && !profile.versionId && result.installed.length) {
      const sorted = [...result.installed].sort((a, b) =>
        String(b.releaseTime || '').localeCompare(String(a.releaseTime || ''))
      );
      const chosen = (sorted.find((v) => v.loader === 'Vanilla' && v.type === 'release') || sorted.find((v) => v.type === 'release') || sorted[0]).id;
      store.setProfileVersion(profile.id, chosen);
      send('state', snapshot());
    }
    return { ...result, selectedVersion: store.getActiveProfile()?.versionId || null };
  });

  ipcMain.handle('versions:select', (_e, id) => {
    const profile = store.getActiveProfile();
    if (profile) store.setProfileVersion(profile.id, id);
    send('state', snapshot());
    return true;
  });

  /** Downloads everything a profile needs: Fabric loader, client mods and the
      vanilla files into the shared cache. No Java required. */
  /** Resolves the loader build of a profile (Fabric profile JSON or a Forge install). */
  async function prepareLoader(profile, settings, { onLog = log } = {}) {
    const loader = loaders.normalizeLoader(profile.loader);
    const mcVersion = loaders.minecraftVersionOf(profile.versionId);
    if (loader === 'vanilla') return mcVersion;

    let javaPath = null;
    if (loader === 'forge') {
      /* The installer itself runs on the Java build this Minecraft version needs. */
      let required = null;
      try {
        const meta = await mojang.resolveVersion(settings.gameDir, mcVersion);
        required = meta.javaVersion?.majorVersion || null;
      } catch {
        /* requirements are optional here */
      }
      const java = await currentJava(required);
      if (!java) throw new Error('Forge needs a Java runtime – install Java or set one in Settings.');
      javaPath = java.path;
    }

    const info = await loaders.ensure({
      loader,
      mcVersion,
      loaderVersion: profile.loaderVersion || '',
      runtimeDir: store.sharedDir(),
      javaPath,
      onLog: (line) => onLog(line),
      onProgress: (p) => send('progress', p)
    });
    return info.versionId;
  }

  async function installProfileVersion(profileId) {
    const profile = store.getProfile(profileId) || store.getActiveProfile();
    if (!profile?.versionId) throw new Error('Pick a Minecraft version for this profile first.');
    const settings = store.effectiveSettings(profile);
    setGameState('preparing', { versionId: profile.versionId });
    try {
      const launchId = await prepareLoader(profile, settings, { onLog: log });
      const report = await fabric.prepareClientMods({
        gameDir: settings.gameDir,
        runtimeDir: store.sharedDir(),
        versionId: launchId,
        loader: loaders.normalizeLoader(profile.loader),
        loaderVersion: profile.loaderVersion || '',
        enabled: true,
        onLog: log
      });
      const finalId = report.fabricVersionId || launchId;
      await mojang.prepareLaunch({
        gameDir: settings.gameDir,
        versionId: finalId,
        settings,
        onProgress: (p) => send('progress', p),
        onLog: (line) => log(line)
      });
      log(`Profile ${profile.name} is ready: ${finalId}`);
      setGameState('idle');
      return { versionId: finalId, mods: report.injected, error: report.error };
    } catch (err) {
      log(`Install failed: ${err.message}`);
      setGameState('idle', { error: err.message });
      throw err;
    }
  }

  ipcMain.handle('versions:install', async (_e, id) => installProfileVersion(id));

  /* -------------------------------------------------------------- loaders */

  ipcMain.handle('loaders:list', () => loaders.LOADERS);

  ipcMain.handle('loaders:versions', async (_e, options = {}) => {
    try {
      return await loaders.versions(options);
    } catch (err) {
      return { loader: loaders.normalizeLoader(options.loader), mcVersion: options.mcVersion || null, versions: [], error: err.message };
    }
  });

  /* ------------------------------------------------------------ modrinth */

  ipcMain.handle('modrinth:search', async (_e, options = {}) => modrinth.search(options));

  ipcMain.handle('modrinth:versions', async (_e, projectId, options = {}) => {
    const versions = await modrinth.projectVersions(projectId, options);
    return versions.map((version) => ({
      id: version.id,
      name: version.name,
      version: version.version_number,
      downloads: version.downloads,
      gameVersions: version.game_versions || [],
      loaders: version.loaders || []
    }));
  });

  ipcMain.handle('modrinth:installMod', async (_e, payload = {}) => {
    const profile = (payload.profileId ? store.getProfile(payload.profileId) : null) || store.getActiveProfile();
    if (!profile) throw new Error('Create a profile first.');
    const settings = store.effectiveSettings(profile);
    const mcVersion = fabric.baseMinecraftVersion(profile.versionId || '');
    const result = await modrinth.installMod({
      projectId: payload.projectId,
      versionId: payload.versionId,
      gameDir: settings.gameDir,
      gameVersion: mcVersion,
      loader: payload.loader || 'fabric',
      onLog: (line) => log(line, profile.id),
      onProgress: (p) => send('progress', p)
    });
    log(`Installed ${result.name || result.file} into ${profile.name}`, profile.id);
    send('state', snapshot());
    return result;
  });

  ipcMain.handle('modrinth:importPack', async (_e, payload = {}) => {
    const mcVersion = payload.gameVersion || '';
    const profile = store.createProfile({
      name: payload.name || 'Modrinth pack',
      versionId: null,
      modpack: {
        projectId: payload.projectId,
        versionId: payload.versionId || null,
        title: payload.name || '',
        iconUrl: payload.iconUrl || null
      }
    });
    const settings = store.effectiveSettings(profile);
    send('state', snapshot());
    try {
      setGameState('preparing', { versionId: mcVersion });
      const pack = await modrinth.installModpack({
        projectId: payload.projectId,
        versionId: payload.versionId,
        gameDir: settings.gameDir,
        gameVersion: mcVersion,
        loader: payload.loader || 'fabric',
        onLog: log,
        onProgress: (p) => send('progress', p)
      });
      if (pack.minecraft) {
        store.updateProfile(profile.id, {
          versionId: pack.minecraft,
          modpack: { ...profile.modpack, version: pack.packVersion, minecraft: pack.minecraft }
        });
      }
      await installProfileVersion(profile.id);
      log(`Imported ${pack.name} (${pack.files} files) as profile ${profile.name}`);
      send('state', snapshot());
      return { profile: store.getProfile(profile.id), pack };
    } catch (err) {
      setGameState('idle', { error: err.message });
      throw err;
    }
  });

  ipcMain.handle('modrinth:importPackFile', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a Modrinth pack',
      properties: ['openFile'],
      filters: [{ name: 'Modrinth pack', extensions: ['mrpack', 'zip'] }]
    });
    const filePath = picked.canceled ? null : picked.filePaths[0];
    if (!filePath) return null;

    const meta = modrinth.readPackIndex(filePath);
    const profile = store.createProfile({
      name: meta.name,
      versionId: null,
      modpack: { title: meta.name, version: meta.packVersion, file: path.basename(filePath) }
    });
    const settings = store.effectiveSettings(profile);
    send('state', snapshot());
    log(`Importing ${path.basename(filePath)} into ${profile.name}`);
    try {
      setGameState('preparing', { versionId: meta.minecraft });
      const pack = await modrinth.installPackFile({
        filePath,
        gameDir: settings.gameDir,
        onLog: log,
        onProgress: (p) => send('progress', p)
      });
      if (pack.minecraft) {
        store.updateProfile(profile.id, {
          versionId: pack.minecraft,
          modpack: { ...profile.modpack, version: pack.packVersion, minecraft: pack.minecraft }
        });
        await installProfileVersion(profile.id);
      }
      log(`Imported ${pack.name} (${pack.files} files) as profile ${profile.name}`);
      setGameState('idle');
      send('state', snapshot());
      return { profile: store.getProfile(profile.id), pack };
    } catch (err) {
      setGameState('idle', { error: err.message });
      throw err;
    }
  });

  /* ------------------------------------------------------------ profiles */

  ipcMain.handle('profiles:create', (_e, patch) => {
    const profile = store.createProfile(patch || {});
    send('state', snapshot());
    return profile;
  });

  ipcMain.handle('profiles:update', (_e, id, patch) => {
    const profile = store.updateProfile(id, patch || {});
    send('state', snapshot());
    return profile;
  });

  ipcMain.handle('profiles:duplicate', (_e, id) => {
    const profile = store.duplicateProfile(id);
    send('state', snapshot());
    return profile;
  });

  ipcMain.handle('profiles:remove', (_e, id) => {
    /* A deleted profile must not keep a game running in the background. */
    if (launches.has(id)) {
      mojang.stop(id);
      launches.delete(id);
      publishGame();
    }
    store.removeProfile(id);
    send('state', snapshot());
    return true;
  });

  ipcMain.handle('profiles:select', (_e, id) => {
    store.selectProfile(id);
    updatePresence();
    send('state', snapshot());
    return true;
  });

  ipcMain.handle('accounts:add', (_e, name) => {
    const account = store.addAccount(name);
    send('state', snapshot());
    return account;
  });

  ipcMain.handle('accounts:remove', (_e, id) => {
    store.removeAccount(id);
    send('state', snapshot());
    return true;
  });

  ipcMain.handle('accounts:select', (_e, id) => {
    store.selectAccount(id);
    send('state', snapshot());
    return true;
  });

  /* --------------------------------------------------------- microsoft */

  const msaSessions = new Map();

  ipcMain.handle('msa:start', async () => {
    const clientId = store.get().settings.msaClientId || microsoft.DEFAULT_CLIENT_ID;
    const code = await microsoft.requestDeviceCode(clientId);
    for (const [key, session] of msaSessions) {
      if (Date.now() - session.startedAt > 15 * 60 * 1000) msaSessions.delete(key);
    }
    msaSessions.set(code.deviceCode, { ...code, startedAt: Date.now() });
    log(`Microsoft sign-in started (code ${code.userCode})`);
    return {
      deviceCode: code.deviceCode,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresIn: code.expiresIn,
      interval: code.interval,
      flow: code.flow
    };
  });

  ipcMain.handle('msa:poll', async (_e, deviceCode) => {
    const session = msaSessions.get(deviceCode);
    if (!session) throw new Error('The sign-in session expired. Start again.');
    const result = await microsoft.pollDeviceCode(session);
    if (result.status === 'pending') return { status: 'pending', slowDown: Boolean(result.slowDown) };

    const resolved = await microsoft.resolveAccount({
      msa: result.tokens,
      clientId: session.clientId,
      flow: session.flow
    });
    const account = store.addMsaAccount({
      profile: resolved.profile,
      xuid: resolved.xuid,
      minecraftToken: resolved.minecraftToken,
      minecraftTokenExpiresAt: resolved.minecraftTokenExpiresAt,
      msaRefreshToken: resolved.msaRefreshToken,
      clientId: session.clientId,
      flow: session.flow
    });
    msaSessions.delete(deviceCode);
    log(`Signed in to Microsoft as ${account.name}`);
    send('state', snapshot());
    return { status: 'done', account: store.publicAccount(account) };
  });

  ipcMain.handle('msa:cancel', (_e, deviceCode) => {
    msaSessions.delete(deviceCode);
    return true;
  });

  ipcMain.handle('accounts:refresh', async (_e, id) => {
    const target = id || store.getAccount()?.id;
    const secrets = store.getAccountSecrets(target);
    if (!secrets || secrets.account.type !== 'msa') throw new Error('This account is not a Microsoft account.');
    const refreshed = await refreshMsaSession(secrets);
    send('state', snapshot());
    return refreshed;
  });

  ipcMain.handle('accounts:setClientId', (_e, clientId) => {
    store.updateSettings({ msaClientId: String(clientId || '').trim() });
    send('state', snapshot());
    return store.get().settings.msaClientId;
  });

  ipcMain.handle('skins:fetch', async (_e, url) => {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch {
      throw new Error('That skin address is invalid.');
    }
    if (parsed.protocol !== 'https:') throw new Error('Only https skin links can be loaded.');
    const response = await fetch(parsed.toString(), { redirect: 'follow' });
    if (!response.ok) throw new Error(`The skin could not be downloaded (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 4 * 1024 * 1024) throw new Error('That skin file is too large.');
    return `data:image/png;base64,${buffer.toString('base64')}`;
  });

  ipcMain.handle('skins:apply', async (_e, payload = {}) => {
    const account = store.getAccount();
    if (!account || account.type !== 'msa') {
      throw new Error('Sign in with Microsoft to change the skin of your Minecraft profile.');
    }

    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(payload.image || ''));
    if (!match) throw new Error('That skin could not be read.');
    const buffer = Buffer.from(match[1], 'base64');
    const size = pngSize(buffer);
    if (!size) throw new Error('That is not a valid PNG skin.');
    const isModern = size.width === 64 && size.height === 64;
    const isLegacy = size.width === 64 && size.height === 32;
    if (!isModern && !isLegacy) {
      throw new Error(`Minecraft only accepts 64×64 or 64×32 skins (this one is ${size.width}×${size.height}).`);
    }

    const variant = payload.slim ? 'slim' : 'classic';
    let session = await ensureMinecraftSession(account);
    let outcome = await uploadSkin(variant, buffer, session.accessToken);
    if (outcome === 'expired') {
      const secrets = store.getAccountSecrets(account.id);
      session = await refreshMsaSession(secrets);
      outcome = await uploadSkin(variant, buffer, session.accessToken);
      if (outcome === 'expired') throw new Error('Minecraft rejected the session. Sign in with Microsoft again.');
    }

    // Pick up the fresh texture URL so "Your account" shows the new skin.
    const profile = await fetch(MC_PROFILE_URL, { headers: { Authorization: `Bearer ${session.accessToken}` } })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const skin = (profile?.skins || []).find((entry) => entry.state === 'ACTIVE') || profile?.skins?.[0] || null;
    if (skin) {
      store.updateMsaTokens(account.id, {
        profile: {
          name: account.name,
          uuid: account.uuid,
          skinUrl: skin.url ? skin.url.replace(/^http:/i, 'https:') : null,
          skinVariant: skin.variant || null
        }
      });
    }

    log(`Uploaded a new ${variant} skin for ${account.name}`);
    send('state', snapshot());
    return { name: account.name, variant, skinUrl: skin?.url || null };
  });

  /* ------------------------------------------------------------- servers */

  ipcMain.handle('servers:list', async (_e, options = {}) => servers.list(options || {}));

  ipcMain.handle('cosmetics:list', (_e, payload = {}) => {
    const profile = (payload?.profileId ? store.getProfile(payload.profileId) : null) || store.getActiveProfile();
    return cosmetics.list({ gameDir: profile?.gameDir || '' });
  });

  /** Writes one cosmetic into the profile's SallyClient config. */
  ipcMain.handle('cosmetics:toggle', (_e, payload = {}) => {
    const profile = (payload?.profileId ? store.getProfile(payload.profileId) : null) || store.getActiveProfile();
    if (!profile?.gameDir) throw new Error('Create a profile first.');
    return cosmetics.toggle({ gameDir: profile.gameDir, id: payload?.id });
  });

  /** Makes a server from the list the target of the profile's next launch. */
  ipcMain.handle('servers:apply', (_e, payload = {}) => {
    const address = String(payload?.address || '').trim();
    if (!address) throw new Error('That server has no address.');
    const profile = (payload?.profileId ? store.getProfile(payload.profileId) : null) || store.getActiveProfile();
    if (!profile) throw new Error('Create a profile first.');
    store.updateProfile(profile.id, { serverAddress: address });
    store.updateSettings({ autoConnect: true });
    send('state', snapshot());
    return { profileId: profile.id, serverAddress: address, profile: store.getProfile(profile.id) };
  });

  ipcMain.handle('client:info', () => {
    const profile = store.getActiveProfile();
    const settings = store.effectiveSettings(profile);
    const versionId = profile?.versionId || null;
    const report = fabric.clientModReport(versionId);
    return {
      enabled: true,
      versionId,
      mcVersion: report.mcVersion,
      mods: report.mods,
      modsDir: path.join(settings.gameDir, 'mods')
    };
  });

  ipcMain.handle('logs:get', () => logBuffer.slice(-1200));

  /* ------------------------------------------------------------ instance */

  ipcMain.handle('instance:mods', async (_e, id) => {
    const profile = store.getProfile(id);
    if (!profile) return [];
    const dir = path.join(profile.gameDir || store.profileDir(profile.id), 'mods');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => /\.jar(\.disabled)?$/i.test(name));
    } catch {
      return [];
    }
    const mods = [];
    for (const file of files) {
      const full = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      let name = file.replace(/\.jar$/i, '');
      let version = '';
      /* the jar knows its pretty name; the file name only has the slug */
      try {
        const zip = new AdmZip(full);
        const entry = zip.getEntry('fabric.mod.json');
        if (entry) {
          const meta = JSON.parse(zip.readAsText(entry));
          if (meta.name) name = String(meta.name);
          if (meta.version) version = String(meta.version);
        }
      } catch {
        /* not a Fabric mod – keep the file name */
      }
      mods.push({
        file,
        name,
        version,
        enabled: !/\.disabled$/i.test(file),
        path: full,
        sizeMb: Math.round((stat.size / 1048576) * 10) / 10,
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Renames a jar to `.jar.disabled` and back – the game ignores those. */
  ipcMain.handle('instance:toggleMod', (_e, profileId, file) => {
    const profile = store.getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    const dir = path.join(profile.gameDir || store.profileDir(profile.id), 'mods');
    const from = path.join(dir, path.basename(file));
    if (!fs.existsSync(from)) throw new Error('That mod file is gone.');
    const disabled = /\.disabled$/i.test(from);
    const to = disabled ? from.replace(/\.disabled$/i, '') : `${from}.disabled`;
    fs.renameSync(from, to);
    log(`${path.basename(to)} ${disabled ? 'enabled' : 'disabled'}`, profile.id);
    return { file: path.basename(to), enabled: disabled };
  });

  ipcMain.handle('instance:deleteMod', (_e, profileId, file) => {
    const profile = store.getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    const dir = path.join(profile.gameDir || store.profileDir(profile.id), 'mods');
    const target = path.join(dir, path.basename(file));
    if (!fs.existsSync(target)) throw new Error('That mod file is gone.');
    fs.rmSync(target, { force: true });
    log(`Deleted ${path.basename(file)}`, profile.id);
    return true;
  });

  ipcMain.handle('instance:reveal', (_e, target) => {
    if (!target || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  /**
   * Looks the installed mod up on Modrinth so a version can be swapped.
   * The jar itself does not store the project id, so it is matched by name.
   */
  ipcMain.handle('instance:modLookup', async (_e, profileId, name) => {
    const profile = store.getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    const gameVersion = fabric.baseMinecraftVersion(profile.versionId || '');
    const found = await modrinth.search({ query: name, projectType: 'mod', gameVersion, loader: 'fabric', limit: 5 });
    const hits = found.hits || [];
    if (!hits.length) return { project: null, versions: [] };
    const exact = hits.find((hit) => String(hit.title).toLowerCase() === String(name).toLowerCase());
    const project = exact || hits[0];
    const versions = await modrinth.projectVersions(project.id, { gameVersion, loader: 'fabric' });
    return {
      project: { id: project.id, title: project.title, iconUrl: project.iconUrl, description: project.description },
      versions: versions.map((version) => ({
        id: version.id,
        name: version.name,
        version: version.version_number,
        downloads: version.downloads,
        gameVersions: version.game_versions || [],
        loaders: version.loaders || []
      }))
    };
  });

  ipcMain.handle('instance:modSearch', async (_e, profileId, query) => {
    const profile = store.getProfile(profileId);
    if (!profile) throw new Error('Profile not found.');
    const gameVersion = fabric.baseMinecraftVersion(profile.versionId || '');
    return modrinth.search({ query, projectType: 'mod', gameVersion, loader: 'fabric', limit: 12 });
  });

  ipcMain.handle('instance:worlds', (_e, id) => {
    const profile = store.getProfile(id);
    if (!profile) return [];
    const dir = path.join(profile.gameDir || store.profileDir(profile.id), 'saves');
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const stat = fs.statSync(path.join(dir, entry.name));
          return { name: entry.name, modifiedAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    } catch {
      return [];
    }
  });

  /* -------------------------------------------------------------- updates */

  ipcMain.handle('updates:check', () => checkForUpdates());

  ipcMain.handle('updates:install', async () => {
    const info = updateState?.available ? updateState : await checkForUpdates();
    if (!info?.available) throw new Error('SallyLauncher is already on the newest release.');
    /* Only the packed app.asar is replaced – no reinstall, settings stay. */
    if (!patch.canPatch() || !info.patch) {
      /* No app.asar attached: fall back to the full setup instead of only
         opening the browser – that is what makes an update possible at all. */
      if (info.asset?.url) {
        setGameState('preparing', { versionId: info.latestVersion });
        try {
          const file = await updates.downloadInstaller(info, {
            targetDir: path.join(app.getPath('temp'), 'SallyLauncher-update'),
            onProgress: (progress) => send('progress', progress)
          });
          setGameState('idle');
          log(`Setup ${info.asset.name} downloaded – starting the installer.`);
          const failure = await shell.openPath(file);
          if (failure) throw new Error(failure);
          return { installer: file };
        } catch (err) {
          setGameState('idle', { error: err.message });
          log(`Update failed: ${err.message}`);
          throw err;
        }
      }
      await shell.openExternal(info.htmlUrl || updates.RELEASES_PAGE);
      return { opened: true };
    }
    setGameState('preparing', { versionId: info.latestVersion });
    try {
      const result = await patch.apply(info, {
        onProgress: (progress) => send('progress', progress)
      });
      log(`Update ${info.latestVersion} ready – launcher restarts, running games stay open.`);
      setGameState('idle');
      return { patched: true, ...result };
    } catch (err) {
      log(`Update failed: ${err.message}`);
      setGameState('idle', { error: err.message });
      throw err;
    }
  });

  ipcMain.handle('updates:openRelease', async (_e, url) => {
    const target = /^https:\/\/github\.com\//i.test(String(url || '')) ? url : updateState?.htmlUrl || updates.RELEASES_PAGE;
    await shell.openExternal(target);
    return true;
  });

  /** Starts one profile; several profiles may run at the same time. */
  ipcMain.handle('launch:start', async (_e, payload = {}) => {
    const requested = payload?.profileId ? store.getProfile(payload.profileId) : null;
    if (payload?.profileId && !requested) throw new Error('That profile no longer exists.');
    const profile = requested || store.getActiveProfile();
    if (!profile) throw new Error('Create a profile first.');
    if (launches.has(profile.id)) throw new Error(`${profile.name} is already running.`);

    const settings = store.effectiveSettings(profile);
    let account = store.getAccount();
    if (!account) throw new Error('Create an account first.');
    if (account.type === 'msa') {
      const session = await ensureMinecraftSession(account);
      account = { ...account, name: session.name, uuid: session.uuid, accessToken: session.accessToken };
    }

    let versionId = profile.versionId || null;
    if (!versionId) {
      versionId = await pickDefaultVersion(settings.gameDir);
      if (versionId && profile) {
        store.setProfileVersion(profile.id, versionId);
        send('state', snapshot());
      }
    }
    if (!versionId) throw new Error('No Minecraft version installed yet – install one on the Versions page.');

    let required = null;
    try {
      const meta = await mojang.resolveVersion(settings.gameDir, versionId);
      required = meta.javaVersion?.majorVersion || null;
    } catch (err) {
      log(`Could not read Java requirements: ${err.message}`);
    }

    const java = await currentJava(required);
    if (!java) {
      throw new Error(
        `No Java runtime found${required ? ` – ${versionId} needs Java ${required} or newer` : ''}. Install Java or set a java.exe in Settings.`
      );
    }
    if (required && java.major < required) {
      throw new Error(
        `Java ${required}+ is required for ${versionId} but ${java.path} reports Java ${java.major}. Set a newer java.exe in Settings.`
      );
    }

    /* The instance's loader decides what gets prepared: Fabric gets its profile
       JSON plus the bundled client mod, Forge gets installed, vanilla stays as
       it is. */
    const loaderId = loaders.normalizeLoader(profile.loader);
    let launchVersion = versionId;
    setLaunch(profile.id, { state: 'preparing', versionId, name: profile.name });
    if (loaderId !== 'vanilla') {
      launchVersion = await prepareLoader(profile, settings, { onLog: (line) => log(line, profile.id) });
    }
    const clientReport = await fabric.prepareClientMods({
      gameDir: settings.gameDir,
      runtimeDir: store.sharedDir(),
      versionId: launchVersion,
      loader: loaderId,
      loaderVersion: profile.loaderVersion || '',
      enabled: true,
      onLog: (line) => log(line, profile.id)
    });
    if (clientReport.fabricVersionId) launchVersion = clientReport.fabricVersionId;
    if (clientReport.injected.length) {
      log(`Client mods active: ${clientReport.injected.map((mod) => `${mod.name} ${mod.version}`).join(', ')}`);
    }
    if (clientReport.skipped.length) {
      log(
        `Mods parked for this version (wrong Minecraft target): ${clientReport.skipped
          .map((mod) => `${mod.name} needs ${mod.minecraft}`)
          .join(', ')}`
      );
    }
    if (clientReport.parked?.length) {
      log(
        `Other mods parked because they target another Minecraft version: ${clientReport.parked
          .map((mod) => `${mod.name} needs ${mod.minecraft}`)
          .join(', ')}`
      );
    }
    if (clientReport.error) log(`Client mods could not be prepared: ${clientReport.error}`);

    setLaunch(profile.id, { versionId: launchVersion });
    log(`Launching ${launchVersion} as ${account.name} with ${java.path} (${profile.name})`);
    try {
      const { pid } = await mojang.launch({
        key: profile.id,
        gameDir: settings.gameDir,
        versionId: launchVersion,
        settings,
        javaPath: java.path,
        account,
        onProgress: (p) => send('progress', p),
        onLog: (line) => log(line, profile.id),
        onExit: ({ code, signal }) => {
          log(`${profile.name} closed (${signal ? `signal ${signal}` : `code ${code}`})`, profile.id);
          finishSession(profile.id);
          clearLaunch(profile.id, { exitCode: code, signal, profileId: profile.id });
        }
      });
      setLaunch(profile.id, { state: 'running', versionId: launchVersion, pid, startedAt: Date.now() }, { started: profile.id });
      store.touchPlayed(profile.id);
      send('state', snapshot());
      return { ok: true, profileId: profile.id, versionId: launchVersion, pid };
    } catch (err) {
      log(`Launch failed: ${err.message}`);
      clearLaunch(profile.id, { error: err.message, profileId: profile.id });
      throw err;
    }
  });

  ipcMain.handle('launch:stop', (_e, payload = {}) => {
    const profileId = payload?.profileId || null;
    if (profileId) {
      const name = launches.get(profileId)?.name || store.getProfile(profileId)?.name || 'Minecraft';
      const killed = mojang.stop(profileId);
      if (killed) log(`${name} stopped by user.`, profileId);
      finishSession(profileId);
      clearLaunch(profileId, { profileId });
      return killed;
    }

    const hadLaunches = launches.size > 0;
    for (const id of [...launches.keys()]) finishSession(id);
    const killed = mojang.stop();
    launches.clear();
    if (killed) log('All Minecraft processes stopped by user.');
    if (killed || hadLaunches) publishGame();
    return killed;
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.on('window:toggleMax', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
}

/* --------------------------------------------------------------- updates */

/** Reads the newest GitHub release once; callers share the running request. */
function checkForUpdates() {
  if (updateCheck) return updateCheck;
  updateCheck = updates
    .check({ currentVersion: app.getVersion() })
    .then((info) => {
      const before = updateState?.latestVersion;
      updateState = info;
      if (info.noRelease) log('No SallyLauncher release on GitHub yet – update check stays idle.');
      else if (info.error) log(`Update check failed: ${info.error}`);
      else if (info.available) log(`SallyLauncher ${info.latestVersion} is available (you run ${info.currentVersion}).`);
      else if (before !== info.latestVersion) log(`SallyLauncher is up to date (${info.currentVersion}).`);
      send('state', snapshot());
      return info;
    })
    .finally(() => {
      updateCheck = null;
    });
  return updateCheck;
}

/* ----------------------------------------------------------------- stats */

function startStats() {
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const mem = memoryStats();
    send('stats', {
      cpu: cpuPercent(),
      memPercent: mem.percent,
      memUsedMb: mem.usedMb,
      memTotalMb: mem.totalMb,
      launcherRss: Math.round(process.memoryUsage().rss / 1048576)
    });
  }, 1200).unref?.();
}

/* ---------------------------------------------------------------- window */

/* A driver can composite acrylic as a blank frame without crashing. Sampling the
   first glass frame catches that and drops back to the solid window. */
function verifyFirstGlassFrame() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
  Promise.race([mainWindow.webContents.capturePage(), timer])
    .then((image) => {
      if (!image || !image.getSize) return;
      const { width, height } = image.getSize();
      if (!width || !height) return;
      const bitmap = image.getBitmap();
      let sampled = 0;
      let white = 0;
      for (let y = 4; y < height; y += 24) {
        for (let x = 4; x < width; x += 24) {
          const i = (y * width + x) * 4;
          if (i + 3 > bitmap.length) continue;
          sampled += 1;
          if (bitmap[i] > 244 && bitmap[i + 1] > 244 && bitmap[i + 2] > 244) white += 1;
        }
      }
      const ratio = sampled ? white / sampled : 0;
      if (process.env.SALLY_DEBUG) log('Glass frame sampled: ' + Math.round(ratio * 100) + '% white');
      /* a light theme is legitimately almost white – only dark themes prove a blank frame */
      const darkTheme = (store.get().settings?.theme || 'midnight') !== 'light';
      if (darkTheme && ratio > 0.97) {
        log('Glass frame came back blank (' + Math.round(ratio * 100) + '%) – using the solid window.');
        writeSafeStart(true, 'blank-glass-frame');
        setGlass(false);
      }
    })
    .catch((err) => log('Glass frame check skipped: ' + (err?.message || err)));
}

function setGlass(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (on && safeStartMode) return;
  try {
    mainWindow.setBackgroundMaterial(on ? 'acrylic' : 'none');
    mainWindow.setBackgroundColor(on ? '#00000000' : '#16151d');
  } catch (err) {
    log('Glass not available: ' + err.message);
    try {
      mainWindow.setBackgroundColor('#16151d');
    } catch {
      /* nothing left to try */
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    show: false,
    /* solid first: acrylic is switched on after the first paint, so a driver
       that cannot composite it can never leave a blank window */
    backgroundColor: '#16151d',
    roundedCorners: true,
    title: 'SallyLauncher',
    icon: path.join(RENDERER_DIR, 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const glassWanted = !safeStartMode && store.get().settings?.glass !== false;

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (glassWanted) {
      setTimeout(() => {
        setGlass(true);
        setTimeout(verifyFirstGlassFrame, 2600);
      }, 1400);
    }
  });

  /* If the first paint never reports back, show the window anyway. */
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('Window did not become ready in time – showing it now.');
      writeSafeStart(true, 'ready-to-show timeout');
      mainWindow.show();
    }
  }, 8000).unref?.();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('console-message', (_event, levelOrDetails, message) => {
    if (levelOrDetails && typeof levelOrDetails === 'object') {
      const detail = levelOrDetails;
      log(`[renderer:${detail.level}] ${detail.message} (${detail.sourceId || ''}:${detail.lineNumber || 0})`);
    } else {
      log(`[renderer:${levelOrDetails}] ${message}`);
    }
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log(`Preload failed (${preloadPath}): ${error?.message || error}`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`Page failed to load (${code}): ${description} – ${url}`);
  });

  let recoveries = 0;
  const recover = (reason) => {
    log('Recovering renderer: ' + reason);
    writeSafeStart(true, reason);
    if (recoveries >= 2) return;
    recoveries += 1;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 600);
  };

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recover('render-process-gone:' + (details?.reason || 'unknown'));
  });
  mainWindow.on('unresponsive', () => {
    log('Window unresponsive.');
    writeSafeStart(true, 'unresponsive');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    writeSafeStart(false);
  });

  mainWindow.loadURL('sally://app/index.html');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/*
 * Software rendering escape hatch.
 *
 * On a machine whose GPU driver freezes the desktop, the launcher is the wrong
 * place to fight it: this switch turns Chromium's GPU compositing off. It has
 * to be decided before `ready`, so the setting is read straight from the state
 * file instead of through the Store.
 */
function prefersSoftwareRendering() {
  try {
    const file = path.join(app.getPath('userData'), 'sallylauncher.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved?.settings?.hardwareAcceleration === false;
  } catch {
    return false;
  }
}

if (prefersSoftwareRendering() || safeStartMode) {
  app.disableHardwareAcceleration();
  log(
    safeStartMode
      ? 'Safe start: last run failed – hardware acceleration and glass are off.'
      : 'Hardware acceleration disabled – running on the software renderer.'
  );
}

/* One launcher at a time – a second start focuses the window that is open. */
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  protocol.handle('sally', async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const filePath = path.normalize(path.join(RENDERER_DIR, rel));
      if (!filePath.startsWith(RENDERER_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      const data = await fsp.readFile(filePath);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          /* the UI is read from disk on every start – never serve a stale copy */
          'cache-control': 'no-store'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  store.load();
  mojang.setSharedDir(store.sharedDir());
  createWindow();
  startStats();

  /* one check on startup, then every six hours */
  syncDiscord().catch(() => {});
  setTimeout(() => checkForUpdates().catch(() => {}), 2500);
  setInterval(() => checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000).unref?.();

  /* the SallyClient mod follows sallyclient.stream, not the launcher release */
  setTimeout(async () => {
    try {
      const build = await clientmod.ensure({ onLog: (line) => log(line) });
      if (build && build.path) fabric.useClientJar(build.path);
      /* every Fabric profile that runs this client build gets the jar */
      let installed = 0;
      for (const profile of store.get().profiles || []) {
        if (!profile || !profile.versionId || !profile.gameDir) continue;
        if (loaders.normalizeLoader(profile.loader) !== 'fabric') continue;
        try {
          const result = await fabric.syncClientMod({
            gameDir: profile.gameDir,
            versionId: profile.versionId,
            onLog: (line) => log(line)
          });
          if (result) {
            installed += 1;
            if (result.updated) log('SallyClient ' + result.version + ' added to ' + profile.name);
          }
        } catch (err) {
          log('SallyClient for ' + profile.name + ' skipped: ' + err.message);
        }
      }
      if (installed) {
        log('SallyClient ' + build.version + ' is in ' + installed + ' Fabric profile(s)');
        send('state', snapshot());
      }
    } catch (err) {
      log('SallyClient update skipped: ' + err.message);
    }
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* Closing the launcher never touches a running game – Minecraft keeps going. */
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  rpc.stop({ silent: true }).catch(() => {});
});
