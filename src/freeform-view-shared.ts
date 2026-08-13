// Shared constants, helper functions, types, and small modal classes used
// across the split FreeformRenderer files (freeform-view.ts + its
// satellites). Nothing here depends on FreeformRenderer itself.

import {
  App, TFile, Notice, Modal,
  FuzzySuggestModal,
} from 'obsidian';
import {
  TileCard, StickyCard, TextCard, ChecklistCard, NoteLinkCard,
  ImageCard, AudioCard, VideoCard, BookmarkCard, KanbanColumnCard, KanbanBoardCard,
  KanbanItem, Card, ColumnCard, ColumnChildCard, CommentCard,
  TableCard,
  MapCard, SwatchCard, FileCard, CalloutCard, GroupCard,
  CalendarCard, CalendarNoteImportance, CheckersCard,
  StickyTextScale, STICKY_TEXT_SCALES,
} from './file-types';
import { isDarkTheme } from './color-utils';


// ── Constants ──────────────────────────────────────────────────
export const TILE_DEFAULT_W      = 140;
export const TILE_DEFAULT_H      = 160;
export const TILE_MIN_W          = 80;
export const TILE_MIN_H          = 100;
export const STICKY_DEFAULT_W    = 180;
export const STICKY_DEFAULT_H    = 160;
export const STICKY_MIN_W        = 120;
export const STICKY_MIN_H        = 80;
export const CHECKLIST_DEFAULT_W = 240;
export const CHECKLIST_DEFAULT_H = 300;
export const CHECKLIST_MIN_W     = 180;
export const CHECKLIST_MIN_H     = 120;
export const COMMENT_DEFAULT_W   = 240;
export const COMMENT_DEFAULT_H   = 150;
export const COMMENT_MIN_W       = 200;
export const COMMENT_MIN_H       = 110;
export const TABLE_DEFAULT_W     = 320;
export const TABLE_DEFAULT_H     = 220;
export const TABLE_MIN_W         = 200;
export const TABLE_MIN_H         = 120;
export const NOTELINK_DEFAULT_W  = 280;
export const NOTELINK_DEFAULT_H  = 240;
export const NOTELINK_TITLE_W    = 220;
export const NOTELINK_TITLE_H    = 52;
export const NOTELINK_MIN_W      = 160;
export const NOTELINK_MIN_H      = 52;
export const IMAGE_DEFAULT_W     = 240;
export const IMAGE_DEFAULT_H     = 200;
export const IMAGE_MIN_W         = 80;
export const IMAGE_MIN_H         = 80;
export const BOOKMARK_DEFAULT_W  = 260;
export const BOOKMARK_DEFAULT_H  = 220;
export const BOOKMARK_MIN_W      = 180;
export const BOOKMARK_MIN_H      = 100;
export const AUDIO_DEFAULT_W     = 280;
export const AUDIO_DEFAULT_H     = 100;
// Exact 16:9. The card resizes to the clip's real aspect ratio once its
// metadata loads (see measureVideoAspect), so this is only what a card looks
// like for the moment before that arrives — 16:9 makes that moment least
// jarring, being what most footage actually is.
export const VIDEO_DEFAULT_W     = 320;
export const VIDEO_DEFAULT_H     = 180;
// A freshly dropped clip is fitted inside VIDEO_DEFAULT_W x VIDEO_MAX_H rather
// than being given a fixed width. Deriving the height from a fixed width is
// right for landscape and wrong for everything else: a vertical phone video at
// 320 wide comes out 569 tall, which is most of a screen for one card on a
// moodboard. Chosen so 16:9 lands on exactly 320x180 as before, while 9:16
// lands near 202x360.
export const VIDEO_MAX_H         = 360;
export const VIDEO_MIN_W         = 120;
export const VIDEO_MIN_H         = 68;
export const MAP_DEFAULT_W       = 480;
export const MAP_DEFAULT_H       = 360;
export const MAP_MIN_W           = 200;
export const MAP_MIN_H           = 160;
export const SWATCH_DEFAULT_W    = 160;
export const SWATCH_DEFAULT_H    = 160;
export const SWATCH_MIN_W        = 90;
export const SWATCH_MIN_H        = 90;
export const FILE_DEFAULT_W      = 260;
export const FILE_DEFAULT_H      = 300;
export const FILE_MIN_W          = 150;
export const FILE_MIN_H          = 110;
export const CALLOUT_DEFAULT_W   = 320;
export const CALLOUT_DEFAULT_H   = 100;
export const CALLOUT_MIN_W       = 180;
export const CALLOUT_MIN_H       = 64;
export const GROUP_DEFAULT_W     = 400;
export const GROUP_DEFAULT_H     = 300;
export const GROUP_MIN_W         = 160;
export const GROUP_MIN_H         = 120;
export const GROUP_PAD           = 40; // margin added around selected cards' bbox when grouping
export const AUDIO_MIN_W         = 200;
export const AUDIO_MIN_H         = 72;
export const AUDIO_EXTS          = ['mp3', 'wav'];
// What becomes a video card on drop. Wider than the set Electron's Chromium
// can actually decode -- mkv and avi usually cannot be, and mov depends on its
// codec -- because "videos become video cards" is a rule people can predict,
// whereas a hand-picked subset looks arbitrary from the outside. Whatever
// can't play is caught by the <video> element's error event and shown as a
// card offering to open it externally, which beats a black rectangle.
export const VIDEO_EXTS          = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'];
// There is deliberately no VIDEO_CONTROLS_H here any more. Reserving a fixed
// strip for the browser's control bar was wrong for any video whose width made
// Chromium lay it out on two rows, and no single number can be right: the
// height depends on the video's width, the platform and the app's zoom. The
// canvas defers to movement instead — see bindDelegatedCardEvents.
export const KANBAN_DEFAULT_W    = 220;
export const KANBAN_DEFAULT_H    = 340;
export const KANBAN_MIN_W        = 160;
export const KANBAN_MIN_H        = 200;
export const COLUMN_DEFAULT_W    = 260;
export const COLUMN_DEFAULT_H    = 360;
export const COLUMN_MIN_W        = 180;
export const COLUMN_MIN_H        = 160;
export const CALENDAR_DEFAULT_W  = 460;
export const CALENDAR_DEFAULT_H  = 420;
export const CALENDAR_MIN_W      = 300;
export const CALENDAR_MIN_H      = 240;
export const CHECKERS_DEFAULT_W  = 340;
export const CHECKERS_DEFAULT_H  = 380;
export const CHECKERS_MIN_W      = 220;
export const CHECKERS_MIN_H      = 260;
export const DOT_SPACING         = 32;
export const MAX_UNDO            = 20;
export const DRAG_THRESHOLD      = 5;

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif', 'ico'];

