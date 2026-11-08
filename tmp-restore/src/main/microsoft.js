'use strict';

/**
 * Real Microsoft account login (device code flow) followed by the
 * Xbox Live → XSTS → Minecraft services chain.
 *
 * Two flows are supported because Minecraft accepts different app
 * registrations:
 *  - "live"  : legacy Live SDK ids (16 hex chars, e.g. 00000000402b5328)
 *  - "entra" : Azure/Entra app GUIDs (needs "Allow public client flows")
 *
 * A client id can be configured in Settings; without an approved app
 * registration Minecraft answers `login_with_xbox` with HTTP 403.
 */

const DEFAULT_CLIENT_ID = '00000000402b5328';
const LIVE_DEVICE_URL = 'https://login.live.com/oauth20_connect.srf';
const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const ENTRA_DEVICE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const ENTRA_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const ENTRA_SCOPE = 'XboxLive.signin offline_access';
const XBOX_USER_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';

const XERR_MESSAGES = {
  2148916227: 'This Microsoft account is banned from Xbox Live.',
  2148916229: 'Xbox Live blocks this account because of parental restrictions.',
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at xbox.com, then try again.',
  2148916234: 'The Xbox Live terms of service have not been accepted for this account.',
  2148916235: 'Xbox Live is not available in the country of this account.',
  2148916236: 'This account needs adult verification (South Korea).',
  2148916237: 'This account reached its Xbox playtime limit.',
  2148916238: 'This is a child account. Add it to a Microsoft family first.'
};

function clientIdOf(value) {
  const clean = String(value || '').trim();
  return clean || DEFAULT_CLIENT_ID;
}

function flowOf(clientId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(clientId) ? 'entra' : 'live';
}

function scopeFor(flow) {
  return flow === 'entra' ? ENTRA_SCOPE : LIVE_SCOPE;
}

async function request(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url, body) {
  return request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'SallyLauncher/1.0'
    },
    body: new URLSearchParams(body).toString()
  });
}

async function postJson(url, body, extraHeaders = {}) {
  return request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'SallyLauncher/1.0',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/* --------------------------------------------------------- device code */

async function requestDeviceCode(clientIdInput) {
  const clientId = clientIdOf(clientIdInput);
  const flow = flowOf(clientId);

  const response =
    flow === 'entra'
      ? await postForm(ENTRA_DEVICE_URL, { client_id: clientId, scope: ENTRA_SCOPE })
      : await postForm(LIVE_DEVICE_URL, {
          client_id: clientId,
          scope: LIVE_SCOPE,
          response_type: 'device_code'
        });

  const data = await readJson(response);
  if (!response.ok || !data.user_code) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`Microsoft did not return a sign-in code: ${detail}`);
  }

  return {
    clientId,
    flow,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://www.microsoft.com/link',
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
    message: data.message || ''
  };
}

/** Polls once. Resolves {status:'pending'} | {status:'done', tokens}. */
async function pollDeviceCode({ clientId, flow, deviceCode }) {
  const url = flow === 'entra' ? ENTRA_TOKEN_URL : LIVE_TOKEN_URL;
  const response = await postForm(url, {
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode
  });
  const data = await readJson(response);

  if (data.access_token && data.refresh_token) {
    return {
      status: 'done',
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: Number(data.expires_in) || 3600
      }
    };
  }

  const error = String(data.error || '');
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'pending', slowDown: true };
  if (error === 'expired_token') throw new Error('The sign-in code expired. Start the login again.');
  if (error === 'authorization_declined') throw new Error('The sign-in was declined.');
  throw new Error(data.error_description || error || `Microsoft returned HTTP ${response.status}`);
}

