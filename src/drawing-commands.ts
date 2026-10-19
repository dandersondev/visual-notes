import type { FreeformRenderer } from './freeform-view';

export const PEN_COLORS = ['var(--text-normal)', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];
export const HIGHLIGHT_COLORS = ['#ffeb3b', '#b2ff59', '#ff80ab', '#ffb74d', '#81d4fa', '#ce93d8'];
export const PEN_WIDTHS: [number, string][] = [[2, 'Thin'], [4, 'Medium'], [8, 'Thick']];

// Users assign these commands in Obsidian's Hotkeys settings.
export const DRAWING_COMMANDS: { id: string; name: string; run: (renderer: FreeformRenderer) => void }[] = [
  { id: 'toggle-drawing-mode', name: 'Drawing: Toggle drawing mode', run: r => r.togglePenMode() },
  ...(['pen', 'highlighter', 'eraser'] as const).map(tool => ({
    id: `drawing-${tool}`, name: `Drawing: Select ${tool}`,
    run: (r: FreeformRenderer) => r.setPenTool(tool),
  })),
  ...PEN_WIDTHS.map(([width, label]) => ({
    id: `drawing-width-${label.toLowerCase()}`, name: `Drawing: ${label} thickness`,
    run: (r: FreeformRenderer) => r.setPenWidth(width),
  })),
  { id: 'drawing-next-width', name: 'Drawing: Next thickness', run: r => r.cyclePenWidth(1) },
  { id: 'drawing-previous-width', name: 'Drawing: Previous thickness', run: r => r.cyclePenWidth(-1) },
  { id: 'drawing-next-color', name: 'Drawing: Next color', run: r => r.cyclePenColor(1) },
  { id: 'drawing-previous-color', name: 'Drawing: Previous color', run: r => r.cyclePenColor(-1) },
  { id: 'drawing-straight-lines', name: 'Drawing: Toggle straight lines', run: r => r.toggleStraightLineMode() },
];
