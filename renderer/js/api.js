/**
 * Thin wrapper around the Electron preload bridge. When the renderer is opened
 * in a plain browser (design preview) it falls back to demo data so the UI can
 * still be explored.
 */

const bridge = typeof window !== 'undefined' ? window.sally : undefined;
const desktop = Boolean(bridge);

function cleanMessage(message) {
  return String(message || 'Something went wrong')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

const demoState = {
  settings: {
    gameDir: 'C:\\Users\\you\\AppData\\Roaming\\.minecraft',
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
    discordRpc: true,
    cosmeticId: 'sally-crown',
    skinLibrary: [],
    skinId: 'account',
    theme: 'dark'
  },
  accounts: [{ id: 'demo-1', name: '__rawr_', type: 'offline', uuid: '0d3a3c2e-8c9b-3f80-9d61-11c8c4c3b1a7' }],
  activeAccountId: 'demo-1',
  activeAccount: { id: 'demo-1', name: '__rawr_', type: 'offline', uuid: '0d3a3c2e-8c9b-3f80-9d61-11c8c4c3b1a7' },
  profiles: [
    {
      id: 'p-1',
      name: 'Vanilla 26.3',
      versionId: '26.3',
      gameDir: '',
      memoryMb: 4096,
      jvmArgs: '',
      serverAddress: '',
      customResolution: false,
      resolutionWidth: 1280,
      resolutionHeight: 720,
      playtimeMs: 21780000,
      lastPlayedAt: '2026-11-01T18:20:00Z',
      createdAt: '2026-09-20T10:00:00Z'
    },
    {
      id: 'p-2',
      name: 'Fabric Performance',
      versionId: 'fabric-loader-0.19.5-26.3',
      gameDir: 'D:\\Minecraft\\fabric',
      memoryMb: 6144,
      jvmArgs: '-XX:+UseG1GC',
      serverAddress: '',
      customResolution: true,
      resolutionWidth: 1920,
      resolutionHeight: 1080,
      playtimeMs: 5400000,
      lastPlayedAt: '2026-10-30T15:05:00Z',
      createdAt: '2026-10-02T18:30:00Z'
    }
  ],
  activeProfileId: 'p-1',
  activeProfile: null,
  selectedVersion: '26.3',
  discord: { enabled: false, status: 'off', error: null, activity: null },
  update: {
    available: true,
    currentVersion: '1.2.2',
    latestVersion: '1.2.2',
    name: 'SallyLauncher 1.2.2',
    notes: 'Faster modpack installs, update checks and a Windows installer.',
    publishedAt: '2026-10-28T12:00:00Z',
    htmlUrl: 'https://github.com/SallyLabs/SallyLauncher/releases/latest',
    releasesUrl: 'https://github.com/SallyLabs/SallyLauncher/releases/latest',
    repo: 'SallyLabs/SallyLauncher',
    asset: { name: 'SallyLauncher-Setup-1.2.2.exe', url: '#', size: 0 },
    checkedAt: '2026-11-01T09:00:00Z',
    error: null
  },
  gameState: 'idle',
  instances: [],
  status: { running: false, versionId: null },
  appVersion: '1.2.2',
  platform: 'win32'
};

const demoVersions = {
  installed: [
    { id: '26.3', loader: 'Vanilla', type: 'release', releaseTime: '2026-09-18T00:00:00Z' },
    { id: '26.2', loader: 'Vanilla', type: 'release', releaseTime: '2026-06-11T00:00:00Z' },
    { id: 'fabric-loader-0.19.5-26.3', loader: 'Fabric', type: 'release', releaseTime: '2026-09-22T00:00:00Z' }
  ],
  available: [
    { id: '26.3', loader: 'Vanilla', type: 'release', releaseTime: '2026-09-18T00:00:00Z' },
    { id: '26.2', loader: 'Vanilla', type: 'release', releaseTime: '2026-06-11T00:00:00Z' },
    { id: '26.3-snapshot-10', loader: 'Vanilla', type: 'snapshot', releaseTime: '2026-10-02T00:00:00Z' },
    { id: '26.1', loader: 'Vanilla', type: 'release', releaseTime: '2026-03-05T00:00:00Z' }
  ],
  selectedVersion: '26.3'
};

demoState.activeProfile = demoState.profiles.find((p) => p.id === demoState.activeProfileId);

demoState.snapshot = () => {
  const profile = demoState.profiles.find((p) => p.id === demoState.activeProfileId) || demoState.profiles[0];
  demoState.activeProfile = profile;
  demoState.selectedVersion = profile?.versionId || null;
  return structuredClone({ ...demoState, snapshot: undefined });
};

function demoInvoke(channel, ...args) {
  const payload = args[0];
  switch (channel) {
    case 'state:get':
      return demoState.snapshot();
    case 'settings:update':
      Object.assign(demoState.settings, payload || {});
      return structuredClone(demoState.settings);
    case 'profiles:create':
      {
        const id = `p-${Date.now()}`;
        demoState.profiles.push({
          ...payload,
          id,
          gameDir: payload?.gameDir || `C:\\Users\\you\\AppData\\Roaming\\SallyLauncher\\instances\\${id}`,
          createdAt: new Date().toISOString()
        });
      }
      demoState.activeProfileId = demoState.profiles[demoState.profiles.length - 1].id;
      return demoState.snapshot();
    case 'profiles:update': {
      const target = demoState.profiles.find((p) => p.id === args[0]);
      if (target) Object.assign(target, args[1] || {});
      return target;
    }
    case 'profiles:duplicate': {
      const source = demoState.profiles.find((p) => p.id === args[0]);
      if (source) {
        const copy = { ...source, id: `p-${Date.now()}`, name: `${source.name} copy` };
        demoState.profiles.push(copy);
        demoState.activeProfileId = copy.id;
      }
      return true;
    }
    case 'profiles:remove':
      if (demoState.profiles.length > 1) demoState.profiles = demoState.profiles.filter((p) => p.id !== args[0]);
      if (!demoState.profiles.some((p) => p.id === demoState.activeProfileId)) {
        demoState.activeProfileId = demoState.profiles[0].id;
      }
      return true;
    case 'profiles:select':
      demoState.activeProfileId = args[0];
      return true;
    case 'versions:list':
      return structuredClone({ ...demoVersions, selectedVersion: demoState.snapshot().selectedVersion });
    case 'versions:select': {
      const profile = demoState.profiles.find((p) => p.id === demoState.activeProfileId);
      if (profile) profile.versionId = payload;
      demoVersions.selectedVersion = payload;
      return true;
    }
    case 'java:detect':
      return { path: 'C:\\Program Files\\Java\\jdk-25\\bin\\javaw.exe', version: '25.0.4', major: 25 };
    case 'logs:get':
      return [
        { text: '[SallyLauncher] Demo preview – no Electron bridge detected.', profile: null },
        { text: '[SallyLauncher] Start the app with "npm start" to launch Minecraft.', profile: null }
      ];
    case 'instance:mods':
      return [
        { file: 'fabric-api-0.141.6+26.3.jar', name: 'Fabric API', version: '0.141.6+26.3', sizeMb: 2.1, modifiedAt: '2026-10-20T10:00:00Z' },
        { file: 'sodium-fabric-0.6.9.jar', name: 'Sodium', version: '0.6.9', sizeMb: 1.4, modifiedAt: '2026-10-20T10:00:00Z' }
      ];
    case 'instance:worlds':
      return [{ name: 'New World', modifiedAt: '2026-11-01T19:00:00Z' }];
    case 'client:info':
      return {
        enabled: true,
        versionId: demoState.snapshot().selectedVersion,
        mcVersion: '26.3',
        modsDir: 'C:\\Users\\you\\AppData\\Roaming\\.minecraft\\mods',
        mods: [
          { id: 'sallyclient', name: 'SallyClient', version: '1.0.0', file: 'sallyclient-1.0.0.jar', minecraft: '~26.3', requiresFabricApi: true, supported: true }
        ]
      };
    case 'updates:check':
      demoState.update.checkedAt = new Date().toISOString();
      return structuredClone(demoState.update);
    case 'updates:install':
      return { started: true };
    case 'servers:list':
      return {
        servers: [
          { id: 'sallylabs', name: 'SallyLabs', address: 'mc.sallylabs.net', description: 'The SallyLabs home server', languages: ['de', 'en'], featured: true, banner: null },
          { id: 'hypixel', name: 'Hypixel', address: 'hypixel.net', description: 'SkyBlock, Bed Wars and a lot more', languages: ['en'], featured: true, banner: null },
          { id: 'gommehd', name: 'GommeHD', address: 'gommehd.net', description: 'BedWars, SkyWars and more', languages: ['de'], featured: true, banner: null },
          { id: 'katzensmp', name: 'KatzenSMP', address: 'katzensmp.net', description: 'ForeverWorld', languages: ['de'], featured: false, banner: null }
        ],
        fetchedAt: new Date().toISOString(),
        fromCache: true,
        error: null
      };
    case 'cosmetics:list':
      return {
        version: '1.9.17',
        configured: true,
        items: [
          { id: 'little_star', name: 'Little Star', slot: 'halo', collection: 'basics', price: 250, image: null, worn: false, owned: false },
          { id: 'flower_crown', name: 'Flower Crown', slot: 'hat', collection: 'flower', price: 400, image: null, worn: false, owned: false },
          { id: 'royal_crown', name: 'Royal Crown', slot: 'hat', collection: 'royal', price: 600, image: null, worn: false, owned: false },
          { id: 'bat_wings', name: 'Bat Wings', slot: 'back', collection: 'halloween', price: 500, image: null, worn: false, owned: false }
        ]
      };
    case 'cosmetics:toggle':
      return { worn: [String(payload?.id || "").toUpperCase()], removed: false };
    case 'servers:apply':
      return { profileId: demoState.activeProfileId, serverAddress: payload?.address || '' };
    case 'discord:reconnect':
      return structuredClone(demoState.discord);
    case 'updates:openRelease':
      return true;
    default:
      return null;
  }
}

export const api = {
  desktop,
  async invoke(channel, ...args) {
    if (!desktop) return demoInvoke(channel, ...args);
    try {
      return await bridge.invoke(channel, ...args);
    } catch (err) {
      throw new Error(cleanMessage(err && err.message));
    }
  },
  onEvent(callback) {
    if (!desktop) {
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        const cpu = Math.round(9 + Math.abs(Math.sin(tick / 2.6)) * 24 + Math.random() * 5);
        callback({
          type: 'stats',
          payload: {
            cpu,
            memPercent: 44 + (tick % 3),
            memUsedMb: 7260,
            memTotalMb: 16384,
            launcherRss: 214 + Math.round(Math.random() * 26)
          }
        });
      }, 1400);
      return () => clearInterval(timer);
    }
    return bridge.onEvent(callback);
  },
  window: {
    minimize: () => desktop && bridge.window.minimize(),
    close: () => desktop && bridge.window.close(),
    toggleMaximize: () => desktop && bridge.window.toggleMaximize()
  }
};
