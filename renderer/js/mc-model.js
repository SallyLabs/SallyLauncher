import { el } from './ui.js';

/**
 * Blocky Minecraft player model built from six CSS faces per body part.
 * Shared by the cosmetics store and the skin library.
 *
 * Skin pixels are drawn at `unit` screen pixels. The whole texture always maps
 * onto the 64x64 skin grid, so HD skins (128, 256, ...) need no extra scaling:
 * they are simply drawn at a higher sampling resolution.
 */
export const SKIN_TONE = '#b98a63';
export const SHIRT_TONE = '#2f8f8f';
export const PANTS_TONE = '#3b4170';

/** One texture region drawn onto one face. */
function faceStyle(url, [rx, ry, rw, rh], fw, fh, transform, left, top) {
  const sx = fw / rw;
  const sy = fh / rh;
  const style = { left: `${left}px`, top: `${top}px`, width: `${fw}px`, height: `${fh}px`, transform };
  if (url) {
    style.backgroundImage = `url("${url}")`;
    style.backgroundSize = `calc(64px * ${sx}) calc(64px * ${sy})`;
    style.backgroundPosition = `calc(${-rx * sx}px) calc(${-ry * sy}px)`;
  }
  return style;
}

export function createModelBuilder({ url = '', unit = 9, slim = false }) {
  const U = unit;
  /** Slim ("Alex") skins draw 3px wide arms instead of the classic 4px. */
  const armWidth = slim ? 3 : 4;

  /**
   * One textured cube. `u/v/w/h/d` is the texture region in skin pixels,
   * `bw/bh/bd` the (inflatable) box size, so overlay layers grow outwards
   * around the same centre.
   */
  const box = ({
    u = 0,
    v = 0,
    w = 1,
    h = 1,
    d = 1,
    bw = w,
    bh = h,
    bd = d,
    x = 0,
    y = 0,
    z = 0,
    cls = '',
    fallback = '',
    texture = '',
    url: faceUrl = url
  }) => {
    const W = bw * U;
    const H = bh * U;
    const D = bd * U;

    const part = el('div', {
      class: `mc-part ${cls}`.trim(),
      style: {
        left: `${(x - (bw - w) / 2) * U}px`,
        top: `${(y - (bh - h) / 2) * U}px`,
        width: `${W}px`,
        height: `${H}px`
      }
    });
    if (z) part.style.transform = `translateZ(${z * U}px)`;
    if (fallback) part.style.setProperty('--fb', fallback);
    if (texture) part.style.backgroundImage = texture;

    const faces = [
      ['f-front', [u + d, v + d, w, h], W, H, `translateZ(${D / 2}px)`, 0, 0],
      ['f-back', [u + w + 2 * d, v + d, w, h], W, H, `rotateY(180deg) translateZ(${D / 2}px)`, 0, 0],
      ['f-side-r', [u, v + d, d, h], D, H, `rotateY(-90deg) translateZ(${W / 2}px)`, (W - D) / 2, 0],
      ['f-side-l', [u + w + d, v + d, d, h], D, H, `rotateY(90deg) translateZ(${W / 2}px)`, (W - D) / 2, 0],
      ['f-top', [u + d, v, w, d], W, D, `rotateX(90deg) translateZ(${H / 2}px)`, 0, (H - D) / 2],
      ['f-bottom', [u + w + d, v, w, d], W, D, `rotateX(-90deg) translateZ(${H / 2}px)`, 0, (H - D) / 2]
    ];

    for (const [name, region, fw, fh, transform, left, top] of faces) {
      part.append(el('div', { class: `mc-face ${name}`, style: faceStyle(faceUrl, region, fw, fh, transform, left, top) }));
    }
    return part;
  };

  /** Limb wrapper: base skin box plus the slightly larger overlay layer. */
  const limb = ({ x, y, cls, base, sleeve, fallback, w = 4 }) => {
    const h = 12;
    const d = 4;
    const wrap = el('div', {
      class: `mc-limb ${cls}`,
      style: { left: `${x * U}px`, top: `${y * U}px`, width: `${w * U}px`, height: `${h * U}px` }
    });
    wrap.append(
      box({ u: base.u, v: base.v, w, h, d, cls: 'mc-skin', fallback }),
      box({ u: sleeve.u, v: sleeve.v, w, h, d, bw: w + 0.5, bh: h + 0.5, bd: d + 0.5, cls: 'mc-overlay' })
    );
    return wrap;
  };

  /** Full player: head (with extras), torso, both arms and both legs. */
  const player = ({ head = [], body = [] } = {}) => {
    const model = el('div', {
      class: 'mc-model',
      style: { width: `${16 * U}px`, height: `${32 * U}px` }
    });

    const headGroup = el('div', {
      class: 'mc-head-group',
      style: { left: `${4 * U}px`, top: '0px', width: `${8 * U}px`, height: `${8 * U}px` }
    });
    headGroup.append(
      box({ u: 0, v: 0, w: 8, h: 8, d: 8, cls: 'mc-head', fallback: SKIN_TONE }),
      box({ u: 32, v: 0, w: 8, h: 8, d: 8, bw: 9, bh: 9, bd: 9, cls: 'mc-hat' }),
      ...head
    );
    model.append(headGroup);

    model.append(
      box({ u: 16, v: 16, w: 8, h: 12, d: 4, x: 4, y: 8, cls: 'mc-body', fallback: SHIRT_TONE }),
      box({ u: 16, v: 32, w: 8, h: 12, d: 4, bw: 8.5, bh: 12.5, bd: 4.5, x: 4, y: 8, cls: 'mc-jacket' })
    );

    // the character's right arm sits on the left of the model
    model.append(
      limb({
        x: 4 - armWidth,
        y: 8,
        cls: 'mc-arm mc-arm-r',
        base: { u: 40, v: 16 },
        sleeve: { u: 40, v: 32 },
        fallback: SKIN_TONE,
        w: armWidth
      }),
      limb({
        x: 12,
        y: 8,
        cls: 'mc-arm mc-arm-l',
        base: { u: 32, v: 48 },
        sleeve: { u: 48, v: 48 },
        fallback: SKIN_TONE,
        w: armWidth
      }),
      limb({ x: 4, y: 20, cls: 'mc-leg', base: { u: 0, v: 16 }, sleeve: { u: 0, v: 32 }, fallback: PANTS_TONE }),
      limb({ x: 8, y: 20, cls: 'mc-leg', base: { u: 16, v: 48 }, sleeve: { u: 0, v: 48 }, fallback: PANTS_TONE }),
      ...body
    );

    return model;
  };

  return { box, limb, player, unit: U };
}

