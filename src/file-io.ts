import { App, Notice, TFile, TFolder } from 'obsidian';
import { VisualNotesFile } from './file-types';
import { CanvasData, visualNotesToCanvas, canvasToVisualNotes, isVisualNotesCanvas, hasLostRootMetadata } from './canvas-format';
import { migrateLegacyKanbanColumns } from './kanban-migrate';
import { NamePromptModal } from './tile-modal';
import { mergeBoards } from './board-merge';

// ── Backups ───────────────────────────────────────────────────

// Written when a file won't parse at all. Never overwritten — the first
// copy is the one taken closest to whatever broke it.
const CORRUPT_BAK_SUFFIX = '.bak';

// Written either side of native Canvas touching a board: before a deliberate
// switch into the native view, and again if we later find it came back with
// its root metadata stripped. Kept separate from CORRUPT_BAK_SUFFIX so
// neither can clobber the other.
export const NATIVE_BAK_SUFFIX = '.native-backup.bak';

// Written when a save is about to replace a board that has cards on disk with
// one that has none. Clearing a whole board by hand is legitimate and rare, so
// this never blocks the write — but every route to total board loss ends at
// this same shape of write, whatever caused it upstream, so a snapshot here
// makes the damage recoverable without needing to know the cause first.
export const EMPTIED_BAK_SUFFIX = '.before-empty.bak';

// Written when a save finds the file already holds a revision we didn't write
// and didn't load — another device, another pane, native Canvas, a git pull.
// Holds the revision found on disk, so the save can still land without that
// work being destroyed. Refreshed rather than kept-earliest, for the same
// reason as EMPTIED_BAK_SUFFIX: each copy holds the other side's latest work,
// so the newest is the fullest. One refreshing file also means a board being
// autosaved against a busy sync can't spawn backups without bound.
export const CONFLICT_BAK_SUFFIX = '.conflict.bak';

// A file that changes between every attempt is either being written in a tight
// loop by something else or is not going to settle; give up and let the
// caller's save queue report it rather than spinning.
const MAX_WRITE_ATTEMPTS = 3;

// `overwrite: false` keeps the earliest copy (best when the current state is
// the damaged one); `true` refreshes it (best when the current state is known
// good and a newer snapshot is strictly more useful).
async function writeBackup(app: App, path: string, raw: string, overwrite: boolean): Promise<void> {
  try {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if (overwrite) await app.vault.modify(existing, raw);
    } else {
      await app.vault.create(path, raw);
    }
  } catch { /* best effort — never block the open on a failed backup */ }
}

/**
 * Snapshots a board before handing it to Obsidian's native Canvas view.
 * Only snapshots a file that currently reads as a healthy Visual Notes
 * board, so refreshing an existing backup can never replace a good copy
 * with an already-stripped one. Returns true if a backup now exists.
 */
export async function backupBeforeNativeEdit(app: App, file: TFile): Promise<boolean> {
  try {
    const raw = await app.vault.read(file);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    if (hasLostRootMetadata(parsed as CanvasData)) return false; // already damaged
    if (!isVisualNotesCanvas(parsed as CanvasData)) return false;
    await writeBackup(app, file.path + NATIVE_BAK_SUFFIX, raw, true);
    return true;
  } catch {
    return false;
  }
}

// ── Read ──────────────────────────────────────────────────────

export async function readBoardFile(app: App, file: TFile): Promise<VisualNotesFile> {
  let raw: string;
  try {
    raw = await app.vault.read(file);
  } catch {
    // Previously this rejected and the caller had nothing to catch it. Now it
    // returns a board flagged unreadable, which renders as empty but can
    // never be written back — so a file we couldn't even open is left alone.
    new Notice(`Visual Notes: Could not open "${file.name}". The file has been left untouched.`, 8000);
    return unreadableBoard();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid canvas/board file');

    // Native JSON Canvas format (nodes/edges) — whether authored by Icon
    // Board or by Obsidian's own Canvas / another plugin.
    if (Array.isArray((parsed as Record<string, unknown>).nodes)) {
      const data = parsed as CanvasData;
      const board = migrateLegacyKanbanColumns(canvasToVisualNotes(data));
      // Root metadata gone but the cards still stashed on their nodes:
      // native Canvas has rewritten this file. Preserve the damaged state
      // before anything writes over it, and flag it so the caller can put
      // the root block back (see canvas-format's hasLostRootMetadata).
      if (hasLostRootMetadata(data)) {
        await writeBackup(app, file.path + NATIVE_BAK_SUFFIX, raw, false);
        board.recoveredFromNativeEdit = true;
      }
      // The revision this in-memory board is derived from. Every later write
      // is checked against it, so a board held open for hours can't overwrite
      // an edit that arrived from elsewhere in the meantime.
      board.baseline = raw;
      return board;
    }

    throw new Error('Unrecognized file structure');
  } catch {
    const backupPath = file.path + CORRUPT_BAK_SUFFIX;
    try {
      if (!app.vault.getAbstractFileByPath(backupPath)) {
        await app.vault.create(backupPath, raw);
      }
    } catch { /* ignore */ }
    new Notice(
      `Visual Notes: Could not read "${file.name}" — it may be corrupted. ` +
      `A backup was saved as "${file.name}${CORRUPT_BAK_SUFFIX}", and the file has been left untouched.`,
      8000
    );
    return unreadableBoard();
  }
}

