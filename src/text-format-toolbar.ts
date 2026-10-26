// Storage format:
// Text colour  → <span style="color:#hex">…</span>
// Highlight    → <mark style="background:#hex">…</mark>
// Formatting stays within text runs; alignment is stored on block elements.
// Obsidian's MarkdownRenderer passes this HTML through on render.

import { setIcon, Platform } from 'obsidian';
import { hoistListItemSizes } from './bullet-list';
import { placeFloatingPanel, Rect } from './floating-placement';

const TEXT_COLORS: (string | null)[] = [
  null,      // Default — removes colour
  '#EF4444', '#F59E0B', '#10B981',
  '#3B82F6', '#8B5CF6', '#EC4899',
];

const HIGHLIGHT_COLORS: (string | null)[] = [
  null,      // None — removes highlight
  '#000000', '#67E8F9', '#BEF264',
  '#FCD34D', '#F9A8D4', '#D1D5DB',
];

// Per-selection text sizes, as em multipliers of whatever the card is
// already at. `null` is the reset step: it strips the font-size rather than
// writing 1em, so repeatedly resizing can't leave a pile of nested spans.
const TEXT_SIZES: { label: string; em: number | null }[] = [
  { label: 'XS', em: 0.75 },
  { label: 'S',  em: 0.9 },
  { label: 'M',  em: null },
  { label: 'L',  em: 1.25 },
  { label: 'XL', em: 1.5 },
  { label: '2X', em: 2 },
  { label: '3X', em: 2.5 },
  { label: '4X', em: 3 },
  { label: '5X', em: 4 },
];

export class TextFormatToolbar {
  private popover:     HTMLElement | null = null;
  private debounce:    number | null = null;
  private savedRange:  Range | null = null;

  private readonly onSelChange: () => void;
  private readonly onOutside:   (e: MouseEvent) => void;

  constructor(
    private readonly editor:    HTMLElement,   // contenteditable div
    private readonly cardEl:    HTMLElement,
    private readonly container: HTMLElement,
  ) {
    this.onSelChange = () => this.scheduleCheck();
    this.onOutside   = (e: MouseEvent) => {
      if (this.popover && !this.popover.contains(e.target as Node)) this.dismiss();
    };
    this.editor.ownerDocument.addEventListener('selectionchange', this.onSelChange);
  }

  // ── Selection check ────────────────────────────────────────────

  private scheduleCheck(): void {
    // On a phone, this floating popover has nowhere good to go — no
    // phone-specific sizing/positioning/keyboard-awareness exists for it,
    // and it was the leading suspect for a report of editing taking over
    // the whole screen with a white popup. iPad (isMobile && !isPhone) and
    // desktop are unaffected; a phone-appropriate replacement (routed
    // through the bottom context bar) is a separate follow-up.
    if (Platform.isPhone) return;
    if (this.debounce !== null) this.editor.ownerDocument.defaultView!.clearTimeout(this.debounce);
    this.debounce = this.editor.ownerDocument.defaultView!.setTimeout(() => {
      this.debounce = null;
      const sel = this.editor.ownerDocument.defaultView!.getSelection();
      if (!sel || sel.isCollapsed) { this.dismiss(); return; }
      if (!this.editor.contains(sel.anchorNode) || !this.editor.contains(sel.focusNode)) {
        this.dismiss(); return;
      }
      this.savedRange = sel.getRangeAt(0).cloneRange();
      if (!this.popover) this.show();
    }, 100);
  }

  // ── Popover ────────────────────────────────────────────────────

  private show(): void {
    const pop = this.popover = this.container.createDiv('visual-notes-text-fmt-toolbar');
    pop.addEventListener('pointerdown', e => e.preventDefault()); // keep editor focus + selection

    this.buildFormatRow(pop);
    this.buildAlignmentRow(pop);
    pop.createDiv('visual-notes-text-fmt-divider');
    this.buildSizeSection(pop);
    pop.createDiv('visual-notes-text-fmt-divider');
    this.buildSection(pop, 'Color',     TEXT_COLORS,      hex => this.applyColor(hex),     'color');
    pop.createDiv('visual-notes-text-fmt-divider');
    this.buildSection(pop, 'Highlight', HIGHLIGHT_COLORS, hex => this.applyHighlight(hex), 'highlight');

    this.position(pop);
    this.editor.ownerDocument.defaultView!.setTimeout(() => this.editor.ownerDocument.addEventListener('mousedown', this.onOutside), 0);
  }

