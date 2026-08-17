import {
  Notice,
} from 'obsidian';
import {
  VisualNotesFile,
} from './file-types';
import {
  MAX_UNDO,
  ArchiveModal,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    undoSnapshot(): string;
    applyUndoSnapshot(json: string): void;
    pushUndo(): void;
    undo(): void;
    redo(): void;
    rebuildCards(): void;
    archiveSelected(): void;
    openArchiveBrowser(): void;
    scheduleSave(): void;
    saveNow(): Promise<void>;
  }
}

export const persistenceMethods = {
  undoSnapshot(this: FreeformRenderer): string {
    return JSON.stringify({
      cards: this.board.cards, connections: this.board.connections, archived: this.board.archived,
      drawings: this.board.drawings,
    });
  },

  applyUndoSnapshot(this: FreeformRenderer, json: string): void {
    const snap = JSON.parse(json) as {
      cards: VisualNotesFile['cards']; connections: VisualNotesFile['connections']; archived?: VisualNotesFile['archived'];
      drawings?: VisualNotesFile['drawings'];
    };
    this.board.cards = snap.cards;
    this.board.connections = snap.connections ?? [];
    // JSON.stringify omits undefined optional fields. Assigning the missing
    // value back would create an own `archived: undefined` property, which is
    // not JSON-safe and caused collaboration diffing to throw during undo.
    if (snap.archived === undefined) delete this.board.archived;
    else this.board.archived = snap.archived;
    // Older in-memory snapshots (pushed before drawings were included here)
    // won't have this key — falling back to the current drawings rather
    // than wiping them out is safer than an undefined->[] wipe mid-session.
    this.board.drawings = snap.drawings ?? this.board.drawings;
    this.scheduleSave(); this.rebuildCards();
  },

  pushUndo(this: FreeformRenderer): void {
    this.undoStack.push(this.undoSnapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.refreshUndoRedoButtons();
  },

  undo(this: FreeformRenderer): void {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.undoSnapshot());
    this.applyUndoSnapshot(this.undoStack.pop()!);
    this.refreshUndoRedoButtons();
  },

  redo(this: FreeformRenderer): void {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.undoSnapshot());
    this.applyUndoSnapshot(this.redoStack.pop()!);
    this.refreshUndoRedoButtons();
  },

  rebuildCards(this: FreeformRenderer): void {
    this.exitConnectMode();
    this.deselectDrawing();
    this.inner.empty(); this.cardEls.clear(); this.connectionPaths.clear(); this.selection.clear();
    this.inkPaths.clear(); this.inkHitPaths.clear();
    this.initConnectionLayer();
    for (const card of this.board.cards) this.createCardEl(card);
    this.refreshAllConnections();
    // inner.empty() also tore down the ink SVG layer — rebuild it and
    // re-render from this.board.drawings, which undo/redo snapshots and
    // restores right alongside cards/connections.
    this.initInkLayer();
    this.renderAllDrawings();
  },

  archiveSelected(this: FreeformRenderer): void {
    const ids = new Set(this.selection.getIds());
    if (ids.size === 0) return;
    this.pushUndo();
    const toArchive = this.board.cards.filter(c => ids.has(c.id));
    this.board.cards = this.board.cards.filter(c => !ids.has(c.id));
    (this.board.archived ??= []).push(...toArchive);
    // Connections to an archived card can't survive (both ends must be
    // live canvas nodes); dropping them is undoable along with the archive.
    this.board.connections = this.board.connections.filter(c =>
      !(c.fromCardId && ids.has(c.fromCardId)) && !(c.toCardId && ids.has(c.toCardId)));
    for (const id of ids) { this.cardEls.get(id)?.remove(); this.cardEls.delete(id); this.disposeCardResources(id); }
    this.selection.clear();
    this.refreshSelectionVisuals();
    this.refreshAllConnections();
    this.scheduleSave();
    new Notice(`Archived ${toArchive.length} card${toArchive.length === 1 ? '' : 's'}.`);
  },

  openArchiveBrowser(this: FreeformRenderer): void {
    new ArchiveModal(
      this.app,
      () => this.board.archived ?? [],
      (c) => this.cardDisplayName(c),
      (c) => {
        this.pushUndo();
        this.board.archived = (this.board.archived ?? []).filter(a => a.id !== c.id);
        this.board.cards.push(c);
        this.createCardEl(c);
        this.selection.select(c.id);
        this.refreshSelectionVisuals();
        this.centerOnCard(c.id);
        this.scheduleSave();
      },
      (c) => {
        this.pushUndo();
        this.board.archived = (this.board.archived ?? []).filter(a => a.id !== c.id);
        this.scheduleSave();
      },
    ).open();
  },

  scheduleSave(this: FreeformRenderer): void {
    this.board.viewport = { ...this.vp };
    // Minimap redraw and filter re-scan are real work on a large board (full
    // dot teardown/rebuild, full card rescan) — coalesce bursts of edits
    // (e.g. dragging several cards, rapid typing) into one refresh shortly
    // after they settle, rather than repeating the work on every single call.
    if (this.minimapFilterTimer) window.clearTimeout(this.minimapFilterTimer);
    this.minimapFilterTimer = window.setTimeout(() => {
      this.minimapFilterTimer = null;
      if (this.minimapOpen) this.updateMinimapCards();
      // Card edits rebuild elements, wiping dim classes — reapply.
      if (this.activeFilters.size) this.applyFilters();
      // Calendar cards mirror dates owned by other cards — keep them
      // current after any edit settles.
      this.refreshPassiveDataViews();
    }, 200);
    this.scheduleCollaborationSync();
    this.saveQueue.schedule();
  },

  // Debouncing/serialization/failure-handling all live in SaveQueue (see
  // save-queue.ts, and its own tests) — this just keeps the board's
  // viewport current before handing off to it, same as scheduleSave above.
  async saveNow(this: FreeformRenderer): Promise<void> {
    this.board.viewport = { ...this.vp };
    await this.flushCollaborationSync();
    await this.saveQueue.flush();
  },
};
