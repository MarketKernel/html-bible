/**
 * Runs every unit test in tests/ (all but the browser test), one after another,
 * and stops at the first that fails.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './load.mjs';

const BROWSER = new Set(['app.mjs']);
const tests = readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.mjs') && !BROWSER.has(name)).sort();
for (const name of tests) {
  const { status } = spawnSync(process.execPath, [join(root, 'tests', name)], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