  private buildFormatRow(parent: HTMLElement): void {
    const row = parent.createDiv('visual-notes-text-fmt-inline-row');
    const mkBtn = (label: string, tag: string, title: string, cls?: string) => {
      const btn = row.createDiv('visual-notes-text-fmt-inline-btn');
      btn.setAttribute('title', title);
      if (cls) btn.addClass(cls);
      const labelSpan = btn.createSpan();
      labelSpan.setText(label);
      btn.addEventListener('click', () => this.applyInlineTag(tag));
    };
    mkBtn('B', 'strong', 'Bold (⌘B)', 'visual-notes-fmt-bold');
    mkBtn('I', 'em',     'Italic (⌘I)', 'visual-notes-fmt-italic');
    mkBtn('S', 's',      'Strikethrough (⌘⇧S)', 'visual-notes-fmt-strike');
    mkBtn('U', 'u',      'Underline (⌘U)', 'visual-notes-fmt-underline');
  }

  // Sizes the selected text only, so one note can carry a big heading and
  // ordinary body text — the context bar's own Size control scales a whole
  // card at once, which can't express that on its own.
  private buildSizeSection(parent: HTMLElement): void {
    const section = parent.createDiv('visual-notes-text-fmt-section');
    const label = section.createSpan('visual-notes-text-fmt-label');
    label.setText('Size');
    const row = section.createDiv('visual-notes-text-fmt-sizes');
    for (const { label: text, em } of TEXT_SIZES) {
      const btn = row.createDiv('visual-notes-text-fmt-size-btn');
      btn.setText(text);
      btn.setAttribute('title', em === null ? 'Reset text size' : `Text size ${text}`);
      if (em === null) btn.addClass('is-reset');
      btn.addEventListener('click', () => { this.applyTextSize(em); this.dismiss(); });
    }
  }

  // ── Inline tag toggle (bold, italic, strikethrough, underline) ─

  public applyInlineTag(tag: string): void {
    this.restoreSelection();
    const sel = this.editor.ownerDocument.defaultView!.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;

    // Toggle off if entire selection sits inside an element of this tag
    const ancestor = range.commonAncestorContainer;
    const existingWrapper = (ancestor.nodeType === Node.ELEMENT_NODE
      ? ancestor as Element
      : ancestor.parentElement
    )?.closest(tag);
    if (existingWrapper && this.editor.contains(existingWrapper)) {
      const children = Array.from(existingWrapper.childNodes);
      const parent = existingWrapper.parentNode!;
      while (existingWrapper.firstChild) parent.insertBefore(existingWrapper.firstChild, existingWrapper);
      existingWrapper.remove();
      if (children.length > 0 && parent.contains(children[0]) && parent.contains(children[children.length - 1])) {
        const nr = this.editor.ownerDocument.createRange();
        nr.setStartBefore(children[0]);
        nr.setEndAfter(children[children.length - 1]);
        sel.removeAllRanges(); sel.addRange(nr);
      } else {
        sel.removeAllRanges();
      }
    } else {
      const wrapper = createEl(tag as keyof HTMLElementTagNameMap);
      this.wrapRange(range, wrapper);
      const nr = this.editor.ownerDocument.createRange();
      nr.selectNodeContents(wrapper);
      sel.removeAllRanges(); sel.addRange(nr);
    }
  }

