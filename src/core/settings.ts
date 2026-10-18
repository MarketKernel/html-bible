/**
 * The page's settings: one JSON object in localStorage. Every field is checked
 * when read — an unknown, missing or broken value becomes the default — so an
 * old or hand-edited value can never break the start.
 */

export interface Settings {
  lang: 'auto' | 'ru' | 'en';
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  font: 'serif' | 'sans';
  /** The translation being read. */
  translation: string | null;
  /** A second one beside it, or none. */
  parallel: string | null;
  showNotes: boolean;
  /** Words the translators added, in [brackets]: italic, or hidden. */
  addedWords: 'italic' | 'hidden' | 'plain';
  hideNoncanonicalBooks: boolean;
  copyFormat: 'quote' | 'ref-first' | 'numbered';
  copyWithLink: boolean;
  /** Commentaries the reader chose not to see. */
  hiddenCommentaries: string[];
  /** Translations left out of comparison, and their order. */
  compareHidden: string[];
  compareOrder: string[];
  lastRead: { book: string; chapter: number } | null;
  onboarded: boolean;
  searchNoncanonical: boolean;
}

export const DEFAULTS: Settings = {
  lang: 'auto',
  theme: 'system',
  fontSize: 19,
  font: 'serif',
  translation: null,
  parallel: null,
  showNotes: true,
  addedWords: 'italic',
  hideNoncanonicalBooks: false,
  copyFormat: 'quote',
  copyWithLink: false,
  hiddenCommentaries: [],
  compareHidden: [],
  compareOrder: [],
  lastRead: null,
  onboarded: false,
  searchNoncanonical: true,
};

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const id = (value: unknown) => (typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : null);
const ids = (value: unknown) => (Array.isArray(value) ? value.map(id).filter((v): v is string => v !== null).slice(0, 200) : []);

export function parseSettings(raw: string | null): Settings {
  let json: Record<string, unknown> = {};
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (value && typeof value === 'object' && !Array.isArray(value)) json = value;
  } catch {
    // A broken value is the same as none.
  }
  const fontSize = typeof json.fontSize === 'number' && json.fontSize >= 14 && json.fontSize <= 32 ? Math.round(json.fontSize) : DEFAULTS.fontSize;
  const last = json.lastRead as Record<string, unknown> | undefined;
  const lastRead =
    last && typeof last.book === 'string' && /^[1-3A-Z]{3}$/.test(last.book) && typeof last.chapter === 'number' && last.chapter >= 1 && last.chapter <= 200
      ? { book: last.book, chapter: Math.floor(last.chapter) }
      : null;
  return {
    lang: oneOf(json.lang, ['auto', 'ru', 'en'], DEFAULTS.lang),
    theme: oneOf(json.theme, ['system', 'light', 'dark'], DEFAULTS.theme),
    fontSize,
    font: oneOf(json.font, ['serif', 'sans'], DEFAULTS.font),
    translation: id(json.translation),
    parallel: id(json.parallel),
    showNotes: bool(json.showNotes, DEFAULTS.showNotes),
    addedWords: oneOf(json.addedWords, ['italic', 'hidden', 'plain'], DEFAULTS.addedWords),
    hideNoncanonicalBooks: bool(json.hideNoncanonicalBooks, DEFAULTS.hideNoncanonicalBooks),
    copyFormat: oneOf(json.copyFormat, ['quote', 'ref-first', 'numbered'], DEFAULTS.copyFormat),
    copyWithLink: bool(json.copyWithLink, DEFAULTS.copyWithLink),
    hiddenCommentaries: ids(json.hiddenCommentaries),
    compareHidden: ids(json.compareHidden),
    compareOrder: ids(json.compareOrder),
    lastRead,
    onboarded: bool(json.onboarded, DEFAULTS.onboarded),
    searchNoncanonical: bool(json.searchNoncanonical, DEFAULTS.searchNoncanonical),
  };
}
