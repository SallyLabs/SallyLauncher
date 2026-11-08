import { el, icon, logoMark } from '../ui.js';
import { createModelBuilder, createViewer, applySkinScale } from '../mc-model.js';

/** Screen pixels per skin pixel. */
const U = 9;

const ITEMS = [
  {
    id: 'sally-cape',
    name: 'Sally Cape',
    slot: 'Cape',
    rarity: 'Legendary',
    tone: 'void',
    yaw: 200,
    about: 'The launcher look, worn on your back: dark cloth, a violet seam and the cat on the back.',
    solo: { s: 1.5, c: 0.45 }
  },
  {
    id: 'sally-wings',
    name: 'Sally Wings',
    slot: 'Back',
    rarity: 'Mythic',
    tone: 'ember',
    yaw: 176,
    about: 'Two fans of feathers behind your shoulders. Every feather moves on its own.',
    solo: { s: 1.5, c: -2.35 }
  },
  {
    id: 'sally-crown',
    name: 'Sally Crown',
    slot: 'Head',
    rarity: 'Radiant',
    tone: 'gold',
    yaw: -24,
    about: 'Gold points around the rim and a single amethyst set into the front that never stops pulsing.',
    solo: { s: 2.2, c: -17.5 }
  },
  {
    id: 'sally-halo',
    name: 'Sally Halo',
    slot: 'Head',
    rarity: 'Celestial',
    tone: 'frost',
    yaw: -18,
    about: 'A thin ring of light with two sparks that keep circling above your head.',
    solo: { s: 2.4, c: -19 }
  }
];

/** Viewer state that has to survive re-renders (equip, theme, navigation). */
const view = { mode: 'grid', id: null, onPlayer: true };

let viewer = null;
let lastRoot = null;
let lastCtx = null;

function equippedItem(ctx) {
  const saved = ctx.state.data.settings.cosmeticId;
  // ids from the first version of this page keep working
  const legacy = {
    'ember-cape': 'sally-cape',
    'void-wings': 'sally-wings',
    'elytra-wings': 'sally-wings',
    'amethyst-crown': 'sally-crown',
    'starlight-halo': 'sally-halo'
  };
  return ITEMS.find((entry) => entry.id === (legacy[saved] || saved)) || ITEMS[0];
}

