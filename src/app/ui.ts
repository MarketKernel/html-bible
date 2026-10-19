/**
 * Toasts, dialogs and menus — the page's own, never alert() or confirm().
 */

import { t } from '../core/i18n';
import { $, h, icon } from './dom';

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const root = $('#toasts');
  const element = h('div', { class: ['toast', kind === 'error' && 'error'], role: kind === 'error' ? 'alert' : 'status' }, message);
  root.appendChild(element);
  setTimeout(() => element.remove(), kind === 'error' ? 5000 : 2600);
}

export interface DialogOptions {
  title: string;
  body: Node;
  actions?: Node[];
  wide?: boolean;
  onClose?: () => void;
  /** False while the dialog must stay open, e.g. while its form is being sent. */
  canClose?: () => boolean;
}

export interface DialogHandle {
  close: () => void;
  element: HTMLElement;
}

const open: DialogHandle[] = [];

export function dialog(options: DialogOptions): DialogHandle {
  const previous = document.activeElement as HTMLElement | null;
  const close = () => {
    if (options.canClose && !options.canClose()) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    const at = open.indexOf(handle);
    if (at >= 0) open.splice(at, 1);
    options.onClose?.();
    previous?.focus?.();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open.at(-1) === handle) {
      event.stopPropagation();
      close();
    }
  };
  const box = h(
    'div',
    { class: ['dialog', options.wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    h('div', { class: 'dialog-head' }, h('h2', null, options.title), h('button', { type: 'button', class: 'icon-button', 'aria-label': t('dialog', 'Close'), on: { click: () => close() } }, icon('close'))),
    h('div', { class: 'dialog-body' }, options.body),
    options.actions?.length ? h('div', { class: 'dialog-actions' }, options.actions) : null,
  );
  const backdrop = h('div', { class: 'backdrop', on: { mousedown: (event) => event.target === backdrop && close() } }, box);
  $('#layer').appendChild(backdrop);
  document.addEventListener('keydown', onKey, true);
  const handle = { close, element: box };
  open.push(handle);
  requestAnimationFrame(() => box.querySelector<HTMLElement>('[autofocus], input, textarea, select, .dialog-actions .primary')?.focus());
  return handle;
}

export function anyDialogOpen(): boolean {
  return open.length > 0;
}

export function confirmDialog(title: string, message: string, confirmText: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const handle = dialog({
      title,
      body: h('p', null, message),
      onClose: () => !answered && resolve(false),
      actions: [
        h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')),
        h('button', { type: 'button', class: ['button', 'primary', danger && 'danger'], on: { click: () => { answered = true; handle.close(); resolve(true); } } }, confirmText),
      ],
    });
  });
}

export interface MenuItem {
  label: string;
  icon?: string;
  action: () => void;
}

/** A small popup menu under an element. */
export function menu(anchor: HTMLElement, items: (MenuItem | 'separator')[]): void {
  const close = () => {
    element.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (event: Event) => !element.contains(event.target as Node) && close();
  const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
  const element = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((item) =>
      item === 'separator'
        ? h('hr')
        : h('button', { type: 'button', role: 'menuitem', on: { click: () => { close(); item.action(); } } }, item.icon ? icon(item.icon) : null, item.label),
    ),
  );
  $('#layer').appendChild(element);
  const rect = anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  element.style.top = `${rect.bottom + 6}px`;
  element.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  element.querySelector('button')?.focus();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The page's own prompt(): a field in a dialog; null when cancelled. */
export function askText(title: string, label: string, initial = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { class: 'input', value: initial, placeholder, autofocus: true });
    const submit = () => {
      answered = true;
      handle.close();
      resolve(input.value.trim());
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    const handle = dialog({
      title,
      body: h('label', { class: 'field' }, h('span', null, label), input),
      onClose: () => !answered && resolve(null),
      actions: [
        h('button', { type: 'button', class: 'button', on: { click: () => handle.close() } }, t('dialog', 'Cancel')),
        h('button', { type: 'button', class: 'button primary', on: { click: submit } }, t('dialog', 'OK')),
      ],
    });
  });
}
