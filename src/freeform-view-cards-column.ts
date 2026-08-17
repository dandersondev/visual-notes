import {
  setIcon,
} from 'obsidian';
import {
  Card, ColumnCard, ColumnChildCard,
} from './file-types';
import {
  parseYouTubeId,
} from './thumbnail-utils';
import {
  screenToCanvas,
} from './canvas/pan-zoom';
import {
  TILE_DEFAULT_W, TILE_DEFAULT_H,
  COLUMN_DEFAULT_W, COLUMN_DEFAULT_H,
  DRAG_THRESHOLD,
  openExternalUrl,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    addColumnCard(): void;
    addColumnCardAt(x: number, y: number): void;
    renderColumnContent(el: HTMLElement, card: ColumnCard): void;
    editColumnTitle(card: ColumnCard, titleEl: HTMLElement): void;
    renderColumnChild(stackEl: HTMLElement, column: ColumnCard, child: ColumnChildCard): void;
    rebuildColumnChild(column: ColumnCard, child: ColumnChildCard): void;
    bindColumnChildEvents(childEl: HTMLElement, column: ColumnCard, child: ColumnChildCard): void;
    startColumnChildDrag(
        startEvent: PointerEvent,
        sourceColumn: ColumnCard,
        child: ColumnChildCard,
        childEl: HTMLElement,
      ): void;
    settleColumnChild(columnId: string, childId: string): void;
  }
}

