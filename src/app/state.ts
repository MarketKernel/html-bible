/**
 * Settings, kept in localStorage and applied to the page: language, theme,
 * text size. Another tab of the same page that changes them is heard through
 * the storage event, so the two never overwrite each other with stale copies.
 */

import { detectLanguage, type Language, setLanguage } from '../core/i18n';
import { parseSettings, type Settings } from '../core/settings';
import type { Lang } from '../core/types';

const KEY = 'html-bible.settings';

function read(): Settings {
  try {
    return parseSettings(localStorage.getItem(KEY));
  } catch {
    return parseSettings(null);
  }
}

export let settings: Settings = read();

const listeners = new Set<(changed: Partial<Settings>) => void>();
export function onSettingsChange(listener: (changed: Partial<Settings>) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or full: the settings live for this visit.
  }
  apply();
  for (const listener of listeners) listener(patch);
}

window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  settings = read();
  apply();
  for (const listener of listeners) listener(settings);
});

export function uiLang(): Lang {
  return settings.lang === 'auto' ? (detectLanguage() as Lang) : settings.lang;
}

const dark = matchMedia('(prefers-color-scheme: dark)');
dark.addEventListener('change', () => apply());

export function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = settings.theme === 'system' ? (dark.matches ? 'dark' : 'light') : settings.theme;
  root.dataset.font = settings.font;
  root.style.setProperty('--text-size', `${settings.fontSize}px`);
  setLanguage(uiLang() as Language);
}
