/**
 * Screenshots of the main screens (onboarding, parallel, a comment, the phone
 * layout, a discussion) into shots/ — the browser test run with --shots.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './load.mjs';

const dir = process.argv[2] ?? join(root, 'shots');
const { status } = spawnSync(process.execPath, [join(root, 'tests', 'app.mjs'), '--shots', dir], { stdio: 'inherit' });
console.log(`screenshots in ${dir}`);
process.exit(status ?? 1);
