import {
  TFile, Notice, setIcon, Platform,
  MarkdownRenderer, sanitizeHTMLToDom,
} from 'obsidian';
import {
  StickyCard,
  ImageCard, AudioCard, KanbanColumnCard, KanbanBoardCard, KanbanColumn,
  KanbanItem, ColumnCard,
} from './file-types';
import { contrastColor } from './color-utils';
import {
  resolveThumbnailSrc, parseYouTubeId, youTubeThumbnailUrl,
} from './thumbnail-utils';
import { NamePromptModal } from './tile-modal';
import { IconPickerModal } from './icon-picker';
import { isCustomIconRef, resolveCustomIconSrc } from './custom-icons';
import { TextFormatToolbar } from './text-format-toolbar';
import {
  screenToCanvas,
} from './canvas/pan-zoom';
import { sortAssetFile, saveNewAsset } from './asset-manager';
import {
  STICKY_DEFAULT_W,
  IMAGE_DEFAULT_W, IMAGE_DEFAULT_H,
  AUDIO_DEFAULT_W, AUDIO_DEFAULT_H,
  AUDIO_EXTS,
  KANBAN_DEFAULT_W, KANBAN_DEFAULT_H,
  DRAG_THRESHOLD, IMAGE_EXTS,
  resolveDefaultStickyColor,
  AppWithPrivateAPIs, KANBAN_BOARD_MIN_W, KanbanItemsOwner,
  isValidURL, openExternalUrl, NoteLinkPickerModal, VaultAudioPickerModal, formatDueDate,
  dueUrgency, DueDateModal,
  KanbanItemUrlModal, KanbanItemImageSuggestModal,
  KanbanItemColorModal, WipLimitModal, TagInputModal,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    wireKanbanItemsDragDrop(itemsEl: HTMLElement, owner: KanbanItemsOwner, isLocked: () => boolean): void;
    renderKanbanColumnContent(el: HTMLElement, card: KanbanColumnCard): void;
    rebuildKanbanCard(card: KanbanColumnCard | KanbanBoardCard | ColumnCard): void;
    updateKanbanCount(card: KanbanColumnCard, cardEl: HTMLElement): void;
    editKanbanTitle(card: KanbanColumnCard, _cardEl: HTMLElement, titleEl: HTMLElement): void;
    addKanbanBoard(): void;
    addKanbanBoardAt(x: number, y: number): void;
    renderKanbanBoardContent(el: HTMLElement, card: KanbanBoardCard): void;
    bindColumnResizers(columnsRow: HTMLElement, board: KanbanBoardCard): void;
    renderBoardColumn(columnsRow: HTMLElement, board: KanbanBoardCard, column: KanbanColumn): void;
    updateKanbanBoardColumnCount(board: KanbanBoardCard, column: KanbanColumn): void;
    editKanbanBoardTitle(card: KanbanBoardCard, titleEl: HTMLElement): void;
    editKanbanColumnTitle(board: KanbanBoardCard, column: KanbanColumn, titleEl: HTMLElement): void;
    addColumnToBoard(board: KanbanBoardCard, boardEl: HTMLElement): void;
    removeLastColumnFromBoard(board: KanbanBoardCard): void;
    showColumnMenu(e: MouseEvent, board: KanbanBoardCard, column: KanbanColumn, columnEl: HTMLElement): void;
    appendKanbanItemIconBadge(itemEl: HTMLElement, item: KanbanItem): void;
    kanbanItemToStickyText(item: KanbanItem): string;
    stickyTextToKanbanItem(card: StickyCard): KanbanItem;
    extractKanbanItemToCanvas(item: KanbanItem, itemEl: HTMLElement): void;
    appendKanbanItem(itemsEl: HTMLElement, owner: KanbanItemsOwner, item: KanbanItem): void;
    editKanbanItemInline(owner: KanbanItemsOwner, item: KanbanItem, itemEl: HTMLElement): void;
    addItemToOwner(owner: KanbanItemsOwner, itemsEl: HTMLElement): void;
    promptItemTag(owner: KanbanItemsOwner, item: KanbanItem): void;
    isContainerLocked(cardId: string | undefined): boolean;
    appendLockButton(
        parent: HTMLElement, cardEl: HTMLElement,
        card: (KanbanColumnCard | KanbanBoardCard | ColumnCard),
      ): void;
    resolveKanbanItemsOwner(itemsEl: HTMLElement): KanbanItemsOwner | null;
    startItemDrag(
        startEvent: PointerEvent,
        sourceOwner: KanbanItemsOwner,
        item: KanbanItem,
        itemEl: HTMLElement,
      ): void;
    settleKanbanItem(itemId: string): void;
    handleDroppedImageToKanban(file: File, owner: KanbanItemsOwner, itemsEl: HTMLElement): Promise<void>;
    addKanbanImageItem(imagePath: string, owner: KanbanItemsOwner, itemsEl: HTMLElement): void;
    handleDroppedAudioToKanban(file: File, owner: KanbanItemsOwner, itemsEl: HTMLElement): Promise<void>;
    addKanbanAudioItem(audioPath: string, owner: KanbanItemsOwner, itemsEl: HTMLElement): void;
  }
}

