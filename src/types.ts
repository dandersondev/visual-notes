import type { PenDrawOptions } from './pen-options-panel';

// ── v1 tile type (kept for migration) ────────────────────────

export interface Tile {
  id: string;
  label: string;
  subtitle?: string;
  icon: string;
  color: string;
  kind: 'folder' | 'canvas' | 'note' | 'board';
  targetPath?: string;
  children?: Tile[];
}

// ── Plugin settings ───────────────────────────────────────────

export interface VisualNotesSettings {
  // v1 data — cleared after migration, kept here for the legacy backup
  rootTiles: Tile[];
  openOnStartup: boolean;

  // v2 fields
  defaultBoardPath?: string;    // path to the board opened by the ribbon/command
  defaultNewBoardFolder?: string; // folder new boards are created in; unset = vault root
  v2migrationDone?: boolean;    // prevents re-running migration
  legacyBackup?: Tile[];        // copy of v1 rootTiles saved during migration
  preImportBackup?: Tile[];     // rootTiles as they were just before the last JSON tile import
  bookmarkCacheDays?: number;   // days before re-fetching bookmark OG metadata; default 30
  defaultStickyColor?: string;  // hex color used when creating new sticky notes
  commentAuthorName?: string;   // name shown on new comments/replies you add to a board
  toolbarPosition?: 'left' | 'right' | 'top' | 'bottom';
  autoRelinkOnOpen?: boolean;   // silently fix broken asset paths when a board is opened
  dotColor?: string;            // canvas background dot-grid color; default #d2d2d2 (rgb 210,210,210)
  dotSize?: number;             // canvas background dot-grid radius in px; default 2
  canvasBgColor?: string;       // freeform canvas background color; default #e6e6e6 (rgb 230,230,230)
  cardDragAnimation?: boolean;      // lift/tilt/settle animation while dragging a card; default true
  cardDragAnimationIntensity?: number; // multiplier on tilt angle/lift scale, 0.5-2; default 1
  largeKanbanItems?: boolean;       // bigger text/padding/icon badges on kanban items; default false
  snapToGrid?: boolean;             // snap dragged/resized/newly-placed cards to a grid on the freeform canvas; default true
  snapGridSize?: number;            // grid size in px used by snapToGrid; default 32 (matches the dot-grid spacing)
  trashZoneSize?: number;           // diameter in px of the bottom-left trash drop zone; default 42
  mobileFabPosition?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'; // corner of the phone-width "+" FAB; default bottom-right
  penDrawOptions?: PenDrawOptions;  // perfect-freehand tuning from the pen options panel; default DEFAULT_PEN_DRAW_OPTIONS
  textScale?: number;               // multiplier on every card's text size (not the plugin UI); 1-2.5, default 1
  panButton?: 'middle' | 'right' | 'either'; // which mouse button drags the freeform canvas; default 'middle'

  // Web clips. Notes appearing in clipFolder are added to clipBoardPath as
  // note-link cards. Named for the general case rather than for Obsidian's
  // Web Clipper specifically: the folder is just a folder, so the iOS share
  // sheet, Readwise, or anything else that writes a note lands there too.
  // Both empty = feature off.
  clipFolder?: string;              // vault folder watched for new clips
  clipBoardPath?: string;           // board the clips are added to
  clipAutoImport?: boolean;         // import on startup (and, from v2, live); default true when a folder is set

  // Tags .canvas files that are Visual Notes boards as VISUAL in the file
  // explorer, so they read apart from Obsidian's own canvases. A setting
  // because it is the one feature that depends on Obsidian's internal
  // markup — if a future release ever breaks it, this is the off switch
  // without waiting for one of ours. Default on.
  explorerBoardTint?: boolean;

  // Light/dark button in a board's bottom-right corner. A setting for two
  // separate reasons, either of which alone would justify one: it is the
  // only control in the plugin that changes Obsidian outside the board, and
  // it rests on undocumented API (see theme-scheme.ts), so it is the second
  // feature that could be broken by an Obsidian release rather than by us.
  // Default on.
  appearanceButton?: boolean;
}

export const DEFAULT_SETTINGS: VisualNotesSettings = {
  rootTiles: [],
  openOnStartup: false,
};