/**
 * Bundles src/ into ONE self-contained build/html-bible.html, and beside it
 * build/pages/: the same page as an installable PWA.
 *
 * Styles, the icon and the compiled TypeScript are inlined; translations are
 * not — the page downloads them (or opens a file) into IndexedDB. So unlike a
 * fully offline single-file app, this one talks to three places, all set at
 * build time and written into the Content-Security-Policy:
 *   dataUrl — catalog, translations, commentaries; relative ("data/") means
 *             beside the page, and from disk beside auth.siteUrl; empty means
 *             the page downloads nothing (the demo: files only);
 *   apiUrl  — the discussions API;
 *   auth.issuer — sign-in (Cognito, or the local stub).
 *
 * --out DIR puts the result somewhere other than build/.
 *
 * Addresses: config/build.json, or --config <file>; any of them overridden by
 * a flag (--data-url, --api-url, --auth-issuer, --auth-client-id, --site-url)
 * or an environment variable (BIBLE_DATA_URL, BIBLE_API_URL, BIBLE_AUTH_ISSUER,
 * BIBLE_AUTH_CLIENT_ID, BIBLE_SITE_URL). Flag beats environment beats file.
 *
 * The version is package.json's and nowhere else.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const at = (...parts) => join(root, ...parts);
const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
// --out DIR: build somewhere else (the browser test builds its own copy with its own addresses).
const outAt = argv.indexOf('--out');
const outDir = outAt >= 0 ? argv[outAt + 1] : at('build');
const outFile = join(outDir, 'html-bible.html');
const SIZE_BUDGET = 250 * 1024;

/** package.json's version; with the commit when HEAD is not the tagged release. */
async function readRelease() {
  const { version } = JSON.parse(await readFile(at('package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json: the version must be x.y.z, not ${version}`);
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const tagged = process.env.RELEASE_TAG === `v${version}` || git('tag', '--points-at', 'HEAD').split('\n').includes(`v${version}`);
  const commit = tagged ? '' : git('rev-parse', '--short', 'HEAD');
  return { version, label: commit ? `${version}+${commit}` : version };
}

/**
 * The addresses for this build. Exported so tests check the precedence and
 * the validation without building.
 */
export async function readConfig({ args = argv, env = process.env } = {}) {
  const get = (name) => {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];
    return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const file = get('--config') ?? 'config/build.json';
  const base = JSON.parse(await readFile(join(root, file), 'utf8'));
  const pick = (flagName, envName, value) => get(flagName) ?? env[envName] ?? value;
  const config = {
    dev: base.dev === true,
    dataUrl: pick('--data-url', 'BIBLE_DATA_URL', base.dataUrl ?? ''),
    apiUrl: pick('--api-url', 'BIBLE_API_URL', base.apiUrl ?? ''),
    auth: {
      issuer: pick('--auth-issuer', 'BIBLE_AUTH_ISSUER', base.auth?.issuer ?? ''),
      clientId: pick('--auth-client-id', 'BIBLE_AUTH_CLIENT_ID', base.auth?.clientId ?? ''),
      providers: base.auth?.providers ?? ['google', 'apple', 'microsoft'],
      siteUrl: pick('--site-url', 'BIBLE_SITE_URL', base.auth?.siteUrl ?? ''),
    },
  };
  validateConfig(config, file);
  return config;
}

export function validateConfig(config, file = 'config') {
  const check = (name, value, optional) => {
    if (!value && optional) return;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${file}: ${name} must be an absolute address, not "${value}"`);
    }
    if (url.protocol !== 'https:' && !(config.dev && url.protocol === 'http:')) throw new Error(`${file}: ${name} must be https (http only in a dev profile): ${value}`);
    if (!value.endsWith('/')) throw new Error(`${file}: ${name} must end with "/": ${value}`);
  };
  if (isRelative(config.dataUrl)) {
    if (config.dataUrl.startsWith('/') || config.dataUrl.split('/').includes('..')) throw new Error(`${file}: a relative dataUrl stays inside the page's folder: ${config.dataUrl}`);
    if (!config.dataUrl.endsWith('/')) throw new Error(`${file}: dataUrl must end with "/": ${config.dataUrl}`);
  } else check('dataUrl', config.dataUrl, true);
  check('apiUrl', config.apiUrl, true);
  check('auth.issuer', config.auth.issuer, true);
  check('auth.siteUrl', config.auth.siteUrl, true);
  for (const provider of config.auth.providers) {
    if (!['google', 'apple', 'microsoft'].includes(provider)) throw new Error(`${file}: unknown sign-in provider ${provider}`);
  }
}

/** "data/" — read beside the page; "" and absolute addresses are not relative. */
const isRelative = (value) => !!value && !/^[a-z][a-z0-9+.-]*:/i.test(value);

/**
 * The origins the page may fetch from. A relative dataUrl is the page's own
 * origin ('self', which the PWA always has), and the site's for the single
 * file opened from disk.
 */
export function connectSources(config) {
  const origins = new Set();
  const data = isRelative(config.dataUrl) ? config.auth.siteUrl : config.dataUrl;
  for (const value of [data, config.apiUrl, config.auth.issuer]) if (value) origins.add(new URL(value).origin);
  return [...origins];
}

/** `</script` inside a string literal would close the inline tag early. */
const guard = (code) => code.replace(/<\/(script|style)/gi, '<\\/$1');

/**
 * "<!--" followed later by "<script" in a script puts the HTML parser into the
 * "double escaped" state, where </script> no longer closes the tag and the page
 * runs nothing at all.
 */
function assertScriptCloses(code) {
  const open = code.indexOf('<!--');
  if (open >= 0 && /<script/i.test(code.slice(open))) throw new Error('The bundle has "<!--" followed by "<script": the page would not run');
}

let release;
let config;

async function bundle(entry) {
  const result = await build({
    entryPoints: [at(entry)],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    minify: !watch,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    define: {
      __APP_VERSION__: JSON.stringify(release.label),
      __CONFIG__: JSON.stringify({ dataUrl: config.dataUrl, apiUrl: config.apiUrl, auth: config.auth }),
    },
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('esbuild returned an empty result');
  return output.text;
}

/** Nothing but the configured addresses may be reached: no script, style or font from elsewhere. */
function assertSelfContained(html) {
  const offenders = [
    [/<script[^>]+\ssrc=/i, '<script src=…>'],
    [/<link[^>]+href=["'](?!data:|manifest|apple-touch-icon)/i, '<link href=…>'],
    [/@import\s+(url\()?["']?(?!data:)/i, '@import'],
    [/url\(\s*["']?https?:/i, 'url(http…)'],
  ];
  for (const [pattern, name] of offenders) {
    if (pattern.test(html)) throw new Error(`An external reference is left in the file: ${name}`);
  }
}

/**
 * The policy, filled in: connect-src gets the configured origins, script-src
 * the hash of the one inline script instead of 'unsafe-inline' — so even a
 * bug in rendering someone's comment could not run a handler from it.
 */
function applyPolicy(html, { extraConnect = [], pwa = false } = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!script) throw new Error('The page has no inline script');
  if (html.indexOf('<script>', script.index + 1) >= 0) throw new Error('The page must have exactly one inline script');
  const hash = createHash('sha256').update(script[1], 'utf8').digest('base64');
  const pattern = /(http-equiv="Content-Security-Policy" content=")([^"]*)/;
  if (!pattern.test(html)) throw new Error('The Content-Security-Policy meta tag is missing');
  return html.replace(pattern, (_, attr, policy) => {
    const directives = new Map(policy.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...sources]) => [name, sources]));
    directives.set('script-src', [`'sha256-${hash}'`]);
    const connect = [...(pwa || isRelative(config.dataUrl) ? ["'self'"] : []), ...connectSources(config), ...extraConnect];
    directives.set('connect-src', connect.length ? connect : ["'none'"]);
    if (pwa) {
      directives.get('img-src').push("'self'");
      directives.set('manifest-src', ["'self'"]);
      directives.set('worker-src', ["'self'"]);
    }
    return attr + [...directives].map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
  });
}

async function buildPages(page) {
  const dir = join(outDir, 'pages');
  const head = [
    '<link rel="manifest" href="manifest.webmanifest">',
    '<meta name="theme-color" content="#f7f4ee" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#16171b" media="(prefers-color-scheme: dark)">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    // The page registers the worker itself (update.ts): this is how it knows it is the PWA.
    '<meta name="service-worker" content="sw.js">',
  ].join('\n');
  const html = applyPolicy(page.replace('</head>', () => `${head}\n</head>`), { pwa: true });
  const cache = `${release.version}-${createHash('sha256').update(html).digest('hex').slice(0, 12)}`;
  const manifest = {
    name: 'Bible',
    short_name: 'Bible',
    description: 'The Bible with search, verse links, commentaries and discussions',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f7f4ee',
    theme_color: '#7a2e2e',
    icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  };
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const worker = (await readFile(at('src/pwa/sw.js'), 'utf8')).replaceAll('__CACHE__', cache).replaceAll('__VERSION__', release.label);
  await Promise.all([
    writeFile(join(dir, 'index.html'), html, 'utf8'),
    writeFile(join(dir, 'sw.js'), worker, 'utf8'),
    writeFile(join(dir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(join(dir, 'icon.svg'), await readFile(at('assets/icon.svg'))),
    writeFile(join(dir, '.nojekyll'), '', 'utf8'),
  ]);
  console.log(`${relative(root, dir)}/ — PWA (cache ${cache})`);
}

async function buildOnce() {
  release = await readRelease();
  config = await readConfig();
  const [template, styles, icon, appJs] = await Promise.all([
    readFile(at('src/app/template.html'), 'utf8'),
    readFile(at('src/app/styles.css'), 'utf8'),
    readFile(at('assets/icon.svg'), 'utf8'),
    bundle('src/app/main.ts'),
  ]);
  assertScriptCloses(appJs);
  const svg = icon.replace(/<\?xml[\s\S]*?\?>/, '').trim();
  const iconUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  const page = template
    .replace('/*__STYLES__*/', () => styles)
    .replace('/*__APP__*/', () => guard(appJs))
    .replaceAll('__ICON__', () => iconUri);
  assertSelfContained(page);
  const html = applyPolicy(page);

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, html, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');
  const kb = (n) => (n / 1024).toFixed(1);
  console.log(`${relative(root, outFile)} ${release.label} — ${kb(bytes)} KB (code ${kb(appJs.length)} KB, styles ${kb(styles.length)} KB)${config.dev ? ' [dev]' : ''}`);
  if (bytes > SIZE_BUDGET) console.warn(`  over the ${kb(SIZE_BUDGET)} KB budget`);
  await buildPages(page);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildOnce();
  if (watch) {
    const { watch: watchDir } = await import('node:fs');
    let pending = null;
    for (const dir of ['src', 'assets', 'config']) {
      watchDir(at(dir), { recursive: true }, () => {
        clearTimeout(pending);
        pending = setTimeout(() => buildOnce().catch((error) => console.error(error.message)), 120);
      });
    }
    console.log('watching src/, assets/ and config/ …');
  }
}
