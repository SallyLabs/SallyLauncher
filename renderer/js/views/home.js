import { el, icon, headAvatar, formatMb, formatPlaytime, formatAgo, versionInfo } from '../ui.js';
import { createModelBuilder, createViewer, applySkinScale, activeSkinOf, skinOrDefault, prepareSkin } from '../mc-model.js';

const refs = { viewer: null, rowTimes: new Map(), closeMenu: null };
let rerender = () => {};

/** Stored stopwatch plus the time the currently running sessions already add. */
function totalPlaytime(data) {
  const stored = (data.profiles || []).reduce((sum, profile) => sum + (Number(profile.playtimeMs) || 0), 0);
  const live = (data.instances || [])
    .filter((entry) => entry.state === 'running' && entry.startedAt)
    .reduce((sum, entry) => sum + Math.max(0, Date.now() - entry.startedAt), 0);
  return stored + live;
}

function statusOf(data) {
  const running = (data.instances || []).filter((entry) => entry.state === 'running').length;
  if (running > 1) return { text: `${running} in game`, cls: 'live' };
  if (running === 1) return { text: 'In game', cls: 'live' };
  if (data.gameState === 'preparing') return { text: 'Preparing', cls: 'busy' };
  return null;
}

/* --------------------------------------------------------------- banner */

function banner(ctx) {
  const data = ctx.state.data;
  const account = data.activeAccount;
  const profile = data.activeProfile;
  const skin = activeSkinOf(data.settings, account);
  const url = skinOrDefault(skin.url);
  const unit = 5;
  const builder = createModelBuilder({ url, unit, slim: skin.slim });
  const model = builder.player();
  applySkinScale(model, url);
  // a legacy 64x32 skin is rewritten to 64x64; rebuild once it is ready
  prepareSkin(skin.url).then((ready) => {
    if (ready !== skin.url && model.isConnected) rerender();
  });
  const status = statusOf(data);

  refs.viewer?.stop();
  const scene = el(
    'div',
    { class: 'mc-scene banner-model', style: { width: `${16 * unit}px`, height: `${32 * unit}px` } },
    model
  );
  refs.viewer = createViewer(model);
  refs.viewer.start();

  let menuNode = null;

  const closeMenu = () => {
    if (!menuNode) return;
    menuNode.remove();
    menuNode = null;
    refs.closeMenu = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeMenu);
  };
  const onOutside = (event) => {
    if (wrap.contains(event.target) || menuNode?.contains(event.target)) return;
    closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closeMenu();
  };

  const menuItem = (entry) => {
    const active = entry.id === data.activeAccountId;
    return el(
      'button',
      {
        class: `account-menu-item${active ? ' is-active' : ''}`,
        type: 'button',
        title: active ? `${entry.name} (active)` : `Switch to ${entry.name}`,
        onclick: async (event) => {
          event.stopPropagation();
          closeMenu();
          if (active) return;
          await ctx.api.invoke('accounts:select', entry.id);
          await ctx.refresh();
          ctx.toast(`Now playing as ${entry.name}.`, 'success');
        }
      },
      headAvatar(entry, 30, 'account-menu-head'),
      el('span', { class: 'account-menu-name', text: entry.name }),
      active ? icon('check', 16) : null
    );
  };

  const openMenu = () => {
    const accounts = data.accounts || [];
    /* The dropdown lives on <body> so the 3D layer of the player model can
       never paint above it. */
    menuNode = el(
      'div',
      { class: 'account-menu', role: 'menu' },
      ...(accounts.length ? accounts.map(menuItem) : [el('div', { class: 'account-menu-empty', text: 'No accounts yet.' })]),
      el('div', { class: 'account-menu-sep' }),
      el(
        'button',
        {
          class: 'account-menu-manage',
          type: 'button',
          onclick: (event) => {
            event.stopPropagation();
            closeMenu();
            ctx.openSettings('accounts');
          }
        },
        icon('user', 18),
        el('span', { text: 'Manage accounts' })
      )
    );
    document.body.appendChild(menuNode);
    refs.closeMenu = closeMenu;
    const rect = wrap.getBoundingClientRect();
    menuNode.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    menuNode.style.bottom = `${Math.round(window.innerHeight - rect.top + 10)}px`;
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
  };

  const chip = el(
    'button',
    {
      class: 'banner-account',
      type: 'button',
      title: 'Switch account',
      onclick: (event) => {
        event.stopPropagation();
        if (menuNode) closeMenu();
        else openMenu();
      }
    },
    headAvatar(account, 26, 'banner-account-head'),
    el('span', { text: `${account?.name || 'Player'} / ${profile?.name || 'Default'}` }),
    icon('chevronDown', 15)
  );

  const wrap = el('div', { class: 'banner-account-wrap' }, chip);

  return el(
    'section',
    { class: 'home-banner' },
    el('div', { class: 'banner-sky' }),
    status ? el('div', { class: `banner-badge ${status.cls}` }, el('i', {}), el('span', { text: status.text })) : null,
    el(
      'button',
      { class: 'banner-profile', type: 'button', title: 'Open your account', onclick: () => ctx.openSettings('accounts') },
      el('span', { class: 'banner-profile-name', text: account?.name || 'Player' }),
      el('span', { class: 'banner-profile-hint', text: 'Go to Profile' })
    ),
    scene,
    el(
      'div',
      { class: 'banner-stat' },
      el('span', { class: 'banner-stat-label', text: 'Total playtime' }),
      el('b', { class: 'banner-stat-value', text: formatPlaytime(totalPlaytime(data)) })
    ),
    wrap,
    el(
      'button',
      { class: 'banner-edit', type: 'button', title: 'Change skin or cosmetics', onclick: () => ctx.navigate('skins') },
      icon('pencil', 18)
    )
  );
}