export const cardsColumnMethods = {
  addColumnCard(this: FreeformRenderer): void {
    const p = this.centerPos(COLUMN_DEFAULT_W, COLUMN_DEFAULT_H);
    this.addColumnCardAt(p.x, p.y);
  },

  addColumnCardAt(this: FreeformRenderer, x: number, y: number): void {
    const card: ColumnCard = {
      id: crypto.randomUUID(), kind: 'column',
      x, y, w: COLUMN_DEFAULT_W, h: COLUMN_DEFAULT_H, z: this.nextZ(),
      children: [],
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  renderColumnContent(this: FreeformRenderer, el: HTMLElement, card: ColumnCard): void {
    el.addClass('visual-notes-freeform-column-card');
    if (card.bgColor) el.style.backgroundColor = card.bgColor;
    if (card.borderColor) el.style.borderColor = card.borderColor;

    const header = el.createDiv('visual-notes-column-header');

    let titleEl: HTMLElement | null = null;
    if (!card.titleHidden) {
      titleEl = header.createDiv('visual-notes-column-title');
      if (card.color) titleEl.style.color = card.color;
      if (card.title) titleEl.setText(card.title);
      else { titleEl.addClass('visual-notes-kanban-title-empty'); titleEl.setText('Untitled column'); }
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (titleEl) this.editColumnTitle(card, titleEl);
      });
    }
    // Fallback so double-clicking anywhere else in the header (not just the
    // title text — handy for the small, dim "Untitled column" placeholder)
    // still opens the rename input. titleEl's own listener above already
    // stops propagation for a direct hit, so this never double-fires.
    header.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.visual-notes-kanban-collapse-btn')) return;
      e.stopPropagation();
      if (titleEl) this.editColumnTitle(card, titleEl);
    });

    header.createSpan({ cls: 'visual-notes-column-count', text: `${card.children.length}` });

    this.appendLockButton(header, el, card);

    // "…" menu — a reliable, discoverable way to rename (alongside the
    // dblclick-anywhere-in-header fallback above), matching the kanban
    // board's per-column "…" menu.
    const menuBtn = header.createDiv('visual-notes-kanban-collapse-btn visual-notes-kanban-column-menu-btn');
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', 'Column options');
    menuBtn.addEventListener('pointerdown', e => e.stopPropagation());
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = this.newMenu();
      if (titleEl) {
        menu.addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => {
          if (titleEl) this.editColumnTitle(card, titleEl);
        }));
      }
      menu.showAtMouseEvent(e);
    });

    const collapseBtn = header.createDiv('visual-notes-kanban-collapse-btn');
    setIcon(collapseBtn, 'chevron-down');
    collapseBtn.addEventListener('pointerdown', e => e.stopPropagation());
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pushUndo();
      card.collapsed = !card.collapsed;
      el.toggleClass('is-collapsed', !!card.collapsed);
      this.scheduleSave();
    });
    if (card.collapsed) el.addClass('is-collapsed');

    const stackEl = el.createDiv('visual-notes-column-stack');
    stackEl.dataset.columnId = card.id;
    if (card.trayColor) stackEl.style.backgroundColor = card.trayColor;
    for (const child of card.children) this.renderColumnChild(stackEl, card, child);

    this.appendResizeHandles(el);
  },

  editColumnTitle(this: FreeformRenderer, card: ColumnCard, titleEl: HTMLElement): void {
    if (titleEl.querySelector('input')) return;
    const original = card.title ?? '';
    titleEl.empty();
    const input = titleEl.createEl('input');
    input.type = 'text'; input.value = original;
    input.addClass('visual-notes-kanban-title-input');

    let cancelled = false;
    const restore = (text: string | undefined) => {
      titleEl.empty();
      if (card.color) titleEl.style.color = card.color;
      if (text) { titleEl.removeClass('visual-notes-kanban-title-empty'); titleEl.setText(text); }
      else { titleEl.addClass('visual-notes-kanban-title-empty'); titleEl.setText('Untitled column'); }
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

  renderColumnChild(this: FreeformRenderer, stackEl: HTMLElement, column: ColumnCard, child: ColumnChildCard): void {
    const childEl = stackEl.createDiv('visual-notes-column-child');
    childEl.dataset.childId = child.id;
    // Kept as an inline style (not a CSS class) deliberately — startColumnChildDrag's
    // ghost clone relies on an inline `position` always beating the CSS class's
    // `position: fixed`, so this can't move into the stylesheet without breaking that.
    childEl.setCssStyles({ position: 'relative' });
    // Every child kind, tiles included, fills the tray's width — align-items:
    // stretch on the stack handles this automatically as long as no explicit
    // width is set here, matching the backdrop box the tile now renders with.
    if (child.kind !== 'sticky' || child.blank) {
      childEl.style.height = `${child.h ?? TILE_DEFAULT_H}px`;
    }
    this.renderCardContent(childEl, child);
    this.bindColumnChildEvents(childEl, column, child);
  },

  rebuildColumnChild(this: FreeformRenderer, column: ColumnCard, child: ColumnChildCard): void {
    const columnEl = this.cardEls.get(column.id);
    const oldChildEl = columnEl?.querySelector<HTMLElement>(`.visual-notes-column-child[data-child-id="${child.id}"]`);
    if (!oldChildEl) return;
    const stackEl = oldChildEl.parentElement as HTMLElement;
    const next = oldChildEl.nextElementSibling;
    oldChildEl.remove();
    const tmp = stackEl.createDiv();
    this.renderColumnChild(stackEl, column, child);
    const newChildEl = stackEl.lastElementChild as HTMLElement;
    tmp.remove();
    if (next) stackEl.insertBefore(newChildEl, next);
  },

  bindColumnChildEvents(this: FreeformRenderer, childEl: HTMLElement, column: ColumnCard, child: ColumnChildCard): void {
    childEl.addEventListener('dblclick', (e) => { void (async () => {
      if (this.penModeActive) return;
      e.stopPropagation();
      const target = e.target as HTMLElement;
      switch (child.kind) {
        case 'tile':      await this.activateTile(child); break;
        case 'sticky':    this.editStickyInline(childEl, child); break;
        case 'note-link': await this.activateNoteLink(child); break;
        case 'image':
          if (target.closest('.visual-notes-image-caption-wrap')) break;
          this.openImageSource(child); break;
        case 'bookmark':  if (!parseYouTubeId(child.url)) openExternalUrl(child.url); break;
      }
    })(); });

    childEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const menu = this.newMenu();
      menu.addItem(i => i.setTitle('Extract to canvas').setIcon('arrow-up-right').onClick(() => {
        this.pushUndo();
        column.children = column.children.filter(c => c.id !== child.id);
        // Land next to the child's own row in the tray rather than always
        // the fixed viewport center — extracting several children in a row
        // used to stack every one of them on the exact same spot.
        const rect = childEl.getBoundingClientRect();
        const outerRect = this.outer.getBoundingClientRect();
        const cp = screenToCanvas(rect.right - outerRect.left + 24, rect.top - outerRect.top, this.vp);
        const newCard = { ...child, x: this.applySnap(cp.x), y: this.applySnap(cp.y), z: this.nextZ() } as Card;
        this.board.cards.push(newCard);
        this.rebuildKanbanCard(column);
        this.createCardEl(newCard);
        this.selection.select(newCard.id);
        this.refreshSelectionVisuals();
        this.scheduleSave();
      }));
      menu.addSeparator();
      if (child.nestedBoardPath) {
        menu.addItem(i => i.setTitle('Open nested board').setIcon('layout-template').onClick(() => {
          this.openNestedBoard(child.nestedBoardPath!, (p) => { child.nestedBoardPath = p; }, child.nestedBoardRoomId, (id) => { child.nestedBoardRoomId = id; });
        }));
        menu.addItem(i => i.setTitle('Unlink nested board').setIcon('unlink').onClick(() => {
          this.pushUndo();
          child.nestedBoardPath = undefined; child.nestedBoardIcon = undefined; child.nestedBoardRoomId = undefined;
          this.rebuildColumnChild(column, child);
          this.scheduleSave();
        }));
      } else {
        menu.addItem(i => i.setTitle('Create nested board…').setIcon('layout-template').onClick(() => {
          this.createNestedBoardFrom(this.cardDisplayName(child), (path, icon, roomId) => {
            this.pushUndo();
            child.nestedBoardPath = path; child.nestedBoardIcon = icon; child.nestedBoardRoomId = roomId;
            this.rebuildColumnChild(column, child);
          });
        }));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Remove from column').setIcon('trash').onClick(() => {
        this.pushUndo();
        column.children = column.children.filter(c => c.id !== child.id);
        this.rebuildKanbanCard(column);
        this.scheduleSave();
      }));
      menu.showAtMouseEvent(e);
    });

    childEl.addEventListener('pointerdown', (e) => {
      if (this.penModeActive) {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        this.startInkStroke(e);
        return;
      }
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"], button, a, audio, .visual-notes-checklist-cb')) return;
      e.stopPropagation();

      // Locked column: children stay put — no drag ever starts.
      if (column.locked) return;

      let wasDragged = false;
      const sx = e.clientX, sy = e.clientY;
      const startE = e;

      const onMove = (e2: PointerEvent) => {
        if (!wasDragged && Math.hypot(e2.clientX - sx, e2.clientY - sy) > DRAG_THRESHOLD) {
          wasDragged = true;
          activeDocument.removeEventListener('pointermove', onMove);
          activeDocument.removeEventListener('pointerup', onUp);
          this.startColumnChildDrag(startE, column, child, childEl);
        }
      };
      const onUp = () => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
      };
      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });
  },

  startColumnChildDrag(this: FreeformRenderer, 
    startEvent: PointerEvent,
    sourceColumn: ColumnCard,
    child: ColumnChildCard,
    childEl: HTMLElement,
  ): void {
    const rect = childEl.getBoundingClientRect();

    // A real clone of the child's own rendered DOM, same as startItemDrag's
    // kanban-item ghost, so what's "lifted" looks like the actual card
    // rather than a flat placeholder box. cloneNode never copies event
    // listeners, so nothing inside it is interactive.
    const ghost = childEl.cloneNode(true) as HTMLElement;
    ghost.addClass('visual-notes-column-drag-ghost');
    // childEl carries an inline `position: relative` (set in
    // renderColumnChild, to contain absolutely-positioned descendants like
    // an image's caption) which cloneNode copies verbatim — and an inline
    // style always wins over the CSS class's `position: fixed` below,
    // silently breaking the ghost's viewport-fixed positioning. Override it
    // explicitly rather than relying on the stylesheet.
    ghost.setCssStyles({ position: 'fixed', width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    ghost.addClass('visual-notes-no-pointer');
    activeDocument.body.appendChild(ghost);
    childEl.addClass('is-dragging');

    // Same lift/tilt "weight" feel as kanban item dragging — toned down to
    // match startItemDrag's own 0.5x kanban intensity, since this is a
    // small stacked item rather than a full free-floating card.
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

    let dropIndicator: HTMLElement | null = null;
    let targetStackEl: HTMLElement | null = null;
    let insertBeforeChildId: string | null = null;
    let lastPointer = { x: startEvent.clientX, y: startEvent.clientY };

    const removeIndicator = () => { dropIndicator?.remove(); dropIndicator = null; };

    const onMove = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      ghost.style.left = `${rect.left + (e.clientX - startEvent.clientX)}px`;
      ghost.style.top = `${rect.top + (e.clientY - startEvent.clientY)}px`;
      if (intensity > 0) {
        const now = performance.now();
        const dt = Math.max(1, now - lastMoveT);
        tiltVX = tiltVX * 0.7 + ((e.clientX - lastMoveX) / dt * 100) * 0.3;
        tiltVY = tiltVY * 0.7 + ((e.clientY - lastMoveY) / dt * 100) * 0.3;
        lastMoveX = e.clientX; lastMoveY = e.clientY; lastMoveT = now;
      }
      this.setTrashHover(e.clientX, e.clientY);
      removeIndicator();
      targetStackEl = null; insertBeforeChildId = null;

      const els = activeDocument.elementsFromPoint(e.clientX, e.clientY);
      let foundStackEl: HTMLElement | null = null;
      for (const elx of els) {
        const se = (elx as HTMLElement).closest<HTMLElement>('.visual-notes-column-stack');
        if (se) { foundStackEl = se; break; }
      }
      // A locked column shows no drop indicator and takes no drop — the
      // child ejects onto the canvas instead, same as missing every column.
      if (!foundStackEl || this.isContainerLocked(foundStackEl.dataset.columnId)) return;
      targetStackEl = foundStackEl;

      const visChildren = Array.from(foundStackEl.querySelectorAll<HTMLElement>('.visual-notes-column-child:not(.is-dragging)'));
      dropIndicator = createDiv();
      dropIndicator.className = 'visual-notes-column-drop-indicator';
      let placed = false;
      for (const vc of visChildren) {
        const vr = vc.getBoundingClientRect();
        if (e.clientY < vr.top + vr.height / 2) {
          insertBeforeChildId = vc.dataset.childId ?? null;
          foundStackEl.insertBefore(dropIndicator, vc);
          placed = true; break;
        }
      }
      if (!placed) { insertBeforeChildId = null; foundStackEl.appendChild(dropIndicator); }
    };

    const onUp = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      window.cancelAnimationFrame(tiltRafId);
      ghost.remove();
      removeIndicator();
      childEl.removeClass('is-dragging');
      this.clearTrashHover();
      this.pushUndo();

      // Dropped on the trash zone: remove from the column outright rather
      // than ejecting back onto the canvas.
      if (this.isOverTrash(lastPointer.x, lastPointer.y)) {
        sourceColumn.children = sourceColumn.children.filter(c => c.id !== child.id);
        this.rebuildKanbanCard(sourceColumn);
        this.scheduleSave();
        return;
      }

      if (!targetStackEl) {
        const outerRect = this.outer.getBoundingClientRect();
        const overCanvas = lastPointer.x >= outerRect.left && lastPointer.x <= outerRect.right &&
                           lastPointer.y >= outerRect.top && lastPointer.y <= outerRect.bottom;
        if (!overCanvas) return;
        sourceColumn.children = sourceColumn.children.filter(c => c.id !== child.id);
        const cp = screenToCanvas(lastPointer.x - outerRect.left, lastPointer.y - outerRect.top, this.vp);
        const w = child.w ?? TILE_DEFAULT_W, h = child.h ?? TILE_DEFAULT_H;
        const newCard = { ...child, x: this.applySnap(cp.x - w / 2), y: this.applySnap(cp.y - h / 2), z: this.nextZ() } as Card;
        this.board.cards.push(newCard);
        this.rebuildKanbanCard(sourceColumn);
        this.createCardEl(newCard);
        this.selection.select(newCard.id);
        this.refreshSelectionVisuals();
        this.scheduleSave();
        return;
      }

      const targetColumnId = targetStackEl.dataset.columnId;
      const targetColumn = this.board.cards.find(c => c.id === targetColumnId && c.kind === 'column') as ColumnCard | undefined;
      if (!targetColumn) return;

      sourceColumn.children = sourceColumn.children.filter(c => c.id !== child.id);
      const destChildren = sourceColumn === targetColumn ? sourceColumn.children : targetColumn.children;
      const insertIdx = insertBeforeChildId ? destChildren.findIndex(c => c.id === insertBeforeChildId) : -1;
      if (insertIdx !== -1) destChildren.splice(insertIdx, 0, child);
      else destChildren.push(child);

      this.rebuildKanbanCard(sourceColumn);
      if (targetColumn !== sourceColumn) this.rebuildKanbanCard(targetColumn);
      if (intensity > 0) this.settleColumnChild(targetColumn.id, child.id);
      this.scheduleSave();
    };

    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
  },

  settleColumnChild(this: FreeformRenderer, columnId: string, childId: string): void {
    const columnEl = this.cardEls.get(columnId);
    const el = columnEl?.querySelector<HTMLElement>(`.visual-notes-column-child[data-child-id="${childId}"]`);
    if (!el) return;
    el.addClass('is-child-settling');
    window.setTimeout(() => el.removeClass('is-child-settling'), 220);
  },
};
