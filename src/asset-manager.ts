import { App, TFile } from 'obsidian';
import { VisualNotesFile } from './file-types';
import { readBoardFile, writeBoardFile, isVisualNotesOwnedFile, ensureDir } from './file-io';

// ── Extension → subfolder mapping ─────────────────────────────

const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','avif'];
const AUDIO_EXTS = ['mp3','wav','ogg','flac','aac','m4a','opus','webm'];
// Kept in step with VIDEO_EXTS in freeform-view-shared.ts, which decides what
// becomes a video card — a file rendering as video while being filed under
// Audio would be its own small confusion.
const VIDEO_EXTS = ['mp4','webm','mov','m4v','ogv','mkv','avi'];
const DOC_EXTS   = ['pdf'];

function assetSubfolder(ext: string): string {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.includes(e)) return 'Images';
  // Video before audio, because webm is in both lists and is far more often a
  // video — and since a dropped .webm now renders as a video card, filing it
  // under Audio would put the file somewhere its own card contradicts. Only
  // affects newly sorted files; nothing already in _Assets is moved.
  if (VIDEO_EXTS.includes(e)) return 'Video';
  if (AUDIO_EXTS.includes(e)) return 'Audio';
  if (DOC_EXTS.includes(e))   return 'Documents';
  return 'Other';
}

// ── Vault helpers ──────────────────────────────────────────────

// Returns a collision-safe path in dir for base.ext, incrementing -2/-3/… as needed.
function uniquePath(app: App, dir: string, base: string, ext: string): string {
  const candidate = (n: number) => n === 0 ? `${dir}/${base}.${ext}` : `${dir}/${base}-${n}.${ext}`;
  let i = 0;
  while (app.vault.getAbstractFileByPath(candidate(i))) i++;
  return candidate(i);
}

// ── Public API ─────────────────────────────────────────────────

// Move an existing vault file into _Assets/<type>/. Returns the new vault path.
// If the file is already in the correct folder, returns its current path unchanged.
export async function sortAssetFile(app: App, file: TFile): Promise<string> {
  const sub  = assetSubfolder(file.extension);
  const dir  = `_Assets/${sub}`;
  const want = `${dir}/${file.name}`;
  if (file.path === want) return file.path;
  await ensureDir(app, dir);
  const finalPath = uniquePath(app, dir, file.basename, file.extension);
  await app.fileManager.renameFile(file, finalPath);
  return finalPath;
}

// Write a new binary file (external drop / paste / upload) into _Assets/<type>/.
// The filename is used as-is (after stripping spaces for path safety); collisions
// are resolved by appending -2/-3/… before the extension.
export async function saveNewAsset(app: App, data: ArrayBuffer, filename: string): Promise<string> {
  const ext      = filename.split('.').pop() ?? 'bin';
  const base     = filename.replace(/\.[^.]+$/, '');
  const sub      = assetSubfolder(ext);
  const dir      = `_Assets/${sub}`;
  await ensureDir(app, dir);
  const finalPath = uniquePath(app, dir, base, ext);
  await app.vault.createBinary(finalPath, data);
  return finalPath;
}

// ── Relink ────────────────────────────────────────────────────

// Mutates board in place: for each broken vault path, searches the vault by filename.
// Auto-fixes if exactly one match is found. Returns the number of links fixed.
//
// Synchronous: every lookup goes through findMatch, which only consults
// Vault's in-memory file list. It was previously declared async despite never
// awaiting anything, which made callers look as though they were waiting on
// disk I/O that never happened.
export function relinkBoardData(app: App, board: VisualNotesFile): number {
  let fixed = 0;
  for (const card of board.cards) {
    if (card.kind === 'image' && card.source.type === 'vault') {
      const r = findMatch(app, card.source.path);
      if (r) { card.source.path = r; fixed++; }
    } else if (card.kind === 'audio') {
      const r = findMatch(app, card.source.path);
      if (r) { card.source.path = r; fixed++; }
    } else if (card.kind === 'note-link') {
      const r = findMatch(app, card.path);
      if (r) { card.path = r; fixed++; }
    } else if (card.kind === 'file') {
      const r = findMatch(app, card.path);
      if (r) { card.path = r; fixed++; }
    } else if (card.kind === 'tile' && card.target.kind !== 'folder') {
      const r = findMatch(app, card.target.path);
      if (r) { card.target.path = r; fixed++; }
    } else if (card.kind === 'kanban-column') {
      for (const item of card.items) {
        if (item.imagePath)      { const r = findMatch(app, item.imagePath);      if (r) { item.imagePath      = r; fixed++; } }
        if (item.audioPath)      { const r = findMatch(app, item.audioPath);      if (r) { item.audioPath      = r; fixed++; } }
        if (item.linkedNotePath) { const r = findMatch(app, item.linkedNotePath); if (r) { item.linkedNotePath = r; fixed++; } }
      }
    }
  }
  return fixed;
}

// Scans every .canvas file carrying Visual Notes' marker, fixes broken
// paths, saves changed files. Deliberately skips plain native .canvas files
// that weren't created by Visual Notes, so this never rewrites someone
// else's canvas. Returns the total number of links fixed across all boards.
export async function relinkAllBoards(app: App): Promise<number> {
  const candidates = app.vault.getFiles().filter(f => f.extension === 'canvas');
  let total = 0;
  for (const bf of candidates) {
    try {
      if (!(await isVisualNotesOwnedFile(app, bf))) continue;
      const board = await readBoardFile(app, bf);
      const n = relinkBoardData(app, board);
      if (n > 0) { await writeBoardFile(app, bf, board); total += n; }
    } catch { /* skip unreadable boards */ }
  }
  return total;
}

// Returns a new path if path is broken and a unique filename match exists, else null.
function findMatch(app: App, path: string): string | null {
  if (!path || app.vault.getAbstractFileByPath(path)) return null;
  const name    = path.split('/').pop()!;
  const matches = app.vault.getFiles().filter(f => f.name === name);
  return matches.length === 1 ? matches[0].path : null;
}
