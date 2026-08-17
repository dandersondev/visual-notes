// ── v3 file format ───────────────────────────────────────────

export interface VisualNotesFile {
  version: 2 | 3;
  layout: 'grid' | 'freeform';
  dotsHidden?: boolean;
  // Legacy: a board could once pin its own light/dark surface independently of
  // Obsidian's theme, set by a toggle on the canvas. The toggle was removed —
  // having two separate places to change appearance confused people more than
  // the flexibility helped — and boards now always follow Obsidian's theme.
  // The field is still parsed and written so an older board keeps its value
  // rather than having it silently stripped on the next save; nothing reads it.
  appearance?: 'light' | 'dark';
  viewport?: { x: number; y: number; zoom: number }; // freeform only
  cards: Card[];
  connections: Connection[];  // empty for grid; freeform only
  drawings: DrawingStroke[];  // empty for grid; freeform only — free-floating pen ink, not bound to any card
  // Trello-style archive: hidden from the canvas but recoverable. Stashed
  // in the file's `vn` metadata (not as canvas nodes) so archived cards
  // don't show up in Obsidian's native Canvas view either.
  archived?: Card[];

  // Native JSON Canvas nodes/edges Visual Notes doesn't understand (added by
  // the user or another plugin directly in Obsidian's native Canvas view).
  // Preserved verbatim and re-emitted unchanged on save so they're never
  // silently deleted. See canvas-format.ts.
  foreignNodes?: import('./canvas-format').CanvasNode[];
  foreignEdges?: import('./canvas-format').CanvasEdge[];

  // Runtime-only, never serialized (visualNotesToCanvas doesn't emit it):
  // set by readBoardFile when this board came back off disk with its root
  // metadata stripped by native Canvas, so the view knows to write the root
  // block straight back out and tell the user what was recovered.
  recoveredFromNativeEdit?: boolean;

  // Runtime-only, never serialized. Set by readBoardFile when the file could
  // not be read or parsed, so what's in memory is a placeholder rather than
  // the user's board. writeBoardFile refuses to write a board carrying this,
  // which is what stops a failed read from overwriting a real board with an
  // empty one on the next autosave.
  unreadable?: boolean;

  // Runtime-only, never serialized. The exact file text as of the last time we
  // read or wrote this board — the revision our in-memory copy is derived
  // from. writeBoardFile compares it against what is actually on disk so a
  // renderer holding a board for hours can't overwrite an edit that arrived
  // from another device in the meantime.
  //
  // The exact text rather than a hash, for two reasons: a hash trades
  // correctness for bytes on a guard whose entire job is preventing data loss,
  // and this string is the base a future three-way merge needs, so keeping it
  // costs nothing that isn't already wanted.
  //
  // Safe to add here because visualNotesToCanvas builds the `vn` block field
  // by field rather than spreading the board, so nothing unknown reaches the
  // file — the same reason recoveredFromNativeEdit and unreadable are safe.
  baseline?: string;
}

// ── Drawing (free-floating pen ink) ─────────────────────────────

export interface DrawingStroke {
  id: string;
  // Strokes drawn in the same pen session (between activating and
  // deactivating the Pen tool) share a groupId, so the whole sketch — even
  // if it's several separate strokes — is selected, dragged, recolored,
  // and deleted as one unit rather than stroke-by-stroke.
  groupId: string;
  // Absolute canvas-space coordinates. `p` is the stylus pressure (0..1)
  // captured at that sample, when the input device reported one — strokes
  // without it (mouse, older files) get velocity-simulated pressure at
  // render time instead, so both taper naturally.
  points: { x: number; y: number; p?: number }[];
  color: string;
  width: number; // stroke thickness in canvas px
  // Set for highlighter strokes (semi-transparent marker ink drawn over
  // content); unset means fully opaque regular pen ink.
  opacity?: number;
}

// ── Connection ────────────────────────────────────────────────

