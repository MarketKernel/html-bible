/**
 * Settings: translations and commentaries, the user's own comments (export,
 * import), how the text looks, the interface language.
 */

import { LANGUAGES, t, tn } from '../core/i18n';
import type { Settings } from '../core/settings';
import { authAvailable, currentUser, signInDialog } from './auth-service';
import { clear, h, icon } from './dom';
import { allComments, download, exportComments, importComments } from './my-comments';
import { packsSection, pickFile } from './packs-view';
import { installedPacks } from './packs';
import { settings, updateSettings } from './state';
import { askText, toast } from './ui';

function select<K extends keyof Settings>(key: K, options: [Settings[K], string][], label: string, after?: () => void): HTMLElement {
  const element = h('select', { class: 'select' }, options.map(([value, text]) => h('option', { value: String(value) }, text)));
  element.value = String(settings[key]);
  element.addEventListener('change', () => {
    const option = options.find(([value]) => String(value) === element.value);
    if (option) updateSettings({ [key]: option[0] } as Partial<Settings>);
    after?.();
  });
  return h('label', { class: 'field grow' }, h('span', null, label), element);
}

function check<K extends keyof Settings>(key: K, label: string): HTMLElement {
  const box = h('input', { type: 'checkbox', checked: Boolean(settings[key]) });
  box.addEventListener('change', () => updateSettings({ [key]: box.checked } as Partial<Settings>));
  return h('label', { class: 'check' }, box, label);
}

export async function openSettings(container: HTMLElement): Promise<void> {
  const page = h('div', { class: 'page' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  const redraw = () => void openSettings(container);
  page.appendChild(h('h1', null, t('settings', 'Settings')));
  page.appendChild(await packsSection(redraw));

  const comments = await allComments();
  page.appendChild(
    h(
      'section',
      { class: 'settings-section' },
      h('h2', null, t('settings', 'My comments')),
      h('p', null, tn('settings', '{count} comment on this device', '{count} comments on this device', comments.length)),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            disabled: !comments.length,
            on: {
              click: async () => {
                const name = await askText(t('settings', 'Export comments'), t('settings', 'Name of the set (others will see it when they open the file)'), t('settings', 'My comments'));
                if (name === null) return;
                const blob = await exportComments(name || t('settings', 'My comments'), currentUser()?.displayName ?? '');
                download(blob, `comments-${new Date().toISOString().slice(0, 10)}.json`);
              },
            },
          },
          icon('download'),
          t('settings', 'Export to a file'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            on: {
              click: async () => {
                const file = await pickFile('.json,application/json');
                if (!file) return;
                try {
                  const n = await importComments(file);
                  toast(tn('settings', '{count} comment added', '{count} comments added', n));
                  redraw();
                } catch (error) {
                  toast((error as Error).message, 'error');
                }
              },
            },
          },
          icon('upload'),
          t('settings', 'Import my export'),
        ),
      ),
      h('p', { class: 'hint' }, t('settings', 'The export is a commentary file: anyone can open it in “Open a file…” and see your comments next to the verses.')),
    ),
  );

  const commentaries = installedPacks('commentary');
  page.appendChild(
    h(
      'section',
      { class: 'settings-section' },
      h('h2', null, t('settings', 'Reading')),
      h(
        'div',
        { class: 'row' },
        select('fontSize', [14, 16, 17, 18, 19, 20, 22, 24, 26, 28].map((n) => [n, `${n}px`]), t('settings', 'Text size')),
        select('font', [['serif', t('settings', 'Serif')], ['sans', t('settings', 'Sans serif')]], t('settings', 'Font')),
        select('addedWords', [['italic', t('settings', 'In italics')], ['plain', t('settings', 'As plain text')], ['hidden', t('settings', 'Hidden')]], t('settings', 'Words added by translators')),
      ),
      check('hideNoncanonicalBooks', t('settings', 'Hide noncanonical books in the book list')),
      check('showNotes', t('settings', 'Show comment markers by verses')),
      commentaries.length
        ? h(
            'div',
            null,
            h('p', { class: 'hint' }, t('settings', 'Commentaries to show:')),
            commentaries.map((c) => {
              const box = h('input', { type: 'checkbox', checked: !settings.hiddenCommentaries.includes(c.id) });
              box.addEventListener('change', () => updateSettings({ hiddenCommentaries: box.checked ? settings.hiddenCommentaries.filter((id) => id !== c.id) : [...settings.hiddenCommentaries, c.id] }));
              return h('label', { class: 'check' }, box, c.name);
            }),
          )
        : null,
      h(
        'div',
        { class: 'row' },
        select('copyFormat', [['quote', t('settings', '«Text» (John 3:16, KJV)')], ['ref-first', t('settings', 'John 3:16, KJV — Text')], ['numbered', t('settings', 'With verse numbers')]], t('settings', 'Copy as')),
      ),
      check('copyWithLink', t('settings', 'Add a link when copying')),
    ),
  );

  page.appendChild(
    h(
      'section',
      { class: 'settings-section' },
      h('h2', null, t('settings', 'Interface')),
      h(
        'div',
        { class: 'row' },
        select('lang', [['auto', t('settings', 'As in the system')], ...(Object.entries(LANGUAGES) as ['ru' | 'en', string][])], t('settings', 'Language'), () => location.reload()),
        select('theme', [['system', t('settings', 'As in the system')], ['light', t('settings', 'Light')], ['dark', t('settings', 'Dark')]], t('settings', 'Theme')),
      ),
    ),
  );

  if (authAvailable()) {
    const user = currentUser();
    page.appendChild(
      h(
        'section',
        { class: 'settings-section' },
        h('h2', null, t('settings', 'Account for discussions')),
        user
          ? h(
              'div',
              { class: 'row' },
              h('span', { class: 'grow' }, t('settings', 'Signed in as {name}', { name: user.displayName })),
              h('a', { class: 'button', href: '#/profile' }, icon('user'), t('settings', 'Profile')),
            )
          : h(
              'div',
              { class: 'row' },
              h('span', { class: 'grow hint' }, t('settings', 'Needed only to take part in discussions.')),
              h('button', { type: 'button', class: 'button', on: { click: () => signInDialog('in') } }, t('settings', 'Sign in')),
              h('button', { type: 'button', class: 'button', on: { click: () => signInDialog('up') } }, t('settings', 'Create an account')),
            ),
      ),
    );
  }

  page.appendChild(h('p', { class: 'version' }, `html-bible ${__APP_VERSION__}`));
}
