// Minimal runtime stand-in for the 'obsidian' package, used only under
// vitest (see vitest.config.ts). The real package has no runtime code, so
// this exists purely so modules that reference an Obsidian class as a
// *value* (an `instanceof` check, a `new Notice(...)` call, `extends Modal`)
// can still load outside the app. Add to this only as new tests need it —
// it is not meant to be a full mock of the Obsidian API. DOM prototype
// extensions (createDiv, addClass, …) live separately in
// obsidian-dom-polyfill.ts since they're needed regardless of which
// Obsidian classes a given file imports.
/* eslint-disable @typescript-eslint/no-explicit-any */
// Note: window.require, needed by the collaboration server's Node loader, is
// set up in obsidian-dom-polyfill.ts — setupFiles run before every test module,
// whereas this stub only loads for files that import 'obsidian'.

export class TAbstractFile {
  path = '';
  name = '';
}

export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  constructor(_message: string | DocumentFragment, _duration?: number) {}
}

// Mirrors Obsidian's own implementation: collapse repeated and backslash
// separators, strip leading/trailing slashes, NFC-normalise, and return '/'
// for what's left of an empty path.
export function normalizePath(path: string): string {
  const p = path.replace(/([\\/])+/g, '/').replace(/(^\/+|\/+$)/g, '').normalize('NFC');
  return p || '/';
}

export function setIcon(_el: HTMLElement, _iconId: string): void {}

export function setTooltip(_el: HTMLElement, _tooltip: string, _options?: unknown): void {}

export function getIconIds(): string[] { return []; }

// Real Obsidian's Platform is a plain (non-readonly-typed) object of
// booleans — mutable here too, so tests can flip `Platform.isPhone` to
// exercise phone-specific branches without needing a class or a mock.
export const Platform = {
  isDesktopApp: true,
  isDesktop: true,
  isMobile: false,
  isPhone: false,
  isTablet: false,
  isSafari: false,
  isIosApp: false,
};

// Just enough of Obsidian's Setting for modules that build settings UIs
// (tile-modal.ts) to load and render without crashing — chainable methods,
// real child elements, no visual fidelity.
export class Setting {
  settingEl: HTMLElement;
  controlEl: HTMLElement;
  descEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv('setting-item');
    this.descEl = this.settingEl.createDiv('setting-item-description');
    this.controlEl = this.settingEl.createDiv('setting-item-control');
  }
  setName(_n: string): this { return this; }
  setDesc(d: string): this { this.descEl.setText(d); return this; }
  setHeading(): this { return this; }
  addText(cb: (t: any) => void): this {
    const inputEl = this.controlEl.createEl('input');
    const t = {
      inputEl,
      setPlaceholder: () => t, setValue: (v: string) => { inputEl.value = v; return t; },
      onChange: (fn: (v: string) => void) => { inputEl.addEventListener('input', () => fn(inputEl.value)); return t; },
    };
    cb(t);
    return this;
  }
  addButton(cb: (b: any) => void): this {
    const buttonEl = this.controlEl.createEl('button');
    const b = {
      buttonEl,
      setButtonText: (txt: string) => { buttonEl.setText(txt); return b; },
      setCta: () => b, setWarning: () => b,
      onClick: (fn: () => void) => { buttonEl.addEventListener('click', fn); return b; },
    };
    cb(b);
    return this;
  }
  addDropdown(cb: (d: any) => void): this {
    const selectEl = this.controlEl.createEl('select');
    const d = {
      selectEl,
      addOption: (value: string, text: string) => {
        const o = selectEl.createEl('option'); o.value = value; o.setText(text); return d;
      },
      setValue: (v: string) => { selectEl.value = v; return d; },
      onChange: (fn: (v: string) => void) => { selectEl.addEventListener('change', () => fn(selectEl.value)); return d; },
    };
    cb(d);
    return this;
  }
  addToggle(cb: (t: any) => void): this {
    const t = { setValue: () => t, onChange: () => t };
    cb(t);
    return this;
  }
}

export async function requestUrl(_opts: unknown): Promise<{ status: number; text: string; json: unknown; arrayBuffer: ArrayBuffer }> {
  return { status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0) };
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

// Real Component tracks registered children/events/intervals and tears
// them down on unload — reimplemented at the same fidelity level since
// FreeformRenderer relies on registerEvent/unload actually working (its
// own destroy() calls this.unload()).
export class Component {
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
  }
  onload(): void {}

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    for (const c of this.children) c.unload();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.onunload();
  }
  onunload(): void {}

  addChild<T extends Component>(child: T): T { this.children.push(child); child.load(); return child; }
  removeChild<T extends Component>(child: T): T {
    this.children = this.children.filter(c => c !== child);
    child.unload();
    return child;
  }

  register(cb: () => void): void { this.cleanups.push(cb); }
  registerEvent(_eventRef: unknown): void {}
  registerDomEvent(el: EventTarget, type: string, cb: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    el.addEventListener(type, cb, options);
    this.register(() => el.removeEventListener(type, cb, options));
  }
  registerInterval(id: number): number { return id; }
}

class MenuItemStub {
  private clickHandler: (() => void) | null = null;
  /** test-only: the real API discards this, but tests need to find an item by name */
  title = '';
  setTitle(t: string): this { this.title = t; return this; }
  setIcon(_i: string | null): this { return this; }
  setIsLabel(_v: boolean): this { return this; }
  setChecked(_v: boolean | null): this { return this; }
  setDisabled(_v: boolean): this { return this; }
  setSection(_s: string): this { return this; }
  setWarning(_v: boolean): this { return this; }
  onClick(fn: (evt: MouseEvent | KeyboardEvent) => void): this { this.clickHandler = fn as () => void; return this; }
  /** test-only helper — not part of the real Obsidian API */
  __trigger(): void { this.clickHandler?.(); }
}

export class Menu {
  items: MenuItemStub[] = [];
  addItem(cb: (item: MenuItemStub) => unknown): this {
    const item = new MenuItemStub();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this { return this; }
  showAtMouseEvent(_e: MouseEvent): void {}
  showAtPosition(_pos: { x: number; y: number }): void {}
  onHide(_cb: () => void): this { return this; }
  hide(): this { return this; }
}

export class Modal extends Component {
  app: unknown;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  modalEl: HTMLElement;
  scope = { register: () => {}, unregister: () => {} };

  constructor(app: unknown) {
    super();
    this.app = app;
    this.modalEl = document.createElement('div');
    this.titleEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
  }

  open(): void { this.load(); this.onOpen(); }
  close(): void { this.onClose(); this.unload(); }
  onOpen(): void {}
  onClose(): void {}
  setTitle(text: string): this { this.titleEl.textContent = text; return this; }
}

export class FuzzySuggestModal<T> extends Modal {
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ''; }
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  renderSuggestion(_item: T, _el: HTMLElement): void {}
  setPlaceholder(_text: string): void {}
}

export class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, el: HTMLElement, _sourcePath: string, _component: Component): Promise<void> {
    el.textContent = markdown;
  }
}
