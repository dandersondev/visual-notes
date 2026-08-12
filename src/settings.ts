import { App, PluginSettingTab, Setting, Notice, FuzzySuggestModal, TFile, type SettingDefinitionItem } from 'obsidian';
import type VisualNotesPlugin from './main';
import { ConfirmModal } from './tile-modal';
import { FolderSuggestModal } from './create-board-modal';
import { validateTileImport } from './settings-validate';
import { relinkAllBoards } from './asset-manager';
import { STICKY_COLORS, resolveDefaultStickyColor } from './freeform-view-shared';

// Replaced with a string literal by esbuild at build time (see the `define`
// in esbuild.config.mjs). The `typeof` guard keeps this working under
// vitest, which imports the TypeScript sources directly and so never runs
// the substitution.
declare const __BUILD_VERSION__: string;
const BUILD_VERSION = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'unknown';

// ── Board picker modal ────────────────────────────────────────

class BoardPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) {
    super(app);
    this.setPlaceholder('Search for a board file…');
  }
  getItems(): TFile[] {
    // Lists every .canvas file. FuzzySuggestModal requires a synchronous
    // item list, so this can't filter out plain native canvases by content
    // here (that check is async — see isVisualNotesOwnedFile in file-io.ts).
    // Picking a non-Visual-Notes canvas as the default board is harmless:
    // opening it will simply hand off to Obsidian's native Canvas view
    // instead of Visual Notes' UI.
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFile => f instanceof TFile && f.extension === 'canvas');
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

// ── Settings tab ──────────────────────────────────────────────
//
// Two rendering paths, one body per setting so they can never drift:
// Obsidian 1.13+ renders declaratively from getSettingDefinitions() (and
// indexes each setting's name/desc for its settings search); older
// versions call display(), which builds the same settings imperatively.
// IMPORTANT: no 1.13-only APIs may be referenced here (update(),
// setDestructive(), …) — minAppVersion predates them and the plugin
// review's obsidianmd/no-unsupported-api check flags even guarded
// references. Obsidian 1.13 is not generally available yet (stable is
// 1.12.x as of 2026-07), so the floor must stay below 1.13.

export class VisualNotesSettingsTab extends PluginSettingTab {
  plugin: VisualNotesPlugin;
  private importText = '';
  private importAreaEl: HTMLTextAreaElement | null = null;

