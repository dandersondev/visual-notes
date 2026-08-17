import {
  App, TFile, Notice, setIcon,
  MarkdownRenderer, sanitizeHTMLToDom,
} from 'obsidian';
import {
  TileCard, StickyCard, ChecklistCard, ChecklistItem, NoteLinkCard,
  Card, CommentCard, CommentReply,
  SwatchCard, FileCard, CalloutCard, GroupCard, STICKY_FONT_FAMILIES, TextCard,
  TEXT_CARD_DEFAULT_FONT,
} from './file-types';
import { contrastColor, isHexColor } from './color-utils';
import {
  resolveThumbnailSrc,
} from './thumbnail-utils';
import { nearestColorName, randomNamedColor, NamedColor } from './named-colors';
import { TileModal } from './tile-modal';
import { isCustomIconRef, resolveCustomIconSrc } from './custom-icons';
import { TextFormatToolbar } from './text-format-toolbar';
import { toggleBulletList } from './bullet-list';
import { sortAssetFile, saveNewAsset } from './asset-manager';
import {
  TILE_DEFAULT_W, TILE_DEFAULT_H, STICKY_DEFAULT_W, STICKY_DEFAULT_H,
  CHECKLIST_DEFAULT_W, CHECKLIST_DEFAULT_H,
  COMMENT_DEFAULT_W, COMMENT_DEFAULT_H,
  NOTELINK_DEFAULT_W, NOTELINK_DEFAULT_H, NOTELINK_TITLE_W, NOTELINK_TITLE_H,
  SWATCH_DEFAULT_W, SWATCH_DEFAULT_H,
  FILE_DEFAULT_W, FILE_DEFAULT_H,
  CALLOUT_DEFAULT_W, CALLOUT_DEFAULT_H, GROUP_DEFAULT_W, GROUP_DEFAULT_H,
  GROUP_PAD, AUDIO_EXTS,
  IMAGE_EXTS,
  resolveDefaultStickyColor, applyStickyTextScale, commentInitial, formatCommentTime,
  NoteLinkPickerModal, VaultAnyFilePickerModal,
  MediaSourceModal, openExternalUrl, safeRemoteImageSrc,
} from './freeform-view-shared';
import {
  clipMetaFromFrontmatter, stripFrontmatter, displayDomain,
} from './web-clip-import';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    renderTileContent(el: HTMLElement, tile: TileCard): void;
    renderTileIcon(square: HTMLElement, tile: TileCard, iconColor: string, iconSize: number): void;
    renderStickyContent(el: HTMLElement, card: StickyCard): void;
    editStickyInline(el: HTMLElement, card: StickyCard): void;
    renderChecklistContent(el: HTMLElement, card: ChecklistCard): void;
    appendChecklistItem(listEl: HTMLElement, card: ChecklistCard, item: ChecklistItem): HTMLElement;
    appendChecklistGhost(listEl: HTMLElement, card: ChecklistCard): HTMLElement;
    rebuildChecklistList(listEl: HTMLElement, card: ChecklistCard): void;
    startChecklistItemDrag(
        startEvent: PointerEvent,
        listEl: HTMLElement,
        card: ChecklistCard,
        item: ChecklistItem,
        itemEl: HTMLElement,
      ): void;
    setHeaderCheckboxState(cb: HTMLInputElement, card: ChecklistCard, headerId: string): void;
    refreshHeaderCheckbox(listEl: HTMLElement, card: ChecklistCard, headerId: string): void;
    findChecklistIndentTarget(card: ChecklistCard, item: ChecklistItem): ChecklistItem | null;
    indentChecklistItem(card: ChecklistCard, item: ChecklistItem, row: HTMLElement): boolean;
    outdentChecklistItem(item: ChecklistItem, row: HTMLElement): boolean;
    deleteChecklistItem(listEl: HTMLElement, card: ChecklistCard, item: ChecklistItem, row: HTMLElement): void;
    renderCommentContent(el: HTMLElement, card: CommentCard): void;
    appendCommentReply(listEl: HTMLElement, card: CommentCard, reply: CommentReply): HTMLElement;
    appendCommentReplyGhost(listEl: HTMLElement, card: CommentCard): HTMLElement;
    renderNoteLinkContent(el: HTMLElement, card: NoteLinkCard): void;
    renderSwatchContent(el: HTMLElement, card: SwatchCard): void;
    addSwatchAt(x: number, y: number): void;
    fileTypeIcon(ext: string): string;
    formatFileSize(bytes: number): string;
    renderFileContent(el: HTMLElement, card: FileCard): void;
    openFileCard(card: FileCard): Promise<void>;
    renderCalloutContent(el: HTMLElement, card: CalloutCard): void;
    editCalloutInline(el: HTMLElement, _card: CalloutCard): void;
    addCalloutAt(x: number, y: number): void;
    renderGroupContent(el: HTMLElement, card: GroupCard): void;
    editGroupLabel(el: HTMLElement, card: GroupCard): void;
    cardsContainedInGroup(group: GroupCard): string[];
    groupSelected(): void;
    addGroupAt(x: number, y: number): void;
    addFileAt(x: number, y: number): void;
    createSwatchGrid(x: number, y: number, colors: NamedColor[]): void;
    rebuildChecklistCard(card: ChecklistCard): void;
    addTile(): void;
    addTileAt(x: number, y: number): void;
    prepareBoardTileCollaboration(tile: TileCard): Promise<void>;
    addSticky(): void;
    addStickyAt(x: number, y: number, initialText?: string): void;
    addBlankCard(): void;
    addBlankCardAt(x: number, y: number): void;
    addTextCardAt(x: number, y: number): void;
    renderTextContent(el: HTMLElement, card: TextCard): void;
    editTextInline(el: HTMLElement, card: TextCard): void;
    syncTextCardSize(el: HTMLElement, card: TextCard): void;
    styleTextBody(target: HTMLElement, card: TextCard): void;
    addChecklist(): void;
    addChecklistAt(x: number, y: number): void;
    addComment(): void;
    addCommentAt(x: number, y: number): void;
    addNoteLink(): void;
    addNoteLinkAt(x: number, y: number): void;
  }
}