/** The skin the account is wearing right now, or the same skin by name. */
function skinUrlFor(account) {
  if (account?.skinUrl) return String(account.skinUrl).replace(/^http:\/\//, 'https://');
  return `https://mc-heads.net/skin/${encodeURIComponent(account?.name || 'Steve')}`;
}

/* -------------------------------------------------------------- cosmetics */

/** Accessories are painted by CSS, so they must not sample the skin texture. */
const plainBox = (b) => (options) => b.box({ ...options, url: null });

function buildCape(b) {
  const box = plainBox(b);
  const wrap = el('div', {
    class: 'mc-cape-wrap',
    style: { left: `${2.25 * U}px`, top: `${8.4 * U}px`, width: `${11.5 * U}px`, height: `${18 * U}px` }
  });
  const cape = box({ w: 11.5, h: 18, d: 1, cls: 'mc-accessory mc-cape' });
  // the blinking cat from the launcher, stitched onto the back
  cape.querySelector('.f-back').append(el('span', { class: 'mc-crest' }, logoMark(54)));
  wrap.append(cape);
  return wrap;
}

function buildWings(b) {
  const box = plainBox(b);
  const wing = (side) => {
    const left = side === 'l';
    const wrap = el('div', {
      class: `mc-wing mc-wing-${side}`,
      style: { left: `${4 * U}px`, top: `${6.8 * U}px`, width: `${8 * U}px`, height: `${14 * U}px` }
    });

    // shoulder joint at the spine
    wrap.append(box({ w: 3.2, h: 4.2, d: 1.5, x: left ? 3.2 : 1.6, y: -0.6, cls: 'mc-accessory mc-wings mc-wing-root' }));

    // arm the feathers grow from, pivoting upwards at the spine
    wrap.append(
      el(
        'div',
        {
          class: 'mc-wing-arm',
          style: {
            left: `${(4 - 0.8) * U}px`,
            top: `${(1.8 - 10.4) * U}px`,
            width: `${1.6 * U}px`,
            height: `${10.4 * U}px`,
            transform: `rotateZ(${left ? 70 : -70}deg)`
          }
        },
        box({ w: 1.6, h: 10.4, d: 1.4, cls: 'mc-accessory mc-wings mc-wing-arm-box' })
      )
    );

    // feathers hang from the arm; outer tips sit higher, so the edge rises
    const feathers = [
      { dx: 1.7, y: 1.6, len: 13.5, w: 1.9 },
      { dx: 3.94, y: 0.8, len: 15, w: 2 },
      { dx: 6.17, y: 0, len: 13.5, w: 2 },
      { dx: 8.4, y: -0.8, len: 10.5, w: 1.9 },
      { dx: 10.21, y: -1.4, len: 7.5, w: 1.8 }
    ];

    feathers.forEach((feather, index) => {
      const baseX = 4 + (left ? feather.dx : -feather.dx);
      wrap.append(
        box({
          w: feather.w,
          h: feather.len,
          d: 1.1,
          x: baseX - feather.w / 2,
          y: feather.y,
          cls: `mc-accessory mc-wings mc-feather-${index}`
        })
      );
    });

    return wrap;
  };
  return [wing('l'), wing('r')];
}

function buildCrown(b) {
  const box = plainBox(b);
  const group = el('div', { class: 'mc-crown-group' });
  // gold band hugging the upper head
  group.append(
    box({ w: 8.8, h: 2.2, d: 0.8, x: -0.4, y: -1.9, z: 4.4, cls: 'mc-accessory mc-crown' }),
    box({ w: 8.8, h: 2.2, d: 0.8, x: -0.4, y: -1.9, z: -4.4, cls: 'mc-accessory mc-crown' }),
    box({ w: 0.8, h: 2.2, d: 8.8, x: -0.4, y: -1.9, cls: 'mc-accessory mc-crown' }),
    box({ w: 0.8, h: 2.2, d: 8.8, x: 7.6, y: -1.9, cls: 'mc-accessory mc-crown' })
  );
  // blocky points around the rim
  for (const [sx, sz] of [[0, 4], [8, 4], [0, -4], [8, -4], [4, 4], [4, -4]]) {
    group.append(box({ w: 1.2, h: 1.8, d: 1.2, x: sx - 0.6, y: -3.5, z: sz, cls: 'mc-accessory mc-crown mc-spike' }));
  }
  // amethyst set into the front of the band
  group.append(box({ w: 1.3, h: 1.3, d: 0.5, x: 3.35, y: -1, z: 4.9, cls: 'mc-gem' }));
  return group;
}

function buildHalo() {
  const wrap = el('div', {
    class: 'mc-halo',
    style: { left: `calc(50% - ${4 * U}px)`, top: `${-7 * U}px`, width: `${8 * U}px`, height: `${8 * U}px` }
  });
  const ring = el('div', { class: 'mc-halo-ring' });
  const orbit = el('div', { class: 'mc-halo-orbit' });
  orbit.append(el('span', { class: 'mc-spark mc-spark-a' }), el('span', { class: 'mc-spark mc-spark-b' }));
  ring.append(orbit);
  wrap.append(ring);
  return wrap;
}

/* ------------------------------------------------------------------ model */

/**
 * Scene with the model, either worn by the player or floating on its own.
 * `still` locks a three-quarter view, used for the small store thumbnails.
 */
function buildScene(url, item, solo, still = false) {
  const builder = createModelBuilder({ url, unit: U });
  const model = builder.player({ head: item.id === 'sally-crown' ? [buildCrown(builder)] : [] });

  if (item.id === 'sally-cape') model.append(buildCape(builder));
  if (item.id === 'sally-wings') model.append(...buildWings(builder));
  if (item.id === 'sally-halo') model.append(buildHalo());

  applySkinScale(model, url);

  let body = model;
  if (solo) {
    model.classList.add('is-solo');
    const { s, c } = item.solo;
    body = el(
      'div',
      {
        class: 'mc-frame',
        // centre the loose cosmetic in the frame, then scale it up
        style: { transform: `translateY(${-s * c * U}px) scale(${s})` }
      },
      model
    );
  }
  if (still) model.style.transform = `rotateX(6deg) rotateY(${item.yaw ?? -24}deg)`;

  return el(
    'div',
    { class: `mc-scene${solo ? ' is-solo' : ''}`, style: { width: `${16 * U}px`, height: `${32 * U}px` } },
    body
  );
}

/* ------------------------------------------------------------------ views */

function card(item, current) {
  const equipped = current.id === item.id;
  return el(
    'button',
    {
      class: `store-card tone-${item.tone}${equipped ? ' is-equipped' : ''}`,
      type: 'button',
      onclick: () => {
        view.mode = 'detail';
        view.id = item.id;
        redraw();
      }
    },
    el(
      'span',
      { class: 'store-art' },
      buildScene(skinUrlFor(lastCtx.state.data.activeAccount), item, true, true),
      equipped ? el('span', { class: 'store-badge', text: 'Equipped' }) : null
    ),
    el(
      'span',
      { class: 'store-body' },
      el('span', { class: 'store-meta', text: item.slot }),
      el('span', { class: 'store-name', text: item.name })
    ),
    el('span', { class: 'store-cta' }, el('span', { text: 'View item' }), icon('chevronRight', 16))
  );
}

function renderGrid(root, ctx, equipped) {
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Cosmetics' }),
        el('div', { class: 'page-sub', text: 'Blocky cosmetics, rendered on the skin you are wearing right now.' })
      ),
      el(
        'div',
        { class: 'head-actions' },
        el('span', { class: 'chip' }, icon('sparkles', 16), el('span', { text: `${ITEMS.length} items` }))
      )
    ),
    el('div', { class: 'store-grid' }, ...ITEMS.map((item) => card(item, equipped))),
    el('p', {
      class: 'store-note',
      text: 'Preview only: cosmetics are rendered in the launcher and are not applied in game.'
    })
  );
}