// A specific point a connection is pinned to on a card's edge, node-graph
// style. `t` is the fractional position ALONG that side (0..1, measured
// left→right on n/s and top→bottom on e/w), not a pixel offset, so a pinned
// connection keeps its proportional place when the card is resized.
export type ConnectionSide = 'n' | 'e' | 's' | 'w';
export interface ConnectionAnchor {
  side: ConnectionSide;
  t: number;
}

export interface Connection {
  id: string;
  // A connection normally anchors to a card at each end (fromCardId/
  // toCardId), following it as it moves. Either end can instead be a free
  // point in canvas space (fromPoint/toPoint) — set when the matching
  // *CardId is unset — for a line dropped straight onto the canvas rather
  // than between two cards. Both ends free is a fully floating arrow.
  fromCardId?: string;
  toCardId?: string;
  fromPoint?: { x: number; y: number };
  toPoint?: { x: number; y: number };
  // Pins a card-anchored end to one exact point on that card's edge. Unset
  // (the default, and what every connection made before this existed has)
  // keeps the original auto behavior: the endpoint slides freely around the
  // card's edge to always face the other end. Only meaningful alongside the
  // matching *CardId — ignored on a free-point end.
  fromAnchor?: ConnectionAnchor;
  toAnchor?: ConnectionAnchor;
  routing: 'straight' | 'elbow';
  elbowOrientation?: 'auto' | 'horizontal-first' | 'vertical-first';
  // Perpendicular offset (px) from the straight-line midpoint, dragged via
  // the connection's bend handle — only meaningful when routing is
  // 'straight'; unset or 0 is a plain straight line. Stored as an offset
  // (not raw coordinates) so the curve stays sensible if the connected
  // cards are moved later, rather than staying fixed in stale canvas space.
  bend?: number;
  label?: string;
  // Font size (px, canvas-space so it scales with zoom) of the midpoint
  // label; unset renders at the default of 14.
  labelSize?: number;
  color: string;
  style: 'solid' | 'dashed';
  arrowhead: 'end' | 'both' | 'none';
  thickness: 2 | 4 | 6;
}

// ── Base ─────────────────────────────────────────────────────

// A small colored text pill attached to a card — Trello-label style, not
// tied to any particular card kind.
export interface CardLabel {
  id: string;
  text: string;
  color: string; // hex background of the pill
}

export interface BaseCard {
  id: string;
  order?: number;   // grid mode: position index
  x?: number;       // freeform: canvas X
  y?: number;       // freeform: canvas Y
  w?: number;       // freeform: width
  h?: number;       // freeform: height
  z?: number;       // freeform: z-index
  // Universal card decorations — available on every card kind, rendered as
  // a small pill row inset at the card's bottom edge (see renderCardBadges
  // in freeform-view.ts). Reactions are single-user toggles (present or
  // not), not counted, since there's no multi-user concept here.
  labels?: CardLabel[];
  reactions?: string[];
  // "Create nested board" link — a child board spawned from this card via
  // its context menu. The card shows a clickable board chip in its badge
  // row, and the child board is seeded with a back-link tile carrying the
  // same custom icon (nestedBoardIcon, an `asset:` ref) so both ends of the
  // link visually match. Unlinking clears these but never deletes the file.
  nestedBoardPath?: string;
  nestedBoardIcon?: string;
  // Hosted child document paired with nestedBoardPath. It is an identifier,
  // never a credential; local-only boards simply leave it unset.
  nestedBoardRoomId?: string;
}

// ── Tile card (the v1-style icon tile) ───────────────────────

export interface TileCard extends BaseCard {
  kind: 'tile';
  label: string;
  subtitle?: string;
  icon: string;   // Lucide name or single emoji
  color: string;  // hex
  target: TileTarget;
  // Optional cover image shown in place of the icon (Milanote-style tile
  // thumbnail). Falls back to icon/color when absent or fails to load.
  thumbnail?: { type: 'vault'; path: string } | { type: 'external'; url: string };
}

