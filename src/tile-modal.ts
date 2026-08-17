import {
  App,
  Modal,
  Setting,
  FuzzySuggestModal,
  TFolder,
  TFile,
  Notice,
  setIcon,
} from 'obsidian';
import { TileCard, TileTarget } from './file-types';
import { IconPickerModal } from './icon-picker';
import { contrastColor } from './color-utils';
import { createBoardFile } from './file-io';
import { isCustomIconRef, resolveCustomIconSrc } from './custom-icons';
import { runCommand, KANBAN_CREATE_BOARD_COMMAND } from './obsidian-commands';

/** Typed wrapper for private Obsidian APIs used in tile-modal. */
interface AppWithPrivateAPIs extends App {
  plugins?: { enabledPlugins?: Set<string> };
}

const COLOR_PALETTE = [
  '#EF4444', '#F59E0B', '#EAB308', '#84CC16',
  '#10B981', '#06B6D4', '#3B82F6', '#8B5CF6',
  '#EC4899', '#64748B', '#44403C', '#FFFFFF',
];

// ── Path fuzzy-suggest ────────────────────────────────────────

class PathSuggestModal extends FuzzySuggestModal<string> {
  private paths: string[];
  private onChoose: (path: string) => void;

  constructor(app: App, paths: string[], onChoose: (path: string) => void) {
    super(app);
    this.paths = paths;
    this.onChoose = onChoose;
    this.setPlaceholder('Type to search…');
  }

  getItems(): string[] { return this.paths; }
  getItemText(item: string): string { return item; }
  onChooseItem(item: string): void { this.onChoose(item); }
}

// ── Confirm modal ─────────────────────────────────────────────

export class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  // confirmLabel defaults to 'Delete' — every original caller confirms a
  // deletion; pass it for any other destructive action (e.g. 'Replace').
  constructor(app: App, message: string, onConfirm: () => void, private confirmLabel = 'Delete') {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message });
    const btnRow = contentEl.createDiv('visual-notes-modal-buttons');
    btnRow.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());
    const delBtn = btnRow.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
    delBtn.addEventListener('click', () => { this.onConfirm(); this.close(); });
  }

  override onClose(): void { this.contentEl.empty(); }
}

// ── Board name prompt ─────────────────────────────────────────

export class NamePromptModal extends Modal {
  constructor(app: App, private heading: string, private placeholder: string, private onCreate: (name: string) => void, private initial = '', private confirmLabel = 'Create') { super(app); }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.heading });
    const input = contentEl.createEl('input', { type: 'text', placeholder: this.placeholder, value: this.initial });
    input.addClass('visual-notes-board-name-input');
    const row = contentEl.createDiv('visual-notes-modal-buttons');
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const btn = row.createEl('button', { text: this.confirmLabel, cls: 'mod-cta' });
    btn.addEventListener('click', () => {
      const name = input.value.trim();
      if (!name) { new Notice('Enter a name.'); return; }
      this.onCreate(name); this.close();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    window.setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  override onClose(): void { this.contentEl.empty(); }
}

// ── Thumbnail pickers ─────────────────────────────────────────

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];

class ThumbnailImageSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder('Search for an image in your vault…');
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => IMAGE_EXTENSIONS.includes(f.extension));
  }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}

class ThumbnailUrlModal extends Modal {
  constructor(app: App, private initialValue: string, private onSubmit: (url: string) => void) { super(app); }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Thumbnail image URL' });
    const input = contentEl.createEl('input', { type: 'text', placeholder: 'https://…', value: this.initialValue });
    input.addClass('visual-notes-board-name-input');
    window.setTimeout(() => input.focus(), 50);
    const row = contentEl.createDiv('visual-notes-modal-buttons');
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const btn = row.createEl('button', { text: 'Save', cls: 'mod-cta' });
    const submit = () => { this.close(); this.onSubmit(input.value.trim()); };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  override onClose(): void { this.contentEl.empty(); }
}

// ── Tile modal ────────────────────────────────────────────────

type TargetKind = TileTarget['kind'];

export class TileModal extends Modal {
  private tile: Partial<TileCard>;
  private targetKind: TargetKind;
  private targetPath: string;
  private onSave: (tile: TileCard) => void;
  private isEditing: boolean;
  private currentFile: TFile | null;

