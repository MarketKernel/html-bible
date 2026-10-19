/**
 * A discussion saved to a file: the topic as the API gave it (both languages,
 * subtopics, verses with both ratings, interpretations), stamped with where
 * and when it was taken. What the viewer voted (`votes.mine`) is theirs, not
 * the discussion's, so it is left out: the file can be passed on.
 */

import type { QuestionFull } from './api-types';

export interface DiscussionFile extends QuestionFull {
  format: 'html-bible/discussion';
  formatVersion: 1;
  /** ISO time of the export. */
  exportedAt: string;
  /** The API it came from. */
  source: string;
}

function withoutMine<T>(item: T): T {
  const votes = (item as { votes?: Record<string, unknown> }).votes;
  if (!votes || !('mine' in votes)) return item;
  const { mine: _mine, ...rest } = votes;
  return { ...item, votes: rest };
}

export function discussionFile(full: QuestionFull, source: string, now = new Date()): DiscussionFile {
  return {
    format: 'html-bible/discussion',
    formatVersion: 1,
    exportedAt: now.toISOString(),
    source,
    question: full.question,
    arguments: full.arguments,
    verses: full.verses.map(withoutMine),
    interpretations: full.interpretations.map(withoutMine),
  };
}

/** "discussion-is-the-trinity-biblical-2026-10-18.json": the title's words, any script. */
export function discussionFileName(title: string, now = new Date()): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `discussion-${words ? `${words}-` : ''}${now.toISOString().slice(0, 10)}.json`;
}
