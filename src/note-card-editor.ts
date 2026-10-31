import type { App, TFile } from 'obsidian';

/** A source-note edit stays separate from board data and the board undo stack. */
export class NoteCardEditor {
  readonly element = createDiv('visual-notes-notelink-editor');
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private original: string | null = null;
  private saving = false;
  private close: () => void = () => {};

  constructor(private app: App, readonly file: TFile, wholeNote: boolean) {
    this.element.createDiv({
      cls: 'visual-notes-notelink-editor-hint',
      text: wholeNote ? 'Editing the entire note, including properties.' : 'Edit Markdown. Save updates the original note.',
    });
    this.input = this.element.createEl('textarea', {
      cls: 'visual-notes-notelink-editor-input',
      attr: { 'aria-label': `Edit ${file.name}`, spellcheck: 'true' },
    });
    this.input.disabled = true;
    this.status = this.element.createDiv({
      cls: 'visual-notes-notelink-editor-status',
      text: 'Loading note…', attr: { role: 'status', 'aria-live': 'polite' },
    });
    const actions = this.element.createDiv('visual-notes-notelink-editor-actions');
    this.cancelButton = actions.createEl('button', { text: 'Cancel' });
    this.saveButton = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
    this.saveButton.disabled = true;
    this.saveButton.addEventListener('click', () => { void this.save(); });
    this.cancelButton.addEventListener('click', () => { if (!this.saving) this.close(); });
    // Text selection, scrolling, context menus and native text undo belong to
    // this editor rather than the canvas's drag/pan/delete/undo handlers.
    for (const event of ['pointerdown', 'dblclick', 'click', 'contextmenu', 'wheel']) {
      this.element.addEventListener(event, e => e.stopPropagation());
    }
    this.element.addEventListener('keydown', e => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); void this.save();
      }
    });
    void this.load();
  }

  mount(host: HTMLElement, close: () => void): void {
    this.close = close;
    host.appendChild(this.element);
    if (!this.input.disabled) this.input.focus({ preventScroll: true });
  }

  private async load(): Promise<void> {
    try {
      this.original = await this.app.vault.read(this.file);
      this.input.value = this.original;
      this.input.disabled = false;
      this.saveButton.disabled = false;
      this.status.setText('');
      if (this.element.isConnected) this.input.focus({ preventScroll: true });
    } catch {
      this.status.setText('Could not read this note. Cancel and try again.');
      this.status.addClass('is-error');
    }
  }

  private async save(): Promise<void> {
    if (this.saving || this.original === null) return;
    this.saving = true;
    this.input.readOnly = true;
    this.saveButton.disabled = true;
    this.cancelButton.disabled = true;
    this.status.removeClass('is-error');
    this.status.setText('Saving…');
    const draft = this.input.value;
    let conflict = false;
    try {
      if (this.app.vault.getAbstractFileByPath(this.file.path) !== this.file) {
        throw new Error('Source note is missing or was replaced');
      }
      if (draft !== this.original) {
        await this.app.vault.process(this.file, current => {
          if (current !== this.original && current !== draft) {
            conflict = true;
            throw new Error('Source note changed');
          }
          return draft;
        });
      }
      this.close();
    } catch {
      this.status.setText(conflict
        ? 'This note changed elsewhere. Your edits are kept here; copy them before cancelling and reopening the editor.'
        : 'Could not save the note. Your edits are kept here. Try Save again or copy your text.');
      this.status.addClass('is-error');
    } finally {
      this.saving = false;
      this.input.readOnly = false;
      this.saveButton.disabled = false;
      this.cancelButton.disabled = false;
    }
  }
}