  private buildSection(
    parent: HTMLElement,
    label:  string,
    colors: (string | null)[],
    apply:  (hex: string | null) => void,
    kind:   'color' | 'highlight',
  ): void {
    const section = parent.createDiv('visual-notes-text-fmt-section');
    const sectionLabel = section.createSpan('visual-notes-text-fmt-label');
    sectionLabel.setText(label);
    const row = section.createDiv('visual-notes-text-fmt-swatches');

    // Colour-wheel swatch (opens native picker)
    const customSw = row.createDiv('visual-notes-text-fmt-swatch');
    customSw.addClass('is-custom');
    setIcon(customSw, 'pipette');
    const colorInput = customSw.createEl('input');
    colorInput.type = 'color';
    colorInput.className = 'visual-notes-text-fmt-custom-input';
    colorInput.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
    colorInput.addEventListener('change', () => { apply(colorInput.value); this.dismiss(); });
    customSw.addEventListener('click', () => { this.restoreSelection(); colorInput.click(); });

    // Preset swatches
    for (const hex of colors) {
      const sw = row.createDiv('visual-notes-text-fmt-swatch');
      if (hex === null) {
        sw.addClass(kind === 'color' ? 'is-default' : 'is-none');
        const nullLabel = sw.createSpan('visual-notes-text-fmt-null-label');
        nullLabel.setText(kind === 'color' ? 'A' : '/');
      } else {
        sw.style.backgroundColor = hex;
        if (hex === '#000000') {
          const blackLabel = sw.createSpan('visual-notes-text-fmt-black-label');
          blackLabel.setText('A');
        }
      }
      sw.addEventListener('click', () => { apply(hex); this.dismiss(); });
    }
  }

  // ── Positioning (above the actual selected text) ───────────────

  private position(pop: HTMLElement): void {
    pop.addClass('visual-notes-invisible');
    this.editor.ownerDocument.defaultView!.requestAnimationFrame(() => {
      if (!this.popover || !this.savedRange) return;

      // Anchored to the card, not to the selection. Anchoring to the selection
      // meant "above the selected text" — which on anything but a short card
      // with the selection near its top is directly on top of the note being
      // edited. Horizontal centring still follows the selection, so the
      // popover stays near where you're typing without ever covering it.
      const rects = this.savedRange.getClientRects();
      const centerOn = rects.length > 0
        ? (rects[0].left + rects[rects.length - 1].right) / 2
        : undefined;

      // The context bar prefers the space above a card, so this takes the
      // space below — the two only need avoidance for the cases where one of
      // them has to flip.
      const avoid: Rect[] = [];
      const ctxBar = this.container.querySelector<HTMLElement>('.visual-notes-ctx-bar-panel');
      if (ctxBar && !ctxBar.hasClass('visual-notes-invisible')) {
        avoid.push(ctxBar.getBoundingClientRect());
      }

      const { top, left } = placeFloatingPanel({
        anchor: this.cardEl.getBoundingClientRect(),
        container: this.container.getBoundingClientRect(),
        panelW: pop.offsetWidth,
        panelH: pop.offsetHeight,
        prefer: 'below',
        centerOn,
        avoid,
      });

      pop.style.top  = `${top}px`;
      pop.style.left = `${left}px`;
      pop.removeClass('visual-notes-invisible');
    });
  }

  // ── Apply formatting ───────────────────────────────────────────

  private applyColor(hex: string | null): void {
    this.applyInlineStyleProp('color', hex);
  }

  // Sizes are stored in `em`, not px, so they multiply whatever the card and
  // global text scales currently are instead of fighting them — a heading
  // stays proportionally a heading when either is changed later.
  private applyTextSize(em: number | null): void {
    this.applyInlineStyleProp('font-size', em === null ? null : `${em}em`);
  }

  // Colour and size both live on <span>, so wrapRange's blanket "flatten
  // every same-tag element in range" would mean setting one silently wiped
  // the other. This clears only the property being written, and unwraps a
  // span solely once nothing else is left on it.
  private applyInlineStyleProp(prop: 'color' | 'font-size', value: string | null): void {
    this.restoreSelection();
    const sel = this.editor.ownerDocument.defaultView!.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;

    this.formatTextNodes(range, prop, value);
    if (prop === 'font-size') hoistListItemSizes(this.editor);
    this.finishFormatting();
  }

