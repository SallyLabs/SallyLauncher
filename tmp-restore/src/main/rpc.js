'use strict';

/**
 * Discord Rich Presence ("Playing SallyLauncher" in a Discord profile).
 *
 * Discord matches a local process to an application by its application ID.
 * SallyLauncher reads that public ID from the shipped .env file; each user's
 * preference to enable or disable presence is stored separately.
 */

const { Client } = require('@xhayper/discord-rpc');

const GITHUB_URL = 'https://github.com/SallyLabs/SallyLauncher';
const SITE_URL = 'https://github.com/SallyLabs/SallyLauncher';

const state = {
  enabled: false,
  clientId: '',
  status: 'off', /* off | connecting | ready | error */
  error: null
};

let client = null;
let pending = null;
let log = () => {};
let notify = () => {};
let retryTimer = null;
let stopped = true;
let everReady = false;

function status() {
  const { clientId, ...publicState } = state;
  return { ...publicState, activity: pending ? pending.details : null };
}

function activityFor(presence) {
  const base = {
    largeImageKey: 'logo',
    largeImageText: 'SallyLauncher',
    buttons: [{ label: 'SallyLauncher on GitHub', url: GITHUB_URL }],
    instance: false
  };
  if (presence.kind === 'playing') {
    return {
      ...base,
      details: `Minecraft ${presence.version || ''}`.trim(),
      state: presence.profile
        ? `Profile: ${presence.profile}${presence.count > 1 ? ` +${presence.count - 1} more` : ''}`
        : 'In game',
      startTimestamp: presence.startedAt || Date.now()
    };
  }
  if (presence.kind === 'launching') {
    return {
      ...base,
      details: 'Launching Minecraft',
      state: presence.version || 'Preparing files…'
    };
  }
  return {
    ...base,
    details: 'In the main menu',
    state: presence.profile ? `${presence.profile}` : 'Ready to play'
  };
}

function push() {
  if (!client?.isConnected || !pending) return;
  client.user?.setActivity(pending).catch((err) => {
    state.error = err.message;
    log(`Discord presence update failed: ${err.message}`);
  });
}

/** Sends a presence; kept for the next connection attempt when offline. */
function setPresence(presence) {
  pending = activityFor(presence || { kind: 'menu' });
  push();
}

async function connect() {
  if (!client) return;
  state.status = 'connecting';
  state.error = null;
  notify();
  try {
    await client.connect();
    state.status = 'ready';
    everReady = true;
    log(`Discord Rich Presence connected (app ${state.clientId}).`);
    notify();
    push();
  } catch (err) {
    state.status = 'error';
    state.error = /ENOENT|ECONNREFUSED|could not|not found/i.test(err.message)
      ? 'Discord is not running or does not know this application ID.'
      : 'Discord refused the connection – check the application ID.';
    log(`Discord Rich Presence unavailable: ${state.error}`);
    notify();
  }
}

function scheduleRetry() {
  if (retryTimer || stopped) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (stopped) return;
    connect();
  }, 60_000);
  retryTimer.unref?.();
}

async function start({ clientId, onLog, onChange } = {}) {
  log = typeof onLog === 'function' ? onLog : () => {};
  notify = typeof onChange === 'function' ? onChange : () => {};
  const id = String(clientId || '').trim();
  if (!id) {
    state.enabled = false;
    state.status = 'off';
    state.clientId = '';
    return status();
  }
  if (client && state.clientId === id && state.status !== 'error') return status();
  await stop({ silent: true });

  stopped = false;
  everReady = false;
  state.enabled = true;
  state.clientId = id;
  client = new Client({ clientId: id });
  client.on('disconnected', () => {
    state.status = 'error';
    state.error = everReady
      ? 'Discord was closed – reconnecting…'
      : 'Discord does not know this application ID.';
    notify();
    scheduleRetry();
  });
  client.on('ready', () => {
    state.status = 'ready';
    state.error = null;
    push();
  });
  await connect();
  return status();
}

async function stop({ silent = false } = {}) {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const current = client;
  client = null;
  state.enabled = false;
  state.status = 'off';
  state.error = null;
  state.clientId = '';
  everReady = false;
  if (current) {
    try {
      await current.destroy();
      if (!silent) log('Discord Rich Presence disconnected.');
    } catch {
      /* Discord already gone */
    }
  }
  notify();
}

module.exports = { start, stop, setPresence, status, SITE_URL };