/** The placeholder returned when a file can't be read: renders empty, never saves. */
function unreadableBoard(): VisualNotesFile {
  const board = emptyBoard('grid');
  board.unreadable = true;
  return board;
}

/**
 * What a `.canvas` file is, from Visual Notes' point of view.
 *
 * `unreadable` is deliberately its own answer rather than being folded into
 * `foreign`. Those two demand opposite responses: a foreign canvas should be
 * handed to Obsidian's native Canvas view, whereas a file we merely failed to
 * read must NOT be — native Canvas rebuilds a file from its own model when it
 * saves, so handing it a board we couldn't parse is how a transient read
 * error turns into permanent loss of the board's metadata. "I couldn't read
 * this" has to mean stop, not hand it to something that will rewrite it.
 */
export type CanvasFileKind = 'ours' | 'foreign' | 'unreadable';

export async function classifyCanvasFile(app: App, file: TFile): Promise<CanvasFileKind> {
  let raw: string;
  try {
    raw = await app.vault.read(file);
  } catch {
    return 'unreadable';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // A genuinely foreign canvas is still valid JSON with an object at the
    // root; anything else means we can't tell what this file is.
    if (!parsed || typeof parsed !== 'object') return 'unreadable';
    return isVisualNotesCanvas(parsed as CanvasData) ? 'ours' : 'foreign';
  } catch {
    return 'unreadable';
  }
}

/** True if the given vault file is a JSON Canvas authored by Visual Notes (carries our `vn` marker, or the legacy `ib` one). */
export async function isVisualNotesOwnedFile(app: App, file: TFile): Promise<boolean> {
  return (await classifyCanvasFile(app, file)) === 'ours';
}

// ── Write ─────────────────────────────────────────────────────

/**
 * Writes a board, refusing to destroy a revision it didn't expect.
 *
 * The problem this exists for is not a race. A renderer holds its whole board
 * in memory from the moment it opens, so a save an hour later still carries
 * that original snapshot — and writing it blindly overwrites anything that
 * arrived in between, from another device, another pane, or a git pull. No
 * amount of debouncing or serialization helps, because the two writes never
 * had to overlap in the first place.
 *
 *   theirs == base  →  write ours
 *   ours   == base  →  we changed nothing; their revision stands
 *   otherwise       →  real conflict: back theirs up, then write ours
 *
 * The middle case is what keeps the guard from crying wolf: panning schedules
 * a save, so without it, opening a board and scrolling while a sync landed
 * would raise a conflict over a change the user never made. It is also what
 * makes two panes on one board behave — a clean pane defers, a dirty pane
 * conflicts, which is exactly right.
 *
 * Conflicts preserve rather than block, the same choice snapshotIfEmptying
 * makes below: the user keeps working and their save lands, while the other
 * revision is recoverable beside the board.
 */
