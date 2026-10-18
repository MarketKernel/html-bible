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
  /** The discussions API, "…/v1/". Empty — no server. */
  apiUrl: string;
  auth: {
    /** Cognito domain (or the local stub): /oauth2/authorize, /oauth2/token, /logout. */
    issuer: string;
    clientId: string;
    providers: ('google' | 'apple' | 'microsoft')[];
    /**
     * The site. A page opened from file:// sends the user here to sign in,
     * and reads a relative dataUrl from here.
     */
    siteUrl: string;
  };
}

declare const __CONFIG__: AppConfig;

export const CONFIG: AppConfig =
  typeof __CONFIG__ === 'undefined'
    ? { dataUrl: '', apiUrl: '', auth: { issuer: '', clientId: '', providers: ['google', 'apple', 'microsoft'], siteUrl: '' } }
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
  const base = page.startsWith('file:') ? config.auth.siteUrl : page;
  return base ? new URL(config.dataUrl, base).href : '';
}
