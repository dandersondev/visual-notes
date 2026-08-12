import { Tile, VisualNotesSettings, DEFAULT_SETTINGS } from './types';

// Runtime validation for the two places untyped data enters settings:
// user-pasted JSON (tile import) and whatever data.json holds at load.
// Deliberately conservative — a wrong-typed optional field is dropped so the
// default wins at the use site; nothing here invents values.

const TILE_KINDS = new Set(['folder', 'canvas', 'note', 'board']);

/** First problem with a would-be Tile, or null if it's valid. Recurses children. */
function tileError(v: unknown, where: string): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${where} is not an object`;
  const t = v as Record<string, unknown>;
  for (const key of ['id', 'label', 'icon', 'color'] as const) {
    if (typeof t[key] !== 'string') return `${where} is missing string field "${key}"`;
  }
  if (typeof t.kind !== 'string' || !TILE_KINDS.has(t.kind)) {
    return `${where} has invalid "kind" (expected folder | canvas | note | board)`;
  }
  if (t.subtitle !== undefined && typeof t.subtitle !== 'string') return `${where}.subtitle is not a string`;
  if (t.targetPath !== undefined && typeof t.targetPath !== 'string') return `${where}.targetPath is not a string`;
  if (t.children !== undefined) {
    if (!Array.isArray(t.children)) return `${where}.children is not an array`;
    for (let i = 0; i < t.children.length; i++) {
      const err = tileError(t.children[i], `${where}.children[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Validates pasted import JSON. All-or-nothing by design: a partial import
 * that silently dropped some of the user's tiles would be worse than a clear
 * refusal naming the first bad entry.
 */
export function validateTileImport(value: unknown): { tiles: Tile[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'Expected a JSON array of tile objects.' };
  for (let i = 0; i < value.length; i++) {
    const err = tileError(value[i], `tile[${i}]`);
    if (err) return { error: err };
  }
  return { tiles: value as Tile[] };
}

const ENUMS: { [K in 'toolbarPosition' | 'mobileFabPosition' | 'panButton']: string[] } = {
  toolbarPosition: ['left', 'right', 'top', 'bottom'],
  mobileFabPosition: ['bottom-right', 'bottom-left', 'top-right', 'top-left'],
  panButton: ['middle', 'right', 'either'],
};

/**
 * Repairs persisted settings at load. Unlike import this is per-field, not
 * all-or-nothing: one corrupt value in data.json must not cost the rest.
 * Invalid tiles are dropped individually; wrong-typed scalars are removed so
 * DEFAULT_SETTINGS / use-site defaults apply; the documented 0.5–2 range on
 * cardDragAnimationIntensity is clamped rather than reset.
 */
export function normalizeSettings(s: VisualNotesSettings): VisualNotesSettings {
  const out = { ...s };

  for (const key of ['rootTiles', 'legacyBackup', 'preImportBackup'] as const) {
    const v: unknown = out[key];
    if (v === undefined && key !== 'rootTiles') continue;
    out[key] = Array.isArray(v) ? (v.filter((t, i) => tileError(t, `${key}[${i}]`) === null) as Tile[]) : [];
  }
  if (typeof out.openOnStartup !== 'boolean') out.openOnStartup = DEFAULT_SETTINGS.openOnStartup;

  for (const key of Object.keys(ENUMS) as (keyof typeof ENUMS)[]) {
    if (out[key] !== undefined && !ENUMS[key].includes(out[key])) delete out[key];
  }
  for (const key of ['defaultBoardPath', 'defaultNewBoardFolder', 'defaultStickyColor', 'commentAuthorName', 'dotColor', 'canvasBgColor', 'clipFolder', 'clipBoardPath'] as const) {
    if (out[key] !== undefined && typeof out[key] !== 'string') delete out[key];
  }
  for (const key of ['v2migrationDone', 'autoRelinkOnOpen', 'cardDragAnimation', 'largeKanbanItems', 'snapToGrid', 'clipAutoImport'] as const) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') delete out[key];
  }
  for (const key of ['bookmarkCacheDays', 'dotSize', 'snapGridSize', 'trashZoneSize', 'cardDragAnimationIntensity'] as const) {
    const v = out[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) delete out[key];
  }
  if (out.cardDragAnimationIntensity !== undefined) {
    out.cardDragAnimationIntensity = Math.min(2, Math.max(0.5, out.cardDragAnimationIntensity));
  }
  if (out.penDrawOptions !== undefined && (typeof out.penDrawOptions !== 'object' || out.penDrawOptions === null)) {
    delete out.penDrawOptions;
  }
  return out;
}