  constructor(app: App, existingTile: TileCard | null, onSave: (tile: TileCard) => void, currentFile: TFile | null = null, initialKind?: TargetKind) {
    super(app);
    this.onSave = onSave;
    this.isEditing = existingTile !== null;
    this.currentFile = currentFile;

    if (existingTile) {
      this.tile = { ...existingTile };
      this.targetKind = existingTile.target.kind;
      this.targetPath = existingTile.target.path;
    } else {
      this.tile = {
        id: crypto.randomUUID(),
        kind: 'tile',
        label: '',
        icon: 'star',
        color: '#3B82F6',
      };
      this.targetKind = initialKind ?? 'board';
      this.targetPath = '';
    }

    this.modalEl.addClass('visual-notes-tile-modal');
  }

  override onOpen(): void { this.render(); }
  override onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.isEditing ? 'Edit Tile' : 'Add Tile' });

    // ── Label ──
    new Setting(contentEl)
      .setName('Label')
      .setDesc('Required — shown below the tile')
      .addText(text => {
        text.setPlaceholder('My Board').setValue(this.tile.label ?? '').onChange(v => {
          this.tile.label = v;
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    // ── Subtitle ──
    new Setting(contentEl)
      .setName('Subtitle')
      .setDesc('Optional — smaller text below the label')
      .addText(text =>
        text
          .setPlaceholder('e.g. "95 boards"')
          .setValue(this.tile.subtitle ?? '')
          .onChange(v => { this.tile.subtitle = v || undefined; })
      );

    // ── Icon ──
    // When a thumbnail image is set, it fully covers the tile and the icon
    // is never shown on the tile itself — so this whole section is hidden
    // outright rather than left visible-but-inert, which would still read
    // as "both are showing."
    const hasThumb = !!this.tile.thumbnail;
    const iconSetting = new Setting(contentEl).setName('Symbol');
    iconSetting.settingEl.style.display = hasThumb ? 'none' : '';
    const previewWrap = iconSetting.controlEl.createDiv('visual-notes-modal-icon-preview');
    // A custom asset icon is full art, not a glyph meant to sit on an
    // accent-colored chip — no background, same as the tile/badge renders.
    previewWrap.style.backgroundColor = isCustomIconRef(this.tile.icon) ? 'transparent' : (this.tile.color ?? '#3B82F6');
    const iconEl = previewWrap.createDiv('visual-notes-modal-icon-el');
    iconEl.style.color = contrastColor(this.tile.color ?? '#3B82F6');
    const isSingleEmoji =
      !!this.tile.icon &&
      [...this.tile.icon].length === 1 &&
      /\p{Emoji_Presentation}/u.test(this.tile.icon);
    const customSrc = isCustomIconRef(this.tile.icon) ? resolveCustomIconSrc(this.tile.icon) : undefined;
    if (customSrc) {
      iconEl.createEl('img', { attr: { src: customSrc }, cls: 'visual-notes-modal-custom-icon-img' });
    } else if (isSingleEmoji) {
      iconEl.setText(this.tile.icon!);
      iconEl.addClass('visual-notes-modal-emoji');
    } else {
      setIcon(iconEl, this.tile.icon ?? 'star');
    }
    iconSetting.addButton(btn => {
      btn.setButtonText('Choose symbol').onClick(() => {
        new IconPickerModal(this.app, this.tile.color ?? '#3B82F6', (selected, color) => {
          this.tile.icon = selected;
          this.tile.color = color;
          this.render();
        }).open();
      });
    });

    // ── Color ──
    const colorSetting = new Setting(contentEl).setName('Color');
    const palette = colorSetting.controlEl.createDiv('visual-notes-modal-palette');
    for (const hex of COLOR_PALETTE) {
      const swatch = palette.createDiv('visual-notes-modal-swatch');
      swatch.style.backgroundColor = hex;
      if (hex === this.tile.color) swatch.addClass('is-selected');
      if (hex === '#FFFFFF') swatch.addClass('has-border');
      swatch.addEventListener('click', () => { this.tile.color = hex; this.render(); });
    }
    const hexInput = colorSetting.controlEl.createEl('input', {
      type: 'text',
      placeholder: '#3B82F6',
      cls: 'visual-notes-modal-hex-input',
    });
    hexInput.value = this.tile.color ?? '#3B82F6';
    hexInput.addEventListener('change', () => {
      const val = hexInput.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) { this.tile.color = val; this.render(); }
    });

    const colorWheel = colorSetting.controlEl.createEl('input');
    colorWheel.type = 'color';
    colorWheel.value = this.tile.color ?? '#3B82F6';
    colorWheel.addClass('visual-notes-modal-color-wheel');
    colorWheel.addEventListener('input', () => {
      this.tile.color = colorWheel.value;
      previewWrap.style.backgroundColor = colorWheel.value;
      iconEl.style.color = contrastColor(colorWheel.value);
      hexInput.value = colorWheel.value;
      palette.querySelectorAll<HTMLElement>('.visual-notes-modal-swatch').forEach(s => s.removeClass('is-selected'));
    });
    colorWheel.addEventListener('change', () => { this.tile.color = colorWheel.value; this.render(); });

    // ── Thumbnail image (optional) ──
    const thumbSetting = new Setting(contentEl)
      .setName('Thumbnail image')
      .setDesc('Optional — replaces the icon with a cover image, Milanote-style.');

    const thumbPreview = thumbSetting.controlEl.createDiv('visual-notes-modal-thumbnail-preview');
    thumbPreview.style.cssText = 'width:64px;height:64px;border-radius:6px;overflow:hidden;'
      + 'background:var(--background-modifier-border);display:flex;align-items:center;'
      + 'justify-content:center;flex-shrink:0;font-size:12px;color:var(--text-faint);';
    const thumb = this.tile.thumbnail;
    if (thumb) {
      const src = thumb.type === 'vault'
        ? (() => { const f = this.app.vault.getAbstractFileByPath(thumb.path); return f instanceof TFile ? this.app.vault.getResourcePath(f) : ''; })()
        : thumb.url;
      if (src) {
        thumbPreview.createEl('img', { attr: { src } });
      }
    } else {
      thumbPreview.setText('None');
    }

    thumbSetting.addButton(btn =>
      btn.setButtonText('Choose from vault').onClick(() => {
        new ThumbnailImageSuggestModal(this.app, (file) => {
          this.tile.thumbnail = { type: 'vault', path: file.path };
          this.render();
        }).open();
      })
    );
    thumbSetting.addButton(btn =>
      btn.setButtonText('Use image URL').onClick(() => {
        const current = this.tile.thumbnail?.type === 'external' ? this.tile.thumbnail.url : '';
        new ThumbnailUrlModal(this.app, current, (url) => {
          if (!url) return;
          this.tile.thumbnail = { type: 'external', url };
          this.render();
        }).open();
      })
    );
    if (this.tile.thumbnail) {
      thumbSetting.addButton(btn =>
        btn.setButtonText('Clear').onClick(() => {
          this.tile.thumbnail = undefined;
          this.render();
        })
      );
    }

    // ── Kind dropdown ──
    new Setting(contentEl)
      .setName('Type')
      .addDropdown(dd =>
        dd
          .addOption('note', 'Note')
          .addOption('folder', 'Folder')
          .addOption('board', 'Visual Notes board (canvas or grid)')
          .setValue(this.targetKind)
          .onChange(v => {
            this.targetKind = v as TargetKind;
            this.targetPath = '';
            this.render();
          })
      );

    // ── Target path ──
    if (this.targetKind === 'kanban') {
      const isInstalled = (this.app as AppWithPrivateAPIs).plugins?.enabledPlugins?.has('obsidian-kanban') ?? false;
      const kanbanPaths = this.getKanbanPaths();

      const pathSetting = new Setting(contentEl)
        .setName('Kanban board')
        .setDesc('Choose a .md file managed by the Kanban plugin');

      const pathDisplay = pathSetting.controlEl.createSpan('visual-notes-modal-path-display' + (this.targetPath ? '' : ' is-empty'));
      pathDisplay.setText(this.targetPath || 'None selected');

      if (kanbanPaths.length > 0) {
        pathSetting.addButton(btn =>
          btn.setButtonText('Browse…').onClick(() => {
            new PathSuggestModal(this.app, kanbanPaths, selected => {
              this.targetPath = selected;
              this.render();
            }).open();
          })
        );
      } else if (isInstalled) {
        pathSetting.descEl.appendText(' — no Kanban boards found yet.');
      } else {
        pathSetting.descEl.appendText(' — install the community "Kanban" plugin first.');
      }

      if (isInstalled) {
        pathSetting.addButton(btn =>
          btn.setButtonText('Create new…').onClick(() => {
            this.close();
            runCommand(
              this.app,
              KANBAN_CREATE_BOARD_COMMAND,
              'Could not open the Kanban plugin’s "create board" command. Create the board from the Kanban plugin directly, then pick it here.',
            );
          })
        );
      }
    } else if (this.targetKind !== 'board') {
      const label = this.targetKind === 'folder' ? 'Folder'
        : this.targetKind === 'canvas' ? 'Canvas file'
        : 'Note';

      // Only a canvas target can be conjured from the label alone. A note or
      // folder tile is a link to something that already exists, so an empty
      // target there stays a validation error rather than silently spawning
      // an empty note the user never asked for.
      const createsOnSave = this.targetKind === 'canvas';

      const pathSetting = new Setting(contentEl)
        .setName('Target')
        .setDesc(createsOnSave
          ? 'Leave empty to create a new canvas named after the label, or choose an existing one.'
          : `Choose the ${label.toLowerCase()} to open when clicked`);

      const pathDisplay = pathSetting.controlEl.createSpan('visual-notes-modal-path-display' + (this.targetPath ? '' : ' is-empty'));
      pathDisplay.setText(this.targetPath || (createsOnSave ? 'New canvas from label' : 'None selected'));

      pathSetting.addButton(btn =>
        btn.setButtonText('Browse…').onClick(() => {
          const paths = this.getPathsForKind(this.targetKind as 'folder' | 'canvas' | 'note');
          new PathSuggestModal(this.app, paths, selected => {
            this.targetPath = selected;
            this.render();
          }).open();
        })
      );

      pathSetting.addButton(btn =>
        btn.setButtonText('Create new…').onClick(() => {
          const heading = this.targetKind === 'folder' ? 'New folder'
            : this.targetKind === 'canvas' ? 'New canvas'
            : 'New note';
          const placeholder = this.targetKind === 'folder' ? 'Folder name'
            : this.targetKind === 'canvas' ? 'Canvas name'
            : 'Note name';
          new NamePromptModal(this.app, heading, placeholder, (name) => { void (async () => {
            const basePath = this.currentFile?.parent?.path ?? '';
            const sep = basePath ? '/' : '';
            if (this.targetKind === 'folder') {
              const folderPath = basePath + sep + name;
              try {
                await this.app.vault.createFolder(folderPath);
                this.targetPath = folderPath;
                this.render();
              } catch { new Notice('Failed to create folder.'); }
            } else if (this.targetKind === 'canvas') {
              const filePath = basePath + sep + name + '.canvas';
              try {
                const f = await this.app.vault.create(filePath, '{"nodes":[],"edges":[]}');
                this.targetPath = f.path;
                this.render();
              } catch { new Notice('Failed to create canvas.'); }
            } else {
              const filePath = basePath + sep + name + '.md';
              try {
                const f = await this.app.vault.create(filePath, '');
                this.targetPath = f.path;
                this.render();
              } catch { new Notice('Failed to create note.'); }
            }
          })(); }).open();
        })
      );
    } else {
      // Board target: pick an existing .canvas board file or create a new
      // nested one.
      const boardPaths = this.getBoardPaths();

      const pathSetting = new Setting(contentEl)
        .setName('Target board')
        // Leaving this empty is the normal path, not an error — see
        // handleSaveClick. The board this tile lives on is deliberately not
        // offered (a tile linking to its own board would have nowhere to go),
        // so in a fresh vault there may be nothing to browse at all.
        .setDesc(boardPaths.length > 0
          ? 'Leave empty to create a new nested board named after the label, or choose an existing one.'
          : 'Leave empty to create a new nested board named after the label.');

      const pathDisplay = pathSetting.controlEl.createSpan('visual-notes-modal-path-display' + (this.targetPath ? '' : ' is-empty'));
      pathDisplay.setText(this.targetPath || 'New board from label');

      if (boardPaths.length > 0) {
        pathSetting.addButton(btn =>
          btn.setButtonText('Browse…').onClick(() => {
            new PathSuggestModal(this.app, boardPaths, selected => {
              this.targetPath = selected;
              this.render();
            }).open();
          })
        );
      }

      pathSetting.addButton(btn =>
        btn.setButtonText('Create new…').onClick(() => {
          new NamePromptModal(this.app, 'New nested board', 'Board name', (name) => { void (async () => {
            const newFile = await this.createNestedBoard(name);
            if (!newFile) return;
            this.targetPath = newFile.path;
            this.render();
          })(); }).open();
        })
      );
    }

    // ── Buttons ──
    const btnRow = contentEl.createDiv('visual-notes-modal-buttons');
    btnRow.createEl('button', { text: 'Cancel', cls: 'visual-notes-modal-cancel' })
      .addEventListener('click', () => this.close());

    // "Create" while adding, because the click can now genuinely create the
    // target file; "Save" while editing, where it only ever updates the tile.
    const saveBtn = btnRow.createEl('button', {
      text: this.isEditing ? 'Save' : 'Create',
      cls: 'mod-cta visual-notes-modal-save',
    });
    saveBtn.addEventListener('click', () => { void this.handleSaveClick(); });
  }

  // Creating the target is the default action rather than an error case: the
  // label almost always IS the name the new board should get, so demanding a
  // separate "Create new…" trip through NamePromptModal asked for the same
  // name twice. Browsing to an existing target still overrides this.
  private async handleSaveClick(): Promise<void> {
    const label = this.tile.label?.trim();
    // Checked before anything is created — trySave rejects an empty label
    // anyway, and creating the file first would leave a stray board behind
    // for a click that then failed validation.
    if (!label) { new Notice('Please enter a label.'); return; }

    if (!this.targetPath && (this.targetKind === 'board' || this.targetKind === 'canvas')) {
      const path = await this.createTargetFromLabel(label);
      if (!path) return;
      this.targetPath = path;
    }

    this.trySave();
  }

  // Returns the new file's path, or null if creation failed (the failure is
  // reported to the user here, so callers just bail).
  private async createTargetFromLabel(name: string): Promise<string | null> {
    if (this.targetKind === 'board') {
      const file = await this.createNestedBoard(name);
      return file?.path ?? null;
    }
    // 'canvas' — a plain Obsidian canvas, matching what "Create new…" makes
    // for this kind, and placed beside the current board rather than nested.
    const basePath = this.currentFile?.parent?.path ?? '';
    const sep = basePath ? '/' : '';
    try {
      const f = await this.app.vault.create(basePath + sep + name + '.canvas', '{"nodes":[],"edges":[]}');
      return f.path;
    } catch { new Notice('Failed to create canvas.'); return null; }
  }

  // Nested boards live in a folder named after the current board's stem, so a
  // board and the boards reached from it stay together. Shared by the
  // "Create new…" button and the create-on-save path so the two can't drift.
  private async createNestedBoard(name: string): Promise<TFile | null> {
    let folderPath = '';
    if (this.currentFile) {
      folderPath = this.currentFile.path.replace(/\.canvas$/, '');
    }
    if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
      try { await this.app.vault.createFolder(folderPath); } catch { /* already exists */ }
    }
    const folderAbstract = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : null;
    const folder = folderAbstract instanceof TFolder ? folderAbstract : null;
    try {
      return await createBoardFile(this.app, name, folder, 'freeform');
    } catch { new Notice('Failed to create board.'); return null; }
  }

  // Validation + save, extracted from the button handler so the self-link
  // guard is directly testable. Returns whether the tile was saved.
  private trySave(): boolean {
    if (!this.tile.label?.trim()) { new Notice('Please enter a label.'); return false; }
    if (!this.targetPath) { new Notice('Please select a target.'); return false; }
    // The picker lists already exclude the current board, but an edited
    // pre-existing tile (or one created before this guard) can still carry
    // a self-link — refuse to save it rather than recreate the "tile that
    // goes nowhere" confusion.
    if (this.currentFile && this.targetPath === this.currentFile.path) {
      new Notice('A tile can\'t link to the board it\'s on — pick a different target.');
      return false;
    }

    const previousTarget = this.tile.target;
    const roomId = previousTarget?.kind === 'board'
      && this.targetKind === 'board'
      && previousTarget.path === this.targetPath
      ? previousTarget.roomId : undefined;
    const target: TileTarget = this.targetKind === 'board'
      ? { kind: 'board', path: this.targetPath, ...(roomId ? { roomId } : {}) }
      : { kind: this.targetKind, path: this.targetPath };
    const saved: TileCard = {
      ...(this.tile as TileCard),
      target,
    };
    this.onSave(saved);
    this.close();
    return true;
  }

  // A tile linking to the board it lives on can never go anywhere, so the
  // current board is excluded from every board/canvas picker list.
  private getBoardPaths(): string[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFile => f instanceof TFile && f.extension === 'canvas' && f.path !== this.currentFile?.path)
      .map(f => f.path)
      .sort();
  }

  private getPathsForKind(kind: 'folder' | 'canvas' | 'note'): string[] {
    const all = this.app.vault.getAllLoadedFiles();
    if (kind === 'folder') return all.filter(f => f instanceof TFolder).map(f => f.path).sort();
    if (kind === 'canvas') return this.getBoardPaths();
    return all.filter((f): f is TFile => f instanceof TFile && f.extension === 'md').map(f => f.path).sort();
  }

  private getKanbanPaths(): string[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFile => {
        if (!(f instanceof TFile) || f.extension !== 'md') return false;
        const cache = this.app.metadataCache.getFileCache(f);
        return cache?.frontmatter != null && 'kanban-plugin' in cache.frontmatter;
      })
      .map(f => f.path)
      .sort();
  }
}
