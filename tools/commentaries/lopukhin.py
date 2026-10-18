#!/usr/bin/env python3
"""
Lopukhin's Explanatory Bible ("Толковая Библия Лопухина", 1904-1913, public
domain) -> data/commentaries/ru-lopukhin/ (html-bible/commentary, split by book).

Source: the MyBible commentary module "Лоп-к" ("Толковая Библия Лопухина,
1914", SQLite3, Synodal numbering), listed in the MyBible registry
  https://mybible.zone/repository/registry/registry.zip
and downloaded from
  https://mybible.zone/repository/modules/%D0%9B%D0%BE%D0%BF-%D0%BA.commentaries.zip

Run (Python 3.9+, stdlib only; Node for the versification table):
  python3 -I tools/commentaries/lopukhin.py            # download once (cached), convert
  python3 -I tools/commentaries/lopukhin.py --offline  # never touch the network
  node tools/translations/build-catalog.mjs            # then refresh data/catalog.json

Pipeline:
  1. download the registry and the module, each into its own directory under
     private/sources/ (lopukhin-registry/, lopukhin-mybible/); kept as a cache;
  2. module rows -> private/build/lopukhin/raw.jsonl (Synodal ref + raw HTML);
  3. HTML -> the Markdown subset of src/core/markdown.ts
     (private/build/lopukhin/clean.jsonl);
  4. Synodal refs -> canonical KJV keys via src/core/versification
     (tools/commentaries/synodal-map.mjs dumps the table); noncanonical
     verses (Dan 3:24-90, Dan 13-14, Ps 151, ...) are dropped and counted;
  5. split by book, gzip (mtime 0, byte-stable), manifest with sha256.

Text cleanup:
  - <p>, <p/> -> paragraph; <br> -> line break; <h2..h4> -> a **bold** paragraph;
  - <b>/<strong> -> **bold** (the module's Greek and Hebrew words are bold and
    stay so, as text); <i>/<em> -> _italic_ (underscores, so italic and bold
    never nest ambiguously; *italic* next to an ASCII letter);
  - <a> cross references -> their text only ("Лк 4:21"): the app finds verse
    references in plain text by itself;
  - <SMALL>[...]</SMALL> footnotes stay inline, in their own square brackets;
  - tables -> one line per row, cells joined with " | "; <ol>/<ul> items ->
    "1. ..." lines / "- ..." list items;
  - <img> (7 drawings in Ezekiel, files not in the module) dropped, counted;
  - every other tag dropped, its text kept; entities decoded; whitespace
    collapsed; Markdown characters (\\ * _ [ and a leading > or -) escaped.
  - Introductions (verse 0 = chapter intro, chapter 0 = book intro) become
    entries on the first verse of the chapter (book: chapter 1), sorted before
    the verse entries there.
  - A Synodal range whose canonical verses are not contiguous (e.g. Rom
    14:24-26 = KJV 16:25-27) gives one entry per contiguous run.
  - Known source slip: one row has book number 1110 for 110 (1 Kings 9:10-14,
    a gap in the module otherwise) and is read as 110.

The report (stdout) is numbers only: entries per book, dropped and why, size,
3 samples of 300 characters, the first 20 refs that could not be used.
"""
import gzip
import hashlib
import html
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, OrderedDict
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REGISTRY_URL = 'https://mybible.zone/repository/registry/registry.zip'
MODULE_ABR = 'Лоп-к'
MODULE_URL = 'https://mybible.zone/repository/modules/' + urllib.parse.quote(MODULE_ABR) + '.commentaries.zip'
UA = 'html-bible-prep/1.0 (one-off conversion of a public-domain commentary)'

REG_DIR = os.path.join(ROOT, 'private', 'sources', 'lopukhin-registry')
SRC_DIR = os.path.join(ROOT, 'private', 'sources', 'lopukhin-mybible')
WORK_DIR = os.path.join(ROOT, 'private', 'build', 'lopukhin')
OUT_DIR = os.path.join(ROOT, 'data', 'commentaries', 'ru-lopukhin')
DB_NAME = 'lopukhin.commentaries.SQLite3'

