/**
 * Choosing what to download: the first-run wizard (translations, then
 * commentaries) and the same lists in settings later. A file can always be
 * opened instead — the only way without a network.
 */

import { t } from '../core/i18n';
import type { Catalog, CatalogCommentary, CatalogTranslation, PackMeta } from '../core/types';
import { clear, h, icon } from './dom';
import { canDownload, fetchCatalog, hasUpdate, installCatalogCommentary, installCatalogTranslation, installedPacks, installFile, removePack } from './packs';
import { settings, uiLang, updateSettings } from './state';
import { confirmDialog, formatBytes, toast } from './ui';

export function pickFile(accept = '.json,.gz,application/json,application/gzip'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    // No change event when the picker is cancelled; nothing waits on it for long.
    document.body.appendChild(input);
    input.click();
  });
}

export async function openPackFile(file?: File | null): Promise<PackMeta | undefined> {
  const chosen = file ?? (await pickFile());
  if (!chosen) return undefined;
  try {
    const meta = await installFile(chosen);
    toast(meta.kind === 'translation' ? t('packs', 'Translation “{name}” added', { name: meta.name }) : t('packs', 'Commentary “{name}” added', { name: meta.name }));
    if (meta.kind === 'translation' && !settings.translation) updateSettings({ translation: meta.id });
    return meta;
  } catch (error) {
    toast((error as Error).message, 'error');
    return undefined;
  }
}

function progressBar(): { element: HTMLElement; set: (loaded: number, total: number) => void } {
  const bar = h('div');
  return {
    element: h('div', { class: 'progress' }, bar),
    set: (loaded, total) => {
      bar.style.width = total ? `${Math.min(100, (loaded / total) * 100)}%` : '30%';
    },
  };
}

/* ---------------- first run ---------------- */

