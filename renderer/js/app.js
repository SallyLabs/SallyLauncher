import { el, icon, logoMark, toast, themeReveal } from './ui.js';
import { api } from './api.js';
import * as home from './views/home.js';
import * as profiles from './views/profiles.js';
import * as modrinth from './views/modrinth.js';
import * as skins from './views/skins.js';
import * as cosmetics from './views/cosmetics.js';
import * as instance from './views/instance.js';
import * as settings from './views/settings.js';

const VIEWS = { home, profiles, instance, modrinth, skins, cosmetics, settings };

const NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'profiles', label: 'Profiles', icon: 'layers' },
  { id: 'modrinth', label: 'Modrinth', icon: 'cube' },
  { id: 'skins', label: 'Skins', icon: 'palette' },
  { id: 'cosmetics', label: 'Cosmetics', icon: 'sparkles' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

export const state = {
  data: null,
  stats: { cpu: 0, memPercent: 0, memUsedMb: 0, memTotalMb: 0, launcherRss: 0 },
  cpuHistory: new Array(48).fill(0),
  logs: [],
  clientInfo: null,
  versions: null,
  versionsError: null,
  progress: null,
  view: 'home',
  /* which profile the instance page shows, and on which tab */
  instanceId: null,
  instanceTab: 'content',
  instanceReturn: 'home',
  /* which section of the settings page is open */
  settingsTab: 'general'
};

const viewRoot = () => document.getElementById('view');
const currentModule = () => VIEWS[state.view];

function dispatch(hook, ...args) {
  const module = currentModule();
  if (module && typeof module[hook] === 'function') {
    try {
      module[hook](viewRoot(), ctx, ...args);
    } catch (err) {
      console.error(`view hook ${hook} failed`, err);
    }
  }
}

const ctx = {
  state,
  api,
  navigate,
  refreshView() {
    renderView();
  },
  async refresh() {
    state.data = await api.invoke('state:get');
    state.clientInfo = await api.invoke('client:info').catch(() => null);
    applyTheme(state.data.settings.theme);
    syncChrome();
    renderView();
  },
  async saveSettings(patch) {
    const updated = await api.invoke('settings:update', patch);
    if (state.data) state.data.settings = { ...state.data.settings, ...updated };
    if (patch.theme) applyTheme(patch.theme);
    syncChrome();
    return updated;
  },
  /** Without a profile id the active profile is started. */
  async launchGame(profileId) {
    try {
      await api.invoke('launch:start', profileId ? { profileId } : {});
    } catch (err) {
      toast(err.message, 'error');
    }
  },
  async stopGame(profileId) {
    try {
      await api.invoke('launch:stop', profileId ? { profileId } : {});
    } catch (err) {
      toast(err.message, 'error');
    }
  },
  /** Opens the instance page for one profile, optionally on a given tab. */
  openInstance(profileId, tab = 'content') {
    if (state.view !== 'instance') state.instanceReturn = state.view;
    state.instanceId = profileId;
    state.instanceTab = tab;
    if (state.view === 'instance') renderView(true);
    else navigate('instance');
  },
  /** Opens Settings on one section, e.g. 'accounts'. */
  openSettings(tab = 'general') {
    const changed = state.settingsTab !== tab;
    state.settingsTab = tab;
    if (state.view === 'settings') {
      if (changed) renderView(true);
    } else {
      navigate('settings');
    }
  },
  async loadVersions(refresh = false) {
    try {
      state.versionsError = null;
      state.versions = await api.invoke('versions:list', { refresh });
    } catch (err) {
      state.versionsError = err.message;
    }
    if (state.view === 'home') dispatch('onState');
    if (state.view === 'profiles') dispatch('onVersions');
  },
  async loadClientInfo() {
    try {
      state.clientInfo = await api.invoke('client:info');
    } catch {
      state.clientInfo = null;
    }
    if (state.view === 'home') dispatch('onState');
  },
  openPath(target) {
    if (!target) return;
    return api.invoke('system:openPath', target);
  },
  toast
};

/* ------------------------------------------------------------------ chrome */

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.innerHTML = '';
    btn.appendChild(icon(value === 'dark' ? 'moon' : 'sun', 20));
    btn.title = value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
}

function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const item of NAV) {
    const button = el(
      'button',
      { class: 'nav-item', type: 'button', dataset: { route: item.id }, onclick: () => navigate(item.id) },
      icon(item.icon, 22),
      el('span', { text: item.label })
    );
    nav.appendChild(button);
  }
}

