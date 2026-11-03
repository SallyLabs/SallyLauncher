import { el, icon, headAvatar, toast } from '../ui.js';

let ctxRef = null;
let timer = null;
let signIn = null;
const els = {};

function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(seconds) {
  stopTimer();
  timer = setTimeout(poll, Math.max(3, seconds) * 1000);
}

function setStatus(text, kind = 'info') {
  if (!els.status) return;
  els.status.className = `msa-status ${kind}`;
  els.status.innerHTML = '';
  if (kind === 'busy') els.status.appendChild(el('span', { class: 'spinner' }));
  els.status.appendChild(el('span', { text }));
}

async function poll() {
  const ctx = ctxRef;
  if (!ctx || !signIn) return;
  try {
    const result = await ctx.api.invoke('msa:poll', signIn.deviceCode);
    if (result.status === 'pending') {
      if (result.slowDown) signIn.interval += 5;
      setStatus('Waiting for you to confirm in the browser…', 'busy');
      schedule(signIn.interval);
      return;
    }
    setStatus(`Signed in as ${result.account.name}.`, 'ok');
    toast(`Microsoft account ${result.account.name} connected.`, 'success');
    signIn = null;
    stopTimer();
    await ctx.refresh();
  } catch (err) {
    signIn = null;
    stopTimer();
    setStatus(err.message, 'error');
    if (ctx) await ctx.refresh().catch(() => {});
  }
}

async function startSignIn(ctx) {
  try {
    setStatus('Requesting a sign-in code…', 'busy');
    const code = await ctx.api.invoke('msa:start');
    signIn = { ...code, interval: code.interval || 5 };
    await ctx.refresh();
    schedule(signIn.interval);
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function cancelSignIn(ctx) {
  if (signIn) ctx.api.invoke('msa:cancel', signIn.deviceCode).catch(() => {});
  signIn = null;
  stopTimer();
  ctx.refresh();
}

/* ------------------------------------------------------------ components */

function microsoftPanel(ctx) {
  const data = ctx.state.data;
  const clientId = data.settings.msaClientId || '';

  const panel = el(
    'div',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('span', { class: 'ic' }, icon('shield', 20)),
      el('span', { text: 'Microsoft account' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'tag green', text: 'Online ready' })
    )
  );

  if (signIn) {
    els.status = el('div', { class: 'msa-status busy' }, el('span', { class: 'spinner' }), el('span', { text: 'Waiting for you to confirm in the browser…' }));
    els.code = el('div', { class: 'msa-code', text: signIn.userCode });
    panel.append(
      el('div', { class: 'faint', style: { fontSize: '12.5px' }, text: 'Open the Microsoft page and enter this one-time code:' }),
      els.code,
      el(
        'div',
        { class: 'toolbar', style: { marginTop: '4px' } },
        el(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: () => ctx.api.invoke('system:openExternal', signIn.verificationUri || 'https://www.microsoft.com/link')
          },
          icon('external', 16),
          el('span', { text: 'Open microsoft.com/link' })
        ),
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(signIn.userCode);
                toast('Code copied.', 'success');
              } catch {
                toast('Could not copy the code.', 'error');
              }
            }
          },
          icon('copy', 16),
          el('span', { text: 'Copy code' })
        ),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => cancelSignIn(ctx) }, el('span', { text: 'Cancel' }))
      ),
      els.status,
      el('div', {
        class: 'setting-hint',
        style: { marginTop: '12px' },
        text: 'After signing in you can join online servers with your real Minecraft profile, skin and cape.'
      })
    );
    return panel;
  }

  els.status = null;
  const idInput = el('input', {
    type: 'text',
    value: clientId,
    placeholder: 'optional – Azure app client id',
    style: { width: '100%' }
  });

  panel.append(
    el('div', {
      class: 'faint',
      style: { fontSize: '12.5px', lineHeight: '1.5' },
      text: 'Sign in with the Microsoft account that owns Minecraft: Java Edition. Uses the device code flow – no password ever reaches the launcher.'
    }),
    el(
      'div',
      { class: 'toolbar', style: { marginTop: '16px', marginBottom: '0' } },
      el('button', { class: 'btn primary', type: 'button', onclick: () => startSignIn(ctx) }, icon('user', 17), el('span', { text: 'Sign in with Microsoft' }))
    ),
    el(
      'details',
      { class: 'msa-advanced' },
      el('summary', { text: 'Advanced: app client id' }),
      el('div', {
        class: 'setting-hint',
        text: 'Minecraft only accepts app ids Mojang approved. Leave empty to use the built-in one; if Minecraft answers 403, register an app and paste its id here.'
      }),
      el(
        'div',
        { class: 'toolbar', style: { marginTop: '10px', marginBottom: '0' } },
        idInput,
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              await ctx.api.invoke('accounts:setClientId', idInput.value);
              toast('Client id saved.', 'success');
              await ctx.refresh();
            }
          },
          el('span', { text: 'Save' })
        )
      )
    )
  );
  return panel;
}

