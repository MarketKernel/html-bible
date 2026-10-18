/**
 * Sign-in without SDKs: OAuth 2.0 Authorization Code with PKCE against Cognito's
 * hosted endpoints (or the local stub, which has the same paths). The page
 * redirects to /oauth2/authorize with the provider named, comes back with
 * ?code=…&state=…, and trades the code for tokens with one fetch.
 *
 * No DOM here: the parts that are pure logic, so the tests check them.
 */

export type Provider = 'google' | 'apple' | 'microsoft';

/** Cognito's names for the federated identity providers. */
export const IDENTITY_PROVIDER: Record<Provider, string> = {
  google: 'Google',
  apple: 'SignInWithApple',
  microsoft: 'Microsoft',
};

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636: BASE64URL(SHA256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authorizeUrl(options: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  provider: Provider;
  state: string;
  challenge: string;
}): string {
  const url = new URL('oauth2/authorize', options.issuer.endsWith('/') ? options.issuer : `${options.issuer}/`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    identity_provider: IDENTITY_PROVIDER[options.provider],
    scope: 'openid profile email',
  }).toString();
  return url.href;
}

export function tokenUrl(issuer: string): string {
  return new URL('oauth2/token', issuer.endsWith('/') ? issuer : `${issuer}/`).href;
}

export function logoutUrl(issuer: string, clientId: string, logoutUri: string): string {
  const url = new URL('logout', issuer.endsWith('/') ? issuer : `${issuer}/`);
  url.search = new URLSearchParams({ client_id: clientId, logout_uri: logoutUri }).toString();
  return url.href;
}

export interface Tokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export function parseTokenResponse(json: unknown, now = Date.now()): Tokens {
  const value = json as Record<string, unknown>;
  if (typeof value?.access_token !== 'string' || typeof value.id_token !== 'string') throw new Error('Bad token response');
  const expiresIn = typeof value.expires_in === 'number' ? value.expires_in : 3600;
  return {
    accessToken: value.access_token,
    idToken: value.id_token,
    ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}),
    expiresAt: now + expiresIn * 1000,
  };
}

/** A JWT's claims, unverified — the server verifies; the page only reads the name and the expiry. */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Refresh a minute before the access token runs out. */
export function needsRefresh(tokens: Tokens, now = Date.now()): boolean {
  return tokens.expiresAt - now < 60_000;
}