// Shared by the day-decoration and note context menus (Calendar card).
export const CALENDAR_IMPORTANCE_OPTIONS: { v: CalendarNoteImportance | undefined; label: string }[] = [
  { v: undefined, label: 'No importance' },
  { v: 'low', label: 'Low importance' },
  { v: 'medium', label: 'Medium importance' },
  { v: 'high', label: 'High importance' },
];

export const CONN_COLOR_PRESETS = [
  '#6b7280', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#3b82f6', '#a855f7', '#ec4899',
];

const STICKY_COLORS_LIGHT: { color: string; name: string }[] = [
  { color: '#FDE68A', name: 'Yellow' },
  { color: '#FCA5A5', name: 'Rose' },
  { color: '#86EFAC', name: 'Green' },
  { color: '#93C5FD', name: 'Blue' },
  { color: '#C4B5FD', name: 'Purple' },
  { color: '#FBB6CE', name: 'Pink' },
  { color: '#FCD34D', name: 'Amber' },
  { color: '#A7F3D0', name: 'Mint' },
  { color: '#D1D5DB', name: 'Grey' },
  { color: '#F3F4F6', name: 'Light Grey' },
];
// Same names/slots as the light set, in muted Tailwind 800/900 shades —
// pale pastels sitting on a dark canvas read as glaring rather than
// blending in, which is what "colors don't suit dark mode" meant in
// practice for sticky/kanban-item backgrounds specifically.
const STICKY_COLORS_DARK: { color: string; name: string }[] = [
  { color: '#78350F', name: 'Yellow' },
  { color: '#7F1D1D', name: 'Rose' },
  { color: '#14532D', name: 'Green' },
  { color: '#1E3A8A', name: 'Blue' },
  { color: '#4C1D95', name: 'Purple' },
  { color: '#831843', name: 'Pink' },
  { color: '#92400E', name: 'Amber' },
  { color: '#064E3B', name: 'Mint' },
  { color: '#374151', name: 'Grey' },
  { color: '#1F2937', name: 'Light Grey' },
];
// `dark` lets a board pin its own light/dark surface (board.appearance) —
// without it these would follow Obsidian's theme and hand a pale pastel to a
// dark board sitting in a light vault, the exact glare the dark set exists to
// avoid. Omitted by callers with no board in scope, e.g. the settings picker.
export function STICKY_COLORS(dark = isDarkTheme()): { color: string; name: string }[] {
  return dark ? STICKY_COLORS_DARK : STICKY_COLORS_LIGHT;
}

