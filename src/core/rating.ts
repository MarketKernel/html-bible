/**
 * Showing the two ratings of a discussion: the AI's and the users'. Each verse
 * is one point; the server adds the points up (Tally), this module turns a
 * tally into the beam's lean (−100 … +100) and the lean into what the page draws.
 */

import type { Tally } from './api-types';

export const MAX_TILT = 20;

/** The beam's angle in degrees: positive tips toward "pro" (left pan down). */
export function tilt(lean: number | null | undefined): number {
  if (lean === null || lean === undefined || Number.isNaN(lean)) return 0;
  return Math.max(-MAX_TILT, Math.min(MAX_TILT, lean * 0.2));
}

/** A tally → −100 … +100 for the beam: (pro − con) / (pro + con); null with no points either way. */
export function tallyLean(tally: Pick<Tally, 'pro' | 'con'> | undefined): number | null {
  if (!tally) return null;
  const total = tally.pro + tally.con;
  return total ? Math.round(((tally.pro - tally.con) / total) * 100) : null;
}

/** "+42", "−17", "0", "—" */
export function formatLean(lean: number | null | undefined): string {
  if (lean === null || lean === undefined || Number.isNaN(lean)) return '—';
  const rounded = Math.round(lean);
  if (rounded > 0) return `+${rounded}`;
  if (rounded < 0) return `−${-rounded}`;
  return '0';
}

/** Which way a lean points, for colours and words. */
export function side(lean: number | null | undefined, dead = 10): 'pro' | 'con' | 'even' | 'none' {
  if (lean === null || lean === undefined || Number.isNaN(lean)) return 'none';
  if (lean > dead) return 'pro';
  if (lean < -dead) return 'con';
  return 'even';
}
