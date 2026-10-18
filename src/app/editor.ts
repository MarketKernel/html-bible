/**
 * The Markdown editor: a textarea, buttons that wrap the selection in markup,
 * and a preview. Not contenteditable — that would take in pasted HTML.
 */

import { countImages, MAX_IMAGES, MAX_LENGTH, parseMarkdown } from '../core/markdown';
import { parseRef } from '../core/refs';
import { t } from '../core/i18n';
import { h, icon, isMac } from './dom';
import { renderMarkdown, type RefTitle } from './render-md';
import { askText } from './ui';

export interface Editor {
  element: HTMLElement;
  value: () => string;
  /** An error message when the text cannot be saved; undefined when it can. */
  problem: () => string | undefined;
  focus: () => void;
}

export function editor(initial = '', options: { placeholder?: string; refTitle?: RefTitle; rows?: number } = {}): Editor {
  const area = h('textarea', { class: 'textarea', rows: options.rows ?? 7, placeholder: options.placeholder ?? '', spellcheck: true });
  area.value = initial;
  const preview = h('div', { class: 'editor-preview', hidden: true });
  const counter = h('span');
  const error = h('span', { class: 'error' });

  const wrap = (before: string, after = before, placeholder = '') => {
    const { selectionStart: start, selectionEnd: end, value } = area;
    const selected = value.slice(start, end) || placeholder;
    area.setRangeText(`${before}${selected}${after}`, start, end, 'end');
    area.selectionStart = start + before.length;
    area.selectionEnd = start + before.length + selected.length;
    area.focus();
    update();
  };
  // The selection is lost while a dialog has focus: remember it.
  const keep = () => [area.selectionStart, area.selectionEnd] as const;
  const restore = ([start, end]: readonly [number, number]) => {
    area.focus();
    area.setSelectionRange(start, end);
  };
  const link = async () => {
    const range = keep();
    const url = await askText(t('editor', 'Link'), t('editor', 'Address (https://…)'), 'https://');
    restore(range);
    if (url && /^https?:\/\/\S+$/.test(url)) wrap('[', `](${url})`, t('editor', 'text'));
  };
  const image = async () => {
    const range = keep();
    const url = await askText(t('editor', 'Image'), t('editor', 'Image address (https://…)'), 'https://');
    restore(range);
    if (url && /^https:\/\/\S+$/.test(url)) wrap('![', `](${url})`, t('editor', 'image'));
  };
  const verse = async () => {
    const range = keep();
    const text = await askText(t('editor', 'Verse reference'), t('editor', 'For example: John 3:16'));
    restore(range);
    if (text && parseRef(text)) wrap(`[[${text}]]`, '', '');
  };

  const update = () => {
    const value = area.value;
    counter.textContent = `${value.length} / ${MAX_LENGTH}`;
    error.textContent = problem() ?? '';
    if (!preview.hidden) preview.replaceChildren(renderMarkdown(value, options.refTitle));
  };
  const problem = () => {
    const value = area.value;
    if (value.length > MAX_LENGTH) return t('editor', 'Too long: at most {max} characters.', { max: MAX_LENGTH });
    if (countImages(parseMarkdown(value)) > MAX_IMAGES) return t('editor', 'At most {max} images.', { max: MAX_IMAGES });
    return undefined;
  };

  const mod = isMac() ? '⌘' : 'Ctrl+';
  const tool = (name: string, title: string, action: () => void) =>
    h('button', { type: 'button', title, 'aria-label': title, on: { click: action } }, icon(name));
  const writeTab = h('button', { type: 'button', class: 'tab', 'aria-selected': 'true' }, t('editor', 'Write'));
  const previewTab = h('button', { type: 'button', class: 'tab', 'aria-selected': 'false' }, t('editor', 'Preview'));
  const show = (previewing: boolean) => {
    writeTab.setAttribute('aria-selected', String(!previewing));
    previewTab.setAttribute('aria-selected', String(previewing));
    area.hidden = previewing;
    preview.hidden = !previewing;
    update();
  };
  writeTab.addEventListener('click', () => show(false));
  previewTab.addEventListener('click', () => show(true));

  area.addEventListener('input', update);
  area.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'b') wrap('**');
    else if (key === 'i') wrap('*');
    else if (key === 'k') void link();
    else return;
    event.preventDefault();
  });

  const element = h(
    'div',
    { class: 'editor' },
    h(
      'div',
      { class: 'editor-tabs' },
      writeTab,
      previewTab,
      h(
        'div',
        { class: 'editor-tools' },
        tool('bold', `${t('editor', 'Bold')} (${mod}B)`, () => wrap('**')),
        tool('italic', `${t('editor', 'Italic')} (${mod}I)`, () => wrap('*')),
        tool('link', `${t('editor', 'Link')} (${mod}K)`, link),
        tool('image', t('editor', 'Image'), image),
        tool('verse', t('editor', 'Verse reference'), verse),
      ),
    ),
    area,
    preview,
    h('div', { class: 'editor-foot' }, error, counter),
  );
  update();
  return { element, value: () => area.value.trim(), problem, focus: () => area.focus() };
}
