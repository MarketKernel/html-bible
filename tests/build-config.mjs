/**
 * The build's addresses: file, then environment, then flag; validation of what
 * would end up in the Content-Security-Policy.
 */
import { checker, load } from '../tools/load.mjs';
import { connectSources, readConfig, validateConfig } from '../build.mjs';

const { check, done } = checker();

const base = await readConfig({ args: [], env: {} });
check('default data url: beside the page', base.dataUrl, 'data/');
check('default origins (relative data: the site, for the file from disk)', connectSources(base), ['https://bible.marketkernel.com', 'https://api.bible.marketkernel.com', 'https://auth.bible.marketkernel.com']);
const demo = await readConfig({ args: ['--config', 'config/build.demo.json'], env: {} });
check('demo: no network at all', [demo.dataUrl, connectSources(demo)], ['', []]);
const fromEnv = await readConfig({ args: [], env: { BIBLE_API_URL: 'https://api.example.org/v1/' } });
check('environment overrides the file', fromEnv.apiUrl, 'https://api.example.org/v1/');
const fromFlag = await readConfig({ args: ['--api-url', 'https://flag.example.org/v1/'], env: { BIBLE_API_URL: 'https://api.example.org/v1/' } });
check('flag overrides the environment', fromFlag.apiUrl, 'https://flag.example.org/v1/');
const inline = await readConfig({ args: ['--data-url=https://cdn.example.org/bible/'], env: {} });
check('flag with =', inline.dataUrl, 'https://cdn.example.org/bible/');
const dev = await readConfig({ args: ['--config', 'config/build.dev.json'], env: {} });
check('dev profile allows http', dev.dataUrl, 'http://localhost:8787/data/');
check('dev origins collapse', connectSources(dev), ['http://localhost:8787']);

const fails = (config) => {
  try {
    validateConfig(config);
    return false;
  } catch {
    return true;
  }
};
const good = { dev: false, dataUrl: 'https://a.example/', apiUrl: '', auth: { issuer: '', clientId: '', providers: ['google'], siteUrl: '' } };
check('valid', fails(good), false);
check('http in production', fails({ ...good, dataUrl: 'http://a.example/' }), true);
check('no trailing slash', fails({ ...good, dataUrl: 'https://a.example/data' }), true);
check('relative data', fails({ ...good, dataUrl: 'data/' }), false);
check('relative data without a slash', fails({ ...good, dataUrl: 'data' }), true);
check('data from the site root', fails({ ...good, dataUrl: '/data/' }), true);
check('data above the page', fails({ ...good, dataUrl: '../data/' }), true);
check('no data is fine', fails({ ...good, dataUrl: '' }), false);
check('relative api', fails({ ...good, apiUrl: 'v1/' }), true);
check('unknown provider', fails({ ...good, auth: { ...good.auth, providers: ['facebook'] } }), true);
check('no api is fine', fails({ ...good, apiUrl: '' }), false);

// Where the page reads its data from.
const { dataBase } = await load('core/config');
const site = (dataUrl, siteUrl = 'https://bible.example/') => ({ dataUrl, apiUrl: '', auth: { issuer: '', clientId: '', providers: [], siteUrl } });
check('relative: beside the page', dataBase(site('data/'), 'https://preview.pages.dev/app/#Jhn3'), 'https://preview.pages.dev/app/data/');
check('relative: from disk, beside the site', dataBase(site('data/'), 'file:///Users/x/html-bible.html'), 'https://bible.example/data/');
check('relative: from disk, no site', dataBase(site('data/', ''), 'file:///x.html'), '');
check('absolute stays', dataBase(site('https://cdn.example/bible/'), 'file:///x.html'), 'https://cdn.example/bible/');
check('none', dataBase(site(''), 'https://bible.example/'), '');

done('build config');