ID = 'ru-lopukhin'
MAX_MD = 200000

# MyBible book numbers -> USFM codes (canonical books; others are dropped).
MYBIBLE = {
    10: 'GEN', 20: 'EXO', 30: 'LEV', 40: 'NUM', 50: 'DEU', 60: 'JOS', 70: 'JDG', 80: 'RUT',
    90: '1SA', 100: '2SA', 110: '1KI', 120: '2KI', 130: '1CH', 140: '2CH', 150: 'EZR',
    160: 'NEH', 190: 'EST', 220: 'JOB', 230: 'PSA', 240: 'PRO', 250: 'ECC', 260: 'SNG',
    290: 'ISA', 300: 'JER', 310: 'LAM', 330: 'EZK', 340: 'DAN', 350: 'HOS', 360: 'JOL',
    370: 'AMO', 380: 'OBA', 390: 'JON', 400: 'MIC', 410: 'NAM', 420: 'HAB', 430: 'ZEP',
    440: 'HAG', 450: 'ZEC', 460: 'MAL', 470: 'MAT', 480: 'MRK', 490: 'LUK', 500: 'JHN',
    510: 'ACT', 520: 'ROM', 530: '1CO', 540: '2CO', 550: 'GAL', 560: 'EPH', 570: 'PHP',
    580: 'COL', 590: '1TH', 600: '2TH', 610: '1TI', 620: '2TI', 630: 'TIT', 640: 'PHM',
    650: 'HEB', 660: 'JAS', 670: '1PE', 680: '2PE', 690: '1JN', 700: '2JN', 710: '3JN',
    720: 'JUD', 730: 'REV',
}
# Deuterocanonical books in MyBible numbering (dropped as noncanonical).
MYBIBLE_EXTRA = {165, 170, 180, 192, 232, 270, 280, 305, 315, 320, 323, 325, 345,
                 462, 464, 466, 467, 468, 790}
BOOK_FIXES = {1110: 110}
ORDER = list(MYBIBLE.values())


# ---------------------------------------------------------------- download

def fetch(url, dest):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest + '.part', 'wb') as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    os.replace(dest + '.part', dest)
    time.sleep(1)


def download(offline):
    db = os.path.join(SRC_DIR, DB_NAME)
    if os.path.exists(db):
        return db
    zpath = os.path.join(SRC_DIR, 'Lop-k.commentaries.zip')
    if not os.path.exists(zpath):
        if offline:
            sys.exit('no cached module in ' + SRC_DIR)
        os.makedirs(REG_DIR, exist_ok=True)
        reg = os.path.join(REG_DIR, 'registry.zip')
        if not os.path.exists(reg):
            fetch(REGISTRY_URL, reg)
        with zipfile.ZipFile(reg) as z:
            data = json.loads(z.read('registry.json').decode('utf-8-sig'))
        if not any(m.get('abr') == MODULE_ABR for m in data.get('downloads', [])):
            sys.exit('module %s not in the registry' % MODULE_ABR)
        os.makedirs(SRC_DIR, exist_ok=True)
        fetch(MODULE_URL, zpath)
    with zipfile.ZipFile(zpath) as z:
        members = [i for i in z.infolist() if i.filename.endswith('.SQLite3')]
        if len(members) != 1 or members[0].file_size > 500 * 1024 * 1024:
            sys.exit('unexpected module archive')
        # Written under a fixed name: the member name is never used as a path.
        with open(db, 'wb') as f:
            f.write(z.read(members[0]))
    return db


# ---------------------------------------------------------------- raw rows

