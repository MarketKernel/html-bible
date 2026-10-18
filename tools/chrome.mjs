/**
 * Headless Chrome over the DevTools protocol, for the browser tests and the
 * screenshots. No puppeteer: the installed Chrome is started with a debugging
 * port and spoken to through Node's built-in WebSocket.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((path) => existsSync(path));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GONE = /Inspected target navigated or closed|Cannot find context with specified id|Execution context was destroyed|Cannot find default execution context/;

export async function launch({ width = 1280, height = 860 } = {}) {
  if (!CHROME) return null;
  const profile = await mkdtemp(join(tmpdir(), 'bible-chrome-'));
  const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`];
  if (process.platform === 'linux') flags.push('--no-sandbox');
  const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const debugPort = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const target = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const waiting = new Map();
  const errors = [];
  const listeners = new Set();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(msg.params.entry.text)) errors.push(msg.params.entry.text);
    for (const listener of listeners) listener(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = async (expression, { gesture = false } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 200)}\n${r.exceptionDetails.exception?.description ?? 'eval failed'}`);
    return r.result.value;
  };
  async function until(expression, timeout = 10000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true;
      } catch (error) {
        if (!GONE.test(error.message)) throw error;
        last = error;
      }
      await sleep(60);
    }
    throw new Error(`Timed out: ${expression}${last ? `\n${last.message}` : ''}`);
  }
  const navigate = async (url) => {
    await send('Page.navigate', { url });
    await sleep(100);
    await until('document.readyState === "complete"');
  };
  const click = (selector) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('No ' + ${JSON.stringify(selector)}); n.click(); return true; })()`, { gesture: true });
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const texts = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.textContent)`);
  const type = async (selector, value) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await send('Input.insertText', { text: value });
  };
  const press = async (key, code = key, keyCode = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  const screenshot = async (path, { width: w, height: h, mobile = false, scale = 1 } = {}) => {
    if (w) await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile });
    await sleep(200);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
  };
  const close = async () => {
    try {
      ws.close();
    } catch {
      // Already gone.
    }
    chrome.kill();
    await sleep(200);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  };
  return { send, evaluate, until, navigate, click, text, texts, type, press, screenshot, close, errors, on: (l) => listeners.add(l) };
}
