/**
 * The built page in headless Chrome: the first run, readable and free-form
 * links, renumbering between translations, selection, copying, the user's own
 * comments, comparison, noncanonical verses, search — and, when the Python
 * stub can be started, sign-in and a discussion.
 *
 * Builds its own copy (dev profile) into a temporary folder with this test's
 * addresses, serves it with tests/fixtures/data/ (cut from the real texts by
 * tools/test-data.mjs) beside it as data/ — the relative dataUrl the site
 * uses — and drives it over the DevTools protocol (tools/chrome.mjs).
 * `--shots DIR` saves screenshots.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { CHROME, launch, sleep } from '../tools/chrome.mjs';
import { checker, load, root } from '../tools/load.mjs';

if (!CHROME) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser tests.');
  process.exit(0);
}
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const { check, done } = checker();

/* ---------------- the Python stub (discussions), if Python is here ---------------- */

const free = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PAGE_PORT = await free();
const API_PORT = await free();
let api = null;
const python = existsSync(join(root, 'server', 'local_server.py'));
if (python) {
  api = spawn('python3', [join(root, 'server', 'local_server.py'), '--port', String(API_PORT), '--reset'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    await sleep(100);
    up = await fetch(`http://127.0.0.1:${API_PORT}/v1/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) {
    console.log('  the Python stub did not start: discussions are skipped');
    api.kill();
    api = null;
  }
}

/* ---------------- the page ---------------- */

const out = await mkdtemp(join(tmpdir(), 'bible-app-'));
const apiBase = api ? `http://127.0.0.1:${API_PORT}/` : '';
execFileSync(
  process.execPath,
  ['build.mjs', '--config', 'config/build.dev.json', '--out', out, '--data-url', 'data/', '--api-url', api ? `${apiBase}v1/` : '', '--auth-issuer', apiBase, '--site-url', `http://127.0.0.1:${PAGE_PORT}/`],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.gz': 'application/gzip', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
// Set, the server drops every connection: the network is gone, as the PWA sees it.
let down = false;
const server = createServer(async (req, res) => {
  if (down) return req.socket.destroy();
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.includes('..')) return res.writeHead(400).end();
  const file = path.startsWith('/data/') ? join(root, 'tests', 'fixtures', path) : join(out, 'pages', path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(PAGE_PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PAGE_PORT}/`;

const c = await launch();
const { evaluate, until, navigate, click, text, texts, type, send } = c;
const shot = async (name, options) => SHOTS && c.screenshot(join(SHOTS, `${name}.png`), options);
await send('Browser.grantPermissions', { origin: BASE.slice(0, -1), permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => undefined);
const go = async (hash) => {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(150);
};

try {
  /* ---- first run ---- */
  await navigate(BASE);
  await until(`!!document.querySelector('.onboarding .pack input')`);
  check('first run lists the catalog', (await texts('.onboarding .pack .name')).length >= 2, true);
  await shot('onboarding');
  await evaluate(`document.querySelectorAll('.onboarding .pack input').forEach((b) => { if (!b.checked) b.click(); })`);
  // Under load the first click can land before the page settles: press again if the step did not change.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await click('.onboarding .button.primary');
    if (await until(`document.querySelector('.onboarding h1')?.textContent.includes('commentar')`, 4000).catch(() => false)) break;
  }
  await click('.onboarding .button.primary');
  await until(`!!document.querySelector('.chapter .verse')`, 60000);
  check('reader opens after the downloads', await text('.reader-title'), 'Genesis 1');

  /* ---- links ---- */
  await go('#Synodal_Psa22-2-4');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('Псалтирь 22')`);
  check('readable link: highlighted verses', await evaluate(`[...document.querySelectorAll('.verse.highlight')].map((v) => v.dataset.v)`), ['2', '3', '4']);
  await go('#KJV_Psa23-1');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('Psalms 23')`);
  check('link names its translation', await text('.translation-pick'), 'KJV');
  // Synodal is current again; a link without a translation is canonical (KJV) numbering.
  await go('#Synodal_Gen1');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('Бытие 1')`);
  await go('#Psa23-1');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('Псалтирь 22')`);
  check('canonical link renumbered into the Synodal', await evaluate(`[...document.querySelectorAll('.verse.highlight')].map((v) => v.dataset.v)`), ['1']);
  await go('#Мф 2:3');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('От Матфея 2')`);
  check('free-form link', await evaluate(`[...document.querySelectorAll('.verse.highlight')].map((v) => v.dataset.v)`), ['3']);
  await go('#Synodal_Psa22-1?par=KJV');
  await until(`!!document.querySelector('.parallel-row')`);
  check('parallel: Synodal Ps 22:2 beside KJV Ps 23:2', await evaluate(`document.querySelectorAll('.parallel-row')[1].children[1].textContent.includes('green pastures')`), true);
  await shot('parallel');

  /* ---- selection, copy, link ---- */
  await go('#Synodal_Jhn3');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('От Иоанна 3')`);
  await evaluate(`document.querySelector('.verse[data-v="16"] .vnum').click()`);
  await until(`!document.getElementById('selection-bar').hidden`);
  check('selection bar label (interface language)', await text('#selection-bar .label'), 'John 3:16');
  check('selection actions (canonical)', (await evaluate(`document.querySelectorAll('#selection-bar .button').length`)) >= 5, true);
  await evaluate(`document.querySelector('#selection-bar .button').click()`);
  await sleep(300);
  const copied = await evaluate(`navigator.clipboard.readText().catch(() => '')`);
  if (copied) check('copied text', copied.startsWith('«Ибо так возлюбил Бог мир') && copied.endsWith('(Ин 3:16, SYN)'), true);
  await evaluate(`document.querySelectorAll('#selection-bar .button')[1].click()`);
  await sleep(300);
  const link = await evaluate(`navigator.clipboard.readText().catch(() => '')`);
  if (link) check('copied link', link, `${BASE}#Synodal_Jhn3-16`);

  /* ---- my comment ---- */
  await evaluate(`[...document.querySelectorAll('#selection-bar .button')].find((b) => b.title === 'Comment').click()`);
  await until(`!!document.querySelector('.dialog textarea')`);
  await type('.dialog textarea', 'Главный стих. См. **Рим 5:8** и [[Jhn3-17]]');
  await evaluate(`document.querySelector('.dialog-actions .primary').click()`);
  await until(`!!document.querySelector('.verse[data-v="16"] .marker')`);
  check('comment marker', await text('.verse[data-v="16"] .marker'), '1');
  await until(`!!document.querySelector('.side-panel:not([hidden]) .comment')`);
  check('comment in the panel', await evaluate(`document.querySelector('.side-panel .comment strong')?.textContent`), 'Рим 5:8');
  check('verse links in the comment', await evaluate(`[...document.querySelectorAll('.side-panel .comment .verse-link')].map((a) => a.getAttribute('href'))`), ['#Rom5-8', '#Jhn3-17']);
  await shot('comment');
  await evaluate(`document.querySelector('.side-panel .icon-button').click()`);

  /* ---- Lopukhin, downloaded from settings, loaded a book at a time ---- */
  await go('#/settings');
  await until(`[...document.querySelectorAll('.pack')].some((p) => p.textContent.includes('Лопухина'))`);
  await evaluate(`[...document.querySelectorAll('.pack')].find((p) => p.textContent.includes('Лопухина')).querySelector('.button').click()`);
  await until(`[...document.querySelectorAll('.pack')].some((p) => p.textContent.includes('Лопухина') && p.querySelector('.icon-button'))`, 30000);
  await go('#Synodal_Jhn3-16');
  await until(`document.querySelector('.verse[data-v="16"] .marker')?.textContent === '2'`, 20000);
  check('Lopukhin and my comment on John 3:16', true, true);
  await evaluate(`document.querySelector('.verse[data-v="16"] .marker').click()`);
  await until(`[...document.querySelectorAll('.side-panel .panel-group h3')].some((h) => h.textContent.includes('Лопухина'))`);
  check('Lopukhin group in the panel', true, true);
  await evaluate(`document.querySelector('.side-panel .icon-button').click()`);

  /* ---- comparison ---- */
  await go('#/compare/Psa23-1');
  await until(`document.querySelectorAll('.compare-card').length >= 2`);
  check('compare: both translations', await evaluate(`document.querySelector('.page').textContent.includes('Пастырь') && document.querySelector('.page').textContent.includes('shepherd')`), true);
  check('compare: own numbering shown', await evaluate(`[...document.querySelectorAll('.compare-card .badge')].some((b) => b.textContent.includes('22:1'))`), true);

  /* ---- noncanonical ---- */
  await go('#Synodal_Dan3-30');
  await until(`!!document.querySelector('.verse.highlight')`);
  check('insertion labelled', await evaluate(`!!document.querySelector('.nc-label')`), true);
  await evaluate(`document.querySelector('.verse[data-v="30"] .vnum').click()`);
  await until(`!document.getElementById('selection-bar').hidden`);
  check('noncanonical: no compare, comment or discuss', await evaluate(`[...document.querySelectorAll('#selection-bar .button')].map((b) => b.title).filter((x) => ['Compare', 'Comment', 'Discuss'].includes(x))`), []);
  await go('#Synodal_Tob1-1');
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('Товит 1')`);
  check('deuterocanonical book opens', await evaluate(`!!document.querySelector('.reader-title .badge')`), true);

  /* ---- search: the list beside the chapter ---- */
  await go('#/search?q=%D0%B8%D0%BF%D0%BE%D1%81%D1%82%D0%B0');
  await until(`!!document.querySelector('.hit')`);
  check('part of a word: one verse', await evaluate(`document.querySelectorAll('.hit').length`), 1);
  check('the hit under its reference', await text('.hit-ref'), '(Евреям 1:3)');
  check('its chapter beside the list', await text('.preview-head h2'), 'Евреям 1');
  check('the verse lit in the chapter', await evaluate(`document.querySelector('.preview-text .verse.highlight')?.dataset.v`), '3');
  check('the word marked in the chapter', await evaluate(`document.querySelector('.preview-text .highlight mark')?.textContent`), 'ипостаси');
  await evaluate(`document.querySelector('.hit .hit-foot button').click()`);
  await sleep(300);
  const hitCopy = await evaluate(`navigator.clipboard.readText().catch(() => '')`);
  if (hitCopy) check('copied with the reference under it', hitCopy.endsWith('\n(Евреям 1:3)') && hitCopy.includes('ипостаси'), true);
  check('open goes to the reader', await evaluate(`document.querySelector('.hit .hit-foot a').getAttribute('href')`), '#Synodal_Heb1-3');

  await go('#/search?q=%D0%BB%D1%8E%D0%B1%D0%BE%D0%B2%D1%8C');
  await until(`document.querySelectorAll('.hit').length > 10`);
  check('search highlights', await evaluate(`document.querySelector('.hit mark')?.textContent.toLowerCase()`), 'любовь');
  const firstChapter = await text('.preview-head h2');
  const hash = await evaluate('location.hash');
  await evaluate(`document.querySelectorAll('.hit')[5].querySelector('.hit-text').click()`);
  await until(`document.querySelectorAll('.hit')[5].getAttribute('aria-selected') === 'true'`);
  check('a click shows another chapter, the page stays', [await evaluate(`document.querySelector('.preview-head h2').textContent !== ${JSON.stringify(firstChapter)}`), await evaluate(`location.hash.startsWith(${JSON.stringify(hash)})`)], [true, true]);
  check('the chosen hit is in the address', await evaluate(`location.hash.includes('&at=')`), true);
  await c.press('ArrowDown', 'ArrowDown', 40);
  await until(`document.querySelectorAll('.hit')[6].getAttribute('aria-selected') === 'true'`);
  check('↓ moves to the next hit', true, true);
  await shot('search');
  await evaluate(`{ const i = document.getElementById('search-input'); i.value = 'Ин 3:16'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) }`);
  await until(`location.hash === '#Jhn3-16'`);
  check('search box takes references', true, true);

  /* ---- phone ---- */
  if (SHOTS) {
    await go('#Synodal_Jhn3-16');
    await sleep(500);
    await shot('phone', { width: 390, height: 844, mobile: true, scale: 2 });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  }

  /* ---- discussions through the stub ---- */
  if (api) {
    const bookOrder = (await load('core/books')).BOOKS.map((b) => b.link);
    await go('#/discussions');
    await until(`!!document.querySelector('.q-card')`, 15000);
    check('discussions: the seed topic listed', (await texts('.q-card h3')).length >= 1, true);
    await evaluate(`document.querySelector('.q-card').click()`);
    await until(`!!document.querySelector('.argument')`);
    check('topic: two scales', await evaluate(`document.querySelectorAll('.scale-card').length`), 2);
    check('a verdict word under each scale', await evaluate(`[...document.querySelectorAll('.scale-card .verdict-word')].map((v) => v.textContent.length > 0 && /pro|con|even|none/.test(v.className))`), [true, true]);
    // Opened straight from a link, before any chapter was read: the verses still have their text.
    await send('Page.reload');
    await until(`!!document.querySelector('.stone')`, 15000);
    check('verse text shown when the topic is opened directly', await evaluate(`[...document.querySelectorAll('.stone .stone-text')].every((p) => !p.classList.contains('missing') && p.textContent.trim().length > 10)`), true);
    await evaluate(`document.querySelectorAll('.argument').forEach((a) => (a.open = true))`);
    await until(`!!document.querySelector('.stone')`);
    // Verses stand in the order of the books of the Bible, in every subtopic.
    const orders = await evaluate(`[...document.querySelectorAll('.argument')].map((a) => [...a.querySelectorAll('.stone-ref')].map((r) => r.getAttribute('href')))`);
    const position = (href) => {
      const m = /_([1-3]?[A-Za-z]+)(\d+)-(\d+)/.exec(href);
      return m ? bookOrder.indexOf(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : -1;
    };
    check('stones in Bible order', orders.every((list) => list.map(position).every((p, i, all) => p >= 0 && (i === 0 || all[i - 1] <= p))), true);
    check('each stone has three vote buttons and two columns', await evaluate(`[...document.querySelectorAll('.stone')].every((s) => s.querySelectorAll('.vote-button').length === 3 && s.querySelectorAll('.side-col').length === 2)`), true);
    await shot('discussion');

    // A verse in a discussion shows ⚖ in the reader, and its panel leads back.
    await go('#KJV_Jhn1-1');
    await until(`!!document.querySelector('.verse[data-v="1"] .marker.discussion')`, 15000);
    check('verse tag marker', true, true);
    await evaluate(`document.querySelector('.verse[data-v="1"] .marker.discussion').click()`);
    await until(`!!document.querySelector('.side-panel .tag-item')`);
    check('verse panel: the topic and the results', await evaluate(`!!document.querySelector('.side-panel .tag-item .outcomes .outcome')`), true);

    // Sign in with the stub (Google).
    await evaluate(`document.getElementById('account-button').click()`);
    await until(`document.querySelectorAll('.dialog .provider-button').length === 3`);
    check('three square sign-in buttons with logos', await evaluate(`[...document.querySelectorAll('.dialog .provider-button')].map((b) => [b.className.split(' ')[1], !!b.querySelector('svg.provider-logo'), b.textContent.trim()])`), [['apple', true, ''], ['google', true, ''], ['microsoft', true, '']]);
    await shot('sign-in');
    await evaluate(`document.querySelector('.dialog .provider-button.google').click()`);
    await until(`location.port === '${API_PORT}'`, 10000);
    await until(`!!document.querySelector('form')`);
    await evaluate(`{ const n = document.querySelector('input[name="name"]'); if (n) n.value = 'Тест'; document.querySelector('button[value="allow"]').click() }`);
    await until(`location.port === '${PAGE_PORT}' && !!document.querySelector('#account-button .avatar')`, 15000);
    check('signed in', await text('#account-button .avatar'), 'Т');
    await until(`!!document.querySelector('.dialog input')`, 5000).catch(() => undefined);
    await evaluate(`document.querySelector('.dialog .dialog-actions .primary')?.click()`);

    // Vote on a stone.
    await go('#/discussions');
    await until(`!!document.querySelector('.q-card')`);
    await evaluate(`document.querySelector('.q-card').click()`);
    await until(`!!document.querySelector('.argument')`);
    await evaluate(`{ const a = document.querySelector('.argument'); a.open = true }`);
    await until(`!!document.querySelector('.argument[open] .stone .vote-button.pro')`);
    const before = Number(await evaluate(`document.querySelector('.argument[open] .stone .vote-button.pro .count').textContent`));
    await evaluate(`document.querySelector('.argument[open] .stone .vote-button.pro').click()`);
    await until(`document.querySelector('.argument[open] .stone .vote-button.pro')?.getAttribute('aria-pressed') === 'true'`, 10000);
    check('vote counted', Number(await evaluate(`document.querySelector('.argument[open] .stone .vote-button.pro .count').textContent`)), before + 1);

    // Rate someone's interpretation +.
    const rate = `document.querySelector('.argument[open] .stone .point .rate.up:not(:disabled)')`;
    const upBefore = Number(await evaluate(`${rate}.querySelector('.count').textContent`));
    const rated = await evaluate(`${rate}.closest('.point').id`);
    await evaluate(`${rate}.click()`);
    await until(`document.getElementById('${rated}')?.querySelector('.rate.up')?.getAttribute('aria-pressed') === 'true'`, 10000);
    check('interpretation rated +', Number(await evaluate(`document.getElementById('${rated}').querySelector('.rate.up .count').textContent`)), upBefore + 1);

    // Add a verse; the same verse again is not repeated.
    const stones = await evaluate(`document.querySelectorAll('.argument[open] .stone').length`);
    const addVerse = async () => {
      await evaluate(`[...document.querySelectorAll('.argument[open] .argument-body > .button')].at(-1).click()`);
      await until(`!!document.querySelector('.dialog .input')`);
      await evaluate(`{ const i = document.querySelector('.dialog .input'); i.value = 'John 3:16'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) }`);
      await until(`!document.querySelector('.dialog')`, 10000);
    };
    await addVerse();
    await until(`[...document.querySelectorAll('.argument[open] .stone-ref')].some((r) => r.textContent === 'John 3:16')`, 10000);
    check('verse added', await evaluate(`document.querySelectorAll('.argument[open] .stone').length`), stones + 1);
    await addVerse();
    await sleep(500);
    check('the same verse is not added twice', await evaluate(`document.querySelectorAll('.argument[open] .stone').length`), stones + 1);

    // An interpretation in the first position's column; then the AI has a result for the verse.
    const stone = `[...document.querySelectorAll('.argument[open] .stone')].find((s) => s.querySelector('.stone-ref').textContent === 'John 3:16')`;
    await evaluate(`${stone}.querySelector('.side-col.pro .button').click()`);
    await until(`!!document.querySelector('.dialog textarea')`);
    await type('.dialog textarea', 'A test interpretation.');
    await evaluate(`document.querySelector('.dialog-actions .primary').click()`);
    await until(`!document.querySelector('.dialog') && !!(${stone})?.querySelector('.side-col.pro .point')`, 10000);
    check('interpretation in its column', await evaluate(`(${stone}).querySelector('.side-col.pro .point').textContent.includes('A test interpretation.')`), true);
    check('own interpretation cannot be rated', await evaluate(`(${stone}).querySelector('.side-col.pro .point .rate.up').disabled`), true);
    await until(`!(${stone}).querySelector('.pending')`, 15000);
    check('the AI rated the verse', await evaluate(`[...(${stone}).querySelectorAll('.stone-head .outcome')].length`), 2);

    // Own interpretation deleted, then the verse removed.
    await evaluate(`(${stone}).querySelector('.side-col.pro .point .button.danger').click()`);
    await until(`!!document.querySelector('.dialog-actions .primary')`);
    await evaluate(`document.querySelector('.dialog-actions .primary').click()`);
    await until(`!(${stone}).querySelector('.side-col.pro .point')`, 10000);
    await evaluate(`(${stone}).querySelector('.stone-foot .button.danger').click()`);
    await until(`!!document.querySelector('.dialog-actions .primary')`);
    await evaluate(`document.querySelector('.dialog-actions .primary').click()`);
    await until(`!(${stone})`, 10000);
    check('own verse removed', await evaluate(`document.querySelectorAll('.argument[open] .stone').length`), stones);
  }

  /* ---- the PWA offline ---- */
  await go('#Synodal_Jhn3-16');
  await until(`!!navigator.serviceWorker?.controller`, 15000);
  check('service worker controls the page', true, true);
  down = true;
  await c.navigate(`${BASE}#KJV_Psa23-1`);
  await until(`document.querySelector('.reader-title')?.textContent.startsWith('Psalms 23')`, 15000);
  check('offline: reads from IndexedDB', await evaluate(`document.querySelector('.verse[data-v="1"]').textContent.includes('shepherd')`), true);
  down = false;
  c.errors.splice(0, c.errors.length, ...c.errors.filter((e) => !/Failed to fetch|NetworkError|net::/.test(e)));

  check('no page errors', c.errors, []);
} catch (error) {
  console.error(error);
  check('ran to the end', error.message, null);
} finally {
  await c.close();
  server.close();
  api?.kill();
  await rm(out, { recursive: true, force: true });
}
done('app');