def read_rows(db):
    con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
    rows = con.execute('select book_number, chapter_number_from, verse_number_from, '
                       'chapter_number_to, verse_number_to, text from commentaries '
                       'order by rowid').fetchall()
    con.close()
    out = []
    for b, c1, v1, c2, v2, text in rows:
        out.append({'book': int(b or 0), 'c1': int(c1 or 0), 'v1': int(v1 or 0),
                    'c2': int(c2) if c2 not in (None, '') else None,
                    'v2': int(v2) if v2 not in (None, '') else None,
                    'html': text or ''})
    return out


# ---------------------------------------------------------------- HTML -> Markdown

class ToMarkdown(HTMLParser):
    """Collects (text, bold, italic) runs and 'P' / 'BR' breaks."""

    IGNORE = {'a', 'small', 'e', 'center', 'dir', 'font', 'span', 'sup', 'sub', 'u', 'div', 'big'}

    def __init__(self, stats):
        super().__init__(convert_charrefs=True)
        self.stats = stats
        self.items = []
        self.bold = 0
        self.italic = 0
        self.lists = []  # stack of [kind, counter]
        self.cell = 0

    def text(self, s):
        if s:
            self.items.append((s, self.bold > 0, self.italic > 0))

    def handle_data(self, data):
        self.text(data)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in ('br', 'p', 'img', 'hr'):
            self.handle_endtag(tag)

    def handle_starttag(self, tag, attrs):
        if tag in ('p', 'table', 'hr'):
            self.items.append('P')
        elif tag == 'br':
            self.items.append('BR')
        elif tag in ('b', 'strong'):
            self.bold += 1
        elif tag in ('i', 'em'):
            self.italic += 1
        elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.items.append('P')
            self.bold += 1
        elif tag in ('ol', 'ul'):
            self.items.append('P')
            self.lists.append([tag, 0])
        elif tag == 'li':
            self.items.append('BR')
            if self.lists:
                self.lists[-1][1] += 1
                kind, n = self.lists[-1]
                self.items.append(('%d. ' % n) if kind == 'ol' else 'LI')
            else:
                self.items.append('LI')
        elif tag == 'tr':
            self.items.append('BR')
            self.cell = 0
        elif tag in ('td', 'th'):
            if self.cell:
                self.text(' | ')
            self.cell += 1
        elif tag == 'img':
            self.stats['images dropped'] += 1
        elif tag not in self.IGNORE:
            self.stats['unknown tag <%s>' % tag] += 1

    def handle_endtag(self, tag):
        if tag in ('b', 'strong'):
            self.bold = max(0, self.bold - 1)
        elif tag in ('i', 'em'):
            self.italic = max(0, self.italic - 1)
        elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.bold = max(0, self.bold - 1)
            self.items.append('P')
        elif tag in ('ol', 'ul'):
            if self.lists:
                self.lists.pop()
            self.items.append('P')
        elif tag in ('table', 'p'):
            self.items.append('P')


ESCAPE = re.compile(r'([\\*_\[])')
ASCII_WORD = re.compile(r'[A-Za-z0-9_]')


def escape(s):
    return ESCAPE.sub(r'\\\1', s)


