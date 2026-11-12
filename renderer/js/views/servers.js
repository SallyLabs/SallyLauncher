import { el, icon, toast } from '../ui.js';

const view = {
  servers: [],
  loading: false,
  error: null,
  fetchedAt: null,
  busy: null,
  loaded: false
};

async function load(ctx, force = false) {
  view.loading = true;
  view.error = null;
  ctx.refreshView();
  try {
    const result = await ctx.api.invoke('servers:list', { force });
    view.servers = result?.servers || [];
    view.fetchedAt = result?.fetchedAt || null;
    if (result?.error) view.error = `Showing the saved list – ${result.error}`;
  } catch (err) {
    view.error = err.message;
    view.servers = [];
  } finally {
    view.loading = false;
    view.loaded = true;
    ctx.refreshView();
  }
}

async function apply(ctx, server, join) {
  const profile = ctx.state.data?.activeProfile;
  if (!profile) {
    toast('Create a profile first.', 'error');
    return;
  }
  view.busy = server.id;
  ctx.refreshView();
  try {
    await ctx.api.invoke('servers:apply', { profileId: profile.id, address: server.address });
    await ctx.refresh();
    if (join) {
      await ctx.launchGame(profile.id);
      toast(`Launching ${profile.name} on ${server.name}…`, 'success');
    } else {
      toast(`${server.name} saved as the server of ${profile.name}.`, 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    view.busy = null;
    ctx.refreshView();
  }
}

function bannerFallback(server) {
  return el('div', { class: 'srv-banner fallback' }, icon('globe', 26), el('span', { text: server.name }));
}

function banner(server) {
  if (!server.banner) return bannerFallback(server);
  const img = el('img', { class: 'srv-banner', src: server.banner, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => {
    if (img.isConnected) img.replaceWith(bannerFallback(server));
  });
  return img;
}

function card(ctx, server) {
  const busy = view.busy === server.id;
  const profile = ctx.state.data?.activeProfile;
  const active = profile?.serverAddress === server.address;
  return el(
    'article',
    { class: `srv-card${active ? ' active' : ''}` },
    banner(server),
    el(
      'div',
      { class: 'srv-body' },
      el(
        'div',
        { class: 'srv-head' },
        el('span', { class: 'srv-name', text: server.name }),
        server.featured ? el('span', { class: 'tag accent', text: 'Featured' }) : null,
        active ? el('span', { class: 'tag green', text: 'Active' }) : null
      ),
      el('div', { class: 'srv-address', text: server.address }),
      server.description ? el('p', { class: 'srv-desc', text: server.description }) : null,
      el(
        'div',
        { class: 'srv-meta' },
        ...(server.languages || []).map((lang) => el('span', { class: 'tag', text: String(lang).toUpperCase() }))
      ),
      el(
        'div',
        { class: 'srv-actions' },
        el(
          'button',
          { class: 'btn primary small', type: 'button', disabled: busy, onclick: () => apply(ctx, server, true) },
          busy ? el('span', { class: 'spinner' }) : icon('play', 15),
          el('span', { text: busy ? 'Starting…' : 'Play' })
        ),
        el(
          'button',
          {
            class: 'btn small',
            type: 'button',
            disabled: busy,
            title: profile ? `Sets ${server.address} on ${profile.name}` : 'Create a profile first',
            onclick: () => apply(ctx, server, false)
          },
          icon('plus', 15),
          el('span', { text: 'Add' })
        )
      )
    )
  );
}

function grid(ctx) {
  if (view.loading && !view.servers.length) {
    return el('div', { class: 'srv-grid' }, ...[1, 2, 3].map(() => el('div', { class: 'srv-card skeleton' })));
  }
  if (view.error && !view.servers.length) {
    return el('div', { class: 'notice' }, icon('alert', 16), el('span', { text: view.error }));
  }
  if (!view.servers.length) {
    return el('div', { class: 'empty' }, el('span', { text: 'No servers in the list yet.' }));
  }
  return el('div', { class: 'srv-grid' }, ...view.servers.map((server) => card(ctx, server)));
}

export function render(root, ctx) {
  root.innerHTML = '';
  const profile = ctx.state.data?.activeProfile;

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Servers' }),
        el('div', {
          class: 'page-sub',
          text: profile ? profile.name : ''
        })
      ),
      el(
        'div',
        { class: 'head-actions' },
        el(
          'button',
          { class: 'btn ghost small', type: 'button', disabled: view.loading, title: 'Ask the Sally server for the list again', onclick: () => load(ctx, true) },
          view.loading ? el('span', { class: 'spinner' }) : icon('refresh', 15),
          el('span', { text: view.loading ? 'Loading…' : 'Refresh' })
        )
      )
    ),
    el(
      'section',
      { class: 'panel srv-panel' },
      view.error && view.servers.length
        ? el('div', { class: 'notice' }, icon('alert', 16), el('span', { text: view.error }))
        : null,
      grid(ctx)
    )
  );

  if (!view.loaded && !view.loading) load(ctx);
}

export function onState(root, ctx) {
  render(root, ctx);
}

export async function onEnter(ctx) {
  if (!view.loaded) await load(ctx);
}
