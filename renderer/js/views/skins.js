import { el, icon } from '../ui.js';
import { createModelBuilder, createViewer, applySkinScale, skinInfoFor, skinOrDefault, prepareSkin } from '../mc-model.js';

/** Big preview and the small library thumbnails use different pixel sizes. */
const PREVIEW_UNIT = 9;
const THUMB_UNIT = 4.5;

const DEFAULT_SKINS = [
  { id: 'steve', name: 'Steve', url: 'https://mc-heads.net/skin/Steve', builtin: true, tag: 'Default' },
  { id: 'alex', name: 'Alex', url: 'https://mc-heads.net/skin/Alex', builtin: true, tag: 'Default' }
];

let viewer = null;
let cleanup = null;
let editorLayer = null;
const ui = { savedOpen: true, defaultsOpen: false, editing: false };

function accountSkinUrl(account) {
  if (account?.skinUrl) return String(account.skinUrl).replace(/^http:\/\//, 'https://');
  return `https://mc-heads.net/skin/${encodeURIComponent(account?.name || 'Steve')}`;
}

function libraryOf(settings) {
  return Array.isArray(settings?.skinLibrary) ? settings.skinLibrary.filter((entry) => entry?.url) : [];
}

function modelFor(url, unit, slim = false) {
  const builder = createModelBuilder({ url, unit, slim });
  const model = builder.player();
  applySkinScale(model, url);
  return model;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(url) {
  return new Promise((resolve) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => resolve(null);
    node.src = url;
  });
}

/** Mojang only takes 64×64 / 64×32, so HD skins are resampled down first. */
async function minecraftSkinOf(url) {
  const source = /^data:/i.test(url) ? url : await window.sally.invoke('skins:fetch', url);
  const image = await loadImage(source);
  if (!image) throw new Error('That skin could not be loaded.');
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error('That skin could not be loaded.');

  const targetHeight = height * 2 === width ? 32 : 64;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, width, height, 0, 0, 64, targetHeight);
  return canvas.toDataURL('image/png');
}

