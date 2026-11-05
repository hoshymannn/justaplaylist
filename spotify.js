// Spotify login (Authorization Code with PKCE) and a small API helper.
// Runs entirely in the browser; no client secret is involved.

import { CONFIG } from './config.js';

const AUTH_KEY = 'jap.auth';
const PKCE_KEY = 'jap.pkce';
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
].join(' ');

export const redirectUri = new URL('./', location.href).href;

export function isConfigured() {
  return CONFIG.clientId && !CONFIG.clientId.startsWith('PASTE_');
}

/* ---------- storage (wrapped, storage can be unavailable) ---------- */

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function isLoggedIn() {
  return !!load(AUTH_KEY)?.refresh_token;
}

export function logout() {
  remove(AUTH_KEY);
}

/* ---------- login ---------- */

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, v => chars[v % chars.length]).join('');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const verifier = randomString(64);
  const state = randomString(16);
  save(PKCE_KEY, { verifier, state });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
  });
  location.assign('https://accounts.spotify.com/authorize?' + params);
}

// Call once on page load. Finishes a login if Spotify just sent us back.
// Returns an error message for the person, or null.
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return null;

  const pkce = load(PKCE_KEY);
  const returnedState = url.searchParams.get('state');
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  history.replaceState(null, '', url.pathname + url.search + url.hash);

  if (error) return error === 'access_denied'
    ? 'The Spotify login was cancelled.'
    : `Spotify reported an error during login (${error}).`;
  if (!pkce || returnedState !== pkce.state) {
    return 'The login could not be completed. Please log in again.';
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CONFIG.clientId,
      code_verifier: pkce.verifier,
    }),
  });
  remove(PKCE_KEY);
  if (!res.ok) return 'Spotify did not accept the login. Please log in again.';
  storeTokens(await res.json());
  return null;
}

function storeTokens(data) {
  const old = load(AUTH_KEY) || {};
  save(AUTH_KEY, {
    access_token: data.access_token,
    refresh_token: data.refresh_token || old.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  });
}

export class LoginExpiredError extends Error {}

async function accessToken(forceRefresh = false) {
  const auth = load(AUTH_KEY);
  if (!auth?.refresh_token) throw new LoginExpiredError('Not logged in.');
  if (!forceRefresh && auth.access_token && auth.expires_at - 60_000 > Date.now()) {
    return auth.access_token;
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: CONFIG.clientId,
    }),
  });
  if (!res.ok) {
    logout();
    throw new LoginExpiredError('Your Spotify login has expired. Log in again to continue.');
  }
  storeTokens(await res.json());
  return load(AUTH_KEY).access_token;
}

/* ---------- API ---------- */

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await accessToken();
    const res = await fetch('https://api.spotify.com/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await accessToken(true);
      continue;
    }
    if (res.status === 429) {
      const wait = Math.min(10, Number(res.headers.get('Retry-After')) || 2);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 204) return null;

    const data = await res.json().catch(() => null);
    if (res.ok) return data;

    const message = data?.error?.message || res.statusText || 'Unknown error';
    if (res.status === 403 && /regist/i.test(message)) {
      throw new ApiError(
        'This Spotify account isn’t on the app’s user list. The app owner can add it under “User Management” in the Spotify developer dashboard.',
        403,
      );
    }
    throw new ApiError(`Spotify reported an error: ${message} (${res.status}).`, res.status);
  }
  throw new ApiError('Spotify is receiving too many requests right now. Try again in a minute.', 429);
}

// Fetches all pages of a paged endpoint, up to `limitItems` items.
export async function apiAll(path, limitItems = 500) {
  const items = [];
  let next = path;
  while (next && items.length < limitItems) {
    const page = await api('GET', next);
    items.push(...(page.items || []));
    next = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return items;
}