/* --------------------------------------------------------------- profiles */

function profileRow(ctx, profile) {
  const data = ctx.state.data;
  const info = versionInfo(profile.versionId);
  const instance = (data.instances || []).find((entry) => entry.profileId === profile.id);
  const running = instance?.state === 'running';
  const preparing = instance?.state === 'preparing';
  const active = profile.id === data.activeProfileId;

  const stat = el('span', {
    class: 'row-playtime',
    title: 'Playtime on this profile',
    text: formatPlaytime(profile.playtimeMs)
  });
  refs.rowTimes.set(profile.id, stat);

  const play = el(
    'button',
    {
      class: `row-play${running ? ' is-stop' : ''}${preparing ? ' is-busy' : ''}`,
      type: 'button',
      title: running ? `Stop ${profile.name}` : `Play ${profile.name}`,
      onclick: (event) => {
        event.stopPropagation();
        if (running) ctx.stopGame(profile.id);
        else ctx.launchGame(profile.id);
      }
    },
    icon(running ? 'stop' : 'play', 17),
    el('span', { text: preparing ? 'Starting' : running ? 'Stop' : 'Play' })
  );

  const gear = el(
    'button',
    {
      class: 'row-gear',
      type: 'button',
      title: 'Instance settings',
      onclick: (event) => {
        event.stopPropagation();
        ctx.openInstance(profile.id, 'settings');
      }
    },
    icon('settings', 18)
  );

  return el(
    'div',
    {
      class: `profile-row${active ? ' is-active' : ''}`,
      tabindex: '0',
      role: 'button',
      onclick: () => ctx.openInstance(profile.id),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') ctx.openInstance(profile.id);
      }
    },
    el('span', { class: 'row-tile' }, icon(profile.modpack ? 'cube' : 'layers', 22)),
    el(
      'span',
      { class: 'row-main' },
      el(
        'span',
        { class: 'row-name' },
        el('span', { text: profile.name }),
        running || preparing ? el('span', { class: 'dot ok' }) : null,
        active ? el('span', { class: 'row-tag', text: 'Active' }) : null
      ),
      el('span', {
        class: 'row-meta',
        text: `${info.label} · ${formatAgo(profile.lastPlayedAt)}`
      })
    ),
    stat,
    el('span', { class: 'row-actions' }, play, gear)
  );
}

function profileSection(ctx) {
  const data = ctx.state.data;
  const profiles = [...(data.profiles || [])].sort((a, b) =>
    String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || ''))
  );
  refs.rowTimes.clear();

  return el(
    'section',
    { class: 'home-profiles' },
    el(
      'div',
      { class: 'home-prof-head' },
      el('span', { class: 'home-prof-title' }, icon('clock', 17), el('span', { text: 'Last played profiles' })),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el('span', { class: 'pill' }, icon('cpu', 14), el('span', { text: `CPU ${Math.round(ctx.state.stats.cpu || 0)}%`, id: 'heroCpu' })),
      el('span', { class: 'pill' }, icon('memory', 14), el('span', { text: `${formatMb(data.activeProfile?.memoryMb || data.settings.memoryMb)} RAM` }))
    ),
    el('div', { class: 'profile-rows' }, ...profiles.map((profile) => profileRow(ctx, profile))),
    el(
      'div',
      { class: 'home-actions' },
      el(
        'button',
        { class: 'home-action', type: 'button', onclick: () => ctx.navigate('profiles') },
        icon('layers', 17),
        el('span', { text: 'Manage all profiles' })
      ),
      el(
        'button',
        { class: 'home-action', type: 'button', onclick: () => ctx.navigate('modrinth') },
        icon('plus', 17),
        el('span', { text: 'Add mods' })
      )
    )
  );
}

/* ---------------------------------------------------------------- render */

export function render(root, ctx) {
  refs.closeMenu?.();
  refs.root = root;
  rerender = () => {
    if (!root.isConnected) return;
    refs.closeMenu?.();
    const previous = root.scrollTop;
    root.innerHTML = '';
    build(root, ctx);
    root.scrollTop = previous;
  };

  build(root, ctx);
  if (!ctx.state.versions) ctx.loadVersions();
}

function build(root, ctx) {
  refs.rowTimes.clear();
  root.append(banner(ctx), profileSection(ctx));
}

export function onStats(root, ctx) {
  if (!refs.root || !refs.root.isConnected || !ctx.state.data) return;
  const cpu = document.getElementById('heroCpu');
  if (cpu) cpu.lastChild.textContent = `CPU ${Math.round(ctx.state.stats.cpu || 0)}%`;

  const data = ctx.state.data;
  const total = refs.root.querySelector('.banner-stat-value');
  if (total) total.textContent = formatPlaytime(totalPlaytime(data));

  /* running sessions keep counting while the page is open */
  for (const [profileId, node] of refs.rowTimes) {
    const profile = (data.profiles || []).find((entry) => entry.id === profileId);
    const instance = (data.instances || []).find((entry) => entry.profileId === profileId && entry.state === 'running');
    const base = Number(profile?.playtimeMs) || 0;
    const live = instance?.startedAt ? Math.max(0, Date.now() - instance.startedAt) : 0;
    if (node.isConnected) node.textContent = formatPlaytime(base + live);
  }
}

export function onState(root, ctx) {
  rerender();
}

export function onLeave() {
  refs.closeMenu?.();
}