export async function openOnboarding(container: HTMLElement, done: () => void): Promise<void> {
  const page = h('div', { class: 'page onboarding' });
  clear(container, h('div', { class: 'view-scroll' }, page));
  let catalog: Catalog | null = null;
  try {
    catalog = await fetchCatalog();
  } catch {
    catalog = null;
  }
  const chosenTranslations = new Set<string>();
  const chosenCommentaries = new Set<string>();
  const lang = uiLang();
  for (const entry of catalog?.translations ?? []) if (entry.lang === lang) {
    chosenTranslations.add(entry.id);
    break;
  }
  if (!chosenTranslations.size && catalog?.translations[0]) chosenTranslations.add(catalog.translations[0].id);
  for (const entry of catalog?.commentaries ?? []) if (entry.lang === lang) chosenCommentaries.add(entry.id);

  const steps = (n: number) => h('div', { class: 'steps' }, [1, 2].map((i) => h('span', { class: i <= n ? 'done' : undefined })));
  const fileButton = () =>
    h('button', { type: 'button', class: 'button', on: { click: async () => { if (await openPackFile()) { if (installedPacks('translation').length) finishIfReady(); } } } }, icon('upload'), t('packs', 'Open a file…'));

  const finishIfReady = () => {
    if (!installedPacks('translation').length) return;
    updateSettings({ onboarded: true });
    done();
  };

  const checkList = (entries: (CatalogTranslation | CatalogCommentary)[], chosen: Set<string>) =>
    h(
      'div',
      { class: 'pack-list' },
      entries.map((entry) => {
        const box = h('input', { type: 'checkbox', checked: chosen.has(entry.id) });
        box.addEventListener('change', () => (box.checked ? chosen.add(entry.id) : chosen.delete(entry.id)));
        return h(
          'label',
          { class: 'pack checkable' },
          box,
          h('div', { class: 'info' }, h('div', { class: 'name' }, entry.name), h('div', { class: 'meta' }, [entry.lang.toUpperCase(), formatBytes(entry.bytes), entry.license].filter(Boolean).join(' · '))),
        );
      }),
    );

  const stepOne = () => {
    clear(
      page,
      steps(1),
      h('h1', null, t('onboarding', 'Which translations to download?')),
      h('p', null, t('onboarding', 'They are kept in this browser and work without the internet. More can be added later in the menu.')),
      catalog
        ? checkList(catalog.translations, chosenTranslations)
        : h('p', { class: 'hint' }, canDownload() ? t('onboarding', 'The list could not be loaded (no internet?). You can open a translation file instead.') : t('onboarding', 'This copy downloads nothing: open a translation file (.json or .json.gz) from your computer.')),
      h('div', { class: 'row' }, catalog ? h('button', { type: 'button', class: 'button primary', on: { click: () => (chosenTranslations.size ? stepTwo() : toast(t('onboarding', 'Choose at least one translation.'), 'error')) } }, t('onboarding', 'Next')) : null, fileButton()),
    );
  };

  const stepTwo = () => {
    clear(
      page,
      steps(2),
      h('h1', null, t('onboarding', 'And commentaries?')),
      h('p', null, t('onboarding', 'Commentaries are shown next to the verses. Big ones load a book at a time, as you read.')),
      catalog?.commentaries.length ? checkList(catalog.commentaries, chosenCommentaries) : h('p', { class: 'hint' }, t('onboarding', 'No commentaries in the catalog yet.')),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'button', on: { click: stepOne } }, icon('left'), t('onboarding', 'Back')),
        h('button', { type: 'button', class: 'button primary', on: { click: install } }, icon('download'), t('onboarding', 'Download')),
        fileButton(),
      ),
    );
  };

  const install = async () => {
    if (!catalog) return;
    const jobs = [
      ...catalog.translations.filter((e) => chosenTranslations.has(e.id)).map((e) => ({ name: e.name, run: (p: (l: number, total: number) => void) => installCatalogTranslation(e, p) })),
      ...catalog.commentaries.filter((e) => chosenCommentaries.has(e.id)).map((e) => ({ name: e.name, run: (p: (l: number, total: number) => void) => installCatalogCommentary(e, false, p) })),
    ];
    const rows = jobs.map((job) => ({ job, bar: progressBar(), status: h('div', { class: 'meta' }, t('onboarding', 'Waiting')) }));
    clear(
      page,
      h('h1', null, t('onboarding', 'Downloading…')),
      h('div', { class: 'pack-list' }, rows.map((r) => h('div', { class: 'pack' }, h('div', { class: 'info' }, h('div', { class: 'name' }, r.job.name), r.status, r.bar.element)))),
    );
    let failed = 0;
    for (const row of rows) {
      row.status.textContent = t('onboarding', 'Downloading');
      try {
        const meta = await row.job.run(row.bar.set);
        row.bar.set(1, 1);
        row.status.textContent = t('onboarding', 'Done');
        if (meta.kind === 'translation' && !settings.translation) updateSettings({ translation: meta.id });
      } catch (error) {
        failed += 1;
        row.status.textContent = (error as Error).message;
        row.status.classList.add('error');
      }
    }
    if (installedPacks('translation').length && !failed) finishIfReady();
    else page.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'button primary', on: { click: () => (installedPacks('translation').length ? finishIfReady() : stepOne()) } }, installedPacks('translation').length ? t('onboarding', 'Start reading') : t('onboarding', 'Try again'))));
  };

  stepOne();
}

/* ---------------- settings: installed and available ---------------- */

