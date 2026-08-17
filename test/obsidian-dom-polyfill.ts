// Obsidian patches a large set of DOM convenience methods (createDiv,
// addClass, empty, setText, …) onto Node/Element/HTMLElement.prototype at
// app startup — none of it ships in the 'obsidian' npm package (types
// only), and none of it exists in plain jsdom. This reimplements the
// subset FreeformRenderer's rendering code actually uses, matching the
// documented signatures in node_modules/obsidian/obsidian.d.ts. Loaded once
// via vitest's setupFiles (jsdom environment only — see vitest.config.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';

// Unguarded, and first: this runs in BOTH environments, unlike the DOM
// patching below. Obsidian exposes Electron's module loader as window.require
// on desktop, and collaboration-server/src/desktop-node.ts reads it there
// rather than from globalThis (Obsidian's review asks for window, for popout
// compatibility). Tests run in plain Node, so stand up window itself under the
// default environment and give it a real require in both. Done in the setup
// file rather than obsidian-stub.ts because setupFiles are guaranteed to run
// before any test module — and the modules that need this do not all import
// 'obsidian', so the stub is not reliably evaluated first.
const testWindow = ((globalThis as any).window ??= {}) as {
  require?: (id: string) => unknown;
  crypto?: Crypto;
};
testWindow.require ??= createRequire(import.meta.url);
// Real Obsidian's window carries WebCrypto; a bare stand-in window does not,
// and the collaboration stores use it for temporary-file suffixes.
testWindow.crypto ??= globalThis.crypto;

interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

function applyInfo(el: HTMLElement, o?: DomElementInfo | string): void {
  const info: DomElementInfo | undefined = typeof o === 'string' ? { cls: o } : o;
  if (!info) return;
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/).filter(Boolean);
    if (classes.length) el.classList.add(...classes);
  }
  if (info.text !== undefined) {
    if (info.text instanceof DocumentFragment) el.appendChild(info.text);
    else el.textContent = info.text;
  }
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) { if (v !== null && v !== undefined) el.setAttribute(k, String(v)); }
  if (info.title) el.setAttribute('title', info.title);
  if (info.value !== undefined) (el as any).value = info.value;
  if (info.type !== undefined) (el as any).type = info.type;
  if (info.placeholder !== undefined) (el as any).placeholder = info.placeholder;
  if (info.href !== undefined) (el as any).href = info.href;
}

function createElOn(parentEl: Node, tag: string, o?: DomElementInfo | string, callback?: (el: any) => void): any {
  const el = document.createElement(tag);
  applyInfo(el, o);
  const info = typeof o === 'string' ? undefined : o;
  const target = info?.parent ?? parentEl;
  if (info?.prepend && target.firstChild) target.insertBefore(el, target.firstChild);
  else target.appendChild(el);
  callback?.(el);
  return el;
}