export async function writeBoardFile(app: App, file: TFile, board: VisualNotesFile): Promise<void> {
  // A board we failed to read is a placeholder, not the user's data. Writing
  // it back is precisely how an unreadable file becomes an empty one.
  if (board.unreadable) return;
  // Runs before the write, as it always has. Folding it into the process()
  // callback below would move its snapshot to *after* the overwrite it exists
  // to protect against. In the rare case where a conflict then stops the
  // write, the extra backup holds the user's own good data — harmless.
  await snapshotIfEmptying(app, file, board);

  let next = JSON.stringify(visualNotesToCanvas(board), null, 2);
  let mergedRemoteChanges = false;
  let mergeConflictCount = 0;

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    let onDisk: string | undefined = undefined;
    let written = false;

    // process() reads and writes as one atomic step. A plain read-then-write
    // would leave a window for the file to change in between — the very bug
    // this function exists to prevent, in miniature.
    //
    // The callback must stay synchronous, so it only decides: backups,
    // notices and baseline updates all happen after it resolves. On a
    // conflict it returns the file unchanged, which is what guarantees
    // nothing is overwritten before the other revision is safely backed up.
    await app.vault.process(file, (current) => {
      onDisk = current;
      // No baseline means a file we created rather than read — a seeded
      // template, a brand-new board. There is no earlier revision to protect.
      if (board.baseline === undefined || current === board.baseline) {
        written = true;
        return next;
      }
      return current;
    });

    if (written) {
      // Load-bearing: without this the next save sees its own write as
      // someone else's change, and every save from here on writes a conflict
      // backup forever.
      board.baseline = next;
      if (mergedRemoteChanges) {
        new Notice(
          mergeConflictCount === 0
            ? `Visual Notes: Merged changes from another copy of "${file.basename}".`
            : `Visual Notes: Merged changes to "${file.basename}" with ${mergeConflictCount} ` +
              `collision${mergeConflictCount === 1 ? '' : 's'}. Your values were kept; the other revision is in ` +
              `"${file.name}${CONFLICT_BAK_SUFFIX}".`,
          mergeConflictCount === 0 ? 5000 : 12000,
        );
      }
      return;
    }

    const theirs: string = onDisk ?? '';
    if (!hasLocalEdits(board, next)) {
      // Nothing of ours to save, so their revision simply stands. Adopting it
      // as our base stops the next save re-reporting the same conflict.
      board.baseline = theirs;
      return;
    }

    const baseBoard = parseBoardRevision(board.baseline);
    const ourBoard = parseBoardRevision(next);
    const theirBoard = parseBoardRevision(theirs);
    if (baseBoard && ourBoard && theirBoard) {
      const result = mergeBoards(baseBoard, ourBoard, theirBoard);
      if (result.conflicts.length > 0) {
        await writeBackup(app, file.path + CONFLICT_BAK_SUFFIX, theirs, true);
        mergeConflictCount += result.conflicts.length;
      }
      applyBoardContent(board, result.board);
      next = JSON.stringify(visualNotesToCanvas(board), null, 2);
      mergedRemoteChanges = true;
    } else {
      // Unreadable revisions retain the conservative behaviour: preserve the
      // disk copy and let the local save land.
      await writeBackup(app, file.path + CONFLICT_BAK_SUFFIX, theirs, true);
      mergeConflictCount++;
      mergedRemoteChanges = true;
    }
    // Their revision is incorporated or safely backed up; use it as the new
    // base for the atomic merged write.
    board.baseline = theirs;
  }

  // Only reachable if the file changed again between every single attempt.
  // Throwing hands this to the caller's save queue, which tells the user their
  // changes are still on screen — far better than returning as if it saved.
  throw new Error(`"${file.name}" kept changing while Visual Notes tried to save it.`);
}

function parseBoardRevision(raw: string | undefined): VisualNotesFile | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!Array.isArray((parsed as Record<string, unknown>).nodes)) return undefined;
    return migrateLegacyKanbanColumns(canvasToVisualNotes(parsed as CanvasData));
  } catch {
    return undefined;
  }
}

/** Replaces serialized board state without disturbing runtime save flags. */
function applyBoardContent(target: VisualNotesFile, source: VisualNotesFile): void {
  target.version = source.version;
  target.layout = source.layout;
  target.cards = source.cards;
  target.connections = source.connections;
  target.drawings = source.drawings;
  copyOptional(target, source, 'dotsHidden');
  copyOptional(target, source, 'appearance');
  copyOptional(target, source, 'viewport');
  copyOptional(target, source, 'archived');
  copyOptional(target, source, 'foreignNodes');
  copyOptional(target, source, 'foreignEdges');
}

function copyOptional<K extends keyof VisualNotesFile>(target: VisualNotesFile, source: VisualNotesFile, key: K): void {
  if (source[key] === undefined) delete target[key];
  else target[key] = source[key];
}

/**
 * True if the in-memory board differs from the revision it was loaded from.
 *
 * Viewport is normalised out because panning is not content: it is stored in
 * the file, and it schedules a save, so counting it would make simply looking
 * around a board enough to raise a conflict.
 *
 * Anything unparseable falls back to a plain text comparison — that errs
 * toward "we have edits", which errs toward preserving both sides.
 */