export type TileTarget =
  | { kind: 'folder';  path: string }
  | { kind: 'canvas';  path: string }
  | { kind: 'note';    path: string }
  | { kind: 'kanban';  path: string }
  | { kind: 'board';   path: string; roomId?: string }; // nested Visual Notes file (.canvas)

// Custom drag MIME type carrying a grid tile's full styling (icon/color/
// label/subtitle/thumbnail/target) — set by GridRenderer on dragstart so
// dropping a tile onto a freeform canvas open in another pane recreates an
// identical Tile card there, rather than the generic default-styled tile
// that dropping a raw vault file produces.
export const TILE_DRAG_MIME = 'application/x-visual-notes-tile';

export interface DraggedTilePayload {
  label: string;
  subtitle?: string;
  icon: string;
  color: string;
  thumbnail?: TileCard['thumbnail'];
  target: TileTarget;
}

// ── Other card types ──────────────────────────────────────────

// Per-card text size for Note/Card cards, multiplying whatever the global
// "Card text size" setting is (see the Text scale block in styles.css).
// 'sm'/'md'/'lg' predate the xl/xxl steps and keep their original meaning,
// so a board that already carries one still renders the same.
export type StickyTextScale = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'xxxl' | 'huge';

// Ascending — the context bar renders the steps in this key order.
export const STICKY_TEXT_SCALES: Record<StickyTextScale, number> = {
  xs: 0.7, sm: 0.85, md: 1, lg: 1.3, xl: 1.7, xxl: 2.2, xxxl: 2.8, huge: 3.6,
};

// Deliberately limited to the three fonts Obsidian itself exposes, rather than
// arbitrary family names: these are the fonts the user has already configured
// under Appearance → Font, they exist on every platform including iPad, and
// they keep the promise made when the plugin's hard-coded serif stack was
// removed (see the --visual-notes-font-display comment in styles.css) that
// everything follows the user's own font settings.
export type StickyFontFamily = 'text' | 'interface' | 'monospace';

export const STICKY_FONT_FAMILIES: Record<StickyFontFamily, string> = {
  text: 'var(--font-text)',
  interface: 'var(--font-interface)',
  monospace: 'var(--font-monospace)',
};

export interface StickyCard extends BaseCard {
  kind: 'sticky';
  text: string;
  color: string;
  topColor?: string;
  textScale?: StickyTextScale;
  textColor?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  // True for cards created via the "Card" tool (a plain neutral card, no
  // placeholder hint text, freely resizable height) rather than "Note" (a
  // colorful sticky that shows a "Double-click to edit…" hint and only
  // resizes width, auto-growing height with content).
  blank?: boolean;
  // Shape (blank cards only) — 'round' becomes a circle or oval depending
  // on the card's current width/height, since border-radius:50% on a
  // non-square box naturally produces an ellipse. Default is a plain
  // rounded rectangle when unset.
  shape?: 'rect' | 'round';
  // Drops the card's fill, border and shadow, leaving bare text on the
  // canvas — what the "Text" tool creates, and available to any note from the
  // colour panel. Note this also disables the auto-contrast text colour: with
  // no fill the text sits on the canvas, so a colour derived from `color`
  // would be contrasting against a background that isn't being drawn.
  transparent?: boolean;
  // Unset inherits the pane font, which is what every card did before this
  // existed.
  fontFamily?: StickyFontFamily;
}