// A saved "default sticky color" is a literal hex captured at the moment the
// user picked it, so a choice made under one theme would otherwise stay
// stuck at that hex forever — including after switching theme. Since the
// picker only ever offers palette swatches, re-map a stored hex to its
// same-named swatch in the *current* theme's palette instead of returning it
// verbatim.
export function resolveDefaultStickyColor(stored: string | undefined, dark = isDarkTheme()): string {
  if (!stored) return STICKY_COLORS(dark)[0].color;
  const lower = stored.toLowerCase();
  const idx = STICKY_COLORS_LIGHT.findIndex(c => c.color.toLowerCase() === lower);
  const resolvedIdx = idx !== -1 ? idx : STICKY_COLORS_DARK.findIndex(c => c.color.toLowerCase() === lower);
  return resolvedIdx !== -1 ? STICKY_COLORS(dark)[resolvedIdx].color : stored;
}

// Per-card text size, written as a plain multiplier onto the *card* element.
// It has to land there rather than on the inner text node: --vn-text-mult is
// declared on .visual-notes-freeform-card, and custom properties inherit
// their already-computed value, so an override set further down would never
// re-enter that calc. Clearing it falls back to the global setting alone.
export function applyStickyTextScale(cardEl: HTMLElement, scale: StickyTextScale | undefined): void {
  if (scale && scale in STICKY_TEXT_SCALES) {
    cardEl.style.setProperty('--vn-card-text-scale', String(STICKY_TEXT_SCALES[scale]));
  } else {
    cardEl.style.removeProperty('--vn-card-text-scale');
  }
}


export const KANBAN_COLORS: { color: string; name: string }[] = [
  { color: '#6b7280', name: 'Gray' },
  { color: '#ef4444', name: 'Red' },
  { color: '#f97316', name: 'Orange' },
  { color: '#eab308', name: 'Yellow' },
  { color: '#22c55e', name: 'Green' },
  { color: '#3b82f6', name: 'Blue' },
  { color: '#a855f7', name: 'Purple' },
  { color: '#ec4899', name: 'Pink' },
];

// Card kinds that are allowed to live inside a Column — matches
// ColumnChildCard in file-types.ts. Containers (kanban/board/column
// itself) are excluded to avoid unbounded nesting.
export const COLUMN_CHILD_KINDS = new Set<Card['kind']>([
  'tile', 'sticky', 'text', 'checklist', 'table', 'image', 'audio', 'note-link', 'bookmark', 'swatch', 'file', 'callout',
]);
export function isColumnChildKind(kind: Card['kind']): kind is ColumnChildCard['kind'] {
  return COLUMN_CHILD_KINDS.has(kind);
}

export function commentInitial(author?: string): string {
  const name = (author ?? '').trim();
  return name ? name[0].toUpperCase() : 'A';
}