export const cardsBasicMethods = {
  renderTileContent(this: FreeformRenderer, el: HTMLElement, tile: TileCard): void {
    el.addClass('visual-notes-freeform-tile-card');
    const w = parseFloat(el.style.width) || (tile.w ?? TILE_DEFAULT_W);
    const h = parseFloat(el.style.height) || (tile.h ?? TILE_DEFAULT_H);
    const tileSize = Math.max(40, Math.min(w - 20, h - 50 - 16));
    const radius = Math.round(tileSize * 0.2);

    const square = el.createDiv('visual-notes-freeform-tile-square');
    // Neutral background behind thumbnails and custom icon images — see
    // matching comment in grid-view.ts. The accent color is only
    // appropriate as a backdrop for the small centered Lucide/emoji glyph,
    // not behind a full image that may have transparent or padded margins
    // (a custom asset icon shows its own art edge-to-edge, same as a
    // thumbnail, so the accent square would otherwise show through as an
    // unwanted colored ring around it).
    const hasThumbForBg = !!tile.thumbnail || isCustomIconRef(tile.icon);
    square.style.backgroundColor = hasThumbForBg ? 'transparent' : tile.color;
    square.style.width = `${tileSize}px`; square.style.height = `${tileSize}px`;
    square.style.borderRadius = `${radius}px`;

    const iconColor = contrastColor(tile.color);
    const thumbSrc = resolveThumbnailSrc(this.app, tile);
    const iconSize = Math.round(tileSize * 0.55);

    if (thumbSrc) {
      const img = square.createEl('img', { cls: 'visual-notes-tile-thumbnail-img' });
      img.src = thumbSrc;
      img.alt = tile.label;
      img.addEventListener('error', () => {
        img.remove();
        square.style.backgroundColor = tile.color;
        this.renderTileIcon(square, tile, iconColor, iconSize);
      });
    } else {
      this.renderTileIcon(square, tile, iconColor, iconSize);
    }

    if (tile.target.kind === 'board') {
      const chevron = square.createDiv('visual-notes-tile-board-indicator');
      setIcon(chevron, 'chevron-right'); chevron.style.color = iconColor;
    }

    if (tile.target.kind === 'kanban') {
      const indicator = square.createDiv('visual-notes-tile-board-indicator');
      setIcon(indicator, 'columns-3'); indicator.style.color = iconColor;
    }

    el.createDiv({ cls: 'visual-notes-tile-label', text: tile.label });
    if (tile.subtitle) el.createDiv({ cls: 'visual-notes-tile-subtitle', text: tile.subtitle });
    this.appendResizeHandles(el);
  },

  renderTileIcon(this: FreeformRenderer, square: HTMLElement, tile: TileCard, iconColor: string, iconSize: number): void {
    const iconEl = square.createDiv('visual-notes-tile-icon');
    iconEl.style.color = iconColor;
    iconEl.style.width = `${iconSize}px`; iconEl.style.height = `${iconSize}px`;
    const customSrc = isCustomIconRef(tile.icon) ? resolveCustomIconSrc(tile.icon) : undefined;
    const isSingleEmoji = [...tile.icon].length === 1 && /\p{Emoji_Presentation}/u.test(tile.icon);
    if (customSrc) {
      iconEl.createEl('img', { attr: { src: customSrc }, cls: 'visual-notes-tile-custom-icon-img' });
    } else if (isSingleEmoji) {
      iconEl.setText(tile.icon); iconEl.addClass('visual-notes-tile-emoji');
      iconEl.style.fontSize = `${Math.round(iconSize * 0.9)}px`;
    } else { setIcon(iconEl, tile.icon); }
  },

  renderStickyContent(this: FreeformRenderer, el: HTMLElement, card: StickyCard): void {
    el.addClass('visual-notes-freeform-sticky-card');
    if (card.blank) el.addClass('is-blank-card');
    if (card.shape === 'round') el.addClass('is-shape-round');
    if (card.transparent) el.addClass('is-transparent');
    // On the card rather than the text span so the rendered text and the
    // inline editor both inherit it — the editor is a *sibling* of the span,
    // which is exactly how the text colour ended up wrong before 1.1.19.
    if (card.fontFamily) el.style.setProperty('--vn-card-font', STICKY_FONT_FAMILIES[card.fontFamily]);

    // The colored/shaped fill lives on its own layer behind the content,
    // separate from `el` itself — which is what makes a transparent card a
    // matter of simply not painting it.
    const shapeFill = el.createDiv('visual-notes-sticky-shape-fill');
    if (!card.transparent) shapeFill.style.backgroundColor = card.color;
    if (card.shape === 'round') shapeFill.addClass('is-shape-round');

    if (card.topColor) {
      const strip = el.createDiv('visual-notes-card-top-strip');
      strip.style.backgroundColor = card.topColor;
    }
    applyStickyTextScale(el, card.textScale);
    const inner = el.createDiv('visual-notes-sticky-inner');
    const textEl = inner.createDiv('visual-notes-sticky-text');
    // A pastel/bright background (the default palette is all pale colors)
    // read against the theme's own text color regardless of contrast —
    // white theme text on a pale yellow sticky was reported as barely
    // readable. Auto-contrast against the card's own background unless the
    // user picked an explicit text color; skipped for theme-driven
    // defaults (e.g. a blank Note's `var(--visual-notes-card-bg)`), which already
    // pair correctly with the CSS-level --visual-notes-card-text fallback.
    // Skipped entirely when transparent: with no fill drawn, contrasting
    // against `color` would pair the text with a background that isn't there
    // — dark ink derived from a pale card, sitting on a dark canvas. Falling
    // through to the CSS-level --visual-notes-card-text tracks the theme,
    // which is what the text is actually sitting on.
    const autoTextColor = card.textColor
      ?? (!card.transparent && isHexColor(card.color) ? contrastColor(card.color) : undefined);
    if (autoTextColor) textEl.style.color = autoTextColor;
    if (card.textAlign) textEl.style.textAlign = card.textAlign;
    const placeholder = card.blank ? '*Start Typing…*' : '*Double-click to edit…*';
    void MarkdownRenderer.render(this.app, card.text || placeholder, textEl, '', this);
    this.appendResizeHandles(el);
  },

  editStickyInline(this: FreeformRenderer, el: HTMLElement, card: StickyCard): void {
    const textEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text');
    if (!textEl || el.querySelector('.visual-notes-sticky-editor')) return;
    const inner = el.querySelector<HTMLElement>('.visual-notes-sticky-inner') ?? el;

    const editor = inner.createDiv('visual-notes-sticky-editor');
    // Carry the rendered text's colour across. The editor is a *sibling* of
    // .visual-notes-sticky-text rather than a child, so it inherits none of the
    // auto-contrast colour renderStickyContent computed from the card's own
    // background, and would fall back to the theme's --text-normal — near-white
    // on a pale sticky under a dark theme, which turned the text unreadable the
    // moment you started editing. Copying the resolved value also picks up an
    // explicit card.textColor for free. Empty when the card uses a theme-driven
    // var() colour, which is deliberate: those pair with the CSS-level default.
    editor.style.color = textEl.style.color;
    editor.contentEditable = 'true';
    editor.empty();
    if (card.text) editor.appendChild(sanitizeHTMLToDom(textEl.innerHTML));
    textEl.hide();

    editor.focus();
    const r = activeDocument.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);

    editor.addEventListener('pointerdown', e => e.stopPropagation());

    // Selection-triggered Bold/Italic/Strike/Underline + text Color/Highlight
    // bubble menu — every other inline text editor (checklist item, kanban
    // item, …) already gets this too.
    const fmtToolbar = new TextFormatToolbar(editor, el, this.container);

    // "- " at the start of a line becomes a bullet, the way Obsidian's own
    // editor behaves. This is the only route into a list from an *empty*
    // line: the selection toolbar's bullet button needs text selected before
    // it will even appear.
    editor.addEventListener('input', () => {
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed || !editor.contains(sel.anchorNode)) return;
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent ?? '';
      if (!text.startsWith('- ') || sel.anchorOffset < 2) return;
      // Only when "- " opens the line, not mid-sentence: the text must be
      // first in its block, and that block must be the editor itself or one
      // of its direct children (not, say, text nested inside a <strong>).
      if (node.previousSibling) return;
      const parent = node.parentElement;
      if (parent !== editor && parent?.parentElement !== editor) return;
      // Already a list item — Enter already continues the list natively.
      if (parent?.tagName === 'LI') return;

      node.textContent = text.slice(2);
      const caret = activeDocument.createRange();
      caret.setStart(node, Math.max(0, sel.anchorOffset - 2));
      caret.collapse(true);
      sel.removeAllRanges(); sel.addRange(caret);
      toggleBulletList(editor);

      // toggleBulletList clears the selection (it rebuilds the blocks it
      // touched) — put the caret back at the end of the new item so typing
      // simply continues.
      const li = editor.querySelector('ul > li:last-child');
      if (li) {
        const r = activeDocument.createRange();
        r.selectNodeContents(li); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
      }
      editor.focus();
    });

    // ── Inline tag toggle (Cmd/Ctrl+B/I/U, Cmd/Ctrl+Shift+S) ───────
    let savedRange: Range | null = null;

    const applyTag = (tag: string) => {
      // Keep editor focused throughout — sel.removeAllRanges() can move focus to body
      editor.focus();
      const sel = window.getSelection();
      if (savedRange) { sel?.removeAllRanges(); sel?.addRange(savedRange.cloneRange()); }
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return;

      const ancestor = range.commonAncestorContainer;
      const existing = (ancestor.nodeType === Node.ELEMENT_NODE
        ? ancestor as Element : ancestor.parentElement)?.closest(tag);
      if (existing && editor.contains(existing)) {
        // Unwrap — move children out, then re-select them
        const children = Array.from(existing.childNodes);
        const p = existing.parentNode!;
        while (existing.firstChild) p.insertBefore(existing.firstChild, existing);
        existing.remove();
        if (children.length > 0 && p.contains(children[0]) && p.contains(children[children.length - 1])) {
          const nr = activeDocument.createRange();
          nr.setStartBefore(children[0]);
          nr.setEndAfter(children[children.length - 1]);
          sel.removeAllRanges(); sel.addRange(nr);
          savedRange = nr.cloneRange();
        } else {
          sel.removeAllRanges(); savedRange = null;
        }
      } else {
        // Wrap — re-select the new wrapper's contents
        const wrapper = createEl(tag as keyof HTMLElementTagNameMap);
        const extracted = range.extractContents();
        const tmp = createDiv();
        tmp.appendChild(extracted);
        tmp.querySelectorAll(tag).forEach(n => n.replaceWith(...Array.from(n.childNodes)));
        while (tmp.firstChild) wrapper.appendChild(tmp.firstChild);
        range.insertNode(wrapper);
        wrapper.parentElement?.normalize();
        const nr = activeDocument.createRange();
        nr.selectNodeContents(wrapper);
        sel.removeAllRanges(); sel.addRange(nr);
        savedRange = nr.cloneRange();
      }
      // Re-focus after selection manipulation in case browser moved focus away
      editor.focus();
    };

    // Tracks the live selection so applyTag (below, via the Cmd+B/I/U/
    // Shift+S shortcuts) always has a real range to work with.
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !editor.contains(sel.anchorNode)) { savedRange = null; return; }
      savedRange = sel.getRangeAt(0).cloneRange();
    };
    activeDocument.addEventListener('selectionchange', onSelChange);

    // Register on window (not document) so we fire before Obsidian's document-level
    // capture handlers, which intercept CMD+B/I/U before we ever see them.
    const onFormatKey = (e: KeyboardEvent) => {
      if (activeDocument.activeElement !== editor) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (!e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); applyTag('strong'); return; }
      if (!e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); applyTag('em'); return; }
      if (!e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); applyTag('u'); return; }
      if (e.shiftKey  && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); applyTag('s'); return; }
    };
    window.addEventListener('keydown', onFormatKey, true);

    const cleanup = () => {
      activeDocument.removeEventListener('selectionchange', onSelChange);
      window.removeEventListener('keydown', onFormatKey, true);
      fmtToolbar.destroy();
    };

    const commit = () => {
      if (!el.contains(editor)) return;
      cleanup();
      this.pushUndo();
      card.text = editor.innerHTML;
      editor.remove(); textEl.show();
      textEl.empty();
      const placeholder = card.blank ? '*Start Typing…*' : '*Double-click to edit…*';
      void MarkdownRenderer.render(this.app, card.text || placeholder, textEl, '', this);
      this.scheduleSave();
    };
    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); cleanup();
        editor.removeEventListener('blur', commit);
        editor.remove(); textEl.show();
      }
    });
  },

  renderChecklistContent(this: FreeformRenderer, el: HTMLElement, card: ChecklistCard): void {
    el.addClass('visual-notes-freeform-checklist-card');
    el.toggleClass('is-title-hidden', !!card.titleHidden);
    el.style.backgroundColor = card.color;

    // Top strip (optional — only shown if accentColor is set)
    if (card.accentColor) {
      const accentBar = el.createDiv('visual-notes-checklist-accent');
      accentBar.style.backgroundColor = card.accentColor;
    }

    // Title (hidden when titleHidden is true)
    if (!card.titleHidden) {
      const titleEl = el.createEl('input', { cls: 'visual-notes-checklist-title' });
      titleEl.type = 'text'; titleEl.value = card.title || ''; titleEl.placeholder = 'Checklist';
      titleEl.addEventListener('pointerdown', e => e.stopPropagation());
      titleEl.addEventListener('input', () => { card.title = titleEl.value; });
      titleEl.addEventListener('blur', () => this.scheduleSave());
    }

    // List
    const listEl = el.createDiv('visual-notes-checklist-list');
    for (const item of card.items) this.appendChecklistItem(listEl, card, item);
    this.appendChecklistGhost(listEl, card);

    this.appendResizeHandles(el);
  },

  appendChecklistItem(this: FreeformRenderer, listEl: HTMLElement, card: ChecklistCard, item: ChecklistItem): HTMLElement {
    const row = listEl.createDiv('visual-notes-checklist-item');
    row.dataset.id = item.id;
    if (item.done) row.addClass('is-done');
    if (item.isHeader) row.addClass('is-header');
    if (item.parentId) row.addClass('is-child');

    row.addEventListener('contextmenu', (e) => {
      // Headers keep the card's own context menu (add section, accent
      // colour, etc) — deleting one is still done via empty-then-Backspace.
      if (item.isHeader) return;
      e.preventDefault(); e.stopPropagation();
      const menu = this.newMenu();
      if (item.parentId) {
        menu.addItem(i => i.setTitle('Remove subtask').setIcon('outdent').onClick(() => {
          this.pushUndo();
          if (this.outdentChecklistItem(item, row)) this.scheduleSave();
        }));
        menu.addSeparator();
      } else if (this.findChecklistIndentTarget(card, item)) {
        menu.addItem(i => i.setTitle('Make subtask').setIcon('indent').onClick(() => {
          this.pushUndo();
          if (this.indentChecklistItem(card, item, row)) this.scheduleSave();
        }));
        menu.addSeparator();
      }
      menu.addItem(i => i.setTitle('Delete task').setIcon('trash-2').onClick(() => {
        this.pushUndo();
        this.deleteChecklistItem(listEl, card, item, row);
      }));
      menu.showAtMouseEvent(e);
    });

    const handle = row.createDiv('visual-notes-checklist-drag-handle');
    setIcon(handle, 'grip-vertical');
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      this.startChecklistItemDrag(e, listEl, card, item, row);
    });

    const cb = row.createEl('input');
    cb.type = 'checkbox'; cb.checked = item.done; cb.className = 'visual-notes-checklist-cb';
    if (item.isHeader) this.setHeaderCheckboxState(cb, card, item.id);

    cb.addEventListener('pointerdown', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      // Cascade to any children of this item
      const children = card.items.filter(i => i.parentId === item.id);
      for (const child of children) {
        child.done = cb.checked;
        const childRow = listEl.querySelector<HTMLElement>(`[data-id="${child.id}"]`);
        if (childRow) {
          childRow.toggleClass('is-done', child.done);
          const childCb = childRow.querySelector<HTMLInputElement>('.visual-notes-checklist-cb');
          if (childCb) { childCb.checked = cb.checked; childCb.indeterminate = false; }
        }
      }
      item.done = cb.checked;
      row.toggleClass('is-done', item.done);
      if (item.parentId) this.refreshHeaderCheckbox(listEl, card, item.parentId);
      this.scheduleSave();
    });

    const textDiv = row.createDiv('visual-notes-checklist-item-input') as HTMLElement;
    textDiv.contentEditable = 'true';
    textDiv.dataset.placeholder = item.isHeader ? 'Section…' : 'Add a task…';
    if (item.text) textDiv.appendChild(sanitizeHTMLToDom(item.text));
    textDiv.addEventListener('pointerdown', e => e.stopPropagation());

    let fmtToolbar: TextFormatToolbar | null = null;
    textDiv.addEventListener('focus', () => {
      if (!fmtToolbar) fmtToolbar = new TextFormatToolbar(textDiv, row, this.container);
    });
    textDiv.addEventListener('blur', () => {
      fmtToolbar?.destroy(); fmtToolbar = null;
      item.text = textDiv.innerHTML;
      this.scheduleSave();
    });
    textDiv.addEventListener('input', () => { item.text = textDiv.innerHTML; });
    textDiv.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const idx = card.items.indexOf(item);
        const ni: ChecklistItem = { id: crypto.randomUUID(), text: '', done: false, parentId: item.parentId };
        card.items.splice(idx + 1, 0, ni);
        const nr = this.appendChecklistItem(listEl, card, ni);
        row.after(nr);
        window.setTimeout(() => nr.querySelector<HTMLElement>('.visual-notes-checklist-item-input')?.focus(), 0);
      }
      if (e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) {
          if (this.outdentChecklistItem(item, row)) this.scheduleSave();
        } else if (this.indentChecklistItem(card, item, row)) {
          this.scheduleSave();
        }
      }
      if (e.key === 'Backspace' && (textDiv.innerHTML === '' || textDiv.innerHTML === '<br>')) {
        const idx = card.items.indexOf(item);
        if (idx > 0) {
          e.preventDefault(); e.stopPropagation();
          card.items.splice(idx, 1);
          const prev = row.previousElementSibling as HTMLElement | null;
          row.remove();
          prev?.querySelector<HTMLElement>('.visual-notes-checklist-item-input')?.focus();
          this.scheduleSave();
        }
      }
    });
    return row;
  },

  appendChecklistGhost(this: FreeformRenderer, listEl: HTMLElement, card: ChecklistCard): HTMLElement {
    const row = listEl.createDiv('visual-notes-checklist-item visual-notes-checklist-ghost');

    const cb = row.createEl('input');
    cb.type = 'checkbox'; cb.className = 'visual-notes-checklist-cb'; cb.disabled = true;
    cb.addEventListener('pointerdown', e => e.stopPropagation());

    const input = row.createEl('input');
    input.type = 'text'; input.placeholder = 'Add a task…';
    input.className = 'visual-notes-checklist-item-input';
    input.addEventListener('pointerdown', e => e.stopPropagation());

    let committed = false;
    const commit = () => {
      if (committed) return;
      const text = input.value.trim();
      if (!text) return;
      committed = true;
      const newItem: ChecklistItem = { id: crypto.randomUUID(), text, done: false };
      this.pushUndo(); card.items.push(newItem);
      row.remove();
      this.appendChecklistItem(listEl, card, newItem);
      this.appendChecklistGhost(listEl, card);
      this.scheduleSave();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!input.value.trim()) return;
        commit();
        window.setTimeout(() => listEl.querySelector<HTMLInputElement>('.visual-notes-checklist-ghost .visual-notes-checklist-item-input')?.focus(), 0);
      } else if (e.key === 'Escape') {
        e.preventDefault(); input.value = ''; input.blur();
      }
    });

    return row;
  },

  rebuildChecklistList(this: FreeformRenderer, listEl: HTMLElement, card: ChecklistCard): void {
    listEl.empty();
    for (const item of card.items) this.appendChecklistItem(listEl, card, item);
    this.appendChecklistGhost(listEl, card);
  },

  startChecklistItemDrag(this: FreeformRenderer, 
    startEvent: PointerEvent,
    listEl: HTMLElement,
    card: ChecklistCard,
    item: ChecklistItem,
    itemEl: HTMLElement,
  ): void {
    const itemRect = itemEl.getBoundingClientRect();

    const ghost = itemEl.cloneNode(true) as HTMLElement;
    ghost.addClass('visual-notes-checklist-drag-ghost');
    ghost.style.width = `${itemRect.width}px`;
    ghost.style.left = `${itemRect.left}px`;
    ghost.style.top = `${itemRect.top}px`;
    ghost.addClass('visual-notes-no-pointer');
    activeDocument.body.appendChild(ghost);

    itemEl.addClass('is-dragging');

    let dropIndicator: HTMLElement | null = null;
    let insertBeforeId: string | null = null;
    let nestUnderId: string | null = null;
    let nestTargetRow: HTMLElement | null = null;
    let hasValidTarget = false;
    const removeIndicator = () => { dropIndicator?.remove(); dropIndicator = null; };
    const clearNestTarget = () => { nestTargetRow?.removeClass('is-nest-target'); nestTargetRow = null; };

    // Dragging the row noticeably to the right (like an outliner) while
    // hovering another eligible row nests it under that row instead of
    // just reordering it — mouse-driven equivalent of the Tab shortcut.
    const NEST_DRAG_THRESHOLD = 24;

    const onMove = (e: PointerEvent) => {
      ghost.style.left = `${itemRect.left + (e.clientX - startEvent.clientX)}px`;
      ghost.style.top = `${itemRect.top + (e.clientY - startEvent.clientY)}px`;
      removeIndicator();
      clearNestTarget();
      insertBeforeId = null;
      nestUnderId = null;
      hasValidTarget = false;

      const listRect = listEl.getBoundingClientRect();
      const overList = e.clientX >= listRect.left && e.clientX <= listRect.right &&
                       e.clientY >= listRect.top && e.clientY <= listRect.bottom;
      if (!overList) return;
      hasValidTarget = true;

      const rows = Array.from(listEl.querySelectorAll<HTMLElement>(
        '.visual-notes-checklist-item:not(.is-dragging):not(.visual-notes-checklist-ghost)'
      ));

      if (!item.isHeader && (e.clientX - startEvent.clientX) > NEST_DRAG_THRESHOLD) {
        for (const r of rows) {
          const rr = r.getBoundingClientRect();
          if (e.clientY < rr.top || e.clientY > rr.bottom) continue;
          const target = card.items.find(i => i.id === r.dataset.id);
          if (target && (target.isHeader || !target.parentId)) {
            nestUnderId = target.id;
            nestTargetRow = r;
            r.addClass('is-nest-target');
            return;
          }
        }
      }

      dropIndicator = createDiv();
      dropIndicator.className = 'visual-notes-checklist-drop-indicator';

      let placed = false;
      for (const r of rows) {
        const rr = r.getBoundingClientRect();
        if (e.clientY < rr.top + rr.height / 2) {
          insertBeforeId = r.dataset.id ?? null;
          listEl.insertBefore(dropIndicator, r);
          placed = true;
          break;
        }
      }
      if (!placed) {
        insertBeforeId = null;
        const addGhostRow = listEl.querySelector('.visual-notes-checklist-ghost');
        if (addGhostRow) listEl.insertBefore(dropIndicator, addGhostRow);
        else listEl.appendChild(dropIndicator);
      }
    };

    const onUp = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      ghost.remove();
      removeIndicator();
      clearNestTarget();
      itemEl.removeClass('is-dragging');

      if (!hasValidTarget) return;
      const idx = card.items.indexOf(item);
      if (idx === -1) return;
      const without = card.items.slice(0, idx).concat(card.items.slice(idx + 1));

      if (nestUnderId) {
        this.pushUndo();
        item.parentId = nestUnderId;
        const targetIdx = without.findIndex(i => i.id === nestUnderId);
        without.splice(targetIdx + 1, 0, item);
        card.items = without;
        this.rebuildChecklistList(listEl, card);
        this.scheduleSave();
        return;
      }

      const insertIdx = insertBeforeId ? without.findIndex(i => i.id === insertBeforeId) : -1;
      const finalIdx = insertIdx === -1 ? without.length : insertIdx;
      if (finalIdx !== idx) {
        this.pushUndo();
        without.splice(finalIdx, 0, item);
        card.items = without;
        this.rebuildChecklistList(listEl, card);
        this.scheduleSave();
      }
    };

    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
  },

  setHeaderCheckboxState(this: FreeformRenderer, cb: HTMLInputElement, card: ChecklistCard, headerId: string): void {
    const children = card.items.filter(i => i.parentId === headerId);
    const doneCount = children.filter(i => i.done).length;
    if (children.length === 0) { cb.indeterminate = false; return; }
    if (doneCount === children.length) { cb.checked = true; cb.indeterminate = false; }
    else if (doneCount > 0) { cb.indeterminate = true; }
    else { cb.checked = false; cb.indeterminate = false; }
  },

  refreshHeaderCheckbox(this: FreeformRenderer, listEl: HTMLElement, card: ChecklistCard, headerId: string): void {
    const headerItem = card.items.find(i => i.id === headerId);
    if (!headerItem) return;
    const headerRow = listEl.querySelector<HTMLElement>(`[data-id="${headerId}"]`);
    const headerCb = headerRow?.querySelector<HTMLInputElement>('.visual-notes-checklist-cb');
    if (!headerCb) return;
    const children = card.items.filter(i => i.parentId === headerId);
    const doneCount = children.filter(i => i.done).length;
    if (children.length === 0) return;
    if (doneCount === children.length) {
      headerCb.checked = true; headerCb.indeterminate = false;
    } else if (doneCount > 0) {
      headerCb.indeterminate = true;
    } else {
      headerCb.checked = false; headerCb.indeterminate = false;
    }
  },

  // Nearest header or top-level item above `item` in list order — the one
  // it would nest under. null if there's nothing eligible above it.
  findChecklistIndentTarget(this: FreeformRenderer, card: ChecklistCard, item: ChecklistItem): ChecklistItem | null {
    const idx = card.items.indexOf(item);
    for (let i = idx - 1; i >= 0; i--) {
      const above = card.items[i];
      if (above.isHeader || !above.parentId) return above;
    }
    return null;
  },

  indentChecklistItem(this: FreeformRenderer, card: ChecklistCard, item: ChecklistItem, row: HTMLElement): boolean {
    if (item.parentId || item.isHeader) return false;
    const target = this.findChecklistIndentTarget(card, item);
    if (!target) return false;
    item.parentId = target.id;
    row.addClass('is-child');
    return true;
  },

  outdentChecklistItem(this: FreeformRenderer, item: ChecklistItem, row: HTMLElement): boolean {
    if (!item.parentId) return false;
    item.parentId = undefined;
    row.removeClass('is-child');
    return true;
  },

  deleteChecklistItem(this: FreeformRenderer, listEl: HTMLElement, card: ChecklistCard, item: ChecklistItem, row: HTMLElement): void {
    const idx = card.items.indexOf(item);
    if (idx === -1) return;
    card.items.splice(idx, 1);
    row.remove();
    if (item.parentId) this.refreshHeaderCheckbox(listEl, card, item.parentId);
    this.scheduleSave();
  },

  renderCommentContent(this: FreeformRenderer, el: HTMLElement, card: CommentCard): void {
    el.addClass('visual-notes-freeform-comment-card');
    el.toggleClass('is-resolved', !!card.resolved);
    el.style.setProperty('--visual-notes-comment-accent', card.color ?? '#eab308');

    const header = el.createDiv('visual-notes-comment-header');
    const avatar = header.createDiv('visual-notes-comment-avatar');
    avatar.setText(commentInitial(card.author));
    // Author + timestamp share one compact line instead of stacking into
    // two — same metadata, a lot less header height.
    const headMeta = header.createDiv('visual-notes-comment-head-meta');
    headMeta.createSpan({ cls: 'visual-notes-comment-author', text: card.author || 'Anonymous' });
    headMeta.createSpan({ cls: 'visual-notes-comment-time-sep', text: '·' });
    headMeta.createSpan({ cls: 'visual-notes-comment-time', text: formatCommentTime(card.createdAt) });
    if (card.resolved) {
      const badge = header.createDiv('visual-notes-comment-resolved-badge');
      setIcon(badge.createSpan(), 'check');
      badge.createSpan({ text: 'Resolved' });
    }

    const body = el.createDiv('visual-notes-comment-body');
    const textEl = body.createDiv('visual-notes-comment-text');
    textEl.contentEditable = 'true';
    textEl.dataset.placeholder = 'Write a comment…';
    if (card.text) textEl.appendChild(sanitizeHTMLToDom(card.text));
    textEl.addEventListener('pointerdown', e => e.stopPropagation());
    textEl.addEventListener('input', () => { card.text = textEl.innerHTML; });
    textEl.addEventListener('blur', () => this.scheduleSave());

    const repliesEl = el.createDiv('visual-notes-comment-replies');
    for (const reply of card.replies) this.appendCommentReply(repliesEl, card, reply);
    this.appendCommentReplyGhost(repliesEl, card);

    this.appendResizeHandles(el);
  },

  appendCommentReply(this: FreeformRenderer, listEl: HTMLElement, card: CommentCard, reply: CommentReply): HTMLElement {
    const row = listEl.createDiv('visual-notes-comment-reply');
    row.dataset.id = reply.id;

    const head = row.createDiv('visual-notes-comment-reply-head');
    head.createSpan({ cls: 'visual-notes-comment-reply-author', text: reply.author || 'Anonymous' });
    head.createSpan({ cls: 'visual-notes-comment-reply-time', text: formatCommentTime(reply.createdAt) });

    const delBtn = head.createDiv('visual-notes-comment-reply-delete');
    setIcon(delBtn, 'x');
    delBtn.setAttribute('aria-label', 'Delete reply');
    delBtn.setAttribute('tabindex', '0');
    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      card.replies = card.replies.filter(r => r.id !== reply.id);
      row.remove();
      this.scheduleSave();
    });

    const textEl = row.createDiv('visual-notes-comment-reply-text');
    textEl.contentEditable = 'true';
    if (reply.text) textEl.appendChild(sanitizeHTMLToDom(reply.text));
    textEl.addEventListener('pointerdown', e => e.stopPropagation());
    textEl.addEventListener('input', () => { reply.text = textEl.innerHTML; });
    textEl.addEventListener('blur', () => this.scheduleSave());

    return row;
  },

  appendCommentReplyGhost(this: FreeformRenderer, listEl: HTMLElement, card: CommentCard): HTMLElement {
    const row = listEl.createDiv('visual-notes-comment-reply visual-notes-comment-reply-ghost');
    const input = row.createEl('input');
    input.type = 'text'; input.placeholder = 'Reply…';
    input.className = 'visual-notes-comment-reply-ghost-input';
    input.addEventListener('pointerdown', e => e.stopPropagation());

    let committed = false;
    const commit = () => {
      if (committed) return;
      const text = input.value.trim();
      if (!text) return;
      committed = true;
      const reply: CommentReply = { id: crypto.randomUUID(), text, author: this.commentAuthorName, createdAt: Date.now() };
      this.pushUndo(); card.replies.push(reply);
      row.remove();
      this.appendCommentReply(listEl, card, reply);
      this.appendCommentReplyGhost(listEl, card);
      this.scheduleSave();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!input.value.trim()) return;
        commit();
        window.setTimeout(() => listEl.querySelector<HTMLInputElement>('.visual-notes-comment-reply-ghost-input')?.focus(), 0);
      } else if (e.key === 'Escape') {
        e.preventDefault(); input.value = ''; input.blur();
      }
    });

    return row;
  },

  renderNoteLinkContent(this: FreeformRenderer, el: HTMLElement, card: NoteLinkCard): void {
    el.addClass('visual-notes-freeform-notelink-card');

    const titleBar = el.createDiv('visual-notes-notelink-titlebar');
    setIcon(titleBar.createDiv('visual-notes-notelink-icon'), 'file-text');

    const file = this.app.vault.getAbstractFileByPath(card.path);
    // A clipped page carries its own metadata in the note's properties. The
    // frontmatter title beats the filename because clippers sanitise
    // filenames for the filesystem — "Why Things Break_ A Guide" is the file,
    // "Why Things Break: A Guide" is the article.
    const meta = file instanceof TFile
      ? clipMetaFromFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter)
      : {};
    const title = meta.title
      ?? (file ? file.name.replace(/\.md$/, '') : (card.path || 'Note Link'));
    titleBar.createDiv({ cls: 'visual-notes-notelink-title', text: title });

    const modeBtn = titleBar.createEl('button', { cls: 'visual-notes-notelink-mode-btn' });
    modeBtn.setAttribute('title', card.displayMode === 'preview' ? 'Switch to title-only' : 'Switch to preview');
    setIcon(modeBtn, card.displayMode === 'preview' ? 'minimize-2' : 'eye');
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault(); this.pushUndo();
      card.displayMode = card.displayMode === 'preview' ? 'title-only' : 'preview';
      if (card.displayMode === 'preview') {
        card.w = Math.max(card.w ?? NOTELINK_DEFAULT_W, NOTELINK_DEFAULT_W);
        card.h = Math.max(card.h ?? NOTELINK_DEFAULT_H, NOTELINK_DEFAULT_H);
      } else { card.w = card.w ?? NOTELINK_TITLE_W; card.h = NOTELINK_TITLE_H; }
      el.style.width = `${card.w}px`; el.style.height = `${card.h}px`;
      this.renderCardContent(el, card); this.scheduleSave();
    });

    if (card.displayMode === 'preview' && file instanceof TFile) {
      // A clipped page gets its cover and source shown as card chrome, above
      // the article itself — the same shape a bookmark card uses, so a page
      // saved into the vault and a page merely linked to look like siblings.
      const coverSrc = safeRemoteImageSrc(meta.image);
      if (coverSrc) {
        const coverWrap = el.createDiv('visual-notes-notelink-cover');
        const img = coverWrap.createEl('img');
        img.src = coverSrc;
        img.addEventListener('error', () => coverWrap.remove());
      }

      const domain = displayDomain(meta.sourceUrl ?? card.clipSourceUrl);
      if (domain) {
        const srcRow = el.createDiv('visual-notes-notelink-source');
        setIcon(srcRow.createDiv('visual-notes-notelink-source-icon'), 'globe');
        srcRow.createSpan({ cls: 'visual-notes-notelink-source-domain', text: domain });
        srcRow.setAttribute('title', `Open ${meta.sourceUrl ?? card.clipSourceUrl ?? domain}`);
        srcRow.addClass('is-clickable');
        // Not a bare window.open: the URL came out of a note's frontmatter,
        // which on a shared board is a string somebody else wrote.
        srcRow.addEventListener('pointerdown', e => e.stopPropagation());
        srcRow.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          openExternalUrl(meta.sourceUrl ?? card.clipSourceUrl);
        });
      }

      const previewEl = el.createDiv('visual-notes-notelink-preview');
      const loadPreview = (f: TFile) => {
        if (!el.contains(previewEl)) return;
        void this.app.vault.cachedRead(f).then(content => {
          if (!el.contains(previewEl)) return;
          previewEl.empty();
          // Without the strip, a clipped note opens with its raw YAML — the
          // very properties rendered as chrome just above.
          void MarkdownRenderer.render(this.app, stripFrontmatter(content), previewEl, f.path, this);
        });
      };
      loadPreview(file);

      const reloadBtn = titleBar.createEl('button', { cls: 'visual-notes-notelink-mode-btn' });
      reloadBtn.setAttribute('title', 'Reload note content'); setIcon(reloadBtn, 'refresh-cw');
      reloadBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); loadPreview(file); });

      this.registerEvent(this.app.vault.on('modify', (modified) => {
        if (modified instanceof TFile && modified.path === card.path) loadPreview(modified);
      }));
    }

    this.appendResizeHandles(el);
  },

  renderSwatchContent(this: FreeformRenderer, el: HTMLElement, card: SwatchCard): void {
    el.addClass('visual-notes-freeform-swatch-card');

    const colorArea = el.createDiv('visual-notes-swatch-color-area');
    colorArea.style.backgroundColor = card.color;

    const hexLabel = colorArea.createDiv({ cls: 'visual-notes-swatch-hex', text: card.color.toUpperCase() });
    hexLabel.style.color = contrastColor(card.color);

    // Native <input type="color"> — the browser's own picker gives a full
    // gradient/wheel + hex/RGB fields + eyedropper for free. Kept invisible
    // and triggered by a small pipette button so the swatch face itself
    // stays a clean color block rather than a form control.
    const colorInput = colorArea.createEl('input', { cls: 'visual-notes-swatch-color-input' });
    colorInput.type = 'color';
    colorInput.value = card.color;
    colorInput.addEventListener('pointerdown', e => e.stopPropagation());
    colorInput.addEventListener('input', () => {
      card.color = colorInput.value;
      colorArea.style.backgroundColor = card.color;
      hexLabel.setText(card.color.toUpperCase());
      hexLabel.style.color = contrastColor(card.color);
      nameLabel.setText(nearestColorName(card.color));
    });
    colorInput.addEventListener('change', () => { this.pushUndo(); this.scheduleSave(); });

    const editBtn = colorArea.createDiv('visual-notes-swatch-edit-btn');
    setIcon(editBtn, 'pipette');
    editBtn.setAttribute('aria-label', 'Change color');
    editBtn.addEventListener('pointerdown', e => e.stopPropagation());
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); colorInput.click(); });

    const nameBar = el.createDiv('visual-notes-swatch-name-bar');
    const nameLabel = nameBar.createDiv({ cls: 'visual-notes-swatch-name', text: nearestColorName(card.color) });

    const randomBtn = nameBar.createDiv('visual-notes-swatch-random-btn');
    setIcon(randomBtn, 'shuffle');
    randomBtn.setAttribute('aria-label', 'Randomize color');
    randomBtn.setAttribute('tabindex', '0');
    randomBtn.addEventListener('pointerdown', e => e.stopPropagation());
    const randomize = () => {
      this.pushUndo();
      card.color = randomNamedColor().hex;
      colorArea.style.backgroundColor = card.color;
      colorInput.value = card.color;
      hexLabel.setText(card.color.toUpperCase());
      hexLabel.style.color = contrastColor(card.color);
      nameLabel.setText(nearestColorName(card.color));
      this.scheduleSave();
    };
    randomBtn.addEventListener('click', (e) => { e.stopPropagation(); randomize(); });
    randomBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); randomize(); }
    });

    this.appendResizeHandles(el);
  },

  addSwatchAt(this: FreeformRenderer, x: number, y: number): void {
    const card: SwatchCard = {
      id: crypto.randomUUID(), kind: 'swatch', x, y,
      w: SWATCH_DEFAULT_W, h: SWATCH_DEFAULT_H, z: this.nextZ(),
      color: randomNamedColor().hex,
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  fileTypeIcon(this: FreeformRenderer, ext: string): string {
    const e = ext.toLowerCase();
    if (e === 'pdf') return 'file-text';
    if (['zip','rar','7z','tar','gz'].includes(e)) return 'file-archive';
    if (['xls','xlsx','csv','ods','numbers'].includes(e)) return 'file-spreadsheet';
    if (['doc','docx','odt','rtf','pages'].includes(e)) return 'file-text';
    if (['ppt','pptx','odp','key'].includes(e)) return 'file-sliders';
    if (['mp4','mkv','mov','avi','m4v','webm'].includes(e)) return 'file-video';
    if (['js','ts','py','json','html','css','sh','yml','yaml','xml','c','cpp','rs','go','java'].includes(e)) return 'file-code';
    return 'file';
  },

  formatFileSize(this: FreeformRenderer, bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  },

  renderFileContent(this: FreeformRenderer, el: HTMLElement, card: FileCard): void {
    el.addClass('visual-notes-freeform-file-card');

    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (!(file instanceof TFile)) {
      const fail = el.createDiv('visual-notes-map-fail');
      setIcon(fail.createDiv('visual-notes-map-fail-icon'), 'file-x');
      fail.createDiv({ cls: 'visual-notes-bookmark-fail-url', text: card.path });
      fail.createDiv({ cls: 'visual-notes-bookmark-loading-text', text: 'File not found in vault. Try "Relink all board assets".' });
      this.appendResizeHandles(el);
      return;
    }

    const ext = file.extension.toLowerCase();

    if (ext === 'pdf') {
      // Live embedded PDF preview via Chromium's built-in viewer. Same
      // pattern as the map card: the iframe swallows pointer events, so a
      // permanent header strip is the drag handle.
      const header = el.createDiv('visual-notes-file-header');
      setIcon(header.createDiv('visual-notes-file-header-icon'), 'file-text');
      header.createDiv({ cls: 'visual-notes-file-header-title', text: file.name });
      header.setAttribute('title', 'Drag here to move. Double-click to open.');

      const body = el.createDiv('visual-notes-file-body');
      const iframe = body.createEl('iframe', { cls: 'visual-notes-file-iframe' });
      iframe.src = `${this.app.vault.getResourcePath(file)}#toolbar=0`;
      iframe.setAttribute('title', file.name);
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('loading', 'lazy');
    } else {
      const tile = el.createDiv('visual-notes-file-tile');
      const iconEl = tile.createDiv('visual-notes-file-tile-icon');
      setIcon(iconEl, this.fileTypeIcon(ext));
      tile.createDiv({ cls: 'visual-notes-file-tile-name', text: file.name });
      const meta = tile.createDiv('visual-notes-file-tile-meta');
      meta.createSpan({ cls: 'visual-notes-file-ext-pill', text: ext.toUpperCase() });
      meta.createSpan({ text: this.formatFileSize(file.stat.size) });
    }

    this.appendResizeHandles(el);
  },

  async openFileCard(this: FreeformRenderer, card: FileCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (!(file instanceof TFile)) { new Notice('File not found in vault.'); return; }
    // Obsidian opens what it understands (pdf, md, images, audio, video);
    // for everything else fall back to the OS default app (desktop only —
    // openWithDefaultApp is a private desktop API, hence the guard+catch).
    const knownViewer = ['pdf','md','canvas', ...IMAGE_EXTS, ...AUDIO_EXTS, 'mp4','mov','mkv','webm'];
    if (knownViewer.includes(file.extension.toLowerCase())) {
      await this.app.workspace.getLeaf('tab').openFile(file);
      return;
    }
    const appWithOpen = this.app as App & { openWithDefaultApp?: (path: string) => Promise<void> };
    try {
      if (appWithOpen.openWithDefaultApp) await appWithOpen.openWithDefaultApp(file.path);
      else await this.app.workspace.getLeaf('tab').openFile(file);
    } catch {
      new Notice('No app available to open this file type.');
    }
  },

  renderCalloutContent(this: FreeformRenderer, el: HTMLElement, card: CalloutCard): void {
    el.addClass('visual-notes-freeform-callout-card');
    el.style.borderLeftColor = card.color;
    // Tinted background derived from the accent — hex + alpha suffix keeps
    // it readable on both light and dark themes without a second setting.
    el.style.backgroundColor = `${card.color}1A`;

    const iconEl = el.createDiv({ cls: 'visual-notes-callout-icon', text: card.icon ?? '💡' });
    iconEl.setAttribute('title', 'Right-click the card to change the icon');

    const textEl = el.createDiv('visual-notes-callout-text');
    textEl.dataset.placeholder = 'Type something…';
    textEl.setText(card.text);
    // Same edit-on-demand model as table cells: static until double-click
    // (the card-level dblclick dispatch promotes it), demoted on blur.
    textEl.addEventListener('input', () => { card.text = textEl.textContent ?? ''; });
    textEl.addEventListener('blur', () => {
      textEl.contentEditable = 'false';
      this.scheduleSave();
    });
    textEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') textEl.blur();
    });

    this.appendResizeHandles(el);
  },

  editCalloutInline(this: FreeformRenderer, el: HTMLElement, _card: CalloutCard): void {
    const textEl = el.querySelector<HTMLElement>('.visual-notes-callout-text');
    if (!textEl) return;
    if (!textEl.isContentEditable) { textEl.contentEditable = 'true'; textEl.spellcheck = false; }
    textEl.focus();
    const rng = activeDocument.createRange();
    rng.selectNodeContents(textEl);
    rng.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(rng);
  },

  addCalloutAt(this: FreeformRenderer, x: number, y: number): void {
    const card: CalloutCard = {
      id: crypto.randomUUID(), kind: 'callout', x, y,
      w: CALLOUT_DEFAULT_W, h: CALLOUT_DEFAULT_H, z: this.nextZ(),
      text: '', icon: '💡', color: '#3b82f6',
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    window.setTimeout(() => this.editCalloutInline(el, card), 0);
  },

  renderGroupContent(this: FreeformRenderer, el: HTMLElement, card: GroupCard): void {
    el.addClass('visual-notes-freeform-group-card');
    const color = card.color ?? '#6b7280';
    el.style.borderColor = color;
    // The fill color is bgColor if one's been chosen, otherwise the border
    // color itself (the original derived-tint look). Transparent (true or
    // unset — the default) is a pure alpha applied to THAT color, not a
    // separate look — so toggling it never changes which color is showing,
    // only how solid it is.
    const fill = card.bgColor ?? color;
    el.style.backgroundColor = (card.transparent ?? true) ? `${fill}14` : fill;

    const label = el.createDiv({ cls: 'visual-notes-group-label', text: card.label || 'Group' });
    label.toggleClass('is-empty', !card.label);
    label.style.backgroundColor = color;
    label.style.color = contrastColor(color);
    label.addEventListener('pointerdown', e => e.stopPropagation());
    label.addEventListener('dblclick', (e) => { e.stopPropagation(); this.editGroupLabel(el, card); });

    this.appendResizeHandles(el);
  },

  editGroupLabel(this: FreeformRenderer, el: HTMLElement, card: GroupCard): void {
    const label = el.querySelector<HTMLElement>('.visual-notes-group-label');
    if (!label || label.querySelector('input')) return;
    const original = card.label ?? '';
    label.empty();
    label.removeClass('is-empty');
    const input = label.createEl('input');
    input.type = 'text'; input.value = original; input.placeholder = 'Group';
    input.addClass('visual-notes-group-label-input');

    let cancelled = false;
    const restore = (text: string) => {
      label.empty();
      label.setText(text || 'Group');
      label.toggleClass('is-empty', !text);
    };
    const commit = () => {
      if (cancelled) { restore(original); return; }
      this.pushUndo();
      card.label = input.value.trim() || undefined;
      restore(card.label ?? '');
      this.scheduleSave();
    };
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
    });
    input.addEventListener('blur', commit);
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
  },

  cardsContainedInGroup(this: FreeformRenderer, group: GroupCard): string[] {
    const gx = group.x ?? 0, gy = group.y ?? 0;
    const gw = group.w ?? GROUP_DEFAULT_W, gh = group.h ?? GROUP_DEFAULT_H;
    const ids: string[] = [];
    for (const c of this.board.cards) {
      if (c.id === group.id || c.kind === 'group') continue;
      const cx = (c.x ?? 0) + (c.w ?? TILE_DEFAULT_W) / 2;
      const cy = (c.y ?? 0) + (c.h ?? TILE_DEFAULT_H) / 2;
      if (cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh) ids.push(c.id);
    }
    return ids;
  },

  groupSelected(this: FreeformRenderer): void {
    const ids = this.selection.getIds();
    const selected = ids.map(id => this.board.cards.find(c => c.id === id)).filter((c): c is Card => !!c);
    if (selected.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
    for (const c of selected) {
      const x = c.x ?? 0, y = c.y ?? 0, w = c.w ?? TILE_DEFAULT_W, h = c.h ?? TILE_DEFAULT_H;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      minZ = Math.min(minZ, c.z ?? 0);
    }

    const card: GroupCard = {
      id: crypto.randomUUID(), kind: 'group',
      x: minX - GROUP_PAD, y: minY - GROUP_PAD - 20, // extra top margin so the label chip clears the frame
      w: (maxX - minX) + GROUP_PAD * 2, h: (maxY - minY) + GROUP_PAD * 2 + 20,
      z: minZ - 1,
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    window.setTimeout(() => this.editGroupLabel(el, card), 0);
  },

  addGroupAt(this: FreeformRenderer, x: number, y: number): void {
    const card: GroupCard = {
      id: crypto.randomUUID(), kind: 'group', x, y,
      w: GROUP_DEFAULT_W, h: GROUP_DEFAULT_H, z: 0,
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  addFileAt(this: FreeformRenderer, x: number, y: number): void {
    const createCard = (path: string) => {
      const isPdf = path.toLowerCase().endsWith('.pdf');
      const card: FileCard = {
        id: crypto.randomUUID(), kind: 'file', x, y,
        w: FILE_DEFAULT_W, h: isPdf ? FILE_DEFAULT_H : 150, z: this.nextZ(), path,
      };
      this.pushUndo(); this.board.cards.push(card); void this.saveNow();
      this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
    };
    const fromVault = () => new VaultAnyFilePickerModal(this.app, (f) => { void (async () => {
      createCard(await sortAssetFile(this.app, f));
    })(); }).open();
    const fromUpload = () => {
      const input = createEl('input');
      input.type = 'file';
      input.addEventListener('change', () => { void (async () => {
        const file = input.files?.[0]; if (!file) return;
        let path: string;
        try { path = await saveNewAsset(this.app, await file.arrayBuffer(), file.name); }
        catch { new Notice(`Failed to save ${file.name}.`); return; }
        createCard(path);
      })(); });
      input.click();
    };
    new MediaSourceModal(this.app, 'Add file', fromVault, fromUpload).open();
  },

  createSwatchGrid(this: FreeformRenderer, x: number, y: number, colors: NamedColor[]): void {
    const cell = 96, gap = 8, cols = 8;
    this.pushUndo();
    let z = this.nextZ();
    const newIds: string[] = [];
    colors.forEach((entry, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const card: SwatchCard = {
        id: crypto.randomUUID(), kind: 'swatch',
        x: this.applySnap(x + col * (cell + gap)),
        y: this.applySnap(y + row * (cell + gap)),
        w: cell, h: cell, z: z++,
        color: entry.hex,
      };
      this.board.cards.push(card);
      this.createCardEl(card);
      newIds.push(card.id);
    });
    this.selection.clear();
    for (const id of newIds) this.selection.add(id);
    this.refreshSelectionVisuals();
    void this.saveNow();
  },

  rebuildChecklistCard(this: FreeformRenderer, card: ChecklistCard): void {
    const oldEl = this.cardEls.get(card.id);
    if (!oldEl) return;
    const newEl = this.inner.createDiv('visual-notes-freeform-card');
    newEl.dataset.id = card.id;
    this.positionCardEl(newEl, card);
    this.renderCardContent(newEl, card);
    oldEl.replaceWith(newEl);
    this.cardEls.set(card.id, newEl);
  },

  addTile(this: FreeformRenderer): void { const p = this.centerPos(TILE_DEFAULT_W, TILE_DEFAULT_H); this.addTileAt(p.x, p.y); },

  addTileAt(this: FreeformRenderer, x: number, y: number): void {
    new TileModal(this.app, null, (t) => { void (async () => {
      t.x = x; t.y = y; t.w = TILE_DEFAULT_W; t.h = TILE_DEFAULT_H; t.z = this.nextZ();
      try { await this.prepareBoardTileCollaboration(t); }
      catch (error) {
        new Notice(`Board tile was created locally but could not be shared: ${error instanceof Error ? error.message : String(error)}`, 10000);
      }
      this.pushUndo(); this.board.cards.push(t); await this.saveNow();
      this.createCardEl(t); this.selection.select(t.id); this.refreshSelectionVisuals();
    })(); }, this.file).open();
  },

  addSticky(this: FreeformRenderer): void { const p = this.centerPos(STICKY_DEFAULT_W, STICKY_DEFAULT_H); this.addStickyAt(p.x, p.y); },

  addStickyAt(this: FreeformRenderer, x: number, y: number, initialText = ''): void {
    const card: StickyCard = { id: crypto.randomUUID(), kind: 'sticky', x, y, w: STICKY_DEFAULT_W, z: this.nextZ(), text: initialText, color: resolveDefaultStickyColor(this.defaultStickyColor, this.boardIsDark()) };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    if (!initialText) this.editStickyInline(el, card);
  },

  addBlankCard(this: FreeformRenderer): void { const p = this.centerPos(STICKY_DEFAULT_W, STICKY_DEFAULT_H); this.addBlankCardAt(p.x, p.y); },

  addBlankCardAt(this: FreeformRenderer, x: number, y: number): void {
    // Theme-following default (matches checklist's own 'var(--background-
    // primary)' default) instead of a hardcoded near-white hex — the
    // hardcoded value stayed near-white in a dark theme too, which read as
    // "white background, white text" once paired with the dark theme's
    // own (light) --visual-notes-card-text.
    const card: StickyCard = { id: crypto.randomUUID(), kind: 'sticky', x, y, w: STICKY_DEFAULT_W, z: this.nextZ(), text: '', color: 'var(--visual-notes-card-bg)', blank: true };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    this.editStickyInline(el, card);
  },

  addTextCardAt(this: FreeformRenderer, x: number, y: number): void {
    const card: TextCard = {
      id: crypto.randomUUID(), kind: 'text', x, y, z: this.nextZ(),
      text: '', fontSize: TEXT_CARD_DEFAULT_FONT,
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    this.editTextInline(el, card);
  },

  renderTextContent(this: FreeformRenderer, el: HTMLElement, card: TextCard): void {
    el.addClass('visual-notes-freeform-text-card');
    const body = el.createDiv('visual-notes-text-body');
    this.styleTextBody(body, card);
    // Rendered from the same HTML the editor produces, rather than through
    // MarkdownRenderer — so the card doesn't visibly change shape when you
    // enter and leave edit mode.
    if (card.text) body.appendChild(sanitizeHTMLToDom(card.text));
    else { body.addClass('is-placeholder'); body.setText('Text'); }
    this.appendResizeHandles(el);
    this.syncTextCardSize(el, card);
  },

  // A text card's on-screen size comes from CSS (content width at the current
  // font size), not from card.w/h. But connection anchors, the minimap,
  // marquee hit-testing and export bounds all read w/h, so they're kept in
  // step here. Only ever called once the content has settled — never during a
  // drag, which is what keeps resizing free of layout reads.
  syncTextCardSize(this: FreeformRenderer, el: HTMLElement, card: TextCard): void {
    const w = Math.ceil(el.offsetWidth), h = Math.ceil(el.offsetHeight);
    // jsdom, and a card not yet laid out, report 0 — writing that through
    // would leave a card with no clickable area at all.
    if (w > 0 && h > 0) { card.w = w; card.h = h; }
  },

  editTextInline(this: FreeformRenderer, el: HTMLElement, card: TextCard): void {
    const body = el.querySelector<HTMLElement>('.visual-notes-text-body');
    if (!body || el.querySelector('.visual-notes-text-editor')) return;
    body.hide();

    const editor = el.createDiv('visual-notes-text-editor');
    editor.contentEditable = 'true';
    this.styleTextBody(editor, card);
    if (card.text) editor.appendChild(sanitizeHTMLToDom(card.text));
    editor.addEventListener('pointerdown', e => e.stopPropagation());
    // Enter is deliberately not intercepted: a new line is the whole point,
    // since a text card never wraps.
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); editor.blur(); }
      e.stopPropagation();
    });
    new TextFormatToolbar(editor, el, this.container);

    editor.focus();
    const r = activeDocument.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);

    let committed = false;
    editor.addEventListener('blur', () => {
      if (committed) return;
      committed = true;
      card.text = editor.innerHTML;
      // Full re-render rather than swapping the editor out by hand: it rebuilds
      // the body from card.text and re-syncs w/h in one place.
      this.renderCardContent(el, card);
      this.scheduleSave();
    });
  },

  styleTextBody(this: FreeformRenderer, target: HTMLElement, card: TextCard): void {
    target.style.fontSize = `${card.fontSize}px`;
    if (card.color) target.style.color = card.color;
    if (card.fontFamily) target.style.fontFamily = STICKY_FONT_FAMILIES[card.fontFamily];
    if (card.align) target.style.textAlign = card.align;
  },

  addChecklist(this: FreeformRenderer): void { const p = this.centerPos(CHECKLIST_DEFAULT_W, CHECKLIST_DEFAULT_H); this.addChecklistAt(p.x, p.y); },

  addChecklistAt(this: FreeformRenderer, x: number, y: number): void {
    const card: ChecklistCard = { id: crypto.randomUUID(), kind: 'checklist', x, y, w: CHECKLIST_DEFAULT_W, h: CHECKLIST_DEFAULT_H, z: this.nextZ(), title: '', titleHidden: true, items: [], color: 'var(--background-primary)' };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    window.setTimeout(() => el.querySelector<HTMLElement>('.visual-notes-checklist-item-input')?.focus(), 50);
  },

  addComment(this: FreeformRenderer): void { const p = this.centerPos(COMMENT_DEFAULT_W, COMMENT_DEFAULT_H); this.addCommentAt(p.x, p.y); },

  addCommentAt(this: FreeformRenderer, x: number, y: number): void {
    const card: CommentCard = {
      id: crypto.randomUUID(), kind: 'comment', x, y, w: COMMENT_DEFAULT_W, h: COMMENT_DEFAULT_H, z: this.nextZ(),
      text: '', author: this.commentAuthorName, createdAt: Date.now(), replies: [],
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    window.setTimeout(() => el.querySelector<HTMLElement>('.visual-notes-comment-text')?.focus(), 50);
  },

  addNoteLink(this: FreeformRenderer): void { const p = this.centerPos(NOTELINK_DEFAULT_W, NOTELINK_DEFAULT_H); this.addNoteLinkAt(p.x, p.y); },

  addNoteLinkAt(this: FreeformRenderer, x: number, y: number): void {
    new NoteLinkPickerModal(this.app, (file) => {
      const card: NoteLinkCard = { id: crypto.randomUUID(), kind: 'note-link', x, y, w: NOTELINK_DEFAULT_W, h: NOTELINK_DEFAULT_H, z: this.nextZ(), path: file.path, displayMode: 'preview' };
      this.pushUndo(); this.board.cards.push(card); void this.saveNow();
      this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
    }).open();
  },
};
