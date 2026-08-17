import { FileView, WorkspaceLeaf, TFile, Notice, setIcon } from 'obsidian';
import type VisualNotesPlugin from './main';
import { Card, VisualNotesFile } from './file-types';
import { readBoardFile, writeBoardFile, classifyCanvasFile, NATIVE_BAK_SUFFIX } from './file-io';
import { GridRenderer } from './grid-view';
import { FreeformRenderer } from './freeform-view';
import type { FreeformCollaborationConfig } from './freeform-view';
import { DEFAULT_PEN_DRAW_OPTIONS } from './pen-options-panel';
import { ensureCollaborationIdentity } from './collaboration-identity';
import { relinkBoardData } from './asset-manager';
import { CreateBoardModal } from './create-board-modal';
import { findBoardPathForRoom, loadBoardRoom, saveBoardRoom } from './collaboration-rooms';

// Obsidian core's own view type string for its native Canvas view.
export const NATIVE_CANVAS_VIEW_TYPE = 'canvas';

export const VISUAL_NOTES_VIEW_TYPE = 'visual-notes-view';

export class VisualNotesView extends FileView {
  plugin: VisualNotesPlugin;

  // Navigation history: files visited before the current one.
  // Empty = this is the entry point.
  private navigationHistory: TFile[] = [];

  // Flag to distinguish internal navigation from an external file open.
  private isInternalNavigation = false;

  private renderer: GridRenderer | FreeformRenderer | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VisualNotesPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  // A FileView can be open without a file (e.g. workspace restore with no state).
  override allowNoFile = true;

  getViewType(): string { return VISUAL_NOTES_VIEW_TYPE; }

  override getDisplayText(): string {
    return this.file ? this.file.basename : 'Visual Notes';
  }

  override getIcon(): string { return 'layout-grid'; }

  // Obsidian calls this when it assigns a file to the view.
  override async onLoadFile(file: TFile): Promise<void> {
    // .canvas is a shared extension: Visual Notes registers a view for it so
    // its own boards open richly, but plenty of .canvas files in a vault
    // will be plain native canvases (or another plugin's) that just happen
    // to share the extension. Never render those with Visual Notes' UI —
    // hand the leaf straight back to Obsidian's real native Canvas view
    // instead.
    // Only a file that reads cleanly AND isn't ours goes to native Canvas.
    // A file we couldn't read falls through to readBoardFile instead, which
    // backs it up, says so, and returns a board that can never be written
    // back — because native Canvas rewrites whatever it's given, so handing
    // it an unparsed board is how a bad read becomes permanent damage.
    if (file.extension === 'canvas' && (await classifyCanvasFile(this.app, file)) === 'foreign') {
      await this.leaf.setViewState({ type: NATIVE_CANVAS_VIEW_TYPE, state: { file: file.path } });
      return;
    }

    if (!this.isInternalNavigation) {
      // Opened externally (ribbon, file explorer, workspace restore) — reset history.
      this.navigationHistory = [];
    }
    this.isInternalNavigation = false;

    const board = await readBoardFile(this.app, file);

    // Native Canvas stripped this board's root metadata at some point. The
    // cards survived on their nodes, so writing it back out immediately
    // restores the root block — without which the board would be treated as
    // a plain native canvas on every future open. Layout and card data are
    // recovered; anything that lived only at the root (viewport, free
    // drawings, the archive) was already gone by the time we read it, hence
    // pointing at the backup rather than claiming a clean fix.
    if (board.recoveredFromNativeEdit) {
      await writeBoardFile(this.app, file, board);
      new Notice(
        `Visual Notes: "${file.basename}" had been rewritten by Obsidian's native Canvas, which drops ` +
        `Visual Notes' board metadata. The cards have been recovered. Free-floating drawings and any ` +
        `archived cards could not be — they're in "${file.name}${NATIVE_BAK_SUFFIX}" if you need them.`,
        15000
      );
    }

    if (this.plugin.settings.autoRelinkOnOpen) {
      const fixed = relinkBoardData(this.app, board);
      if (fixed > 0) {
        await writeBoardFile(this.app, file, board);
        new Notice(`Visual Notes: Fixed ${fixed} broken link${fixed === 1 ? '' : 's'}.`);
      }
    }

    await this.renderBoard(board, file);
  }

  override async onUnloadFile(_file: TFile): Promise<void> {
    await this.destroyRenderer();
  }

  override async onClose(): Promise<void> {
    await this.destroyRenderer();
  }

