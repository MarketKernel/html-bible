/**
 * Signing in for discussions with a login and a password (docs/api.md). The
 * server answers with a token that lasts until signing out; it is kept with
 * the user in IndexedDB, never in localStorage. A 401 means the session is
 * gone (signed out on another device, or the password changed there), and
 * the page forgets it.
 *
 * Nothing but requests to the API: it works the same from file://.
 */

import type { User } from '../core/api-types';
import { CONFIG } from '../core/config';
import { t } from '../core/i18n';
import { del, get, put } from './db';
import { h } from './dom';
import { uiLang } from './state';
import { askText, dialog, toast } from './ui';

interface Session {
  token: string;
  user: User;
}

let session: Session | null = null;
const listeners = new Set<(user: User | null) => void>();

export function currentUser(): User | null {
  return session?.user ?? null;
}

export function onUserChange(listener: (user: User | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function authAvailable(): boolean {
  return !!CONFIG.apiUrl;
}

/** The token for API requests; null when signed out. */
export function authToken(): string | null {
  return session?.token ?? null;
}

async function keep(next: Session | null): Promise<void> {
  session = next;
  await (next ? put('auth', next, 'session') : del('auth', 'session')).catch(() => undefined);
  for (const listener of listeners) listener(next?.user ?? null);
}

class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function explain(status: number, error: { code?: string; field?: string; reason?: string }, retryAfter: string | null): string {
  switch (error.code) {
    case 'invalid_credentials':
      return t('auth', 'Wrong login or password.');
    case 'login_taken':
      return t('auth', 'This login is taken.');
    case 'wrong_password':
      return t('auth', 'The current password is wrong.');
    case 'too_many_requests':
      return t('auth', 'Too many attempts. Try again in {minutes} min.', { minutes: Math.max(1, Math.ceil(Number(retryAfter ?? 60) / 60)) });
    case 'invalid_invite':
      return t('auth', 'This invitation code is not valid.');
    case 'invite_used':
      return t('auth', 'This invitation code has already been used.');
    case 'moderation_rejected':
      return error.reason ?? t('auth', 'This name was rejected.');
    case 'validation_error':
      if (error.field === 'login') return t('auth', 'A login is 3–32 characters: letters a–z, digits, ".", "_" or "-".');
      if (error.field === 'password' || error.field === 'newPassword') return t('auth', 'A password is 8–128 characters and not the same as the login.');
      if (error.field === 'invite') return t('auth', 'Enter the invitation code you were given, like 1-7-K3M9Q-T8ZR2.');
  }
  if (status === 503) return t('api', 'The service is busy. Try again in a minute.');
  return t('api', 'Something went wrong ({status}).', { status });
}

async function request<T>(method: string, path: string, body?: unknown, token: string | null = session?.token ?? null): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(new URL(path, CONFIG.apiUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new AuthError(0, 'offline', t('api', 'No connection to the server.'));
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new AuthError(response.status, String((json?.error as { code?: string })?.code ?? 'error'), explain(response.status, (json?.error ?? {}) as object, response.headers.get('Retry-After')));
  return json as T;
}

/** At start: the kept session, its profile renewed when online. */
export async function initAuth(): Promise<void> {
  if (!authAvailable()) return;
  const kept = await get<Session>('auth', 'session').catch(() => undefined);
  if (!kept?.token) return;
  await keep(kept);
  if (!navigator.onLine) return;
  try {
    await keep({ token: kept.token, user: await request<User>('GET', 'me') });
  } catch (error) {
    if ((error as AuthError).status === 401) await keep(null);
  }
}

/** Called by the API client on a 401: the session ended elsewhere. */
export function sessionLost(): void {
  if (!session) return;
  void keep(null);
  toast(t('auth', 'You were signed out. Sign in again.'), 'error');
}

export async function signOut(everywhere = false): Promise<void> {
  const token = session?.token;
  if (!token) return;
  if (everywhere) {
    // Every device: only once the server has done it.
    try {
      await request('POST', 'auth/logout', { all: true });
    } catch (error) {
      toast((error as Error).message, 'error');
      return;
    }
  } else {
    request('POST', 'auth/logout', undefined, token).catch(() => undefined);
  }
  await keep(null);
}

export function updateUserName(name: string): void {
  if (session) void keep({ ...session, user: { ...session.user, displayName: name } });
}

/** The public name in discussions; at registration it starts as the login. */
export async function renameDialog(): Promise<void> {
  const user = currentUser();
  if (!user) return;
  const name = await askText(t('auth', 'Your name in discussions'), t('auth', 'Others will see it next to what you write.'), user.displayName);
  if (!name || name === user.displayName) return;
  try {
    const updated = await request<User>('PATCH', 'me', { displayName: name.slice(0, 40) });
    updateUserName(updated.displayName);
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

function field(label: string, input: HTMLInputElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), input);
}

/** A new password is held to the rules here too; a current one is the server's to judge. */
function passwordInput(autocomplete: 'current-password' | 'new-password'): HTMLInputElement {
  const input = h('input', { class: 'input', type: 'password', autocomplete, maxlength: '128', required: true });
  if (autocomplete === 'new-password') input.minLength = 8;
  return input;
}

export function changePasswordDialog(): void {
  if (!session) return;
  const current = passwordInput('current-password');
  const next = passwordInput('new-password');
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'button primary' }, t('auth', 'Change password'));
  const form = h(
    'form',
    { class: 'sign-in', on: { submit: (event) => void send(event) } },
    field(t('auth', 'Current password'), current),
    field(t('auth', 'New password'), next),
    h('p', { class: 'hint' }, t('auth', 'Other devices will be signed out.')),
    error,
    h('div', { class: 'dialog-actions' }, submit),
  );
  const handle = dialog({ title: t('auth', 'Change password'), body: form });
  async function send(event: Event): Promise<void> {
    event.preventDefault();
    submit.disabled = true;
    try {
      await request('POST', 'auth/password', { password: current.value, newPassword: next.value });
      handle.close();
      toast(t('auth', 'The password is changed.'));
    } catch (failure) {
      error.textContent = (failure as Error).message;
      error.hidden = false;
      submit.disabled = false;
    }
  }
}

/** Sign in, or create an account with an invitation code: one form, two tabs. */
export function signInDialog(mode: 'in' | 'up' = 'in', code = ''): void {
  if (!authAvailable()) {
    toast(t('auth', 'Discussions are not available in this build.'), 'error');
    return;
  }
  const login = h('input', { class: 'input', name: 'login', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', maxlength: '32', required: true, autofocus: true });
  const password = passwordInput(mode === 'in' ? 'current-password' : 'new-password');
  const invite = h('input', { class: 'input', name: 'invite', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '40', value: code });
  const inviter = h('p', { class: 'hint invited-by' });
  const inviteField = h('div', null, field(t('auth', 'Invitation code'), invite), inviter);
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'button primary' });
  const hint = h('p', { class: 'hint' });
  const tabs = (['in', 'up'] as const).map((which) =>
    h('button', { type: 'button', class: 'tab', role: 'tab', on: { click: () => show(which) } }, which === 'in' ? t('auth', 'Sign in') : t('auth', 'Create an account')),
  );
  const show = (which: 'in' | 'up') => {
    mode = which;
    tabs.forEach((tab, index) => tab.setAttribute('aria-selected', String((index === 0) === (which === 'in'))));
    password.autocomplete = which === 'in' ? 'current-password' : 'new-password';
    if (which === 'in') password.removeAttribute('minlength');
    else password.minLength = 8;
    inviteField.hidden = which === 'in';
    invite.required = which === 'up';
    submit.textContent = which === 'in' ? t('auth', 'Sign in') : t('auth', 'Create an account');
    hint.textContent =
      which === 'in'
        ? t('auth', 'Signing in is needed only to take part in discussions: to ask, argue and vote. Reading needs no account.')
        : t('auth', 'An account needs an invitation code from a member. A login of 3–32 characters (letters a–z, digits, ".", "_", "-") and a password of at least 8. Others see your name, which starts as the login and can be changed.');
    error.hidden = true;
  };
  const form = h(
    'form',
    { class: 'sign-in', on: { submit: (event) => void send(event) } },
    h('div', { class: 'tabs', role: 'tablist' }, tabs),
    inviteField,
    field(t('auth', 'Login'), login),
    field(t('auth', 'Password'), password),
    error,
    hint,
    h('div', { class: 'dialog-actions' }, submit),
  );
  show(mode);
  const handle = dialog({ title: t('auth', 'Account for discussions'), body: form });
  // Who invites: shown as soon as the code is whole, so a wrong code shows before the rest is typed.
  let asked = '';
  const lookUp = async () => {
    const value = invite.value.trim();
    if (value === asked) return;
    asked = value;
    inviter.textContent = '';
    // Only a whole code is asked about: number, number, 10 characters of signature.
    const parts = value.split(/[\s-]+/).filter(Boolean);
    if (parts.length < 3 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!) || parts.slice(2).join('').length !== 10) return;
    try {
      const found = await request<{ inviter: { displayName: string } }>('GET', `invites/${encodeURIComponent(value)}`, undefined, null);
      if (invite.value.trim() === value) inviter.textContent = t('auth', '{name} invites you.', { name: found.inviter.displayName });
    } catch (failure) {
      if (invite.value.trim() === value) inviter.textContent = (failure as Error).message;
    }
  };
  invite.addEventListener('change', () => void lookUp());
  invite.addEventListener('input', () => void lookUp());
  if (code) void lookUp();
  async function send(event: Event): Promise<void> {
    event.preventDefault();
    submit.disabled = true;
    const registering = mode === 'up';
    try {
      const body = registering ? { invite: invite.value, login: login.value, password: password.value, lang: uiLang() } : { login: login.value, password: password.value };
      const answer = await request<Session>('POST', registering ? 'auth/register' : 'auth/login', body, null);
      await keep({ token: answer.token, user: answer.user });
      handle.close();
      toast(t('auth', 'Signed in as {name}', { name: answer.user.displayName }));
      if (registering) await renameDialog();
    } catch (failure) {
      error.textContent = (failure as Error).message;
      error.hidden = false;
      submit.disabled = false;
    }
  }
}
