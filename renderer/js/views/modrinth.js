import { el, icon, toast } from '../ui.js';

const view = {
  tab: 'modpack',
  query: '',
  results: [],
  total: 0,
  loading: false,
  error: null,
  busy: null,
  projects: []
};

function mcVersionOf(data) {
  const raw = data.selectedVersion || data.activeProfile?.versionId || '';
  const match = /^[a-z-]+-loader-[\d.]+-(.+)$/.exec(raw);
  return match ? match[1] : raw;
}

async function loadResults(ctx) {
  view.loading = true;
  view.error = null;
  ctx.refreshView();
  try {
    const result = await ctx.api.invoke('modrinth:search', {
      query: view.query,
      projectType: view.tab,
      gameVersion: mcVersionOf(ctx.state.data),
      loader: 'fabric',
      limit: 18
    });
    view.results = result.hits || [];
    view.total = result.total || 0;
  } catch (err) {
    view.error = err.message;
    view.results = [];
  } finally {
    view.loading = false;
    ctx.refreshView();
  }
}

function toolbar(ctx) {
  const search = el('input', {
    type: 'search',
    value: view.query,
    placeholder: view.tab === 'modpack' ? 'Search modpacks on Modrinth…' : 'Search mods on Modrinth…'
  });
  const submit = () => {
    view.query = search.value.trim();
    loadResults(ctx);
  };
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  return el(
    'div',
    { class: 'mr-toolbar' },
    el('div', { class: 'mr-search' }, icon('search', 17), search),
    el('button', { class: 'btn primary', type: 'button', onclick: submit }, el('span', { text: 'Search' })),
    el(
      'button',
      {
        class: 'btn',
        type: 'button',
        title: 'Import a downloaded .mrpack file as a new profile',
        onclick: async () => {
          try {
            const result = await ctx.api.invoke('modrinth:importPackFile');
            if (!result) return;
            toast(`${result.profile.name} imported with ${result.pack.files} files.`, 'success');
            await ctx.refresh();
            ctx.navigate('profiles');
          } catch (err) {
            toast(err.message, 'error');
          }
        }
      },
      icon('folder', 16),
      el('span', { text: 'Import .mrpack' })
    ),
    el('div', { class: 'spacer' }),
    el(
      'div',
      { class: 'mr-tabs' },
      el(
        'button',
        { class: `mr-tab${view.tab === 'modpack' ? ' active' : ''}`, type: 'button', onclick: () => { view.tab = 'modpack'; view.results = []; loadResults(ctx); } },
        el('span', { text: 'Modpacks' })
      ),
      el(
        'button',
        { class: `mr-tab${view.tab === 'mod' ? ' active' : ''}`, type: 'button', onclick: () => { view.tab = 'mod'; view.results = []; loadResults(ctx); } },
        el('span', { text: 'Mods' })
      )
    )
  );
}

function packCard(ctx, project) {
  const installing = view.busy === project.id;
  return el(
    'div',
    { class: 'mr-card' },
    project.iconUrl
      ? el('img', { class: 'mr-icon', src: project.iconUrl, alt: project.title })
      : el('div', { class: 'mr-icon placeholder' }, icon('cube', 24)),
    el(
      'div',
      { class: 'mr-main' },
      el('div', { class: 'mr-title', title: project.title, text: project.title }),
      el('div', { class: 'mr-desc', text: project.description }),
      el(
        'div',
        { class: 'mr-meta' },
        el('span', { class: 'tag', text: `${Math.round((project.downloads || 0) / 1000)}k downloads` }),
        project.categories.slice(0, 2).map((category) => el('span', { class: 'tag', text: category }))
      )
    ),
    el(
      'button',
      {
        class: 'btn primary small',
        type: 'button',
        disabled: installing,
        onclick: async () => {
          view.busy = project.id;
          ctx.refreshView();
          try {
            await ctx.api.invoke('modrinth:importPack', {
              projectId: project.id,
              name: project.title,
              iconUrl: project.iconUrl,
              gameVersion: mcVersionOf(ctx.state.data),
              loader: 'fabric'
            });
            toast(`Profile „${project.title}" created.`, 'success');
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            view.busy = null;
            await ctx.refresh();
          }
        }
      },
      installing ? el('span', { class: 'spinner' }) : icon('download', 16),
      el('span', { text: installing ? 'Installing…' : 'Install as profile' })
    )
  );
}

function modCard(ctx, project) {
  const profile = ctx.state.data.activeProfile;
  const installing = view.busy === project.id;
  return el(
    'div',
    { class: 'mr-card' },
    project.iconUrl
      ? el('img', { class: 'mr-icon', src: project.iconUrl, alt: project.title })
      : el('div', { class: 'mr-icon placeholder' }, icon('layers', 24)),
    el(
      'div',
      { class: 'mr-main' },
      el('div', { class: 'mr-title', title: project.title, text: project.title }),
      el('div', { class: 'mr-desc', text: project.description }),
      el('div', { class: 'mr-meta' }, el('span', { class: 'tag', text: project.author || 'Modrinth' }))
    ),
    el(
      'button',
      {
        class: 'btn small',
        type: 'button',
        disabled: installing || !profile,
        title: profile ? `Installs into ${profile.name}` : 'Create a profile first',
        onclick: async () => {
          view.busy = project.id;
          ctx.refreshView();
          try {
            const result = await ctx.api.invoke('modrinth:installMod', {
              projectId: project.id,
              loader: 'fabric'
            });
            toast(`${result.name || result.file} added to ${profile.name}.`, 'success');
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            view.busy = null;
            ctx.refreshView();
          }
        }
      },
      installing ? el('span', { class: 'spinner' }) : icon('plus', 16),
      el('span', { text: installing ? 'Adding…' : 'Add to profile' })
    )
  );
}

function results(ctx) {
  if (view.loading) {
    return el('div', { class: 'mr-grid' }, ...[1, 2, 3, 4].map(() => el('div', { class: 'mr-card skeleton' })));
  }
  if (view.error) return el('div', { class: 'notice' }, icon('alert', 16), el('span', { text: view.error }));
  if (!view.results.length) {
    return el('div', { class: 'empty' }, el('span', { text: 'Nothing found. Try another search term.' }));
  }
  return el(
    'div',
    { class: 'mr-grid' },
    ...view.results.map((project) => (view.tab === 'modpack' ? packCard(ctx, project) : modCard(ctx, project)))
  );
}

export function render(root, ctx) {
  root.innerHTML = '';
  const data = ctx.state.data;
  const profile = data.activeProfile;

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Modrinth' }),
        el('div', {
          class: 'page-sub',
          text: `Minecraft ${mcVersionOf(data) || '—'} · ${profile?.name || 'no profile'}`
        })
      ),
      el(
        'div',
        { class: 'head-actions' },
        el('span', { class: 'chip' }, icon('layers', 16), el('span', { text: profile?.name || 'No profile' }))
      )
    ),
    el('section', { class: 'panel mr-browser' }, toolbar(ctx), results(ctx))
  );

  if (!view.results.length && !view.loading && !view.error) loadResults(ctx);
}

export function onState(root, ctx) {
  render(root, ctx);
}

export async function onEnter(ctx) {
  if (!view.results.length) await loadResults(ctx);
}