export function formatCommentTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Type helpers ───────────────────────────────────────────────

/** Typed wrapper for the private Obsidian dragManager API. */
export interface DragManager {
  draggable?: { type: string; file?: unknown };
}
export interface AppWithPrivateAPIs extends App {
  dragManager?: DragManager;
  plugins?: { enabledPlugins?: Set<string> };
}

export type SupportedCard = TileCard | StickyCard | TextCard | ChecklistCard | CommentCard | TableCard | NoteLinkCard | ImageCard | AudioCard | VideoCard | BookmarkCard | KanbanColumnCard | KanbanBoardCard | ColumnCard | MapCard | SwatchCard | FileCard | CalloutCard | GroupCard | CalendarCard | CheckersCard;

export const KANBAN_BOARD_MIN_W = 320;

export function cardMinSize(kind: Card['kind']): { w: number; h: number } {
  // Tiny, because a text card's real size comes from its font size rather
  // than from w/h — this only has to stop a resize collapsing it to nothing.
  if (kind === 'text')      return { w: 12,              h: 10              };
  if (kind === 'sticky')    return { w: STICKY_MIN_W,    h: STICKY_MIN_H    };
  if (kind === 'checklist') return { w: CHECKLIST_MIN_W, h: CHECKLIST_MIN_H };
  if (kind === 'comment')   return { w: COMMENT_MIN_W,   h: COMMENT_MIN_H   };
  if (kind === 'table')     return { w: TABLE_MIN_W,     h: TABLE_MIN_H     };
  if (kind === 'note-link') return { w: NOTELINK_MIN_W,  h: NOTELINK_MIN_H  };
  if (kind === 'image')     return { w: IMAGE_MIN_W,     h: IMAGE_MIN_H     };
  if (kind === 'bookmark')  return { w: BOOKMARK_MIN_W,  h: BOOKMARK_MIN_H  };
  if (kind === 'audio')     return { w: AUDIO_MIN_W,     h: AUDIO_MIN_H     };
  if (kind === 'video')     return { w: VIDEO_MIN_W,     h: VIDEO_MIN_H     };
  if (kind === 'kanban-column') return { w: KANBAN_MIN_W, h: KANBAN_MIN_H };
  if (kind === 'kanban-board')  return { w: KANBAN_BOARD_MIN_W, h: KANBAN_MIN_H };
  if (kind === 'column')        return { w: COLUMN_MIN_W, h: COLUMN_MIN_H };
  if (kind === 'map')           return { w: MAP_MIN_W, h: MAP_MIN_H };
  if (kind === 'swatch')        return { w: SWATCH_MIN_W, h: SWATCH_MIN_H };
  if (kind === 'file')          return { w: FILE_MIN_W, h: FILE_MIN_H };
  if (kind === 'callout')       return { w: CALLOUT_MIN_W, h: CALLOUT_MIN_H };
  if (kind === 'group')         return { w: GROUP_MIN_W, h: GROUP_MIN_H };
  if (kind === 'calendar')      return { w: CALENDAR_MIN_W, h: CALENDAR_MIN_H };
  if (kind === 'checkers')      return { w: CHECKERS_MIN_W, h: CHECKERS_MIN_H };
  return { w: TILE_MIN_W, h: TILE_MIN_H };
}

// Abstracts "a list of kanban items that can be rendered/edited/dragged",
// letting the same rich item-rendering code (icon badges, thumbnails,
// YouTube previews, tags, colors, drag-and-drop) serve both a legacy
// single-column KanbanColumnCard and a single column inside a multi-column
// KanbanBoardCard, without duplicating that logic for each.
export interface KanbanItemsOwner {
  ownerKey: string; // stable identity (`${cardId}` or `${cardId}:${columnId}`) — do NOT compare owner objects by reference, a fresh one is constructed on every resolution
  getItems: () => KanbanItem[];
  setItems: (items: KanbanItem[]) => void;
  rebuild: () => void;
  updateCount: () => void;
}