def render_line(runs):
    """runs: [(text, bold, italic)] with whitespace already collapsed."""
    merged = []
    for text, b, i in runs:
        if merged and merged[-1][1] == b and merged[-1][2] == i:
            merged[-1][0] += text
        else:
            merged.append([text, b, i])
    # A letter or two set off inside a word (the module marks stress in
    # Slavonic quotations so: ж<b>е</b>но) takes the style of the word: the
    # Markdown subset has no intra-word emphasis that parses reliably.
    k = 1
    while k < len(merged):
        text = merged[k][0]
        prev = merged[k - 1][0]
        nxt = merged[k + 1][0] if k + 1 < len(merged) else ''
        if len(text) <= 2 and text.isalpha() and (prev[-1:].isalpha() or nxt[:1].isalpha()):
            donor = merged[k - 1] if prev[-1:].isalpha() else merged[k + 1]
            merged[k][1], merged[k][2] = donor[1], donor[2]
            # Re-merge with the neighbours that now share the style.
            if merged[k - 1][1:] == merged[k][1:]:
                merged[k - 1][0] += merged.pop(k)[0]
                k -= 1
            if k + 1 < len(merged) and merged[k + 1][1:] == merged[k][1:]:
                merged[k][0] += merged.pop(k + 1)[0]
        k += 1
    pieces = []
    for k, (text, b, i) in enumerate(merged):
        if not (b or i) or not text.strip():
            pieces.append(escape(text))
            continue
        lead = text[:len(text) - len(text.lstrip())]
        trail = text[len(text.rstrip()):]
        core = escape(text.strip())
        if i:
            prev = (merged[k - 1][0][-1:] if k else '') if not lead else ' '
            nxt = (merged[k + 1][0][:1] if k + 1 < len(merged) else '') if not trail else ' '
            if (ASCII_WORD.match(prev or ' ') or ASCII_WORD.match(nxt or ' ')) and not b:
                core = '*' + core + '*'
            else:
                core = '_' + core + '_'
        if b:
            core = '**' + core + '**'
        pieces.append(lead + core + trail)
    line = re.sub(r' {2,}', ' ', ''.join(pieces)).strip()
    if re.match(r'\s*(>|-\s)', line):
        line = '\\' + line
    return line


# Slips in the module's markup, fixed before parsing.
SOURCE_FIXES = [
    (re.compile(r'<U(Пс) >(\d+)\.(\d+)'), r'<a>\1 \2:\3'),  # MAT 11:23: a broken link
    (re.compile(r'<font\b[^<>]*>', re.I), ''),  # JOS 19:50: <font face="Symbol> (quote not closed)
]


def to_markdown(source, stats):
    for rx, repl in SOURCE_FIXES:
        source, n = rx.subn(repl, source)
        if n:
            stats['markup slips fixed'] += n
    p = ToMarkdown(stats)
    p.feed(source)
    p.close()
    paragraphs = []
    lines = []
    runs = []
    prefix = ''  # "- " or "1. " of a list item: markup, not escaped

    def end_line():
        nonlocal runs, prefix
        line = render_line(runs)
        if line:
            lines.append(prefix + line if prefix else line)
        runs = []
        prefix = ''

    def end_paragraph():
        nonlocal lines
        end_line()
        if lines:
            paragraphs.append('\n'.join(lines))
        lines = []

    for item in p.items:
        if item == 'P':
            end_paragraph()
        elif item == 'BR':
            end_line()
        elif item == 'LI':
            end_line()
            prefix = '- '
        elif isinstance(item, str):  # "1. " of an ordered list
            end_line()
            prefix = item
        else:
            text, b, i = item
            text = re.sub(r'\s+', ' ', text.replace('\u00a0', ' '))
            if not runs and not text.strip():
                continue
            runs.append((text, b, i))
    end_paragraph()
    return '\n\n'.join(paragraphs)


def to_markdown_entry(source, stats):
    md = to_markdown(source, stats)
    if '<' in md and re.search(r'<[A-Za-z/!]', md):
        stats['"<" left in text'] += 1
    return md


# ---------------------------------------------------------------- refs

def load_versification():
    out = subprocess.run(['node', os.path.join(ROOT, 'tools', 'commentaries', 'synodal-map.mjs')],
                         check=True, capture_output=True, cwd=ROOT).stdout
    return json.loads(out)


def parse_key(k):
    b, c, v = k.split('.')
    return b, int(c), int(v)


