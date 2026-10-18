/**
 * Between a translation's numbering and canonical keys, on the real Synodal and
 * KJV numbering: references in links, comment ranges, noncanonical verses.
 * The files are the test cut (tests/fixtures/data/), which keeps every book,
 * chapter and verse of the real ones, so this runs without data/.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checker, load, root } from '../tools/load.mjs';

const { check, done } = checker();
const C = await load('core/canon', 'core/refs');
const read = (id) => JSON.parse(gunzipSync(readFileSync(join(root, 'tests', 'fixtures', 'data', 'translations', `${id}.json.gz`))).toString('utf8'));
const syn = read('ru-synodal');
const kjv = read('en-kjv');

check('key of a Synodal psalm verse', C.toKey(syn, { book: 'PSA', chapter: 22, verse: 2 }), { book: 'PSA', chapter: 23, verse: 2 });
check('insertion has no key', C.toKey(syn, { book: 'DAN', chapter: 3, verse: 30 }), null);
check('deuterocanonical book has no key', C.toKey(syn, { book: 'TOB', chapter: 1, verse: 1 }), null);
check('after the insertion', C.toKey(syn, { book: 'DAN', chapter: 3, verse: 91 }), { book: 'DAN', chapter: 3, verse: 24 });
check('KJV is identity', C.toKey(kjv, { book: 'JHN', chapter: 3, verse: 16 }), { book: 'JHN', chapter: 3, verse: 16 });

check('Synodal ref → canonical ranges', C.refToRanges(syn, C.parseLink('Synodal_Psa22-2-4')), [{ from: 'PSA.23.2', to: 'PSA.23.4' }]);
check('range across an insertion shrinks', C.refToRanges(syn, C.parseLink('Synodal_Dan3-23-25')), [{ from: 'DAN.3.23', to: 'DAN.3.23' }]);
check('only noncanonical → nothing', C.refToRanges(syn, C.parseLink('Synodal_Dan3-30')), []);
check('canonical ref → Synodal numbering', C.canonicalRefToNative(syn, C.parseLink('Psa23-1-2')), { book: 'PSA', parts: [{ chapter: 22, verse: 1, endVerse: 2 }] });
check('canonical chapter → Synodal chapter', C.canonicalRefToNative(syn, C.parseLink('Psa23')), { book: 'PSA', parts: [{ chapter: 22 }] });
check('Malachi 4:5 the same in both', C.canonicalRefToNative(syn, C.parseLink('Mal4-5')), { book: 'MAL', parts: [{ chapter: 4, verse: 5 }] });
check('range → Synodal verses', C.rangeToNative(syn, { from: 'ROM.16.25', to: 'ROM.16.27' }).map((v) => `${v.chapter}:${v.verse}`), ['14:24', '14:25', '14:26']);
check('range contains', [C.rangeContains({ from: 'JHN.3.16', to: 'JHN.3.18' }, { book: 'JHN', chapter: 3, verse: 17 }), C.rangeContains({ from: 'JHN.3.16', to: 'JHN.3.18' }, { book: 'JHN', chapter: 4, verse: 1 })], [true, false]);
check('ranges overlap', C.rangesOverlap({ from: 'JHN.3.16', to: 'JHN.3.18' }, { from: 'JHN.3.18', to: 'JHN.4.2' }), true);
check('parse range', C.parseRange('1CO.13.4-1CO.13.7'), { from: '1CO.13.4', to: '1CO.13.7' });
check('canonical verse count', C.canonicalVerseCount('PSA', 119), 176);

check('Synodal text ref → canonical', C.schemeRefToCanonical('synodal', C.parseFree('Пс 90:11')), { book: 'PSA', parts: [{ chapter: 91, verse: 11 }] });
check('Synodal range → canonical', C.schemeRefToCanonical('synodal', C.parseFree('Пс 50:3-5')), { book: 'PSA', parts: [{ chapter: 51, verse: 1, endVerse: 3 }] });
check('KJV scheme unchanged', C.schemeRefToCanonical('kjv', C.parseFree('Ps 23:1')), { book: 'PSA', parts: [{ chapter: 23, verse: 1 }] });

done('canon');