async function refreshMsaToken({ clientId, flow, refreshToken }) {
  const url = flow === 'entra' ? ENTRA_TOKEN_URL : LIVE_TOKEN_URL;
  const response = await postForm(url, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: scopeFor(flow)
  });
  const data = await readJson(response);
  if (!data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`;
    const error = new Error(`Microsoft session expired (${detail}). Sign in again.`);
    error.needsLogin = true;
    throw error;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in) || 3600
  };
}

/* ------------------------------------------------------ xbox → minecraft */

async function xboxUser(msaAccessToken) {
  const response = await postJson(
    XBOX_USER_URL,
    {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    },
    { 'x-xbl-contract-version': '1' }
  );
  const data = await readJson(response);
  if (!response.ok || !data.Token) {
    throw new Error(`Xbox Live rejected the Microsoft token: ${data.Message || `HTTP ${response.status}`}`);
  }
  return { token: data.Token, uhs: data.DisplayClaims?.xui?.[0]?.uhs };
}

async function xstsAuthorize(xblToken) {
  const response = await postJson(
    XSTS_URL,
    {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    },
    { 'x-xbl-contract-version': '1' }
  );
  const data = await readJson(response);
  if (!response.ok || !data.Token) {
    const xerr = Number(data.XErr);
    const friendly = XERR_MESSAGES[xerr];
    throw new Error(
      friendly || `Xbox Live authorization failed${xerr ? ` (XErr ${xerr})` : ''}${data.Message ? `: ${data.Message}` : ''}`
    );
  }
  return { token: data.Token, uhs: data.DisplayClaims?.xui?.[0]?.uhs };
}

async function minecraftLogin(uhs, xstsToken) {
  const response = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xstsToken}` });
  const data = await readJson(response);
  if (response.status === 403) {
    throw new Error(
      'Minecraft refused this app registration (HTTP 403). Use a Microsoft/Azure app id that Mojang approved for Minecraft, or fall back to an offline account.'
    );
  }
  if (!response.ok || !data.access_token) {
    throw new Error(`Minecraft login failed: ${data.errorMessage || data.error || `HTTP ${response.status}`}`);
  }
  return { token: data.access_token, expiresIn: Number(data.expires_in) || 86400 };
}

async function minecraftProfile(mcToken) {
  const response = await request(MC_PROFILE_URL, {
    headers: { authorization: `Bearer ${mcToken}`, accept: 'application/json', 'user-agent': 'SallyLauncher/1.0' }
  });
  if (response.status === 404) {
    throw new Error('This Microsoft account owns no Minecraft profile yet. Create one in the official launcher first.');
  }
  const data = await readJson(response);
  if (!response.ok || !data.id) {
    throw new Error(`Could not read the Minecraft profile: ${data.error || `HTTP ${response.status}`}`);
  }
  const skin = (data.skins || []).find((entry) => entry.state === 'ACTIVE') || data.skins?.[0] || null;
  return {
    uuid: data.id,
    name: data.name,
    skins: data.skins || [],
    capes: data.capes || [],
    /* the API still answers with http:// texture URLs, which the renderer CSP blocks */
    skinUrl: skin?.url ? skin.url.replace(/^http:/i, 'https:') : null,
    skinVariant: skin?.variant || null
  };
}

async function ownsMinecraft(mcToken) {
  try {
    const response = await request(MC_ENTITLEMENTS_URL, {
      headers: { authorization: `Bearer ${mcToken}`, accept: 'application/json', 'user-agent': 'SallyLauncher/1.0' }
    });
    if (!response.ok) return true;
    const data = await readJson(response);
    const names = (data.items || []).map((item) => item.name);
    return names.includes('game_minecraft') || names.includes('product_minecraft') || names.length === 0;
  } catch {
    return true;
  }
}

function dashedUuid(id) {
  const clean = String(id || '').replace(/-/g, '');
  if (clean.length !== 32) return id;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

/**
 * Turns Microsoft tokens into a launchable Minecraft account.
 * `msa` = { accessToken, refreshToken, expiresIn } from the code flow.
 */
async function resolveAccount({ msa, clientId, flow, previous = {} }) {
  const xbl = await xboxUser(msa.accessToken);
  const xsts = await xstsAuthorize(xbl.token);
  const mc = await minecraftLogin(xsts.uhs || xbl.uhs, xsts.token);
  const profile = await minecraftProfile(mc.token);
  const owned = await ownsMinecraft(mc.token);
  if (!owned) throw new Error('This Microsoft account does not own Minecraft: Java Edition.');

  return {
    xuid: xsts.uhs || xbl.uhs,
    minecraftToken: mc.token,
    minecraftTokenExpiresAt: Date.now() + mc.expiresIn * 1000,
    msaRefreshToken: msa.refreshToken || previous.msaRefreshToken,
    clientId,
    flow,
    profile
  };
}

module.exports = {
  DEFAULT_CLIENT_ID,
  requestDeviceCode,
  pollDeviceCode,
  refreshMsaToken,
  resolveAccount,
  minecraftProfile,
  dashedUuid,
  flowOf,
  clientIdOf
};
