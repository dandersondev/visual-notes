// Generates synthetic large boards for manual performance testing — drop
// the output .canvas files into a vault, open each in Visual Notes, and use
// Obsidian's own DevTools (Ctrl+Shift+I — it's Electron/Chromium under the
// hood) Performance tab while opening/zooming/dragging/searching/toggling
// the minimap. There is no way to automate real paint/interaction timing
// without the actual app, so this only automates generating realistic
// input at each size, not the measurement itself.
//
// Reuses the real visualNotesToCanvas serializer (bundled fresh via esbuild,
// same trick as scripts/generate-starter-templates.mjs's sibling script for
// extracting templates) so these boards are byte-faithful to what the
// plugin itself would produce — not a hand-rolled approximation of the
// format.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'benchmarks');
const SIZES = [100, 500, 1000];

async function loadVisualNotesToCanvas() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/canvas-format.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    alias: { obsidian: path.join(ROOT, 'test/obsidian-stub.ts') },
  });
  const tmp = path.join(ROOT, `_bench-canvas-format-${process.pid}.mjs`);
  fs.writeFileSync(tmp, result.outputFiles[0].text, 'utf8');
  try {
    return await import(`file://${tmp}`);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// A rotating mix of card kinds so a benchmark board resembles a real one —
// not just N identical sticky notes, which would under-represent the cost
// of table/kanban/checklist rendering.
function makeCard(i, x, y) {
  const kind = i % 10;
  const base = { id: `bench-${i}`, x, y, z: i };
  if (kind < 5) {
    // Half the board: plain sticky notes — the cheapest, most common kind.
    return { ...base, kind: 'sticky', w: 240, h: 160, text: `Sticky note #${i}\n\nSome sample body text to approximate real content length.`, color: '#FDE68A' };
  }
  if (kind < 7) {
    return { ...base, kind: 'tile', w: 200, h: 120, label: `Tile ${i}`, icon: 'star', color: '#3B82F6', target: { kind: 'note', path: `Note ${i}.md` } };
  }
  if (kind === 7) {
    return {
      ...base, kind: 'checklist', w: 280, h: 260, color: '#ffffff', title: `Checklist ${i}`,
      items: Array.from({ length: 5 }, (_, j) => ({ id: `bench-${i}-item-${j}`, text: `Item ${j}`, done: j % 2 === 0 })),
    };
  }
  if (kind === 8) {
    return {
      ...base, kind: 'table', w: 340, h: 240, color: '#ffffff', title: `Table ${i}`,
      columns: [{ id: 'c1', label: 'Name', type: 'text' }, { id: 'c2', label: 'Done', type: 'checkbox' }],
      rows: Array.from({ length: 6 }, (_, j) => ({ id: `bench-${i}-row-${j}`, cells: { c1: `Row ${j}`, c2: j % 2 === 0 ? 'true' : '' } })),
    };
  }
  // kind === 9: a small kanban board — the most expensive common kind.
  return {
    ...base, kind: 'kanban-board', w: 580, h: 380, title: `Board ${i}`,
    columns: [
      { id: `bench-${i}-col-a`, color: '#eee', title: 'To do', items: Array.from({ length: 4 }, (_, j) => ({ id: `bench-${i}-a-${j}`, text: `Task ${j}` })) },
      { id: `bench-${i}-col-b`, color: '#cfc', title: 'Done', items: Array.from({ length: 4 }, (_, j) => ({ id: `bench-${i}-b-${j}`, text: `Task ${j}`, done: true })) },
    ],
  };
}

function generateBoard(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const spacingX = 340, spacingY = 300;
  const cards = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    cards.push(makeCard(i, col * spacingX, row * spacingY));
  }

  // Connections roughly proportional to card count: a chain through every
  // card (n-1 links, the common "flow diagram" case) plus a sparser set of
  // random cross-links (~n/5) so connection routing/rendering is exercised
  // at a realistic density without every board becoming a single long line.
  const connections = [];
  for (let i = 0; i < n - 1; i++) {
    connections.push({
      id: `bench-conn-${i}`, fromCardId: `bench-${i}`, toCardId: `bench-${i + 1}`,
      routing: 'straight', color: '#6b7280', style: 'solid', arrowhead: 'end', thickness: 2,
    });
  }
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < Math.floor(n / 5); i++) {
    const a = Math.floor(rand() * n), b = Math.floor(rand() * n);
    if (a === b) continue;
    connections.push({
      id: `bench-cross-${i}`, fromCardId: `bench-${a}`, toCardId: `bench-${b}`,
      routing: 'elbow', color: '#a855f7', style: 'dashed', arrowhead: 'end', thickness: 2,
    });
  }

  return {
    version: 3, layout: 'freeform', cards, connections, drawings: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

// A focused Storyboard fixture for measuring the feature's real hot path:
// one nested node, forty shots, 120 pressure-sensitive strokes and enough
// normalized samples to exercise serialization, parsing and brush rendering.
function generateStoryboardBoard() {
  const sections = Array.from({ length: 4 }, (_, sectionIndex) => ({
    id: `story-section-${sectionIndex + 1}`,
    title: `Scene section ${sectionIndex + 1}`,
    shots: Array.from({ length: 10 }, (_, shotIndex) => {
      const absoluteIndex = sectionIndex * 10 + shotIndex;
      const drawings = Array.from({ length: 3 }, (_, strokeIndex) => ({
        id: `story-stroke-${absoluteIndex}-${strokeIndex}`,
        brush: ['pen', 'marker', 'pencil'][strokeIndex],
        color: ['#ef4444', '#2563eb', '#1f2937'][strokeIndex],
        width: [5, 12, 4][strokeIndex], opacity: [1, .82, .68][strokeIndex],
        smoothing: [.55, .7, .38][strokeIndex], pressureEnabled: true, simulatePressure: false,
        points: Array.from({ length: 100 }, (_, pointIndex) => ({
          x: Math.round((.04 + pointIndex / 109) * 10_000) / 10_000,
          y: Math.round((.2 + strokeIndex * .25 + Math.sin((pointIndex + absoluteIndex) / 8) * .08) * 10_000) / 10_000,
          p: Math.round((.2 + ((pointIndex + strokeIndex * 17) % 80) / 100) * 10_000) / 10_000,
        })),
      }));
      return {
        id: `story-shot-${absoluteIndex + 1}`, shot: `${sectionIndex + 1}.${shotIndex + 1}`,
        title: `Benchmark shot ${absoluteIndex + 1}`, duration: 3, aspectRatio: absoluteIndex % 7 === 0 ? '4:3' : '16:9',
        notes: 'A representative shot description used to measure preview captions and native Markdown projection.',
        background: { type: 'vault', path: `Benchmark Assets/frame-${String(absoluteIndex + 1).padStart(2, '0')}.jpg` },
        objects: [{ id: `story-label-${absoluteIndex}`, kind: 'text', x: .08, y: .08, text: `SHOT ${absoluteIndex + 1}`, color: '#ffffff', size: 24 }],
        drawings, status: 'draft',
      };
    }),
  }));
  return {
    version: 3, layout: 'freeform',
    cards: [{ id: 'storyboard-40', kind: 'storyboard', title: '40-shot performance storyboard', view: 'grid', previewSize: 'md', x: 0, y: 0, w: 900, h: 620, z: 1, sections }],
    connections: [], drawings: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
}

const { visualNotesToCanvas } = await loadVisualNotesToCanvas();

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const n of SIZES) {
  const board = generateBoard(n);
  const data = visualNotesToCanvas(board);
  const outPath = path.join(OUT_DIR, `Benchmark ${n}.canvas`);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`wrote ${outPath} — ${board.cards.length} cards, ${board.connections.length} connections`);
}
const storyboard = generateStoryboardBoard();
const storyboardPath = path.join(OUT_DIR, 'Storyboard 40.canvas');
fs.writeFileSync(storyboardPath, JSON.stringify(visualNotesToCanvas(storyboard), null, 2), 'utf8');
console.log(`wrote ${storyboardPath} — 40 shots, 120 strokes, 12000 ink samples`);
console.log('\nCopy the .canvas file(s) you want into your vault and open them in Visual Notes.');
console.log('Obsidian is Electron/Chromium — Ctrl+Shift+I opens real DevTools; use the Performance');
console.log('tab while opening/zooming/dragging/searching/toggling the minimap to get real numbers.');
