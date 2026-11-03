import { el, icon, switchToggle, toast, formatMb, formatDate, formatPlaytime, formatAgo } from '../ui.js';

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
    const version = profile.versionId || 'No version';
    const instance = (data.instances || []).find((entry) => entry.profileId === profile.id);
    const running = instance?.state === 'running';
    const preparing = instance?.state === 'preparing';

    const action = (iconName, title, handler, extra = {}) =>
      el('button', { class: 'square-btn', type: 'button', title, onclick: handler, ...extra }, icon(iconName, 18));

    return el(
      'div',
      {
        class: `profile-card${isActive ? ' active' : ''}`,
        tabindex: '0',
        role: 'button',
        title: `Open ${profile.name}`,
        onclick: (event) => {
          /* inner buttons keep their own action */
          if (event.target.closest('button')) return;
          ctx.openInstance(profile.id);
        },
        onkeydown: (event) => {
          if (event.key === 'Enter') ctx.openInstance(profile.id);
        }
      },
      el('div', { class: 'profile-cover' }),
      el(
        'div',
        { class: 'profile-head' },
        el('div', { class: 'row-icon' }, icon('layers', 19)),
        el(
          'div',
          { style: { minWidth: '0' } },
          el('div', { class: 'profile-title', text: profile.name }),
          el('div', { class: 'profile-sub', text: `${version} · ${formatMb(profile.memoryMb)}` })
        ),
        running || preparing
          ? el('span', { class: 'tag green', text: preparing ? 'Starting' : 'Running' })
          : isActive
            ? el('span', { class: 'tag green', text: 'Active' })
            : null
      ),
      el(
        'div',
        { class: 'profile-meta' },
        el('div', { class: 'kv' }, el('span', { text: 'Version' }), el('b', { text: version })),
        profile.modpack ? el('div', { class: 'kv' }, el('span', { text: 'Modpack' }), el('b', { text: `${profile.modpack.title}${profile.modpack.version ? ` ${profile.modpack.version}` : ''}` })) : null,
        el('div', { class: 'kv' }, el('span', { text: 'Instance' }), el('b', { class: 'mono small', text: profile.gameDir || '—' })),
        el('div', { class: 'kv' }, el('span', { text: 'Playtime' }), el('b', { text: `${formatPlaytime(profile.playtimeMs)} · ${formatAgo(profile.lastPlayedAt)}` })),
        el('div', { class: 'kv' }, el('span', { text: 'Created' }), el('b', { text: formatDate(profile.createdAt) }))
      ),
      el(
        'div',
        { class: 'profile-actions' },
        running || preparing
          ? el(
              'button',
              { class: 'btn danger', type: 'button', onclick: () => ctx.stopGame(profile.id) },
              icon('stop', 16),
              el('span', { text: preparing ? 'Cancel' : 'Stop' })
            )
          : el(
              'button',
              { class: `btn${isActive ? ' primary' : ''}`, type: 'button', onclick: () => ctx.launchGame(profile.id) },
              icon('play', 16),
              el('span', { text: 'Play' })
            ),
        isActive
          ? null
          : el(
              'button',
              {
                class: 'btn',
                type: 'button',
                title: 'Use this profile on Home',
                onclick: async () => {
                  await ctx.api.invoke('profiles:select', profile.id);
                  await ctx.refresh();
                }
              },
              icon('check', 16),
              el('span', { text: 'Use' })
            ),
        el('div', { class: 'spacer', style: { flex: '1' } }),
        action('folder', 'Open instance folder', () => ctx.openPath(profile.gameDir)),
        action('settings', 'Edit profile', () => {
          editing = profile.id;
          repaint();
        }),
        action('copy', 'Duplicate profile', async () => {
          await ctx.api.invoke('profiles:duplicate', profile.id);
          await ctx.refresh();
          toast('Profile duplicated.', 'success');
        }),
        action(
          'trash',
          data.profiles.length > 1 ? 'Delete profile' : 'Keep at least one profile',
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
        { class: 'profile-card new-card', type: 'button', onclick: () => { editing = 'new'; repaint(); } },
        el('div', { class: 'row-icon' }, icon('plus', 18)),
        el('div', { class: 'profile-title', text: 'New profile' }),
        el('div', { class: 'profile-sub', text: 'Separate version, memory and game folder' })
      )
    );
  }
  return cards;
}

