import { el, icon, switchToggle, toast, formatMb, formatDate, formatPlaytime, formatAgo } from '../ui.js';
import { openCreate } from './create.js';

let editing = null; // 'new' | profile id | null
let lastRoot = null;
let lastCtx = null;

/* Navigating to the view that is already open does nothing, so opening the
   form has to repaint the page directly. */
function repaint() {
  if (!lastRoot || !lastCtx) return;
  lastRoot.innerHTML = '';
  render(lastRoot, lastCtx);
}

function profileDefaults(ctx) {
  const profile = ctx.state.data.activeProfile;
  return {
    name: '',
    versionId: profile?.versionId || ctx.state.data.selectedVersion || '',
    gameDir: '',
    memoryMb: profile?.memoryMb || 4096,
    jvmArgs: '',
    serverAddress: '',
    customResolution: false,
    resolutionWidth: 1280,
    resolutionHeight: 720
  };
}

function profileCards(ctx) {
  const data = ctx.state.data;
  const cards = data.profiles.map((profile) => {
    const isActive = profile.id === data.activeProfileId;
    const instance = (data.instances || []).find((entry) => entry.profileId === profile.id);
    const running = instance?.state === 'running';
    const preparing = instance?.state === 'preparing';
    const meta = [
      profile.versionId || 'No version',
      profile.loader && profile.loader !== 'vanilla' ? profile.loader : null,
      `${formatPlaytime(profile.playtimeMs)} played`
    ]
      .filter(Boolean)
      .join(' · ');

    const iconButton = (name, title, handler, extra = {}) =>
      el('button', { class: 'instance-icon-btn', type: 'button', title, onclick: handler, ...extra }, icon(name, 15));

    return el(
      'article',
      {
        class: `instance-card${isActive ? ' is-active' : ''}`,
        tabindex: '0',
        role: 'button',
        onclick: (event) => {
          if (event.target.closest('button')) return;
          ctx.openInstance(profile.id);
        },
        onkeydown: (event) => {
          if (event.key === 'Enter') ctx.openInstance(profile.id);
        }
      },
      el(
        'div',
        { class: 'instance-top' },
        el('span', { class: 'instance-icon' }, icon(profile.modpack ? 'cube' : 'layers', 17)),
        el(
          'div',
          { class: 'instance-text' },
          el('span', { class: 'instance-name', text: profile.name }),
          el('span', { class: 'instance-meta', text: meta })
        ),
        running || preparing
          ? el('span', { class: 'tag green', text: preparing ? 'Starting' : 'Running' })
          : isActive
            ? el('span', { class: 'tag green', text: 'Active' })
            : null
      ),
      el(
        'div',
        { class: 'instance-actions' },
        running || preparing
          ? el(
              'button',
              { class: 'btn small danger', type: 'button', onclick: () => ctx.stopGame(profile.id) },
              icon('stop', 14),
              el('span', { text: preparing ? 'Cancel' : 'Stop' })
            )
          : el(
              'button',
              { class: `btn small${isActive ? ' primary' : ''}`, type: 'button', onclick: () => ctx.launchGame(profile.id) },
              icon('play', 14),
              el('span', { text: 'Play' })
            ),
        isActive
          ? null
          : el(
              'button',
              {
                class: 'btn small ghost',
                type: 'button',
                title: 'Use this instance on Home',
                onclick: async () => {
                  await ctx.api.invoke('profiles:select', profile.id);
                  await ctx.refresh();
                }
              },
              el('span', { text: 'Use' })
            ),
        el('span', { class: 'spacer', style: { flex: '1' } }),
        iconButton('folder', 'Open folder', () => ctx.openPath(profile.gameDir)),
        iconButton('settings', 'Edit instance', () => {
          editing = profile.id;
          repaint();
        }),
        iconButton('copy', 'Duplicate', async () => {
          await ctx.api.invoke('profiles:duplicate', profile.id);
          await ctx.refresh();
          toast('Instance duplicated.', 'success');
        }),
        iconButton(
          'trash',
          data.profiles.length > 1 ? 'Delete instance' : 'Keep at least one instance',
          async () => {
            await ctx.api.invoke('profiles:remove', profile.id);
            await ctx.refresh();
            toast(`Deleted ${profile.name}`, 'info');
          },
          { disabled: data.profiles.length <= 1 }
        )
      )
    );
  });

  if (editing !== 'new') {
    cards.push(
      el(
        'button',
        {
          class: 'instance-card instance-new',
          type: 'button',
          onclick: () => openCreate(ctx, { onDone: repaint })
        },
        el('span', { class: 'instance-icon' }, icon('plus', 17)),
        el(
          'div',
          { class: 'instance-text' },
          el('span', { class: 'instance-name', text: 'New instance' }),
          el('span', { class: 'instance-meta', text: 'Version, loader, mods' })
        )
      )
    );
  }
  return cards;
}

export function render(root, ctx) {
  lastRoot = root;
  lastCtx = ctx;
  /* every state event re-renders this page, so the old nodes go first */
  root.innerHTML = '';
  const data = ctx.state.data;
  if (editing && editing !== 'new' && !data.profiles.some((p) => p.id === editing)) editing = null;

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Instances' })
      ),
      el(
        'div',
        { class: 'head-actions' },
        el('span', { class: 'chip' }, icon('layers', 16), el('span', { text: data.activeProfile?.name || 'Default' })),
        el(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => openCreate(ctx, { onDone: repaint }) },
          icon('plus', 16),
          el('span', { text: 'New instance' })
        )
      )
    ),
    el('div', { class: 'profile-grid' }, ...profileCards(ctx))
  );

  if (editing && editing !== 'new') root.append(profileForm(ctx));
}

export function onState(root, ctx) {
  render(root, ctx);
}

export function onVersions(root, ctx) {
  render(root, ctx);
}
