// Marks the file-explorer row of .canvas files that are Visual Notes boards,
// so they can be told apart from Obsidian's own canvases at a glance. The
// styling itself lives in styles.css; this only decides which rows get the
// class.
//
// Obsidian shows both with the same icon and the same CANVAS tag, which is
// correct — they really are the same file type, and that is the point of
// building on the format rather than inventing one. The only thing that
// differs is the `vn` marker *inside* the file, so this cannot be done in
// CSS alone: each canvas has to be read before its row can be marked.
//
// There is no API for decorating explorer rows; every plugin that does this
// works against the explorer's DOM. That has two consequences the design
// here takes seriously:
//
//   - It must fail invisibly. If Obsidian's markup changes and no row ever
//     gets the class, the explorer looks exactly as it does today. Nothing
//     is removed or replaced, only a class added, so a broken decoration is
//     indistinguishable from the feature being switched off.
//   - It must not read the vault repeatedly. Results are cached per path and
//     invalidated by modification time, only rows actually rendered are
//     examined, and scans are debounced and never overlap.
import { App, TAbstractFile, TFile } from 'obsidian';
import { classifyCanvasFile } from './file-io';
import { SaveQueue } from './save-queue';

/** Marks a row as one of ours. Styled in styles.css; see --vn-explorer-board-tint. */
export const BOARD_ROW_CLASS = 'visual-notes-explorer-board';

// Long enough to collapse the burst of mutations that expanding a folder or
// scrolling a long list produces, short enough not to be noticed.
const SCAN_DEBOUNCE_MS = 120;

/**
 * Remembers which canvases are Visual Notes boards.
 *
 * Keyed by path and validated against the file's modification time, because
 * a canvas can stop being one of ours (or become one) through an edit made
 * anywhere — including Obsidian's own Canvas view rewriting it.
 */
export class BoardClassCache {
  private entries = new Map<string, { mtime: number; isBoard: boolean }>();

  /** The cached answer for this path at this mtime, or undefined if unknown or stale. */
  get(path: string, mtime: number): boolean | undefined {
    const hit = this.entries.get(path);
    if (!hit || hit.mtime !== mtime) return undefined;
    return hit.isBoard;
  }

  set(path: string, mtime: number, isBoard: boolean): void {
    this.entries.set(path, { mtime, isBoard });
  }

  forget(path: string): void {
    this.entries.delete(path);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class ExplorerDecorator {
  private readonly cache = new BoardClassCache();
  private readonly observers: MutationObserver[] = [];
  private queue: SaveQueue | null = null;
  private running = false;

  constructor(private readonly app: App) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.queue ??= new SaveQueue(
      () => this.scan(),
      // A decoration failing is not worth a Notice — the explorer simply
      // looks the way it did before the feature existed.
      (err) => { console.error('Visual Notes: could not decorate the file explorer', err); },
      SCAN_DEBOUNCE_MS,
    );
    this.observe();
    this.queue.schedule();
  }

  stop(): void {
    this.running = false;
    this.queue?.cancel();
    for (const o of this.observers) o.disconnect();
    this.observers.length = 0;
    this.undecorate();
    this.cache.clear();
  }

  /** Re-examines the explorer soon. Cheap to call as often as you like. */
  schedule(): void {
    if (this.running) this.queue?.schedule();
  }

  /** Drops what we knew about a path, so its row is re-examined. */
  forget(file: TAbstractFile): void {
    this.cache.forget(file.path);
    this.schedule();
  }

  // ── Internals ────────────────────────────────────────────────

  private explorerRoots(): HTMLElement[] {
    return this.app.workspace.getLeavesOfType('file-explorer')
      .map(leaf => (leaf.view as { containerEl?: HTMLElement }).containerEl)
      .filter((el): el is HTMLElement => !!el);
  }

  private observe(): void {
    for (const root of this.explorerRoots()) {
      // childList/subtree only: class changes are attribute mutations, so
      // our own decorating can't retrigger the observer.
      const obs = new MutationObserver(() => this.schedule());
      obs.observe(root, { childList: true, subtree: true });
      this.observers.push(obs);
    }
  }

  private rows(): Array<{ pathEl: HTMLElement; row: HTMLElement }> {
    const out: Array<{ pathEl: HTMLElement; row: HTMLElement }> = [];
    for (const root of this.explorerRoots()) {
      // `data-path` lived on .nav-file-title in older explorer markup, but
      // current Obsidian builds may put it on a nested/adjacent tree item.
      // Treat the path attribute as the stable part and decorate the nearest
      // visible row. Keeping pathEl separately lets us detect DOM recycling
      // after the asynchronous file classification below.
      for (const pathEl of Array.from(root.querySelectorAll<HTMLElement>('[data-path]'))) {
        const path = pathEl.getAttribute('data-path');
        if (!path?.toLowerCase().endsWith('.canvas')) continue;
        const row = pathEl.matches('.nav-file-title, .tree-item-self')
          ? pathEl
          : pathEl.closest<HTMLElement>('.nav-file-title, .tree-item-self') ?? pathEl;
        if (!out.some(hit => hit.row === row)) out.push({ pathEl, row });
      }
    }
    return out;
  }

  private async scan(): Promise<void> {
    if (!this.running) return;
    // A leaf can appear after start() — a re-opened sidebar, a new window —
    // so pick up any explorer we aren't watching yet.
    if (this.observers.length < this.explorerRoots().length) {
      for (const o of this.observers) o.disconnect();
      this.observers.length = 0;
      this.observe();
    }

    for (const { pathEl, row } of this.rows()) {
      const path = pathEl.getAttribute('data-path');
      if (!path) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const mtime = file.stat.mtime;
      let isBoard = this.cache.get(path, mtime);
      if (isBoard === undefined) {
        isBoard = (await classifyCanvasFile(this.app, file)) === 'ours';
        this.cache.set(path, mtime, isBoard);
      }
      // Re-checked because an await gives the explorer time to recycle the
      // row out from under us.
      if (!row.isConnected || pathEl.getAttribute('data-path') !== path) continue;
      row.toggleClass(BOARD_ROW_CLASS, isBoard);
    }
  }

  private undecorate(): void {
    for (const root of this.explorerRoots()) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${BOARD_ROW_CLASS}`))) {
        el.removeClass(BOARD_ROW_CLASS);
      }
    }
  }
}
