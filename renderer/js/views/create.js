import { el, icon, toast } from '../ui.js';

/**
 * Modrinth-style instance dialog: pick a Minecraft version and a loader,
 * everything else (folder, Java, memory) has sane defaults.
 */

let layer = null;

function close() {
  if (!layer) return;
  layer.remove();
  layer = null;
  document.removeEventListener('keydown', onKey, true);
}

function onKey(event) {
  if (event.key === 'Escape') close();
}

const LOADERS = [
  { id: 'fabric', label: 'Fabric', hint: 'Light, fast updates' },
  { id: 'forge', label: 'Forge', hint: 'Classic mods' },
  { id: 'vanilla', label: 'Vanilla', hint: 'No mods' }
];

export function openCreate(ctx, { onDone } = {}) {
  if (layer) return;
  const data = ctx.state.data;
  const installed = ctx.state.versions?.installed || [];
  const available = ctx.state.versions?.available || [];
  const releases = available.filter((version) => version.type === 'release');
  if (!ctx.state.versions) ctx.loadVersions();

  const options = releases.length
    ? releases
    : installed.map((version) => ({ id: version.id, type: 'release' }));
  const first = data.selectedVersion || data.activeProfile?.versionId || options[0]?.id || '';

  let loader = data.activeProfile?.loader || 'fabric';
  let loaderVersion = '';
  let nameTouched = false;

  const name = el('input', { type: 'text', placeholder: 'My instance', spellcheck: false, value: '' });
  const version = el(
    'select',
    {},
    ...options.map((entry) => el('option', { value: entry.id, text: entry.id, selected: entry.id === first }))
  );
  if (!options.length) version.appendChild(el('option', { value: '', text: 'No versions available yet' }));

  const loaderVersionSelect = el('select', {}, el('option', { value: '', text: 'Recommended' }));
  const loaderVersionField = el(
    'label',
    {},
    el('span', { class: 'ci-label', text: 'Loader version' }),
    loaderVersionSelect
  );

  const mcOf = (id) => {
    const value = String(id || '');
    const fabric = /^fabric-loader-[^-]+-(.+)$/i.exec(value);
    if (fabric) return fabric[1];
    const forge = /^(.+?)-forge-.+$/i.exec(value);
    if (forge) return forge[1];
    return value;
  };

  const suggestName = () => {
    if (nameTouched) return;
    const label = LOADERS.find((entry) => entry.id === loader)?.label || 'Vanilla';
    name.value = loader === 'vanilla' ? `Minecraft ${version.value}` : `${label} ${version.value}`.trim();
  };

  let request = 0;
  const fillLoaderVersions = async () => {
    loaderVersionField.style.display = loader === 'vanilla' ? 'none' : '';
    loaderVersionSelect.replaceChildren(el('option', { value: '', text: 'Recommended' }));
    loaderVersion = '';
    const mc = mcOf(version.value);
    const id = ++request;
    if (!mc || loader === 'vanilla') return;
    try {
      const result = await ctx.api.invoke('loaders:versions', { loader, mcVersion: mc });
      if (id !== request) return;
      const entries = result?.versions || [];
      loaderVersionSelect.replaceChildren(el('option', { value: '', text: 'Recommended' }));
      for (const entry of entries) {
        loaderVersionSelect.appendChild(
          el('option', { value: entry.version, text: `${entry.version}${entry.stable ? ' · stable' : ''}` })
        );
      }
    } catch {
      /* loader list is optional – the recommended one still installs */
    }
  };

  const loaderButtons = LOADERS.map((entry) =>
    el(
      'button',
      {
        class: `ci-loader${entry.id === loader ? ' is-active' : ''}`,
        type: 'button',
        onclick: (event) => {
          loader = entry.id;
          event.currentTarget.parentElement
            .querySelectorAll('.ci-loader')
            .forEach((node) => node.classList.remove('is-active'));
          event.currentTarget.classList.add('is-active');
          fillLoaderVersions();
          suggestName();
        }
      },
      el('b', { text: entry.label }),
      el('span', { text: entry.hint })
    )
  );

  name.addEventListener('input', () => {
    nameTouched = name.value.trim().length > 0;
  });
  version.addEventListener('change', () => {
    fillLoaderVersions();
    suggestName();
  });
  loaderVersionSelect.addEventListener('change', () => {
    loaderVersion = loaderVersionSelect.value;
  });

  const create = async (button) => {
    const payload = {
      name: name.value.trim() || `${version.value} instance`,
      versionId: version.value || null,
      loader,
      loaderVersion,
      memoryMb: data.activeProfile?.memoryMb || data.settings.memoryMb || 4096
    };
    button.disabled = true;
    try {
      const profile = await ctx.api.invoke('profiles:create', payload);
      close();
      await ctx.refresh();
      toast(`${payload.name} created.`, 'success');
      onDone?.();
      if (profile?.id && payload.versionId) {
        ctx.api
          .invoke('versions:install', profile.id)
          .catch((err) => toast(err.message, 'error'));
      }
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'error');
    }
  };

  const createButton = el(
    'button',
    { class: 'btn primary', type: 'button', onclick: () => create(createButton) },
    icon('plus', 16),
    el('span', { text: 'Create instance' })
  );

  layer = el(
    'div',
    {
      class: 'mod-modal-layer',
      onclick: (event) => {
        if (event.target.classList.contains('mod-modal-layer')) close();
      }
    },
    el(
      'div',
      { class: 'mod-modal ci-modal', role: 'dialog', 'aria-modal': 'true' },
      el(
        'div',
        { class: 'mod-modal-head' },
        el('span', { text: 'New instance' }),
        el('button', { class: 'mod-btn', type: 'button', onclick: close }, icon('close', 16))
      ),
      el(
        'div',
        { class: 'mod-modal-body' },
        el(
          'div',
          { class: 'ci-body' },
          el('label', {}, el('span', { class: 'ci-label', text: 'Name' }), name),
          el('label', {}, el('span', { class: 'ci-label', text: 'Minecraft version' }), version),
          el(
            'div',
            {},
            el('span', { class: 'ci-label', text: 'Loader' }),
            el('div', { class: 'ci-loaders' }, ...loaderButtons)
          ),
          loaderVersionField
        )
      ),
      el(
        'div',
        { class: 'mod-modal-foot' },
        el(
          'div',
          { class: 'ci-foot', style: { width: '100%' } },
          el('span', { class: 'faint', text: 'Own folder, own mods' }),
          el('div', { style: { flex: '1' } }),
          el('button', { class: 'btn ghost', type: 'button', onclick: close }, el('span', { text: 'Cancel' })),
          createButton
        )
      )
    )
  );

  document.body.appendChild(layer);
  document.addEventListener('keydown', onKey, true);
  fillLoaderVersions();
  suggestName();
  setTimeout(() => name.focus(), 30);
}