export function isValidURL(text: string): boolean {
  try { const u = new URL(text); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

/**
 * Opens a link in the browser — but only if it really is a web link.
 *
 * Every URL that reaches here can have come from the *file* rather than from
 * this session's typing: a board someone shares carries whatever its author
 * put in it, and the deserializer builds cards straight from the JSON
 * without re-checking their URLs (see canvas-format's bookmark case). The
 * creation paths do validate, so this is the same check applied at the point
 * of use, which is the only place that sees a board authored elsewhere.
 *
 * It matters most for window.open specifically: a `javascript:` URL there
 * executes in the opened document rather than simply failing to load, so an
 * unchecked open turns "click a card on a shared board" into running someone
 * else's script.
 */
export function openExternalUrl(url: string | undefined | null): void {
  if (!url || !isValidURL(url)) {
    new Notice('Visual Notes: that link isn’t a valid web address, so it wasn’t opened.', 6000);
    return;
  }
  window.open(url, '_blank');
}

/**
 * A remote image URL, or null if it isn't one worth trusting to an <img src>.
 *
 * For vault files use app.vault.getResourcePath() instead — its `app:` URLs
 * are not web URLs and would (correctly) fail this check.
 */
export function safeRemoteImageSrc(url: string | undefined | null): string | null {
  return url && isValidURL(url) ? url : null;
}

// ── Helper modals ──────────────────────────────────────────────

export class NoteLinkPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) { super(app); }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

export class VaultImagePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) { super(app); }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => IMAGE_EXTS.includes(f.extension.toLowerCase()));
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

export class VaultAudioPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) { super(app); }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => AUDIO_EXTS.includes(f.extension.toLowerCase()));
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

export class VaultVideoPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) { super(app); }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => VIDEO_EXTS.includes(f.extension.toLowerCase()));
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

export class VaultAnyFilePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) { super(app); }
  getItems(): TFile[] { return this.app.vault.getFiles(); }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

// ── Due date helpers ───────────────────────────────────────────

export function formatDueDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Urgency class for a due badge: overdue → red, within 48h → amber,
// done → muted green (no urgency once the item is checked off).
export function dueUrgency(iso: string, done: boolean | undefined): 'overdue' | 'soon' | 'done' | null {
  if (done) return 'done';
  const due = new Date(`${iso}T23:59:59`).getTime();
  if (isNaN(due)) return null;
  const now = Date.now();
  if (now > due) return 'overdue';
  if (due - now < 48 * 3600 * 1000) return 'soon';
  return null;
}

export class DueDateModal extends Modal {
  constructor(app: App, private current: string | undefined, private onSubmit: (date: string | undefined) => void) { super(app); }

  override onOpen(): void {
    this.contentEl.createEl('h3', { text: 'Due date' });
    const input = this.contentEl.createEl('input');
    input.type = 'date';
    input.value = this.current ?? '';
    input.addClass('visual-notes-modal-text-input');

    const row = this.contentEl.createDiv('visual-notes-modal-btn-row');
    if (this.current) {
      row.createEl('button', { text: 'Remove' })
        .addEventListener('click', () => { this.close(); this.onSubmit(undefined); });
    }
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const save = row.createEl('button', { text: 'Save', cls: 'mod-cta' });
    const submit = () => { this.close(); this.onSubmit(input.value || undefined); };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    window.setTimeout(() => input.focus(), 50);
  }

  override onClose(): void { this.contentEl.empty(); }
}

// Browser for a board's archived cards — restore puts a card back on the
// canvas exactly where it was; delete removes it for good (still undoable).
export class ArchiveModal extends Modal {
  constructor(
    app: App,
    private getCards: () => Card[],
    private describe: (c: Card) => string,
    private onRestore: (c: Card) => void,
    private onDelete: (c: Card) => void,
  ) { super(app); }

  override onOpen(): void { this.renderList(); }

