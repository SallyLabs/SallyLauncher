'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/** Each profile owns its instance folder – the launcher never writes into
    the vanilla `.minecraft` directory. */
function instancesRoot() {
  return path.join(app.getPath('userData'), 'instances');
}

function profileDir(id) {
  return path.join(instancesRoot(), String(id));
}

/** Libraries, assets and version files are shared by every instance. */
function sharedDir() {
  return path.join(app.getPath('userData'), 'shared');
}

function legacyGameDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, '.minecraft');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  }
  return path.join(os.homedir(), '.minecraft');
}

function sanitizeName(raw) {
  const cleaned = String(raw || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return cleaned.length >= 3 ? cleaned : 'Player';
}

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32)
  ].join('-');
}

/* Tokens never sit in the JSON as plain text: the OS keystore (DPAPI on
   Windows) encrypts them when it is available. */
function encryptSecret(value) {
  if (!value) return '';
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(String(value)).toString('base64')}`;
    }
  } catch {
    /* fall through to the obfuscated variant */
  }
  return `raw:${Buffer.from(String(value), 'utf8').toString('base64')}`;
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:') && safeStorage) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    }
    if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch {
    return '';
  }
  return '';
}

function dashedUuid(id) {
  const clean = String(id || '').replace(/-/g, '');
  if (clean.length !== 32) return String(id || '');
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

function makeAccount(name, type = 'offline') {
  const clean = sanitizeName(name);
  return {
    id: crypto.randomUUID(),
    name: clean,
    type,
    uuid: offlineUuid(clean)
  };
}

function makeProfile(patch = {}) {
  const id = patch.id || crypto.randomUUID();
  return {
    id,
    name: patch.name || 'New profile',
    versionId: patch.versionId || null,
    loader: patch.loader === 'vanilla' || patch.loader === 'forge' ? patch.loader : 'fabric',
    loaderVersion: patch.loaderVersion || null,
    gameDir: patch.gameDir || profileDir(id),
    modpack: patch.modpack || null,
    memoryMb: Math.max(1024, Math.min(32768, Number(patch.memoryMb) || 4096)),
    jvmArgs: patch.jvmArgs || '',
    serverAddress: patch.serverAddress || '',
    playtimeMs: Math.max(0, Math.round(Number(patch.playtimeMs) || 0)),
    lastPlayedAt: patch.lastPlayedAt || null,
    customResolution: Boolean(patch.customResolution),
    resolutionWidth: Number(patch.resolutionWidth) || 1280,
    resolutionHeight: Number(patch.resolutionHeight) || 720,
    createdAt: new Date().toISOString()
  };
}

const DEFAULTS = () => ({
  settings: {
    gameDir: instancesRoot(),
    javaPath: '',
    memoryMb: 4096,
    jvmArgs: '',
    fullscreen: false,
    customResolution: false,
    resolutionWidth: 1280,
    resolutionHeight: 720,
    autoConnect: false,
    serverAddress: '',
    showConsole: true,
    demoMode: false,
    injectClientMod: true,
    msaClientId: '',
    discordRpc: true,
    cosmeticId: 'sally-crown',
    skinLibrary: [],
    skinId: 'account',
    theme: 'dark'
  },
  accounts: [],
  activeAccountId: null,
  profiles: [],
  activeProfileId: null,
  selectedVersion: null
});

class Store {
  constructor() {
    this.file = () => path.join(app.getPath('userData'), 'sallylauncher.json');
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    const base = DEFAULTS();
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch {
      saved = {};
    }

    const data = {
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings || {}) },
      accounts: Array.isArray(saved.accounts) ? saved.accounts : [],
      activeAccountId: saved.activeAccountId || null,
      profiles: Array.isArray(saved.profiles) ? saved.profiles.filter(Boolean) : [],
      activeProfileId: saved.activeProfileId || null,
      selectedVersion: saved.selectedVersion || null
    };

    /* Older builds stored a personal Modrinth token. Login is no longer used;
       omit the field and persist this migration so the token is removed. */
    delete data.modrinth;
    /* The Discord application ID is shipped in .env and is not user data. */
    delete data.settings.discordClientId;

    if (!data.accounts.length) {
      const account = makeAccount(os.userInfo().username || 'Steve');
      data.accounts = [account];
      data.activeAccountId = account.id;
    }
    if (!data.accounts.some((a) => a.id === data.activeAccountId)) {
      data.activeAccountId = data.accounts[0]?.id || null;
    }

    /* Profiles from before the loader picker are Fabric instances. */
    for (const profile of data.profiles) {
      if (!profile.loader) profile.loader = 'fabric';
    }

    if (!data.profiles.length) {
      const profile = makeProfile({
        name: 'Default',
        versionId: data.selectedVersion || null,
        memoryMb: data.settings.memoryMb,
        customResolution: data.settings.customResolution,
        resolutionWidth: data.settings.resolutionWidth,
        resolutionHeight: data.settings.resolutionHeight,
        serverAddress: data.settings.serverAddress
      });
      data.profiles = [profile];
      data.activeProfileId = profile.id;
    }
    if (!data.profiles.some((p) => p.id === data.activeProfileId)) {
      data.activeProfileId = data.profiles[0].id;
    }
    /* Older builds shared the vanilla `.minecraft` folder; every profile now
       gets its own instance directory instead. */
    for (const profile of data.profiles) {
      if (!profile.gameDir || path.resolve(profile.gameDir) === path.resolve(legacyGameDir())) {
        profile.gameDir = profileDir(profile.id);
      }
      if (!profile.modpack) profile.modpack = null;
      if (!Number.isFinite(Number(profile.playtimeMs))) profile.playtimeMs = 0;
      if (!profile.lastPlayedAt) profile.lastPlayedAt = null;
    }

    this.data = data;
    this.save();
    return data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save launcher state:', err.message);
    }
  }

  get() {
    return this.load();
  }

  updateSettings(patch = {}) {
    const data = this.load();
    const safePatch = { ...patch };
    delete safePatch.discordClientId;
    const next = { ...data.settings, ...safePatch };
    next.memoryMb = Math.max(1024, Math.min(32768, Math.round(Number(next.memoryMb) || 4096)));
    next.resolutionWidth = Math.max(320, Math.round(Number(next.resolutionWidth) || 1280));
    next.resolutionHeight = Math.max(240, Math.round(Number(next.resolutionHeight) || 720));
    data.settings = next;
    this.save();
    return data.settings;
  }

  /* ---------------------------------------------------------- accounts */

  getAccount() {
    const data = this.load();
    return data.accounts.find((a) => a.id === data.activeAccountId) || data.accounts[0] || null;
  }

  addAccount(name) {
    const data = this.load();
    const account = makeAccount(name);
    data.accounts.push(account);
    data.activeAccountId = account.id;
    this.save();
    return account;
  }

  removeAccount(id) {
    const data = this.load();
    data.accounts = data.accounts.filter((a) => a.id !== id);
    if (!data.accounts.length) {
      const account = makeAccount('Player');
      data.accounts.push(account);
      data.activeAccountId = account.id;
    } else if (data.activeAccountId === id) {
      data.activeAccountId = data.accounts[0].id;
    }
    this.save();
  }

  selectAccount(id) {
    const data = this.load();
    if (data.accounts.some((a) => a.id === id)) {
      data.activeAccountId = id;
      this.save();
    }
  }

  /* ------------------------------------------------------- microsoft */

  publicAccount(account) {
    if (!account) return null;
    const { minecraftTokenEnc, msaRefreshTokenEnc, ...rest } = account;
    return rest;
  }

  publicAccounts() {
    return this.load().accounts.map((account) => this.publicAccount(account));
  }

  addMsaAccount({ profile, xuid = '', minecraftToken = '', minecraftTokenExpiresAt = 0, msaRefreshToken = '', clientId = '', flow = '' }) {
    const data = this.load();
    const uuid = dashedUuid(profile.uuid);
    let account = data.accounts.find((entry) => entry.type === 'msa' && (entry.uuid === uuid || (xuid && entry.xuid === xuid)));
    if (!account) {
      account = { id: crypto.randomUUID(), type: 'msa', addedAt: new Date().toISOString() };
      data.accounts.push(account);
    }
    Object.assign(account, {
      name: profile.name,
      uuid,
      xuid,
      clientId,
      flow,
      skinUrl: profile.skinUrl || null,
      skinVariant: profile.skinVariant || null,
      minecraftTokenEnc: encryptSecret(minecraftToken),
      minecraftTokenExpiresAt,
      msaRefreshTokenEnc: encryptSecret(msaRefreshToken)
    });
    data.activeAccountId = account.id;
    this.save();
    return account;
  }

  getAccountSecrets(id) {
    const account = this.load().accounts.find((entry) => entry.id === id) || null;
    if (!account) return null;
    return {
      account,
      minecraftToken: decryptSecret(account.minecraftTokenEnc),
      msaRefreshToken: decryptSecret(account.msaRefreshTokenEnc)
    };
  }

  updateMsaTokens(id, { minecraftToken, minecraftTokenExpiresAt, msaRefreshToken, profile } = {}) {
    const data = this.load();
    const account = data.accounts.find((entry) => entry.id === id);
    if (!account) return null;
    if (minecraftToken !== undefined) account.minecraftTokenEnc = encryptSecret(minecraftToken);
    if (minecraftTokenExpiresAt !== undefined) account.minecraftTokenExpiresAt = minecraftTokenExpiresAt;
    if (msaRefreshToken) account.msaRefreshTokenEnc = encryptSecret(msaRefreshToken);
    if (profile) {
      account.name = profile.name;
      account.uuid = dashedUuid(profile.uuid);
      account.skinUrl = profile.skinUrl || null;
      account.skinVariant = profile.skinVariant || null;
    }
    this.save();
    return account;
  }

  /* ---------------------------------------------------------- profiles */

  getProfile(id) {
    const data = this.load();
    return data.profiles.find((p) => p.id === id) || null;
  }

  getActiveProfile() {
    const data = this.load();
    return data.profiles.find((p) => p.id === data.activeProfileId) || data.profiles[0] || null;
  }

  createProfile(patch = {}) {
    const data = this.load();
    const profile = makeProfile(patch);
    if (patch.gameDir) {
      const requestedDir = path.resolve(patch.gameDir);
      const conflict = data.profiles.find((entry) => path.resolve(entry.gameDir || profileDir(entry.id)) === requestedDir);
      if (conflict) throw new Error(`That instance folder already belongs to ${conflict.name}. Choose a different folder.`);
      profile.gameDir = patch.gameDir;
    }
    data.profiles.push(profile);
    data.activeProfileId = profile.id;
    this.save();
    return profile;
  }

  profileDir(id) {
    return profileDir(id);
  }

  sharedDir() {
    return sharedDir();
  }

  updateProfile(id, patch = {}) {
    const data = this.load();
    const profile = data.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Profile not found');
    Object.assign(profile, {
      ...patch,
      memoryMb: Math.max(1024, Math.min(32768, Number(patch.memoryMb ?? profile.memoryMb) || 4096)),
      resolutionWidth: Math.max(320, Number(patch.resolutionWidth ?? profile.resolutionWidth) || 1280),
      resolutionHeight: Math.max(240, Number(patch.resolutionHeight ?? profile.resolutionHeight) || 720)
    });
    this.save();
    return profile;
  }

  duplicateProfile(id) {
    const data = this.load();
    const source = data.profiles.find((p) => p.id === id);
    if (!source) throw new Error('Profile not found');
    /* a copy starts with a clean stopwatch */
    const copy = makeProfile({ ...source, id: null, gameDir: '', name: `${source.name} copy`, playtimeMs: 0, lastPlayedAt: null });
    data.profiles.push(copy);
    data.activeProfileId = copy.id;
    this.save();
    return copy;
  }

  removeProfile(id) {
    const data = this.load();
    if (data.profiles.length <= 1) throw new Error('Keep at least one profile');
    data.profiles = data.profiles.filter((p) => p.id !== id);
    if (data.activeProfileId === id) data.activeProfileId = data.profiles[0].id;
    this.save();
  }

  selectProfile(id) {
    const data = this.load();
    if (data.profiles.some((p) => p.id === id)) {
      data.activeProfileId = id;
      this.save();
    }
  }

  setProfileVersion(id, versionId) {
    return this.updateProfile(id, { versionId });
  }

  /** Adds one finished (or still running) session to the profile's stopwatch. */
  addPlaytime(id, ms) {
    const data = this.load();
    const profile = data.profiles.find((p) => p.id === id);
    if (!profile) return null;
    profile.playtimeMs = (Number(profile.playtimeMs) || 0) + Math.max(0, Math.round(Number(ms) || 0));
    this.save();
    return profile;
  }

  /** Remembers that a profile was started so lists can sort by recency. */
  touchPlayed(id) {
    const data = this.load();
    const profile = data.profiles.find((p) => p.id === id);
    if (!profile) return null;
    profile.lastPlayedAt = new Date().toISOString();
    this.save();
    return profile;
  }

  totalPlaytime() {
    return this.load().profiles.reduce((sum, profile) => sum + (Number(profile.playtimeMs) || 0), 0);
  }

  /* Effective settings for a launch: profile values win over global ones. */
  effectiveSettings(profile = null) {
    const data = this.load();
    const settings = data.settings;
    if (!profile) return { ...settings, gameDir: profileDir('default'), sharedDir: sharedDir() };
    return {
      ...settings,
      sharedDir: sharedDir(),
      gameDir: profile.gameDir || profileDir(profile.id),
      memoryMb: profile.memoryMb || settings.memoryMb,
      jvmArgs: profile.jvmArgs || settings.jvmArgs,
      serverAddress: profile.serverAddress || settings.serverAddress,
      customResolution: profile.customResolution,
      resolutionWidth: profile.resolutionWidth || settings.resolutionWidth,
      resolutionHeight: profile.resolutionHeight || settings.resolutionHeight
    };
  }
}

module.exports = { Store, profileDir, instancesRoot, sharedDir, offlineUuid };
