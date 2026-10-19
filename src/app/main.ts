/**
 * The page: the top bar, the router, the first run.
 *
 * Every screen is an address after "#" (core/route.ts): a verse link opens the
 * reader, "/…" the app's own screens. The page holds no state the address
 * cannot rebuild, so a link, a reload and the Back button all land in the
 * same place.
 */

import { t, translatePage } from '../core/i18n';
import { parseRef } from '../core/refs';
import { formatRoute, parseRoute, type Route } from '../core/route';
import { currentUser, initAuth, onUserChange, signInDialog, signOut } from './auth-service';
import { openCompare } from './compare-view';
import { openDb } from './db';
import { openDiscussion, openDiscussions } from './discussions';
import { $, clear, h, icon } from './dom';
import { closePanel, panelOpen } from './panel';
import { installedPacks, loadInstalled } from './packs';
import { openOnboarding, openPackFile } from './packs-view';
import { clearSelection, openReader, readerState, step } from './reader';
import { openSearch } from './search-view';
import { openProfile, openUser } from './profile-view';
import { openSettings } from './settings-view';
import { apply, settings } from './state';
import { anyDialogOpen, menu, toast } from './ui';
import { initUpdates } from './update';

let view: HTMLElement;
let onboarding = false;

function setTab(tab: 'bible' | 'discussions' | null): void {
  $('#tab-bible').setAttribute('aria-selected', String(tab === 'bible'));
  $('#tab-discussions').setAttribute('aria-selected', String(tab === 'discussions'));
}

async function route(): Promise<void> {
  if (onboarding) return;
  const r: Route = parseRoute(location.hash);
  if (r.name !== 'read' && r.name !== 'home') {
    clearSelection();
    closePanel();
  }
  const input = $('#search-input') as HTMLInputElement;
  if (r.name !== 'search') input.value = '';
  switch (r.name) {
    case 'home':
      setTab('bible');
      return openReader(view);
    case 'read':
      setTab('bible');
      clearSelection();
      return openReader(view, { ref: r.ref, notes: r.notes ?? false, par: r.par, comment: r.comment });
    case 'compare':
      setTab('bible');
      return openCompare(view, r.ref);
    case 'search':
      setTab('bible');
      input.value = r.q;
      return openSearch(view, r.q, r.scope, r.at);
    case 'discussions':
      setTab('discussions');
      return openDiscussions(view, r.tag);
    case 'discussion':
      setTab('discussions');
      return openDiscussion(view, r.id, { argument: r.argument, verse: r.verse });
    case 'settings':
      setTab(null);
      return openSettings(view);
    case 'profile':
      setTab(null);
      return openProfile(view);
    case 'user':
      setTab('discussions');
      return openUser(view, r.id);
    case 'join': {
      // An invitation link: the discussions, with the new-account form over them.
      setTab('discussions');
      await openDiscussions(view);
      const user = currentUser();
      if (user) toast(t('auth', 'You are signed in already, as {name}.', { name: user.displayName }));
      else signInDialog('up', r.code);
      return;
    }
    case 'unknown': {
      setTab('bible');
      toast(t('app', 'Not a verse or a page of the app: {text}', { text: r.text.slice(0, 60) }), 'error');
      return openReader(view);
    }
  }
}

function setupTopbar(): void {
  $('#tab-bible').addEventListener('click', () => {
    const state = readerState();
    location.hash = state ? formatRoute({ name: 'read', ref: { linkName: state.tr.linkName, book: state.book, parts: [{ chapter: state.chapter }] } }) : '';
  });
  $('#tab-discussions').addEventListener('click', () => (location.hash = '#/discussions'));

  const input = $('#search-input') as HTMLInputElement;
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;
    // A reference goes straight to the verse; anything else is a search.
    const ref = parseRef(q);
    location.hash = ref && !q.includes('"') ? formatRoute({ name: 'read', ref }) : formatRoute({ name: 'search', q });
    input.blur();
  });

  const account = $('#account-button');
  const drawAccount = () => {
    const user = currentUser();
    account.replaceChildren(user ? h('span', { class: 'avatar' }, user.displayName.slice(0, 1).toUpperCase()) : icon('user'));
    account.title = user ? user.displayName : t('topbar', 'Sign in');
  };
  drawAccount();
  onUserChange(drawAccount);
  account.addEventListener('click', () => {
    const user = currentUser();
    if (!user) return signInDialog();
    menu(account, [
      { label: t('topbar', 'Profile'), icon: 'user', action: () => (location.hash = formatRoute({ name: 'profile' })) },
      { label: t('topbar', 'Sign out'), icon: 'logout', action: () => void signOut() },
    ]);
  });

  const menuButton = $('#menu-button');
  menuButton.appendChild(icon('more'));
  menuButton.addEventListener('click', () =>
    menu(menuButton, [
      { label: t('topbar', 'Translations and commentaries'), icon: 'download', action: () => (location.hash = '#/settings') },
      { label: t('topbar', 'Open a file…'), icon: 'upload', action: () => void openPackFile().then((m) => m && route()) },
      'separator',
      { label: t('topbar', 'Settings'), icon: 'settings', action: () => (location.hash = '#/settings') },
    ]),
  );
}

function setupKeys(): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable]');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !typing) {
      event.preventDefault();
      $('#search-input').focus();
      return;
    }
    if (typing || anyDialogOpen() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      $('#search-input').focus();
    } else if (event.key === 'Escape') {
      if (panelOpen()) closePanel();
      else clearSelection();
    } else if (readerState() && parseRoute(location.hash).name.match(/^(read|home)$/)) {
      if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
    }
  });
}

/** A translation or commentary file dropped anywhere on the window. */
function setupDrop(): void {
  const app = $('#app');
  let depth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    depth += 1;
    app.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) app.classList.remove('dragging');
  });
  document.addEventListener('dragover', (event) => event.dataTransfer?.types.includes('Files') && event.preventDefault());
  document.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    depth = 0;
    app.classList.remove('dragging');
    // Take the file before any await: the DataTransfer empties after it.
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const meta = await openPackFile(file);
    if (meta && onboarding && installedPacks('translation').length) finishOnboarding();
    else if (meta) void route();
  });
}

function finishOnboarding(): void {
  onboarding = false;
  void route();
}

async function boot(): Promise<void> {
  apply();
  translatePage();
  setupTopbar();
  setupKeys();
  setupDrop();
  view = h('div', { class: 'view' });
  clear($('#main'), view);
  try {
    await openDb();
    await loadInstalled();
  } catch (error) {
    clear(view, h('div', { class: 'view-scroll' }, h('div', { class: 'empty' }, t('app', 'This browser does not let the page keep data (private mode?). {error}', { error: (error as Error).message }))));
    return;
  }
  await initAuth().catch(() => undefined);
  window.addEventListener('hashchange', () => void route());
  initUpdates();
  if (!installedPacks('translation').length || !settings.onboarded) {
    if (installedPacks('translation').length) {
      void route();
      return;
    }
    onboarding = true;
    setTab(null);
    await openOnboarding(view, finishOnboarding);
    return;
  }
  await route();
}

void boot();