export async function packsSection(onChange: () => void): Promise<HTMLElement> {
  const section = h('section', { class: 'settings-section' }, h('h2', null, t('packs', 'Translations and commentaries')));
  let catalog: Catalog | null = null;
  try {
    catalog = await fetchCatalog();
  } catch {
    catalog = null;
  }
  const installed = installedPacks();
  const row = (meta: PackMeta) =>
    h(
      'div',
      { class: 'pack' },
      icon(meta.kind === 'translation' ? 'book' : 'comment'),
      h(
        'div',
        { class: 'info' },
        h('div', { class: 'name' }, meta.name, meta.shortName ? ` (${meta.shortName})` : ''),
        h('div', { class: 'meta' }, [meta.kind === 'translation' ? t('packs', 'translation') : t('packs', 'commentary'), meta.lang.toUpperCase(), formatBytes(meta.bytes), meta.origin === 'file' ? t('packs', 'from a file') : `v${meta.version}`].join(' · ')),
      ),
      hasUpdate(meta, catalog)
        ? h('button', { type: 'button', class: 'button small', on: { click: async () => { const entry = meta.kind === 'translation' ? catalog!.translations.find((e) => e.id === meta.id) : undefined; const c = catalog!.commentaries.find((e) => e.id === meta.id); try { if (entry) await installCatalogTranslation(entry); else if (c) await installCatalogCommentary(c, false); toast(t('packs', 'Updated')); onChange(); } catch (e) { toast((e as Error).message, 'error'); } } } }, t('packs', 'Update'))
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          title: t('packs', 'Remove'),
          'aria-label': t('packs', 'Remove'),
          on: {
            click: async () => {
              if (meta.kind === 'translation' && installedPacks('translation').length === 1) return toast(t('packs', 'At least one translation must stay.'), 'error');
              if (!(await confirmDialog(t('packs', 'Remove “{name}”?', { name: meta.name }), t('packs', 'It can be downloaded or opened again later.'), t('packs', 'Remove'), true))) return undefined;
              await removePack(meta.id);
              if (settings.translation === meta.id) updateSettings({ translation: installedPacks('translation')[0]?.id ?? null });
              if (settings.parallel === meta.id) updateSettings({ parallel: null });
              onChange();
              return undefined;
            },
          },
        },
        icon('trash'),
      ),
    );
  section.appendChild(h('div', { class: 'pack-list' }, installed.map(row)));

  const available = [
    ...(catalog?.translations ?? []).filter((e) => !installed.some((p) => p.id === e.id)).map((e) => ({ kind: 'translation' as const, entry: e })),
    ...(catalog?.commentaries ?? []).filter((e) => !installed.some((p) => p.id === e.id)).map((e) => ({ kind: 'commentary' as const, entry: e })),
  ];
  if (available.length) {
    section.appendChild(h('h2', null, t('packs', 'Available to download')));
    section.appendChild(
      h(
        'div',
        { class: 'pack-list' },
        available.map(({ kind, entry }) => {
          const bar = progressBar();
          bar.element.hidden = true;
          const button = h(
            'button',
            {
              type: 'button',
              class: 'button small',
              on: {
                click: async () => {
                  button.disabled = true;
                  bar.element.hidden = false;
                  try {
                    if (kind === 'translation') await installCatalogTranslation(entry as CatalogTranslation, bar.set);
                    else await installCatalogCommentary(entry as CatalogCommentary, false, bar.set);
                    toast(t('packs', 'Downloaded'));
                    onChange();
                  } catch (error) {
                    toast((error as Error).message, 'error');
                    button.disabled = false;
                  }
                },
              },
            },
            icon('download'),
            t('packs', 'Download'),
          );
          return h('div', { class: 'pack' }, icon(kind === 'translation' ? 'book' : 'comment'), h('div', { class: 'info' }, h('div', { class: 'name' }, entry.name), h('div', { class: 'meta' }, [entry.lang.toUpperCase(), formatBytes(entry.bytes), entry.license].join(' · ')), bar.element), button);
        }),
      ),
    );
  } else if (!catalog && canDownload()) {
    section.appendChild(h('p', { class: 'hint' }, t('packs', 'The catalog could not be loaded (no internet?).')));
  }
  section.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '10px' } },
      h('button', { type: 'button', class: 'button', on: { click: async () => { if (await openPackFile()) onChange(); } } }, icon('upload'), t('packs', 'Open a file…')),
      h('span', { class: 'hint' }, t('packs', 'A translation or commentary in JSON (.json or .json.gz). You can also drop it on the window.')),
    ),
  );
  return section;
}