function hasLocalEdits(board: VisualNotesFile, serialized: string): boolean {
  if (board.baseline === undefined) return true;
  return contentKey(serialized) !== contentKey(board.baseline);
}

/** A board's text with view-only state stripped, for comparing content alone. */
function contentKey(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> & { vn?: Record<string, unknown> };
    if (!parsed || typeof parsed !== 'object' || !parsed.vn || typeof parsed.vn !== 'object') return raw;
    const vn = { ...parsed.vn };
    delete vn.viewport;
    return JSON.stringify({ ...parsed, vn });
  } catch {
    return raw;
  }
}

/**
 * Backs the file up when this write would take a board from having cards on
 * disk to having none.
 *
 * Deliberately does not block the write: clearing a board by hand is a real
 * thing to do, and refusing would break it. The value is that total loss
 * becomes recoverable no matter which upstream path caused it — a guard at
 * the point of damage rather than at each of the many ways to reach it.
 *
 * The backup is refreshed rather than kept-earliest (unlike the corrupt-file
 * one): the pre-empty state is by definition the fuller of the two, so the
 * most recent snapshot is always the most useful.
 */
async function snapshotIfEmptying(app: App, file: TFile, board: VisualNotesFile): Promise<void> {
  if (board.cards.length > 0) return;
  try {
    const raw = await app.vault.read(file);
    const parsed: unknown = JSON.parse(raw);
    const nodes = (parsed as CanvasData | null)?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    await writeBackup(app, file.path + EMPTIED_BAK_SUFFIX, raw, true);
    new Notice(
      `Visual Notes: "${file.basename}" just went from ${nodes.length} item${nodes.length === 1 ? '' : 's'} ` +
      `to empty. If that wasn't deliberate, the previous version is saved as ` +
      `"${file.name}${EMPTIED_BAK_SUFFIX}".`,
      12000
    );
  } catch {
    // Nothing readable on disk to preserve — the write is no worse than what's there.
  }
}

// ── Create ────────────────────────────────────────────────────

export async function createBoardFile(
  app: App,
  name: string,
  folder: TFolder | null,
  layout: 'grid' | 'freeform'
): Promise<TFile> {
  return writeNewBoardFile(app, name, folder, emptyBoard(layout));
}

// ── Templates ─────────────────────────────────────────────────

export const TEMPLATES_FOLDER = '_Templates';

// Group templates (reusable clusters of cards saved off a board, rather
// than whole boards) live in a subfolder of the same place. Declared here
// next to TEMPLATES_FOLDER because listTemplates has to know to skip it —
// see group-templates.ts for everything else about them.
export const GROUP_TEMPLATES_FOLDER = `${TEMPLATES_FOLDER}/Groups`;

// Template files are just ordinary Visual Notes boards that happen to live
// in this one folder — nothing distinguishes them at the file-format level.
export function listTemplates(app: App): TFile[] {
  return app.vault.getFiles().filter(
    f => f.extension === 'canvas'
      && f.path.startsWith(`${TEMPLATES_FOLDER}/`)
      // Group templates are board fragments, not whole boards — they'd
      // spawn a near-empty board if offered in the new-board picker.
      && !f.path.startsWith(`${GROUP_TEMPLATES_FOLDER}/`)
  );
}

// Spawns a new board from a template file. The template itself is never
// opened or modified — its contents are copied into a brand-new file with
// every card/connection/drawing id regenerated, so opening the same
// template repeatedly always yields independent boards, and the template
// stays exactly as-is for next time.
export async function createBoardFileFromTemplate(
  app: App,
  templateFile: TFile,
  folder: TFolder | null
): Promise<TFile> {
  const templateBoard = await readBoardFile(app, templateFile);
  return writeNewBoardFile(app, templateFile.basename, folder, withFreshIds(templateBoard));
}

// Writes a bundled starter template into _Templates/<name>.canvas so it
// behaves like any user-made template from then on (editable, deletable,
// listed by listTemplates). If a template with that name already exists —
// including a user-modified copy of the same starter — it is returned
// untouched rather than overwritten.
export async function installStarterTemplate(app: App, name: string, json: string): Promise<TFile> {
  await ensureDir(app, TEMPLATES_FOLDER);
  const path = `${TEMPLATES_FOLDER}/${name}.canvas`;
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  return app.vault.create(path, json);
}