/** Hides the Electron wrapper that IPC errors carry. */
function errorText(err) {
  return String(err?.message || err)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function imageSize(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
}

/** Classic 64x64/64x32 and any square multiple of 64 (HD skins). */
function isSkinSize({ width, height }) {
  if (!width || !height) return false;
  if (width === 64 && (height === 64 || height === 32)) return true;
  return width === height && width % 64 === 0;
}

/**
 * Re-encodes the PNG at its own size (capped) so no oversized file ends up in
 * the settings file and odd PNG headers get normalised.
 */
async function normalizeSkin(url) {
  const image = await new Promise((resolve) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => resolve(null);
    node.src = url;
  });
  if (!image) return null;

  const size = { width: image.naturalWidth, height: image.naturalHeight };
  if (!isSkinSize(size)) return null;

  const cap = 512;
  const scale = Math.min(1, cap / size.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

/* ---------------------------------------------------------------- cards -- */

function thumbFor(entry) {
  return el('div', { class: 'skin-thumb' }, modelFor(entry.url, THUMB_UNIT, Boolean(entry.slim)));
}

function selectionCard(entry, { activeId, ctx, library = [], onPick = null, onSelected = null }) {
  const active = entry.id === activeId;

  const card = el(
    'button',
    {
      class: `skin-card${active ? ' is-active' : ''}`,
      type: 'button',
      title: entry.name,
      onclick: async () => {
        if (onPick) {
          await onPick(entry);
          return;
        }
        try {
          await ctx.saveSettings({ skinId: entry.id });
          ctx.refreshView();
          if (onSelected) await onSelected(entry);
        } catch (err) {
          ctx.toast(errorText(err), 'error');
        }
      }
    },
    thumbFor(entry),
    el(
      'span',
      { class: 'skin-card-copy' },
      el('span', { class: 'skin-card-name', text: entry.name }),
      el('span', { class: 'skin-card-tag', text: entry.tag || (entry.builtin ? 'Your account' : entry.slim ? 'Slim' : 'Classic') })
    ),
    active ? el('span', { class: 'skin-card-check' }, icon('check', 14)) : null
  );

  if (entry.builtin) return el('div', { class: 'skin-card-wrap' }, card);

  return el(
    'div',
    { class: 'skin-card-wrap' },
    card,
    el(
      'button',
      {
        class: 'skin-remove',
        type: 'button',
        title: `Remove ${entry.name}`,
        onclick: async (event) => {
          event.stopPropagation();
          try {
            await ctx.saveSettings({
              skinLibrary: library.filter((item) => item.id !== entry.id),
              ...(activeId === entry.id ? { skinId: 'account' } : {})
            });
            ctx.refreshView();
            ctx.toast(`${entry.name} removed.`, 'success');
          } catch (err) {
            ctx.toast(err.message, 'error');
          }
        }
      },
      icon('close', 13)
    )
  );
}

function sectionHead(title, count, open, onToggle) {
  return el(
    'button',
    {
      class: `skin-section-head${open ? ' is-open' : ''}`,
      type: 'button',
      onclick: onToggle
    },
    el('span', { class: 'skin-chev' }, icon('chevronRight', 16)),
    el('span', { text: title }),
    el('span', { class: 'skin-section-count', text: String(count) })
  );
}

/* --------------------------------------------------------------- render -- */

export function render(root, ctx) {
  viewer?.stop();
  viewer = null;
  cleanup?.();
  cleanup = null;
  ui.editing = false;
  root.innerHTML = '';

  const settings = ctx.state.data.settings;
  const account = ctx.state.data.activeAccount;
  const library = libraryOf(settings);
  const rawEntries = [
    {
      id: 'account',
      name: account?.name || 'Steve',
      url: accountSkinUrl(account),
      slim: String(account?.skinVariant || '').toUpperCase() === 'SLIM',
      builtin: true
    },
    ...library
  ];
  // legacy 64x32 skins are rewritten to the 64x64 grid before they are drawn
  const entries = rawEntries.map((entry) => ({ ...entry, url: skinOrDefault(entry.url) }));
  const activeId = settings.skinId || 'account';
  const active = entries.find((entry) => entry.id === activeId) || entries[0];

  /** Selecting a skin also uploads it to the Minecraft profile. */
  const applySkin = async (entry) => {
    if (!account || account.type !== 'msa') return;
    if (entry.id === 'account') return;
    try {
      const image = await minecraftSkinOf(entry.url);
      const result = await window.sally.invoke('skins:apply', { image, slim: Boolean(entry.slim) });
      ctx.toast(`Skin applied to ${result.name}.`, 'success');
    } catch (err) {
      ctx.toast(errorText(err), 'error');
    }
  };

  /* ---- import ----------------------------------------------------------- */

  const fileInput = el('input', { type: 'file', accept: 'image/png', style: { display: 'none' } });

  const importFile = async (file) => {
    try {
      const dataUrl = await readAsDataUrl(file);
      const skin = await normalizeSkin(dataUrl);
      if (!skin) {
        const size = await imageSize(dataUrl);
        ctx.toast(`Not a skin file: ${size.width}×${size.height}. Use 64×64, 64×32 or an HD size.`, 'error');
        return;
      }

      const name = file.name.replace(/\.png$/i, '').slice(0, 40) || 'New skin';
      const entry = { id: `skin-${Date.now().toString(36)}`, name, url: skin.url, slim: false };
      await ctx.saveSettings({ skinLibrary: [...library, entry], skinId: entry.id });
      ctx.refreshView();
      ctx.toast(`${entry.name} added to your library.`, 'success');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await importFile(file);
  });

  const importFromUrl = async (url, name) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${name} could not be downloaded.`);
      const skin = await normalizeSkin(await readAsDataUrl(await response.blob()));
      if (!skin) throw new Error(`${name} is not a usable skin file.`);
      const entry = { id: `skin-${Date.now().toString(36)}`, name, url: skin.url, slim: false };
      await ctx.saveSettings({ skinLibrary: [...library, entry], skinId: entry.id });
      ctx.refreshView();
      ctx.toast(`${name} added to your library.`, 'success');
      return entry;
    } catch (err) {
      ctx.toast(err.message || 'That skin could not be loaded.', 'error');
      return null;
    }
  };

  const pickFile = () => fileInput.click();

  /* ---- drag & drop ------------------------------------------------------ */

  const dropZone = el('div', { class: 'skin-dropzone' });

  const dropHandler = new AbortController();
  cleanup = () => {
    dropHandler.abort();
    editorLayer?.remove();
    editorLayer = null;
  };
  const signal = dropHandler.signal;

  root.addEventListener(
    'dragover',
    (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      dropZone.classList.add('is-over');
    },
    { signal }
  );
  root.addEventListener(
    'dragleave',
    (event) => {
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      dropZone.classList.remove('is-over');
    },
    { signal }
  );
  root.addEventListener(
    'drop',
    (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      dropZone.classList.remove('is-over');
      // Dropping always adds a skin; renaming and the arm model live in "Edit skin".
      importFile(event.dataTransfer.files[0]);
    },
    { signal }
  );

  /* ---- big preview ------------------------------------------------------ */

  const stage = el('div', { class: 'skin-stage' });
  const scene = el('div', { class: 'mc-scene', style: { width: `${16 * PREVIEW_UNIT}px`, height: `${32 * PREVIEW_UNIT}px` } });
  const model = modelFor(active.url, PREVIEW_UNIT, Boolean(active.slim));
  scene.append(model);
  stage.append(scene);

  viewer = createViewer(model);
  viewer.attach(stage);
  viewer.start();

  /** Rebuilds the preview model, e.g. when switching between classic and slim. */
  const rebuildPreview = (slim) => {
    const next = modelFor(active.url, PREVIEW_UNIT, slim);
    scene.replaceChildren(next);
    viewer?.setModel(next);
  };

  const hd = el('span', { class: 'tag hd', text: 'HD' });
  hd.style.display = 'none';
  const known = skinInfoFor(active.url);
  if (known) {
    if (known.width > 64) hd.style.display = '';
  } else {
    applySkinScale(model, active.url).then((info) => {
      if (info && info.width > 64) hd.style.display = '';
    });
  }

  /* ---- edit panel ------------------------------------------------------- */

  let draftSlim = Boolean(active.slim);

  const nameInput = el('input', {
    class: 'skin-editor-input',
    type: 'text',
    maxlength: '40',
    placeholder: 'Skin name',
    value: active.name
  });

  const classicBtn = el(
    'button',
    { class: 'skin-seg-btn', type: 'button', onclick: () => setSeg(false) },
    el('span', { class: 'skin-seg-name', text: 'Classic' }),
    el('span', { class: 'skin-seg-sub', text: '4px arms' })
  );

  const slimBtn = el(
    'button',
    { class: 'skin-seg-btn', type: 'button', onclick: () => setSeg(true) },
    el('span', { class: 'skin-seg-name', text: 'Slim' }),
    el('span', { class: 'skin-seg-sub', text: '3px arms' })
  );

  /** @param {{ preview?: boolean }} options */
  function setSeg(slim, { preview = true } = {}) {
    draftSlim = slim;
    classicBtn.classList.toggle('is-on', !slim);
    slimBtn.classList.toggle('is-on', slim);
    if (preview) rebuildPreview(slim);
  }

  const panel = el(
    'div',
    { class: 'skin-editor', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'skin-editor-title', text: active.builtin ? 'Save this skin' : 'Skin settings' }),
    el(
      'label',
      { class: 'skin-editor-field' },
      el('span', { class: 'skin-editor-label', text: 'Name' }),
      nameInput
    ),
    el(
      'div',
      { class: 'skin-editor-field' },
      el('span', { class: 'skin-editor-label', text: 'Arm model' }),
      el('div', { class: 'skin-seg' }, classicBtn, slimBtn)
    ),
    el(
      'div',
      { class: 'skin-editor-actions' },
      active.builtin
        ? null
        : el(
            'button',
            { class: 'btn skin-editor-delete', type: 'button', onclick: () => requestDelete() },
            icon('trash', 15),
            el('span', { text: 'Delete' })
          ),
      el('button', { class: 'btn', type: 'button', onclick: () => closeEditor() }, el('span', { text: 'Cancel' })),
      el(
        'button',
        { class: 'btn primary', type: 'button', onclick: () => saveEditor() },
        icon('check', 15),
        el('span', { text: 'Save' })
      )
    )
  );

  // The editor only covers the right column, so the model preview stays visible.
  editorLayer = el(
    'div',
    { class: 'skin-editor-layer' },
    el('div', { class: 'skin-editor-backdrop', onclick: () => closeEditor() }),
    panel
  );

  setSeg(draftSlim, { preview: false });

  /** Two-step delete, so a single stray click cannot drop a skin. */
  let confirmTimer = 0;
  const deleteBtn = panel.querySelector('.skin-editor-delete');

  const resetDelete = () => {
    window.clearTimeout(confirmTimer);
    deleteBtn?.classList.remove('is-confirm');
    if (deleteBtn) deleteBtn.lastElementChild.textContent = 'Delete';
  };

  const requestDelete = () => {
    if (!deleteBtn || active.builtin) return;
    if (!deleteBtn.classList.contains('is-confirm')) {
      deleteBtn.classList.add('is-confirm');
      deleteBtn.lastElementChild.textContent = 'Delete? Click again';
      confirmTimer = window.setTimeout(resetDelete, 3500);
      return;
    }
    resetDelete();
    deleteActive();
  };

  const deleteActive = async () => {
    try {
      await ctx.saveSettings({
        skinLibrary: library.filter((item) => item.id !== active.id),
        ...(activeId === active.id ? { skinId: 'account' } : {})
      });
      ui.editing = false;
      ctx.refreshView();
      ctx.toast(`${active.name} deleted.`, 'success');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };

  const openEditor = () => {
    ui.editing = true;
    nameInput.value = active.name;
    setSeg(Boolean(active.slim), { preview: false });
    editorLayer?.classList.add('is-open');
    nameInput.focus();
    nameInput.select();
  };

  const closeEditor = () => {
    ui.editing = false;
    resetDelete();
    editorLayer?.classList.remove('is-open');
    if (draftSlim !== Boolean(active.slim)) rebuildPreview(Boolean(active.slim));
  };

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && ui.editing) {
        event.preventDefault();
        closeEditor();
      }
      if (event.key === 'Enter' && ui.editing && event.target === nameInput) {
        event.preventDefault();
        saveEditor();
      }
    },
    { signal }
  );

  const toggleEditor = () => (ui.editing ? closeEditor() : openEditor());

  const saveEditor = async () => {
    const name = nameInput.value.trim().slice(0, 40) || 'New skin';
    let saved = null;
    try {
      if (active.builtin) {
        const entry = { id: `skin-${Date.now().toString(36)}`, name, url: active.url, slim: draftSlim };
        await ctx.saveSettings({ skinLibrary: [...library, entry], skinId: entry.id });
        ctx.toast(`${name} saved to your library.`, 'success');
        saved = entry;
      } else {
        const next = library.map((item) => (item.id === active.id ? { ...item, name, slim: draftSlim } : item));
        await ctx.saveSettings({ skinLibrary: next });
        ctx.toast(`${name} updated.`, 'success');
        saved = { ...active, name, slim: draftSlim };
      }
      ui.editing = false;
      ctx.refreshView();
      // Renaming alone stays local; a changed skin or arm model goes to Mojang.
      if (saved && (saved.url !== active.url || Boolean(saved.slim) !== Boolean(active.slim))) {
        await applySkin(saved);
      }
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };

  /* ---- saved skins ------------------------------------------------------ */

  const token = (ui.token = (ui.token || 0) + 1);
  const savedCards = entries.map((entry) => ({
    entry,
    node: selectionCard(entry, { activeId: active.id, ctx, library, onSelected: applySkin })
  }));

  /**
   * A saved skin that is pixel-identical to the one you are wearing is
   * redundant: the account card already shows it, so those cards stay hidden
   * and only come back once you wear something else.
   */
  const hideWornCopies = async () => {
    if (!account?.skinUrl) return;
    let worn = null;
    try {
      worn = await minecraftSkinOf(accountSkinUrl(account));
    } catch {
      return;
    }
    if (!worn || ui.token !== token) return;

    const copies = [];
    for (const card of savedCards) {
      if (card.entry.builtin) continue;
      let signature = null;
      try {
        signature = await minecraftSkinOf(card.entry.url);
      } catch {
        signature = null;
      }
      if (signature === worn) copies.push(card);
    }
    if (!copies.length || ui.token !== token) return;

    for (const { node } of copies) {
      node.classList.add('is-worn-copy');
      const button = node.querySelector('.skin-card');
      button?.classList.remove('is-active');
      button?.querySelector('.skin-card-check')?.remove();
    }

    // The worn skin is still reachable through the account card.
    if (copies.some(({ entry }) => entry.id === active.id)) {
      const accountButton = savedCards[0]?.node.querySelector('.skin-card');
      if (accountButton && !accountButton.classList.contains('is-active')) {
        accountButton.classList.add('is-active');
        accountButton.append(el('span', { class: 'skin-card-check' }, icon('check', 14)));
      }
    }

    const remaining = entries.length - copies.length;
    const count = savedHead.querySelector('.skin-section-count');
    if (count) count.textContent = String(remaining);
    const chip = totalChip.lastElementChild;
    if (chip) chip.textContent = `${remaining} skins`;
  };

  const savedGrid = el(
    'div',
    { class: 'skin-grid' },
    el(
      'div',
      { class: 'skin-card-wrap' },
      el(
        'button',
        { class: 'skin-card skin-add', type: 'button', onclick: () => pickFile() },
        el('span', { class: 'skin-add-icon' }, icon('plus', 20)),
        el(
          'span',
          { class: 'skin-card-copy skin-add-copy' },
          el('span', { class: 'skin-card-name', text: 'Add skin' }),
          el('span', { class: 'skin-card-tag', text: 'Drag and drop' })
        )
      )
    ),
    ...savedCards.map((card) => card.node)
  );

  const savedHead = sectionHead('Saved skins', entries.length, ui.savedOpen, () => {
    ui.savedOpen = !ui.savedOpen;
    ctx.refreshView();
  });

  /* ---- default skins ---------------------------------------------------- */

  const defaultsBody = el('div', { class: 'skin-grid' });
  if (ui.defaultsOpen) {
    DEFAULT_SKINS.forEach((skin) => {
      defaultsBody.append(
        selectionCard(skin, {
          activeId: null,
          ctx,
          onPick: async (item) => {
            const created = await importFromUrl(item.url, item.name);
            if (created) await applySkin(created);
          }
        })
      );
    });
  }

  const defaultsHead = sectionHead('Default skins', DEFAULT_SKINS.length, ui.defaultsOpen, () => {
    ui.defaultsOpen = !ui.defaultsOpen;
    ctx.refreshView();
  });

  /* ---- assemble --------------------------------------------------------- */

  const totalChip = el(
    'span',
    { class: 'chip' },
    icon('layers', 16),
    el('span', { text: `${entries.length} skins` })
  );

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: 'Skins' })
      ),
      el(
        'div',
        { class: 'head-actions' },
        totalChip,
        el(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => pickFile() },
          icon('plus', 16),
          el('span', { text: 'Add skin' })
        )
      )
    ),
    el(
      'div',
      { class: 'skin-layout' },
      el(
        'div',
        { class: 'skin-side' },
        el(
          'div',
          { class: 'skin-nameplate' },
          el('span', { class: 'skin-nameplate-name', text: active.name }),
          hd
        ),
        stage,
        el(
          'div',
          { class: 'skin-side-foot' },
          el('span', { class: 'skin-drag' }, icon('expand', 14), el('span', { text: 'Drag to rotate' })),
          el(
            'button',
            { class: 'btn', type: 'button', onclick: toggleEditor },
            icon('sparkles', 15),
            el('span', { text: 'Edit skin' })
          )
        )
      ),
      el(
        'div',
        { class: 'skin-saved' },
        savedHead,
        ui.savedOpen ? savedGrid : null,
        defaultsHead,
        ui.defaultsOpen ? defaultsBody : null,
        editorLayer,
        el('p', {
          class: 'skin-note',
          text:
            account?.type === 'msa'
              ? 'PNG only: 64×64, 64×32 or HD sizes like 128×128 and 256×256. Picking a skin uploads it to your Minecraft profile (HD skins are scaled to 64×64).'
              : 'PNG only: 64×64, 64×32 or HD sizes like 128×128 and 256×256. Sign in with Microsoft to apply skins to your Minecraft profile.'
        })
      )
    ),
    dropZone,
    fileInput
  );

  Promise.all(rawEntries.map((entry) => prepareSkin(entry.url))).then((urls) => {
    if (urls.some((url, index) => url !== rawEntries[index].url) && root.isConnected) ctx.refreshView();
  });

  hideWornCopies();
}

export function onState(root, ctx) {
  render(root, ctx);
}
