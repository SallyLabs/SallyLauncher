import { el, icon, toast } from '../ui.js';

const view = {
  items: null,
  loading: false,
  error: null,
  version: '',
  configured: true,
  collection: 'all',
  busy: null
};

const COLLECTIONS = ['basics', 'flower', 'halloween', 'royal', 'xmas', 'ranks'];

function profileOf(ctx) {
  return ctx.state.data?.activeProfile || null;
}

async function load(ctx) {
  view.loading = true;
  view.error = null;
  ctx.refreshView();
  try {
    const result = await ctx.api.invoke('cosmetics:list', {});
    view.items = result?.items || [];
    view.version = result?.version || '';
    view.configured = result?.configured !== false;
  } catch (err) {
    view.error = err.message;
    view.items = [];
  } finally {
    view.loading = false;
    ctx.refreshView();
  }
}

async function wear(ctx, item) {
  const profile = profileOf(ctx);
  if (!profile) {
    toast('Create a profile first.', 'error');
    return;
  }
  view.busy = item.id;
  ctx.refreshView();
  try {
    const result = await ctx.api.invoke('cosmetics:toggle', { profileId: profile.id, id: item.id });
    const worn = new Set((result?.worn || []).map((entry) => String(entry).toUpperCase()));
    view.items = (view.items || []).map((entry) => ({ ...entry, worn: worn.has(entry.id.toUpperCase()) }));
    toast(
      result?.removed
        ? `${item.name} taken off in ${profile.name}.`
        : `${item.name} is now worn in ${profile.name}.`,
      'success'
    );
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    view.busy = null;
    ctx.refreshView();
  }
}

async function buy(ctx, item) {
  const profile = profileOf(ctx);
  if (!profile) {
    toast('Create a profile first.', 'error');
    return;
  }
  try {
    await ctx.api.invoke('launch:start', { profileId: profile.id });
    toast(`${item.name} — buy it in the shop, then wear it here.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function visible() {
  const items = view.items || [];
  return view.collection === 'all' ? items : items.filter((item) => item.collection === view.collection);
}

function row(ctx, item) {
  const busy = view.busy === item.id;
  return el(
    'article',
    { class: `cos-row${item.worn ? ' is-worn' : ''}` },
    el(
      'div',
      { class: 'cos-thumb', title: item.name },
      item.image ? el('img', { src: item.image, alt: item.name, loading: 'lazy' }) : icon('sparkles', 18)
    ),
    el(
      'div',
      { class: 'cos-info' },
      el('span', { class: 'cos-name', text: item.name }),
      el('span', {
        class: 'cos-meta',
        text: `${item.slot}${item.collection ? ` · ${item.collection}` : ''}`
      })
    ),
    el('span', {
      class: 'cos-price',
      title: item.price ? `${item.price} credits in the client shop` : 'Rank reward',
      text: item.price ? `${item.price} cr` : 'rank'
    }),
    el(
      'div',
      { class: 'cos-actions' },
      el(
        'button',
        { class: 'cos-btn buy', type: 'button', title: 'Open the client and buy it in the shop', onclick: () => buy(ctx, item) },
        el('span', { text: 'Buy' })
      ),
      el(
        'button',
        {
          class: `cos-btn wear${item.worn ? ' is-on' : ''}`,
          type: 'button',
          disabled: busy || !view.configured,
          title: view.configured
            ? item.worn
              ? 'Take it off'
              : 'Wear it in the client'
            : 'Start SallyClient once for this profile so it writes its config',
          onclick: () => wear(ctx, item)
        },
        busy ? el('span', { class: 'spinner' }) : icon(item.worn ? 'check' : 'plus', 14),
        el('span', { text: busy ? '…' : item.worn ? 'Worn' : 'Wear' })
      )
    )
  );
}

function toolbar(ctx) {
  const items = view.items || [];
  const chips = [['all', `All ${items.length}`]].concat(
    COLLECTIONS.filter((name) => items.some((item) => item.collection === name)).map((name) => [
      name,
      `${name.charAt(0).toUpperCase()}${name.slice(1)} ${items.filter((item) => item.collection === name).length}`
    ])
  );
  return el(
    'div',
    { class: 'cos-toolbar' },
    el(
      'div',
      { class: 'cos-filters' },
      ...chips.map(([id, label]) =>
        el(
          'button',
          {
            class: `mr-tab${view.collection === id ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              view.collection = id;
              ctx.refreshView();
            }
          },
          el('span', { text: label })
        )
      )
    ),
    el('span', { class: 'cos-hint', text: 'Buy in the client shop · wear from here' })
  );
}

function grid(ctx) {
  if (view.loading && !view.items) {
    return el('div', { class: 'cos-grid' }, ...[1, 2, 3, 4, 5, 6, 7, 8].map(() => el('div', { class: 'cos-row skeleton' })));
  }
  if (view.error) {
    return el('div', { class: 'notice' }, icon('alert', 16), el('span', { text: view.error }));
  }
  const items = visible();
  if (!items.length) return el('div', { class: 'empty' }, el('span', { text: 'Nothing in this collection.' }));
  return el('div', { class: 'cos-grid' }, ...items.map((item) => row(ctx, item)));
}

export function render(root, ctx) {
  root.innerHTML = '';
  const profile = profileOf(ctx);
  if (!view.items && !view.loading) load(ctx);
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Cosmetics' }),
        el('div', {
          class: 'page-sub',
          text: `${view.items?.length || 0} items${view.version ? ` · client ${view.version}` : ''}`
        })
      ),
      el(
        'div',
        { class: 'head-actions' },
        el(
          'button',
          { class: 'btn ghost small', type: 'button', disabled: view.loading, onclick: () => load(ctx) },
          view.loading ? el('span', { class: 'spinner' }) : icon('refresh', 15),
          el('span', { text: view.loading ? 'Loading…' : 'Refresh' })
        ),
        el('span', { class: 'chip' }, icon('layers', 16), el('span', { text: profile?.name || 'No profile' }))
      )
    ),
    toolbar(ctx),
    grid(ctx)
  );
}

export function onState(root, ctx) {
  render(root, ctx);
}

export async function onEnter(ctx) {
  if (!view.items) await load(ctx);
}