function profileForm(ctx) {
  const data = ctx.state.data;
  const existing = editing && editing !== 'new' ? data.profiles.find((p) => p.id === editing) : null;
  const values = existing ? { ...existing } : profileDefaults(ctx);
  const installed = ctx.state.versions?.installed || [];
  const available = ctx.state.versions?.available || [];
  const releases = available.filter((version) => version.type === 'release');
  const seen = new Set(releases.map((version) => version.id));
  const versions = [
    ...installed.filter((version) => !seen.has(version.id)).map((v) => ({ ...v, installed: true })),
    ...releases
  ];

  if (!ctx.state.versions) ctx.loadVersions();

  const name = el('input', { type: 'text', value: values.name, placeholder: 'e.g. Fabric 1.21 - Performance', spellcheck: false, style: { width: '100%' } });

  const versionSelect = el(
    'select',
    { style: { width: '100%' } },
    el('option', { value: '', text: versions.length ? 'Choose a version' : 'No versions installed yet' }),
    ...versions.map((version) =>
      el('option', {
        value: version.id,
        text: `${version.id}${version.loader && version.loader !== 'Vanilla' ? ` (${version.loader})` : ''}${version.installed ? ' · installed' : ''}`,
        selected: version.id === values.versionId
      })
    )
  );
  if (values.versionId && !versions.some((version) => version.id === values.versionId)) {
    versionSelect.appendChild(el('option', { value: values.versionId, text: `${values.versionId} · installed`, selected: true }));
  }

  const memoryLabel = el('span', { class: 'range-value', text: formatMb(values.memoryMb) });
  const memory = el('input', { type: 'range', min: 1024, max: 16384, step: 512, value: values.memoryMb });
  memory.addEventListener('input', () => {
    memoryLabel.textContent = formatMb(Number(memory.value));
  });

  const instanceDir = existing ? values.gameDir || ctx.state.data.instanceDir || '' : '';
  const gameDir = el('input', {
    type: 'text',
    value: instanceDir,
    placeholder: existing ? 'Instance folder' : 'Assigned automatically when created',
    spellcheck: false,
    style: { width: '100%' }
  });

  const jvm = el('input', { type: 'text', value: values.jvmArgs || '', placeholder: 'Extra JVM flags', spellcheck: false, style: { width: '100%' } });
  const server = el('input', { type: 'text', value: values.serverAddress || '', placeholder: 'play.example.net:25565', spellcheck: false, style: { width: '100%' } });

  const width = el('input', { type: 'number', value: values.resolutionWidth, min: 320, max: 7680, disabled: !values.customResolution });
  const height = el('input', { type: 'number', value: values.resolutionHeight, min: 240, max: 4320, disabled: !values.customResolution });
  const resolutionSwitch = switchToggle(values.customResolution, (value) => {
    width.disabled = !value;
    height.disabled = !value;
  });

  const save = async () => {
    const payload = {
      name: name.value.trim() || 'Untitled profile',
      versionId: versionSelect.value || null,
      gameDir: gameDir.value.trim(),
      memoryMb: Number(memory.value),
      jvmArgs: jvm.value.trim(),
      serverAddress: server.value.trim(),
      customResolution: resolutionSwitch.classList.contains('on'),
      resolutionWidth: Number(width.value),
      resolutionHeight: Number(height.value)
    };
    try {
      const profile = existing
        ? await ctx.api.invoke('profiles:update', existing.id, payload)
        : await ctx.api.invoke('profiles:create', payload);
      editing = null;
      await ctx.refresh();
      toast(`Profile ${payload.name} saved.`, 'success');
      if (profile?.id && payload.versionId) {
        toast('Installing Minecraft and the client mod…', 'info');
        ctx.api.invoke('versions:install', profile.id).catch((err) => toast(err.message, 'error'));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return el(
    'div',
    { class: 'panel', style: { marginTop: '18px' } },
    el(
      'div',
      { class: 'panel-head' },
      el('span', { class: 'ic' }, icon(existing ? 'settings' : 'plus', 20)),
      el('span', { text: existing ? `Edit ${existing.name}` : 'New profile' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => { editing = null; repaint(); } }, el('span', { text: 'Cancel' }))
    ),
    el(
      'div',
      { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'field' }, el('span', { text: 'Version' }), versionSelect),
      el('label', { class: 'field' }, el('span', { text: 'Memory' }), el('div', { class: 'setting-control' }, memory, memoryLabel)),
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Instance folder' }),
        el(
          'div',
          { class: 'setting-control', style: { width: '100%' } },
          gameDir,
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              title: 'Open instance folder',
              onclick: () => ctx.openPath(gameDir.value)
            },
            icon('folder', 16)
          )
        )
      ),
      el('label', { class: 'field' }, el('span', { text: 'Server (auto-connect)' }), server),
      el('label', { class: 'field' }, el('span', { text: 'JVM arguments' }), jvm),
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Window size' }),
        el('div', { class: 'setting-control' }, resolutionSwitch, width, el('span', { class: 'faint', text: '×' }), height)
      )
    ),
    el(
      'div',
      { class: 'toolbar', style: { marginTop: '18px', marginBottom: '0' } },
      el('button', { class: 'btn primary', type: 'button', onclick: save }, icon('check', 16), el('span', { text: existing ? 'Save changes' : 'Create profile' })),
      el('span', { class: 'faint', text: 'Every profile has its own instance folder – saves, mods and config never mix.' })
    )
  );
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
        el('h1', { class: 'page-title', text: 'Profiles' }),
        el('div', { class: 'page-sub', text: 'One profile per setup: vanilla, Fabric, snapshots or a modded folder.' })
      ),
      el(
        'div',
        { class: 'head-actions' },
        el('span', { class: 'chip' }, icon('layers', 16), el('span', { text: data.activeProfile?.name || 'Default' })),
        el(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => { editing = 'new'; repaint(); } },
          icon('plus', 16),
          el('span', { text: 'New profile' })
        )
      )
    ),
    el('div', { class: 'profile-grid' }, ...profileCards(ctx))
  );

  if (editing) root.append(profileForm(ctx));
}

export function onState(root, ctx) {
  render(root, ctx);
}

export function onVersions(root, ctx) {
  render(root, ctx);
}