export const cardsKanbanMethods = {
  wireKanbanItemsDragDrop(this: FreeformRenderer, itemsEl: HTMLElement, owner: KanbanItemsOwner, isLocked: () => boolean): void {
    itemsEl.addEventListener('dragenter', (e) => {
      if (isLocked()) return;
      if (this.isDropAccepted(e)) { e.preventDefault(); itemsEl.addClass('is-drag-over'); }
    });
    itemsEl.addEventListener('dragleave', (e) => {
      if (!itemsEl.contains(e.relatedTarget as Node)) itemsEl.removeClass('is-drag-over');
    });
    itemsEl.addEventListener('dragover', (e) => {
      if (isLocked()) return;
      if (this.isDropAccepted(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = 'copy'; }
    });
    itemsEl.addEventListener('drop', (e) => { void (async () => {
      itemsEl.removeClass('is-drag-over');
      if (isLocked() || !this.isDropAccepted(e)) return;
      e.preventDefault(); e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (files?.length) {
        for (const f of Array.from(files)) {
          if (f.type.startsWith('image/')) await this.handleDroppedImageToKanban(f, owner, itemsEl);
          else if (f.type.startsWith('audio/')) await this.handleDroppedAudioToKanban(f, owner, itemsEl);
        }
        return;
      }
      const dragMgr = (this.app as AppWithPrivateAPIs).dragManager;
      const draggable = dragMgr?.draggable;
      if (draggable?.type === 'file' && draggable.file instanceof TFile) {
        const vf = draggable.file;
        const ext = vf.extension.toLowerCase();
        if (IMAGE_EXTS.includes(ext)) {
          const newPath = await sortAssetFile(this.app, vf);
          this.addKanbanImageItem(newPath, owner, itemsEl);
        } else if (AUDIO_EXTS.includes(ext)) {
          const newPath = await sortAssetFile(this.app, vf);
          this.addKanbanAudioItem(newPath, owner, itemsEl);
        }
      }
    })(); });
  },

  renderKanbanColumnContent(this: FreeformRenderer, el: HTMLElement, card: KanbanColumnCard): void {
    el.addClass('visual-notes-freeform-kanban-card');
    if (card.bgColor) el.style.backgroundColor = card.bgColor;
    if (card.topColor) {
      const strip = el.createDiv('visual-notes-card-top-strip');
      strip.style.backgroundColor = card.topColor;
    }

    const owner: KanbanItemsOwner = {
      ownerKey: card.id,
      getItems: () => card.items,
      setItems: (items) => { card.items = items; },
      rebuild: () => this.rebuildKanbanCard(card),
      updateCount: () => { const cEl = this.cardEls.get(card.id); if (cEl) this.updateKanbanCount(card, cEl); },
    };

    const header = el.createDiv('visual-notes-kanban-header');

    let titleEl: HTMLElement | null = null;
    if (!card.titleHidden) {
      titleEl = header.createDiv('visual-notes-kanban-title');
      if (card.color) titleEl.style.color = card.color;
      if (card.title) {
        titleEl.setText(card.title);
      } else {
        titleEl.addClass('visual-notes-kanban-title-empty');
        titleEl.setText('Untitled');
      }
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (titleEl) this.editKanbanTitle(card, el, titleEl);
      });
    }
    // Fallback so double-clicking anywhere else in the header (not just the
    // title text itself — handy for the small, dim "Untitled" placeholder)
    // still opens the rename input. titleEl's own listener above already
    // stops propagation for a direct hit, so this never double-fires.
    header.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.visual-notes-kanban-collapse-btn, .visual-notes-kanban-column-menu-btn')) return;
      e.stopPropagation();
      if (titleEl) this.editKanbanTitle(card, el, titleEl);
    });

    const countRow = header.createDiv('visual-notes-kanban-count-row');
    countRow.createSpan({ cls: 'visual-notes-kanban-col-count' });
    this.updateKanbanCount(card, el);

    this.appendLockButton(header, el, card);

    // "…" menu — a reliable, discoverable way to rename (alongside the
    // dblclick-anywhere-in-header fallback above), matching the board's
    // per-column "…" menu.
    const menuBtn = header.createDiv('visual-notes-kanban-collapse-btn visual-notes-kanban-column-menu-btn');
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', 'Card options');
    menuBtn.addEventListener('pointerdown', e => e.stopPropagation());
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = this.newMenu();
      if (titleEl) {
        menu.addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => {
          if (titleEl) this.editKanbanTitle(card, el, titleEl);
        }));
      }
      menu.showAtMouseEvent(e);
    });

    // Collapse toggle button
    const collapseBtn = header.createDiv('visual-notes-kanban-collapse-btn');
    setIcon(collapseBtn, 'chevron-down');
    collapseBtn.addEventListener('pointerdown', e => e.stopPropagation());
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      card.collapsed = !card.collapsed;
      el.toggleClass('is-collapsed', !!card.collapsed);
      if (card.collapsed) {
        el.setCssStyles({ height: '' });
      } else {
        el.setCssStyles({ height: `${card.h ?? 0}px` });
      }
      this.scheduleSave();
    });

    // Apply collapsed state
    if (card.collapsed) {
      el.addClass('is-collapsed');
      el.setCssStyles({ height: '' });
    }

    const itemsEl = el.createDiv('visual-notes-kanban-items');
    itemsEl.dataset.ownerCardId = card.id;
    for (const item of card.items) {
      this.appendKanbanItem(itemsEl, owner, item);
    }

    this.wireKanbanItemsDragDrop(itemsEl, owner, () => !!card.locked);

    if (!card.locked) {
      const addBtn = el.createDiv('visual-notes-kanban-add-btn');
      const addIcon = addBtn.createSpan();
      setIcon(addIcon, 'plus');
      addBtn.createSpan({ text: 'Add item' });
      addBtn.addEventListener('pointerdown', e => e.stopPropagation());
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addItemToOwner(owner, itemsEl);
      });
    }

    this.appendResizeHandles(el);
  },

  rebuildKanbanCard(this: FreeformRenderer, card: KanbanColumnCard | KanbanBoardCard | ColumnCard): void {
    const oldEl = this.cardEls.get(card.id);
    if (!oldEl) return;
    const newEl = this.inner.createDiv('visual-notes-freeform-card');
    newEl.dataset.id = card.id;
    this.positionCardEl(newEl, card);
    this.renderCardContent(newEl, card);
    oldEl.replaceWith(newEl);
    this.cardEls.set(card.id, newEl);
  },

  updateKanbanCount(this: FreeformRenderer, card: KanbanColumnCard, cardEl: HTMLElement): void {
    const countSpan = cardEl.querySelector<HTMLElement>('.visual-notes-kanban-col-count');
    const wipDot = cardEl.querySelector<HTMLElement>('.visual-notes-kanban-wip-dot');
    const overWip = card.wipLimit !== undefined && card.items.length > card.wipLimit;
    if (countSpan) {
      const n = card.items.length;
      const label = card.wipLimit !== undefined ? `${n}/${card.wipLimit} cards` : `${n} ${n === 1 ? 'card' : 'cards'}`;
      countSpan.setText(label);
    }
    const countRow = cardEl.querySelector<HTMLElement>('.visual-notes-kanban-count-row');
    if (overWip && !wipDot) {
      (countRow ?? cardEl.querySelector('.visual-notes-kanban-header'))?.createSpan({ cls: 'visual-notes-kanban-wip-dot' });
    } else if (!overWip && wipDot) {
      wipDot.remove();
    }
  },

  editKanbanTitle(this: FreeformRenderer, card: KanbanColumnCard, _cardEl: HTMLElement, titleEl: HTMLElement): void {
    if (titleEl.querySelector('input')) return;
    const original = card.title ?? '';
    titleEl.empty();
    const input = titleEl.createEl('input');
    input.type = 'text';
    input.value = original;
    input.addClass('visual-notes-kanban-title-input');

    let cancelled = false;
    const restoreTitle = (text: string | undefined) => {
      titleEl.empty();
      if (card.color) titleEl.style.color = card.color;
      if (text) {
        titleEl.removeClass('visual-notes-kanban-title-empty');
        titleEl.setText(text);
      } else {
        titleEl.addClass('visual-notes-kanban-title-empty');
        titleEl.setText('Untitled');
      }
    };
    const commit = () => {
      if (cancelled) { restoreTitle(original || undefined); return; }
      const val = input.value.trim();
      this.pushUndo();
      card.title = val || undefined;
      restoreTitle(card.title);
      this.scheduleSave();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
  },

  addKanbanBoard(this: FreeformRenderer): void {
    const p = this.centerPos(KANBAN_BOARD_MIN_W, KANBAN_DEFAULT_H);
    this.addKanbanBoardAt(p.x, p.y);
  },

  addKanbanBoardAt(this: FreeformRenderer, x: number, y: number): void {
    const card: KanbanBoardCard = {
      id: crypto.randomUUID(), kind: 'kanban-board',
      x, y, w: KANBAN_DEFAULT_W * 2 + 12, h: KANBAN_DEFAULT_H, z: this.nextZ(),
      columns: [{ id: crypto.randomUUID(), title: 'To do', color: '#6b7280', items: [] }],
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  renderKanbanBoardContent(this: FreeformRenderer, el: HTMLElement, card: KanbanBoardCard): void {
    el.addClass('visual-notes-freeform-kanban-card', 'visual-notes-freeform-kanban-board-card');

    // ── Board-level title bar ──
    const titlebar = el.createDiv('visual-notes-kanban-board-titlebar');
    let boardTitleEl: HTMLElement | null = null;
    if (!card.titleHidden) {
      boardTitleEl = titlebar.createDiv('visual-notes-kanban-board-title');
      if (card.title) boardTitleEl.setText(card.title);
      else { boardTitleEl.addClass('visual-notes-kanban-title-empty'); boardTitleEl.setText('Untitled board'); }
      boardTitleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (boardTitleEl) this.editKanbanBoardTitle(card, boardTitleEl);
      });
    }
    // Fallback so double-clicking anywhere else in the titlebar (not just
    // the title text — handy for the small, dim "Untitled board" placeholder)
    // still opens the rename input. boardTitleEl's own listener above
    // already stops propagation for a direct hit, so this never double-fires.
    titlebar.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.visual-notes-kanban-collapse-btn, .visual-notes-kanban-board-add-col-btn')) return;
      e.stopPropagation();
      if (boardTitleEl) this.editKanbanBoardTitle(card, boardTitleEl);
    });
    this.appendLockButton(titlebar, el, card);

    // "…" menu — a reliable, discoverable way to rename the board itself
    // (alongside the dblclick-anywhere-in-titlebar fallback above),
    // matching each column's own "…" menu further down.
    const menuBtn = titlebar.createDiv('visual-notes-kanban-collapse-btn visual-notes-kanban-column-menu-btn visual-notes-kanban-board-menu-btn');
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', 'Board options');
    menuBtn.addEventListener('pointerdown', e => e.stopPropagation());
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = this.newMenu();
      if (boardTitleEl) {
        menu.addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => {
          if (boardTitleEl) this.editKanbanBoardTitle(card, boardTitleEl);
        }));
      }
      menu.showAtMouseEvent(e);
    });

    const addColBtn = titlebar.createDiv('visual-notes-kanban-board-add-col-btn');
    setIcon(addColBtn, 'plus');
    addColBtn.setAttribute('aria-label', 'Add column');
    addColBtn.addEventListener('pointerdown', e => e.stopPropagation());
    addColBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.addColumnToBoard(card, el);
    });

    const removeColBtn = titlebar.createDiv('visual-notes-kanban-board-add-col-btn visual-notes-kanban-board-remove-col-btn');
    setIcon(removeColBtn, 'minus');
    removeColBtn.setAttribute('aria-label', 'Remove most recently added column');
    removeColBtn.addEventListener('pointerdown', e => e.stopPropagation());
    if (card.columns.length <= 1) {
      removeColBtn.addClass('is-disabled');
    } else {
      removeColBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeLastColumnFromBoard(card);
      });
    }

    // ── Columns, side by side ──
    const columnsRow = el.createDiv('visual-notes-kanban-board-columns');
    for (const column of card.columns) {
      this.renderBoardColumn(columnsRow, card, column);
    }
    this.bindColumnResizers(columnsRow, card);

    this.appendResizeHandles(el);
  },

  bindColumnResizers(this: FreeformRenderer, columnsRow: HTMLElement, board: KanbanBoardCard): void {
    // Matches the CSS min-width on .visual-notes-kanban-board-column.
    const COL_MIN_W = 160;
    const colEls = Array.from(columnsRow.querySelectorAll<HTMLElement>('.visual-notes-kanban-board-column'));
    for (let i = 1; i < colEls.length; i++) {
      const resizer = colEls[i].createDiv('visual-notes-kanban-col-resizer');
      resizer.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.pushUndo();
        // Seed every column's weight from its current on-screen width so
        // untouched columns keep their exact size (a default weight of 1
        // mixed with pixel-scale weights would collapse them).
        const startW = colEls.map(ce => ce.getBoundingClientRect().width / this.vp.zoom);
        board.columns.forEach((c, ci) => { c.width = startW[ci]; });
        colEls.forEach((ce, ci) => { ce.style.flexGrow = String(startW[ci]); });
        const sx = e.clientX;
        const leftStart = startW[i - 1], rightStart = startW[i];
        resizer.setPointerCapture(e.pointerId);
        resizer.addClass('is-resizing');
        const onMove = (ev: PointerEvent) => {
          let dx = (ev.clientX - sx) / this.vp.zoom;
          dx = Math.min(dx, rightStart - COL_MIN_W);
          dx = Math.max(dx, COL_MIN_W - leftStart);
          if (leftStart + dx < COL_MIN_W || rightStart - dx < COL_MIN_W) dx = 0;
          const lw = leftStart + dx, rw = rightStart - dx;
          board.columns[i - 1].width = lw; board.columns[i].width = rw;
          colEls[i - 1].style.flexGrow = String(lw); colEls[i].style.flexGrow = String(rw);
        };
        const onUp = () => {
          resizer.removeEventListener('pointermove', onMove);
          resizer.removeEventListener('pointerup', onUp);
          resizer.removeClass('is-resizing');
          this.scheduleSave();
        };
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
      });
    }
  },

  renderBoardColumn(this: FreeformRenderer, columnsRow: HTMLElement, board: KanbanBoardCard, column: KanbanColumn): void {
    const columnEl = columnsRow.createDiv('visual-notes-kanban-board-column');
    columnEl.dataset.columnId = column.id;
    if (typeof column.width === 'number') columnEl.style.flexGrow = String(column.width);
    if (column.bgColor) columnEl.style.backgroundColor = column.bgColor;
    if (column.topColor) {
      const strip = columnEl.createDiv('visual-notes-card-top-strip');
      strip.style.backgroundColor = column.topColor;
    }

    const owner: KanbanItemsOwner = {
      ownerKey: `${board.id}:${column.id}`,
      getItems: () => column.items,
      setItems: (items) => { column.items = items; },
      rebuild: () => this.rebuildKanbanCard(board),
      updateCount: () => this.updateKanbanBoardColumnCount(board, column),
    };

    const header = columnEl.createDiv('visual-notes-kanban-header');

    let titleEl: HTMLElement | null = null;
    if (!column.titleHidden) {
      titleEl = header.createDiv('visual-notes-kanban-title');
      if (column.color) titleEl.style.color = column.color;
      if (column.title) titleEl.setText(column.title);
      else { titleEl.addClass('visual-notes-kanban-title-empty'); titleEl.setText('Untitled'); }
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (titleEl) this.editKanbanColumnTitle(board, column, titleEl);
      });
    }
    // Fallback so double-clicking anywhere else in the header (not just the
    // title text — handy for the small, dim "Untitled" placeholder) still
    // opens the rename input. titleEl's own listener above already stops
    // propagation for a direct hit, so this never double-fires.
    header.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.visual-notes-kanban-collapse-btn, .visual-notes-kanban-column-menu-btn')) return;
      e.stopPropagation();
      if (titleEl) this.editKanbanColumnTitle(board, column, titleEl);
    });

    const countRow = header.createDiv('visual-notes-kanban-count-row');
    countRow.createSpan({ cls: 'visual-notes-kanban-col-count' });
    this.updateKanbanBoardColumnCount(board, column);

    const collapseBtn = header.createDiv('visual-notes-kanban-collapse-btn');
    setIcon(collapseBtn, 'chevron-down');
    collapseBtn.addEventListener('pointerdown', e => e.stopPropagation());
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      column.collapsed = !column.collapsed;
      columnEl.toggleClass('is-collapsed', !!column.collapsed);
      this.scheduleSave();
    });

    const menuBtn = header.createDiv('visual-notes-kanban-collapse-btn visual-notes-kanban-column-menu-btn');
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', 'Column options');
    menuBtn.addEventListener('pointerdown', e => e.stopPropagation());
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showColumnMenu(e, board, column, columnEl);
    });

    if (column.collapsed) columnEl.addClass('is-collapsed');

    const itemsEl = columnEl.createDiv('visual-notes-kanban-items');
    itemsEl.dataset.ownerCardId = board.id;
    itemsEl.dataset.ownerColumnId = column.id;
    for (const item of column.items) {
      this.appendKanbanItem(itemsEl, owner, item);
    }

    this.wireKanbanItemsDragDrop(itemsEl, owner, () => !!board.locked);

    if (!board.locked) {
      const addBtn = columnEl.createDiv('visual-notes-kanban-add-btn');
      const addIcon = addBtn.createSpan();
      setIcon(addIcon, 'plus');
      addBtn.createSpan({ text: 'Add item' });
      addBtn.addEventListener('pointerdown', e => e.stopPropagation());
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addItemToOwner(owner, itemsEl);
      });
    }
  },

  updateKanbanBoardColumnCount(this: FreeformRenderer, board: KanbanBoardCard, column: KanbanColumn): void {
    const boardEl = this.cardEls.get(board.id);
    const columnEl = boardEl?.querySelector<HTMLElement>(`.visual-notes-kanban-board-column[data-column-id="${column.id}"]`);
    if (!columnEl) return;
    const countSpan = columnEl.querySelector<HTMLElement>('.visual-notes-kanban-col-count');
    const wipDot = columnEl.querySelector<HTMLElement>('.visual-notes-kanban-wip-dot');
    const overWip = column.wipLimit !== undefined && column.items.length > column.wipLimit;
    if (countSpan) {
      const n = column.items.length;
      const label = column.wipLimit !== undefined ? `${n}/${column.wipLimit} cards` : `${n} ${n === 1 ? 'card' : 'cards'}`;
      countSpan.setText(label);
    }
    const countRow = columnEl.querySelector<HTMLElement>('.visual-notes-kanban-count-row');
    if (overWip && !wipDot) {
      (countRow ?? columnEl.querySelector('.visual-notes-kanban-header'))?.createSpan({ cls: 'visual-notes-kanban-wip-dot' });
    } else if (!overWip && wipDot) {
      wipDot.remove();
    }
  },

  editKanbanBoardTitle(this: FreeformRenderer, card: KanbanBoardCard, titleEl: HTMLElement): void {
    if (titleEl.querySelector('input')) return;
    const original = card.title ?? '';
    titleEl.empty();
    const input = titleEl.createEl('input');
    input.type = 'text'; input.value = original;
    input.addClass('visual-notes-kanban-title-input');

    let cancelled = false;
    const restore = (text: string | undefined) => {
      titleEl.empty();
      if (text) { titleEl.removeClass('visual-notes-kanban-title-empty'); titleEl.setText(text); }
      else { titleEl.addClass('visual-notes-kanban-title-empty'); titleEl.setText('Untitled board'); }
    };
    const commit = () => {
      if (cancelled) { restore(original || undefined); return; }
      this.pushUndo();
      card.title = input.value.trim() || undefined;
      restore(card.title);
      this.scheduleSave();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
  },

  editKanbanColumnTitle(this: FreeformRenderer, board: KanbanBoardCard, column: KanbanColumn, titleEl: HTMLElement): void {
    if (titleEl.querySelector('input')) return;
    const original = column.title ?? '';
    titleEl.empty();
    const input = titleEl.createEl('input');
    input.type = 'text'; input.value = original;
    input.addClass('visual-notes-kanban-title-input');

    let cancelled = false;
    const restore = (text: string | undefined) => {
      titleEl.empty();
      if (column.color) titleEl.style.color = column.color;
      if (text) { titleEl.removeClass('visual-notes-kanban-title-empty'); titleEl.setText(text); }
      else { titleEl.addClass('visual-notes-kanban-title-empty'); titleEl.setText('Untitled'); }
    };
    const commit = () => {
      if (cancelled) { restore(original || undefined); return; }
      this.pushUndo();
      column.title = input.value.trim() || undefined;
      restore(column.title);
      this.scheduleSave();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
  },

  addColumnToBoard(this: FreeformRenderer, board: KanbanBoardCard, boardEl: HTMLElement): void {
    this.pushUndo();
    const column: KanbanColumn = { id: crypto.randomUUID(), title: 'New column', color: '#6b7280', items: [] };
    // If existing columns carry explicit resize weights, match their average
    // so the new lane doesn't render collapsed next to pixel-scale weights.
    const weights = board.columns.map(c => c.width).filter((w): w is number => typeof w === 'number');
    if (weights.length) column.width = weights.reduce((a, b) => a + b, 0) / weights.length;
    board.columns.push(column);
    // Widen the board so the new column has room, rather than squeezing
    // existing columns — matches how "Add col" felt before (a new lane
    // appears rather than everyone getting thinner).
    board.w = (board.w ?? KANBAN_DEFAULT_W * 2) + KANBAN_DEFAULT_W + 12;
    this.scheduleSave();
    this.rebuildKanbanCard(board);
    const newColEl = boardEl.parentElement
      ? this.cardEls.get(board.id)?.querySelector<HTMLElement>(`.visual-notes-kanban-board-column[data-column-id="${column.id}"] .visual-notes-kanban-title`)
      : null;
    if (newColEl) this.editKanbanColumnTitle(board, column, newColEl);
  },

  removeLastColumnFromBoard(this: FreeformRenderer, board: KanbanBoardCard): void {
    if (board.columns.length <= 1) return; // always keep at least one column
    this.pushUndo();
    board.columns.pop();
    // Undo the width bump addColumnToBoard applied, mirroring it back down
    // rather than leaving a wide board with empty space on the right.
    board.w = Math.max(KANBAN_BOARD_MIN_W, (board.w ?? KANBAN_DEFAULT_W * 2) - KANBAN_DEFAULT_W - 12);
    this.scheduleSave();
    this.rebuildKanbanCard(board);
  },

  showColumnMenu(this: FreeformRenderer, e: MouseEvent, board: KanbanBoardCard, column: KanbanColumn, columnEl: HTMLElement): void {
    const menu = this.newMenu();
    menu.addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => {
      const titleEl = columnEl.querySelector<HTMLElement>('.visual-notes-kanban-title');
      if (titleEl) this.editKanbanColumnTitle(board, column, titleEl);
    }));
    menu.addItem(i => i.setTitle('Set title color…').setIcon('palette').onClick(() => {
      new KanbanItemColorModal(this.app, column.color, (hex) => {
        this.pushUndo(); column.color = hex ?? '#6b7280';
        this.rebuildKanbanCard(board); this.scheduleSave();
      }, this.boardIsDark()).open();
    }));
    menu.addItem(i => i.setTitle('Set background…').setIcon('palette').onClick(() => {
      new KanbanItemColorModal(this.app, column.bgColor, (hex) => {
        this.pushUndo(); column.bgColor = hex;
        this.rebuildKanbanCard(board); this.scheduleSave();
      }, this.boardIsDark()).open();
    }));
    menu.addItem(i => i.setTitle('Set WIP limit…').setIcon('gauge').onClick(() => {
      new WipLimitModal(this.app, column.wipLimit, (limit) => {
        this.pushUndo(); column.wipLimit = limit;
        this.updateKanbanBoardColumnCount(board, column); this.scheduleSave();
      }).open();
    }));
    menu.addItem(i => i.setTitle('Sort by due date').setIcon('calendar-arrow-up').onClick(() => {
      this.pushUndo();
      // Dated items first (soonest → latest), undated keep their order after.
      column.items.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
      this.rebuildKanbanCard(board); this.scheduleSave();
    }));
    menu.addSeparator();
    if (board.columns.length > 1) {
      menu.addItem(i => i.setTitle('Delete column').setIcon('trash').onClick(() => {
        this.pushUndo();
        board.columns = board.columns.filter(c => c.id !== column.id);
        this.rebuildKanbanCard(board); this.scheduleSave();
      }));
    } else {
      menu.addItem(i => i.setTitle('Delete board').setIcon('trash').onClick(() => {
        this.pushUndo();
        const boardEl = this.cardEls.get(board.id);
        boardEl?.remove();
        this.cardEls.delete(board.id);
        this.board.cards = this.board.cards.filter(c => c.id !== board.id);
        this.selection.clear();
        this.contextBar.hide();
        this.scheduleSave();
      }));
    }
    menu.showAtMouseEvent(e);
  },

  appendKanbanItemIconBadge(this: FreeformRenderer, itemEl: HTMLElement, item: KanbanItem): void {
    if (!item.icon) return;
    const badge = itemEl.createDiv('visual-notes-kanban-item-icon-badge');
    // Same reasoning as the tile square: a custom asset icon is full art,
    // not a glyph meant to sit on an accent-colored chip, so it gets no
    // background instead of the usual icon-color fill showing through as a
    // colored ring around it.
    badge.style.backgroundColor = isCustomIconRef(item.icon) ? 'transparent' : (item.iconColor ?? '#3B82F6');
    const badgeIconEl = badge.createDiv('visual-notes-kanban-item-icon-inner');
    badgeIconEl.style.color = contrastColor(item.iconColor ?? '#3B82F6');
    const customSrc = isCustomIconRef(item.icon) ? resolveCustomIconSrc(item.icon) : undefined;
    const isSingleEmoji = [...item.icon].length === 1 && /\p{Emoji_Presentation}/u.test(item.icon);
    if (customSrc) { badgeIconEl.createEl('img', { attr: { src: customSrc }, cls: 'visual-notes-tile-custom-icon-img' }); }
    else if (isSingleEmoji) { badgeIconEl.setText(item.icon); badgeIconEl.addClass('visual-notes-tile-emoji'); }
    else { setIcon(badgeIconEl, item.icon); }
  },

  kanbanItemToStickyText(this: FreeformRenderer, item: KanbanItem): string {
    const parts: string[] = [];
    if (item.text) parts.push(item.text);
    if (item.imagePath) parts.push(`![[${item.imagePath}]]`);
    if (item.audioPath) parts.push(`![[${item.audioPath}]]`);
    if (item.linkedNotePath) parts.push(`[[${item.linkedNotePath.replace(/\.md$/, '')}]]`);
    if (item.linkUrl) parts.push(item.linkUrl);
    if (item.tags && item.tags.length > 0) parts.push(item.tags.map(t => `#${t}`).join(' '));
    return parts.join('\n\n');
  },

  stickyTextToKanbanItem(this: FreeformRenderer, card: StickyCard): KanbanItem {
    // extractKanbanItemToCanvas stamps this same fallback onto every sticky
    // it creates for a colorless item, so seeing it here means the color
    // was never deliberately set — reset it back to unset rather than
    // force a color onto an item that didn't have one.
    const fallbackColor = resolveDefaultStickyColor(this.defaultStickyColor, this.boardIsDark());
    const item: KanbanItem = { id: crypto.randomUUID(), text: '', color: card.color === fallbackColor ? undefined : card.color };
    const textParts: string[] = [];
    const tags: string[] = [];

    for (const raw of (card.text ?? '').split(/\n{2,}/)) {
      const p = raw.trim();
      if (!p) continue;

      const embedMatch = p.match(/^!\[\[(.+)\]\]$/);
      if (embedMatch) {
        const path = embedMatch[1];
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        if (!item.imagePath && IMAGE_EXTS.includes(ext)) { item.imagePath = path; continue; }
        if (!item.audioPath && AUDIO_EXTS.includes(ext)) { item.audioPath = path; continue; }
      }

      const linkMatch = p.match(/^\[\[(.+)\]\]$/);
      if (linkMatch && !item.linkedNotePath) {
        const notePath = linkMatch[1];
        item.linkedNotePath = notePath.endsWith('.md') ? notePath : `${notePath}.md`;
        continue;
      }

      if (!item.linkUrl && isValidURL(p)) { item.linkUrl = p; continue; }

      if (/^(#[\w-]+\s*)+$/.test(p)) {
        const tagRe = /#([\w-]+)/g;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(p))) tags.push(m[1]);
        continue;
      }

      textParts.push(p);
    }

    if (tags.length > 0) item.tags = tags;
    item.text = textParts.join('\n\n');
    return item;
  },

  extractKanbanItemToCanvas(this: FreeformRenderer, item: KanbanItem, itemEl: HTMLElement): void {
    const rect = itemEl.getBoundingClientRect();
    const outerRect = this.outer.getBoundingClientRect();
    const cp = screenToCanvas(rect.right - outerRect.left + 24, rect.top - outerRect.top, this.vp);

    const card: StickyCard = {
      id: crypto.randomUUID(), kind: 'sticky',
      x: this.applySnap(cp.x), y: this.applySnap(cp.y), w: STICKY_DEFAULT_W, z: this.nextZ(),
      text: this.kanbanItemToStickyText(item),
      color: item.color ?? resolveDefaultStickyColor(this.defaultStickyColor, this.boardIsDark()),
    };
    this.board.cards.push(card);
    this.createCardEl(card);
    this.selection.select(card.id);
    this.refreshSelectionVisuals();
  },

  appendKanbanItem(this: FreeformRenderer, itemsEl: HTMLElement, owner: KanbanItemsOwner, item: KanbanItem): void {
    const itemEl = itemsEl.createDiv('visual-notes-kanban-item');
    itemEl.dataset.itemId = item.id;
    // Set directly on the item (not a container ancestor) so the drag ghost
    // — a clone of this exact element — carries the same sizing without
    // needing its old parent context.
    itemEl.toggleClass('is-large', this.largeKanbanItems);
    itemEl.toggleClass('is-done', item.done ?? false);
    itemEl.setAttribute('tabindex', '0');
    if (item.color) {
      itemEl.style.backgroundColor = item.color;
      itemEl.style.color = contrastColor(item.color);
      itemEl.addClass('has-custom-color');
    }

    const removeItem = () => {
      const idx = owner.getItems().findIndex(i => i.id === item.id);
      if (idx !== -1) { const items = owner.getItems().slice(); items.splice(idx, 1); owner.setItems(items); }
      itemEl.remove();
      owner.updateCount();
    };

    const cb = itemEl.createDiv('visual-notes-kanban-item-cb');
    cb.toggleClass('is-checked', item.done ?? false);
    cb.setAttribute('aria-label', 'Mark done');
    // Without this the pointerdown reaches the card-level drag machinery,
    // which starts a card drag and swallows the click below — the checkbox
    // looked completely dead. The item's own pointerdown handler does skip
    // drag-start for this element, but it returns without stopping
    // propagation, so the event still escapes to the card. Same guard every
    // other control here uses (column menu, collapse, add-item, subtask
    // checkbox); this one was simply missing it.
    cb.addEventListener('pointerdown', e => e.stopPropagation());
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      item.done = !item.done;
      itemEl.toggleClass('is-done', item.done);
      cb.toggleClass('is-checked', item.done);
      owner.updateCount();
      this.scheduleSave();
    });

    const itemThumbSrc = resolveThumbnailSrc(this.app, item);
    if (itemThumbSrc) {
      const badge = itemEl.createDiv('visual-notes-kanban-item-icon-badge visual-notes-kanban-item-thumb-badge');
      const img = badge.createEl('img');
      img.src = itemThumbSrc;
      img.alt = '';
      img.addEventListener('error', () => {
        // Broken vault path or dead URL — fall back to the icon badge.
        badge.remove();
        if (item.icon) this.appendKanbanItemIconBadge(itemEl, item);
      });
    } else if (item.icon) {
      this.appendKanbanItemIconBadge(itemEl, item);
    }

    const bodyEl = itemEl.createDiv('visual-notes-kanban-item-body');
    const textEl = bodyEl.createDiv('visual-notes-kanban-item-text');
    if (item.text) {
      MarkdownRenderer.render(this.app, item.text, textEl, '', this).catch(() => textEl.setText(item.text));
    }
    // Media only takes over the whole card (full-bleed image look — the
    // .has-image CSS hides the checkbox, text, and delete button) when the
    // item carries no task content of its own. A real task keeps its normal
    // row — checkbox, text, badges, subtasks all visible — and the media
    // renders inline underneath instead.
    const isBareMedia = !item.text?.trim() && !item.subtasks?.length && !item.dueDate;
    if (item.imagePath) {
      itemEl.addClass(isBareMedia ? 'has-image' : 'has-inline-media');
      const imgWrap = bodyEl.createDiv('visual-notes-kanban-item-image');
      const vf = this.app.vault.getAbstractFileByPath(item.imagePath);
      if (vf instanceof TFile) {
        const img = imgWrap.createEl('img');
        img.src = this.app.vault.getResourcePath(vf);
        img.alt = '';
      }
    }

    const youTubeId = item.linkUrl ? parseYouTubeId(item.linkUrl) : null;
    if (youTubeId) {
      itemEl.addClass(isBareMedia ? 'has-image' : 'has-inline-media');
      const videoWrap = bodyEl.createDiv('visual-notes-kanban-item-image visual-notes-kanban-item-video');
      const img = videoWrap.createEl('img');
      img.src = youTubeThumbnailUrl(youTubeId);
      img.alt = 'YouTube video';
      const playBadge = videoWrap.createDiv('visual-notes-kanban-video-play');
      setIcon(playBadge, 'play');
      videoWrap.addEventListener('click', (e) => {
        e.stopPropagation();
        openExternalUrl(item.linkUrl);
      });
    }

    if (item.audioPath) {
      const audioWrap = bodyEl.createDiv('visual-notes-kanban-item-audio');
      const vf = this.app.vault.getAbstractFileByPath(item.audioPath);
      if (vf instanceof TFile) {
        audioWrap.createDiv({ cls: 'visual-notes-kanban-audio-title', text: vf.basename });
        const audio = audioWrap.createEl('audio');
        audio.src = this.app.vault.getResourcePath(vf);
        audio.controls = true;
        audio.addClass('visual-notes-kanban-audio-player');
        audio.addEventListener('pointerdown', (e) => e.stopPropagation());
        audio.addEventListener('click', (e) => e.stopPropagation());
      }
    }

    const hasMeta = item.nestedBoardPath || item.linkedNotePath || (item.linkUrl && !youTubeId) || (item.tags && item.tags.length > 0);
    if (hasMeta) {
      const metaEl = bodyEl.createDiv('visual-notes-kanban-item-meta');
      if (item.nestedBoardPath) {
        const pill = metaEl.createDiv('visual-notes-kanban-item-note-pill visual-notes-kanban-item-board-pill');
        const iconSrc = item.nestedBoardIcon && isCustomIconRef(item.nestedBoardIcon)
          ? resolveCustomIconSrc(item.nestedBoardIcon) : undefined;
        if (iconSrc) pill.createEl('img', { attr: { src: iconSrc }, cls: 'visual-notes-nested-pill-img' });
        else { const iconEl = pill.createSpan(); setIcon(iconEl, 'layout-template'); }
        const resolved = this.resolveNestedBoard(item.nestedBoardPath);
        const boardName = resolved?.basename
          ?? item.nestedBoardPath.split('/').pop()?.replace(/\.canvas$/, '') ?? 'Board';
        pill.toggleClass('is-missing', !resolved);
        pill.createSpan({ text: boardName });
        pill.setAttribute('aria-label', `Open nested board "${boardName}"`);
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openNestedBoard(item.nestedBoardPath!, (p) => { item.nestedBoardPath = p; });
        });
      }
      if (item.linkedNotePath) {
        const pill = metaEl.createDiv('visual-notes-kanban-item-note-pill');
        const iconEl = pill.createSpan(); setIcon(iconEl, 'file-text');
        const noteName = item.linkedNotePath.split('/').pop()?.replace(/\.md$/, '') ?? item.linkedNotePath;
        pill.createSpan({ text: noteName });
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.app.workspace.openLinkText(item.linkedNotePath!, '', false);
        });
      }
      if (item.linkUrl && !youTubeId) {
        const pill = metaEl.createDiv('visual-notes-kanban-item-note-pill');
        const iconEl = pill.createSpan(); setIcon(iconEl, 'link');
        let host = item.linkUrl;
        try { host = new URL(item.linkUrl).hostname; } catch { /* keep raw url as fallback label */ }
        pill.createSpan({ text: host });
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          openExternalUrl(item.linkUrl);
        });
      }
      if (item.tags) {
        for (const tag of item.tags) {
          metaEl.createDiv({ cls: 'visual-notes-kanban-item-tag', text: `#${tag}` });
        }
      }
    }

    // ── Sub-checklist rows (Trello-style checklist inside the item) ──
    if (item.subtasks && item.subtasks.length > 0) {
      const stWrap = bodyEl.createDiv('visual-notes-kanban-subtasks');
      for (const st of item.subtasks) {
        const row = stWrap.createDiv('visual-notes-kanban-subtask');
        row.toggleClass('is-done', st.done);
        const stCb = row.createDiv('visual-notes-kanban-subtask-cb');
        stCb.toggleClass('is-checked', st.done);
        stCb.addEventListener('pointerdown', e => e.stopPropagation());
        stCb.addEventListener('click', (e) => {
          e.stopPropagation();
          this.pushUndo();
          st.done = !st.done;
          owner.rebuild();
          this.scheduleSave();
        });
        row.createDiv({ cls: 'visual-notes-kanban-subtask-text', text: st.text });
        const stDel = row.createDiv('visual-notes-kanban-subtask-del');
        setIcon(stDel, 'x');
        stDel.setAttribute('aria-label', 'Remove sub-task');
        stDel.addEventListener('pointerdown', e => e.stopPropagation());
        stDel.addEventListener('click', (e) => {
          e.stopPropagation();
          this.pushUndo();
          item.subtasks = item.subtasks!.filter(s => s.id !== st.id);
          owner.rebuild();
          this.scheduleSave();
        });
      }
    }

    // ── Footer badges: due date + sub-task progress ──
    const subDone = item.subtasks?.filter(s => s.done).length ?? 0;
    const subTotal = item.subtasks?.length ?? 0;
    if (item.dueDate || subTotal > 0) {
      const badges = bodyEl.createDiv('visual-notes-kanban-item-badges');
      if (item.dueDate) {
        const b = badges.createDiv('visual-notes-kanban-due-badge');
        setIcon(b.createSpan(), 'calendar');
        b.createSpan({ text: formatDueDate(item.dueDate) });
        const urgency = dueUrgency(item.dueDate, item.done);
        if (urgency) b.addClass(`is-${urgency}`);
      }
      if (subTotal > 0) {
        const p = badges.createDiv('visual-notes-kanban-subtask-pill');
        setIcon(p.createSpan(), 'check-square');
        p.createSpan({ text: `${subDone}/${subTotal}` });
        if (subDone === subTotal) p.addClass('is-complete');
      }
    }

    const delBtn = itemEl.createDiv('visual-notes-kanban-item-del');
    setIcon(delBtn, 'x');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      removeItem();
      this.scheduleSave();
    });

    itemEl.addEventListener('keydown', (e) => {
      if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); cb.click(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.editKanbanItemInline(owner, item, itemEl); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); e.stopPropagation();
        this.pushUndo();
        removeItem();
        this.scheduleSave();
      }
    });

    itemEl.addEventListener('pointerdown', (e) => {
      if (this.penModeActive) {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        this.startInkStroke(e);
        return;
      }
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.visual-notes-kanban-item-cb') || target.closest('.visual-notes-kanban-item-del')) return;
      e.stopPropagation();

      // Locked container: the item stays put — no drag ever starts.
      // (ownerKey is `${cardId}` or `${cardId}:${columnId}`.)
      if (this.isContainerLocked(owner.ownerKey.split(':')[0])) return;

      let wasDragged = false;
      const sx = e.clientX, sy = e.clientY;
      const startE = e;

      const onMove = (e2: PointerEvent) => {
        if (!wasDragged && Math.hypot(e2.clientX - sx, e2.clientY - sy) > DRAG_THRESHOLD) {
          wasDragged = true;
          activeDocument.removeEventListener('pointermove', onMove);
          activeDocument.removeEventListener('pointerup', onUp);
          this.startItemDrag(startE, owner, item, itemEl);
        }
      };
      const onUp = () => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
        if (!wasDragged) {
          // On a phone, a plain tap (no drag) opens the item's editor
          // directly — dblclick, the only other route in, is unreliable on
          // touch. Desktop/tablet keep the focus-only behavior since a
          // focused item drives keyboard shortcuts (Space toggles, Enter
          // edits, Delete removes) that an auto-opened editor would eat.
          // Same image/audio guard as the dblclick handler below.
          if (Platform.isPhone && !item.imagePath && !item.audioPath) {
            this.editKanbanItemInline(owner, item, itemEl);
          } else {
            itemEl.focus();
          }
        }
      };
      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });

    itemEl.addEventListener('dblclick', (e) => {
      if (this.penModeActive) return;
      const target = e.target as HTMLElement;
      if (target.closest('.visual-notes-kanban-item-cb') || target.closest('.visual-notes-kanban-item-del')) return;
      e.stopPropagation();
      if (!item.imagePath && !item.audioPath) this.editKanbanItemInline(owner, item, itemEl);
    });

    itemEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const menu = this.newMenu();
      menu.addItem(i => i.setTitle('Extract to canvas').setIcon('external-link').onClick(() => {
        this.pushUndo();
        this.extractKanbanItemToCanvas(item, itemEl);
        removeItem();
        this.scheduleSave();
      }));
      if (item.nestedBoardPath) {
        menu.addItem(i => i.setTitle('Open nested board').setIcon('layout-template').onClick(() => {
          this.openNestedBoard(item.nestedBoardPath!, (p) => { item.nestedBoardPath = p; });
        }));
        menu.addItem(i => i.setTitle('Unlink nested board').setIcon('unlink').onClick(() => {
          this.pushUndo();
          item.nestedBoardPath = undefined; item.nestedBoardIcon = undefined;
          owner.rebuild(); this.scheduleSave();
        }));
      } else {
        menu.addItem(i => i.setTitle('Create nested board…').setIcon('layout-template').onClick(() => {
          const defaultName = item.text.split('\n')[0].replace(/[*_#`[\]]/g, '').trim().slice(0, 60);
          this.createNestedBoardFrom(defaultName, (path, icon) => {
            this.pushUndo();
            item.nestedBoardPath = path; item.nestedBoardIcon = icon;
            owner.rebuild();
          });
        }));
      }
      menu.addSeparator();
      if (!item.thumbnail) {
        menu.addItem(i => i.setTitle(item.icon ? 'Change icon…' : 'Set icon…').setIcon('image').onClick(() => {
          new IconPickerModal(this.app, item.iconColor ?? '#3B82F6', (selected, color) => {
            this.pushUndo(); item.icon = selected; item.iconColor = color;
            owner.rebuild(); this.scheduleSave();
          }).open();
        }));
        if (item.icon) {
          menu.addItem(i => i.setTitle('Remove icon').setIcon('x').onClick(() => {
            this.pushUndo(); item.icon = undefined; item.iconColor = undefined;
            owner.rebuild(); this.scheduleSave();
          }));
        }
      }
      if (!item.icon) {
        menu.addItem(i => i.setTitle(item.thumbnail ? 'Change thumbnail image…' : 'Set thumbnail image…').setIcon('image-plus').onClick(() => {
          new KanbanItemImageSuggestModal(this.app, (file) => {
            this.pushUndo(); item.thumbnail = { type: 'vault', path: file.path };
            owner.rebuild(); this.scheduleSave();
          }).open();
        }));
        menu.addItem(i => i.setTitle('Use thumbnail URL…').setIcon('link').onClick(() => {
          new KanbanItemUrlModal(this.app, '', (url) => {
            if (!url) return;
            this.pushUndo(); item.thumbnail = { type: 'external', url };
            owner.rebuild(); this.scheduleSave();
          }).open();
        }));
        if (item.thumbnail) {
          menu.addItem(i => i.setTitle('Remove thumbnail').setIcon('x').onClick(() => {
            this.pushUndo(); item.thumbnail = undefined;
            owner.rebuild(); this.scheduleSave();
          }));
        }
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle(item.color ? 'Change color…' : 'Set color…').setIcon('palette').onClick(() => {
        new KanbanItemColorModal(this.app, item.color, (hex) => {
          this.pushUndo(); item.color = hex;
          owner.rebuild(); this.scheduleSave();
        }, this.boardIsDark()).open();
      }));
      if (item.color) {
        menu.addItem(i => i.setTitle('Reset color').setIcon('x').onClick(() => {
          this.pushUndo(); item.color = undefined;
          owner.rebuild(); this.scheduleSave();
        }));
      }
      menu.addSeparator();
      if (item.linkedNotePath) {
        menu.addItem(i => i.setTitle('Open linked note').setIcon('file-text').onClick(() => {
          void this.app.workspace.openLinkText(item.linkedNotePath!, '', false);
        }));
        menu.addItem(i => i.setTitle('Remove link').setIcon('unlink').onClick(() => {
          this.pushUndo(); item.linkedNotePath = undefined;
          owner.rebuild(); this.scheduleSave();
        }));
        menu.addSeparator();
      }
      menu.addItem(i => i.setTitle('Link to note…').setIcon('file-text').onClick(() => {
        new NoteLinkPickerModal(this.app, (file) => {
          this.pushUndo(); item.linkedNotePath = file.path;
          owner.rebuild(); this.scheduleSave();
        }).open();
      }));
      if (item.linkUrl) {
        menu.addItem(i => i.setTitle('Open link').setIcon('link').onClick(() => openExternalUrl(item.linkUrl)));
        menu.addItem(i => i.setTitle('Remove web link').setIcon('unlink').onClick(() => {
          this.pushUndo(); item.linkUrl = undefined;
          owner.rebuild(); this.scheduleSave();
        }));
      } else {
        menu.addItem(i => i.setTitle('Add web link…').setIcon('link').onClick(() => {
          new KanbanItemUrlModal(this.app, '', (url) => {
            if (!url) return;
            this.pushUndo(); item.linkUrl = url;
            owner.rebuild(); this.scheduleSave();
          }).open();
        }));
      }
      if (item.tags && item.tags.length > 0) {
        menu.addSeparator();
        for (const tag of item.tags) {
          menu.addItem(i => i.setTitle(`Remove #${tag}`).setIcon('x').onClick(() => {
            this.pushUndo(); item.tags = item.tags!.filter(t => t !== tag);
            owner.rebuild(); this.scheduleSave();
          }));
        }
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle(item.dueDate ? 'Change due date…' : 'Set due date…').setIcon('calendar').onClick(() => {
        new DueDateModal(this.app, item.dueDate, (date) => {
          this.pushUndo();
          item.dueDate = date;
          owner.rebuild();
          this.scheduleSave();
        }).open();
      }));
      menu.addItem(i => i.setTitle('Add sub-task…').setIcon('list-checks').onClick(() => {
        new NamePromptModal(this.app, 'New sub-task', 'e.g. "Draft outline"', (name) => {
          const text = name.trim(); if (!text) return;
          this.pushUndo();
          (item.subtasks ??= []).push({ id: crypto.randomUUID(), text, done: false });
          owner.rebuild();
          this.scheduleSave();
        }).open();
      }));
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Attach audio…').setIcon('music').onClick(() => {
        new VaultAudioPickerModal(this.app, (file) => {
          this.pushUndo(); item.audioPath = file.path;
          owner.rebuild(); this.scheduleSave();
        }).open();
      }));
      if (item.audioPath) {
        menu.addItem(i => i.setTitle('Remove audio').setIcon('x').onClick(() => {
          this.pushUndo(); item.audioPath = undefined;
          owner.rebuild(); this.scheduleSave();
        }));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Add tag…').setIcon('tag').onClick(() => this.promptItemTag(owner, item)));
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Delete item').setIcon('trash').onClick(() => {
        this.pushUndo();
        removeItem();
        this.scheduleSave();
      }));
      menu.showAtMouseEvent(e);
    });
  },

  editKanbanItemInline(this: FreeformRenderer, owner: KanbanItemsOwner, item: KanbanItem, itemEl: HTMLElement): void {
    const textEl = itemEl.querySelector<HTMLElement>('.visual-notes-kanban-item-text');
    const bodyEl = itemEl.querySelector<HTMLElement>('.visual-notes-kanban-item-body');
    if (!textEl || !bodyEl || bodyEl.querySelector('.visual-notes-kanban-item-editor')) return;

    const removeItem = () => {
      const idx = owner.getItems().findIndex(i => i.id === item.id);
      if (idx !== -1) { const items = owner.getItems().slice(); items.splice(idx, 1); owner.setItems(items); }
      itemEl.remove();
      owner.updateCount();
    };

    const original = item.text;
    const seedHTML = textEl.innerHTML;
    textEl.hide();
    itemEl.addClass('is-editing');

    const editor = bodyEl.createDiv('visual-notes-kanban-item-editor') as HTMLElement;
    editor.contentEditable = 'true';
    editor.empty();
    if (item.text) editor.appendChild(sanitizeHTMLToDom(seedHTML));
    editor.addEventListener('pointerdown', e => e.stopPropagation());

    const fmtToolbar = new TextFormatToolbar(editor, itemEl, this.container);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      itemEl.removeClass('is-editing');
      fmtToolbar.destroy();
      const html = editor.innerHTML;
      editor.remove(); textEl.show();
      const isEmpty = !html || html === '<br>' || !html.trim();
      if (isEmpty) {
        this.pushUndo();
        removeItem();
        this.scheduleSave();
        return;
      }
      this.pushUndo();
      item.text = html;
      textEl.empty();
      MarkdownRenderer.render(this.app, html, textEl, '', this).catch(() => textEl.setText(html));
      this.scheduleSave();
    };

    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editor.blur(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        fmtToolbar.destroy();
        editor.removeEventListener('blur', commit);
        editor.remove(); textEl.show();
        itemEl.removeClass('is-editing');
        if (!original) {
          removeItem();
        } else {
          textEl.empty();
          MarkdownRenderer.render(this.app, original, textEl, '', this).catch(() => textEl.setText(original));
        }
      }
    });

    window.requestAnimationFrame(() => {
      editor.focus();
      const r = activeDocument.createRange();
      r.selectNodeContents(editor); r.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges(); s?.addRange(r);
    });
  },

  addItemToOwner(this: FreeformRenderer, owner: KanbanItemsOwner, itemsEl: HTMLElement): void {
    this.pushUndo();
    // A default name (rather than blank text) means the item survives if
    // you click "Add item" again without typing into this one first —
    // editKanbanItemInline treats an untouched blank item as abandoned and
    // deletes it on blur, which made repeated clicks only ever leave you
    // with the last item added. No auto-opened editor either, so clicking
    // "Add item" repeatedly just piles up "Item 1", "Item 2", … without
    // interruption — double-click any of them after to rename.
    const defaultName = `Item ${owner.getItems().length + 1}`;
    const item: KanbanItem = { id: crypto.randomUUID(), text: defaultName, done: false };
    owner.setItems([...owner.getItems(), item]);
    owner.updateCount();
    this.appendKanbanItem(itemsEl, owner, item);
    const newItemEl = itemsEl.lastElementChild as HTMLElement | null;
    newItemEl?.scrollIntoView({ block: 'nearest' });
  },

  promptItemTag(this: FreeformRenderer, owner: KanbanItemsOwner, item: KanbanItem): void {
    new TagInputModal(this.app, (tag) => {
      this.pushUndo();
      item.tags = [...(item.tags ?? []), tag];
      owner.rebuild();
      this.scheduleSave();
    }).open();
  },

  isContainerLocked(this: FreeformRenderer, cardId: string | undefined): boolean {
    if (!cardId) return false;
    const card = this.board.cards.find(c => c.id === cardId);
    return !!card && (card.kind === 'kanban-column' || card.kind === 'kanban-board' || card.kind === 'column') && !!card.locked;
  },

  appendLockButton(this: FreeformRenderer, 
    parent: HTMLElement, cardEl: HTMLElement,
    card: (KanbanColumnCard | KanbanBoardCard | ColumnCard),
  ): void {
    const btn = parent.createDiv('visual-notes-kanban-collapse-btn visual-notes-lock-btn');
    setIcon(btn, card.locked ? 'lock' : 'lock-open');
    btn.toggleClass('is-locked', !!card.locked);
    btn.setAttribute('aria-label', card.locked
      ? 'Unlock: allow dragging items in and out'
      : 'Lock: prevent dragging items in and out');
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      card.locked = card.locked ? undefined : true;
      this.renderCardContent(cardEl, card);
      this.scheduleSave();
    });
  },

  resolveKanbanItemsOwner(this: FreeformRenderer, itemsEl: HTMLElement): KanbanItemsOwner | null {
    const cardId = itemsEl.dataset.ownerCardId;
    const columnId = itemsEl.dataset.ownerColumnId;
    if (!cardId) return null;
    const card = this.board.cards.find(c => c.id === cardId);
    if (!card) return null;
    // Locked containers accept no incoming items (drops resolve to no owner).
    if ((card.kind === 'kanban-column' || card.kind === 'kanban-board') && card.locked) return null;

    if (card.kind === 'kanban-column' && !columnId) {
      return {
        ownerKey: card.id,
        getItems: () => card.items,
        setItems: (items) => { card.items = items; },
        rebuild: () => this.rebuildKanbanCard(card),
        updateCount: () => { const el = this.cardEls.get(card.id); if (el) this.updateKanbanCount(card, el); },
      };
    }
    if (card.kind === 'kanban-board' && columnId) {
      const column = card.columns.find(c => c.id === columnId);
      if (!column) return null;
      return {
        ownerKey: `${card.id}:${column.id}`,
        getItems: () => column.items,
        setItems: (items) => { column.items = items; },
        rebuild: () => this.rebuildKanbanCard(card),
        updateCount: () => this.updateKanbanBoardColumnCount(card, column),
      };
    }
    return null;
  },

  startItemDrag(this: FreeformRenderer, 
    startEvent: PointerEvent,
    sourceOwner: KanbanItemsOwner,
    item: KanbanItem,
    itemEl: HTMLElement,
  ): void {
    const itemRect = itemEl.getBoundingClientRect();

    // A real clone of the item's own rendered DOM — icon badge, thumbnail,
    // colors, tags, checkbox state and all — rather than a bare text
    // rectangle, so what's "lifted" actually looks like the card itself.
    // cloneNode never copies event listeners, so every control inside
    // (checkbox, delete button, audio player, link pills) is already inert
    // even before pointer-events gets disabled below.
    const ghost = itemEl.cloneNode(true) as HTMLElement;
    ghost.addClass('visual-notes-kanban-drag-ghost');
    ghost.style.width = `${itemRect.width}px`;
    ghost.style.left = `${itemRect.left}px`;
    ghost.style.top = `${itemRect.top}px`;
    ghost.addClass('visual-notes-no-pointer');
    activeDocument.body.appendChild(ghost);

    itemEl.addClass('is-dragging');

    let dropIndicator: HTMLElement | null = null;
    let targetOwner: KanbanItemsOwner | null = null;
    let insertBeforeItemId: string | null = null;
    let lastPointer = { x: startEvent.clientX, y: startEvent.clientY };

    const removeIndicator = () => { dropIndicator?.remove(); dropIndicator = null; };

    // Same lift/tilt "weight" feel as top-level card dragging, toned down
    // (smaller max angle, smaller lift, no counter-drift) to suit a small
    // list item rather than a full card — applied to the ghost, since
    // that's what actually tracks the pointer here (the real item element
    // just fades in place until drop).
    const intensity = this.cardDragAnimationEnabled ? this.cardDragAnimationIntensity * 0.5 : 0;
    let tiltVX = 0, tiltVY = 0;
    let lastMoveX = startEvent.clientX, lastMoveY = startEvent.clientY, lastMoveT = performance.now();
    let tiltRafId = 0;
    if (intensity > 0) {
      ghost.addClass('is-tilting');
      const tiltLoop = () => {
        tiltVX *= 0.88; tiltVY *= 0.88;
        const rot = Math.max(-4 * intensity, Math.min(4 * intensity, tiltVX * 0.01 * intensity));
        const liftScale = 1 + 0.02 * intensity;
        ghost.style.transform = `scale(${liftScale}) rotate(${rot.toFixed(2)}deg)`;
        tiltRafId = window.requestAnimationFrame(tiltLoop);
      };
      tiltRafId = window.requestAnimationFrame(tiltLoop);
    }

    const onMove = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      ghost.style.left = `${itemRect.left + (e.clientX - startEvent.clientX)}px`;
      ghost.style.top = `${itemRect.top + (e.clientY - startEvent.clientY)}px`;
      if (intensity > 0) {
        const now = performance.now();
        const dt = Math.max(1, now - lastMoveT);
        tiltVX = tiltVX * 0.7 + ((e.clientX - lastMoveX) / dt * 100) * 0.3;
        tiltVY = tiltVY * 0.7 + ((e.clientY - lastMoveY) / dt * 100) * 0.3;
        lastMoveX = e.clientX; lastMoveY = e.clientY; lastMoveT = now;
      }
      this.setTrashHover(e.clientX, e.clientY);
      removeIndicator();
      targetOwner = null;
      insertBeforeItemId = null;

      const els = activeDocument.elementsFromPoint(e.clientX, e.clientY);
      let tItemsEl: HTMLElement | null = null;
      for (const el of els) {
        const ie = (el as HTMLElement).closest<HTMLElement>('.visual-notes-kanban-items');
        if (ie) { tItemsEl = ie; break; }
      }
      if (!tItemsEl) return;
      const owner = this.resolveKanbanItemsOwner(tItemsEl);
      if (!owner) return;
      targetOwner = owner;

      const visItems = Array.from(tItemsEl.querySelectorAll<HTMLElement>('.visual-notes-kanban-item:not(.is-dragging)'));
      dropIndicator = createDiv();
      dropIndicator.className = 'visual-notes-kanban-drop-indicator';

      let placed = false;
      for (const vi of visItems) {
        const vr = vi.getBoundingClientRect();
        if (e.clientY < vr.top + vr.height / 2) {
          insertBeforeItemId = vi.dataset.itemId ?? null;
          tItemsEl.insertBefore(dropIndicator, vi);
          placed = true;
          break;
        }
      }
      if (!placed) {
        insertBeforeItemId = null;
        tItemsEl.appendChild(dropIndicator);
      }
    };

    const onUp = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      window.cancelAnimationFrame(tiltRafId);
      ghost.remove();
      removeIndicator();
      itemEl.removeClass('is-dragging');
      this.clearTrashHover();

      // Dropped on the trash zone: the item is simply gone, no eject.
      if (this.isOverTrash(lastPointer.x, lastPointer.y)) {
        this.pushUndo();
        const idx = sourceOwner.getItems().findIndex(i => i.id === item.id);
        if (idx !== -1) { const items = sourceOwner.getItems().slice(); items.splice(idx, 1); sourceOwner.setItems(items); }
        sourceOwner.rebuild();
        this.scheduleSave();
        return;
      }

      if (!targetOwner) {
        // Drop onto canvas: eject image or audio items back as canvas cards
        if (item.imagePath || item.audioPath) {
          const outerRect = this.outer.getBoundingClientRect();
          const overCanvas = lastPointer.x >= outerRect.left && lastPointer.x <= outerRect.right &&
                             lastPointer.y >= outerRect.top  && lastPointer.y <= outerRect.bottom;
          if (overCanvas) {
            const cp = screenToCanvas(lastPointer.x - outerRect.left, lastPointer.y - outerRect.top, this.vp);
            this.pushUndo();
            const idx = sourceOwner.getItems().findIndex(i => i.id === item.id);
            if (idx !== -1) { const items = sourceOwner.getItems().slice(); items.splice(idx, 1); sourceOwner.setItems(items); }
            sourceOwner.rebuild();
            if (item.imagePath) {
              const c: ImageCard = { id: crypto.randomUUID(), kind: 'image',
                x: this.applySnap(cp.x - IMAGE_DEFAULT_W / 2), y: this.applySnap(cp.y - IMAGE_DEFAULT_H / 2),
                w: IMAGE_DEFAULT_W, h: IMAGE_DEFAULT_H, z: this.nextZ(),
                source: { type: 'vault', path: item.imagePath } };
              this.board.cards.push(c); this.createCardEl(c);
              this.selection.select(c.id); this.refreshSelectionVisuals();
            } else if (item.audioPath) {
              const c: AudioCard = { id: crypto.randomUUID(), kind: 'audio',
                x: this.applySnap(cp.x - AUDIO_DEFAULT_W / 2), y: this.applySnap(cp.y - AUDIO_DEFAULT_H / 2),
                w: AUDIO_DEFAULT_W, h: AUDIO_DEFAULT_H, z: this.nextZ(),
                source: { type: 'vault', path: item.audioPath } };
              this.board.cards.push(c); this.createCardEl(c);
              this.selection.select(c.id); this.refreshSelectionVisuals();
            }
            this.scheduleSave();
          }
        }
        return;
      }
      this.pushUndo();

      const srcItems = sourceOwner.getItems().slice();
      const srcIdx = srcItems.findIndex(i => i.id === item.id);
      if (srcIdx !== -1) srcItems.splice(srcIdx, 1);
      sourceOwner.setItems(srcItems);

      const isSameOwner = targetOwner.ownerKey === sourceOwner.ownerKey;
      const destItems = isSameOwner ? srcItems : targetOwner.getItems().slice();
      const insertIdx = insertBeforeItemId ? destItems.findIndex(i => i.id === insertBeforeItemId) : -1;
      if (insertIdx !== -1) destItems.splice(insertIdx, 0, item);
      else destItems.push(item);
      targetOwner.setItems(destItems);

      sourceOwner.rebuild();
      if (!isSameOwner) targetOwner.rebuild();
      if (intensity > 0) this.settleKanbanItem(item.id);
      this.scheduleSave();
    };

    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
  },

  settleKanbanItem(this: FreeformRenderer, itemId: string): void {
    const el = this.inner.querySelector<HTMLElement>(`.visual-notes-kanban-item[data-item-id="${itemId}"]`);
    if (!el) return;
    el.addClass('is-item-settling');
    window.setTimeout(() => el.removeClass('is-item-settling'), 220);
  },

  async handleDroppedImageToKanban(this: FreeformRenderer, file: File, owner: KanbanItemsOwner, itemsEl: HTMLElement): Promise<void> {
    const ext = file.type.includes('png') ? 'png' : file.type.includes('gif') ? 'gif' : file.type.includes('webp') ? 'webp' : 'jpg';
    const base = file.name.replace(/\.[^.]+$/, '');
    let path: string;
    try { path = await saveNewAsset(this.app, await file.arrayBuffer(), `${base}.${ext}`); }
    catch { new Notice(`Failed to save ${file.name}.`); return; }
    this.addKanbanImageItem(path, owner, itemsEl);
  },

  addKanbanImageItem(this: FreeformRenderer, imagePath: string, owner: KanbanItemsOwner, itemsEl: HTMLElement): void {
    this.pushUndo();
    const item: KanbanItem = { id: crypto.randomUUID(), text: '', imagePath };
    owner.setItems([...owner.getItems(), item]);
    this.appendKanbanItem(itemsEl, owner, item);
    owner.updateCount();
    this.scheduleSave();
  },

  async handleDroppedAudioToKanban(this: FreeformRenderer, file: File, owner: KanbanItemsOwner, itemsEl: HTMLElement): Promise<void> {
    const ext = file.name.toLowerCase().endsWith('.mp3') ? 'mp3' : file.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'wav';
    const base = file.name.replace(/\.[^.]+$/, '');
    let path: string;
    try { path = await saveNewAsset(this.app, await file.arrayBuffer(), `${base}.${ext}`); }
    catch { new Notice(`Failed to save ${file.name}.`); return; }
    this.addKanbanAudioItem(path, owner, itemsEl);
  },

  addKanbanAudioItem(this: FreeformRenderer, audioPath: string, owner: KanbanItemsOwner, itemsEl: HTMLElement): void {
    this.pushUndo();
    const item: KanbanItem = { id: crypto.randomUUID(), text: '', audioPath };
    owner.setItems([...owner.getItems(), item]);
    this.appendKanbanItem(itemsEl, owner, item);
    owner.updateCount();
    this.scheduleSave();
  },
};