// Guarded: setupFiles run for every test file regardless of that file's own
// environment, and most of this suite runs in the (much faster) default
// `node` environment, where none of these globals exist at all — only files
// with `// @vitest-environment jsdom` at the top need any of this.
if (typeof HTMLElement !== 'undefined') {
const NodeProto = Node.prototype as any;
const ElementProto = Element.prototype as any;
const HTMLElementProto = HTMLElement.prototype as any;

NodeProto.empty = function (this: Node) { while (this.firstChild) this.removeChild(this.firstChild); };
NodeProto.detach = function (this: Node) { this.parentNode?.removeChild(this); };
NodeProto.appendText = function (this: Node, val: string) { this.appendChild(document.createTextNode(val)); };
NodeProto.instanceOf = function (this: unknown, type: new () => unknown) { return this instanceof type; };
NodeProto.createEl = function (this: Node, tag: string, o?: DomElementInfo | string, cb?: (el: any) => void) { return createElOn(this, tag, o, cb); };
NodeProto.createDiv = function (this: Node, o?: DomElementInfo | string, cb?: (el: any) => void) { return createElOn(this, 'div', o, cb); };
NodeProto.createSpan = function (this: Node, o?: DomElementInfo | string, cb?: (el: any) => void) { return createElOn(this, 'span', o, cb); };
NodeProto.createSvg = function (this: Node, tag: string, o?: DomElementInfo | string, cb?: (el: any) => void) { return createElOn(this, tag, o, cb); };

ElementProto.getText = function (this: Element) { return this.textContent ?? ''; };
ElementProto.setText = function (this: Element, val: string | DocumentFragment) {
  (this as any).empty();
  if (val instanceof DocumentFragment) this.appendChild(val);
  else this.textContent = val;
};
// Real Obsidian tolerates space-separated strings anywhere a class name is
// expected (e.g. addClass('foo bar')), unlike native classList — split
// every entry on whitespace to match.
function splitClasses(classes: string[]): string[] {
  return classes.flatMap(c => c.split(/\s+/)).filter(Boolean);
}
ElementProto.addClass = function (this: Element, ...classes: string[]) { this.classList.add(...splitClasses(classes)); };
ElementProto.addClasses = function (this: Element, classes: string[]) { this.classList.add(...splitClasses(classes)); };
ElementProto.removeClass = function (this: Element, ...classes: string[]) { this.classList.remove(...splitClasses(classes)); };
ElementProto.removeClasses = function (this: Element, classes: string[]) { this.classList.remove(...splitClasses(classes)); };
ElementProto.toggleClass = function (this: Element, classes: string | string[], value: boolean) {
  for (const c of splitClasses(Array.isArray(classes) ? classes : [classes])) this.classList.toggle(c, value);
};
ElementProto.hasClass = function (this: Element, cls: string) { return this.classList.contains(cls); };
ElementProto.setAttr = function (this: Element, name: string, value: string | number | boolean | null) {
  if (value === null || value === undefined) this.removeAttribute(name); else this.setAttribute(name, String(value));
};
ElementProto.setAttrs = function (this: Element, obj: Record<string, string | number | boolean | null>) {
  for (const [k, v] of Object.entries(obj)) (this as any).setAttr(k, v);
};
ElementProto.getAttr = function (this: Element, name: string) { return this.getAttribute(name); };
ElementProto.find = function (this: Element, selector: string) { return this.querySelector(selector); };
ElementProto.findAll = function (this: Element, selector: string) { return Array.from(this.querySelectorAll(selector)); };
ElementProto.findAllSelf = function (this: Element, selector: string) { return Array.from(this.querySelectorAll(selector)); };
ElementProto.matchParent = function (this: Element, selector: string) { return this.closest(selector)?.parentElement?.closest(selector) ?? null; };

HTMLElementProto.show = function (this: HTMLElement) { this.style.display = ''; };
HTMLElementProto.hide = function (this: HTMLElement) { this.style.display = 'none'; };
HTMLElementProto.toggle = function (this: HTMLElement, show: boolean) { show ? (this as any).show() : (this as any).hide(); };
HTMLElementProto.toggleVisibility = function (this: HTMLElement, visible: boolean) { (this as any).toggle(visible); };
HTMLElementProto.isShown = function (this: HTMLElement) { return this.style.display !== 'none'; };
// Real Obsidian's setCssStyles/setCssProps work on any styleable Element,
// SVG included (ink/connection paths style themselves this way) — patched
// on ElementProto, not HTMLElementProto, to match. SVGElement has a real
// .style in both browsers and jsdom.
ElementProto.setCssStyles = function (this: Element, styles: Partial<CSSStyleDeclaration>) { Object.assign((this as HTMLElement).style, styles); };
ElementProto.setCssProps = function (this: Element, props: Record<string, string>) { for (const [k, v] of Object.entries(props)) (this as HTMLElement).style.setProperty(k, v); };
HTMLElementProto.onClickEvent = function (this: HTMLElement, listener: EventListener, options?: boolean | AddEventListenerOptions) {
  this.addEventListener('click', listener, options);
};
HTMLElementProto.on = function (this: HTMLElement, type: string, selector: string, listener: (this: HTMLElement, ev: Event, target: HTMLElement) => void, options?: boolean | AddEventListenerOptions) {
  const wrapped = (ev: Event) => {
    const target = (ev.target as HTMLElement | null)?.closest(selector) as HTMLElement | null;
    if (target && this.contains(target)) listener.call(this, ev, target);
  };
  (this as any)._EVENTS ??= {};
  ((this as any)._EVENTS[type] ??= []).push({ selector, listener, callback: wrapped, options });
  this.addEventListener(type, wrapped, options);
};
HTMLElementProto.off = function (this: HTMLElement, type: string, selector: string, listener: unknown) {
  const list: any[] | undefined = (this as any)._EVENTS?.[type];
  if (!list) return;
  const idx = list.findIndex(e => e.selector === selector && e.listener === listener);
  if (idx >= 0) { this.removeEventListener(type, list[idx].callback); list.splice(idx, 1); }
};

(globalThis as any).createEl = (tag: string, o?: DomElementInfo | string, cb?: (el: any) => void) => {
  const el = document.createElement(tag);
  applyInfo(el, o);
  cb?.(el);
  return el;
};
(globalThis as any).createDiv = (o?: DomElementInfo | string, cb?: (el: any) => void) => (globalThis as any).createEl('div', o, cb);
(globalThis as any).createSpan = (o?: DomElementInfo | string, cb?: (el: any) => void) => (globalThis as any).createEl('span', o, cb);
(globalThis as any).createFragment = (cb?: (el: DocumentFragment) => void) => {
  const frag = document.createDocumentFragment();
  cb?.(frag);
  return frag;
};
(globalThis as any).createSvg = (tag: string, o?: DomElementInfo | string, cb?: (el: any) => void) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyInfo(el as unknown as HTMLElement, o);
  cb?.(el);
  return el;
};

// jsdom doesn't implement ResizeObserver at all.
if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// Obsidian's cross-window-capable aliases for document/window (support for
// popped-out panes) — plain document/window is a faithful enough stand-in.
if (!(globalThis as any).activeDocument) (globalThis as any).activeDocument = document;
if (!(globalThis as any).activeWindow) (globalThis as any).activeWindow = window;

// jsdom implements neither of these, and drag/resize code calls both.
if (!HTMLElementProto.setPointerCapture) HTMLElementProto.setPointerCapture = function () {};
if (!HTMLElementProto.releasePointerCapture) HTMLElementProto.releasePointerCapture = function () {};
if (!HTMLElementProto.hasPointerCapture) HTMLElementProto.hasPointerCapture = function () { return false; };
if (!(document as any).elementsFromPoint) (document as any).elementsFromPoint = () => [];
} // end typeof HTMLElement guard
