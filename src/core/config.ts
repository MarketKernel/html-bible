/**
 * Addresses the build puts in (config/build.json, overridden by flags and
 * environment variables — see build.mjs). The page has no site address of its
 * own: links are made from where it is opened.
 */

export interface AppConfig {
  /**
   * Where catalog.json, translations and commentaries are. Ends with "/".
   * Relative ("data/") — beside the page, as on the site that hosts both.
   * Empty — nothing to download: the user opens files.
   */
  dataUrl: string;
  /** The discussions API with its sign-in, "…/v1/". Empty — no server. */
  apiUrl: string;
  /** The site: a page opened from file:// reads a relative dataUrl from here. */
  siteUrl: string;
}

declare const __CONFIG__: AppConfig;

export const CONFIG: AppConfig =
  typeof __CONFIG__ === 'undefined'
    ? { dataUrl: '', apiUrl: '', siteUrl: '' }
    : __CONFIG__;

/**
 * The data folder as an absolute address, or '' when this build downloads
 * nothing. A relative dataUrl is resolved against the page — so one build
 * works on any domain or preview address the site gets — except for a page
 * opened from disk, which has no folder of data beside it and reads the site's.
 */
export function dataBase(config: AppConfig, page: string): string {
  if (!config.dataUrl) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(config.dataUrl)) return config.dataUrl;
  const base = page.startsWith('file:') ? config.siteUrl : page;
  return base ? new URL(config.dataUrl, base).href : '';
}
