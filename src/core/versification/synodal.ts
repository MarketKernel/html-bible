/**
 * The Russian Synodal versification compared with the KJV one, the canonical
 * scheme of the app.
 *
 * Where the data comes from: the CrossWire SWORD "Synodal" versification
 * (include/canon_synodal.h, the mappings_synodal array) and the Paratext
 * "Russian Orthodox" versification (rso.vrs, read against eng.vrs). The two
 * agree on almost everything; where they did not, and where both missed a
 * difference (2 Cor 11:32–33, Isa 3:19–20, 1 Sam 20:42), the texts themselves
 * decided. tools/translations/verify-versification.mjs re-checks these rules
 * against the converted Synodal and KJV files: every Synodal verse of a
 * canonical book maps to an existing KJV verse or is listed as noncanonical,
 * and every KJV verse has a Synodal counterpart or is listed as missing.
 *
 * Rules are written as "native = KJV", chapter:verse ranges within one chapter
 * on each side. Equal lengths pair verse by verse; a single verse on one side
 * stands for the whole range on the other (a Synodal verse joining two KJV
 * verses, or a Psalm title verse merging into KJV verse 1). Rules may share a
 * KJV verse (Ps 86:1 and 86:2 both hold KJV 87:1). Verses no rule mentions
 * keep their numbers.
 */
import type { BookId } from '../books';

export const SYNODAL_RULES: Partial<Record<BookId, readonly string[]>> = {
  LEV: ['14:55 = 14:55-56', '14:56 = 14:57'],
  NUM: ['13:1 = 12:16', '13:2-34 = 13:1-33', '30:1 = 29:40', '30:2-17 = 30:1-16'],
  JOS: ['5:16 = 6:1', '6:1-26 = 6:2-27'],
  // The Synodal splits the KJV's last verse of chapter 20 in two.
  '1SA': ['20:42-43 = 20:42', '24:1 = 23:29', '24:2-23 = 24:1-22'],
  JOB: ['39:31-35 = 40:1-5', '40:1-19 = 40:6-24', '40:20-27 = 41:1-8', '41:1-26 = 41:9-34'],
  // Psalms whose verses do not follow the plain pattern of SYNODAL_PSALMS:
  // two psalms joined (9 = KJV 9–10, 113 = KJV 114–115), one psalm split
  // (114–115 = KJV 116, 146–147 = KJV 147), and a Synodal verse here and there
  // that joins two KJV verses.
  PSA: [
    '9:1-2 = 9:1', '9:3-21 = 9:2-20', '9:22-39 = 10:1-18',
    '12:1-2 = 13:1', '12:3-5 = 13:2-4', '12:6 = 13:5-6',
    '86:1 = 87:1', '86:2 = 87:1-2', '86:3-7 = 87:3-7',
    '89:1-2 = 90:1', '89:3-5 = 90:2-4', '89:6 = 90:5-6', '89:7-17 = 90:7-17',
    '113:1-8 = 114:1-8', '113:9-26 = 115:1-18',
    '114:1-7 = 116:1-7', '114:8 = 116:8-9', '115:1-10 = 116:10-19',
    '146:1-11 = 147:1-11', '147:1-9 = 147:12-20',
  ],
  // Synodal 13:14 and 18:8 are Septuagint additions (noncanonical below).
  PRO: ['13:15-26 = 13:14-25', '18:9-25 = 18:8-24'],
  ECC: ['4:17 = 5:1', '5:1-19 = 5:2-20'],
  // The KJV's 1:1 ("The song of songs, which is Solomon's") is the book title
  // in the Synodal, not a verse: see SYNODAL_MISSING.
  SNG: ['1:1-16 = 1:2-17', '7:1 = 6:13', '7:2-14 = 7:1-13'],
  ISA: ['3:19 = 3:19-20', '3:20-25 = 3:21-26'],
  // Synodal 3:24–90 (the Song of the Three) has no KJV counterpart; 3:91–100
  // is KJV 3:24–30 and 4:1–3.
  DAN: ['3:91-97 = 3:24-30', '3:98-100 = 4:1-3', '4:1-34 = 4:4-37'],
  HOS: ['14:1 = 13:16', '14:2-10 = 14:1-9'],
  JON: ['2:1 = 1:17', '2:2-11 = 2:1-10'],
  ACT: ['19:40 = 19:40-41'],
  // The doxology stands at the end of chapter 14 in the Synodal.
  ROM: ['14:24-26 = 16:25-27'],
  '2CO': ['11:32 = 11:32-33', '13:12 = 13:12-13', '13:13 = 13:14'],
  '3JN': ['1:14-15 = 1:14'],
  // Same verse count, different division: Synodal 20:7 runs on through KJV
  // 20:8 (Gog and Magog), and KJV 20:9 is Synodal 20:8–9. Neither CrossWire
  // nor Paratext maps it; the texts show it (both Synodal sources agree).
  REV: ['20:7 = 20:7-8', '20:8-9 = 20:9'],
};

/**
 * The Synodal Psalter is numbered after the Septuagint: KJV Psalms 10–113 and
 * 117–146 are one lower (see SYNODAL_RULES for those joined and split), and a
 * title counts as a verse of its own. [first native psalm, last native psalm,
 * KJV psalm − native psalm].
 */
export const SYNODAL_PSALM_CHAPTERS: readonly (readonly [number, number, number])[] = [
  [1, 8, 0],
  [10, 112, 1],
  [116, 145, 1],
  [148, 150, 0],
];

/**
 * Native psalms whose title takes one (or two) verses before KJV verse 1:
 * native verses 1…n+1 are KJV verse 1, the rest are n lower. In the other
 * psalms the title, if any, shares verse 1 with the text, as in the KJV.
 */
export const SYNODAL_PSALM_TITLE_VERSES: Readonly<Record<1 | 2, readonly number[]>> = {
  1: [
    3, 4, 5, 6, 7, 8, 11, 17, 18, 19, 20, 21, 29, 30, 33, 35, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 48,
    52, 54, 55, 56, 57, 58, 60, 61, 62, 63, 64, 66, 67, 68, 69, 74, 75, 76, 79, 80, 82, 83, 84, 87, 88,
    91, 101, 107, 139,
  ],
  2: [50, 51, 53, 59],
};

/**
 * Noncanonical insertions inside canonical books, in Synodal numbering
 * ("chapter.verse-chapter.verse"): Septuagint text with no KJV counterpart.
 * The Prayer of Manasseh, a separate book in some editions, follows
 * 2 Chronicles 36:23 as verses 24–35. Additions inside a verse (Esther, many
 * bracketed phrases) cannot be told apart by numbers and stay canonical.
 */
export const SYNODAL_NONCANONICAL: Partial<Record<BookId, readonly string[]>> = {
  JOS: ['24.34-24.36'],
  '2CH': ['36.24-36.35'],
  PSA: ['151.1-151.7'],
  PRO: ['4.28-4.29', '13.14-13.14', '18.8-18.8'],
  DAN: ['3.24-3.90', '13.1-14.42'],
};

/** KJV verses the Synodal has no verse for ("chapter.verse"). */
export const SYNODAL_MISSING: Partial<Record<BookId, readonly string[]>> = {
  SNG: ['1.1'],
};