// Bare text placed straight on the canvas — no fill, border or shadow, and no
// wrapping: the box is exactly as wide as the longest line, and you press
// Enter for a new one.
//
// Deliberately its own kind rather than a Note with the background switched
// off. That was the first attempt, and size was the thing that broke it: a
// Note carries a *multiplier* (an 8-step preset enum), so dragging a corner
// and picking a preset wrote two different units for one property and
// disagreed with each other. Here `fontSize` is real canvas px and is the only
// size input there is.
//
// Not wrapping is also what makes dragging smooth: the box scales linearly
// with the font size, so a resize can compute the new box size arithmetically
// instead of measuring it every frame.
// Font sizes a text card can reach by dragging. The floor keeps the box big
// enough to grab again after shrinking it; the ceiling only exists to stop a
// runaway drag, and sits far past any sane headline.
export const TEXT_CARD_MIN_FONT = 4;
export const TEXT_CARD_MAX_FONT = 800;
export const TEXT_CARD_DEFAULT_FONT = 32;

// The px sizes offered in the context bar — the same unit a corner drag
// writes, so picking one after dragging is never a surprise.
export const TEXT_CARD_FONT_PRESETS = [16, 24, 32, 48, 64, 96, 128];

export interface TextCard extends BaseCard {
  kind: 'text';
  // Inline HTML, same as StickyCard.text — rendered as-is rather than through
  // MarkdownRenderer, so what you see while editing is what you get after.
  text: string;
  fontSize: number;
  // Unset follows the theme's own text colour.
  color?: string;
  fontFamily?: StickyFontFamily;
  align?: 'left' | 'center' | 'right';
}

export interface CommentReply {
  id: string;
  text: string;
  author?: string;
  createdAt: number;
}

// A discussion/annotation card — a root remark plus a thread of replies,
// each carrying its own author and timestamp. Distinct from StickyCard:
// stickies are freeform rich-text content, comments are structured
// conversation threads meant to be left on top of other work.
export interface CommentCard extends BaseCard {
  kind: 'comment';
  text: string;
  author?: string;
  createdAt: number;
  color?: string;
  resolved?: boolean;
  replies: CommentReply[];
}

export type TableColumnType = 'text' | 'checkbox' | 'date' | 'select' | 'number';

export interface TableSelectOption {
  label: string;
  color: string; // hex background for the pill
}

export interface TableColumn {
  id: string;
  label: string;
  color?: string; // optional per-column color (header + every cell in the column)
  align?: 'left' | 'center' | 'right'; // text alignment for header + every cell in the column (default left)
  // Notion-style column typing; default (undefined) is plain text.
  // Cell values stay plain strings regardless of type: 'true'/'' for
  // checkbox, ISO "YYYY-MM-DD" for date, the option label for select.
  type?: TableColumnType;
  options?: TableSelectOption[]; // select type only
}

export interface TableRow {
  id: string;
  cells: Record<string, string>; // keyed by TableColumn.id
  color?: string; // optional per-row background color (Trello-label style)
  cellColors?: Record<string, string>; // per-cell background, keyed by TableColumn.id (wins over row/column color)
}

// Database-style alternate presentations of one table's rows — same data,
// different lens (see renderTableAltViewContent in freeform-view.ts).
// 'table' / undefined is the classic editable grid.
export type TableViewMode = 'table' | 'list' | 'gallery' | 'board' | 'calendar';

// A simple spreadsheet-like grid of editable text cells — no formulas or
// per-column types, just rows/columns of plain text with add/remove.
export interface TableCard extends BaseCard {
  kind: 'table';
  title?: string;
  titleHidden?: boolean;
  color: string;
  columns: TableColumn[];
  rows: TableRow[];
  zoom?: number; // grid content zoom factor (e.g. 0.4–1.5); 1 / undefined = 100%
  view?: TableViewMode;
  // Calendar view's shown month (ISO date inside it); undefined = today's.
  calAnchor?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  isHeader?: boolean;   // bold section label; checkbox tracks children
  parentId?: string;    // one level of nesting only
}

export interface ChecklistCard extends BaseCard {
  kind: 'checklist';
  title?: string;
  titleHidden?: boolean;
  accentColor?: string;  // hex; top accent bar colour (undefined = no bar)
  items: ChecklistItem[];
  color: string;
}

