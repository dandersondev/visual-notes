// Adds notes that appear in a chosen folder to a chosen board as note-link
// cards.
//
// Built for Obsidian's Web Clipper, which is a browser extension and so can
// never be part of this plugin — it reads the rendered, logged-in page, which
// nothing inside Obsidian can. What it *can* be given is a destination
// folder, and that folder is the whole integration surface. Writing it as
// "notes in this folder appear on this board" rather than as a Web Clipper
// feature means the iOS share sheet, Readwise, and anything else that writes
// a note get the same behaviour for free.
//
// The operation is idempotent, which is what lets three different triggers
// share one path: a startup reconcile, a manual command, and (from v2) a live
// vault listener all call addClipsToBoard and none of them need to know what
// the others did. Idempotence is also what makes the startup reconcile safe
// to run at all — without it, catching up on clips made while Obsidian was
// closed would mean re-adding every clip ever made.
import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { Card, NoteLinkCard, VisualNotesFile } from './file-types';
import { readBoardFile, writeBoardFile, classifyCanvasFile } from './file-io';
import { NOTELINK_DEFAULT_W, NOTELINK_DEFAULT_H, isValidURL } from './freeform-view-shared';

// Clips are laid out below everything already on the board, in rows.
const CLIP_GAP = 32;          // matches the default snap grid
const CLIPS_PER_ROW = 4;

export interface ClipImportResult {
  added: number;
  alreadyPresent: number;
  /** Set when nothing could be imported at all; already user-facing prose. */
  refusal?: string;
}

/**
 * True if `path` sits inside `folder`.
 *
 * Compared by whole path segments rather than as a raw string prefix, because
 * a prefix test puts "Clippings-old/note.md" inside "Clippings". An empty
 * folder means the feature is off, never "the whole vault".
 */
export function isInClipFolder(path: string, folder: string | undefined): boolean {
  if (!folder) return false;
  const f = normalizePath(folder).replace(/\/+$/, '');
  if (!f || f === '/') return false;
  return path === f || path.startsWith(`${f}/`);
}

/**
 * Where the next `count` clips go: a block of rows starting below everything
 * already placed.
 *
 * Deliberately not a gap-finder. Dropping new cards underneath existing
 * content is predictable — you always know where to look — and it can't
 * wedge a clip into the middle of a layout somebody arranged by hand. Pure
 * arithmetic so it is testable, since jsdom has no layout engine and every
 * measurement it offers reads zero.
 */
export function nextClipPositions(
  cards: Card[],
  count: number,
  size: { w: number; h: number } = { w: NOTELINK_DEFAULT_W, h: NOTELINK_DEFAULT_H },
): { x: number; y: number }[] {
  let left = 0;
  let top = 0;
  if (cards.length > 0) {
    left = Math.min(...cards.map(c => c.x ?? 0));
    top = Math.max(...cards.map(c => (c.y ?? 0) + (c.h ?? 0))) + CLIP_GAP;
  }
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % CLIPS_PER_ROW;
    const row = Math.floor(i / CLIPS_PER_ROW);
    out.push({
      x: left + col * (size.w + CLIP_GAP),
      y: top + row * (size.h + CLIP_GAP),
    });
  }
  return out;
}

/** Paths in `paths` that no note-link card on `board` already points at. */
export function missingClipPaths(board: VisualNotesFile, paths: string[]): string[] {
  const present = new Set(
    board.cards.filter((c): c is NoteLinkCard => c.kind === 'note-link').map(c => c.path),
  );
  // Deduplicated against itself too: the same path can arrive from the
  // reconcile pass and a live event in the same batch.
  const seen = new Set<string>();
  return paths.filter(p => !present.has(p) && !seen.has(p) && (seen.add(p), true));
}

