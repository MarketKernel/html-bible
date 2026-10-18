/**
 * The dictionaries in src/locales against the strings the interface shows:
 * no stale keys, the same placeholders as the English text, a form for every
 * plural category of the language — and the lookup itself in src/core/i18n.ts.
 * A string a dictionary lacks is only reported: it is shown in English.
 */
import { checker, load } from '../tools/load.mjs';
import { compare, dictionaries, extract } from '../tools/i18n.mjs';

const { check, done } = checker();
const I = await load('core/i18n');
const strings = await extract();
const all = await dictionaries();
const placeholders = (text) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();

check('a dictionary per language', Object.keys(all).sort(), Object.keys(I.LANGUAGES).filter((code) => code !== 'en').sort());

for (const [language, dictionary] of Object.entries(all)) {
  const { missing, unused } = compare(strings, dictionary);
  check(`${language}: no unused strings`, unused, []);
  const lacking = Object.entries(missing).flatMap(([context, texts]) => Object.keys(texts).map((text) => `${context} / ${text}`));
  if (lacking.length) console.log(`  ${language}: ${lacking.length} strings not translated (shown in English)`);

  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories.slice().sort();
  const problems = [];
  for (const [context, texts] of Object.entries(dictionary)) {
    for (const [text, value] of Object.entries(texts)) {
      const forms = strings[context]?.[text];
      if (forms === undefined) continue;
      const expected = placeholders(text);
      if (forms === null || typeof value === 'string') {
        if (typeof value !== 'string' || !value.trim()) problems.push(`${context} / ${text}: not a text`);
        else if (JSON.stringify(placeholders(value)) !== JSON.stringify(expected)) problems.push(`${context} / ${text}: placeholders ${placeholders(value)}`);
        continue;
      }
      if (!value || typeof value !== 'object') {
        problems.push(`${context} / ${text}: neither a text nor plural forms`);
        continue;
      }
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(categories)) {
        problems.push(`${context} / ${text}: forms ${Object.keys(value)}, the language has ${categories}`);
      }
      for (const [category, form] of Object.entries(value)) {
        // A form may leave the number out ("one entry"), never anything else.
        const needed = expected.filter((name) => name !== '{count}');
        const got = placeholders(form);
        if (!got.every((name) => expected.includes(name)) || !needed.every((name) => got.includes(name))) {
          problems.push(`${context} / ${text} [${category}]: placeholders ${got}`);
        }
      }
    }
  }
  check(`${language}: well-formed translations`, problems, []);
}

// The lookup
check('english by default', I.t('comments', 'Delete'), 'Delete');
check('placeholders filled', I.t('comments', 'Comments · {verse}', { verse: 'John 3:16' }), 'Comments · John 3:16');
check('english plural: one', I.tn('comments', '{count} comment', '{count} comments', 1), '1 comment');
check('english plural: other', I.tn('comments', '{count} comment', '{count} comments', 3), '3 comments');
I.setLanguage('ru');
check('translated', I.t('comments', 'Delete'), all.ru.comments.Delete);
check('unknown text stays english', I.t('comments', 'No such thing'), 'No such thing');
check('unknown context stays english', I.t('nowhere', 'Delete'), 'Delete');
const forms = all.ru.comments['{count} comments'];
check('russian plural: one', I.tn('comments', '{count} comment', '{count} comments', 21), forms.one.replace('{count}', '21'));
check('russian plural: few', I.tn('comments', '{count} comment', '{count} comments', 3), forms.few.replace('{count}', '3'));
check('russian plural: many', I.tn('comments', '{count} comment', '{count} comments', 11), forms.many.replace('{count}', '11'));
I.setLanguage('en');
check('browser language', I.detectLanguage(['nl-NL', 'ru-RU', 'en']), 'ru');
check('browser language: none known', I.detectLanguage(['nl', 'sv']), 'en');

// Every context is in a dictionary once: JSON.parse keeps only the last of two.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../tools/load.mjs';
for (const language of Object.keys(all)) {
  const raw = await readFile(join(root, 'src', 'locales', `${language}.json`), 'utf8');
  const contexts = [...raw.matchAll(/^  "([^"]+)": \{/gm)].map((m) => m[1]);
  check(`${language}: each context once`, contexts.length, new Set(contexts).size);
}

done('i18n');