  // Work on individual text runs, never put an inline wrapper around blocks.
  // Split inline ancestors so resetting part of a coloured/highlighted run
  // also removes inherited formatting without changing its unselected text.
  private formatTextNodes(range: Range, prop: string, value: string | null): void {
    const walker = this.editor.ownerDocument.createTreeWalker(this.editor, NodeFilter.SHOW_TEXT);
    const runs: { node: Text; start: number; end: number }[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const node = current as Text;
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (end > start) runs.push({ node, start, end });
    }
    for (const { node, start, end } of runs.reverse()) {
      if (end < node.length) node.splitText(end);
      const selected = start ? node.splitText(start) : node;
      let branch: Node = selected;
      let parent = branch.parentElement;
      while (parent && parent !== this.editor && /^(SPAN|MARK|STRONG|B|EM|I|S|STRIKE|U|A|CODE)$/.test(parent.tagName)) {
        const before = parent.cloneNode(false) as HTMLElement;
        const after = parent.cloneNode(false) as HTMLElement;
        while (parent.firstChild !== branch) before.appendChild(parent.firstChild!);
        while (branch.nextSibling) after.appendChild(branch.nextSibling);
        if (before.hasChildNodes()) parent.before(before);
        if (after.hasChildNodes()) parent.after(after);
        parent.style.removeProperty(prop);
        if (prop === 'background-color') parent.style.removeProperty('background');
        const next = parent.parentElement;
        if ((parent.tagName === 'SPAN' && !parent.getAttribute('style') && !parent.className)
          || (prop === 'background-color' && parent.tagName === 'MARK')) {
          parent.replaceWith(...Array.from(parent.childNodes));
        } else branch = parent;
        parent = next;
      }
      if (value !== null) {
        const wrapper = prop === 'background-color' ? createEl('mark') : createSpan();
        wrapper.setCssProps({ [prop]: value });
        selected.before(wrapper);
        wrapper.appendChild(selected);
      }
    }
  }

  private finishFormatting(): void {
    this.savedRange = null;
    this.editor.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
    this.editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  private buildAlignmentRow(parent: HTMLElement): void {
    const row = parent.createDiv('visual-notes-text-fmt-inline-row');
    for (const [align, label] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] as const) {
      const btn = row.createEl('button', { cls: 'visual-notes-text-fmt-inline-btn', attr: { type: 'button', 'aria-label': `Align ${label.toLowerCase()}`, title: `Align ${label.toLowerCase()}` } });
      setIcon(btn, `align-${align}`);
      btn.addEventListener('click', () => { this.applyAlignment(align); this.dismiss(); });
    }
  }

