/**
 * Small pieces shown wherever people and times are: a member's name as a link
 * to their profile, and a moment in the reader's time zone (core/time.ts).
 */

import type { Person } from '../core/api-types';
import { t } from '../core/i18n';
import { formatRoute } from '../core/route';
import { formatTime, fullTime } from '../core/time';
import { h } from './dom';
import { uiLang } from './state';

export function personLink(person: Person | undefined | null): HTMLElement {
  if (!person) return h('span', null, '—');
  return h('a', { class: 'person', href: formatRoute({ name: 'user', id: person.id }) }, person.displayName);
}

/** <time> with the short form shown and the whole moment in its tooltip. */
export function timeTag(iso: string): HTMLElement {
  const lang = uiLang();
  return h('time', { datetime: iso, title: fullTime(iso, lang) }, formatTime(iso, lang));
}

/** "5 мар., 14:05", and "· изменено 6 мар., 09:12" after an edit. */
export function when(created: string | undefined, updated?: string): HTMLElement | null {
  if (!created) return null;
  return h('span', { class: 'when' }, timeTag(created), updated && updated !== created ? [' · ', t('time', 'edited'), ' ', timeTag(updated)] : null);
}