export interface ImageCard extends BaseCard {
  kind: 'image';
  source:
    | { type: 'vault'; path: string; sharedAsset?: SharedAssetRef }
    | { type: 'external'; url: string };
  // The pre-crop source, set the first time this card is cropped and never
  // touched again by later re-crops — so "Crop image…" always opens on the
  // full original rather than progressively cropping an already-cropped
  // result. Cleared whenever the card is pointed at a genuinely different
  // image (e.g. "Choose from vault…"), since the old original no longer
  // applies to it.
  originalSource?:
    | { type: 'vault'; path: string; sharedAsset?: SharedAssetRef }
    | { type: 'external'; url: string };
  caption?: string;
  captionHidden?: boolean;
  captionColor?: string;
  captionScale?: 'sm' | 'md' | 'lg';
}

/** Content-addressed room fallback for vault-local shared media. */
export interface SharedAssetRef {
  hash: string;
  mimeType: string;
  size: number;
  name?: string;
}

export interface AudioCard extends BaseCard {
  kind: 'audio';
  source: { type: 'vault'; path: string };
  title?: string;
}

// A vault video played in place on the canvas, rather than an icon you have to
// open elsewhere. Deliberately has no title/caption field: the card is
// chrome-free so nothing would render one, and nothing would write it either —
// a declared field no code sets is how textScale ended up reachable only by
// hand-editing the JSON. The display name comes from the path, as FileCard's
// does.
export interface VideoCard extends BaseCard {
  kind: 'video';
  source: { type: 'vault'; path: string; sharedAsset?: SharedAssetRef };
}

export interface NoteLinkCard extends BaseCard {
  kind: 'note-link';
  path: string;
  displayMode: 'preview' | 'title-only';

  // Set only on cards created by the web-clip importer. Declared rather than
  // left implicit: stashable() already round-trips any non-positional field,
  // so these would survive undeclared, but a field nothing declares is a
  // field the next person deletes. Enrichment only — the importer never
  // requires a URL to be present, since a clip without one still needs to
  // appear rather than silently vanish.
  clipSourceUrl?: string;
  clipImportedAt?: number;
}

export interface BookmarkCard extends BaseCard {
  kind: 'bookmark';
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  favicon?: string;
  fetchedAt?: number;
  fetchFailed?: boolean;
  // YouTube-embed bookmarks only: shows the header strip above the live
  // video iframe (see renderBookmarkContent). Hidden by default so the
  // embed looks like a bare 16:9 video; the card's main body still drags
  // via the invisible overlay over the iframe either way.
  youtubeHeaderShown?: boolean;
}

// A Trello-style sub-task inside a kanban item — rendered as a compact
// checkbox row under the item text, with a "2/5" progress pill.
export interface KanbanSubtask {
  id: string;
  text: string;
  done: boolean;
}

export interface KanbanItem {
  id: string;
  text: string;
  done?: boolean;
  // ISO date "YYYY-MM-DD" — rendered as a badge that goes amber when due
  // soon and red when overdue (muted once the item is done).
  dueDate?: string;
  subtasks?: KanbanSubtask[];
  linkedNotePath?: string;
  tags?: string[];
  imagePath?: string;
  audioPath?: string;
  // Optional tile-like identity (Lucide icon name or emoji, plus a hex
  // color) shown as a small badge, so a kanban item can carry the same
  // at-a-glance visual identity as a standalone tile card.
  icon?: string;
  iconColor?: string;
  // Optional cover image, same shape and either/or relationship with
  // `icon` as TileCard's thumbnail — replaces the icon badge when set.
  thumbnail?: { type: 'vault'; path: string } | { type: 'external'; url: string };
  // Optional external link (as opposed to linkedNotePath, which points at
  // a note inside the vault) — same idea as a bookmark card, scoped to a
  // single kanban item. A YouTube URL here gets a video-thumbnail preview
  // instead of a plain link pill (see parseYouTubeId in thumbnail-utils.ts).
  // Optional per-item card background color (independent of the icon
  // badge's color) — a Trello-label-style way to color-code items.
  color?: string;
  linkUrl?: string;
  // Same nested-board link as BaseCard's, scoped to a single kanban item —
  // chip renders in the item's meta row alongside note/link pills.
  nestedBoardPath?: string;
  nestedBoardIcon?: string;
  nestedBoardRoomId?: string;
}