  private renderList(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Archived cards' });
    const cards = this.getCards();
    if (cards.length === 0) {
      contentEl.createEl('p', { text: 'Nothing archived on this board.', cls: 'visual-notes-archive-empty' });
      return;
    }
    const list = contentEl.createDiv('visual-notes-archive-list');
    for (const c of cards) {
      const row = list.createDiv('visual-notes-archive-row');
      row.createSpan({ cls: 'visual-notes-archive-kind', text: c.kind });
      row.createSpan({ cls: 'visual-notes-archive-name', text: this.describe(c) || '(untitled)' });
      const btns = row.createDiv('visual-notes-archive-btns');
      const restoreBtn = btns.createEl('button', { text: 'Restore', cls: 'mod-cta' });
      restoreBtn.addEventListener('click', () => { this.onRestore(c); this.renderList(); });
      const delBtn = btns.createEl('button', { text: 'Delete' });
      delBtn.addEventListener('click', () => { this.onDelete(c); this.renderList(); });
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}

// Emoji grid for callout icons — same look as the reaction picker, plus a
// free-input row so any emoji (or short text) works, not just the presets.
export const CALLOUT_ICON_CHOICES = [
  '💡', '⚠️', '❗', '❓', '📌', '📝', '✅', '❌',
  '🔥', '⭐', '🎯', '🚀', '📅', '💬', '🔒', '🐛',
  '⏰', '📣', '👀', '🧠', '💰', '🏆', '✨', 'ℹ️',
];

export class CalloutIconPickerModal extends Modal {
  constructor(app: App, private current: string, private onPick: (icon: string) => void) { super(app); }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Callout icon' });
    const grid = contentEl.createDiv('visual-notes-reaction-grid');
    for (const emoji of CALLOUT_ICON_CHOICES) {
      const btn = grid.createDiv('visual-notes-reaction-option');
      btn.setText(emoji);
      btn.toggleClass('is-active', this.current === emoji);
      btn.addEventListener('click', () => { this.close(); this.onPick(emoji); });
    }

    const row = contentEl.createDiv('visual-notes-modal-btn-row');
    const input = row.createEl('input', { type: 'text', placeholder: 'Or type any emoji…' });
    input.addClass('visual-notes-modal-text-input');
    const useBtn = row.createEl('button', { text: 'Use', cls: 'mod-cta' });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close(); this.onPick(v);
    };
    useBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }

  override onClose(): void { this.contentEl.empty(); }
}

export interface QuickAddEntry { label: string; tool: string; }

// The "/" quick-add palette: fuzzy-pick a card type, and it lands where
// the pointer last was on the canvas (or dead center as the fallback).
export class QuickAddModal extends FuzzySuggestModal<QuickAddEntry> {
  constructor(app: App, private entries: QuickAddEntry[], private onChoose: (e: QuickAddEntry) => void) {
    super(app);
    this.setPlaceholder('Add to board…');
  }
  getItems(): QuickAddEntry[] { return this.entries; }
  getItemText(e: QuickAddEntry): string { return e.label; }
  onChooseItem(e: QuickAddEntry): void { this.onChoose(e); }
}

export class KanbanItemUrlModal extends Modal {
  constructor(app: App, private initialValue: string, private onSubmit: (url: string) => void, private title = 'Link URL') { super(app); }

  override onOpen(): void {
    this.contentEl.createEl('h3', { text: this.title });
    const input = this.contentEl.createEl('input');
    input.type = 'text'; input.placeholder = 'https://…'; input.value = this.initialValue;
    input.addClass('visual-notes-modal-text-input');

    const btnRow = this.contentEl.createDiv();
    btnRow.addClass('visual-notes-modal-btn-row');
    btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    const submit = () => { const v = input.value.trim(); this.close(); this.onSubmit(v); };
    saveBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') this.close();
    });
    window.setTimeout(() => { input.focus(); }, 50);
  }

  override onClose(): void { this.contentEl.empty(); }
}

export class CalendarNoteTextModal extends Modal {
  constructor(app: App, private initialValue: string, private onSubmit: (text: string) => void) { super(app); }