/** Builds the cards for `paths`, positioned as a block below existing content. */
export function buildClipCards(board: VisualNotesFile, paths: string[]): NoteLinkCard[] {
  const at = nextClipPositions(board.cards, paths.length);
  const baseZ = board.cards.reduce((m, c) => Math.max(m, c.z ?? 0), 0);
  return paths.map((path, i) => ({
    id: crypto.randomUUID(),
    kind: 'note-link' as const,
    path,
    displayMode: 'preview' as const,
    x: at[i].x,
    y: at[i].y,
    w: NOTELINK_DEFAULT_W,
    h: NOTELINK_DEFAULT_H,
    z: baseZ + 1 + i,
    clipImportedAt: Date.now(),
  }));
}

/**
 * Whether a vault event about `path` should queue a clip import.
 *
 * Pure, and separate from the listener that calls it, because this is the
 * decision worth testing: everything else in the live path is Obsidian
 * plumbing. Both the folder and the board have to be set — with a folder but
 * no board, every clip would raise a "no board is set" notice, which is a
 * worse way to learn the feature is half-configured than simply staying
 * quiet until it is.
 */
export function shouldQueueClip(
  path: string,
  extension: string,
  settings: { clipFolder?: string; clipBoardPath?: string; clipAutoImport?: boolean },
): boolean {
  if (settings.clipAutoImport === false) return false;
  if (!settings.clipFolder || !settings.clipBoardPath) return false;
  if (extension !== 'md') return false;
  return isInClipFolder(path, settings.clipFolder);
}

// ── Clip metadata ───────────────────────────────────────────────
//
// What a clipper writes into a note's properties. Several key names are
// accepted for the source because different tools pick different ones, and
// getting a clip's own link wrong is worse than a slightly longer list.
const SOURCE_KEYS = ['source', 'url', 'source_url', 'original'];
const IMAGE_KEYS = ['image', 'cover', 'banner', 'thumbnail'];

export interface ClipMeta {
  title?: string;
  sourceUrl?: string;
  description?: string;
  image?: string;
}

function firstString(fm: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Pulls the useful properties out of a clipped note's frontmatter.
 *
 * URLs are validated here rather than at the point of display, so a property
 * carrying something that isn't a web link simply doesn't produce a link.
 * Everything is optional by design: a clip missing all of it still has to
 * render, just without the extras.
 */
export function clipMetaFromFrontmatter(fm: Record<string, unknown> | undefined): ClipMeta {
  if (!fm) return {};
  const source = firstString(fm, SOURCE_KEYS);
  const image = firstString(fm, IMAGE_KEYS);
  return {
    title: firstString(fm, ['title']),
    sourceUrl: source && isValidURL(source) ? source : undefined,
    description: firstString(fm, ['description', 'excerpt', 'summary']),
    image: image && isValidURL(image) ? image : undefined,
  };
}

/**
 * The note's body, without its YAML frontmatter block.
 *
 * A note-link card renders the file's raw text, so without this a clipped
 * note leads with a wall of `source:` / `author:` / `published:` lines —
 * exactly the properties the card is about to display properly itself.
 * Matches only a block that opens on the very first line, which is the only
 * place frontmatter is allowed to be.
 */
export function stripFrontmatter(content: string): string {
  // The body group is optional so an empty block (`---` immediately followed
  // by `---`, which Obsidian itself can leave behind) is still matched.
  const m = /^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/.exec(content);
  return m ? content.slice(m[0].length) : content;
}

/**
 * True if this note looks like a page clipped from the web.
 *
 * Decided by the note's own properties rather than by which folder it is in,
 * so a clip that has been filed away somewhere else is still recognised as
 * one — and so nothing has to be configured for a dropped clip to render
 * like a clip.
 */
export function isClippedPage(app: App, file: TFile): boolean {
  return clipMetaFromFrontmatter(app.metadataCache.getFileCache(file)?.frontmatter).sourceUrl !== undefined;
}

/** The bit of a URL worth showing on a card: its domain, without "www.". */
export function displayDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return undefined; }
}

