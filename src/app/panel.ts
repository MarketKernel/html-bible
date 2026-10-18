/**
 * The right-hand panel of the Bible tab (a bottom sheet on a phone): comments
 * of a verse, or the discussions it is quoted in.
 */

import { t } from '../core/i18n';
import { h, icon } from './dom';

let element: HTMLElement | null = null;
let onCloseHandler: (() => void) | null = null;

export function panelElement(): HTMLElement {
  element ??= h('aside', { class: 'side-panel', hidden: true, 'aria-label': t('panel', 'Panel') });
  return element;
}

export function openPanel(title: string, body: Node, onClose?: () => void): void {
  const panel = panelElement();
  onCloseHandler?.();
  onCloseHandler = onClose ?? null;
  panel.replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', null, title), h('button', { type: 'button', class: 'icon-button', 'aria-label': t('dialog', 'Close'), on: { click: closePanel } }, icon('close'))),
    h('div', { class: 'panel-body' }, body),
  );
  panel.hidden = false;
  panel.scrollTop = 0;
}

export function closePanel(): void {
  if (!element || element.hidden) return;
  element.hidden = true;
  element.replaceChildren();
  const handler = onCloseHandler;
  onCloseHandler = null;
  handler?.();
}

export function panelOpen(): boolean {
  return !!element && !element.hidden;
}