class Refs:
    def __init__(self, table):
        self.syn = table['synodal']
        self.kjv = table['kjv']
        self.map = table['map']

    def canonical_runs(self, book, c1, v1, c2, v2, why):
        """Canonical [(from, to)] runs for a Synodal range, or [] (why[...] says the reason)."""
        counts = self.syn[book]
        if c1 < 1 or c1 > len(counts) or v1 < 1:
            why.append('beyond Synodal %s %d' % (book, len(counts)))
            return []
        if c2 < c1 or (c2 == c1 and v2 < v1):
            why.append('backwards')
            return []
        if c2 > len(counts):
            why.append('end clamped')
            c2, v2 = len(counts), counts[-1]
        if v2 > counts[c2 - 1] and (c2, v2) != (c1, v1):
            why.append('end clamped')
            v2 = counts[c2 - 1]
        if v1 > counts[c1 - 1]:
            # A verse past the end of the Synodal chapter (a slip or another
            # edition's division): kept on the chapter's last verse.
            why.append('start clamped (Synodal %s %d has %d)' % (book, c1, counts[c1 - 1]))
            v1 = counts[c1 - 1]
            if c2 == c1 and v2 > v1:
                v2 = v1
        keys = set()
        insertion = False
        for c in range(c1, c2 + 1):
            for v in range(v1 if c == c1 else 1, (v2 if c == c2 else counts[c - 1]) + 1):
                k = '%s.%d.%d' % (book, c, v)
                got = self.map.get(k, [k])
                if not got:
                    insertion = True
                for g in got:
                    b, kc, kv = parse_key(g)
                    if b == book and 1 <= kc <= len(self.kjv[book]) and 1 <= kv <= self.kjv[book][kc - 1]:
                        keys.add((kc, kv))
                    else:
                        why.append('outside KJV')
        if insertion:
            why.append('noncanonical insertion' if not keys else 'clipped insertion')
        if not keys:
            return []
        ordered = sorted(keys)
        runs = [[ordered[0], ordered[0]]]
        for kc, kv in ordered[1:]:
            lc, lv = runs[-1][1]
            nxt = (lc, lv + 1) if lv < self.kjv[book][lc - 1] else (lc + 1, 1)
            if (kc, kv) == nxt:
                runs[-1][1] = (kc, kv)
            else:
                runs.append([(kc, kv), (kc, kv)])
        if len(runs) > 1:
            why.append('split')
        return [(a, b) for a, b in runs]


def ref_text(book, a, b):
    s = '%s.%d.%d' % (book, a[0], a[1])
    return s if a == b else '%s-%s.%d.%d' % (s, book, b[0], b[1])


# ---------------------------------------------------------------- main

def write_jsonl(path, items):
    with open(path, 'w', encoding='utf-8') as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False) + '\n')


