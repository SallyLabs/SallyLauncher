import {
  el,
  icon,
  toast,
  formatMb,
  formatPlaytime,
  formatAgo,
  formatDate,
  versionInfo,
  switchToggle
} from '../ui.js';
const cache = new Map();

/* Modrinth facet for the instance's loader – vanilla instances search without one. */
function loaderFacet(profile) {
  const loader = profile?.loader || 'fabric';
  return loader === 'vanilla' ? '' : loader;
}

function loaderLabel(profile) {
  const loader = profile?.loader || 'fabric';
  if (loader === 'forge') return 'Forge mods only';
  if (loader === 'vanilla') return 'no loader – pick Fabric or Forge for mods';
  return 'Fabric mods only';
}
let lastRoot = null;
let lastCtx = null;
let follow = true;
let modFilter = '';

const TABS = [
  { id: 'content', label: 'Content', icon: 'cube' },
  { id: 'worlds', label: 'Worlds', icon: 'globe' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

function repaint() {
  if (!lastRoot || !lastCtx) return;
  lastRoot.innerHTML = '';
  render(lastRoot, lastCtx);
}

/** Mods and worlds are read from disk once per profile and then cached. */
async function loadContent(ctx, profile) {
  const known = cache.get(profile.id);
  if (known?.loaded || known?.loading) return;
  cache.set(profile.id, { loading: true });
  const [mods, worlds] = await Promise.all([
    ctx.api.invoke('instance:mods', profile.id).catch(() => []),
    ctx.api.invoke('instance:worlds', profile.id).catch(() => [])
  ]);
  cache.set(profile.id, { mods: mods || [], worlds: worlds || [], loaded: true });
  repaint();
}

/** Lines this instance printed; launcher-wide lines (no profile) show up too. */
function logLines(ctx, profile) {
  return (ctx.state.logs || []).filter((entry) => !entry?.profile || entry.profile === profile.id);
}

/* --------------------------------------------------------------- cover */

/** The cover is artwork only – the player model belongs to the home scene. */
function cover(profile) {
  return el(
    'div',
    { class: 'instance-cover' },
    el('span', { class: 'instance-cover-name', text: profile.name })
  );
}

/* -------------------------------------------------------------- sidebar */

function sidebar(ctx, profile, running, preparing) {
  const info = versionInfo(profile.versionId);
  const data = cache.get(profile.id) || {};
  const active = profile.id === data.activeProfileId;

  const play = el(
    'button',
    {
      class: `btn primary instance-play${running ? ' is-stop' : ''}`,
      type: 'button',
      disabled: preparing,
      onclick: () => (running ? ctx.stopGame(profile.id) : ctx.launchGame(profile.id))
    },
    icon(running ? 'stop' : 'play', 18),
    el('span', { text: preparing ? 'Starting…' : running ? 'Stop game' : 'Play now' })
  );

  return el(
    'aside',
    { class: 'instance-side' },
    cover(profile),
    el(
      'div',
      { class: 'instance-side-body' },
      el(
        'div',
        { class: 'instance-tags' },
        el('span', { class: 'tag green', text: profile.modpack ? 'Modpack' : info.loader }),
        active ? el('span', { class: 'tag', text: 'Active' }) : null
      ),
      el('div', { class: 'instance-version', text: `${info.label} · ${formatMb(profile.memoryMb)} RAM` }),
      play,
      el(
        'button',
        { class: 'btn', type: 'button', onclick: () => ctx.openPath(profile.gameDir) },
        icon('folder', 16),
        el('span', { text: 'Open folder' })
      ),
      el(
        'div',
        { class: 'instance-meta' },
        el(
          'div',
          { class: 'kv' },
          el('span', {}, icon('cube', 14), el('span', { text: 'Content' })),
          el('b', { id: 'metaContent', text: data.loaded ? `${data.mods.length} files` : '…' })
        ),
        el(
          'div',
          { class: 'kv' },
          el('span', {}, icon('hourglass', 14), el('span', { text: 'Playtime' })),
          el('b', { id: 'metaPlaytime', text: formatPlaytime(profile.playtimeMs) })
        ),
        el(
          'div',
          { class: 'kv' },
          el('span', {}, icon('clock', 14), el('span', { text: 'Last played' })),
          el('b', { id: 'metaLastPlayed', text: formatAgo(profile.lastPlayedAt) })
        ),
        el(
          'div',
          { class: 'kv' },
          el('span', {}, icon('layers', 14), el('span', { text: 'Created' })),
          el('b', { text: formatDate(profile.createdAt) })
        ),
        profile.modpack
          ? el(
              'div',
              { class: 'kv' },
              el('span', {}, icon('download', 14), el('span', { text: 'Modpack' })),
              el('b', { text: `${profile.modpack.title || 'Modpack'}${profile.modpack.version ? ` ${profile.modpack.version}` : ''}` })
            )
          : null
      )
    )
  );
}

/* --------------------------------------------------------------- content */

/* mod dialogs keep their own state so a repaint never loses them */
let modMenu = null;
let swapState = null;
let addState = null;
let detailState = null;
let deleteState = null;

function sizeOf(mod) {
  return mod.sizeMb >= 1 ? `${mod.sizeMb} MB` : `${Math.max(1, Math.round(mod.sizeMb * 1024))} KB`;
}

/** Drops the cached file list and reads the mods folder again. */
async function reloadMods(ctx, profile) {
  cache.delete(profile.id);
  await loadContent(ctx, profile);
}

function contentTab(ctx, profile) {
  const data = cache.get(profile.id) || {};
  const mods = data.mods || [];
  const term = modFilter.trim().toLowerCase();
  const shown = term ? mods.filter((mod) => mod.name.toLowerCase().includes(term)) : mods;

  const search = el('input', {
    type: 'search',
    placeholder: 'Search installed mods',
    value: modFilter,
    spellcheck: false
  });
  search.addEventListener('input', () => {
    modFilter = search.value;
    const box = document.getElementById('modRows');
    if (!box) return;
    box.innerHTML = '';
    const list = modFilter.trim()
      ? (cache.get(profile.id)?.mods || []).filter((mod) => mod.name.toLowerCase().includes(modFilter.trim().toLowerCase()))
      : cache.get(profile.id)?.mods || [];
    for (const mod of list) box.appendChild(modRow(ctx, profile, mod));
  });

  return el(
    'div',
    { class: 'instance-pane' },
    el(
      'div',
      { class: 'instance-pane-head' },
      el('span', { class: 'instance-search' }, icon('search', 16), search),
      el(
        'button',
        { class: 'btn primary small', type: 'button', onclick: () => openAdd(ctx) },
        icon('plus', 15),
        el('span', { text: 'Add mods' })
      ),
      el(
        'button',
        { class: 'btn small', type: 'button', title: 'Open the mods folder', onclick: () => ctx.openPath(`${profile.gameDir}\\mods`) },
        icon('folder', 15)
      )
    ),
    !data.loaded && !data.loading ? el('div', { class: 'empty', text: 'Reading the instance folder…' }) : null,
    shown.length
      ? el('div', { class: 'mod-rows', id: 'modRows' }, ...shown.map((mod) => modRow(ctx, profile, mod)))
      : el('div', {
          class: 'empty',
          text: mods.length ? 'No mod matches that search.' : 'No mods in this instance yet – use “Add mods”.'
        })
  );
}

function modRow(ctx, profile, mod) {
  const menuOpen = modMenu === mod.file;

  const toggle = switchToggle(mod.enabled, async () => {
    try {
      const result = await ctx.api.invoke('instance:toggleMod', profile.id, mod.file);
      toast(`${result.file} ${result.enabled ? 'enabled' : 'disabled'}.`, 'success');
      await reloadMods(ctx, profile);
    } catch (err) {
      toast(err.message, 'error');
      await reloadMods(ctx, profile);
    }
  });

  const menuItem = (iconName, label, handler) =>
    el('button', { class: 'mod-menu-item', type: 'button', onclick: handler }, icon(iconName, 14), el('span', { text: label }));

  return el(
    'div',
    { class: `mod-row${mod.enabled ? '' : ' is-off'}` },
    el('span', { class: 'mod-icon' }, icon('cube', 17)),
    el(
      'span',
      { class: 'mod-main' },
      el('span', { class: 'mod-name', text: mod.name }),
      el('span', { class: 'mod-sub', text: `${mod.version || 'unknown version'} · ${sizeOf(mod)}${mod.enabled ? '' : ' · disabled'}` })
    ),
    el(
      'span',
      { class: 'mod-tools' },
      el(
        'button',
        { class: 'mod-btn', type: 'button', title: 'Change mod version', onclick: () => openSwap(ctx, profile, mod) },
        icon('refresh', 16)
      ),
      el(
        'span',
        { class: 'mod-menu-wrap' },
        el(
          'button',
          {
            class: `mod-btn${menuOpen ? ' is-on' : ''}`,
            type: 'button',
            title: 'Mod settings',
            onclick: (event) => {
              event.stopPropagation();
              modMenu = menuOpen ? null : mod.file;
              repaint();
            }
          },
          icon('settings', 16)
        ),
        menuOpen
          ? el(
              'span',
              { class: 'mod-menu' },
              menuItem('folder', 'Show in folder', () => {
                modMenu = null;
                ctx.api.invoke('instance:reveal', mod.path).catch(() => {});
                repaint();
              }),
              menuItem('eye', 'View details', () => {
                modMenu = null;
                detailState = mod;
                repaint();
              }),
              menuItem('trash', 'Delete file', () => {
                modMenu = null;
                deleteState = mod;
                repaint();
              })
            )
          : null
      ),
      toggle,
      el(
        'button',
        { class: 'mod-btn is-danger', type: 'button', title: 'Delete mod', onclick: () => { deleteState = mod; repaint(); } },
        icon('close', 16)
      )
    )
  );
}

/* ---------------------------------------------------------------- modals */

function modalLayer({ title, body, footer, onClose, wide = false }) {
  return el(
    'div',
    {
      class: 'mod-modal-layer',
      onclick: (event) => {
        if (event.target.classList.contains('mod-modal-layer')) onClose();
      }
    },
    el(
      'div',
      { class: `mod-modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      el(
        'div',
        { class: 'mod-modal-head' },
        el('span', { text: title }),
        el('button', { class: 'mod-btn', type: 'button', onclick: onClose }, icon('close', 16))
      ),
      el('div', { class: 'mod-modal-body' }, body),
      footer ? el('div', { class: 'mod-modal-foot' }, footer) : null
    )
  );
}

async function openSwap(ctx, profile, mod) {
  swapState = { mod, loading: true, versions: [], selected: null, busy: false };
  repaint();
  try {
    const data = await ctx.api.invoke('instance:modLookup', profile.id, mod.name);
    swapState = {
      mod,
      loading: false,
      project: data.project,
      versions: data.versions || [],
      selected: data.versions?.[0]?.id || null,
      busy: false
    };
  } catch (err) {
    swapState = { mod, loading: false, error: err.message, versions: [] };
  }
  repaint();
}

function swapModal(ctx, profile) {
  const state = swapState;
  const body = el('div', { class: 'mod-modal-list' });

  if (state.loading) {
    body.appendChild(el('div', { class: 'empty', text: 'Looking the mod up on Modrinth…' }));
  } else if (state.error) {
    body.appendChild(el('div', { class: 'empty', text: state.error }));
  } else if (!state.project) {
    body.appendChild(el('div', { class: 'empty', text: 'No Modrinth project matched this file.' }));
  } else {
    body.appendChild(
      el(
        'div',
        { class: 'mod-swap-head' },
        el('b', { text: `${state.project.title} · ${versionInfo(profile.versionId).label}` }),
        el('span', { class: 'faint small', text: `${state.versions.length} version${state.versions.length === 1 ? '' : 's'} for this instance` })
      )
    );
    if (!state.versions.length) {
      body.appendChild(el('div', { class: 'empty', text: 'No version of this mod targets your Minecraft version.' }));
    }
    for (const version of state.versions) {
      const selected = version.id === state.selected;
      body.appendChild(
        el(
          'button',
          {
            class: `mod-version${selected ? ' is-selected' : ''}`,
            type: 'button',
            onclick: () => {
              swapState = { ...state, selected: version.id };
              repaint();
            }
          },
          el('span', { class: 'mod-version-main' }, el('b', { text: version.version || version.name }), el('span', { class: 'faint small', text: version.name || '' }) ),
          selected ? icon('check', 16) : null
        )
      );
    }
  }

  return modalLayer({
    title: `Swap version · ${state.mod.name}`,
    wide: true,
    onClose: () => {
      swapState = null;
      repaint();
    },
    body,
    footer: el(
      'div',
      { class: 'mod-modal-actions' },
      el('span', { class: 'faint small', text: `Installed: ${state.mod.version || 'unknown'}` }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el('button', { class: 'btn', type: 'button', onclick: () => { swapState = null; repaint(); } }, el('span', { text: 'Cancel' })),
      el(
        'button',
        { class: 'btn primary', type: 'button', disabled: state.busy || !state.selected, onclick: () => doSwap(ctx, profile) },
        icon('refresh', 15),
        el('span', { text: state.busy ? 'Swapping…' : 'Swap version' })
      )
    )
  });
}

async function doSwap(ctx, profile) {
  const state = swapState;
  if (!state?.selected || state.busy) return;
  swapState = { ...state, busy: true };
  repaint();
  try {
    const picked = state.versions.find((version) => version.id === state.selected);
    const result = await ctx.api.invoke('modrinth:installMod', {
      profileId: profile.id,
      projectId: state.project.id,
      versionId: state.selected,
      loader: loaderFacet(profile)
    });
    if (result?.file && result.file !== state.mod.file) {
      await ctx.api.invoke('instance:deleteMod', profile.id, state.mod.file).catch(() => {});
    }
    swapState = null;
    toast(`${state.mod.name} is now ${picked?.version || 'updated'}.`, 'success');
    await reloadMods(ctx, profile);
  } catch (err) {
    toast(err.message, 'error');
    swapState = { ...state, busy: false };
    repaint();
  }
}

function openAdd(ctx) {
  addState = { query: '', results: [], loading: false, busy: null, searched: false };
  repaint();
}

async function runModSearch(ctx, profile) {
  const state = addState;
  if (!state) return;
  addState = { ...state, loading: true };
  repaint();
  try {
    const found = await ctx.api.invoke('instance:modSearch', profile.id, state.query.trim());
    addState = { ...state, loading: false, results: found?.hits || [], searched: true };
  } catch (err) {
    addState = { ...state, loading: false, results: [], error: err.message, searched: true };
  }
  repaint();
}

async function installProject(ctx, profile, project) {
  addState = { ...addState, busy: project.id };
  repaint();
  try {
    const mcVersion = versionInfo(profile.versionId).minecraft;
    const versions = await ctx.api.invoke('modrinth:versions', project.id, { gameVersion: mcVersion, loader: loaderFacet(profile) });
    const version = versions?.[0];
    if (!version) throw new Error(`No ${project.title} release for Minecraft ${mcVersion}.`);
    await ctx.api.invoke('modrinth:installMod', {
      profileId: profile.id,
      projectId: project.id,
      versionId: version.id,
      loader: loaderFacet(profile)
    });
    addState = { ...addState, busy: null };
    toast(`Installed ${project.title}.`, 'success');
    await reloadMods(ctx, profile);
  } catch (err) {
    toast(err.message, 'error');
    addState = { ...addState, busy: null };
    repaint();
  }
}

function addModal(ctx, profile) {
  const state = addState;
  const search = el('input', {
    type: 'search',
    placeholder: 'Search Modrinth mods for this instance',
    value: state.query,
    spellcheck: false
  });
  search.addEventListener('input', () => {
    addState = { ...addState, query: search.value };
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runModSearch(ctx, profile);
  });

  const body = el(
    'div',
    { class: 'mod-add' },
    el(
      'div',
      { class: 'mod-add-search' },
      el('span', { class: 'instance-search' }, icon('search', 16), search),
      el('button', { class: 'btn primary small', type: 'button', onclick: () => runModSearch(ctx, profile) }, el('span', { text: state.loading ? 'Searching…' : 'Search' }))
    ),
    el('div', { class: 'faint small', text: `${versionInfo(profile.versionId).label} · ${loaderLabel(profile)}` })
  );

  const list = el('div', { class: 'mod-modal-list' });
  if (state.error) list.appendChild(el('div', { class: 'empty', text: state.error }));
  else if (!state.searched) list.appendChild(el('div', { class: 'empty', text: 'Type a name and press Enter.' }));
  else if (!state.results.length) list.appendChild(el('div', { class: 'empty', text: 'Nothing found for this version.' }));
  for (const hit of state.results || []) {
    list.appendChild(
      el(
        'div',
        { class: 'mod-result' },
        el('span', { class: 'mod-icon' }, icon('cube', 17)),
        el(
          'span',
          { class: 'mod-main' },
          el('span', { class: 'mod-name', text: hit.title }),
          el('span', { class: 'mod-sub', text: hit.description })
        ),
        el(
          'button',
          {
            class: 'btn small primary',
            type: 'button',
            disabled: state.busy === hit.id,
            onclick: () => installProject(ctx, profile, hit)
          },
          icon('download', 15),
          el('span', { text: state.busy === hit.id ? 'Installing…' : 'Install' })
        )
      )
    );
  }
  body.appendChild(list);

  return modalLayer({
    title: 'Add mods',
    wide: true,
    onClose: () => {
      addState = null;
      repaint();
    },
    body,
    footer: el(
      'div',
      { class: 'mod-modal-actions' },
      el('span', { class: 'faint small', text: `Installs into ${profile.name}` }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el('button', { class: 'btn', type: 'button', onclick: () => { addState = null; repaint(); } }, el('span', { text: 'Done' }))
    )
  });
}

function detailModal(ctx) {
  const mod = detailState;
  const rows = [
    ['File', mod.file],
    ['Name', mod.name],
    ['Version', mod.version || 'unknown'],
    ['Size', sizeOf(mod)],
    ['Modified', formatAgo(mod.modifiedAt)],
    ['State', mod.enabled ? 'Enabled' : 'Disabled'],
    ['Folder', mod.path ? mod.path.replace(/[\\/][^\\/]+$/, '') : '']
  ];
  return modalLayer({
    title: mod.name,
    onClose: () => {
      detailState = null;
      repaint();
    },
    body: el(
      'div',
      { class: 'mod-detail' },
      ...rows.map(([label, value]) =>
        el('div', { class: 'kv' }, el('span', { text: label }), el('b', { class: 'mono small', text: String(value) }))
      )
    ),
    footer: el(
      'div',
      { class: 'mod-modal-actions' },
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el(
        'button',
        { class: 'btn', type: 'button', onclick: () => ctx.api.invoke('instance:reveal', mod.path).catch(() => {}) },
        icon('folder', 15),
        el('span', { text: 'Show in folder' })
      ),
      el('button', { class: 'btn primary', type: 'button', onclick: () => { detailState = null; repaint(); } }, el('span', { text: 'Close' }))
    )
  });
}

function deleteModal(ctx, profile) {
  const mod = deleteState;
  return modalLayer({
    title: 'Delete mod',
    onClose: () => {
      deleteState = null;
      repaint();
    },
    body: el(
      'div',
      { class: 'mod-detail' },
      el('p', { class: 'faint', text: `${mod.name} is removed from ${profile.name}. You can install it again from Modrinth.` }),
      el('div', { class: 'kv' }, el('span', { text: 'File' }), el('b', { class: 'mono small', text: mod.file })),
      el('div', { class: 'kv' }, el('span', { text: 'Size' }), el('b', { text: sizeOf(mod) }))
    ),
    footer: el(
      'div',
      { class: 'mod-modal-actions' },
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el('button', { class: 'btn', type: 'button', onclick: () => { deleteState = null; repaint(); } }, el('span', { text: 'Cancel' })),
      el(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: async () => {
            try {
              await ctx.api.invoke('instance:deleteMod', profile.id, mod.file);
              toast(`${mod.name} deleted.`, 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
            deleteState = null;
            await reloadMods(ctx, profile);
          }
        },
        icon('trash', 15),
        el('span', { text: 'Delete' })
      )
    )
  });
}

function worldsTab(ctx, profile) {
  const data = cache.get(profile.id) || {};
  const worlds = data.worlds || [];
  return el(
    'div',
    { class: 'instance-pane' },
    el(
      'div',
      { class: 'instance-pane-head' },
      el('span', { class: 'faint small', text: worlds.length ? `${worlds.length} world${worlds.length === 1 ? '' : 's'} in this instance` : 'No worlds yet' }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el(
        'button',
        { class: 'btn small', type: 'button', onclick: () => ctx.openPath(`${profile.gameDir}\\saves`) },
        icon('folder', 15),
        el('span', { text: 'Open folder' })
      )
    ),
    worlds.length
      ? el(
          'div',
          { class: 'mod-rows' },
          ...worlds.map((world) =>
            el(
              'div',
              { class: 'mod-row' },
              el('span', { class: 'mod-icon' }, icon('globe', 17)),
              el('span', { class: 'mod-main' }, el('span', { class: 'mod-name', text: world.name }), el('span', { class: 'mod-sub', text: `Changed ${formatAgo(world.modifiedAt)}` }))
            )
          )
        )
      : el('div', { class: 'empty', text: 'Start the game and create a world – it shows up here.' })
  );
}

function logsTab(ctx, profile) {
  const lines = logLines(ctx, profile);
  const box = el('div', { class: 'log-box instance-log' });
  for (const line of lines) {
    box.appendChild(el('div', { class: lineClass(line.text), text: line.text }));
  }
  if (follow) box.scrollTop = box.scrollHeight;

  return el(
    'div',
    { class: 'instance-pane' },
    el(
      'div',
      { class: 'instance-pane-head' },
      el('span', { class: 'faint small', text: `Only output of ${profile.name} – other running instances stay separate` }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el(
        'button',
        {
          class: `btn small${follow ? ' primary' : ''}`,
          type: 'button',
          onclick: () => {
            follow = !follow;
            repaint();
          }
        },
        icon('chevronRight', 15),
        el('span', { text: follow ? 'Following' : 'Paused' })
      ),
      el(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(lines.map((line) => line.text).join('\n'));
              toast('Log copied to clipboard.', 'success');
            } catch {
              toast('Clipboard is not available.', 'error');
            }
          }
        },
        icon('copy', 15),
        el('span', { text: 'Copy' })
      )
    ),
    box
  );
}

function lineClass(text) {
  if (/\b(ERROR|SEVERE|Exception|Failed|failed)\b/.test(text)) return 'err';
  if (/\[SallyLauncher\]|Launching|Client mods active/.test(text)) return 'info';
  return '';
}

/* -------------------------------------------------------------- settings */

function settingsTab(ctx, profile) {
  const data = ctx.state.data;
  const installed = ctx.state.versions?.installed || [];
  const available = ctx.state.versions?.available || [];
  const releases = available.filter((version) => version.type === 'release');
  const seen = new Set(releases.map((version) => version.id));
  const versions = [...installed.filter((version) => !seen.has(version.id)), ...releases];

  if (!ctx.state.versions) ctx.loadVersions();

  const name = el('input', { type: 'text', value: profile.name, spellcheck: false, style: { width: '100%' } });
  const versionSelect = el(
    'select',
    { style: { width: '100%' } },
    el('option', { value: '', text: 'Choose a version' }),
    ...versions.map((version) =>
      el('option', {
        value: version.id,
        text: `${version.id}${version.loader && version.loader !== 'Vanilla' ? ` (${version.loader})` : ''}`,
        selected: version.id === profile.versionId
      })
    )
  );
  if (profile.versionId && !versions.some((version) => version.id === profile.versionId)) {
    versionSelect.appendChild(el('option', { value: profile.versionId, text: profile.versionId, selected: true }));
  }

  const memoryLabel = el('span', { class: 'range-value', text: formatMb(profile.memoryMb) });
  const memory = el('input', { type: 'range', min: 1024, max: 16384, step: 512, value: profile.memoryMb });
  memory.addEventListener('input', () => {
    memoryLabel.textContent = formatMb(Number(memory.value));
  });

  const jvm = el('input', { type: 'text', value: profile.jvmArgs || '', placeholder: 'Extra JVM flags', spellcheck: false, style: { width: '100%' } });
  const server = el('input', { type: 'text', value: profile.serverAddress || '', placeholder: 'play.example.net', spellcheck: false, style: { width: '100%' } });
  const width = el('input', { type: 'number', value: profile.resolutionWidth, min: 320, max: 7680, disabled: !profile.customResolution });
  const height = el('input', { type: 'number', value: profile.resolutionHeight, min: 240, max: 4320, disabled: !profile.customResolution });
  const resolutionSwitch = switchToggle(profile.customResolution, (value) => {
    width.disabled = !value;
    height.disabled = !value;
  });

  const save = async () => {
    try {
      await ctx.api.invoke('profiles:update', profile.id, {
        name: name.value.trim() || profile.name,
        versionId: versionSelect.value || null,
        memoryMb: Number(memory.value),
        jvmArgs: jvm.value.trim(),
        serverAddress: server.value.trim(),
        customResolution: resolutionSwitch.classList.contains('on'),
        resolutionWidth: Number(width.value),
        resolutionHeight: Number(height.value)
      });
      await ctx.refresh();
      repaint();
      toast('Instance settings saved.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const active = profile.id === data.activeProfileId;

  return el(
    'div',
    { class: 'instance-pane' },
    el(
      'div',
      { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'field' }, el('span', { text: 'Version' }), versionSelect),
      el('label', { class: 'field' }, el('span', { text: 'Memory' }), el('div', { class: 'setting-control' }, memory, memoryLabel)),
      el('label', { class: 'field' }, el('span', { text: 'Server (auto-connect)' }), server),
      el('label', { class: 'field' }, el('span', { text: 'JVM arguments' }), jvm),
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Window size' }),
        el('div', { class: 'setting-control' }, resolutionSwitch, width, el('span', { class: 'faint', text: '×' }), height)
      ),
      el(
        'label',
        { class: 'field wide' },
        el('span', { text: 'Instance folder' }),
        el('div', { class: 'setting-control' }, el('span', { class: 'mono small', text: profile.gameDir }))
      )
    ),
    el(
      'div',
      { class: 'toolbar', style: { marginTop: '16px', marginBottom: '0' } },
      el('button', { class: 'btn primary', type: 'button', onclick: save }, icon('check', 16), el('span', { text: 'Save changes' })),
      active
        ? null
        : el(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                await ctx.api.invoke('profiles:select', profile.id);
                await ctx.refresh();
                repaint();
                toast(`${profile.name} is the active profile now.`, 'success');
              }
            },
            icon('star', 16),
            el('span', { text: 'Make active' })
          ),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          disabled: data.profiles.length <= 1,
          title: data.profiles.length <= 1 ? 'Keep at least one profile' : 'Delete this instance',
          onclick: async () => {
            await ctx.api.invoke('profiles:remove', profile.id);
            await ctx.refresh();
            toast(`Deleted ${profile.name}`, 'info');
            ctx.navigate('home');
          }
        },
        icon('trash', 16),
        el('span', { text: 'Delete instance' })
      )
    )
  );
}

/* ---------------------------------------------------------------- render */

export function render(root, ctx) {
  lastRoot = root;
  lastCtx = ctx;
  const data = ctx.state.data;
  const profile =
    data.profiles.find((entry) => entry.id === ctx.state.instanceId) || data.activeProfile || data.profiles[0];
  if (!profile) {
    root.appendChild(el('div', { class: 'empty', text: 'No instance selected.' }));
    return;
  }
  ctx.state.instanceId = profile.id;

  const instance = (data.instances || []).find((entry) => entry.profileId === profile.id);
  const running = instance?.state === 'running';
  const preparing = instance?.state === 'preparing';
  const tab = TABS.some((entry) => entry.id === ctx.state.instanceTab) ? ctx.state.instanceTab : 'content';

  const pane =
    tab === 'content'
      ? contentTab(ctx, profile)
      : tab === 'worlds'
        ? worldsTab(ctx, profile)
        : tab === 'logs'
          ? logsTab(ctx, profile)
          : settingsTab(ctx, profile);

  root.append(
    el(
      'div',
      { class: 'page-head instance-head' },
      el(
        'div',
        { class: 'instance-head-left' },
        el(
          'button',
          {
            class: 'btn back-btn',
            type: 'button',
            onclick: () => ctx.navigate(ctx.state.instanceReturn || 'home')
          },
          icon('chevronLeft', 16),
          el('span', { text: 'Back' })
        ),
        el(
          'div',
          {},
          el(
            'h1',
            { class: 'page-title' },
            el('span', { text: profile.name }),
            running ? el('span', { class: 'tag green', text: 'Running' }) : null,
            preparing ? el('span', { class: 'tag green', text: 'Starting' }) : null
          ),
          el('div', {
            class: 'page-sub',
            text: `${versionInfo(profile.versionId).label} · ${formatPlaytime(profile.playtimeMs)} played · ${formatAgo(profile.lastPlayedAt)}`
          })
        )
      )
    ),
    el(
      'div',
      { class: 'instance-layout' },
      sidebar(ctx, profile, running, preparing),
      el(
        'section',
        { class: 'instance-main' },
        el(
          'div',
          { class: 'instance-tabs' },
          ...TABS.map((entry) =>
            el(
              'button',
              {
                class: `instance-tab${entry.id === tab ? ' active' : ''}`,
                type: 'button',
                onclick: () => {
                  ctx.state.instanceTab = entry.id;
                  repaint();
                }
              },
              icon(entry.icon, 16),
              el('span', { text: entry.label })
            )
          )
        ),
        pane
      )
    )
  );

  if (swapState) root.appendChild(swapModal(ctx, profile));
  if (addState) root.appendChild(addModal(ctx, profile));
  if (detailState) root.appendChild(detailModal(ctx));
  if (deleteState) root.appendChild(deleteModal(ctx, profile));

  loadContent(ctx, profile);
}

export function onState(root, ctx) {
  const current = ctx.state.data.profiles.find((entry) => entry.id === ctx.state.instanceId);
  if (current) {
    /* the sidebar numbers change even while the page stays on the logs tab */
    const playtime = root.querySelector('#metaPlaytime');
    if (playtime) playtime.textContent = formatPlaytime(current.playtimeMs);
    const lastPlayed = root.querySelector('#metaLastPlayed');
    if (lastPlayed) lastPlayed.textContent = formatAgo(current.lastPlayedAt);
    const content = root.querySelector('#metaContent');
    const loaded = cache.get(current.id);
    if (content && loaded?.loaded) content.textContent = `${loaded.mods.length} files`;
  }

  if (ctx.state.instanceTab === 'logs') {
    /* keep the log pane live without rebuilding the whole page */
    const profile = ctx.state.data.profiles.find((entry) => entry.id === ctx.state.instanceId);
    const box = root.querySelector('.instance-log');
    if (box && profile) {
      const lines = logLines(ctx, profile);
      box.innerHTML = '';
      for (const line of lines) box.appendChild(el('div', { class: lineClass(line.text), text: line.text }));
      if (follow) box.scrollTop = box.scrollHeight;
      return;
    }
  }
  if (root.querySelector('.instance-pane input:focus, .instance-pane select:focus, .mod-modal input:focus')) return;
  repaint();
}

export function onLog(root, ctx) {
  if (!lastRoot || !lastRoot.isConnected) return;
  if (ctx.state.instanceTab !== 'logs') return;
  const profile = ctx.state.data.profiles.find((entry) => entry.id === ctx.state.instanceId);
  const box = lastRoot.querySelector('.instance-log');
  if (!box || !profile) return;
  const lines = logLines(ctx, profile);
  const last = lines[lines.length - 1];
  if (!last) return;
  const node = el('div', { class: lineClass(last.text), text: last.text });
  box.appendChild(node);
  while (box.childElementCount > 4000) box.firstElementChild.remove();
  if (follow) box.scrollTop = box.scrollHeight;
}