// A single lane inside a multi-column kanban board. Everything that used to
// live directly on KanbanColumnCard (legacy, one column = one card) now
// lives here instead, one per column, inside KanbanBoardCard.columns.
export interface KanbanColumn {
  id: string;
  title?: string;
  titleHidden?: boolean;
  color: string;
  bgColor?: string;
  topColor?: string;
  collapsed?: boolean;
  wipLimit?: number;
  // Relative flex weight for this column's share of the board width
  // (undefined = 1). Set on every column the first time any divider is
  // dragged, so proportions are preserved when the whole card resizes.
  width?: number;
  items: KanbanItem[];
}

// Legacy: one column = one whole card. Kept only so old boards still parse;
// these are transparently migrated into a one-column KanbanBoardCard on
// load (see migrateLegacyKanbanColumns in migration.ts) and never created
// new. Still a valid member of the Card union for that reason.
export interface KanbanColumnCard extends BaseCard {
  kind: 'kanban-column';
  title?: string;
  titleHidden?: boolean;
  color: string;
  bgColor?: string;
  topColor?: string;
  collapsed?: boolean;
  wipLimit?: number;
  locked?: boolean; // padlock: items can't be dragged in or out (card itself still moves)
  items: KanbanItem[];
}

// A real multi-column kanban board: one card, several columns side by side,
// each independently titled/colored/WIP-limited, items draggable between
// them — the "Add col" toolbar action adds to `columns` on this card
// instead of creating a whole new sibling card.
export interface KanbanBoardCard extends BaseCard {
  kind: 'kanban-board';
  title?: string;
  titleHidden?: boolean;
  locked?: boolean; // padlock: items can't be dragged in or out (card itself still moves)
  columns: KanbanColumn[];
}

export type CalendarNoteImportance = 'low' | 'medium' | 'high';

// A lightweight, calendar-native item — created directly on a day (see
// the "+" hover button / day right-click in the Calendar card) rather than
// living on a kanban board or table. Deliberately small: a title plus the
// same optional identity trimmings a kanban item carries (icon/thumbnail,
// color, nested board link), no subtasks or checklists — those belong on
// a real kanban item or table row instead.
export interface CalendarNote {
  id: string;
  date: string; // ISO "YYYY-MM-DD"
  text: string;
  color?: string;
  icon?: string; // Lucide name, single emoji, or a custom asset ref
  iconColor?: string;
  thumbnail?: { type: 'vault'; path: string } | { type: 'external'; url: string };
  importance?: CalendarNoteImportance;
  nestedBoardPath?: string;
  nestedBoardIcon?: string;
  nestedBoardRoomId?: string;
}

// Decoration on the day cell itself — independent of any note. Lets a date
// carry an icon/image, a color tint, an importance flag, or a nested-board
// link without requiring text content, e.g. marking "July 15" as important
// and linking it to a project board without writing a note on it. Keyed by
// ISO date on CalendarCard.dayStyles; an entry is pruned back out once
// every field on it is cleared, so this map only ever holds decorated days.
export interface CalendarDayStyle {
  color?: string;
  icon?: string; // Lucide name, single emoji, or a custom asset ref
  iconColor?: string;
  thumbnail?: { type: 'vault'; path: string } | { type: 'external'; url: string };
  importance?: CalendarNoteImportance;
  nestedBoardPath?: string;
  nestedBoardIcon?: string;
  nestedBoardRoomId?: string;
}

