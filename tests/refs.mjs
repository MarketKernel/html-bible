/**
 * Verse references: readable links both ways, free form in Russian and English,
 * references found inside text, book names and their ambiguities. Every case
 * here is a fixed vector: a change that breaks one breaks links people shared.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const R = await load('core/refs', 'core/books');

// Books
const book = (name) => R.findBook(name);
for (const [name, id] of [
  ['Мф', 'MAT'], ['Матф', 'MAT'], ['От Матфея', 'MAT'], ['Mt', 'MAT'], ['Matthew', 'MAT'], ['Matt.', 'MAT'], ['Mat', 'MAT'],
  ['Ин', 'JHN'], ['Иоанна', 'JHN'], ['John', 'JHN'], ['Jn', 'JHN'], ['Jhn', 'JHN'],
  ['Ион', 'JON'], ['Иона', 'JON'], ['Jonah', 'JON'],
  ['Иуд', 'JUD'], ['Иудифь', 'JDT'], ['Суд', 'JDG'], ['Тов', 'TOB'],
  ['1 Кор', '1CO'], ['1Кор', '1CO'], ['1 Кор.', '1CO'], ['I Cor', '1CO'], ['1Cor', '1CO'], ['1Co', '1CO'], ['II Cor', '2CO'],
  ['Пс', 'PSA'], ['Псалом', 'PSA'], ['Ps', 'PSA'], ['Psalms', 'PSA'],
  ['Быт', 'GEN'], ['Бытие', 'GEN'], ['Gen', 'GEN'], ['Ис', 'ISA'], ['Isa', 'ISA'], ['Is', 'ISA'], ['Исх', 'EXO'],
  ['Откр', 'REV'], ['Rev', 'REV'], ['1Ma', '1MA'], ['1Macc', '1MA'], ['1 Макк', '1MA'], ['Прем', 'WIS'],
  ['Песн', 'SNG'], ['Song of Solomon', 'SNG'], ['3 Цар', '1KI'], ['1 Kings', '1KI'], ['3 Ин', '3JN'],
  ['Евр', 'HEB'], ['Иак', 'JAS'], ['Флп', 'PHP'], ['Флм', 'PHM'], ['Деян', 'ACT'], ['Acts', 'ACT'],
]) check(`book ${name}`, book(name), id);
check('unknown book', book('Xyz'), undefined);
check('prefix of a full name', book('Второзак'), 'DEU');

// Readable links
const link = (text) => R.parseLink(text);
check('link: verse', link('Synodal_Mat3-3'), { linkName: 'Synodal', book: 'MAT', parts: [{ chapter: 3, verse: 3 }] });
check('link: range', link('Synodal_Mat3-3-5'), { linkName: 'Synodal', book: 'MAT', parts: [{ chapter: 3, verse: 3, endVerse: 5 }] });
check('link: list', link('Synodal_Mat5-3,5,7-9'), {
  linkName: 'Synodal', book: 'MAT', parts: [{ chapter: 5, verse: 3 }, { chapter: 5, verse: 5 }, { chapter: 5, verse: 7, endVerse: 9 }],
});
check('link: chapter', link('KJV_Jhn3'), { linkName: 'KJV', book: 'JHN', parts: [{ chapter: 3 }] });
check('link: across chapters', link('Synodal_Mat3-16~4-2'), { linkName: 'Synodal', book: 'MAT', parts: [{ chapter: 3, verse: 16, endChapter: 4, endVerse: 2 }] });
check('link: no translation', link('Mat3-3'), { book: 'MAT', parts: [{ chapter: 3, verse: 3 }] });
check('link: numbered book', link('KJV_1Co13-4'), { linkName: 'KJV', book: '1CO', parts: [{ chapter: 13, verse: 4 }] });
check('link: deuterocanon', link('Synodal_1Ma3-3'), { linkName: 'Synodal', book: '1MA', parts: [{ chapter: 3, verse: 3 }] });
check('link: alias accepted', link('KJV_John3-16'), { linkName: 'KJV', book: 'JHN', parts: [{ chapter: 3, verse: 16 }] });
check('link: backwards range', link('Synodal_Mat3-5-3'), undefined);
check('link: zero', link('Synodal_Mat0-3'), undefined);
check('link: garbage', link('Synodal_Mat3-'), undefined);

for (const text of ['Synodal_Mat3-3', 'Synodal_Mat3-3-5', 'Synodal_Mat5-3,5,7-9', 'KJV_Jhn3', 'Synodal_Mat3-16~4-2', 'Mat3-3', 'KJV_1Co13-4', 'Synodal_1Ma3-3']) {
  check(`link round trip ${text}`, R.formatLink(R.parseLink(text)), text);
}
check('link canonical spelling', R.formatLink(R.parseLink('KJV_John3-16')), 'KJV_Jhn3-16');

// Free form
const free = (text) => R.parseFree(text);
check('free: Мф 2:3', free('Мф 2:3'), { book: 'MAT', parts: [{ chapter: 2, verse: 3 }] });
check('free: Мф 2,3 (Russian comma)', free('Мф 2,3'), { book: 'MAT', parts: [{ chapter: 2, verse: 3 }] });
check('free: Ин 3:16-18', free('Ин 3:16-18'), { book: 'JHN', parts: [{ chapter: 3, verse: 16, endVerse: 18 }] });
check('free: en dash', free('Ин 3:16–18'), { book: 'JHN', parts: [{ chapter: 3, verse: 16, endVerse: 18 }] });
check('free: list', free('Мф 5:3,5,7'), { book: 'MAT', parts: [{ chapter: 5, verse: 3 }, { chapter: 5, verse: 5 }, { chapter: 5, verse: 7 }] });
check('free: 1 Кор 13:4', free('1 Кор 13:4'), { book: '1CO', parts: [{ chapter: 13, verse: 4 }] });
check('free: chapter', free('Пс 22'), { book: 'PSA', parts: [{ chapter: 22 }] });
check('free: John 3:16', free('John 3:16'), { book: 'JHN', parts: [{ chapter: 3, verse: 16 }] });
check('free: Matt. 3:16-4:2', free('Matt. 3:16-4:2'), { book: 'MAT', parts: [{ chapter: 3, verse: 16, endChapter: 4, endVerse: 2 }] });
check('free: Song of Solomon 2:1', free('Song of Solomon 2:1'), { book: 'SNG', parts: [{ chapter: 2, verse: 1 }] });
check('free: От Иоанна 1:1', free('От Иоанна 1:1'), { book: 'JHN', parts: [{ chapter: 1, verse: 1 }] });
check('free: spaces', free('  Ин  3 : 16 '), { book: 'JHN', parts: [{ chapter: 3, verse: 16 }] });
check('free: Тов 1:1', free('Тов 1:1'), { book: 'TOB', parts: [{ chapter: 1, verse: 1 }] });
check('free: not a reference', free('любовь'), undefined);
check('free: unknown book', free('Xyz 3:16'), undefined);
check('parseRef prefers link', R.parseRef('Synodal_Mat3-3').linkName, 'Synodal');
check('parseRef falls back to free', R.parseRef('Мф 2:3'), { book: 'MAT', parts: [{ chapter: 2, verse: 3 }] });
check('parseRefs', R.parseRefs('Ин 3:16; Рим 5:8').map((r) => r.book), ['JHN', 'ROM']);

// Human format
check('human ru', R.formatHuman({ book: 'JHN', parts: [{ chapter: 3, verse: 16 }] }, 'ru'), 'Ин 3:16');
check('human en range', R.formatHuman({ book: 'JHN', parts: [{ chapter: 3, verse: 16, endVerse: 18 }] }, 'en'), 'John 3:16–18');
check('human list', R.formatHuman(R.parseFree('Мф 5:3,5,7-9'), 'ru'), 'Мф 5:3,5,7–9');
check('human chapter', R.formatHuman({ book: 'PSA', parts: [{ chapter: 23 }] }, 'en'), 'Ps 23');
check('human across', R.formatHuman(R.parseLink('Mat3-16~4-2'), 'ru'), 'Мф 3:16–4:2');

// Verses in a chapter
check('verses: list', R.versesInChapter(R.parseLink('Mat5-3,5,7-9').parts, 5, 48), [3, 5, 7, 8, 9]);
check('verses: across, first chapter', R.versesInChapter(R.parseLink('Mat3-16~4-2').parts, 3, 17), [16, 17]);
check('verses: across, second chapter', R.versesInChapter(R.parseLink('Mat3-16~4-2').parts, 4, 25), [1, 2]);
check('verses: whole chapter', R.versesInChapter([{ chapter: 2 }], 2, 3), [1, 2, 3]);
check('verses: other chapter', R.versesInChapter([{ chapter: 2, verse: 1 }], 3, 10), []);
check('parts from verses', R.partsFromVerses(5, [9, 3, 4, 5, 7]), [{ chapter: 5, verse: 3, endVerse: 5 }, { chapter: 5, verse: 7 }, { chapter: 5, verse: 9 }]);

// In text
const found = R.findRefsInText('Как сказано в Ин 3:16 и (Рим 5:8), а также 1 Кор 13:4-7.');
check('in text: books', found.map((f) => f.ref.book), ['JHN', 'ROM', '1CO']);
check('in text: span', found.map((f) => 'Как сказано в Ин 3:16 и (Рим 5:8), а также 1 Кор 13:4-7.'.slice(f.index, f.index + f.length)), ['Ин 3:16', 'Рим 5:8', '1 Кор 13:4-7']);
check('in text: English', R.findRefsInText('See John 3:16, then Rom 5:8.').map((f) => f.ref.book), ['JHN', 'ROM']);
check('in text: no colon, no ref', R.findRefsInText('В 3 часа 15 минут').length, 0);
check('in text: unknown word', R.findRefsInText('Глава 3:16').length, 0);

done('refs');
