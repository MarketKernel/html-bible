/**
 * Rebuilds the translations in data/translations/ and data/catalog.json:
 * runs the converter of each source, then the versification check and the
 * catalog. The sources must already be in private/sources/ (each converter's
 * header says how to download them).
 *
 *   node tools/translations/build.mjs            # everything
 *   node tools/translations/build.mjs kjv        # one translation (+ catalog)
 *   node tools/translations/build.mjs synodal
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CONVERTERS = { kjv: 'build-kjv.mjs', synodal: 'build-synodal.mjs' };
const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(CONVERTERS);

const run = (script) => {
  const { status } = spawnSync(process.execPath, [join(here, script)], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
};

for (const name of names) {
  if (!CONVERTERS[name]) throw new Error(`unknown source ${name}: ${Object.keys(CONVERTERS).join(', ')}`);
  run(CONVERTERS[name]);
}
run('verify-versification.mjs');
run('build-catalog.mjs');