  private applyAlignment(align: 'left' | 'center' | 'right'): void {
    this.restoreSelection();
    const selection = this.editor.ownerDocument.defaultView?.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!this.editor.contains(range.commonAncestorContainer)) return;
    // Group bare inline runs into blocks, leaving existing paragraphs/lists intact.
    const touched = new Set(Array.from(this.editor.childNodes).filter(node => range.intersectsNode(node)));
    const blockSelector = 'div,p,li,h1,h2,h3,h4,h5,h6,blockquote';
    const blocks = new Set(Array.from(this.editor.querySelectorAll<HTMLElement>(blockSelector))
      .filter(block => !block.querySelector(blockSelector) && range.intersectsNode(block)));
    let inline: HTMLElement | null = null;
    for (const node of Array.from(this.editor.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && /^(DIV|P|UL|OL|H[1-6]|BLOCKQUOTE)$/.test((node as Element).tagName)) {
        inline = null;

      } else {
        if (!inline) {
          inline = createDiv();
          node.before(inline);
        }
        inline.appendChild(node);
        if (touched.has(node)) blocks.add(inline);
      }
    }
    for (const block of blocks) {
      block.setCssStyles({ textAlign: align });
      for (const child of Array.from(block.querySelectorAll<HTMLElement>('[style*="text-align"]'))) {
        child.style.removeProperty('text-align');
      }
    }
    this.finishFormatting();
  }

  // A bullet marker is sized by its <li>, not by anything nested inside it,
  // so sizing a span within an item gives a big line next to a tiny bullet.
  // When the size covers the whole item, move it onto the <li> itself so the
  // marker grows with the text.
  private hoistListItemSizes(): void {
    // Selecting a whole list puts the size on a <span> wrapping the <ul>
    // instead of inside an item — push it down to the items, which is the
    // only level the marker reads.
    for (const span of Array.from(this.editor.querySelectorAll('span'))) {
      const size = span.style.fontSize;
      if (!size) continue;
      const lists = Array.from(span.querySelectorAll('ul'));
      if (!lists.length) continue;
      for (const ul of lists) {
        for (const li of Array.from(ul.children)) {
          // instanceOf, not instanceof: a board open in a popout window has
          // its own HTMLElement global, which a plain instanceof would miss.
          if (li.instanceOf(HTMLElement) && !li.style.fontSize) li.style.fontSize = size;
        }
      }
      span.style.removeProperty('font-size');
      if (!span.getAttribute('style') && !span.className) {
        span.replaceWith(...Array.from(span.childNodes));
      }
    }

    for (const li of Array.from(this.editor.querySelectorAll('li'))) {
      if (li.style.fontSize) continue;
      const sized = Array.from(li.querySelectorAll<HTMLElement>('*')).filter(el => el.style.fontSize);
      if (!sized.length) continue;

      const size = sized[0].style.fontSize;
      if (!sized.every(el => el.style.fontSize === size)) continue;
      // Only when one size covers the item's entire text. A part-resized
      // line keeps its base-size marker, which is the right answer — the
      // line itself hasn't changed size, just a word inside it.
      const covered = sized.map(el => el.textContent ?? '').join('').trim();
      if (covered !== (li.textContent ?? '').trim()) continue;

      li.style.fontSize = size;
      for (const el of sized) {
        el.style.removeProperty('font-size');
        if (el.tagName === 'SPAN' && !el.getAttribute('style') && !el.className) {
          el.replaceWith(...Array.from(el.childNodes));
        }
      }
    }
  }

  private applyHighlight(hex: string | null): void {
    this.restoreSelection();
    const sel = this.editor.ownerDocument.defaultView!.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    this.formatTextNodes(range, 'background-color', hex);
    this.finishFormatting();
  }

  private restoreSelection(): void {
    if (!this.savedRange) return;
    const sel = this.editor.ownerDocument.defaultView!.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(this.savedRange.cloneRange());
  }

  // ── DOM range helpers ──────────────────────────────────────────

  private wrapRange(range: Range, wrapper: HTMLElement): void {
    const tag = wrapper.tagName.toLowerCase();
    // Extract selection, flatten any same-type tags inside, then rewrap
    const extracted = range.extractContents();
    const tmp = createDiv();
    tmp.appendChild(extracted);
    tmp.querySelectorAll(tag).forEach(el => el.replaceWith(...Array.from(el.childNodes)));
    while (tmp.firstChild) wrapper.appendChild(tmp.firstChild);
    range.insertNode(wrapper);
    wrapper.parentElement?.normalize();
  }

  private unwrapRange(range: Range, tag: string): void {
    const extracted = range.extractContents();
    const tmp = createDiv();
    tmp.appendChild(extracted);
    tmp.querySelectorAll(tag).forEach(el => el.replaceWith(...Array.from(el.childNodes)));
    const frag = createFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    range.insertNode(frag);
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  dismiss(): void {
    this.popover?.remove();
    this.popover = null;
    this.editor.ownerDocument.removeEventListener('mousedown', this.onOutside);
  }

  destroy(): void {
    if (this.debounce !== null) this.editor.ownerDocument.defaultView!.clearTimeout(this.debounce);
    this.dismiss();
    this.editor.ownerDocument.removeEventListener('selectionchange', this.onSelChange);
  }
}
