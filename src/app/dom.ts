/**
 * Building DOM by hand, without innerHTML anywhere: every text goes in as a
 * text node, so nothing a translation file, a commentary or another user
 * wrote can become markup.
 */

type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (event: Event) => void;

export interface Props {
  class?: string | (string | false | null | undefined)[];
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, Handler>>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  [attribute: string]: unknown;
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') {
        element.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      } else if (key === 'dataset') {
        Object.assign(element.dataset, value);
      } else if (key === 'on') {
        for (const [name, handler] of Object.entries(value as Record<string, Handler>)) element.addEventListener(name, handler);
      } else if (key === 'style') {
        for (const [name, v] of Object.entries(value as Record<string, string>)) element.style.setProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v);
      } else if (value === true) {
        element.setAttribute(key, '');
      } else if (key in element && typeof value !== 'string') {
        (element as unknown as Record<string, unknown>)[key] = value;
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }
  append(element, children);
  return element;
}

export function fragment(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`No ${selector}`);
  return element;
}

export function clear(element: Element, ...children: Child[]): void {
  element.replaceChildren();
  append(element, children);
}

/* ---------------- icons ---------------- */

const PATHS: Record<string, string[]> = {
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 6l6 6-6 6'],
  down: ['M6 9l6 6 6-6'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  share: ['M12 3v12', 'M7 8l5-5 5 5', 'M5 14v6h14v-6'],
  compare: ['M4 6h7', 'M4 12h7', 'M4 18h7', 'M13 6h7', 'M13 12h7', 'M13 18h7'],
  comment: ['M4 5h16v11H9l-5 4z'],
  scale: ['M12 4v16', 'M7 20h10', 'M5 8h14', 'M5 8l-3 6a3 3 0 0 0 6 0z', 'M19 8l-3 6a3 3 0 0 0 6 0z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-5-5'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 19V5'],
  columns: ['M4 4h7v16H4z', 'M13 4h7v16h-7z'],
  edit: ['M4 20h4L19 9l-4-4L4 16z'],
  trash: ['M5 7h14', 'M9 7V4h6v3', 'M7 7l1 13h8l1-13'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  upload: ['M12 16V5', 'M7 10l5-5 5 5', 'M5 20h14'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z'],
  bold: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'],
  italic: ['M10 5h8', 'M6 19h8', 'M14 5l-4 14'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15 9h.01'],
  verse: ['M6 4h9l3 3v13H6z', 'M9 11h6', 'M9 15h6'],
  plus: ['M12 5v14', 'M5 12h14'],
  up: ['M7 14l5-5 5 5'],
  check: ['M5 12l5 5 9-10'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'],
  logout: ['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'],
};

export function icon(name: keyof typeof PATHS | string, label?: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  if (label) svg.setAttribute('aria-label', label);
  else svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export const isTouch = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches;
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
