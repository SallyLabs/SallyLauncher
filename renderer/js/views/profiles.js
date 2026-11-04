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

function minecraftVersionOf(versionId) {
  const id = String(versionId || '');
  const fabric = /^(?:fabric|quilt)-loader-[\d.]+-(.+)$/.exec(id);
  if (fabric) return fabric[1];
  const forge = /^(.+)-forge-[\d.]+$/.exec(id);
  if (forge) return forge[1];
  return id;
}

const LOADER_CHOICES = [
  { id: 'vanilla', label: 'Vanilla', hint: 'Plain Minecraft – no loader, no bundled mods.' },
  { id: 'fabric', label: 'Fabric', hint: 'Light and quick – the bundled SallyClient mod runs here.' },
  { id: 'forge', label: 'Forge', hint: 'Classic loader for large modpacks – installed with the official installer.' }
];

function profileDefaults(ctx) {
  const profile = ctx.state.data.activeProfile;
  return {
    name: '',
    versionId: minecraftVersionOf(profile?.versionId || ctx.state.data.selectedVersion || ''),
    loader: profile?.loader || 'fabric',
    loaderVersion: profile?.loaderVersion || '',
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
    const version = minecraftVersionOf(profile.versionId) || 'No version';
    const loaderLabel = (LOADER_CHOICES.find((choice) => choice.id === (profile.loader || 'fabric')) || {}).label || 'Fabric';
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
          el('div', { class: 'profile-sub', text: `${loaderLabel} ${version} · ${formatMb(profile.memoryMb)}` })
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
        el('div', { class: 'kv' }, el('span', { text: 'Loader' }), el('b', { text: `${loaderLabel} ${profile.loaderVersion || ''}`.trim() })),
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
  const values = existing
    ? { ...existing, versionId: minecraftVersionOf(existing.versionId), loader: existing.loader || 'fabric' }
    : profileDefaults(ctx);

  if (!ctx.state.versions) ctx.loadVersions();

  /* Minecraft versions: the release list from Mojang plus whatever is installed. */
  const installed = ctx.state.versions?.installed || [];
  const available = ctx.state.versions?.available || [];
  const mcVersions = [];
  const seenMc = new Set();
  const addMc = (id, installedFlag = false) => {
    const version = minecraftVersionOf(id);
    if (!version || seenMc.has(version)) return;
    seenMc.add(version);
    mcVersions.push({ id: version, installed: installedFlag });
  };
  installed.forEach((version) => addMc(version.id, true));
  available.filter((version) => version.type === 'release').forEach((version) => addMc(version.id));
  if (values.versionId && !seenMc.has(values.versionId)) addMc(values.versionId, true);

  const name = el('input', { type: 'text', value: values.name, placeholder: 'e.g. Fabric 1.21 - Performance', spellcheck: false, style: { width: '100%' } });

  const versionSelect = el(
    'select',
    { style: { width: '100%' } },
    el('option', { value: '', text: mcVersions.length ? 'Choose a Minecraft version' : 'No versions available yet' }),
    ...mcVersions.map((version) =>
      el('option', {
        value: version.id,
        text: `${version.id}${version.installed ? ' · installed' : ''}`,
        selected: version.id === values.versionId
      })
    )
  );

  const loaderSelect = el(
    'select',
    { style: { width: '100%' } },
    ...LOADER_CHOICES.map((choice) =>
      el('option', { value: choice.id, text: choice.label, selected: choice.id === (values.loader || 'fabric') })
    )
  );

  const loaderVersionSelect = el('select', { style: { width: '100%' } });
  const loaderHint = el('div', { class: 'faint', style: { marginTop: '4px' }, text: '' });

  const fillLoaderVersions = async () => {
    const loader = loaderSelect.value;
    const mcVersion = versionSelect.value;
    const choice = LOADER_CHOICES.find((entry) => entry.id === loader);
    loaderHint.textContent = choice?.hint || '';
    loaderVersionSelect.innerHTML = '';
    if (loader === 'vanilla') {
      loaderVersionSelect.disabled = true;
      loaderVersionSelect.appendChild(el('option', { value: '', text: 'Not needed for vanilla' }));
      return;
    }
    if (!mcVersion) {
      loaderVersionSelect.disabled = true;
      loaderVersionSelect.appendChild(el('option', { value: '', text: 'Pick a Minecraft version first' }));
      return;
    }
    loaderVersionSelect.disabled = true;
    loaderVersionSelect.appendChild(el('option', { value: '', text: 'Loading builds…' }));
    try {
      const result = await ctx.api.invoke('loaders:versions', { loader, mcVersion });
      const list = result?.versions || [];
      loaderVersionSelect.innerHTML = '';
      if (!list.length) {
        loaderVersionSelect.appendChild(el('option', { value: '', text: 'No builds available' }));
        loaderVersionSelect.disabled = true;
        loaderHint.textContent = result?.error || `No ${loader} build for Minecraft ${mcVersion}.`;
        return;
      }
      for (const entry of list) {
        const suffix = entry.recommended ? ' · recommended' : entry.latest ? ' · latest' : entry.stable ? ' · stable' : '';
        loaderVersionSelect.appendChild(
          el('option', { value: entry.version, text: `${entry.version}${suffix}`, selected: entry.version === values.loaderVersion })
        );
      }
      loaderVersionSelect.disabled = false;
      loaderHint.textContent = `${choice?.hint || ''} ${list.length} build${list.length === 1 ? '' : 's'} for ${mcVersion}.`.trim();
    } catch (err) {
      loaderVersionSelect.innerHTML = '';
      loaderVersionSelect.disabled = true;
      loaderVersionSelect.appendChild(el('option', { value: '', text: 'Could not load builds' }));
      loaderHint.textContent = err.message;
    }
  };

  loaderSelect.addEventListener('change', () => {
    values.loaderVersion = '';
    fillLoaderVersions();
  });
  versionSelect.addEventListener('change', () => {
    values.loaderVersion = '';
    fillLoaderVersions();
  });

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
      loader: loaderSelect.value,
      loaderVersion: loaderVersionSelect.value || null,
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
        toast(`Installing Minecraft${payload.loader !== 'vanilla' ? ` with ${payload.loader}` : ''}…`, 'info');
        ctx.api.invoke('versions:install', profile.id).catch((err) => toast(err.message, 'error'));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  fillLoaderVersions();

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
      el('label', { class: 'field' }, el('span', { text: 'Minecraft version' }), versionSelect),
      el('label', { class: 'field' }, el('span', { text: 'Loader' }), loaderSelect),
      el('label', { class: 'field' }, el('span', { text: 'Loader version' }), el('div', { style: { width: '100%' } }, loaderVersionSelect, loaderHint)),
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