// Month/week agenda over the board-wide dated items (kanban due dates,
// table date columns, and this card's own notes — see dated-items.ts),
// with drag-to-reschedule between day cells.
export interface CalendarCard extends BaseCard {
  kind: 'calendar';
  title?: string;
  titleHidden?: boolean;
  mode?: 'month' | 'week';
  anchor?: string; // ISO date inside the shown month/week; undefined = today
  // When set, Previous/Today/Next and the month/year jump control are all
  // inert — guards against nudging the displayed month off a long-scrolled
  // position (e.g. deep into a historical timeline) with a stray click.
  anchorLocked?: boolean;
  dayStyles?: Record<string, CalendarDayStyle>; // keyed by ISO date
  notes?: CalendarNote[];
}

// A card kind that can live inside a Column. Deliberately excludes the
// container kinds themselves (kanban-column, kanban-board, column) — a
// column holds content cards, not other containers, to avoid unbounded
// nesting. x/y are ignored for children (the column stacks them vertically
// on its own), but kept on the type since these are otherwise ordinary
// cards reusing the exact same render/edit code as their top-level form.
export type ColumnChildCard =
  | TileCard | StickyCard | ChecklistCard | TableCard
  | ImageCard | AudioCard | VideoCard | NoteLinkCard | BookmarkCard | SwatchCard | FileCard | CalloutCard;

// A native-Canvas-style group frame: purely spatial, like Obsidian's own
// Canvas groups — a labeled rectangle that visually encloses whatever
// cards happen to sit inside its bounds. There is no explicit membership
// list; a card "belongs" to the group only by geometry, recomputed live.
// Dragging the frame moves every card currently inside it; resizing only
// changes the frame; deleting the frame never touches its contents.
export interface GroupCard extends BaseCard {
  kind: 'group';
  label?: string;
  color?: string;   // accent for border + label chip; default grey
  // Explicit fill, chosen from a theme-aware pastel palette (see BG_COLORS
  // in context-bar.ts). Only rendered while `transparent` is false —
  // stored independently of it so switching transparency back off
  // restores whatever fill was last picked instead of forgetting it.
  bgColor?: string;
  // true or unset (the default new groups get): a faint tint derived from
  // `color`, same as every group made before bgColor/transparent existed.
  // false: the explicit `bgColor` fill.
  transparent?: boolean;
}

// A generic vertical container, Milanote-style: drag any card from the
// canvas in and it snaps into the stack as a full, fully-functional card
// (not a simplified "item" the way KanbanBoardCard's columns work) —
// still clickable, editable, navigable exactly as it was on the open
// canvas. Reorder by dragging within the stack; drag back onto the open
// canvas to pop a card back out as a normal top-level card.
export interface ColumnCard extends BaseCard {
  kind: 'column';
  title?: string;
  titleHidden?: boolean;
  color?: string;
  bgColor?: string;
  // Background of the inner "tray" area cards drop into and fill up;
  // default is a theme-matched light gray (--background-secondary) when unset.
  trayColor?: string;
  // Color of the card's own outer border; default is the theme's usual
  // card border (--background-modifier-border) when unset.
  borderColor?: string;
  collapsed?: boolean;
  locked?: boolean; // padlock: children can't be dragged in or out (card itself still moves)
  children: ColumnChildCard[];
}

// A live embedded Google Map: paste any Google Maps link (place, search,
// coordinates, or a maps.app.goo.gl short link) and the location renders
// as an interactive keyless embed iframe.
export interface MapCard extends BaseCard {
  kind: 'map';
  url: string; // the Google Maps link as pasted
  // Short links (maps.app.goo.gl / goo.gl/maps) carry no location data in
  // the URL itself — resolved once via HTTP and cached here.
  resolvedUrl?: string;
  resolveFailed?: boolean;
}