function syncNav() {
  document.querySelectorAll('.nav-item').forEach((node) => {
    node.classList.toggle('active', node.dataset.route === state.view);
  });
}

function syncChrome() {
  syncNav();
  if (!state.data) return;
  document.getElementById('appVersion').textContent = `v${state.data.appVersion}`;
  syncUpdateBar();
  const status = document.getElementById('clockStatus');
  if (status) {
    const instances = state.data.instances || [];
    const running = instances.filter((entry) => entry.state === 'running');
    if (running.length > 1) status.textContent = `Playing ${running.length} profiles`;
    else if (running.length === 1) status.textContent = `Playing ${running[0].versionId || 'Minecraft'}`;
    else if (state.data.gameState === 'preparing') status.textContent = 'Preparing launch…';
    else status.textContent = 'In the main menu';
  }
}

/* --------------------------------------------------------------- updates */

let updateBusy = false;
let updateSignature = '';

function syncUpdateBar() {
  const bar = document.getElementById('updateBar');
  if (!bar || !state.data) return;
  const info = state.data.update || {};
  const show = updateBusy || Boolean(info.available);
  const signature = show ? `${updateBusy}|${info.currentVersion}|${info.latestVersion}` : '';
  bar.classList.toggle('hidden', !show);
  if (signature === updateSignature) return;
  updateSignature = signature;
  bar.innerHTML = '';
  if (!show) return;

  bar.append(
    el('span', { class: 'update-spark' }, icon('sparkles', 17)),
    el(
      'div',
      { class: 'update-copy' },
      el('b', {
        text: info.available
          ? `SallyLauncher ${info.latestVersion} is available`
          : 'Checking GitHub for a new release…'
      }),
      el('span', {
        text: info.available
          ? `You are on v${info.currentVersion} · ${info.repo || 'SallyLabs/SallyLauncher'}`
          : 'One moment – the launcher asks the repository for its newest release.'
      })
    ),
    el('div', { class: 'spacer' }),
    el(
      'button',
      { class: 'btn ghost small', type: 'button', disabled: updateBusy, title: 'Check GitHub again', onclick: () => checkUpdates(true) },
      updateBusy ? el('span', { class: 'spinner' }) : icon('refresh', 15),
      el('span', { text: updateBusy ? 'Checking…' : 'Refresh' })
    ),
    info.available
      ? el(
          'button',
          { class: 'btn primary small', type: 'button', title: 'Download the new release and start the installer', onclick: installUpdate },
          icon('download', 15),
          el('span', { text: 'Install update' })
        )
      : null
  );
}