// Saves a copy of the given board's data into _Templates/<name>.canvas.
// The archive is dropped — a template is meant to be a lean starting point,
// not carry over whatever happened to be archived on the board it came from.
export async function saveBoardAsTemplate(app: App, board: VisualNotesFile, name: string): Promise<TFile> {
  await ensureDir(app, TEMPLATES_FOLDER);
  const found = app.vault.getAbstractFileByPath(TEMPLATES_FOLDER);
  const folder = found instanceof TFolder ? found : null;
  const clone = JSON.parse(JSON.stringify(board)) as VisualNotesFile;
  delete clone.archived;
  return writeNewBoardFile(app, name, folder, clone);
}

// Shared by the toolbar's "…" overflow menu and the "Save current board as
// template" command — reads the file fresh off disk rather than reaching
// into a live renderer, so it works the same for both grid and freeform
// layouts without either renderer needing to expose its board.
export function promptSaveBoardAsTemplate(app: App, file: TFile): void {
  new NamePromptModal(app, 'Save as template', 'Template name', (name) => { void (async () => {
    const board = await readBoardFile(app, file);
    const saved = await saveBoardAsTemplate(app, board, name);
    new Notice(`Visual Notes: Saved template "${saved.basename}".`);
  })(); }, file.basename, 'Save').open();
}

// ── Helpers ───────────────────────────────────────────────────

export async function ensureDir(app: App, dir: string): Promise<void> {
  const parts = dir.split('/');
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch { /* folder may already exist */ }
    }
  }
}

// Resolves name/folder to a collision-safe path (appending " 1", " 2", …
// before the extension as needed) and writes board there.
export async function writeNewBoardFile(app: App, name: string, folder: TFolder | null, board: VisualNotesFile): Promise<TFile> {
  const safeName = name.trim() || 'New Visual Notes board';
  const baseName = safeName.endsWith('.canvas') ? safeName : `${safeName}.canvas`;
  const folderPath = folder ? folder.path : '';

  let finalPath = folderPath ? `${folderPath}/${baseName}` : baseName;
  let counter = 1;
  while (app.vault.getAbstractFileByPath(finalPath)) {
    const stem = baseName.replace(/\.canvas$/, '');
    const candidate = `${stem} ${counter}.canvas`;
    finalPath = folderPath ? `${folderPath}/${candidate}` : candidate;
    counter++;
  }

  const data = visualNotesToCanvas(board);
  return app.vault.create(finalPath, JSON.stringify(data, null, 2));
}

function emptyBoard(layout: 'grid' | 'freeform'): VisualNotesFile {
  const board: VisualNotesFile = { version: 3, layout, cards: [], connections: [], drawings: [] };
  if (layout === 'freeform') board.viewport = { x: 0, y: 0, zoom: 1 };
  return board;
}

// Deep-clones a board, giving every card (top-level and nested inside a
// Column or Kanban board/column), connection, and drawing stroke a fresh id
// — remapping connection endpoints and drawing groupIds to match — so a
// board spawned from a template never shares ids with the template or with
// any other board spawned from the same one.
export function withFreshIds(board: VisualNotesFile): VisualNotesFile {
  const clone = JSON.parse(JSON.stringify(board)) as VisualNotesFile;
  const cardIdMap = new Map<string, string>();

  const remapChild = (c: { id: string }) => {
    const fresh = crypto.randomUUID();
    cardIdMap.set(c.id, fresh);
    c.id = fresh;
  };
  const remapCard = (card: VisualNotesFile['cards'][number]) => {
    remapChild(card);
    if (card.kind === 'column') for (const ch of card.children) remapChild(ch);
    if (card.kind === 'kanban-board') for (const col of card.columns) for (const it of col.items) remapChild(it);
    if (card.kind === 'kanban-column') for (const it of card.items) remapChild(it);
  };

  for (const card of clone.cards) remapCard(card);
  for (const card of clone.archived ?? []) remapCard(card);

  for (const conn of clone.connections) {
    conn.id = crypto.randomUUID();
    if (conn.fromCardId) conn.fromCardId = cardIdMap.get(conn.fromCardId) ?? conn.fromCardId;
    if (conn.toCardId) conn.toCardId = cardIdMap.get(conn.toCardId) ?? conn.toCardId;
  }

  // Strokes drawn in one pen session share a groupId (so they're selected/
  // moved/deleted together) — regenerate it once per original groupId, not
  // once per stroke, or that grouping would be lost.
  const groupIdMap = new Map<string, string>();
  for (const d of clone.drawings) {
    d.id = crypto.randomUUID();
    if (!groupIdMap.has(d.groupId)) groupIdMap.set(d.groupId, crypto.randomUUID());
    d.groupId = groupIdMap.get(d.groupId)!;
  }

  return clone;
}
