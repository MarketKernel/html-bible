/**
 * The books of the Bible: canonical ids, the codes readable links use, names
 * and abbreviations in the interface languages.
 *
 * Ids are USFM/Paratext codes. The 66 books of the Protestant canon are
 * canonical: comments, discussions and comparison work with them only. The
 * other books of the Synodal translation can be read, searched and linked to,
 * but have no canonical verse keys (see versification/).
 *
 * The link code is the USFM code in title case (MAT → Mat, 1CO → 1Co): what a
 * readable link like Synodal_Mat3-3 is made of.
 *
 * Aliases are compared normalized (see normalizeBookName): lower case, ё → е,
 * no dots or spaces — "1 Кор." and "1кор" are the same alias.
 */

export const CANONICAL_BOOKS = [
  'GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH',
  'EZR', 'NEH', 'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS',
  'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL',
  'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH',
  '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV',
] as const;

export const EXTRA_BOOKS = ['1ES', 'TOB', 'JDT', 'WIS', 'SIR', 'LJE', 'BAR', '1MA', '2MA', '3MA', '2ES'] as const;

export type BookId = (typeof CANONICAL_BOOKS)[number];
export type ExtBookId = (typeof EXTRA_BOOKS)[number];
export type AnyBookId = BookId | ExtBookId;

export type Testament = 'OT' | 'NT';

export interface BookInfo {
  id: AnyBookId;
  /** For readable links: Mat, 1Co. */
  link: string;
  testament: Testament;
  canonical: boolean;
  en: { name: string; short: string; aliases: string[] };
  ru: { name: string; short: string; aliases: string[] };
}

type Row = [AnyBookId, Testament, string, string, string[], string, string, string[]];