function activePanel(ctx) {
  const active = ctx.state.data.activeAccount;
  const isMsa = active?.type === 'msa';
  const panel = el(
    'div',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('span', { class: 'ic' }, icon('user', 20)),
      el('span', { text: 'Active account' }),
      el('span', { class: 'spacer' }),
      el('span', { class: `tag ${isMsa ? 'green' : ''}`, text: isMsa ? 'Microsoft' : 'Offline' })
    )
  );

  panel.append(      el(
      'div',
      { class: 'row', style: { padding: '0' } },
      headAvatar(active, 56, 'lg'),
      el(
        'div',
        { class: 'row-main' },
        el('div', { class: 'row-title' }, el('span', { text: active?.name || 'No account' })),
        el('div', {
          class: 'row-sub',
          text: isMsa ? 'Owns Minecraft: Java Edition · online servers work' : 'Offline account'
        })
      )
    ),
    el(
      'div',
      { style: { marginTop: '18px' } },
      el('div', { class: 'kv' }, el('span', { text: 'UUID' }), el('b', { class: 'mono', text: active?.uuid || '—' })),
      el('div', { class: 'kv' }, el('span', { text: 'Session' }), el('b', { text: isMsa ? 'Microsoft / Xbox Live' : 'Offline' }))
    )
  );

  if (isMsa) {
    panel.appendChild(
      el(
        'div',
        { class: 'toolbar', style: { marginTop: '16px', marginBottom: '0' } },
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              try {
                await ctx.api.invoke('accounts:refresh', active.id);
                toast('Microsoft session refreshed.', 'success');
                await ctx.refresh();
              } catch (err) {
                toast(err.message, 'error');
              }
            }
          },
          icon('refresh', 16),
          el('span', { text: 'Refresh session' })
        )
      )
    );
  }
  return panel;
}

function accountRow(ctx, account, data) {
  const isActive = account.id === data.activeAccountId;
  return    el(
      'div',
      { class: 'row' },
      headAvatar(account, 40),
    el(
      'div',
      { class: 'row-main' },
      el(
        'div',
        { class: 'row-title' },
        el('span', { text: account.name }),
        account.type === 'msa' ? el('span', { class: 'tag green', text: 'Microsoft' }) : el('span', { class: 'tag', text: 'Offline' }),
        isActive ? el('span', { class: 'tag accent', text: 'Active' }) : null
      ),
      el('div', { class: 'row-sub mono', text: account.uuid || '' })
    ),
    el(
      'div',
      { class: 'row-actions' },
      isActive
        ? null
        : el(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                await ctx.api.invoke('accounts:select', account.id);
                await ctx.refresh();
              }
            },
            icon('check', 16),
            el('span', { text: 'Use' })
          ),
      el(
        'button',
        {
          class: 'square-btn',
          type: 'button',
          title: 'Remove account',
          onclick: async () => {
            await ctx.api.invoke('accounts:remove', account.id);
            await ctx.refresh();
            toast(`Removed ${account.name}`, 'info');
          }
        },
        icon('trash', 18)
      )
    )
  );
}

function offlinePanel(ctx) {
  const input = el('input', { type: 'text', maxLength: 16, placeholder: 'Username (3–16 characters)', style: { width: '220px' } });
  const add = async () => {
    const value = input.value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) {
      toast('Use 3–16 letters, numbers or underscores.', 'error');
      return;
    }
    await ctx.api.invoke('accounts:add', value);
    input.value = '';
    await ctx.refresh();
    toast(`${value} added.`, 'success');
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') add();
  });

  return el(
    'div',
    { class: 'panel', style: { marginTop: '18px' } },
    el('div', { class: 'panel-head' }, el('span', { class: 'ic' }, icon('plus', 20)), el('span', { text: 'Offline account' })),
    el(
      'div',
      { class: 'toolbar', style: { marginBottom: '0' } },
      input,
      el('button', { class: 'btn', type: 'button', onclick: add }, el('span', { text: 'Add account' }))
    ),
    el('div', {
      class: 'setting-hint',
      style: { marginTop: '12px' },
      text: 'For singleplayer and offline-mode servers.'
    })
  );
}

/* ---------------------------------------------------------------- section */

/** Panels for the Accounts section of the Settings page. */
export function panels(ctx) {
  ctxRef = ctx;
  const data = ctx.state.data;
  const accounts = data.accounts || [];

  return [
    el('div', { class: 'grid-2' }, microsoftPanel(ctx), activePanel(ctx)),
    el(
      'div',
      { class: 'panel' },
      el(
        'div',
        { class: 'panel-head' },
        el('span', { class: 'ic' }, icon('shield', 20)),
        el('span', { text: 'Saved accounts' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'faint', text: `${accounts.length} total` })
      ),
      el('div', { class: 'list' }, ...(accounts.length ? accounts.map((account) => accountRow(ctx, account, data)) : [el('div', { class: 'empty', text: 'No accounts yet.' })]))
    ),
    offlinePanel(ctx)
  ];
}

/** Stops a running device-code poll (called when the section is left). */
export function onLeave() {
  stopTimer();
}