def main():
    offline = '--offline' in sys.argv
    db = download(offline)
    os.makedirs(WORK_DIR, exist_ok=True)

    rows = read_rows(db)
    write_jsonl(os.path.join(WORK_DIR, 'raw.jsonl'), rows)

    stats = Counter()
    for r in rows:
        r['md'] = to_markdown_entry(r.pop('html'), stats)
    write_jsonl(os.path.join(WORK_DIR, 'clean.jsonl'), rows)

    refs = Refs(load_versification())
    dropped = Counter()
    notes = Counter()
    unparsed = []
    books = OrderedDict((b, []) for b in ORDER)
    for n, r in enumerate(rows):
        num = BOOK_FIXES.get(r['book'], r['book'])
        if num != r['book']:
            notes['book number fixed %d->%d' % (r['book'], num)] += 1
        label = '%d:%d%s (MyBible book %d)' % (r['c1'], r['v1'], '-%d:%d' % (r['c2'], r['v2'] or 0) if r['c2'] else '', r['book'])
        if not r['md'].strip():
            dropped['empty text'] += 1
            continue
        if num in MYBIBLE_EXTRA:
            dropped['noncanonical book'] += 1
            continue
        book = MYBIBLE.get(num)
        if not book:
            dropped['unknown book number'] += 1
            unparsed.append(label + ' (unknown book)')
            continue
        intro = r['v1'] == 0
        if intro:
            c = r['c1'] or 1
            span = (c, 1, c, 1)
            notes['book introductions' if r['c1'] == 0 else 'chapter introductions'] += 1
        else:
            if not r['c2']:  # a single verse
                c2, v2 = r['c1'], r['v1']
            elif not r['v2']:  # "to the end of chapter c2" (canonical_runs clamps)
                c2, v2 = r['c2'], 999
            else:
                c2, v2 = r['c2'], r['v2']
            span = (r['c1'], r['v1'], c2, v2)
        why = []
        runs = refs.canonical_runs(book, *span, why)
        for w in sorted(set(why)):
            if w in ('noncanonical insertion',) and not runs:
                continue
            notes[w.split(' (')[0]] += 1
        if not runs:
            reason = 'noncanonical insertion' if 'noncanonical insertion' in why else 'bad reference'
            dropped[reason] += 1
            if reason == 'bad reference':
                unparsed.append('%s %s (%s)' % (book, label, '; '.join(sorted(set(why)))))
            continue
        if any(w.startswith('start clamped') or w == 'end clamped' for w in why):
            unparsed.append('%s %s (%s, kept)' % (book, label, '; '.join(sorted(set(why)))))
        md = r['md']
        if len(md) > MAX_MD:
            dropped['too long'] += 1
            continue
        for a, b in runs:
            books[book].append(((a, 0 if intro else 1, b, n), {'ref': ref_text(book, a, b), 'md': md}))

    # Write per-book files and the manifest.
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in os.listdir(OUT_DIR):
        if name.endswith('.json.gz') or name == 'manifest.json':
            os.remove(os.path.join(OUT_DIR, name))
    manifest_books = []
    total = 0
    raw_total = 0
    for book, items in books.items():
        if not items:
            continue
        items.sort(key=lambda x: x[0])
        doc = {'format': 'html-bible/commentary-book', 'formatVersion': 1, 'commentary': ID,
               'book': book, 'entries': [e for _, e in items]}
        data = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        gz = gzip.compress(data, compresslevel=9, mtime=0)
        with open(os.path.join(OUT_DIR, book + '.json.gz'), 'wb') as f:
            f.write(gz)
        manifest_books.append({'id': book, 'url': book + '.json.gz', 'bytes': len(gz),
                               'sha256': hashlib.sha256(gz).hexdigest(), 'entries': len(items)})
        total += len(gz)
        raw_total += len(data)
    manifest = OrderedDict([
        ('format', 'html-bible/commentary'), ('formatVersion', 1), ('id', ID),
        ('version', '1.0.0'), ('lang', 'ru'), ('name', 'Толковая Библия Лопухина'),
        # References inside the text ("Пс 90:11") are in Synodal numbering; the app renumbers them.
        ('versification', 'synodal'),
        ('license', 'Public domain'), ('source', MODULE_URL), ('books', manifest_books),
    ])
    with open(os.path.join(OUT_DIR, 'manifest.json'), 'w', encoding='utf-8') as f:
        f.write(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    # Report: numbers only.
    entries = sum(b['entries'] for b in manifest_books)
    print('source rows: %d; entries written: %d in %d books' % (len(rows), entries, len(manifest_books)))
    print('entries per book: ' + ' '.join('%s %d' % (b['id'], b['entries']) for b in manifest_books))
    print('books without entries: ' + (' '.join(b for b, i in books.items() if not i) or 'none'))
    print('dropped: ' + (', '.join('%s %d' % kv for kv in sorted(dropped.items())) or 'none'))
    print('notes: ' + ', '.join('%s %d' % kv for kv in sorted(notes.items())))
    print('cleanup: ' + (', '.join('%s %d' % kv for kv in sorted(stats.items())) or 'nothing odd'))
    print('size: %d bytes gzipped (%d bytes JSON)' % (total, raw_total))
    picks = [('GEN', 0), ('PSA', 3), ('JHN', 0)]
    for book, k in picks:
        items = books.get(book) or []
        if len(items) > k:
            e = items[min(k, len(items) - 1)][1]
            print('sample %s: %s' % (e['ref'], json.dumps(e['md'][:300], ensure_ascii=False)))
    print('unparsed refs (%d): %s' % (len(unparsed), '; '.join(unparsed[:20]) or 'none'))


if __name__ == '__main__':
    main()