function renderDetail(root, ctx, item, equipped) {
  const url = skinUrlFor(ctx.state.data.activeAccount);
  const isEquipped = equipped.id === item.id;
  const stage = el('div', { class: 'preview-stage' }, buildScene(url, item, !view.onPlayer));
  const model = stage.querySelector('.mc-model');

  viewer = createViewer(model);
  viewer.attach(stage);
  viewer.start();

  root.append(
    el(
      'div',
      { class: 'store-detail' },
      el(
        'section',
        { class: `preview-card tone-${item.tone}` },
        el(
          'div',
          { class: 'preview-top' },
          el(
            'button',
            {
              class: 'back-btn',
              type: 'button',
              onclick: () => {
                viewer?.stop();
                view.mode = 'grid';
                redraw();
              }
            },
            icon('chevronLeft', 16),
            el('span', { text: 'Back to cosmetics' })
          ),
          el('span', { class: 'preview-crumb', text: `Cosmetics / ${item.slot}` })
        ),
        el('h2', { class: 'preview-title', text: 'Preview' }),
        stage,
        el(
          'div',
          { class: 'preview-foot' },
          el('span', { class: 'hint', text: 'Drag to rotate' }),
          el(
            'button',
            {
              class: 'ghost-btn',
              type: 'button',
              onclick: () => {
                view.onPlayer = !view.onPlayer;
                redraw();
              }
            },
            el('span', { text: view.onPlayer ? 'Preview cosmetic only' : 'Preview on player' })
          )
        )
      ),
      el(
        'aside',
        { class: 'detail-panel' },
        el('span', { class: 'store-meta', text: item.slot }),
        el('h2', { class: 'detail-title', text: item.name }),
        el('p', { class: 'detail-about', text: item.about }),
        el(
          'div',
          { class: 'info-box' },
          el('div', { class: 'info-row' }, el('span', { text: 'Rarity' }), el('b', { text: item.rarity })),
          el('div', { class: 'info-row' }, el('span', { text: 'Slot' }), el('b', { text: item.slot })),
          el('div', { class: 'info-row' }, el('span', { text: 'Applied' }), el('b', { text: 'Launcher preview only' }))
        ),
        el(
          'button',
          {
            class: `primary-btn${isEquipped ? ' is-on' : ''}`,
            type: 'button',
            disabled: isEquipped,
            onclick: async () => {
              if (isEquipped) return;
              try {
                await ctx.saveSettings({ cosmeticId: item.id });
                ctx.toast(`${item.name} equipped.`, 'success');
              } catch (err) {
                ctx.toast(err.message, 'error');
              }
            }
          },
          isEquipped ? icon('check', 18) : null,
          el('span', { text: isEquipped ? 'In your lineup' : 'Equip' })
        )
      )
    )
  );
}

function redraw() {
  if (lastRoot && lastCtx) render(lastRoot, lastCtx);
}

export function render(root, ctx) {
  viewer?.stop();
  viewer = null;
  lastRoot = root;
  lastCtx = ctx;
  root.innerHTML = '';

  const equipped = equippedItem(ctx);
  if (view.mode === 'detail') {
    const item = ITEMS.find((entry) => entry.id === view.id) || equipped;
    renderDetail(root, ctx, item, equipped);
    return;
  }
  renderGrid(root, ctx, equipped);
}

export function onState(root, ctx) {
  render(root, ctx);
}
