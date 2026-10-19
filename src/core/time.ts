/**
 * Times as people read them. The API keeps and sends UTC (ISO 8601 with "Z");
 * the page shows them in the browser's time zone and the interface language:
 * today "14:05", this year "5 мар., 14:05", earlier "5 мар. 2025 г., 14:05".
 * `timeZone` is for tests; the page leaves it to the browser.
 */

function dayOf(date: Date, timeZone?: string): string {
  // en-CA writes YYYY-MM-DD: a plain string to compare days by.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function formatTime(iso: string, lang: string, now = new Date(), timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = dayOf(at, timeZone);
  const today = dayOf(now, timeZone);
  const clock: Intl.DateTimeFormatOptions = { timeZone, hour: '2-digit', minute: '2-digit' };
  if (day === today) return new Intl.DateTimeFormat(lang, clock).format(at);
  const year = day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' as const };
  return new Intl.DateTimeFormat(lang, { ...clock, day: 'numeric', month: 'short', ...year }).format(at);
}

/** The whole moment with its time zone: for a tooltip. */
export function fullTime(iso: string, lang: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(lang, { timeZone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(at);
}

/** A day "YYYY-MM-DD" (UTC midnight, as the server's dates are) in the reader's terms. */
export function formatDay(day: string, lang: string, timeZone?: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat(lang, { timeZone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(at);
}