  override onOpen(): void {
    this.contentEl.createEl('h3', { text: 'Note' });
    const input = this.contentEl.createEl('input');
    input.type = 'text'; input.placeholder = 'Note text…'; input.value = this.initialValue;
    input.addClass('visual-notes-modal-text-input');

    const btnRow = this.contentEl.createDiv();
    btnRow.addClass('visual-notes-modal-btn-row');
    btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    const submit = () => {
      const v = input.value.trim();
      this.close();
      if (v) this.onSubmit(v);
    };
    saveBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') this.close();
    });
    window.setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  override onClose(): void { this.contentEl.empty(); }
}

export const KANBAN_THUMB_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];

export class KanbanItemImageSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (f: TFile) => void) {
    super(app);
    this.setPlaceholder('Search for an image in your vault…');
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => KANBAN_THUMB_IMAGE_EXTS.includes(f.extension.toLowerCase()));
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onChoose(f); }
}

const KANBAN_ITEM_COLORS_LIGHT = [
  '#FEE2E2', '#FEF3C7', '#D1FAE5', '#DBEAFE', '#EDE9FE', '#FCE7F3',
  '#FFEDD5', '#E0F2FE', '#F3F4F6', '#EF4444', '#3B82F6', '#22C55E',
];
// First 9 are pale pastels (same "glares on a dark canvas" issue as
// STICKY_COLORS/BG_COLORS) swapped for muted Tailwind 800/900 shades in
// the same hue order; the trailing red/blue/green are already fully
// saturated and read fine in either theme, so they're kept as-is.
const KANBAN_ITEM_COLORS_DARK = [
  '#7F1D1D', '#78350F', '#064E3B', '#1E3A8A', '#4C1D95', '#831843',
  '#7C2D12', '#0C4A6E', '#1F2937', '#EF4444', '#3B82F6', '#22C55E',
];
export function KANBAN_ITEM_COLORS(dark = isDarkTheme()): string[] {
  return dark ? KANBAN_ITEM_COLORS_DARK : KANBAN_ITEM_COLORS_LIGHT;
}

export class KanbanItemColorModal extends Modal {
  constructor(app: App, private current: string | undefined, private onSubmit: (hex: string | undefined) => void, private dark = isDarkTheme()) { super(app); }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Item color' });

    const grid = contentEl.createDiv('visual-notes-modal-palette');
    const noneSwatch = grid.createDiv('visual-notes-modal-swatch visual-notes-modal-swatch--none');
    noneSwatch.setAttribute('aria-label', 'Default');
    noneSwatch.addEventListener('click', () => { this.close(); this.onSubmit(undefined); });
    for (const hex of KANBAN_ITEM_COLORS(this.dark)) {
      const swatch = grid.createDiv('visual-notes-modal-swatch');
      swatch.style.backgroundColor = hex;
      if (hex === this.current) swatch.addClass('is-selected');
      // Swatches close enough to the modal's own background (light theme:
      // near-white; dark theme: the darkest gray option) to need a border
      // to read as a distinct square rather than blending in.
      if (['#F3F4F6', '#DBEAFE', '#E0F2FE', '#1F2937'].includes(hex)) swatch.addClass('has-border');
      swatch.addEventListener('click', () => { this.close(); this.onSubmit(hex); });
    }

    const wheelRow = contentEl.createDiv('visual-notes-modal-btn-row');
    const colorWheel = wheelRow.createEl('input');
    colorWheel.type = 'color';
    colorWheel.value = this.current ?? '#3B82F6';
    colorWheel.addClass('visual-notes-modal-color-wheel');
    colorWheel.addEventListener('change', () => { this.close(); this.onSubmit(colorWheel.value); });
    const wheelLabel = wheelRow.createSpan();
    wheelLabel.setText('Custom…');
  }

  override onClose(): void { this.contentEl.empty(); }
}

export class WipLimitModal extends Modal {
  constructor(
    app: App,
    private current: number | undefined,
    private onSubmit: (limit: number | undefined) => void
  ) { super(app); }

