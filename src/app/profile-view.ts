/**
 * Profiles (Task2.md §1, §6). One's own (#/profile): name, password, sign-out,
 * and the invitation codes with who used each. Anyone's (#/users/<id>): the
 * public part only — number, since when, who invited them and whom they invited.
 */

import type { InviteState, PublicProfile } from '../core/api-types';
import { CONFIG } from '../core/config';
import { t, tn } from '../core/i18n';
import { formatRoute } from '../core/route';
import { formatDay } from '../core/time';
import { api, ApiError } from './api';
import { authAvailable, changePasswordDialog, currentUser, onUserChange, renameDialog, signInDialog, signOut } from './auth-service';
import { clear, h, icon } from './dom';
import { personLink, timeTag } from './people';
import { uiLang } from './state';
import { toast } from './ui';

function mount(container: HTMLElement): HTMLElement {
  const page = h('div', { class: 'page profile' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  return page;
}

function failed(page: HTMLElement, error: unknown): void {
  page.appendChild(h('div', { class: 'empty' }, error instanceof ApiError && error.status === 404 ? t('profile', 'No such member.') : (error as Error).message));
}

/** "Member No. 17 · since 5 Mar 2026, 14:05" */
function membership(profile: { number: number; createdAt: string }): HTMLElement {
  return h('p', { class: 'meta' }, t('profile', 'Member No. {number}', { number: profile.number }), ' · ', t('profile', 'since'), ' ', timeTag(profile.createdAt));
}

function chain(profile: PublicProfile): HTMLElement[] {
  return [
    h('p', null, profile.invitedBy ? [t('profile', 'Invited by'), ' ', personLink(profile.invitedBy)] : t('profile', 'The first member: invited by no one.')),
    h('h2', null, t('profile', 'Invited')),
    profile.invitees.length
      ? h('ul', { class: 'people' }, profile.invitees.map((p) => h('li', null, personLink(p), ' · ', timeTag(p.createdAt))))
      : h('p', { class: 'hint' }, t('profile', 'No one yet.')),
  ];
}

/* ---------------------------------------------------------- anyone's */

export async function openUser(container: HTMLElement, id: string): Promise<void> {
  if (id === currentUser()?.id) return openProfile(container);
  const page = mount(container);
  if (!authAvailable()) return void page.appendChild(h('div', { class: 'empty' }, t('profile', 'Profiles are not available in this build.')));
  try {
    const profile = await api.profile(id);
    page.append(h('h1', null, profile.displayName), membership(profile), ...chain(profile));
  } catch (error) {
    failed(page, error);
  }
}

/* --------------------------------------------------------------- own */

/** An invitation link: the site's address (also from a page opened from disk) and #/join/<code>. */
function inviteLink(code: string): string {
  const base = location.protocol === 'file:' && CONFIG.siteUrl ? CONFIG.siteUrl : `${location.origin}${location.pathname}`;
  return `${base}${formatRoute({ name: 'join', code })}`;
}

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(text);
  }
}

function invitations(state: InviteState, reload: () => void): HTMLElement {
  const lang = uiLang();
  const take = h(
    'button',
    {
      type: 'button',
      class: 'button primary',
      disabled: state.available === 0,
      on: {
        click: async () => {
          take.disabled = true;
          try {
            const { code } = await api.newInvite();
            await copy(inviteLink(code), t('profile', 'A new code; its link is copied.'));
            reload();
          } catch (error) {
            toast(error instanceof ApiError && error.code === 'invite_limit' && error.resetOn ? t('profile', 'New codes from {time}.', { time: formatDay(error.resetOn, lang) }) : (error as Error).message, 'error');
            take.disabled = false;
          }
        },
      },
    },
    icon('plus'),
    t('profile', 'Get a code'),
  );
  const status =
    state.available > 0
      ? tn('profile', 'You can get {count} more code now.', 'You can get {count} more codes now.', state.available)
      : state.resetOn
        ? t('profile', 'New codes from {time}.', { time: formatDay(state.resetOn, lang) })
        : '';
  const codes = [...state.codes].reverse();
  return h(
    'section',
    { class: 'settings-section invitations' },
    h('h2', null, t('profile', 'Invitations')),
    h('p', { class: 'hint' }, t('profile', 'An account can be made only with a code from a member. Each code works once and does not expire. Up to 10 codes, then more from the next midnight (UTC).')),
    h('div', { class: 'row' }, take, h('span', { class: 'hint' }, status)),
    codes.length
      ? h(
          'ul',
          { class: 'codes' },
          codes.map((entry) =>
            h(
              'li',
              { class: ['code-row', entry.usedBy ? 'used' : 'free'] },
              h('code', null, entry.code),
              entry.usedBy
                ? h('span', { class: 'hint' }, t('profile', 'used by'), ' ', personLink(entry.usedBy), ' · ', timeTag(entry.usedBy.at))
                : h(
                    'button',
                    { type: 'button', class: 'button small', title: inviteLink(entry.code), on: { click: () => void copy(inviteLink(entry.code), t('profile', 'The invitation link is copied.')) } },
                    icon('link'),
                    t('profile', 'Copy the link'),
                  ),
            ),
          ),
        )
      : null,
  );
}

export async function openProfile(container: HTMLElement): Promise<void> {
  const page = mount(container);
  const reload = () => void openProfile(container);
  const user = currentUser();
  if (!user) {
    page.append(
      h('h1', null, t('profile', 'Profile')),
      authAvailable()
        ? h(
            'div',
            { class: 'row' },
            h('span', { class: 'grow hint' }, t('profile', 'Sign in to see your profile and invite others.')),
            h('button', { type: 'button', class: 'button primary', on: { click: () => signInDialog('in') } }, t('auth', 'Sign in')),
          )
        : h('div', { class: 'empty' }, t('profile', 'Profiles are not available in this build.')),
    );
    const stop = onUserChange((next) => {
      stop();
      if (next && location.hash === formatRoute({ name: 'profile' })) reload();
    });
    return;
  }
  page.append(
    h('h1', null, user.displayName),
    membership(user),
    h('p', { class: 'meta' }, t('profile', 'Login: {login} (only you see it)', { login: user.login })),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'button', on: { click: async () => { await renameDialog(); reload(); } } }, t('settings', 'Change name')),
      h('button', { type: 'button', class: 'button', on: { click: () => changePasswordDialog() } }, t('settings', 'Change password')),
      h('button', { type: 'button', class: 'button', on: { click: async () => { await signOut(); reload(); } } }, icon('logout'), t('settings', 'Sign out')),
      h('button', { type: 'button', class: 'button', on: { click: async () => { await signOut(true); reload(); } } }, t('settings', 'Sign out on all devices')),
    ),
  );
  try {
    const [state, profile] = await Promise.all([api.invites(), api.profile(user.id)]);
    page.append(invitations(state, reload), h('section', { class: 'settings-section' }, ...chain(profile)));
  } catch (error) {
    failed(page, error);
  }
}
