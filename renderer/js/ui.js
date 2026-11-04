import { icons } from './icons.js';

export function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = icons[name] || '';
  return svg;
}

function appendChildren(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && key !== 'type') {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

/** Sally cat mark: the head plus two separate eyes that blink now and then. */
export function logoMark(size = 0, className = '') {
  const wrap = el('span', { class: `logo-mark ${className}`.trim() });
  if (size) {
    wrap.style.width = `${size}px`;
    wrap.style.height = `${size}px`;
  }
  wrap.append(
    el('img', { class: 'logo-cat', src: 'assets/logo-cat.png', alt: 'SallyLauncher', draggable: false }),
    el('img', { class: 'logo-eye eye-left', src: 'assets/logo-eye-left.png', alt: '', draggable: false }),
    el('img', { class: 'logo-eye eye-right', src: 'assets/logo-eye-right.png', alt: '', draggable: false })
  );
  return wrap;
}

/**
 * Square player head cut straight out of the skin texture (face + hat layer),
 * so no external skin service is needed. Falls back to the initial letter.
 */
export function headAvatar(account, size = 48, className = '') {
  const name = account?.name || '?';
  if (!account?.skinUrl) {
    return el('span', {
      class: `avatar head-fallback ${className}`.trim(),
      style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` },
      text: name.slice(0, 1).toUpperCase()
    });
  }
  const unit = size / 8;
  const skinUrl = String(account.skinUrl).replace(/^http:\/\//, 'https://');
  const wrap = el('span', { class: `skin-head ${className}`.trim(), style: { width: `${size}px`, height: `${size}px` } });
  const layer = (offsetX) => {
    const node = el('span', { class: 'skin-layer' });
    node.style.backgroundImage = `url("${skinUrl}")`;
    node.style.backgroundSize = `${64 * unit}px ${64 * unit}px`;
    node.style.backgroundPosition = `${-offsetX * unit}px ${-8 * unit}px`;
    return node;
  };
  wrap.append(layer(8), layer(40));
  return wrap;
}

export function switchToggle(checked, onChange) {
  const btn = el('button', {
    class: `switch${checked ? ' on' : ''}`,
    type: 'button',
    title: checked ? 'Enabled' : 'Disabled'
  });
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const next = !btn.classList.contains('on');
    btn.classList.toggle('on', next);
    onChange(next);
  });
  return btn;
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const item = el('div', { class: `toast ${kind}`, text: String(message) });
  host.appendChild(item);
  setTimeout(() => {
    item.style.transition = 'opacity .25s ease, transform .25s ease';
    item.style.opacity = '0';
    item.style.transform = 'translateY(8px)';
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

export function formatMb(mb) {
  const value = Number(mb) || 0;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatVersionLabel(id) {
  return String(id || '—');
}

/** "2 h 14 m" style duration for playtime counters. */
export function formatPlaytime(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60000);
  if (minutes < 1) return total > 0 ? 'under a minute' : '0 m';
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days} d ${hours % 24} h`;
  if (hours >= 1) return `${hours} h ${minutes % 60} m`;
  return `${minutes} m`;
}

/** "3 days ago" / "Never played" for last played timestamps. */
export function formatAgo(iso) {
  const then = new Date(iso || 0).getTime();
  if (!Number.isFinite(then) || !then) return 'Never played';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'Just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** Splits "fabric-loader-0.20.1-26.3" or "1.20.1-forge-47.2.0" into loader and Minecraft version. */
export function versionInfo(versionId) {
  const id = String(versionId || '');
  const fabric = /^fabric-loader-([\d.]+)-(.+)$/i.exec(id);
  if (fabric) return { loader: 'Fabric', loaderVersion: fabric[1], minecraft: fabric[2], label: `Fabric ${fabric[2]}` };
  const forge = /^(.+)-forge-([\d.]+)$/i.exec(id);
  if (forge) return { loader: 'Forge', loaderVersion: forge[2], minecraft: forge[1], label: `Forge ${forge[1]}` };
  return { loader: 'Vanilla', loaderVersion: '', minecraft: id || '—', label: id || 'No version' };
}

/**
 * Animated theme switch: the new theme grows as a circle out of the control
 * that was clicked (Chromium View Transitions). Falls back to an instant
 * switch when the browser has no support or motion is reduced.
 */
let themeSwitching = false;

export function themeReveal(origin, mutate) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* a second click while the circle is still growing would stack two
     transitions, so it just applies the theme without the animation */
  if (typeof document.startViewTransition !== 'function' || reduce || themeSwitching) {
    mutate();
    return;
  }
  themeSwitching = true;
  const x = origin?.x ?? window.innerWidth - 64;
  const y = origin?.y ?? 46;
  const radius = Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) + 24);
  const transition = document.startViewTransition(() => {
    mutate();
  });
  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
          opacity: [0.78, 1],
          filter: ['blur(4px)', 'blur(0px)']
        },
        {
          duration: 650,
          easing: 'cubic-bezier(.16,.76,.24,1)',
          pseudoElement: '::view-transition-new(root)'
        }
      );
    })
    .catch(() => {});
  const done = () => {
    themeSwitching = false;
  };
  transition.finished.catch(() => {}).then(done);
  setTimeout(done, 720);
}
