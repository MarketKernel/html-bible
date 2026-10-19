/**
 * The PWA's updates. Only the page served with <meta name="service-worker">
 * (build/pages) registers the worker; the single file does nothing here.
 *
 * A new worker does not take over by itself: it installs beside the old one
 * and waits. The page offers "Update"; the worker is told to activate, and the
 * page reloads when it does.
 */

import { t } from '../core/i18n';
import { $, h } from './dom';

export function initUpdates(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="service-worker"]');
  if (!meta || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const offer = (worker: ServiceWorker) => {
    const button = h('button', { type: 'button', class: 'button small primary', style: { pointerEvents: 'auto', marginInlineStart: '8px' } }, t('update', 'Update'));
    const note = h('div', { class: 'toast', style: { pointerEvents: 'auto' } }, t('update', 'A new version is ready.'), button);
    button.addEventListener('click', () => worker.postMessage('activate'));
    $('#toasts').appendChild(note);
  };
  // The first worker claims the page too (clients.claim), which fires
  // controllerchange; reloading then would throw away a first run half done
  // (the translations chosen, downloads under way). Only a worker replacing
  // another one is an update.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register(meta.content)
    .then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
        });
      });
      // A quiet check every six hours and when the network comes back.
      setInterval(() => registration.update().catch(() => undefined), 6 * 3600 * 1000);
      window.addEventListener('online', () => registration.update().catch(() => undefined));
    })
    .catch(() => undefined);
}