async function checkUpdates(showToast = false) {
  if (updateBusy) return;
  updateBusy = true;
  syncUpdateBar();
  try {
    const info = await api.invoke('updates:check');
    if (showToast) {
      if (info?.error) toast(info.error, 'error');
      else if (info?.available) toast(`SallyLauncher ${info.latestVersion} is available.`, 'success');
      else toast(`You already run the newest release (v${info?.currentVersion || state.data.appVersion}).`, 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    updateBusy = false;
    updateSignature = '';
    await ctx.refresh();
  }
}

async function installUpdate() {
  try {
    const result = await api.invoke('updates:install');
    if (result?.opened) toast('Opened the release page – pick the installer there.', 'info');
    else toast('Installer started. SallyLauncher closes so the update can install.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function navigate(id) {
  if (!VIEWS[id] || id === state.view) return;
  const previous = VIEWS[state.view];
  if (previous && typeof previous.onLeave === 'function') {
    try {
      previous.onLeave();
    } catch (err) {
      console.error('view hook onLeave failed', err);
    }
  }
  state.view = id;
  syncNav();
  renderView(true);
  if (typeof VIEWS[id].onEnter === 'function') {
    Promise.resolve(VIEWS[id].onEnter(ctx)).catch((err) => console.error(err));
  }
}

/** Smooth page transition: one fade on the container, never on re-renders. */
function animateView(root) {
  if (typeof root.animate !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.animate(
    [
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'none' }
    ],
    { duration: 320, easing: 'cubic-bezier(.22,.68,.16,1)' }
  );
}

function renderView(animate = false) {
  const root = viewRoot();
  root.innerHTML = '';
  const module = currentModule();
  if (!module) return;
  try {
    module.render(root, ctx);
    if (animate) animateView(root);
  } catch (err) {
    console.error(err);
    root.appendChild(el('div', { class: 'empty', text: `Could not render this page: ${err.message}` }));
  }
}

/* ------------------------------------------------------------------- clock */

function startClock() {
  const tick = () => {
    const now = new Date();
    const time = document.getElementById('clockTime');
    if (time) {
      time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
  };
  tick();
  setInterval(tick, 15000);
}

/* ---------------------------------------------------------------- progress */

function updateProgress() {
  const strip = document.getElementById('progressStrip');
  if (!strip) return;
  const active = state.data && state.data.gameState === 'preparing';
  strip.classList.toggle('hidden', !active);
  if (!active) return;
  const progress = state.progress;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  document.getElementById('progressText').textContent = progress
    ? `${progress.label}${total > 1 ? ` · ${done} / ${total}` : ''}`
    : 'Preparing…';
  document.getElementById('progressPercent').textContent = `${percent}%`;
  document.getElementById('progressFill').style.width = `${percent}%`;
}

/* ------------------------------------------------------------------ events */

function handleEvent(message) {
  const { type, payload } = message || {};
  if (type === 'stats') {
    state.stats = payload;
    state.cpuHistory.push(Number(payload.cpu) || 0);
    if (state.cpuHistory.length > 48) state.cpuHistory.shift();
    dispatch('onStats');
    return;
  }
  if (type === 'progress') {
    state.progress = payload;
    updateProgress();
    return;
  }
  if (type === 'log') {
    state.logs.push(payload);
    if (state.logs.length > 4000) state.logs.shift();
    dispatch('onLog', payload);
    return;
  }
  if (type === 'game') {
    if (state.data) {
      state.data.gameState = payload.state;
      state.data.instances = payload.instances || [];
    }
    if (payload.error) toast(payload.error, 'error');
    if (payload.state === 'preparing') state.progress = null;
    if (payload.state === 'running') {
      state.progress = null;
      /* Only a freshly started game opens its own console – stopping one of
         several running profiles should keep the current page. */
      if (payload.started && state.data?.settings?.showConsole) ctx.openInstance(payload.started, 'logs');
    }
    updateProgress();
    syncChrome();
    dispatch('onState');
    return;
  }
  if (type === 'state') {
    state.data = payload;
    applyTheme(payload.settings.theme);
    syncChrome();
    dispatch('onState');
    /* the client-mod report depends on the active version, so refresh it */
    ctx.loadClientInfo();
  }
}

/* -------------------------------------------------------------------- boot */

async function init() {
  const brand = document.querySelector('.brand-logo');
  if (brand) {
    brand.innerHTML = '';
    brand.appendChild(logoMark());
  }
  document.getElementById('winMin').appendChild(icon('minus', 18));
  document.getElementById('winClose').appendChild(icon('close', 18));
  document.getElementById('winMin').addEventListener('click', () => api.window.minimize());
  document.getElementById('winClose').addEventListener('click', () => api.window.close());
  document.querySelector('.topbar').addEventListener('dblclick', (event) => {
    if (event.target.closest('.win-controls')) return;
    api.window.toggleMaximize();
  });

  document.getElementById('themeToggle').addEventListener('click', async (event) => {
    const next = state.data?.settings?.theme === 'light' ? 'dark' : 'light';
    const rect = event.currentTarget.getBoundingClientRect();
    themeReveal({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, () => applyTheme(next));
    await ctx.saveSettings({ theme: next });
    dispatch('onState');
  });

  state.data = await api.invoke('state:get');
  applyTheme(state.data.settings.theme);
  document.getElementById('appVersion').textContent = `v${state.data.appVersion}`;
  buildNav();
  state.view = null;
  navigate('home');
  startClock();
  syncChrome();
  updateProgress();

  api.onEvent(handleEvent);

  api.invoke('logs:get').then((lines) => {
    state.logs = (Array.isArray(lines) ? lines : []).map((line) =>
      typeof line === 'string' ? { text: line, profile: null } : line
    );
  }).catch(() => {});

  ctx.loadVersions();
  ctx.loadClientInfo();
}

window.addEventListener('error', (event) => {
  console.error(event.error || event.message);
});

init().catch((err) => {
  viewRoot().appendChild(el('div', { class: 'empty', text: `Could not start SallyLauncher: ${err.message}` }));
});