// A single color swatch — a hex value plus a human-readable name looked
// up from the nearest entry in a broad-spectrum named-color palette (see
// named-colors.ts). The name is never stored: it's re-derived from `color`
// on every render, so it can't drift out of sync if the palette improves.
export interface SwatchCard extends BaseCard {
  kind: 'swatch';
  color: string;
}

// A generic vault-file attachment — the catch-all for anything that isn't
// an image/audio/note (PDFs, zips, spreadsheets, videos, …). PDFs render a
// live embedded preview; everything else shows a file-type icon + name.
export interface FileCard extends BaseCard {
  kind: 'file';
  path: string; // vault path
}

// A Notion-style callout: icon + accent-tinted banner with inline text.
export interface CalloutCard extends BaseCard {
  kind: 'callout';
  text: string;
  icon?: string;  // emoji (default 💡)
  color: string;  // accent hex — drives the left border + background tint
}

// A single local pass-and-play checkers game. `board` is 64 cells, row-major
// (index = row*8+col, row 0 = top), null on light squares and any empty dark
// square. Lowercase = a plain man, uppercase = a king; 'r'/'R' is red
// (starts at the bottom, rows 5-7, moves toward row 0), 'b'/'B' is black
// (starts at the top, rows 0-2, moves toward row 7). Captures are optional
// (not enforced board-wide) but a capturing piece must finish out any further
// jumps available from its landing square before the turn passes.
export type CheckersPiece = 'r' | 'R' | 'b' | 'B';

export interface CheckersCard extends BaseCard {
  kind: 'checkers';
  board: (CheckersPiece | null)[];
  turn: 'r' | 'b';
  // Set once a side has no pieces (or no legal move) left — board stays on
  // screen but stops accepting clicks until "New game" is used.
  winner?: 'r' | 'b';
}

// A Storyboard is deliberately one top-level canvas card. Sections, shots and
// the objects drawn inside a shot are lightweight nested records rather than
// Card members, keeping them out of the global toolbar/selection/archive.
export type StoryboardAspectRatio = '16:9' | '4:3' | '1:1' | '9:16';

export interface StoryboardPoint { x: number; y: number; p?: number; }
export type StoryboardBrush = 'pen' | 'marker' | 'highlighter' | 'pencil';

export interface StoryboardStroke {
  id: string;
  points: StoryboardPoint[]; // normalized 0..1 shot coordinates
  color: string;
  width: number;
  brush?: StoryboardBrush;
  opacity?: number;
  smoothing?: number;
  pressureEnabled?: boolean;
  simulatePressure?: boolean;
}

export type StoryboardObject =
  | { id: string; kind: 'text'; x: number; y: number; text: string; color?: string; size?: number }
  | { id: string; kind: 'arrow'; x: number; y: number; x2: number; y2: number; bend?: number; color?: string; width?: number };

export interface StoryboardShot {
  id: string;
  shot?: string;
  title?: string;
  duration?: number;
  notes?: string;
  aspectRatio: StoryboardAspectRatio;
  background?: { type: 'vault'; path: string; sharedAsset?: SharedAssetRef } | { type: 'external'; url: string };
  objects: StoryboardObject[];
  drawings: StoryboardStroke[];
  status?: 'idea' | 'draft' | 'approved' | 'shot';
}

export interface StoryboardSection {
  id: string;
  title: string;
  shots: StoryboardShot[];
}

export interface StoryboardCard extends BaseCard {
  kind: 'storyboard';
  title?: string;
  view?: 'filmstrip' | 'grid';
  previewSize?: 'sm' | 'md' | 'lg';
  sections: StoryboardSection[];
}

export type Card =
  | TileCard | StickyCard | ChecklistCard | CommentCard | TableCard
  | ImageCard | AudioCard | VideoCard | NoteLinkCard | BookmarkCard
  | KanbanColumnCard | KanbanBoardCard | ColumnCard | MapCard | SwatchCard | FileCard | CalloutCard
  | GroupCard | CalendarCard | CheckersCard | StoryboardCard | TextCard;