  // Called when there is no file (e.g. workspace restore with missing state).
  //
  // Deliberately not `async`. Nothing here awaits, but the signature is
  // Obsidian's rather than ours — View declares onOpen(): Promise<void> — so
  // returning an already-resolved promise satisfies it without needing a
  // lint suppression. 1.1.3 used `async` plus an eslint-disable for
  // require-await instead, and Obsidian's plugin check rejected that
  // outright: its config requires every disable directive to carry an inline
  // `-- reason` description, and a plain one is a hard error. Avoiding the
  // directive altogether is simpler than describing it.
  protected override onOpen(): Promise<void> {
    if (!this.file) {
      this.renderEmpty();
    }
    return Promise.resolve();
  }


  /**
   * Collaboration is opt-in and experimental; it must never be able to stop a
   * board opening. It could: these options are built eagerly, and a device
   * with collaboration switched on but no server secret -- every mobile device
   * before its first join, since mobile cannot host -- threw here and took the
   * whole board down with it. usesWebSocketCollaboration() no longer lies
   * about being ready, and this catch means the next thing that goes wrong
   * costs the collaboration bar rather than the board.
   */
  private collaborationOptions(file: TFile): FreeformCollaborationConfig | undefined {
    try {
      return this.buildCollaborationOptions(file);
    } catch (error) {
      console.error('Visual Notes: collaboration could not start for this board.', error);
      new Notice(
        'Visual Notes: collaboration could not start, so this board opened without it. '
        + (error instanceof Error ? error.message : 'Unknown error'),
        10000,
      );
      return undefined;
    }
  }

  private buildCollaborationOptions(file: TFile): FreeformCollaborationConfig {
    const websocket = this.plugin.usesWebSocketCollaboration();
    const room = websocket ? loadBoardRoom(window.localStorage, this.app.vault.getName(), file.path) : undefined;
    const assetClient = websocket ? this.plugin.createCollaborationAssetClient() : undefined;
    return {
      transport: this.plugin.getCollaborationTransport(room),
      identity: ensureCollaborationIdentity(
        this.plugin.settings, undefined, window.localStorage, this.app.vault.getName()
      ).identity,
      // Driven by what the session actually is, not by what the setting asks
      // for. A device with collaboration on but no secret yet falls back to a
      // local session, and labelling that "Private network" told the user they
      // were connected to something they were not.
      label: !websocket ? 'Local session'
        : this.plugin.settings.collaborationTransport === 'private-network' ? 'Private network'
        : 'Development server',
      room,
      // Everything below is a lazy callback, invoked long after this object is
      // built, and each re-reads plugin state when it runs. Gating them on
      // `websocket` -- a snapshot of whether a live session was possible at
      // render time -- was wrong, and specifically broke the one flow that
      // exists to CHANGE that state: joining. A device with no server secret
      // got joinRoom: undefined, and since the bar calls it optionally
      // (`config.joinRoom?.(code)`), pasting an invitation did nothing at all,
      // silently. That is every phone and tablet, which cannot host and so
      // have no secret until an invitation gives them one.
      //
      // `websocket` now decides only the three eager values above: the initial
      // transport, room, and asset client.
      transportForRoom: (nextRoom) => this.plugin.getCollaborationTransport(nextRoom),
      createRoom: (initialBoard) => this.plugin.createCollaborationRoom(initialBoard),
      joinRoom: (inviteCode) => this.plugin.resolveCollaborationRoom(inviteCode),
      saveRoom: (nextRoom) => {
        saveBoardRoom(window.localStorage, this.app.vault.getName(), file.path, nextRoom);
        return Promise.resolve();
      },
      listMembers: (activeRoom) => this.plugin.listCollaborationRoomMembers(activeRoom),
      getRoomStorage: (activeRoom) => this.plugin.getCollaborationRoomStorage(activeRoom),
      getRoomTree: (activeRoom) => this.plugin.getCollaborationRoomTree(activeRoom),
      cleanupRoomAssets: (activeRoom) => this.plugin.cleanupCollaborationRoomAssets(activeRoom),
      exportRoom: (activeRoom) => this.plugin.exportCollaborationRoom(activeRoom),
      deleteRoom: (activeRoom) => this.plugin.deleteCollaborationRoom(activeRoom),
      createChildRoom: (parentRoom, childKey, childBoard) => this.plugin.createCollaborationChildRoom(parentRoom, childKey, childBoard),
      openChildRoom: (parentRoom, childRoomId) => this.plugin.openCollaborationChildRoom(parentRoom, childRoomId),
      saveChildRoom: (boardPath, childRoom) => {
        saveBoardRoom(window.localStorage, this.app.vault.getName(), boardPath, childRoom);
        return Promise.resolve();
      },
      findBoardPathForRoom: (roomId) =>
        findBoardPathForRoom(window.localStorage, this.app.vault.getName(), roomId),
      rotateInvite: (activeRoom, role) => this.plugin.rotateCollaborationRoomInvite(activeRoom, role),
      removeMember: (activeRoom, clientId) => this.plugin.removeCollaborationRoomMember(activeRoom, clientId),
      formatInvite: (inviteCode) => this.plugin.formatCollaborationInvite(inviteCode),
      assetClientForRoom: () => this.plugin.createCollaborationAssetClient(),
      assetClient,
    };
  }

