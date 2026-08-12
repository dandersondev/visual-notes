import { Plugin, TFile, TFolder, TAbstractFile, FileView, Menu, Notice } from 'obsidian';
import { VisualNotesView, VISUAL_NOTES_VIEW_TYPE, NATIVE_CANVAS_VIEW_TYPE } from './view';
import { VisualNotesSettingsTab } from './settings';
import { VisualNotesSettings, DEFAULT_SETTINGS } from './types';
import { Card, VisualNotesFile } from './file-types';
import {
  addClipsToBoard, announceClipImport, clipFolderExists, listClipFiles, shouldQueueClip,
} from './web-clip-import';
import { SaveQueue } from './save-queue';

// Long enough that clipping several pages in a row costs one board write
// rather than one each, short enough that a single clip still feels immediate.
const CLIP_IMPORT_DEBOUNCE_MS = 800;
import { normalizeSettings } from './settings-validate';
import { CreateBoardModal, TemplatePickerModal, TemplateChoice } from './create-board-modal';
import { needsMigration, migrateV1toV2 } from './migration';
import { relinkAllBoards } from './asset-manager';
import { isVisualNotesOwnedFile, listTemplates, createBoardFileFromTemplate, installStarterTemplate, TEMPLATES_FOLDER, promptSaveBoardAsTemplate, backupBeforeNativeEdit, NATIVE_BAK_SUFFIX } from './file-io';
import { STARTER_TEMPLATES } from './starter-templates';

export default class VisualNotesPlugin extends Plugin {
  override settings: VisualNotesSettings;

  // Files the user has explicitly chosen to view with Obsidian's native
  // Canvas instead of Visual Notes' own UI for this session — e.g. so a
  // plugin that patches the native Canvas view class (something Visual
  // Notes' separately-drawn UI can never expose a hook for) can work on
  // them. Session-only by design: not persisted to disk, so a restart
  // always goes back to Visual Notes' rich rendering by default.
  private nativeOverrides = new Set<string>();

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.applyCanvasAppearanceSettings();

    // Register the view
    this.registerView(
      VISUAL_NOTES_VIEW_TYPE,
      (leaf) => new VisualNotesView(leaf, this)
    );