// id, testament, English name, English short, English aliases, Russian name, Russian short, Russian aliases
const ROWS: Row[] = [
  ['GEN', 'OT', 'Genesis', 'Gen', ['Ge', 'Gn'], 'Бытие', 'Быт', ['Бт', 'Бытия', '1Моис']],
  ['EXO', 'OT', 'Exodus', 'Exod', ['Ex', 'Exo'], 'Исход', 'Исх', ['2Моис']],
  ['LEV', 'OT', 'Leviticus', 'Lev', ['Lv', 'Le'], 'Левит', 'Лев', ['Лв', '3Моис']],
  ['NUM', 'OT', 'Numbers', 'Num', ['Nu', 'Nm', 'Nb'], 'Числа', 'Чис', ['Чисел', 'Числ', 'Чс', '4Моис']],
  ['DEU', 'OT', 'Deuteronomy', 'Deut', ['Dt', 'De', 'Deu'], 'Второзаконие', 'Втор', ['Вт', '5Моис']],
  ['JOS', 'OT', 'Joshua', 'Josh', ['Jos', 'Jsh'], 'Иисус Навин', 'Нав', ['Иисуса Навина', 'ИисНав', 'Ис Нав', 'Иис']],
  ['JDG', 'OT', 'Judges', 'Judg', ['Jdg', 'Jg', 'Jdgs'], 'Судьи', 'Суд', ['Судей', 'Сд']],
  ['RUT', 'OT', 'Ruth', 'Ruth', ['Ru', 'Rth', 'Rut'], 'Руфь', 'Руф', ['Рф']],
  ['1SA', 'OT', '1 Samuel', '1 Sam', ['1Sa', '1Sm', 'I Sam', '1 Kingdoms'], '1 Царств', '1 Цар', ['1Цр', '1Царств']],
  ['2SA', 'OT', '2 Samuel', '2 Sam', ['2Sa', '2Sm', 'II Sam', '2 Kingdoms'], '2 Царств', '2 Цар', ['2Цр']],
  ['1KI', 'OT', '1 Kings', '1 Kgs', ['1Ki', '1Kin', 'I Kings', '3 Kingdoms'], '3 Царств', '3 Цар', ['3Цр']],
  ['2KI', 'OT', '2 Kings', '2 Kgs', ['2Ki', '2Kin', 'II Kings', '4 Kingdoms'], '4 Царств', '4 Цар', ['4Цр']],
  ['1CH', 'OT', '1 Chronicles', '1 Chr', ['1Ch', '1Chron', 'I Chr'], '1 Паралипоменон', '1 Пар', ['1Парал', '1Хрон', '1Лет']],
  ['2CH', 'OT', '2 Chronicles', '2 Chr', ['2Ch', '2Chron', 'II Chr'], '2 Паралипоменон', '2 Пар', ['2Парал', '2Хрон', '2Лет']],
  ['EZR', 'OT', 'Ezra', 'Ezra', ['Ezr', 'Ez'], 'Ездра', 'Езд', ['1Езд', '1Ездры', 'Ездры']],
  ['NEH', 'OT', 'Nehemiah', 'Neh', ['Ne'], 'Неемия', 'Неем', ['Неемии']],
  ['EST', 'OT', 'Esther', 'Esth', ['Est', 'Es'], 'Есфирь', 'Есф', ['Эсф', 'Есфири']],
  ['JOB', 'OT', 'Job', 'Job', ['Jb'], 'Иов', 'Иов', ['Иова']],
  ['PSA', 'OT', 'Psalms', 'Ps', ['Psalm', 'Psa', 'Pss', 'Psm'], 'Псалтирь', 'Пс', ['Псалом', 'Псалмы', 'Псал', 'Псалтырь']],
  ['PRO', 'OT', 'Proverbs', 'Prov', ['Pr', 'Pro', 'Prv'], 'Притчи', 'Притч', ['Прит', 'Пр', 'Притчей']],
  ['ECC', 'OT', 'Ecclesiastes', 'Eccl', ['Ec', 'Ecc', 'Qoh'], 'Екклесиаст', 'Еккл', ['Ек', 'Екк', 'Екклезиаст']],
  ['SNG', 'OT', 'Song of Solomon', 'Song', ['Song of Songs', 'SoS', 'Cant', 'Sng'], 'Песнь Песней', 'Песн', ['Песнь', 'ПесПес', 'Пес']],
  ['ISA', 'OT', 'Isaiah', 'Isa', ['Is'], 'Исаия', 'Ис', ['Исаии', 'Иса']],
  ['JER', 'OT', 'Jeremiah', 'Jer', ['Je', 'Jr'], 'Иеремия', 'Иер', ['Иеремии', 'Ир']],
  ['LAM', 'OT', 'Lamentations', 'Lam', ['La'], 'Плач Иеремии', 'Плач', ['Пл', 'ПлачИер', 'Плч']],
  ['EZK', 'OT', 'Ezekiel', 'Ezek', ['Eze', 'Ezk'], 'Иезекииль', 'Иез', ['Иезекииля', 'Из']],
  ['DAN', 'OT', 'Daniel', 'Dan', ['Da', 'Dn'], 'Даниил', 'Дан', ['Даниила']],
  ['HOS', 'OT', 'Hosea', 'Hos', ['Ho'], 'Осия', 'Ос', ['Осии']],
  ['JOL', 'OT', 'Joel', 'Joel', ['Jl', 'Jol'], 'Иоиль', 'Иоил', ['Иоиля', 'Ил']],
  ['AMO', 'OT', 'Amos', 'Amos', ['Am', 'Amo'], 'Амос', 'Ам', ['Амоса']],
  ['OBA', 'OT', 'Obadiah', 'Obad', ['Ob', 'Oba'], 'Авдий', 'Авд', ['Авдия']],
  ['JON', 'OT', 'Jonah', 'Jonah', ['Jon', 'Jnh'], 'Иона', 'Ион', ['Ионы']],
  ['MIC', 'OT', 'Micah', 'Mic', ['Mi', 'Mc'], 'Михей', 'Мих', ['Михея', 'Мх']],
  ['NAM', 'OT', 'Nahum', 'Nah', ['Na', 'Nam'], 'Наум', 'Наум', ['Наума']],
  ['HAB', 'OT', 'Habakkuk', 'Hab', ['Hb'], 'Аввакум', 'Авв', ['Аввакума']],
  ['ZEP', 'OT', 'Zephaniah', 'Zeph', ['Zep', 'Zp'], 'Софония', 'Соф', ['Софонии']],
  ['HAG', 'OT', 'Haggai', 'Hag', ['Hg'], 'Аггей', 'Агг', ['Аггея', 'Аг']],
  ['ZEC', 'OT', 'Zechariah', 'Zech', ['Zec', 'Zc'], 'Захария', 'Зах', ['Захарии', 'Зх']],
  ['MAL', 'OT', 'Malachi', 'Mal', ['Ml'], 'Малахия', 'Мал', ['Малахии', 'Млх']],

  ['MAT', 'NT', 'Matthew', 'Matt', ['Mt', 'Mat'], 'От Матфея', 'Мф', ['Матфея', 'Матфей', 'Матф', 'Мат', 'Мт', 'Евангелие от Матфея']],
  ['MRK', 'NT', 'Mark', 'Mark', ['Mk', 'Mr', 'Mrk', 'Mar'], 'От Марка', 'Мк', ['Марка', 'Марк', 'Мар', 'Мрк', 'Евангелие от Марка']],
  ['LUK', 'NT', 'Luke', 'Luke', ['Lk', 'Lu', 'Luk'], 'От Луки', 'Лк', ['Луки', 'Лука', 'Лук', 'Евангелие от Луки']],
  ['JHN', 'NT', 'John', 'John', ['Jn', 'Jhn', 'Joh'], 'От Иоанна', 'Ин', ['Иоанна', 'Иоанн', 'Иоан', 'Ио', 'Евангелие от Иоанна']],
  ['ACT', 'NT', 'Acts', 'Acts', ['Ac', 'Act', 'Acts of the Apostles'], 'Деяния', 'Деян', ['Деяния апостолов', 'Дея']],
  ['ROM', 'NT', 'Romans', 'Rom', ['Ro', 'Rm'], 'Римлянам', 'Рим', ['К Римлянам', 'Римл']],
  ['1CO', 'NT', '1 Corinthians', '1 Cor', ['1Co', 'I Cor'], '1 Коринфянам', '1 Кор', ['1Коринф', '1 К Коринфянам']],
  ['2CO', 'NT', '2 Corinthians', '2 Cor', ['2Co', 'II Cor'], '2 Коринфянам', '2 Кор', ['2Коринф', '2 К Коринфянам']],
  ['GAL', 'NT', 'Galatians', 'Gal', ['Ga'], 'Галатам', 'Гал', ['К Галатам']],
  ['EPH', 'NT', 'Ephesians', 'Eph', ['Ephes'], 'Ефесянам', 'Еф', ['К Ефесянам', 'Ефес', 'Эф']],
  ['PHP', 'NT', 'Philippians', 'Phil', ['Php', 'Pp'], 'Филиппийцам', 'Флп', ['К Филиппийцам', 'Фил', 'Филип']],
  ['COL', 'NT', 'Colossians', 'Col', ['Co'], 'Колоссянам', 'Кол', ['К Колоссянам']],
  ['1TH', 'NT', '1 Thessalonians', '1 Thess', ['1Th', '1Thes', 'I Thess'], '1 Фессалоникийцам', '1 Фес', ['1Фесс', '1 К Фессалоникийцам']],
  ['2TH', 'NT', '2 Thessalonians', '2 Thess', ['2Th', '2Thes', 'II Thess'], '2 Фессалоникийцам', '2 Фес', ['2Фесс', '2 К Фессалоникийцам']],
  ['1TI', 'NT', '1 Timothy', '1 Tim', ['1Ti', 'I Tim'], '1 Тимофею', '1 Тим', ['1 К Тимофею']],
  ['2TI', 'NT', '2 Timothy', '2 Tim', ['2Ti', 'II Tim'], '2 Тимофею', '2 Тим', ['2 К Тимофею']],
  ['TIT', 'NT', 'Titus', 'Titus', ['Tit', 'Ti'], 'Титу', 'Тит', ['К Титу']],
  ['PHM', 'NT', 'Philemon', 'Phlm', ['Phm', 'Philem'], 'Филимону', 'Флм', ['К Филимону', 'Филим']],
  ['HEB', 'NT', 'Hebrews', 'Heb', ['He'], 'Евреям', 'Евр', ['К Евреям']],
  ['JAS', 'NT', 'James', 'Jas', ['Jm', 'Jam'], 'Иакова', 'Иак', ['Иаков', 'Послание Иакова']],
  ['1PE', 'NT', '1 Peter', '1 Pet', ['1Pe', '1Pt', 'I Pet'], '1 Петра', '1 Пет', ['1Петр']],
  ['2PE', 'NT', '2 Peter', '2 Pet', ['2Pe', '2Pt', 'II Pet'], '2 Петра', '2 Пет', ['2Петр']],
  ['1JN', 'NT', '1 John', '1 John', ['1Jn', '1Jo', 'I John'], '1 Иоанна', '1 Ин', ['1Иоан']],
  ['2JN', 'NT', '2 John', '2 John', ['2Jn', '2Jo', 'II John'], '2 Иоанна', '2 Ин', ['2Иоан']],
  ['3JN', 'NT', '3 John', '3 John', ['3Jn', '3Jo', 'III John'], '3 Иоанна', '3 Ин', ['3Иоан']],
  ['JUD', 'NT', 'Jude', 'Jude', ['Jud', 'Jd'], 'Иуды', 'Иуд', ['Иуда', 'Послание Иуды']],
  ['REV', 'NT', 'Revelation', 'Rev', ['Re', 'Rv', 'Apocalypse', 'Revelations'], 'Откровение', 'Откр', ['Отк', 'Апокалипсис', 'Апок', 'Откровение Иоанна']],

  ['1ES', 'OT', '1 Esdras', '1 Esd', ['1Es', 'I Esd'], '2 Ездры', '2 Езд', ['2Ездр']],
  ['TOB', 'OT', 'Tobit', 'Tob', ['Tb'], 'Товит', 'Тов', ['Товита']],
  ['JDT', 'OT', 'Judith', 'Jdt', ['Jth', 'Jud'], 'Иудифь', 'Иудифь', ['Иудиф', 'Иудифи']],
  ['WIS', 'OT', 'Wisdom of Solomon', 'Wis', ['Wisdom', 'Wisd'], 'Премудрость Соломона', 'Прем', ['Премудрость', 'ПремСол']],
  ['SIR', 'OT', 'Sirach', 'Sir', ['Ecclesiasticus', 'Ecclus'], 'Сирах', 'Сир', ['Премудрость Иисуса сына Сирахова', 'Сираха']],
  ['LJE', 'OT', 'Letter of Jeremiah', 'EpJer', ['Lje', 'Ep Jer'], 'Послание Иеремии', 'Посл Иер', ['ПослИер']],
  ['BAR', 'OT', 'Baruch', 'Bar', ['Ba'], 'Варух', 'Вар', ['Варуха']],
  ['1MA', 'OT', '1 Maccabees', '1 Macc', ['1Ma', '1Mac', 'I Macc'], '1 Маккавейская', '1 Мак', ['1Макк', '1 Маккавейская книга']],
  ['2MA', 'OT', '2 Maccabees', '2 Macc', ['2Ma', '2Mac', 'II Macc'], '2 Маккавейская', '2 Мак', ['2Макк']],
  ['3MA', 'OT', '3 Maccabees', '3 Macc', ['3Ma', '3Mac', 'III Macc'], '3 Маккавейская', '3 Мак', ['3Макк']],
  ['2ES', 'OT', '2 Esdras', '2 Esd', ['2Es', 'II Esd', '4 Ezra'], '3 Ездры', '3 Езд', ['3Ездр']],
];

