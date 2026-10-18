/**
 * Signing in for discussions: Google, Apple or Microsoft through Cognito's
 * hosted endpoints (the local stub has the same ones). The access and ID
 * tokens stay in memory; the refresh token is kept in IndexedDB, never in
 * localStorage, and renews them before they run out.
 *
 * A page opened from file:// cannot be an OAuth redirect address, so there
 * "Sign in" opens the site instead.
 */

import type { User } from '../core/api-types';
import { authorizeUrl, codeChallenge, jwtClaims, logoutUrl, needsRefresh, parseTokenResponse, type Provider, randomString, type Tokens, tokenUrl } from '../core/auth';
import { CONFIG } from '../core/config';
import { t } from '../core/i18n';
import { del, get, put } from './db';
import { h } from './dom';
import { providerLogo } from './logos';
import { dialog, toast } from './ui';

const PENDING = 'html-bible.auth.pending';

let tokens: Tokens | null = null;
let user: User | null = null;
const listeners = new Set<(user: User | null) => void>();

export function currentUser(): User | null {
  return user;
}

export function onUserChange(listener: (user: User | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setUser(next: User | null): void {
  user = next;
  for (const listener of listeners) listener(user);
}

export function authAvailable(): boolean {
  return !!CONFIG.auth.issuer && !!CONFIG.auth.clientId && !!CONFIG.apiUrl;
}

const redirectUri = () => `${location.origin}${location.pathname}`;

function userFromClaims(claims: Record<string, unknown>): User {
  const identities = claims.identities as { providerName?: string }[] | undefined;
  const providerName = String(claims.provider ?? identities?.[0]?.providerName ?? '').toLowerCase();
  const provider = providerName.includes('apple') ? 'apple' : providerName.includes('microsoft') ? 'microsoft' : 'google';
  return {
    id: String(claims.sub ?? ''),
    provider,
    displayName: String(claims.name ?? claims.given_name ?? claims.email ?? 'User'),
    createdAt: new Date().toISOString(),
  };
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(tokenUrl(CONFIG.auth.issuer), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CONFIG.auth.clientId, ...body }).toString(),
  });
  if (!response.ok) throw new Error(`token ${response.status}`);
  return parseTokenResponse(await response.json());
}

async function keep(next: Tokens): Promise<void> {
  tokens = next;
  if (next.refreshToken) await put('auth', next.refreshToken, 'refresh');
  setUser(userFromClaims(jwtClaims(next.idToken)));
}

/** At start: finish a sign-in that came back with ?code=…, or renew from a kept refresh token. */
export async function initAuth(): Promise<void> {
  if (!authAvailable()) return;
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (code && state) {
    let pending: { state: string; verifier: string; hash: string } | null = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null');
    } catch {
      pending = null;
    }
    sessionStorage.removeItem(PENDING);
    history.replaceState(null, '', `${location.pathname}${pending?.hash ?? location.hash}`);
    if (pending && pending.state === state) {
      try {
        await keep(await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: redirectUri() }));
        toast(t('auth', 'Signed in'));
        return;
      } catch {
        toast(t('auth', 'Sign-in failed. Try again.'), 'error');
      }
    }
  }
  const refresh = await get<string>('auth', 'refresh').catch(() => undefined);
  if (refresh && navigator.onLine) {
    try {
      await keep({ ...(await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })), refreshToken: refresh });
    } catch {
      // Expired or revoked: signed out, quietly.
      await del('auth', 'refresh').catch(() => undefined);
    }
  }
}

/** An access token for the API, renewed when about to expire; null when signed out. */
export async function accessToken(): Promise<string | null> {
  if (!tokens) return null;
  if (needsRefresh(tokens)) {
    const refresh = tokens.refreshToken ?? (await get<string>('auth', 'refresh'));
    if (!refresh) return null;
    try {
      await keep({ ...(await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })), refreshToken: refresh });
    } catch {
      await signOut(false);
      return null;
    }
  }
  return tokens?.accessToken ?? null;
}

export async function signIn(provider: Provider): Promise<void> {
  if (location.protocol === 'file:') {
    window.open(`${CONFIG.auth.siteUrl}${location.hash}`, '_blank', 'noopener');
    return;
  }
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(PENDING, JSON.stringify({ state, verifier, hash: location.hash }));
  location.assign(authorizeUrl({ issuer: CONFIG.auth.issuer, clientId: CONFIG.auth.clientId, redirectUri: redirectUri(), provider, state, challenge: await codeChallenge(verifier) }));
}

export async function signOut(remote = true): Promise<void> {
  tokens = null;
  await del('auth', 'refresh').catch(() => undefined);
  setUser(null);
  if (remote && location.protocol !== 'file:' && CONFIG.auth.issuer) {
    // Ends the hosted session too, so the next sign-in asks again.
    fetch(logoutUrl(CONFIG.auth.issuer, CONFIG.auth.clientId, redirectUri()), { mode: 'no-cors' }).catch(() => undefined);
  }
}

export function updateUserName(name: string): void {
  if (user) setUser({ ...user, displayName: name });
}

const PROVIDERS: Record<Provider, string> = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft' };
const ORDER: Provider[] = ['apple', 'google', 'microsoft'];

/** The sign-in dialog: three square buttons with the providers' marks, and why one would sign in. */
export function signInDialog(): void {
  if (!authAvailable()) {
    toast(t('auth', 'Discussions are not available in this build.'), 'error');
    return;
  }
  const fromFile = location.protocol === 'file:';
  const providers = ORDER.filter((p) => CONFIG.auth.providers.includes(p));
  const handle = dialog({
    title: t('auth', 'Sign in'),
    body: h(
      'div',
      { class: 'sign-in' },
      h(
        'div',
        { class: 'providers' },
        providers.map((provider) => {
          const label = t('auth', 'Sign in with {provider}', { provider: PROVIDERS[provider] });
          return h('button', { type: 'button', class: ['provider-button', provider], title: label, 'aria-label': label, on: { click: () => { handle.close(); void signIn(provider); } } }, providerLogo(provider));
        }),
      ),
      h('p', { class: 'hint' }, t('auth', 'Signing in is needed only to take part in discussions: to ask, argue and vote. Reading needs no account.')),
      fromFile ? h('p', { class: 'hint' }, t('auth', 'This page is opened from a file. Signing in works on the site: it will open in a new tab.')) : null,
    ),
  });
}