  // ── Public navigation API (called by GridRenderer) ───────────

  async navigateToBoard(targetPath: string): Promise<void> {
    // A tile pointing at the very board it lives on used to "navigate" to
    // itself: the same board re-rendered, nothing visibly changed, and a
    // bogus history entry piled up — reported as "cannot get into my
    // canvas". Creating such a tile is now blocked in TileModal, but boards
    // saved before that (or edited by hand) can still carry one — explain
    // instead of silently doing nothing.
    if (this.file && targetPath === this.file.path) {
      new Notice('This tile links to the board it\'s on, so it has nowhere to go. Right-click the tile and choose Edit to point it at a different board.', 8000);
      return;
    }
    const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(targetFile instanceof TFile)) {
      new Notice(`Board file not found: ${targetPath}`);
      return;
    }
    this.isInternalNavigation = true;
    this.navigationHistory.push(this.file!);
    // Force Visual Notes' own view type explicitly. Since Visual Notes no
    // longer owns the .canvas extension (Obsidian's core Canvas plugin
    // does), a plain leaf.openFile() here would resolve via extension and
    // silently drop you into the native Canvas view mid-navigation.
    await this.leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: targetFile.path } });
  }

  async navigateBack(): Promise<void> {
    const prev = this.navigationHistory.pop();
    if (!prev) return;
    this.isInternalNavigation = true;
    await this.leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: prev.path } });
  }

  // ── Web-clip import ──────────────────────────────────────────
  //
  // The importer can't write to a board's file while a view is showing it:
  // the renderer holds the whole board in memory and its next save would
  // overwrite the file underneath. So an open board is mutated through its
  // renderer instead, and these three methods are the boundary the importer
  // uses rather than reaching for the private renderer directly.

  /** True if this view is currently showing the board at `path`. */
  isShowingBoard(path: string): boolean {
    return this.file?.path === path;
  }

  /** Writes out anything this view has pending, so a later read sees it. */
  async flushPendingSave(): Promise<void> {
    const r = this.renderer;
    if (r instanceof FreeformRenderer && r.saveQueue.hasPendingWork) await r.saveNow();
  }

  /** Re-reads this view's file and re-renders, discarding in-memory state. */
  async reloadFromDisk(): Promise<void> {
    if (!this.file) return;
    const board = await readBoardFile(this.app, this.file);
    if (board.unreadable) return;
    await this.renderBoard(board, this.file);
  }

  /**
   * Adds cards to the open board through its live renderer.
   *
   * Returns the number added, or null if this view can't take them — a grid
   * board, or no renderer yet — so the caller can tell "nothing to add" (0)
   * apart from "not applicable here" (null) rather than guessing.
   */
  async addCardsLive(build: (board: VisualNotesFile) => Card[]): Promise<number | null> {
    const r = this.renderer;
    if (!(r instanceof FreeformRenderer)) return null;
    const cards = build(r.board);
    if (cards.length === 0) return 0;
    r.pushUndo();
    for (const card of cards) {
      r.board.cards.push(card);
      r.createCardEl(card);
    }
    await r.saveNow();
    return cards.length;
  }

  // ── Rendering ────────────────────────────────────────────────

  private async renderBoard(board: VisualNotesFile, file: TFile): Promise<void> {
    await this.destroyRenderer();

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('visual-notes-container');
    container.toggleClass('visual-notes-layout-freeform', board.layout === 'freeform');

    this.renderHeader(container, file, board.layout);

    const content = container.createDiv('visual-notes-content');

    if (board.layout === 'freeform') {
      this.renderer = new FreeformRenderer(
        this.app,
        content,
        board,
        file,
        (path) => this.navigateToBoard(path),
        async (updated) => { await writeBoardFile(this.app, file, updated); },
        this.plugin.settings.bookmarkCacheDays ?? 30,
        this.plugin.settings.defaultStickyColor,
        this.plugin.settings.toolbarPosition ?? 'left',
        this.plugin.settings.commentAuthorName,
        this.plugin.settings.cardDragAnimation ?? true,
        this.plugin.settings.cardDragAnimationIntensity ?? 1,
        this.plugin.settings.largeKanbanItems ?? false,
        this.plugin.settings.snapToGrid ?? true,
        this.plugin.settings.snapGridSize ?? 32,
        (value) => { this.plugin.settings.snapToGrid = value; void this.plugin.saveSettings(); },
        this.plugin.settings.mobileFabPosition ?? 'bottom-right',
        // Cloned — the panel mutates this object in place, and it must
        // never be the same reference as DEFAULT_PEN_DRAW_OPTIONS or a
        // fresh install's first slider drag would corrupt that shared
        // module-level default for every board opened afterward.
        { ...DEFAULT_PEN_DRAW_OPTIONS, ...this.plugin.settings.penDrawOptions },
        (value) => { this.plugin.settings.penDrawOptions = value; void this.plugin.saveSettings(); },
        this.plugin.settings.panButton ?? 'middle',
        this.plugin.settings.appearanceButton !== false,
        this.plugin.settings.experimentalCollaboration ? this.collaborationOptions(file) : undefined,
      );
    } else {
      this.renderer = new GridRenderer(
        this.app,
        content,
        board,
        file,
        (path) => this.navigateToBoard(path)
      );
    }

    this.renderer.render();
  }

  private renderHeader(container: HTMLElement, file: TFile, layout: VisualNotesFile['layout']): void {
    const header = container.createDiv('visual-notes-view-header');

    // Back button (visible when we have history)
    const backBtn = header.createDiv('visual-notes-back-btn' + (this.navigationHistory.length === 0 ? ' is-hidden' : ''));
    setIcon(backBtn, 'arrow-left');
    backBtn.setAttribute('aria-label', 'Go back');
    backBtn.addEventListener('click', () => { void this.navigateBack(); });

    // Breadcrumb
    const breadcrumb = header.createDiv('visual-notes-breadcrumb');

    if (this.navigationHistory.length === 0) {
      // No drill-down path to show — the plain filename here would just
      // repeat the tab title right above it, so skip straight to the
      // layout badge below rather than rendering a redundant copy of it.
    } else {
      // Render history entries as clickable ancestors
      this.navigationHistory.forEach((histFile, i) => {
        const span = breadcrumb.createSpan({
          text: histFile.basename,
          cls: 'visual-notes-breadcrumb-ancestor',
        });
        span.addEventListener('click', () => { void (async () => {
          // Navigate back to this point: slice history to index i
          const target = this.navigationHistory[i];
          this.navigationHistory = this.navigationHistory.slice(0, i);
          this.isInternalNavigation = true;
          await this.leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: target.path } });
        })(); });
        breadcrumb.createSpan({ text: '›', cls: 'visual-notes-breadcrumb-sep' });
      });
      breadcrumb.createSpan({ text: file.basename, cls: 'visual-notes-breadcrumb-current' });
    }

    // Board-type badge — grid and canvas boards are otherwise visually
    // identical in the file explorer and tab bar (same .canvas extension,
    // same icon), which let users mix the two up ("expected a canvas, got a
    // grid"). Name the layout right in the header.
    breadcrumb.createSpan({
      text: layout === 'freeform' ? 'Canvas' : 'Tile grid',
      cls: 'visual-notes-layout-badge',
    });
  }

  private renderEmpty(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('visual-notes-container');
    const msg = container.createDiv('visual-notes-empty-state');
    msg.createEl('p', { text: 'No board is open.' });
    msg.createEl('p', {
      text: 'Create a new one, or open an existing .canvas board from the file explorer.',
      cls: 'visual-notes-empty-hint',
    });
    const btnRow = msg.createDiv('visual-notes-modal-buttons');
    const createBtn = btnRow.createEl('button', { text: 'Create new board', cls: 'mod-cta' });
    createBtn.addEventListener('click', () => {
      new CreateBoardModal(this.app, this.plugin, (file) => {
        this.isInternalNavigation = true;
        void this.leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
      }).open();
    });
    const templateBtn = btnRow.createEl('button', { text: 'New board from template' });
    templateBtn.addEventListener('click', () => {
      this.plugin.openTemplatePicker((file) => {
        this.isInternalNavigation = true;
        void this.leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
      });
    });
  }

  private async destroyRenderer(): Promise<void> {
    await this.renderer?.destroy();
    this.renderer = null;
  }
}