/** Every markdown file currently sitting in the clip folder, path-sorted. */
export function listClipFiles(app: App, folder: string | undefined): TFile[] {
  if (!folder) return [];
  return app.vault.getFiles()
    .filter(f => f.extension === 'md' && isInClipFolder(f.path, folder))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Adds `paths` to the board at `boardPath`, skipping any already on it.
 *
 * `mutateOpenBoard` is how the caller handles the board being open in a view:
 * an open board is held in memory by its renderer, whose next save would
 * overwrite anything written to the file behind it, so writing the file is
 * only safe when nothing is showing it. It returns the number added, or null
 * if no view is showing the board and this should go to disk instead.
 */
export async function addClipsToBoard(
  app: App,
  boardPath: string | undefined,
  paths: string[],
  mutateOpenBoard: (boardPath: string, add: (board: VisualNotesFile) => NoteLinkCard[]) => Promise<number | null>,
): Promise<ClipImportResult> {
  const empty = { added: 0, alreadyPresent: 0 };
  if (!boardPath) return { ...empty, refusal: 'No board is set to collect clips. Choose one in Visual Notes settings.' };
  if (paths.length === 0) return empty;

  const target = app.vault.getAbstractFileByPath(normalizePath(boardPath));
  if (!(target instanceof TFile)) {
    return { ...empty, refusal: `The board set for clips ("${boardPath}") no longer exists.` };
  }
  const kind = await classifyCanvasFile(app, target);
  if (kind !== 'ours') {
    return {
      ...empty,
      refusal: kind === 'unreadable'
        ? `"${target.basename}" could not be read, so nothing was added to it.`
        : `"${target.basename}" isn't a Visual Notes board.`,
    };
  }

  // One shared closure so the open-board and on-disk routes can't drift: both
  // compute what to add from whichever board object is authoritative.
  const add = (board: VisualNotesFile): NoteLinkCard[] => {
    const missing = missingClipPaths(board, paths);
    return buildClipCards(board, missing);
  };

  const addedLive = await mutateOpenBoard(target.path, add);
  if (addedLive !== null) {
    return { added: addedLive, alreadyPresent: paths.length - addedLive };
  }

  // Nothing showing it — read once, add everything, write once. A write per
  // clip would be slower and would leave a half-imported board if one failed.
  const board = await readBoardFile(app, target);
  if (board.unreadable) {
    return { ...empty, refusal: `"${target.basename}" could not be read, so nothing was added to it.` };
  }
  if (board.layout !== 'freeform') {
    return { ...empty, refusal: `"${target.basename}" is a grid board. Clips can only be added to freeform boards.` };
  }
  const cards = add(board);
  if (cards.length === 0) return { added: 0, alreadyPresent: paths.length };
  board.cards.push(...cards);
  await writeBoardFile(app, target, board);
  return { added: cards.length, alreadyPresent: paths.length - cards.length };
}

/** The message shown after an import. Silence would read as a failure. */
export function clipImportNotice(result: ClipImportResult): string {
  if (result.refusal) return `Visual Notes: ${result.refusal}`;
  if (result.added === 0 && result.alreadyPresent === 0) return 'Visual Notes: no clips found to import.';
  if (result.added === 0) return `Visual Notes: no new clips — all ${result.alreadyPresent} are already on the board.`;
  const skipped = result.alreadyPresent > 0 ? `; ${result.alreadyPresent} already there` : '';
  return `Visual Notes: added ${result.added} clip${result.added === 1 ? '' : 's'}${skipped}.`;
}

/** Shows the result of an import, unless it was a silent no-op. */
export function announceClipImport(result: ClipImportResult, silentWhenNothingToDo: boolean): void {
  if (silentWhenNothingToDo && !result.refusal && result.added === 0) return;
  new Notice(clipImportNotice(result), result.refusal ? 10000 : 6000);
}

/** True if the configured clip folder exists in the vault. */
export function clipFolderExists(app: App, folder: string | undefined): boolean {
  if (!folder) return false;
  return app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder;
}