// 1CO → 1Co, MAT → Mat: a leading digit stays, the first letter is the capital.
const titleCase = (id: string) => id.replace(/^(\d?)(\w)(.*)$/, (_, digit: string, first: string, rest: string) => digit + first + rest.toLowerCase());

export const BOOKS: readonly BookInfo[] = ROWS.map(([id, testament, enName, enShort, enAliases, ruName, ruShort, ruAliases]) => ({
  id,
  link: titleCase(id),
  testament,
  canonical: (CANONICAL_BOOKS as readonly string[]).includes(id),
  en: { name: enName, short: enShort, aliases: enAliases },
  ru: { name: ruName, short: ruShort, aliases: ruAliases },
}));

const byId = new Map<string, BookInfo>(BOOKS.map((book) => [book.id, book]));

export function bookInfo(id: string): BookInfo | undefined {
  return byId.get(id);
}

export function isBookId(id: string): id is AnyBookId {
  return byId.has(id);
}

export function isCanonicalBook(id: string): id is BookId {
  return byId.get(id)?.canonical === true;
}

/** Position in the canonical (Protestant) order; extra books after Revelation. */
export function bookOrder(id: string): number {
  const index = BOOKS.findIndex((book) => book.id === id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** "1 Кор." → "1кор", "Ёв" → "ев", "I Cor" → "1cor". */
export function normalizeBookName(name: string): string {
  let text = name.toLowerCase().replace(/ё/g, 'е').replace(/[.\s_-]+/g, '');
  // Roman numerals in front of a book: "ii cor", "iii john"
  const roman = /^(iii|ii|i)(?=[a-zа-я])/.exec(text);
  if (roman?.[1] && !/^(is|isa|isaiah|ich)/.test(text)) {
    const digit = roman[1] === 'iii' ? '3' : roman[1] === 'ii' ? '2' : '1';
    const rest = text.slice(roman[1].length);
    // "i" alone in front of a known English name — only then it is a numeral
    if (rest.length >= 2) text = digit + rest;
  }
  return text;
}

/** Every normalized name, short name and alias, in both languages → book id. */
const aliasIndex = (() => {
  const index = new Map<string, AnyBookId>();
  const add = (alias: string, id: AnyBookId) => {
    const key = normalizeBookName(alias);
    if (key && !index.has(key)) index.set(key, id);
  };
  // Link codes and USFM ids first: Mat, 1Co, JHN
  for (const book of BOOKS) {
    add(book.link, book.id);
  }
  for (const book of BOOKS) {
    for (const lang of ['ru', 'en'] as const) {
      add(book[lang].short, book.id);
      add(book[lang].name, book.id);
      for (const alias of book[lang].aliases) add(alias, book.id);
    }
  }
  return index;
})();

/**
 * The book a name stands for: an exact alias, else the only full name it is a
 * prefix of (at least 3 letters). Undefined when unknown or ambiguous.
 */
export function findBook(name: string): AnyBookId | undefined {
  const key = normalizeBookName(name);
  if (!key) return undefined;
  const exact = aliasIndex.get(key);
  if (exact) return exact;
  if (key.replace(/^\d/, '').length < 3) return undefined;
  const found = new Set<AnyBookId>();
  for (const book of BOOKS) {
    for (const lang of ['ru', 'en'] as const) {
      if (normalizeBookName(book[lang].name).startsWith(key)) found.add(book.id);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export function bookName(id: string, lang: 'ru' | 'en', form: 'name' | 'short' = 'name'): string {
  const book = byId.get(id);
  return book ? book[lang][form] : id;
}