const sizeCache = new Map();

/** PNG data URLs carry their size in the IHDR header, so no loading is needed. */
function ratioFromPngDataUrl(url) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(url || ''));
  if (!match) return null;
  try {
    const header = atob(match[1].slice(0, 44));
    if (header.slice(12, 16) !== 'IHDR') return null;
    const width = ((header.charCodeAt(16) << 24) | (header.charCodeAt(17) << 16) | (header.charCodeAt(18) << 8) | header.charCodeAt(19)) >>> 0;
    const height = ((header.charCodeAt(20) << 24) | (header.charCodeAt(21) << 16) | (header.charCodeAt(22) << 8) | header.charCodeAt(23)) >>> 0;
    if (!width || !height) return null;
    return { width, height, ratio: Math.max(1, width / 64) };
  } catch {
    return null;
  }
}

/** Known texture size for a URL, if it can be determined without loading. */
export function skinInfoFor(url) {
  if (!url) return null;
  if (sizeCache.has(url)) return sizeCache.get(url);
  const parsed = ratioFromPngDataUrl(url);
  if (parsed) sizeCache.set(url, parsed);
  return parsed;
}

/**
 * Reports the texture size of a skin so callers can flag HD skins. Rendering
 * itself needs no extra scaling: every face maps the full 64x64 grid. Local
 * skins are known immediately from the PNG header.
 */
export function applySkinScale(root, url) {
  if (!url) return Promise.resolve(null);

  // HD textures are drawn from more texels than the face has pixels, so smooth
  // filtering looks better than the nearest-neighbour used for 64x64 skins.
  const mark = (info) => {
    root?.classList?.toggle('is-hd', Boolean(info && info.width > 64));
    return info;
  };

  const known = skinInfoFor(url);
  if (known) return Promise.resolve(mark(known));

  return new Promise((resolve) => {
    const image = new Image();
    const done = (width, height) => {
      const info = { width, height, ratio: Math.max(1, width / 64) };
      sizeCache.set(url, info);
      resolve(mark(info));
    };
    image.onload = () => done(image.naturalWidth || 64, image.naturalHeight || 64);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * Idle turn plus pointer drag. Dragging takes over and stays manual afterwards.
 */
export function createViewer(model) {
  const state = { yaw: -24, pitch: 4, phase: 0, dragging: false, dragged: false, handle: 0, last: 0 };
  const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let target = model;

  const apply = () => {
    target.style.transform = `rotateX(${state.pitch}deg) rotateY(${state.yaw}deg)`;
  };

  /** Swaps in a rebuilt model without losing the current rotation. */
  const setModel = (next) => {
    target = next;
    apply();
  };

  const stop = () => {
    if (state.handle) cancelAnimationFrame(state.handle);
    state.handle = 0;
  };

  const start = () => {
    stop();
    if (still()) {
      apply();
      return;
    }
    state.last = performance.now();
    const tick = (now) => {
      if (!target.isConnected) return;
      const delta = Math.min(64, now - state.last);
      state.last = now;
      if (!state.dragged) {
        state.phase += delta * 0.00016;
        state.yaw = -24 + Math.sin(state.phase) * 18;
      }
      apply();
      state.handle = requestAnimationFrame(tick);
    };
    apply();
    state.handle = requestAnimationFrame(tick);
  };

  const attach = (stage) => {
    let startX = 0;
    let startY = 0;
    let startYaw = 0;
    let startPitch = 0;

    stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      state.dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startYaw = state.yaw;
      startPitch = state.pitch;
      stage.classList.add('is-dragging');
      try {
        stage.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic or already released pointer */
      }
    });

    stage.addEventListener('pointermove', (event) => {
      if (!state.dragging) return;
      state.yaw = startYaw + (event.clientX - startX) * 0.5;
      state.pitch = Math.max(-14, Math.min(24, startPitch - (event.clientY - startY) * 0.3));
      state.dragged = true;
      apply();
    });

    const release = (event) => {
      if (!state.dragging) return;
      state.dragging = false;
      stage.classList.remove('is-dragging');
      try {
        stage.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer already gone */
      }
    };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);
  };

  return { apply, start, stop, attach, setModel };
}