  override onOpen(): void {
    this.contentEl.createEl('h3', { text: 'WIP Limit' });
    this.contentEl.createEl('p', {
      text: 'Maximum items allowed in this column. Leave blank to remove the limit.',
      cls: 'setting-item-description',
    });
    const input = this.contentEl.createEl('input');
    input.type = 'number'; input.min = '1'; input.placeholder = 'No limit';
    input.addClass('visual-notes-modal-text-input');
    if (this.current !== undefined) input.value = String(this.current);

    const btnRow = this.contentEl.createDiv();
    btnRow.addClass('visual-notes-modal-btn-row');
    btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const setBtn = btnRow.createEl('button', { text: 'Set', cls: 'mod-cta' });
    setBtn.addEventListener('click', () => this.submit(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(input.value); }
      if (e.key === 'Escape') this.close();
    });
    window.setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  private submit(raw: string): void {
    const val = parseInt(raw.trim());
    this.close();
    this.onSubmit(isNaN(val) || val < 1 ? undefined : val);
  }

  override onClose(): void { this.contentEl.empty(); }
}

export class MediaSourceModal extends Modal {
  constructor(
    app: App,
    private label: string,
    private onVault: () => void,
    private onUpload: () => void,
    private onUrl?: () => void
  ) { super(app); }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.label, cls: 'visual-notes-media-source-title' });
    const vaultBtn = contentEl.createEl('button', {
      text: 'Choose from vault…',
      cls: 'mod-cta visual-notes-media-source-btn',
    });
    vaultBtn.addEventListener('click', () => { this.close(); this.onVault(); });
    contentEl.createDiv('visual-notes-media-source-sep');
    const uploadBtn = contentEl.createEl('button', {
      text: 'Upload from disk…',
      cls: 'visual-notes-media-source-btn',
    });
    uploadBtn.addEventListener('click', () => { this.close(); this.onUpload(); });
    if (this.onUrl) {
      contentEl.createDiv('visual-notes-media-source-sep');
      const urlBtn = contentEl.createEl('button', {
        text: 'From web URL…',
        cls: 'visual-notes-media-source-btn',
      });
      urlBtn.addEventListener('click', () => { this.close(); this.onUrl!(); });
    }
  }
}

export class TagInputModal extends Modal {
  constructor(app: App, private onSubmit: (tag: string) => void) { super(app); }
  override onOpen(): void {
    this.contentEl.createEl('h3', { text: 'Add tag' });
    const input = this.contentEl.createEl('input');
    input.type = 'text'; input.placeholder = 'tag name (no #)';
    input.addClass('visual-notes-modal-text-input');
    const btnRow = this.contentEl.createDiv();
    btnRow.addClass('visual-notes-modal-btn-row');
    btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const addBtn = btnRow.createEl('button', { text: 'Add', cls: 'mod-cta' });
    const submit = () => {
      const val = input.value.trim().replace(/^#/, '').replace(/\s+/g, '-');
      if (!val) return;
      this.close(); this.onSubmit(val);
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') this.close();
    });
    window.setTimeout(() => input.focus(), 50);
  }
  override onClose(): void { this.contentEl.empty(); }
}

export class BookmarkInputModal extends Modal {
  constructor(app: App, private onSubmit: (url: string) => void, private title = 'Add bookmark') { super(app); }

  override onOpen(): void {
    this.contentEl.createEl('h3', { text: this.title });
    const input = this.contentEl.createEl('input', { cls: 'visual-notes-bookmark-url-input' });
    input.type = 'text'; input.placeholder = 'https://…';
    input.addClass('visual-notes-modal-text-input');

    const btnRow = this.contentEl.createDiv();
    btnRow.addClass('visual-notes-modal-btn-row');
    const cancel = btnRow.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const add = btnRow.createEl('button', { text: 'Add', cls: 'mod-cta' });
    add.addEventListener('click', () => this.submit(input.value));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(input.value); }
      if (e.key === 'Escape') this.close();
    });
    window.setTimeout(() => input.focus(), 50);
  }

  private submit(raw: string): void {
    const url = raw.trim();
    if (!isValidURL(url)) { new Notice('Please enter a valid https:// URL.'); return; }
    this.close(); this.onSubmit(url);
  }

  override onClose(): void { this.contentEl.empty(); }
}