    // .canvas is NOT registered the same way — Obsidian's core Canvas
    // plugin already owns that extension, and a second registerExtensions
    // call for it would conflict. Instead, Visual Notes lets native Canvas
    // stay the default and reactively takes over the leaf at runtime for
    // any .canvas file that carries Visual Notes' own marker (see
    // isVisualNotesOwnedFile in file-io.ts / canvas-format.ts). Plain native
    // canvases — anything without that marker — are left alone entirely.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && file.extension === 'canvas') void this.maybeTakeOverCanvasLeaf(file);
      })
    );

    // Ribbon — opens (or focuses) the default board. Right-click for more
    // options: left-click alone gave no way to create an *additional*
    // board once one already existed (the ribbon would just refocus the
    // one you had), and the only command for it lived in the command
    // palette where it was easy to miss.
    const ribbonEl = this.addRibbonIcon('layout-grid', 'Visual Notes', () => {
      void this.openDefaultBoard();
    });
    ribbonEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem(item =>
        item.setTitle('Open default board').setIcon('layout-grid').onClick(() => {
          void this.openDefaultBoard();
        })
      );
      menu.addItem(item =>
        item.setTitle('Create new board…').setIcon('plus').onClick(() => {
          new CreateBoardModal(this.app, this, (file) => { void this.openBoardFile(file); }).open();
        })
      );
      menu.addItem(item =>
        item.setTitle('New board from template…').setIcon('layout-template').onClick(() => {
          this.openTemplatePicker((file) => { void this.openBoardFile(file); });
        })
      );
      menu.showAtMouseEvent(e);
    });

    // File explorer: right-clicking a folder gets a "New Visual Notes board"
    // entry too, matching how Obsidian's own "New canvas" works — and the
    // new board is created directly inside that folder.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem(item =>
          item.setTitle('New Visual Notes board').setIcon('layout-grid').onClick(() => {
            new CreateBoardModal(this.app, this, (created) => { void this.openBoardFile(created); }, file).open();
          })
        );
        menu.addItem(item =>
          item.setTitle('New Visual Notes from template…').setIcon('layout-template').onClick(() => {
            this.openTemplatePicker((created) => { void this.openBoardFile(created); }, file);
          })
        );
      })
    );

    // Command: open default board
    this.addCommand({
      id: 'open',
      name: 'Open',
      callback: () => { void this.openDefaultBoard(); },
    });

    // Command: pull in any web clips not already on the board. Exists partly
    // as recovery: clips made while Obsidian was closed never fire a vault
    // event we could act on, and a sync can deliver a batch at any moment.
    // Safe to run repeatedly — the import skips whatever is already there.
    this.addCommand({
      id: 'import-web-clips',
      name: 'Import web clips now',
      callback: () => { void this.importWebClips({ silent: false }); },
    });

    // Command: create a new board
    this.addCommand({
      id: 'create-board',
      name: 'Create new board',
      callback: () => {
        new CreateBoardModal(this.app, this, (file) => {
          void this.openBoardFile(file);
        }).open();
      },
    });

    // Command: create a new board from a template
    this.addCommand({
      id: 'new-board-from-template',
      name: 'New board from template',
      callback: () => {
        this.openTemplatePicker((file) => { void this.openBoardFile(file); });
      },
    });

    // Command: relink all board assets
    this.addCommand({
      id: 'relink-board-assets',
      name: 'Relink all board assets',
      callback: async () => {
        const n = await relinkAllBoards(this.app);
        new Notice(n > 0
          ? `Visual Notes: Fixed ${n} broken link${n === 1 ? '' : 's'} across all boards.`
          : 'Visual Notes: No broken links found.');
      },
    });

    // Command: toggle between Visual Notes' rich view and Obsidian's native
    // Canvas view for the currently open board. Useful when another plugin
    // (e.g. one that patches the native Canvas view class) needs to act on
    // the file — that only works while native Canvas is actually rendering
    // it, which Visual Notes' own UI otherwise pre-empts.
    this.addCommand({
      id: 'toggle-native-canvas-view',
      name: 'Toggle native Canvas view for this file',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(FileView);
        const file = view?.file;
        if (!file || file.extension !== 'canvas') return false;
        if (!checking) void this.toggleNativeView(view);
        return true;
      },
    });

    // Command: save the current board as a template — was previously only
    // reachable via a dedicated header button (removed: it was one of the
    // least-used actions taking up permanent header space); now also in
    // the toolbar's "…" overflow menu.
    this.addCommand({
      id: 'save-board-as-template',
      name: 'Save current board as template',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(VisualNotesView);
        const file = view?.file;
        if (!file) return false;
        if (!checking) promptSaveBoardAsTemplate(this.app, file);
        return true;
      },
    });

    // Settings tab
    this.addSettingTab(new VisualNotesSettingsTab(this.app, this));

    // Run migration + startup open + a one-time sweep of already-open
    // .canvas leaves (from a restored workspace layout) after the
    // workspace is ready. The file-open event above only fires going
    // forward, so leaves that were already open when Obsidian launched
    // need this separate pass.
    this.app.workspace.onLayoutReady(async () => {
      await this.runMigrationIfNeeded();
      await this.sweepOpenCanvasLeaves();

      // Catch up on clips that arrived while Obsidian wasn't running, which
      // no vault event will ever report. Only safe because the import skips
      // paths already on the board — without that, this would re-add every
      // clip ever made, every launch.
      if (this.settings.clipAutoImport !== false) await this.importWebClips({ silent: true });

      // Only now start listening. Registered here rather than in onload
      // because vault load emits 'create' for every existing file, so an
      // earlier registration would queue the entire clippings folder on
      // every launch — the reconcile above already covers that ground, once,
      // deliberately.
      this.registerEvent(this.app.vault.on('create', (file) => { this.queueClip(file); }));
      // 'rename' as well as 'create': sync and other tools frequently *move*
      // a note into the folder rather than creating it there, and a create
      // listener alone never sees those at all.
      this.registerEvent(this.app.vault.on('rename', (file) => { this.queueClip(file); }));

      if (this.settings.openOnStartup) {
        await this.openDefaultBoard();
      }
    });
  }

  override onunload(): void {
    // A debounced clip import must not fire against a plugin that has been
    // disabled. Nothing is lost by dropping it: the queue only holds paths,
    // and the startup reconcile picks up anything missed the next time the
    // plugin loads. That is the same idempotence the whole feature rests on.
    this.clipQueue?.cancel();
    this.clipPending.clear();
  }

  // ── Web clips ────────────────────────────────────────────────

  // Paths waiting to be imported, drained by clipQueue. A set because the
  // same note can raise several events (create then rename) before the queue
  // fires, and because a batch of clips should cost one board write.
  private clipPending = new Set<string>();
  private clipQueue: SaveQueue | null = null;

  /** Queues a vault event's file for import, if it looks like a clip. */
  private queueClip(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (!shouldQueueClip(file.path, file.extension, this.settings)) return;
    this.clipPending.add(file.path);
    // Reuses the board save queue rather than a second debouncer: it already
    // coalesces a burst into one run and refuses to start a second run while
    // one is in flight, which is exactly what a batch of clips needs.
    this.clipQueue ??= new SaveQueue(
      () => this.drainClipQueue(),
      (err) => { console.error('Visual Notes: failed to import web clips', err); },
      CLIP_IMPORT_DEBOUNCE_MS,
    );
    this.clipQueue.schedule();
  }

  /** Imports everything queued since the last run, as a single batch. */
  private async drainClipQueue(): Promise<void> {
    const paths = [...this.clipPending];
    this.clipPending.clear();
    if (paths.length === 0) return;
    const result = await addClipsToBoard(
      this.app, this.settings.clipBoardPath, paths,
      (boardPath, add) => this.addToOpenBoard(boardPath, add),
    );
    // silent: true only suppresses "nothing to do" — an actual import still
    // announces itself, which is the whole point of it being automatic.
    announceClipImport(result, true);
  }

  /**
   * Adds every clip in the configured folder that isn't already on the
   * configured board.
   *
   * `silent` suppresses the "nothing to do" message so the startup pass is
   * quiet on a normal launch, while the manual command always says what it
   * did — a command that appears to do nothing reads as broken.
   */
  async importWebClips(opts: { silent: boolean }): Promise<void> {
    const { clipFolder, clipBoardPath } = this.settings;
    if (!clipFolder || !clipBoardPath) {
      announceClipImport(
        { added: 0, alreadyPresent: 0, refusal: 'No clippings folder and board are set yet. Choose them in Visual Notes settings.' },
        opts.silent,
      );
      return;
    }
    if (!clipFolderExists(this.app, clipFolder)) {
      announceClipImport(
        { added: 0, alreadyPresent: 0, refusal: `The clippings folder ("${clipFolder}") doesn't exist.` },
        opts.silent,
      );
      return;
    }
    const paths = listClipFiles(this.app, clipFolder).map(f => f.path);
    const result = await addClipsToBoard(
      this.app, clipBoardPath, paths,
      (boardPath, add) => this.addToOpenBoard(boardPath, add),
    );
    announceClipImport(result, opts.silent);
  }

  /**
   * Adds cards to a board that is open in one or more views, or returns null
   * if none is showing it.
   *
   * The ordering here is the whole point. Flush every open view first, so no
   * unsaved edit is lost; then reload the one we're about to mutate, so its
   * in-memory board includes what the others just wrote — skip that and its
   * save would quietly undo them. The rest are reloaded afterwards so they
   * show the new cards instead of holding a board that is now stale.
   */
  private async addToOpenBoard(
    boardPath: string,
    add: (board: VisualNotesFile) => Card[],
  ): Promise<number | null> {
    const views = this.app.workspace.getLeavesOfType(VISUAL_NOTES_VIEW_TYPE)
      .map(leaf => leaf.view)
      .filter((v): v is VisualNotesView => v instanceof VisualNotesView && v.isShowingBoard(boardPath));
    if (views.length === 0) return null;

    for (const v of views) await v.flushPendingSave();
    const [canonical, ...rest] = views;
    await canonical.reloadFromDisk();
    const added = await canonical.addCardsLive(add);
    // null means this view can't take them (a grid board). Reporting null
    // upward sends the caller down the on-disk path, which reads the board
    // and refuses with a reason rather than failing silently here.
    if (added === null) return null;
    for (const v of rest) await v.reloadFromDisk();
    return added;
  }

  async loadSettings(): Promise<void> {
    // No assertion needed: loadData() is typed `unknown`, and intersecting
    // that with DEFAULT_SETTINGS' type already yields VisualNotesSettings.
    // Normalised because data.json is just a file on disk: hand-edited,
    // synced across devices, or written by an older version. A bad value used
    // to survive load and fail much later at a render site instead.
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, await this.loadData()));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Applies the dot-grid color/size and canvas background color as CSS
  // custom properties on the whole app body — every open (and future)
  // board's canvas reads these via var(--visual-notes-dot-color, ...), etc. with
  // inheritance, so setting them here updates every open board live in one
  // shot — no need to reach into each board's individual FreeformRenderer
  // instance.
  applyCanvasAppearanceSettings(): void {
    if (this.settings.dotColor) document.body.style.setProperty('--visual-notes-dot-color', this.settings.dotColor);
    else document.body.style.removeProperty('--visual-notes-dot-color');

    if (this.settings.dotSize !== undefined) document.body.style.setProperty('--visual-notes-dot-radius', `${this.settings.dotSize}px`);
    else document.body.style.removeProperty('--visual-notes-dot-radius');

    if (this.settings.canvasBgColor) document.body.style.setProperty('--visual-notes-canvas-bg', this.settings.canvasBgColor);
    else document.body.style.removeProperty('--visual-notes-canvas-bg');

    document.body.style.setProperty('--visual-notes-trash-zone-size', `${this.settings.trashZoneSize ?? 56}px`);

    // Unitless multiplier every card-content font-size is written against —
    // see the "Text scale" block in styles.css. Deliberately does not reach
    // the plugin's own UI chrome, which stays at its authored px sizes.
    document.body.style.setProperty('--visual-notes-text-scale', String(this.settings.textScale ?? 1));
  }

  // ── Canvas leaf takeover ─────────────────────────────────────

  async toggleNativeView(view: FileView): Promise<void> {
    const file = view.file;
    if (!file || file.extension !== 'canvas') return;
    const leaf = view.leaf;

    if (view.getViewType() === VISUAL_NOTES_VIEW_TYPE) {
      // Visual Notes → native: remember this choice for the session so the
      // file-open takeover hook doesn't immediately swap it back.
      //
      // Native Canvas rebuilds a file from its own model whenever it saves,
      // and that model has no room for root-level extra keys — so as soon as
      // anything writes over there, this board's layout, viewport, free
      // drawings and archive are gone. Snapshot it first and say so plainly,
      // rather than letting a one-line notice imply the trip is free.
      const backed = await backupBeforeNativeEdit(this.app, file);
      this.nativeOverrides.add(file.path);
      await leaf.setViewState({ type: NATIVE_CANVAS_VIEW_TYPE, state: { file: file.path } });
      new Notice(
        'Opened with Obsidian\'s native Canvas view. Editing here drops board metadata Visual Notes ' +
        'needs — free drawings and archived cards especially. ' +
        (backed ? `A backup was saved as "${file.name}${NATIVE_BAK_SUFFIX}".` : 'No backup could be saved.'),
        12000
      );
      return;
    }

    // Native → Visual Notes: only makes sense for files Visual Notes actually
    // authored (has its `vn` marker) — anything else, there's no rich card
    // data to render.
    if (!(await isVisualNotesOwnedFile(this.app, file))) {
      new Notice('This canvas wasn\'t created by Visual Notes — nothing to switch to.');
      return;
    }
    this.nativeOverrides.delete(file.path);
    await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
  }

  private async maybeTakeOverCanvasLeaf(file: TFile): Promise<void> {
    if (this.nativeOverrides.has(file.path)) return;
    if (!(await isVisualNotesOwnedFile(this.app, file))) return;
    const leaves = this.app.workspace.getLeavesOfType(NATIVE_CANVAS_VIEW_TYPE);
    const leaf = leaves.find(l => (l.view as { file?: TAbstractFile }).file?.path === file.path);
    if (!leaf) return;
    await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
  }

  private async sweepOpenCanvasLeaves(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(NATIVE_CANVAS_VIEW_TYPE)) {
      const file = (leaf.view as { file?: TAbstractFile }).file;
      if (!(file instanceof TFile) || this.nativeOverrides.has(file.path)) continue;
      if (await isVisualNotesOwnedFile(this.app, file)) {
        await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
      }
    }
  }

  // ── Board opening ─────────────────────────────────────────────

  async openDefaultBoard(): Promise<void> {
    const { workspace } = this.app;

    // If a board leaf is already visible AND actually has a file loaded,
    // just focus it. A leaf can exist with no file (e.g. after a workspace
    // restore whose saved file no longer exists) — that's the "No board is
    // open" empty state, not a real board, so it must NOT short-circuit
    // here; otherwise clicking the ribbon just reveals a dead empty view
    // forever instead of ever reaching the create/open flow below.
    const existing = workspace.getLeavesOfType(VISUAL_NOTES_VIEW_TYPE);
    const existingWithFile = existing.find(l => (l.view as { file?: TFile }).file instanceof TFile);
    if (existingWithFile) {
      void workspace.revealLeaf(existingWithFile);
      return;
    }

    // Try the stored default board path
    if (this.settings.defaultBoardPath) {
      const file = this.app.vault.getAbstractFileByPath(this.settings.defaultBoardPath);
      if (file instanceof TFile) {
        // Reuse an existing empty leaf instead of opening a new tab, if one's there.
        if (existing.length > 0) {
          await existing[0].setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
          void workspace.revealLeaf(existing[0]);
          return;
        }
        await this.openBoardFile(file);
        return;
      }
      // Path is stale — clear it
      this.settings.defaultBoardPath = undefined;
      await this.saveSettings();
    }

    // No default board — prompt to create one
    new CreateBoardModal(this.app, this, (file) => {
      this.settings.defaultBoardPath = file.path;
      void this.saveSettings().then(() => this.openBoardFile(file));
    }).open();
  }

  // Shared by every "new board from template" entry point (ribbon menu,
  // folder context menu, command palette, and the empty-state screen in
  // view.ts) — each just supplies its own onCreated (open in a new tab vs.
  // reuse the current empty leaf) and an optional target folder.
  //
  // The picker lists the vault's own _Templates/ files plus any bundled
  // starter templates not yet installed. Starters are install-on-pick:
  // nothing is written to the vault until the user explicitly chooses one,
  // at which point the template file is added to _Templates/ (so it's theirs
  // to edit or delete from then on) and a fresh board is spawned from it.
  openTemplatePicker(onCreated: (file: TFile) => void, folder: TFolder | null = null): void {
    const vaultTemplates = listTemplates(this.app);
    const installedNames = new Set(vaultTemplates.map(f => f.basename));

    const choices: TemplateChoice[] = vaultTemplates.map(f => ({
      label: f.basename,
      onPick: () => { void (async () => {
        const file = await createBoardFileFromTemplate(this.app, f, folder);
        onCreated(file);
      })(); },
    }));

    for (const starter of STARTER_TEMPLATES) {
      if (installedNames.has(starter.name)) continue;
      choices.push({
        label: `${starter.name} — starter`,
        onPick: () => { void (async () => {
          const templateFile = await installStarterTemplate(this.app, starter.name, starter.json);
          new Notice(`Visual Notes: Added starter template to ${TEMPLATES_FOLDER}/${starter.name}.canvas — edit it there to make it your own.`);
          const file = await createBoardFileFromTemplate(this.app, templateFile, folder);
          onCreated(file);
        })(); },
      });
    }

    new TemplatePickerModal(this.app, choices).open();
  }

  async openBoardFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab');
    // Force Visual Notes' view type directly rather than leaf.openFile(),
    // since for .canvas files that would resolve via extension to
    // Obsidian's native Canvas view (which Visual Notes no longer claims).
    await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
    void this.app.workspace.revealLeaf(leaf);
  }

  // ── Migration ─────────────────────────────────────────────────

  private async runMigrationIfNeeded(): Promise<void> {
    if (!needsMigration(this.settings)) return;

    try {
      const homeFile = await migrateV1toV2(this.app, this);
      // Immediately open the migrated home board
      await this.openBoardFile(homeFile);
    } catch (e) {
      console.error('Visual Notes: migration failed', e);
      new Notice('Visual Notes: Migration failed — your v1 tiles are still in plugin settings. Please report this issue.', 10000);
    }
  }
}