import { App, PluginSettingTab, Setting, Notice, FuzzySuggestModal, Platform, TFile, type SettingDefinitionItem } from 'obsidian';
import type VisualNotesPlugin from './main';
import { ConfirmModal } from './tile-modal';
import { FolderSuggestModal } from './create-board-modal';
import { validateTileImport } from './settings-validate';
import { relinkAllBoards } from './asset-manager';
import { STICKY_COLORS, resolveDefaultStickyColor } from './freeform-view-shared';
import {
  COLLABORATOR_COLORS, ensureCollaborationIdentity, regenerateCollaborationClientId,
} from './collaboration-identity';
import { isSafeCollaborationServerUrl } from './collaboration-websocket-transport';
import { isPrivateNetworkCollaborationUrl } from './collaboration-private-network';

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
      { type: 'group', heading: 'Experimental collaboration', items: [
        { name: 'Enable collaboration experiments', desc: 'Enables opt-in private-network collaboration. A participant hosts room updates and shared media; Visual Notes operates no cloud service.',
          render: (s) => this.buildExperimentalCollaboration(s) },
        { name: 'Private-network server address', desc: 'Address supplied by your LAN, VPN, or virtual-network provider.',
          render: (s) => this.buildCollaborationPrivateNetworkUrl(s) },
        { name: 'Private-network server secret', desc: 'A high-entropy secret shared inside private-network invitations.',
          render: (s) => this.buildCollaborationPrivateNetworkToken(s) },
        { name: 'Host from this device', desc: 'Start and stop the bundled private-room server on desktop.',
          render: (s) => this.buildCollaborationPrivateNetworkHost(s) },
        { name: 'Your collaborator name', desc: 'The name experimental shared sessions show to other collaborators.',
          render: (s) => this.buildCollaborationDisplayName(s) },
        { name: 'Your collaborator colour', desc: 'The colour experimental cursors, selections, and presence indicators use.',
          render: (s) => this.buildCollaborationColor(s) },
        { name: 'This device ID', desc: 'A random identifier for this installation, used to distinguish edits from different devices. It is not an account or a tracking identifier.',
          render: (s) => this.buildCollaborationClientId(s) },
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
    const scrollTop = this.containerEl.scrollTop;
    this.renderImperative();
    this.containerEl.scrollTop = scrollTop;
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

    new Setting(containerEl).setName('Experimental collaboration').setHeading();
    this.buildExperimentalCollaboration(new Setting(containerEl));
    this.buildCollaborationPrivateNetworkUrl(new Setting(containerEl));
    this.buildCollaborationPrivateNetworkToken(new Setting(containerEl));
    this.buildCollaborationPrivateNetworkHost(new Setting(containerEl));
    this.buildCollaborationDisplayName(new Setting(containerEl));
    this.buildCollaborationColor(new Setting(containerEl));
    this.buildCollaborationClientId(new Setting(containerEl));

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

  private buildExperimentalCollaboration(setting: Setting): void {
    setting
      .setName('Enable collaboration experiments')
      .setDesc('Enables opt-in private-network collaboration. A participant hosts room updates and shared media; Visual Notes operates no cloud service.');
    // Rendered either way so the row never silently disappears: a reader who
    // has heard of the feature gets told why it is unavailable and what to do.
    if (!this.plugin.supportsCollaboration()) {
      setting.descEl.createDiv('visual-notes-setting-warning').setText(
        'Unavailable on this Obsidian version. Collaboration keeps its server secret in Obsidian’s secure storage, added in Obsidian 1.11.4. Update Obsidian to use it; every other Visual Notes feature works as normal.'
      );
      setting.addToggle(toggle => toggle.setValue(false).setDisabled(true));
      return;
    }
    setting.addToggle(toggle => toggle
      .setValue(this.plugin.settings.experimentalCollaboration ?? false)
      .onChange(async (value) => {
        this.plugin.settings.experimentalCollaboration = value;
        if (value) this.plugin.settings.collaborationTransport = 'private-network';
        await this.plugin.saveSettings();
      }));
  }

  private buildCollaborationPrivateNetworkUrl(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.supportsCollaboration()
      && this.plugin.settings.collaborationTransport === 'private-network');
    setting
      .setName('Private-network server address')
      .setDesc('Use the host address supplied by your physical LAN, VPN, or virtual-network provider. Private IPs and encrypted wss:// addresses are accepted.')
      .addText(text => text
        .setPlaceholder('ws://100.64.0.10:8787')
        .setValue(this.plugin.settings.collaborationPrivateNetworkUrl ?? '')
        .onChange(async value => {
          this.plugin.settings.collaborationPrivateNetworkUrl = value.trim() || undefined;
          await this.plugin.saveSettings();
        }));
    const configured = this.plugin.settings.collaborationPrivateNetworkUrl?.trim();
    if (configured && !isPrivateNetworkCollaborationUrl(configured)) {
      setting.descEl.createDiv('visual-notes-setting-warning').setText(
        'Unsafe address: use wss:// or a loopback, private LAN, Tailscale, .local, or private IPv6 address.'
      );
    }
  }

  private buildCollaborationPrivateNetworkToken(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.supportsCollaboration()
      && this.plugin.settings.collaborationTransport === 'private-network');
    setting
      .setName('Private-network server secret')
      .setDesc(this.plugin.hasPrivateNetworkServerSecret()
        ? 'Stored in Obsidian SecretStorage. It is included in room invitations, so treat invitations like passwords.'
        : 'No server secret is stored yet. One is generated automatically when hosting starts.')
      .addButton(button => button
        .setButtonText(this.plugin.hasPrivateNetworkServerSecret() ? 'Rotate secret' : 'Generate secret')
        .setDisabled(this.plugin.privateNetworkHostStatus().state !== 'stopped')
        .onClick(() => {
        this.plugin.generatePrivateNetworkServerSecret();
        this.refresh();
      }));
  }

  private buildCollaborationPrivateNetworkHost(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.supportsCollaboration()
      && this.plugin.settings.collaborationTransport === 'private-network');
    setting.setName('Host from this device');
    if (!Platform.isDesktopApp) {
      setting.setDesc('This device can join private rooms. Hosting is currently available on desktop only.');
      return;
    }
    const status = this.plugin.privateNetworkHostStatus();
    setting.setDesc(status.state === 'running' && status.address
      ? `Running on ${status.address.address}:${status.port}. Keep Obsidian open while others collaborate.`
      : status.state === 'error' ? `Host stopped: ${status.error ?? 'Unknown error'}`
      : status.state === 'starting' ? 'Starting private collaboration host…'
      : 'Runs the room server on this computer. Board data and shared media stay with the host.');

    let selectedAddress = this.plugin.settings.collaborationPrivateNetworkHostAddress ?? '';
    setting.addDropdown(dropdown => {
      dropdown.addOption('', 'Detecting networks…').setValue('');
      void this.plugin.privateNetworkHostAddresses().then(addresses => {
        dropdown.selectEl.empty();
        if (addresses.length === 0) {
          dropdown.addOption('', 'No private network found').setDisabled(true);
          return;
        }
        for (const address of addresses) {
          const kind = address.kind === 'tailscale' ? 'Tailscale' : address.kind === 'private-lan' ? 'LAN/VPN' : 'Private IPv6';
          dropdown.addOption(address.address, `${kind} · ${address.name} · ${address.address}`);
        }
        if (!addresses.some(address => address.address === selectedAddress)) selectedAddress = addresses[0].address;
        dropdown.setValue(selectedAddress);
      }).catch(error => {
        dropdown.selectEl.empty();
        const message = error instanceof Error ? error.message : 'Unknown error';
        dropdown.addOption('', `Network detection failed: ${message}`).setDisabled(true);
        setting.setDesc(`Network detection failed: ${message}`);
      });
      dropdown.onChange(async value => {
        selectedAddress = value;
        this.plugin.settings.collaborationPrivateNetworkHostAddress = value || undefined;
        await this.plugin.saveSettings();
      });
    });

    setting.addText(text => {
      text.setPlaceholder('8787').setValue(String(this.plugin.settings.collaborationPrivateNetworkPort ?? 8787));
      text.inputEl.type = 'number';
      text.inputEl.min = '1024';
      text.inputEl.max = '65535';
      text.onChange(async value => {
        const port = Number(value);
        this.plugin.settings.collaborationPrivateNetworkPort = Number.isInteger(port) && port >= 1024 && port <= 65535
          ? port : undefined;
        await this.plugin.saveSettings();
      });
    });

    if (status.state === 'running' || status.state === 'starting') {
      setting.addButton(button => button.setButtonText('Stop hosting').setWarning().onClick(async () => {
        button.setDisabled(true);
        await this.plugin.stopPrivateNetworkHost();
        new Notice('Private collaboration host stopped.');
        this.refresh();
      }));
    } else {
      setting.addButton(button => button.setButtonText('Start hosting').setCta().onClick(async () => {
        button.setDisabled(true).setButtonText('Starting…');
        try {
          const addresses = await this.plugin.privateNetworkHostAddresses();
          const address = addresses.find(candidate => candidate.address === selectedAddress) ?? addresses[0];
          if (!address) throw new Error('No private LAN or virtual-network address was detected.');
          const result = await this.plugin.startPrivateNetworkHost(address);
          if (result.state !== 'running') throw new Error(result.error ?? 'The host did not start.');
          new Notice(`Private collaboration host is running on ${address.address}:${result.port}.`);
          this.refresh();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : 'Could not start private collaboration host.', 10000);
          button.setDisabled(false).setButtonText('Start hosting');
        }
      }));
    }
  }

  private buildCollaborationServerUrl(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket');
    setting
      .setName('Development server URL')
      .setDesc('Accepts local unencrypted ws:// or encrypted wss://. Invalid or unsafe URLs fall back to loopback.')
      .addText(text => text
        .setPlaceholder('ws://127.0.0.1:8787')
        .setValue(this.plugin.settings.collaborationServerUrl ?? '')
        .onChange(async value => {
          const trimmed = value.trim();
          this.plugin.settings.collaborationServerUrl = trimmed || undefined;
          await this.plugin.saveSettings();
        }));
    const configured = this.plugin.settings.collaborationServerUrl?.trim();
    if (configured && !isSafeCollaborationServerUrl(configured)) {
      setting.descEl.createDiv('visual-notes-setting-warning').setText('Unsafe URL: use wss://, ws://localhost, or ws://127.0.0.1. Loopback will be used instead.');
    }
  }

  private buildCollaborationDevelopmentToken(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket'
      && this.plugin.settings.collaborationAuthentication !== 'oidc');
    setting
      .setName('Development server token')
      .setDesc('Shared local-development token only. Production authentication will replace this before release.')
      .addText(text => {
        text.setPlaceholder('visual-notes-local-dev')
          .setValue(this.plugin.settings.collaborationDevelopmentToken ?? '')
          .onChange(async value => {
            this.plugin.settings.collaborationDevelopmentToken = value || undefined;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });
  }

  private buildCollaborationAuthentication(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket');
    setting
      .setName('Collaboration authentication')
      .setDesc('Development token preserves the current local workflow. Browser sign-in uses OAuth Authorization Code + PKCE and is intended for the future hosted service.')
      .addDropdown(dropdown => dropdown
        .addOption('development', 'Development token')
        .addOption('oidc', 'Browser account sign-in')
        .setValue(this.plugin.settings.collaborationAuthentication ?? 'development')
        .onChange(async value => {
          this.plugin.settings.collaborationAuthentication = value as 'development' | 'oidc';
          await this.plugin.saveSettings();
          this.refresh();
        }));
  }

  private buildCollaborationOidcIssuer(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket'
      && this.plugin.settings.collaborationAuthentication === 'oidc');
    setting
      .setName('Identity provider issuer')
      .setDesc('HTTPS issuer URL from the hosted identity provider, for example https://accounts.example.com. Discovery is automatic.')
      .addText(text => text
        .setPlaceholder('https://accounts.example.com')
        .setValue(this.plugin.settings.collaborationOidcIssuer ?? '')
        .onChange(async value => {
          this.plugin.signOutCollaboration();
          this.plugin.settings.collaborationOidcIssuer = value.trim() || undefined;
          await this.plugin.saveSettings();
        }));
  }

  private buildCollaborationOidcClientId(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket'
      && this.plugin.settings.collaborationAuthentication === 'oidc');
    setting
      .setName('Identity provider client ID')
      .setDesc('Public native-app client ID. Visual Notes never accepts or stores an OAuth client secret.')
      .addText(text => text
        .setPlaceholder('visual-notes-desktop')
        .setValue(this.plugin.settings.collaborationOidcClientId ?? '')
        .onChange(async value => {
          this.plugin.signOutCollaboration();
          this.plugin.settings.collaborationOidcClientId = value.trim() || undefined;
          await this.plugin.saveSettings();
        }));
  }

  private buildCollaborationOidcScope(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket'
      && this.plugin.settings.collaborationAuthentication === 'oidc');
    setting
      .setName('Identity provider scopes')
      .setDesc('Defaults to openid profile email offline_access. offline_access lets the installation renew an expired access token.')
      .addText(text => text
        .setPlaceholder('openid profile email offline_access')
        .setValue(this.plugin.settings.collaborationOidcScope ?? '')
        .onChange(async value => {
          this.plugin.settings.collaborationOidcScope = value.trim() || undefined;
          await this.plugin.saveSettings();
        }));
  }

  private buildCollaborationOidcAudience(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket'
      && this.plugin.settings.collaborationAuthentication === 'oidc');
    setting
      .setName('Collaboration API audience')
      .setDesc('API identifier configured at the identity provider. Auth0 requires this to issue a token for the Visual Notes collaboration service.')
      .addText(text => text
        .setPlaceholder('https://collaboration.visualnotes.example')
        .setValue(this.plugin.settings.collaborationOidcAudience ?? '')
        .onChange(async value => {
          this.plugin.signOutCollaboration();
          this.plugin.settings.collaborationOidcAudience = value.trim() || undefined;
          await this.plugin.saveSettings();
        }));
  }

  private buildCollaborationAccount(setting: Setting): void {
    setting.settingEl.toggle(this.plugin.settings.collaborationTransport === 'websocket'
      && this.plugin.settings.collaborationAuthentication === 'oidc');
    const status = this.plugin.collaborationAuthStatus();
    const statusText = status.signedIn
      ? `Signed in locally${status.expiresAt ? `; access token expires ${new Date(status.expiresAt).toLocaleString()}` : ''}.`
      : 'Not signed in.';
    setting.setName('Collaboration account').setDesc(statusText);
    if (status.signedIn) {
      setting.addButton(button => button.setButtonText('Find my rooms').onClick(() => { void (async () => {
        button.setDisabled(true).setButtonText('Checking…');
        try {
          const rooms = await this.plugin.listCollaborationAccountRooms();
          setting.setDesc(rooms.length === 0
            ? 'Signed in. This account does not own or belong to any hosted rooms yet.'
            : `Signed in. Found ${rooms.length} hosted root room${rooms.length === 1 ? '' : 's'} for this account.`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : 'Could not load account rooms.');
        } finally {
          button.setDisabled(false).setButtonText('Find my rooms');
        }
      })(); }));
      setting.addButton(button => button.setButtonText('Sign out').onClick(() => {
        this.plugin.signOutCollaboration();
        setting.setDesc('Not signed in.');
        button.setButtonText('Signed out').setDisabled(true);
        new Notice('Signed out of experimental collaboration on this installation.');
      }));
    } else {
      setting.addButton(button => button.setButtonText('Sign in with browser').setCta().onClick(() => { void (async () => {
        button.setDisabled(true).setButtonText('Opening browser…');
        try {
          await this.plugin.beginCollaborationSignIn();
          setting.setDesc('Finish signing in in your browser, then return to Obsidian.');
        } catch (error) {
          new Notice(error instanceof Error ? error.message : 'Could not begin collaboration sign-in.');
          button.setDisabled(false).setButtonText('Sign in with browser');
        }
      })(); }));
    }
  }

  private buildCollaborationDisplayName(setting: Setting): void {
    setting
      .setName('Your collaborator name')
      .setDesc('The name experimental shared sessions show to other collaborators.')
      .addText(text => text
        .setPlaceholder('Anonymous')
        .setValue(this.plugin.settings.collaborationDisplayName ?? '')
        .onChange(async (value) => {
          this.plugin.settings.collaborationDisplayName = value.trim() || undefined;
          await this.plugin.saveSettings();
        }));
  }

  private buildCollaborationColor(setting: Setting): void {
    const identity = ensureCollaborationIdentity(
      this.plugin.settings, undefined, window.localStorage, this.app.vault.getName()
    ).identity;
    setting
      .setName('Your collaborator colour')
      .setDesc('Choose the colour used for your cursor, selections, and presence indicator.');
    const palette = setting.controlEl.createDiv('visual-notes-collaboration-colour-palette');
    for (const colour of COLLABORATOR_COLORS) {
      const swatch = palette.createEl('button', {
        cls: `visual-notes-collaboration-colour-swatch${identity.color === colour ? ' is-selected' : ''}`,
        attr: { 'aria-label': `Use collaborator colour ${colour}`, type: 'button' },
      });
      swatch.style.backgroundColor = colour;
      swatch.addEventListener('click', () => { void (async () => {
        this.plugin.settings.collaborationColor = colour;
        await this.plugin.saveSettings();
        for (const option of palette.querySelectorAll('.visual-notes-collaboration-colour-swatch')) {
          option.toggleClass('is-selected', option === swatch);
        }
      })(); });
    }
  }

  private buildCollaborationClientId(setting: Setting): void {
    const identity = ensureCollaborationIdentity(
      this.plugin.settings, undefined, window.localStorage, this.app.vault.getName()
    ).identity;
    setting
      .setName('This device ID')
      .setDesc('Random local installation ID. Regenerating it makes future sessions treat this device as a new collaborator.')
      .addText(text => {
        text.setValue(identity.clientId);
        text.inputEl.disabled = true;
      })
      .addButton(button => button.setButtonText('Copy').onClick(() => { void (async () => {
        await navigator.clipboard.writeText(identity.clientId);
        new Notice('Visual Notes: Device ID copied.');
      })(); }))
      .addButton(button => button.setButtonText('Regenerate').onClick(() => { void (async () => {
        regenerateCollaborationClientId(
          this.plugin.settings, undefined, window.localStorage, this.app.vault.getName()
        );
        await this.plugin.saveSettings();
        this.refresh();
        new Notice('Visual Notes: This device now has a new collaboration ID.');
      })(); }));
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
