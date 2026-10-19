/**
 * The address after "#": what the page shows.
 *
 * A verse link is the readable reference itself (#Synodal_Mat3-3?notes=0) or
 * free form (#Мф%202:3); the app's own screens start with "/" so they are never
 * taken for a book (#/discussions/…, #/compare/…, #/search?q=…, #/settings,
 * #/profile, #/users/<id>, #/join/<invitation code>).
 */

import { formatLink, type ParsedRef, parseLink, parseRef } from './refs';

export type Route =
  | { name: 'home' }
  | { name: 'read'; ref: ParsedRef; notes?: boolean; par?: string; comment?: string }
  | { name: 'compare'; ref: ParsedRef }
  | { name: 'search'; q: string; scope?: string; at?: string }
  | { name: 'discussions'; tag?: string }
  | { name: 'discussion'; id: string; argument?: string; verse?: string }
  | { name: 'settings' }
  | { name: 'profile' }
  | { name: 'user'; id: string }
  | { name: 'join'; code: string }
  | { name: 'unknown'; text: string };

function splitQuery(text: string): [string, URLSearchParams] {
  const at = text.indexOf('?');
  return at < 0 ? [text, new URLSearchParams()] : [text.slice(0, at), new URLSearchParams(text.slice(at + 1))];
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const ID = /^[\w-]{1,64}$/;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  if (!raw.trim()) return { name: 'home' };
  const [path, query] = splitQuery(raw);
  const text = decode(path).trim();

  if (text.startsWith('/')) {
    const segments = text.split('/').filter(Boolean);
    const [first, second, third, fourth] = segments;
    if (first === 'compare' && second) {
      const ref = parseRef(segments.slice(1).join('/'));
      if (ref) return { name: 'compare', ref };
    }
    if (first === 'settings' && !second) return { name: 'settings' };
    if (first === 'profile' && !second) return { name: 'profile' };
    if (first === 'users' && second && ID.test(second) && !third) return { name: 'user', id: second };
    // An invitation link: #/join/1-7-K3M9Q-T8ZR2 (spaces are kept for the code's own parser).
    if (first === 'join' && second && segments.length === 2 && /^[\w -]{5,40}$/.test(second)) return { name: 'join', code: second };
    if (first === 'search') {
      const route: Route = { name: 'search', q: query.get('q') ?? '' };
      const scope = query.get('in');
      if (scope) route.scope = scope;
      // The hit shown beside the list, in the translation's own numbering: "JHN.3.16".
      const at = query.get('at');
      if (at && /^[1-3A-Z]{3}\.\d{1,3}\.\d{1,3}$/.test(at)) route.at = at;
      return route;
    }
    if (first === 'discussions') {
      if (!second) {
        const tag = query.get('tag') ?? undefined;
        return tag ? { name: 'discussions', tag } : { name: 'discussions' };
      }
      if (ID.test(second)) {
        if (third === 'a' && fourth && ID.test(fourth)) return { name: 'discussion', id: second, argument: fourth };
        if (third === 'v' && fourth && ID.test(fourth)) return { name: 'discussion', id: second, verse: fourth };
        return { name: 'discussion', id: second };
      }
    }
    return { name: 'unknown', text };
  }

  const ref = parseRef(text);
  if (!ref) return { name: 'unknown', text };
  const route: Route = { name: 'read', ref };
  const notes = query.get('notes');
  if (notes === '0' || notes === '1') route.notes = notes === '1';
  const par = query.get('par');
  if (par && /^[A-Za-z][A-Za-z0-9]*$/.test(par)) route.par = par;
  const comment = query.get('c');
  if (comment && ID.test(comment)) route.comment = comment;
  return route;
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home':
      return '';
    case 'read': {
      const query = new URLSearchParams();
      if (route.notes !== undefined) query.set('notes', route.notes ? '1' : '0');
      if (route.par) query.set('par', route.par);
      if (route.comment) query.set('c', route.comment);
      const q = query.toString();
      return `#${formatLink(route.ref)}${q ? `?${q}` : ''}`;
    }
    case 'compare':
      return `#/compare/${formatLink({ book: route.ref.book, parts: route.ref.parts })}`;
    case 'search': {
      const query = new URLSearchParams({ q: route.q });
      if (route.scope) query.set('in', route.scope);
      if (route.at) query.set('at', route.at);
      return `#/search?${query.toString()}`;
    }
    case 'discussions':
      return route.tag ? `#/discussions?tag=${encodeURIComponent(route.tag)}` : '#/discussions';
    case 'discussion':
      if (route.argument) return `#/discussions/${route.id}/a/${route.argument}`;
      if (route.verse) return `#/discussions/${route.id}/v/${route.verse}`;
      return `#/discussions/${route.id}`;
    case 'settings':
      return '#/settings';
    case 'profile':
      return '#/profile';
    case 'user':
      return `#/users/${route.id}`;
    case 'join':
      return `#/join/${encodeURIComponent(route.code)}`;
    case 'unknown':
      return `#${encodeURIComponent(route.text)}`;
  }
}

/** True when the text is exactly a readable link (not free form) — used to keep links canonical. */
export function isReadableLink(text: string): boolean {
  return parseLink(text) !== undefined;
}
