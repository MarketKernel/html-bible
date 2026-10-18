/**
 * Reads a CrossWire SWORD zText module (BlockType=BOOK, CompressType=ZIP) into
 * raw OSIS strings per verse, given the module's versification as a list of
 * books with verse counts per chapter.
 *
 * Layout of zText: [ot|nt].bzs holds the compressed blocks (offset, size,
 * uncompressed size: 3 × uint32 LE), [ot|nt].bzv one entry per verse slot
 * (block, offset in the inflated block, size: uint32, uint32, uint16 LE) and
 * [ot|nt].bzz the zlib blocks. The verse slots follow SWORD's VerseKey index:
 * 0 module heading, 1 testament heading, then per book a book heading, per
 * chapter a chapter heading, then the verses.
 *
 * Not a CLI: imported by build-synodal.mjs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/**
 * books: [{ osis, counts: number[] }] in versification order for one testament.
 * Returns Map<osis, { intro: string, chapters: { intro: string, verses: string[] }[] }>.
 */
export function readZText(dir, testament, books) {
  const bzs = readFileSync(join(dir, `${testament}.bzs`));
  const bzv = readFileSync(join(dir, `${testament}.bzv`));
  const bzz = readFileSync(join(dir, `${testament}.bzz`));
  const blocks = new Map();
  const block = (n) => {
    if (!blocks.has(n)) {
      const offset = bzs.readUInt32LE(n * 12);
      const size = bzs.readUInt32LE(n * 12 + 4);
      blocks.set(n, size ? inflateSync(bzz.subarray(offset, offset + size)) : Buffer.alloc(0));
    }
    return blocks.get(n);
  };
  const slot = (index) => {
    if (index * 10 + 10 > bzv.length) throw new Error(`${testament}: verse slot ${index} beyond the index`);
    const n = bzv.readUInt32LE(index * 10);
    const offset = bzv.readUInt32LE(index * 10 + 4);
    const size = bzv.readUInt16LE(index * 10 + 8);
    if (!size) return '';
    return block(n).subarray(offset, offset + size).toString('utf8');
  };
  const result = new Map();
  let index = 2;
  for (const { osis, counts } of books) {
    const book = { intro: slot(index++), chapters: [] };
    for (const count of counts) {
      const chapter = { intro: slot(index++), verses: [] };
      for (let v = 0; v < count; v += 1) chapter.verses.push(slot(index++));
      book.chapters.push(chapter);
    }
    result.set(osis, book);
  }
  const expected = bzv.length / 10;
  if (index !== expected) throw new Error(`${testament}: versification has ${index} slots, the index ${expected}`);
  return result;
}

/**
 * Parses the books and verse counts out of a SWORD canon_*.h header: the
 * otbooks_/ntbooks_ arrays and the vm_ array.
 */
export function parseCanonHeader(source, name) {
  const array = (re) => {
    const m = re.exec(source);
    if (!m) throw new Error(`canon header: no ${re}`);
    return m[1];
  };
  const books = (testament) =>
    [...array(new RegExp(`struct sbook ${testament}books_${name}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`)).matchAll(/\{"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*(\d+)\}/g)]
      .filter((m) => m[2])
      .map((m) => ({ osis: m[2], chapters: Number(m[4]) }));
  const vm = array(new RegExp(`int vm_${name}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`))
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const ot = books('ot');
  const nt = books('nt');
  let k = 0;
  for (const book of [...ot, ...nt]) {
    book.counts = vm.slice(k, k + book.chapters);
    k += book.chapters;
  }
  if (k !== vm.length) throw new Error(`canon header: ${vm.length} verse counts for ${k} chapters`);
  return { ot, nt };
}

/** The mappings_ array of a canon header: extra book names and 7-byte rules (8 for extra books). */
export function parseCanonMappings(source, name) {
  const m = new RegExp(`unsigned char mappings_${name}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
  if (!m) return null;
  const bytes = m[1]
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^'.'$/.test(s) ? s.charCodeAt(1) : Number(s)));
  const extra = [];
  let i = 0;
  while (bytes[i] !== 0) {
    let s = '';
    while (bytes[i] !== 0) s += String.fromCharCode(bytes[i++]);
    extra.push(s);
    i += 1;
  }
  i += 1;
  return { extra, bytes: bytes.slice(i) };
}