  constructor(app: App, plugin: VisualNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ── Declarative definitions (Obsidian 1.13+) ────────────────

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      // Not a labelled control but a status line, so it gets the setting's
      // own element as a plain container and drops the Setting chrome —
      // that way the exact same body renders it on both paths. Leaving it
      // out of this list is why the stale-build warning, whose entire job is
      // to explain "the update didn't take", was itself invisible on 1.13+
      // — precisely for the users who needed it.
      { name: 'Visual Notes version', render: (s) => {
        s.settingEl.empty();
        s.settingEl.addClass('visual-notes-version-host');
        this.buildVersionNotice(s.settingEl);
      } },
      { name: 'Open on startup', desc: 'Automatically open Visual Notes when Obsidian starts.',
        render: (s) => this.buildOpenOnStartup(s) },
      { name: 'Default board', desc: 'Board opened when you click the ribbon icon or use the "Open" command.',
        render: (s) => this.buildDefaultBoard(s) },
      { name: 'Default folder for new boards', desc: 'Folder pre-selected as the location when you create a board. Creating a board inside a folder you right-clicked still uses that folder.',
        render: (s) => this.buildDefaultNewBoardFolder(s) },
      { name: 'Mark Visual Notes boards in the file explorer', desc: 'Tags .canvas files that are Visual Notes boards as VISUAL rather than CANVAS, so they can be told apart from Obsidian’s own canvases at a glance. Purely visual — nothing about the files changes.',
        render: (s) => this.buildExplorerBoardTint(s) },
      { name: 'Light/dark button on boards', desc: 'Adds a sun/moon button to the bottom-right of every board that switches Obsidian between light and dark mode. This changes Obsidian’s own Appearance setting, not just the board. Takes effect when you next open a board.',
        render: (s) => this.buildAppearanceButton(s) },
      { type: 'group', heading: 'Freeform canvas', items: [
        { name: 'Pan the canvas with', desc: 'Which mouse button drags the freeform canvas around. Space+left-click always works no matter what you pick here. Takes effect when you next open a board.',
          render: (s) => this.buildPanButton(s) },
        { name: 'Toolbar position', desc: 'Where the card-creation toolbar appears on the canvas. Takes effect when you next open a board.',
          render: (s) => this.buildToolbarPosition(s) },
        { name: 'Mobile "+" button position', desc: 'Corner the phone-width add-card button sits in. Move it if it overlaps the minimap/zoom/snap controls. Takes effect when you next open a board.',
          render: (s) => this.buildMobileFabPosition(s) },
        { name: 'Grid dot color', desc: 'Color of the dot grid on the freeform canvas background. Updates any open board live.',
          render: (s) => this.buildDotColor(s) },
        { name: 'Grid dot size', desc: 'Radius of each dot in pixels. Updates any open board live.',
          render: (s) => this.buildDotSize(s) },
        { name: 'Canvas background color', desc: 'Background color of the freeform canvas itself. Updates any open board live.',
          render: (s) => this.buildCanvasBgColor(s) },
        { name: 'Card drag animation', desc: 'Lift, tilt, and settle a card as you drag it around the canvas. Takes effect the next time you open a board.',
          render: (s) => this.buildCardDragAnimation(s) },
        { name: 'Card drag animation intensity', desc: 'How pronounced the lift/tilt effect is. Takes effect the next time you open a board.',
          render: (s) => this.buildCardDragAnimationIntensity(s) },
        { name: 'Snap to grid', desc: 'Dragging, resizing, or placing a card on the freeform canvas snaps it to a grid. Can also be toggled per-session with the magnet button on the canvas. Takes effect the next time you open a board.',
          render: (s) => this.buildSnapToGrid(s) },
        { name: 'Grid size', desc: 'Spacing in pixels of the snap-to-grid. Default: 32.',
          render: (s) => this.buildGridSize(s) },
        { name: 'Trash zone size', desc: 'Diameter in pixels of the delete-by-drag circle in the bottom-left corner of the freeform canvas. Updates any open board live. Default: 56.',
          render: (s) => this.buildTrashZoneSize(s) },
        { name: 'Card text size', desc: 'Scales the text on every card. Does not resize the plugin\'s own toolbars and panels. Individual Notes can override this from their Aa button. Updates any open board live. Default: 100%.',
          render: (s) => this.buildTextScale(s) },
        { name: 'Larger kanban cards', desc: 'Bigger text, padding, and icon badges on kanban items. Takes effect the next time you open a board.',
          render: (s) => this.buildLargeKanbanItems(s) },
        { name: 'Bookmark cache duration', desc: 'Days before bookmark previews are automatically re-fetched. Default: 30.',
          render: (s) => this.buildBookmarkCacheDuration(s) },
        { name: 'Default sticky colour', desc: 'Colour used when creating new sticky notes.',
          render: (s) => this.buildDefaultStickyColor(s) },
        { name: 'Comment author name', desc: 'Shown on new comments and replies you add to a board. Defaults to "Anonymous" when left blank.',
          render: (s) => this.buildCommentAuthorName(s) },
      ] },
      { type: 'group', heading: 'Web clips', items: [
        { name: 'Clippings folder', desc: 'Notes saved into this folder are added to the board below. Point Obsidian Web Clipper’s note location here to send clips straight to a board.',
          render: (s) => this.buildClipFolder(s) },
        { name: 'Board for clips', desc: 'Where clipped notes appear, as cards below whatever is already on it. Must be a freeform board.',
          render: (s) => this.buildClipBoard(s) },
        { name: 'Import clips automatically', desc: 'Check the folder when Obsidian starts and add anything new. Turn this off to only import when you run the "Import web clips now" command.',
          render: (s) => this.buildClipAutoImport(s) },
      ] },
      { type: 'group', heading: 'Assets', items: [
        { name: 'Auto-sort assets', desc: 'All images, audio, video, and documents imported or linked into a board are automatically moved to _Assets/Images/, _Assets/Audio/, etc. in the vault root. Always on.',
          render: (s) => this.buildAutoSortAssets(s) },
        { name: 'Auto-relink on board open', desc: 'When a board opens, silently scan for broken file links and fix any that have a unique filename match in the vault.',
          render: (s) => this.buildAutoRelinkOnOpen(s) },
        { name: 'Relink all boards now', desc: 'Scan every Visual Notes file in the vault and fix broken links with a unique filename match. Useful after moving files.',
          render: (s) => this.buildRelinkAllBoardsNow(s) },
      ] },
      { type: 'group', heading: 'Data', items: [
        { name: 'Export tiles as JSON', desc: 'Copy all your tile data to the clipboard as JSON.',
          render: (s) => this.buildExportTilesJson(s) },
        { name: 'Import tiles from JSON', desc: 'Paste JSON exported from another vault. This will replace all existing tiles. Make sure the JSON is an array of tile objects.',
          render: (s) => this.buildImportDesc(s) },
        { name: 'Import', render: (s) => this.buildImportButton(s) },
      ] },
      { type: 'group', heading: 'Danger zone', items: [
        { name: 'Reset all tiles', desc: 'Permanently delete every tile and nested board. This cannot be undone.',
          render: (s) => this.buildResetAllTiles(s) },
      ] },
    ];
  }

  // ── Imperative fallback (Obsidian < 1.13) ───────────────────
  // Not called by the app on 1.13+ (getSettingDefinitions() takes over).

  override display(): void {
    this.renderImperative();
  }

  // Re-render after a settings mutation that changes the tab's structure
  // (reset buttons, board picker's Clear visibility, sticky palette).
  // Rebuilds imperatively on both paths: on 1.13+ the proper API would be
  // update(), but that's 1.13-only and even a guarded reference trips the
  // review's no-unsupported-api check — and an imperative rebuild renders
  // identically since both paths share the same buildX bodies.
  private refresh(): void {
    this.renderImperative();
  }

  private renderImperative(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.buildVersionNotice(containerEl);
    this.buildOpenOnStartup(new Setting(containerEl));
    this.buildDefaultBoard(new Setting(containerEl));
    this.buildDefaultNewBoardFolder(new Setting(containerEl));
    this.buildExplorerBoardTint(new Setting(containerEl));
    this.buildAppearanceButton(new Setting(containerEl));

    new Setting(containerEl).setName('Freeform canvas').setHeading();
    this.buildPanButton(new Setting(containerEl));
    this.buildToolbarPosition(new Setting(containerEl));
    this.buildMobileFabPosition(new Setting(containerEl));
    this.buildDotColor(new Setting(containerEl));
    this.buildDotSize(new Setting(containerEl));
    this.buildCanvasBgColor(new Setting(containerEl));
    this.buildCardDragAnimation(new Setting(containerEl));
    this.buildCardDragAnimationIntensity(new Setting(containerEl));
    this.buildSnapToGrid(new Setting(containerEl));
    this.buildGridSize(new Setting(containerEl));
    this.buildTrashZoneSize(new Setting(containerEl));
    this.buildTextScale(new Setting(containerEl));
    this.buildLargeKanbanItems(new Setting(containerEl));
    this.buildBookmarkCacheDuration(new Setting(containerEl));
    this.buildDefaultStickyColor(new Setting(containerEl));
    this.buildCommentAuthorName(new Setting(containerEl));

    new Setting(containerEl).setName('Web clips').setHeading();
    this.buildClipFolder(new Setting(containerEl));
    this.buildClipBoard(new Setting(containerEl));
    this.buildClipAutoImport(new Setting(containerEl));

    new Setting(containerEl).setName('Assets').setHeading();
    this.buildAutoSortAssets(new Setting(containerEl));
    this.buildAutoRelinkOnOpen(new Setting(containerEl));
    this.buildRelinkAllBoardsNow(new Setting(containerEl));

    new Setting(containerEl).setName('Data').setHeading();
    this.buildExportTilesJson(new Setting(containerEl));
    this.buildImportDesc(new Setting(containerEl));
    this.buildImportButton(new Setting(containerEl));

    new Setting(containerEl).setName('Danger zone').setHeading();
    this.buildResetAllTiles(new Setting(containerEl));
  }

  // ── Per-setting builders ─────────────────────────────────────

  private buildOpenOnStartup(setting: Setting): void {
    setting
      .setName('Open on startup')
      .setDesc('Automatically open Visual Notes when Obsidian starts.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.openOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.openOnStartup = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private buildDefaultBoard(setting: Setting): void {
    setting
      .setName('Default board')
      .setDesc('Board opened when you click the ribbon icon or use the "Open" command.');

    const pathDisplay = setting.controlEl.createSpan('visual-notes-modal-path-display' + (this.plugin.settings.defaultBoardPath ? '' : ' is-empty'));
    pathDisplay.setText(this.plugin.settings.defaultBoardPath ?? 'None');

    setting.addButton(btn =>
      btn.setButtonText('Browse…').onClick(() => {
        new BoardPickerModal(this.app, (file) => { void (async () => {
          this.plugin.settings.defaultBoardPath = file.path;
          await this.plugin.saveSettings();
          pathDisplay.textContent = file.path;
          pathDisplay.removeClass('is-empty');
          // Update "Clear" button visibility by re-rendering
          this.refresh();
        })(); }).open();
      })
    );

    if (this.plugin.settings.defaultBoardPath) {
      setting.addButton(btn =>
        btn.setButtonText('Clear').onClick(() => { void (async () => {
          this.plugin.settings.defaultBoardPath = undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })(); })
      );
    }
  }

  // ── Web clips ───────────────────────────────────────────────
  //
  // Described as a folder rather than as "Obsidian Web Clipper support",
  // because that is what it is: anything that writes a note into the folder
  // — the Web Clipper, the iOS share sheet, another tool — lands on the
  // board. Naming the Clipper in the description helps people find it
  // without narrowing what it does.

  private buildClipFolder(setting: Setting): void {
    setting
      .setName('Clippings folder')
      .setDesc('Notes saved into this folder are added to the board below. Point Obsidian Web Clipper’s note location here to send clips straight to a board.');

    const folder = this.plugin.settings.clipFolder;
    const pathDisplay = setting.controlEl.createSpan('visual-notes-modal-path-display' + (folder ? '' : ' is-empty'));
    pathDisplay.setText(folder || 'None');

    setting.addButton(btn =>
      btn.setButtonText('Browse…').onClick(() => {
        new FolderSuggestModal(this.app, (chosen) => { void (async () => {
          // '' is the vault root, which would sweep in every note in the
          // vault — treated as "unset" instead.
          this.plugin.settings.clipFolder = chosen?.path || undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })(); }).open();
      })
    );

    if (folder) {
      setting.addButton(btn =>
        btn.setButtonText('Clear').onClick(() => { void (async () => {
          this.plugin.settings.clipFolder = undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })(); })
      );
    }
  }

  private buildClipBoard(setting: Setting): void {
    setting
      .setName('Board for clips')
      .setDesc('Where clipped notes appear, as cards below whatever is already on it. Must be a freeform board.');

    const board = this.plugin.settings.clipBoardPath;
    const pathDisplay = setting.controlEl.createSpan('visual-notes-modal-path-display' + (board ? '' : ' is-empty'));
    pathDisplay.setText(board || 'None');

    setting.addButton(btn =>
      btn.setButtonText('Browse…').onClick(() => {
        new BoardPickerModal(this.app, (file) => { void (async () => {
          this.plugin.settings.clipBoardPath = file.path;
          await this.plugin.saveSettings();
          this.refresh();
        })(); }).open();
      })
    );

    if (board) {
      setting.addButton(btn =>
        btn.setButtonText('Clear').onClick(() => { void (async () => {
          this.plugin.settings.clipBoardPath = undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })(); })
      );
    }
  }

  private buildAppearanceButton(setting: Setting): void {
    setting
      .setName('Light/dark button on boards')
      .setDesc('Adds a sun/moon button to the bottom-right of every board that switches Obsidian between light and dark mode. This changes Obsidian’s own Appearance setting, not just the board. Takes effect when you next open a board.')
      .addToggle(t =>
        t.setValue(this.plugin.settings.appearanceButton !== false).onChange((v) => { void (async () => {
          this.plugin.settings.appearanceButton = v;
          await this.plugin.saveSettings();
        })(); })
      );
  }

  private buildExplorerBoardTint(setting: Setting): void {
    setting
      .setName('Mark Visual Notes boards in the file explorer')
      .setDesc('Tags .canvas files that are Visual Notes boards as VISUAL rather than CANVAS, so they can be told apart from Obsidian’s own canvases at a glance. Purely visual — nothing about the files changes.')
      .addToggle(t =>
        t.setValue(this.plugin.settings.explorerBoardTint !== false).onChange((v) => { void (async () => {
          this.plugin.settings.explorerBoardTint = v;
          await this.plugin.saveSettings();
          this.plugin.applyExplorerTintSetting();
        })(); })
      );
  }

  private buildClipAutoImport(setting: Setting): void {
    setting
      .setName('Import clips automatically')
      .setDesc('Check the folder when Obsidian starts and add anything new. Turn this off to only import when you run the "Import web clips now" command.')
      .addToggle(t =>
        t.setValue(this.plugin.settings.clipAutoImport !== false).onChange((v) => { void (async () => {
          this.plugin.settings.clipAutoImport = v;
          await this.plugin.saveSettings();
        })(); })
      );
  }

  // Stores a folder path rather than a TFolder: settings are serialised to
  // data.json, and the folder can be renamed or deleted between sessions.
  // Every read goes through resolveFolderPath, which turns a stale path back
  // into null (= vault root) instead of failing.
  private buildDefaultNewBoardFolder(setting: Setting): void {
    setting
      .setName('Default folder for new boards')
      .setDesc('Folder pre-selected as the location when you create a board. Creating a board inside a folder you right-clicked still uses that folder.');

    const folder = this.plugin.settings.defaultNewBoardFolder;
    const pathDisplay = setting.controlEl.createSpan('visual-notes-modal-path-display' + (folder ? '' : ' is-empty'));
    pathDisplay.setText(folder || 'Vault root');

    setting.addButton(btn =>
      btn.setButtonText('Browse…').onClick(() => {
        new FolderSuggestModal(this.app, (chosen) => { void (async () => {
          // The root folder's path is '' — storing that would be
          // indistinguishable from "unset", which already means vault root.
          this.plugin.settings.defaultNewBoardFolder = chosen?.path || undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })(); }).open();
      })
    );

    if (folder) {
      setting.addButton(btn =>
        btn.setButtonText('Clear').onClick(() => { void (async () => {
          this.plugin.settings.defaultNewBoardFolder = undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })(); })
      );
    }
  }

  // Reports which build is actually running, and flags the case where that
  // disagrees with what Obsidian thinks is installed.
  //
  // The two numbers come from two different files an update has to replace
  // TOGETHER: manifest.json (what plugin.manifest.version reports, and what
  // a user sees in the Community plugins list) and main.js (the code
  // actually executing, stamped at build time). When only the small
  // manifest.json lands and the ~1MB main.js doesn't, Obsidian cheerfully
  // reports the new version while running the old code — so a just-shipped
  // feature is missing with no visible reason, and the version number
  // "proves" it should be there. Surfacing the mismatch here turns that
  // into something a user can see and screenshot in one step.
  private buildVersionNotice(containerEl: HTMLElement): void {
    const declared = this.plugin.manifest.version;
    if (BUILD_VERSION === declared || BUILD_VERSION === 'unknown') {
      containerEl.createDiv('visual-notes-version-line').setText(`Visual Notes v${declared}`);
      return;
    }

    const warn = containerEl.createDiv('visual-notes-version-line is-stale');
    warn.createDiv('visual-notes-version-line-title').setText(
      `Update didn't finish — manifest.json says v${declared}, but the code running is v${BUILD_VERSION}.`
    );
    warn.createDiv().setText(
      'Obsidian is reporting the newer version while still running the older build, so anything added since ' +
      `v${BUILD_VERSION} will appear to be missing. To fix it, download main.js, manifest.json and styles.css ` +
      'from the latest release, replace all three together, then turn the plugin off and on again in Community plugins.'
    );
  }

  private buildPanButton(setting: Setting): void {
    setting
      .setName('Pan the canvas with')
      .setDesc('Which mouse button drags the freeform canvas around. Space+left-click always works no matter what you pick here. Takes effect when you next open a board.')
      .addDropdown(dd =>
        dd
          .addOption('middle', 'Middle-click (default)')
          .addOption('right', 'Right-click')
          .addOption('either', 'Middle or right-click')
          .setValue(this.plugin.settings.panButton ?? 'middle')
          .onChange(async (value) => {
            this.plugin.settings.panButton = value as 'middle' | 'right' | 'either';
            await this.plugin.saveSettings();
          })
      );
  }

  private buildToolbarPosition(setting: Setting): void {
    setting
      .setName('Toolbar position')
      .setDesc('Where the card-creation toolbar appears on the canvas. Takes effect when you next open a board.')
      .addDropdown(dd =>
        dd
          .addOption('left',   'Left')
          .addOption('right',  'Right')
          .addOption('top',    'Top')
          .addOption('bottom', 'Bottom')
          .setValue(this.plugin.settings.toolbarPosition ?? 'left')
          .onChange(async (value) => {
            this.plugin.settings.toolbarPosition = value as 'left' | 'right' | 'top' | 'bottom';
            await this.plugin.saveSettings();
          })
      );
  }

  private buildMobileFabPosition(setting: Setting): void {
    setting
      .setName('Mobile "+" button position')
      .setDesc('Corner the phone-width add-card button sits in. Move it if it overlaps the minimap/zoom/snap controls. Takes effect when you next open a board.')
      .addDropdown(dd =>
        dd
          .addOption('bottom-right', 'Bottom right')
          .addOption('bottom-left', 'Bottom left')
          .addOption('top-right', 'Top right')
          .addOption('top-left', 'Top left')
          .setValue(this.plugin.settings.mobileFabPosition ?? 'bottom-right')
          .onChange(async (value) => {
            this.plugin.settings.mobileFabPosition = value as 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
            await this.plugin.saveSettings();
          })
      );
  }

  private buildDotColor(setting: Setting): void {
    setting
      .setName('Grid dot color')
      .setDesc('Color of the dot grid on the freeform canvas background. Updates any open board live.')
      .addColorPicker(c =>
        c
          .setValue(this.plugin.settings.dotColor ?? '#d2d2d2')
          .onChange(async (value) => {
            this.plugin.settings.dotColor = value;
            this.plugin.applyCanvasAppearanceSettings();
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.dotColor = undefined;
          this.plugin.applyCanvasAppearanceSettings();
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  private buildDotSize(setting: Setting): void {
    setting
      .setName('Grid dot size')
      .setDesc('Radius of each dot in pixels. Updates any open board live.')
      .addSlider(s =>
        s
          .setLimits(1, 6, 1)
          .setValue(this.plugin.settings.dotSize ?? 2)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.dotSize = value;
            this.plugin.applyCanvasAppearanceSettings();
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.dotSize = undefined;
          this.plugin.applyCanvasAppearanceSettings();
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  private buildCanvasBgColor(setting: Setting): void {
    setting
      .setName('Canvas background color')
      .setDesc('Background color of the freeform canvas itself. Updates any open board live.')
      .addColorPicker(c =>
        c
          .setValue(this.plugin.settings.canvasBgColor ?? '#e6e6e6')
          .onChange(async (value) => {
            this.plugin.settings.canvasBgColor = value;
            this.plugin.applyCanvasAppearanceSettings();
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.canvasBgColor = undefined;
          this.plugin.applyCanvasAppearanceSettings();
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  private buildCardDragAnimation(setting: Setting): void {
    setting
      .setName('Card drag animation')
      .setDesc('Lift, tilt, and settle a card as you drag it around the canvas. Takes effect the next time you open a board.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.cardDragAnimation ?? true)
          .onChange(async (value) => {
            this.plugin.settings.cardDragAnimation = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private buildCardDragAnimationIntensity(setting: Setting): void {
    setting
      .setName('Card drag animation intensity')
      .setDesc('How pronounced the lift/tilt effect is. Takes effect the next time you open a board.')
      .addSlider(s =>
        s
          .setLimits(0.5, 2, 0.1)
          .setValue(this.plugin.settings.cardDragAnimationIntensity ?? 1)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cardDragAnimationIntensity = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.cardDragAnimationIntensity = undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  private buildSnapToGrid(setting: Setting): void {
    setting
      .setName('Snap to grid')
      .setDesc('Dragging, resizing, or placing a card on the freeform canvas snaps it to a grid. Can also be toggled per-session with the magnet button on the canvas. Takes effect the next time you open a board.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.snapToGrid ?? true)
          .onChange(async (value) => {
            this.plugin.settings.snapToGrid = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private buildGridSize(setting: Setting): void {
    setting
      .setName('Grid size')
      .setDesc('Spacing in pixels of the snap-to-grid. Default: 32.')
      .addSlider(s =>
        s
          .setLimits(8, 80, 8)
          .setValue(this.plugin.settings.snapGridSize ?? 32)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.snapGridSize = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.snapGridSize = undefined;
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  // Stored as a unitless multiplier, shown as a percentage — the slider
  // steps in whole 10% increments so the label stays free of float noise.
  private buildTextScale(setting: Setting): void {
    setting
      .setName('Card text size')
      .setDesc('Scales the text on every card. Does not resize the plugin\'s own toolbars and panels. Individual Notes can override this from their Aa button. Updates any open board live. Default: 100%.')
      .addSlider(s =>
        s
          .setLimits(100, 250, 10)
          .setValue(Math.round((this.plugin.settings.textScale ?? 1) * 100))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.textScale = value / 100;
            this.plugin.applyCanvasAppearanceSettings();
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.textScale = undefined;
          this.plugin.applyCanvasAppearanceSettings();
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  private buildTrashZoneSize(setting: Setting): void {
    setting
      .setName('Trash zone size')
      .setDesc('Diameter in pixels of the delete-by-drag circle in the bottom-left corner of the freeform canvas. Updates any open board live. Default: 56.')
      .addSlider(s =>
        s
          .setLimits(32, 96, 4)
          .setValue(this.plugin.settings.trashZoneSize ?? 56)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.trashZoneSize = value;
            this.plugin.applyCanvasAppearanceSettings();
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn.setButtonText('Default').onClick(async () => {
          this.plugin.settings.trashZoneSize = undefined;
          this.plugin.applyCanvasAppearanceSettings();
          await this.plugin.saveSettings();
          this.refresh();
        })
      );
  }

  private buildLargeKanbanItems(setting: Setting): void {
    setting
      .setName('Larger kanban cards')
      .setDesc('Bigger text, padding, and icon badges on kanban items. Takes effect the next time you open a board.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.largeKanbanItems ?? false)
          .onChange(async (value) => {
            this.plugin.settings.largeKanbanItems = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private buildBookmarkCacheDuration(setting: Setting): void {
    setting
      .setName('Bookmark cache duration')
      .setDesc('Days before bookmark previews are automatically re-fetched. Default: 30.')
      .addText(text => {
        text
          .setPlaceholder('30')
          .setValue(String(this.plugin.settings.bookmarkCacheDays ?? 30))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.bookmarkCacheDays = (!isNaN(n) && n > 0) ? n : undefined;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.addClass('visual-notes-bookmark-days-input');
      });
  }

  private buildDefaultStickyColor(setting: Setting): void {
    setting
      .setName('Default sticky colour')
      .setDesc('Colour used when creating new sticky notes.');

    const stickyPalette = setting.controlEl.createDiv('visual-notes-settings-sticky-palette');
    const currentColor = resolveDefaultStickyColor(this.plugin.settings.defaultStickyColor);
    for (const { color } of STICKY_COLORS()) {
      const sw = stickyPalette.createDiv('visual-notes-modal-swatch');
      sw.style.backgroundColor = color;
      if (color === currentColor) sw.addClass('is-selected');
      sw.addEventListener('click', () => { void (async () => {
        stickyPalette.querySelectorAll<HTMLElement>('.visual-notes-modal-swatch').forEach(s => s.removeClass('is-selected'));
        sw.addClass('is-selected');
        this.plugin.settings.defaultStickyColor = color;
        await this.plugin.saveSettings();
      })(); });
    }
  }

  private buildCommentAuthorName(setting: Setting): void {
    setting
      .setName('Comment author name')
      .setDesc('Shown on new comments and replies you add to a board. Defaults to "Anonymous" when left blank.')
      .addText(text =>
        text
          .setPlaceholder('Anonymous')
          .setValue(this.plugin.settings.commentAuthorName ?? '')
          .onChange(async (value) => {
            this.plugin.settings.commentAuthorName = value.trim() || undefined;
            await this.plugin.saveSettings();
          })
      );
  }

  private buildAutoSortAssets(setting: Setting): void {
    setting
      .setName('Auto-sort assets')
      .setDesc('All images, audio, video, and documents imported or linked into a board are automatically moved to _Assets/Images/, _Assets/Audio/, etc. in the vault root. Always on.')
      .addText(t => { t.inputEl.disabled = true; t.setValue('Enabled'); });
  }

  private buildAutoRelinkOnOpen(setting: Setting): void {
    setting
      .setName('Auto-relink on board open')
      .setDesc('When a board opens, silently scan for broken file links and fix any that have a unique filename match in the vault.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoRelinkOnOpen ?? false)
          .onChange(async (value) => {
            this.plugin.settings.autoRelinkOnOpen = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private buildRelinkAllBoardsNow(setting: Setting): void {
    setting
      .setName('Relink all boards now')
      .setDesc('Scan every Visual Notes file in the vault and fix broken links with a unique filename match. Useful after moving files.')
      .addButton(btn =>
        btn.setButtonText('Relink now').onClick(() => { void (async () => {
          btn.setButtonText('Scanning…');
          btn.buttonEl.disabled = true;
          const n = await relinkAllBoards(this.app);
          btn.setButtonText('Relink now');
          btn.buttonEl.disabled = false;
          new Notice(n > 0
            ? `Fixed ${n} broken link${n === 1 ? '' : 's'} across all boards.`
            : 'No broken links found.');
        })(); })
      );
  }

  private buildExportTilesJson(setting: Setting): void {
    setting
      .setName('Export tiles as JSON')
      .setDesc('Copy all your tile data to the clipboard as JSON.')
      .addButton(btn =>
        btn.setButtonText('Copy to clipboard').onClick(() => { void (async () => {
          const json = JSON.stringify(this.plugin.settings.rootTiles, null, 2);
          await navigator.clipboard.writeText(json);
          new Notice('Tile data copied to clipboard.');
        })(); })
      );
  }

  private buildImportDesc(setting: Setting): void {
    setting.setName('Import tiles from JSON').setDesc(
      'Paste JSON exported from another vault. This will replace all existing tiles. ' +
      'Make sure the JSON is an array of tile objects.'
    );

    const importArea = setting.settingEl.createEl('textarea', {
      cls: 'visual-notes-settings-import-area',
      placeholder: '[\n  { "id": "...", "label": "...", ... }\n]',
    });
    importArea.addEventListener('input', () => {
      this.importText = importArea.value;
    });
    this.importAreaEl = importArea;
  }

  private buildImportButton(setting: Setting): void {
    setting
      .addButton(btn =>
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(() => {
            if (!this.importText.trim()) {
              new Notice('Paste some JSON first.');
              return;
            }
            let raw: unknown;
            try {
              raw = JSON.parse(this.importText);
            } catch {
              new Notice('Invalid JSON — please check the format and try again.');
              return;
            }
            // Validated before it can replace anything: an array of the wrong
            // shape used to be accepted and persisted, then failed later at
            // render time with nothing pointing back to the import.
            const result = validateTileImport(raw);
            if ('error' in result) {
              new Notice(`Import cancelled — ${result.error}`);
              return;
            }
            const parsed = result.tiles;
            new ConfirmModal(
              this.app,
              `Replace all ${this.plugin.settings.rootTiles.length} existing tile(s) with the imported data?`,
              () => { void (async () => {
                // Keep the outgoing tiles recoverable: replacement is
                // destructive and the only copy otherwise lives in whatever
                // the user happened to export. Deliberately NOT legacyBackup —
                // that holds the one-time v1 migration copy, which migration.ts
                // tells the user about by name.
                this.plugin.settings.preImportBackup = this.plugin.settings.rootTiles;
                this.plugin.settings.rootTiles = parsed;
                await this.plugin.saveSettings();
                if (this.importAreaEl) this.importAreaEl.value = '';
                this.importText = '';
                new Notice(`Imported ${parsed.length} tile(s).`);
              })(); }
            ).open();
          })
      );
  }

  private buildResetAllTiles(setting: Setting): void {
    setting
      .setName('Reset all tiles')
      .setDesc('Permanently delete every tile and nested board. This cannot be undone.')
      .addButton(btn => {
        // The destructive red styling on every supported version, without
        // referencing setWarning() (deprecated) or setDestructive()
        // (1.13-only, above our minAppVersion).
        btn.buttonEl.addClass('mod-warning');
        return btn
          .setButtonText('Reset everything')
          .onClick(() => {
            new ConfirmModal(
              this.app,
              `Delete all ${this.plugin.settings.rootTiles.length} tile(s)? This cannot be undone.`,
              () => { void (async () => {
                this.plugin.settings.rootTiles = [];
                await this.plugin.saveSettings();
                new Notice('All tiles deleted.');
              })(); }
            ).open();
          });
      });
  }
}
