/**
 * src/core/versification/map.ts: fixed vectors for every Synodal ⇄ KJV
 * difference (both directions), KJV identity, noncanonical books and
 * insertions, and a full round trip over every KJV verse.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const { versification, noncanonicalRanges } = await load('core/versification/map');
const { KJV_COUNTS } = await load('core/versification/kjv-counts');
const { EXTRA_BOOKS } = await load('core/books');

const S = versification('synodal');
const K = versification('kjv');

const parse = (ref) => {
  const m = /^(\w{3}) (\d+):(\d+)$/.exec(ref);
  return { book: m[1], chapter: Number(m[2]), verse: Number(m[3]) };
};
const show = (loc) => (loc ? `${loc.book} ${loc.chapter}:${loc.verse}` : null);
const to = (v, ref) => show(v.toCanonical(parse(ref)));
const toAll = (v, ref) => v.toCanonicalAll(parse(ref)).map(show);
const from = (v, ref) => v.fromCanonical(parse(ref)).map(show);

// KJV and unknown schemes: identity.
for (const v of [K, versification('no-such-scheme')]) {
  check(`${v.id}: GEN 1:1`, to(v, 'GEN 1:1'), 'GEN 1:1');
  check(`${v.id}: PSA 23:1`, [to(v, 'PSA 23:1'), from(v, 'PSA 23:1')], ['PSA 23:1', ['PSA 23:1']]);
  check(`${v.id}: MAL 4:5`, from(v, 'MAL 4:5'), ['MAL 4:5']);
  check(`${v.id}: TOB has no canonical key`, [to(v, 'TOB 1:1'), v.isNoncanonical(parse('TOB 1:1'))], [null, true]);
  check(`${v.id}: canonical is not noncanonical`, v.isNoncanonical(parse('DAN 3:24')), false);
}
check('versification() is cached', versification('synodal') === S, true);

// Synodal → KJV (toCanonical) and back (fromCanonical), every known difference.
// [Synodal verse, KJV verse it maps to (the first, if several)]
const forward = [
  ['GEN 1:1', 'GEN 1:1'], ['GEN 31:55', 'GEN 31:55'], ['EXO 8:1', 'EXO 8:1'], ['EXO 22:1', 'EXO 22:1'],
  ['LEV 6:1', 'LEV 6:1'], ['LEV 14:55', 'LEV 14:55'], ['LEV 14:56', 'LEV 14:57'],
  ['NUM 12:15', 'NUM 12:15'], ['NUM 13:1', 'NUM 12:16'], ['NUM 13:2', 'NUM 13:1'], ['NUM 13:34', 'NUM 13:33'],
  ['NUM 16:36', 'NUM 16:36'], ['NUM 30:1', 'NUM 29:40'], ['NUM 30:2', 'NUM 30:1'], ['NUM 30:17', 'NUM 30:16'],
  ['JOS 5:15', 'JOS 5:15'], ['JOS 5:16', 'JOS 6:1'], ['JOS 6:1', 'JOS 6:2'], ['JOS 6:26', 'JOS 6:27'], ['JOS 24:33', 'JOS 24:33'],
  ['1SA 20:42', '1SA 20:42'], ['1SA 20:43', '1SA 20:42'], ['1SA 24:1', '1SA 23:29'], ['1SA 24:2', '1SA 24:1'], ['1SA 24:23', '1SA 24:22'],
  ['1KI 4:21', '1KI 4:21'], ['1KI 5:1', '1KI 5:1'], ['1CH 6:1', '1CH 6:1'], ['NEH 4:1', 'NEH 4:1'], ['NEH 7:68', 'NEH 7:68'],
  ['JOB 39:30', 'JOB 39:30'], ['JOB 39:31', 'JOB 40:1'], ['JOB 39:35', 'JOB 40:5'], ['JOB 40:1', 'JOB 40:6'], ['JOB 40:19', 'JOB 40:24'],
  ['JOB 40:20', 'JOB 41:1'], ['JOB 40:27', 'JOB 41:8'], ['JOB 41:1', 'JOB 41:9'], ['JOB 41:26', 'JOB 41:34'],
  ['PSA 1:1', 'PSA 1:1'], ['PSA 2:12', 'PSA 2:12'], ['PSA 3:1', 'PSA 3:1'], ['PSA 3:2', 'PSA 3:1'], ['PSA 3:3', 'PSA 3:2'], ['PSA 3:9', 'PSA 3:8'],
  ['PSA 8:10', 'PSA 8:9'], ['PSA 9:1', 'PSA 9:1'], ['PSA 9:2', 'PSA 9:1'], ['PSA 9:21', 'PSA 9:20'], ['PSA 9:22', 'PSA 10:1'], ['PSA 9:39', 'PSA 10:18'],
  ['PSA 10:1', 'PSA 11:1'], ['PSA 10:7', 'PSA 11:7'], ['PSA 11:1', 'PSA 12:1'], ['PSA 11:9', 'PSA 12:8'],
  ['PSA 12:1', 'PSA 13:1'], ['PSA 12:2', 'PSA 13:1'], ['PSA 12:5', 'PSA 13:4'], ['PSA 12:6', 'PSA 13:5'],
  ['PSA 17:51', 'PSA 18:50'], ['PSA 22:1', 'PSA 23:1'], ['PSA 22:6', 'PSA 23:6'], ['PSA 41:12', 'PSA 42:11'], ['PSA 42:5', 'PSA 43:5'],
  ['PSA 50:1', 'PSA 51:1'], ['PSA 50:3', 'PSA 51:1'], ['PSA 50:4', 'PSA 51:2'], ['PSA 50:21', 'PSA 51:19'], ['PSA 59:14', 'PSA 60:12'],
  ['PSA 86:1', 'PSA 87:1'], ['PSA 86:2', 'PSA 87:1'], ['PSA 86:3', 'PSA 87:3'], ['PSA 89:1', 'PSA 90:1'], ['PSA 89:2', 'PSA 90:1'],
  ['PSA 89:6', 'PSA 90:5'], ['PSA 89:7', 'PSA 90:7'], ['PSA 89:17', 'PSA 90:17'], ['PSA 90:16', 'PSA 91:16'],
  ['PSA 112:9', 'PSA 113:9'], ['PSA 113:8', 'PSA 114:8'], ['PSA 113:9', 'PSA 115:1'], ['PSA 113:26', 'PSA 115:18'],
  ['PSA 114:1', 'PSA 116:1'], ['PSA 114:8', 'PSA 116:8'], ['PSA 115:1', 'PSA 116:10'], ['PSA 115:10', 'PSA 116:19'],
  ['PSA 116:2', 'PSA 117:2'], ['PSA 118:176', 'PSA 119:176'], ['PSA 138:24', 'PSA 139:24'], ['PSA 139:1', 'PSA 140:1'], ['PSA 139:14', 'PSA 140:13'],
  ['PSA 145:10', 'PSA 146:10'], ['PSA 146:1', 'PSA 147:1'], ['PSA 146:11', 'PSA 147:11'], ['PSA 147:1', 'PSA 147:12'], ['PSA 147:9', 'PSA 147:20'],
  ['PSA 148:14', 'PSA 148:14'], ['PSA 150:6', 'PSA 150:6'],
  ['PRO 4:27', 'PRO 4:27'], ['PRO 13:13', 'PRO 13:13'], ['PRO 13:15', 'PRO 13:14'], ['PRO 13:26', 'PRO 13:25'],
  ['PRO 18:7', 'PRO 18:7'], ['PRO 18:9', 'PRO 18:8'], ['PRO 18:25', 'PRO 18:24'],
  ['ECC 4:16', 'ECC 4:16'], ['ECC 4:17', 'ECC 5:1'], ['ECC 5:1', 'ECC 5:2'], ['ECC 5:19', 'ECC 5:20'],
  ['SNG 1:1', 'SNG 1:2'], ['SNG 1:16', 'SNG 1:17'], ['SNG 6:12', 'SNG 6:12'], ['SNG 7:1', 'SNG 6:13'], ['SNG 7:2', 'SNG 7:1'], ['SNG 7:14', 'SNG 7:13'],
  ['ISA 3:18', 'ISA 3:18'], ['ISA 3:19', 'ISA 3:19'], ['ISA 3:20', 'ISA 3:21'], ['ISA 3:25', 'ISA 3:26'], ['ISA 9:1', 'ISA 9:1'], ['ISA 64:1', 'ISA 64:1'],
  ['JER 9:1', 'JER 9:1'], ['EZK 20:45', 'EZK 20:45'], ['EZK 21:1', 'EZK 21:1'],
  ['DAN 3:23', 'DAN 3:23'], ['DAN 3:91', 'DAN 3:24'], ['DAN 3:97', 'DAN 3:30'], ['DAN 3:98', 'DAN 4:1'], ['DAN 3:100', 'DAN 4:3'],
  ['DAN 4:1', 'DAN 4:4'], ['DAN 4:34', 'DAN 4:37'], ['DAN 5:31', 'DAN 5:31'], ['DAN 6:1', 'DAN 6:1'], ['DAN 12:13', 'DAN 12:13'],
  ['HOS 1:10', 'HOS 1:10'], ['HOS 13:15', 'HOS 13:15'], ['HOS 14:1', 'HOS 13:16'], ['HOS 14:2', 'HOS 14:1'], ['HOS 14:10', 'HOS 14:9'],
  ['JOL 2:28', 'JOL 2:28'], ['JOL 3:1', 'JOL 3:1'], ['JOL 3:21', 'JOL 3:21'],
  ['JON 1:16', 'JON 1:16'], ['JON 2:1', 'JON 1:17'], ['JON 2:2', 'JON 2:1'], ['JON 2:11', 'JON 2:10'],
  ['MIC 5:1', 'MIC 5:1'], ['NAM 1:15', 'NAM 1:15'], ['ZEC 1:18', 'ZEC 1:18'], ['MAL 3:18', 'MAL 3:18'], ['MAL 4:1', 'MAL 4:1'], ['MAL 4:6', 'MAL 4:6'],
  ['MAT 1:1', 'MAT 1:1'], ['ACT 19:39', 'ACT 19:39'], ['ACT 19:40', 'ACT 19:40'],
  ['ROM 14:23', 'ROM 14:23'], ['ROM 14:24', 'ROM 16:25'], ['ROM 14:26', 'ROM 16:27'], ['ROM 16:24', 'ROM 16:24'],
  ['2CO 11:31', '2CO 11:31'], ['2CO 11:32', '2CO 11:32'], ['2CO 13:11', '2CO 13:11'], ['2CO 13:12', '2CO 13:12'], ['2CO 13:13', '2CO 13:14'],
  ['3JN 1:13', '3JN 1:13'], ['3JN 1:14', '3JN 1:14'], ['3JN 1:15', '3JN 1:14'],
  ['REV 20:6', 'REV 20:6'], ['REV 20:7', 'REV 20:7'], ['REV 20:8', 'REV 20:9'], ['REV 20:9', 'REV 20:9'], ['REV 20:10', 'REV 20:10'], ['REV 22:21', 'REV 22:21'],
];
for (const [native, kjv] of forward) {
  check(`toCanonical ${native}`, to(S, native), kjv);
  check(`fromCanonical ${kjv} holds ${native}`, from(S, kjv).includes(native), true);
}

// One Synodal verse holding several KJV verses.
const joins = [
  ['LEV 14:55', ['LEV 14:55', 'LEV 14:56']], ['PSA 12:6', ['PSA 13:5', 'PSA 13:6']], ['PSA 86:2', ['PSA 87:1', 'PSA 87:2']],
  ['PSA 89:6', ['PSA 90:5', 'PSA 90:6']], ['PSA 114:8', ['PSA 116:8', 'PSA 116:9']], ['ISA 3:19', ['ISA 3:19', 'ISA 3:20']],
  ['ACT 19:40', ['ACT 19:40', 'ACT 19:41']], ['2CO 11:32', ['2CO 11:32', '2CO 11:33']], ['2CO 13:12', ['2CO 13:12', '2CO 13:13']],
  ['REV 20:7', ['REV 20:7', 'REV 20:8']], ['GEN 1:1', ['GEN 1:1']],
];
for (const [native, all] of joins) check(`toCanonicalAll ${native}`, toAll(S, native), all);

// KJV → Synodal, exact lists.
const backward = [
  ['GEN 1:1', ['GEN 1:1']], ['LEV 14:56', ['LEV 14:55']], ['LEV 14:57', ['LEV 14:56']], ['NUM 12:16', ['NUM 13:1']], ['NUM 29:40', ['NUM 30:1']],
  ['JOS 6:1', ['JOS 5:16']], ['1SA 20:42', ['1SA 20:42', '1SA 20:43']], ['1SA 23:29', ['1SA 24:1']],
  ['JOB 40:1', ['JOB 39:31']], ['JOB 40:6', ['JOB 40:1']], ['JOB 41:1', ['JOB 40:20']], ['JOB 41:34', ['JOB 41:26']],
  ['PSA 3:1', ['PSA 3:1', 'PSA 3:2']], ['PSA 9:1', ['PSA 9:1', 'PSA 9:2']], ['PSA 10:1', ['PSA 9:22']], ['PSA 13:6', ['PSA 12:6']],
  ['PSA 23:1', ['PSA 22:1']], ['PSA 51:1', ['PSA 50:1', 'PSA 50:2', 'PSA 50:3']], ['PSA 87:1', ['PSA 86:1', 'PSA 86:2']], ['PSA 87:2', ['PSA 86:2']],
  ['PSA 90:1', ['PSA 89:1', 'PSA 89:2']], ['PSA 90:6', ['PSA 89:6']], ['PSA 115:1', ['PSA 113:9']], ['PSA 116:9', ['PSA 114:8']],
  ['PSA 116:10', ['PSA 115:1']], ['PSA 117:1', ['PSA 116:1']], ['PSA 147:1', ['PSA 146:1']], ['PSA 147:12', ['PSA 147:1']],
  ['PRO 13:14', ['PRO 13:15']], ['PRO 18:8', ['PRO 18:9']], ['ECC 5:1', ['ECC 4:17']],
  ['SNG 1:1', []], ['SNG 1:2', ['SNG 1:1']], ['SNG 6:13', ['SNG 7:1']], ['ISA 3:20', ['ISA 3:19']], ['ISA 3:26', ['ISA 3:25']],
  ['DAN 3:24', ['DAN 3:91']], ['DAN 4:1', ['DAN 3:98']], ['DAN 4:37', ['DAN 4:34']], ['HOS 13:16', ['HOS 14:1']], ['JON 1:17', ['JON 2:1']],
  ['JOL 2:28', ['JOL 2:28']], ['MAL 4:5', ['MAL 4:5']], ['ACT 19:41', ['ACT 19:40']], ['ROM 16:25', ['ROM 14:24']], ['ROM 16:27', ['ROM 14:26']],
  ['2CO 11:33', ['2CO 11:32']], ['2CO 13:13', ['2CO 13:12']], ['2CO 13:14', ['2CO 13:13']], ['3JN 1:14', ['3JN 1:14', '3JN 1:15']],
  ['REV 20:8', ['REV 20:7']], ['REV 20:9', ['REV 20:8', 'REV 20:9']],
];
for (const [kjv, natives] of backward) check(`fromCanonical ${kjv}`, from(S, kjv), natives);

// Noncanonical: whole books and insertions.
for (const id of EXTRA_BOOKS) {
  for (const ref of [`${id} 1:1`, `${id} 1:5`]) {
    check(`${ref} has no canonical key`, [to(S, ref), toAll(S, ref), S.isNoncanonical(parse(ref))], [null, [], true]);
  }
}
// [book, chapter, first verse, last verse] — every verse of each insertion.
const insertions = [
  ['JOS', 24, 34, 36], ['2CH', 36, 24, 35], ['PSA', 151, 1, 7], ['PRO', 4, 28, 29], ['PRO', 13, 14, 14], ['PRO', 18, 8, 8],
  ['DAN', 3, 24, 90], ['DAN', 13, 1, 64], ['DAN', 14, 1, 42],
];
let insertionVerses = 0;
for (const [id, c, first, last] of insertions) {
  for (let v = first; v <= last; v += 1) {
    const loc = { book: id, chapter: c, verse: v };
    if (S.toCanonical(loc) !== null || !S.isNoncanonical(loc) || S.toCanonicalAll(loc).length) check(`${id} ${c}:${v} is noncanonical`, false, true);
    else insertionVerses += 1;
  }
}
check('insertion verses', insertionVerses, 199);
check('insertion edges stay canonical', ['JOS 24:33', '2CH 36:23', 'PSA 150:6', 'PRO 4:27', 'PRO 13:13', 'DAN 3:23', 'DAN 3:91', 'DAN 12:13'].map((r) => S.isNoncanonical(parse(r))), Array(8).fill(false));
check('noncanonicalRanges', [noncanonicalRanges('synodal', 'DAN'), noncanonicalRanges('synodal', 'GEN'), noncanonicalRanges('kjv', 'DAN'), noncanonicalRanges('xyz', 'DAN')], [['3.24-3.90', '13.1-14.42'], [], [], undefined]);

// Full round trip over every KJV verse.
let total = 0;
const roundTripBreaks = [];
const failures = [];
for (const [book, counts] of Object.entries(KJV_COUNTS)) {
  counts.forEach((count, c) => {
    for (let v = 1; v <= count; v += 1) {
      total += 1;
      const loc = { book, chapter: c + 1, verse: v };
      const ref = show(loc);
      const natives = S.fromCanonical(loc);
      if (!natives.length) {
        if (ref !== 'SNG 1:1') failures.push(`${ref}: no Synodal verse`);
        continue;
      }
      for (const n of natives) {
        const all = S.toCanonicalAll(n).map(show);
        if (!all.includes(ref) || S.isNoncanonical(n) || show(S.toCanonical(n)) !== all[0]) failures.push(`${ref} ← ${show(n)} → ${all}`);
      }
      if (show(S.toCanonical(natives[0])) !== ref) roundTripBreaks.push(ref);
      // KJV identity round trip.
      if (show(K.toCanonical(K.fromCanonical(loc)[0])) !== ref) failures.push(`kjv ${ref}`);
    }
  });
}
check('KJV verses visited', total, 31102);
check('round trip toCanonicalAll(fromCanonical(x)) ∋ x', failures.slice(0, 5), []);
// Where one Synodal verse holds two KJV verses, the second comes back as the first.
check('toCanonical(fromCanonical(x)[0]) ≠ x only for the second half of a joined verse', roundTripBreaks, [
  'LEV 14:56', 'PSA 13:6', 'PSA 87:2', 'PSA 90:6', 'PSA 116:9', 'ISA 3:20', 'ACT 19:41', '2CO 11:33', '2CO 13:13', 'REV 20:8',
]);

done('versification');
