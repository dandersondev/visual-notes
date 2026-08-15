import { App, FuzzySuggestModal, Modal, Notice, setIcon, TFile, TFolder } from 'obsidian';
import { toPng } from 'html-to-image';
import { getStroke } from 'perfect-freehand';
import {
  StoryboardAspectRatio, StoryboardBrush, StoryboardCard, StoryboardObject, StoryboardPoint,
  StoryboardShot, StoryboardSection, StoryboardStroke,
} from './file-types';
import {
  IMAGE_EXTS, STORYBOARD_DEFAULT_H, STORYBOARD_DEFAULT_W, VaultImagePickerModal,
  inlineRemoteImages, EXPORT_IMAGE_TOLERANCE,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';
import {
  arrowheadPoints, buildTrimmedCurvedPath, buildTrimmedStraightPath,
  curveControlPoint, curveThroughPoint, perpendicularOffset,
} from './canvas/geometry';

type EditorTool = 'select' | 'pen' | 'eraser' | 'arrow' | 'text';
type StoryboardSelection = { kind: 'object' | 'stroke'; id: string };
type CardPlayback = { timer: number | null; token: symbol };
const LEGACY_TEXT_PROMPT = 'Double-click to edit';
const TEXT_PROMPT = 'Select to edit';
const cardPlaybacks = new Map<string, CardPlayback>();

type BrushPreset = { size: number; opacity: number; smoothing: number; pressure: boolean };
const BRUSH_PRESETS: Record<StoryboardBrush, BrushPreset> = {
  pen: { size: 5, opacity: 1, smoothing: .55, pressure: true },
  marker: { size: 12, opacity: .82, smoothing: .7, pressure: true },
  highlighter: { size: 24, opacity: .3, smoothing: .82, pressure: false },
  pencil: { size: 4, opacity: .68, smoothing: .38, pressure: true },
};

declare module './freeform-view' {
  interface FreeformRenderer {
    addStoryboardCard(): void;
    addStoryboardCardAt(x: number, y: number): void;
    renderStoryboardContent(el: HTMLElement, card: StoryboardCard): void;
    openStoryboardEditor(card: StoryboardCard): void;
  }
}

function newShot(index = 1): StoryboardShot {
  return {
    id: crypto.randomUUID(), shot: `1.${index}`, title: '', duration: 3,
    aspectRatio: '16:9', objects: [], drawings: [], status: 'idea',
  };
}

function imageSrc(app: App, shot: StoryboardShot): string | null {
  const source = shot.background;
  if (!source) return null;
  if (source.type === 'external') {
    try { const u = new URL(source.url); return /^https?:$/.test(u.protocol) ? u.href : null; }
    catch { return null; }
  }
  const file = app.vault.getAbstractFileByPath(source.path);
  return file instanceof TFile ? app.vault.getResourcePath(file) : null;
}

function ratioValue(ratio: StoryboardAspectRatio): number {
  const [w, h] = ratio.split(':').map(Number);
  return w / h;
}

function allShots(card: StoryboardCard): StoryboardShot[] {
  const shots: StoryboardShot[] = [];
  for (const section of card.sections) shots.push(...section.shots);
  return shots;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export function roundStoryboardPoint(point: StoryboardPoint): StoryboardPoint {
  return { x: round4(point.x), y: round4(point.y), ...(point.p === undefined ? {} : { p: round4(point.p) }) };
}

function strokePath(points: number[][]): string {
  if (!points.length) return '';
  const d = points.reduce<Array<string | number>>((acc, [x0, y0], index, array) => {
    const [x1, y1] = array[(index + 1) % array.length];
    acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    return acc;
  }, ['M', ...points[0], 'Q']);
  d.push('Z');
  return d.join(' ');
}

export function storyboardStrokePath(stroke: StoryboardStroke): string {
  const brush = stroke.brush ?? 'pen';
  const thinning = brush === 'highlighter' ? 0 : brush === 'marker' ? .3 : brush === 'pencil' ? .72 : .62;
  const outline = getStroke(stroke.points.map(point => [point.x * 1000, point.y * 1000, point.p ?? .5]), {
    size: Math.max(1, stroke.width) * 3,
    thinning: stroke.pressureEnabled === false ? 0 : thinning,
    smoothing: stroke.smoothing ?? BRUSH_PRESETS[brush].smoothing,
    streamline: brush === 'pencil' ? .32 : .55,
    simulatePressure: stroke.simulatePressure ?? stroke.pressureEnabled === false,
    start: { taper: brush === 'pencil' ? 5 : 0 },
    end: { taper: brush === 'pencil' ? 8 : 0 },
  });
  return strokePath(outline);
}

export function storyboardArrowGeometry(object: Extract<StoryboardObject, { kind: 'arrow' }>): { path: string; tip: string } | null {
  const src = { x: object.x * 1000, y: object.y * 1000 };
  const tgt = { x: object.x2 * 1000, y: object.y2 * 1000 };
  if (src.x === tgt.x && src.y === tgt.y) return null;
  const thickness = (object.width ?? 5) * 3;
  const markerLength = 10 + thickness * 2;
  const bend = (object.bend ?? 0) * 1000;
  const path = bend
    ? buildTrimmedCurvedPath(src, tgt, bend, 0, markerLength)
    : buildTrimmedStraightPath(src, tgt, 0, markerLength);
  const approach = bend ? curveControlPoint(src, tgt, bend) : src;
  const tip = arrowheadPoints(tgt, approach, markerLength, Math.round(markerLength * .42));
  return { path: path ?? '', tip: tip.map(point => `${point.x},${point.y}`).join(' ') };
}

export function storyboardDuration(card: StoryboardCard): number {
  return allShots(card).reduce((total, shot) => total + Math.max(0, shot.duration ?? 0), 0);
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

export function storyboardShotListMarkdown(card: StoryboardCard): string {
  const lines = [`# ${card.title ?? 'Untitled storyboard'}`, ''];
  for (const section of card.sections) {
    lines.push(`## ${section.title}`, '');
    for (const shot of section.shots) {
      const duration = Math.max(0, shot.duration ?? 0);
      lines.push(`- **${shot.shot || 'Shot'}${shot.title ? ` — ${shot.title}` : ''}** (${duration}s, ${shot.aspectRatio})`);
      if (shot.notes?.trim()) lines.push(`  - ${shot.notes.trim().replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  }
  lines.push(`**Total duration:** ${formatDuration(storyboardDuration(card))}`);
  return lines.join('\n');
}

export function storyboardExportBaseName(title?: string): string {
  return (title?.trim() || 'Storyboard').replace(/[\\/:*?"<>|]/g, '-').replace(/[. ]+$/g, '') || 'Storyboard';
}

class StoryboardImageFolderModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private choose: (folder: TFolder) => void) { super(app); }
  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder
        && file.children.some(child => child instanceof TFile && IMAGE_EXTS.includes(child.extension.toLowerCase())))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  getItemText(folder: TFolder): string { return folder.path || '/'; }
  onChooseItem(folder: TFolder): void { this.choose(folder); }
}

/**
 * Owns the lifetime of a captured storyboard gesture. Pointer cancellation
 * must finish exactly like release: iPadOS uses it for palm rejection, system
 * gestures and interrupted touches, and no pointerup follows afterward.
 */
export function bindStoryboardPointerGesture(
  target: HTMLElement,
  move: (event: PointerEvent) => void,
  complete: () => void,
): void {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', finish);
    target.removeEventListener('pointercancel', finish);
    complete();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', finish);
}

/**
 * Render a normalized image-annotation frame without depending on editor state.
 * Keeping this boundary small lets image and map cards reuse the annotation
 * primitive later without bringing the Storyboard modal with them.
 */
export function renderStoryboardShot(app: App, host: HTMLElement, shot: StoryboardShot, compact = false): void {
  host.empty();
  host.addClass('visual-notes-storyboard-frame');
  host.style.aspectRatio = String(ratioValue(shot.aspectRatio));
  const src = imageSrc(app, shot);
  if (src) host.createEl('img', { cls: 'visual-notes-storyboard-background', attr: { src } });
  else host.createDiv({ cls: 'visual-notes-storyboard-empty-frame', text: compact ? '' : 'Add a background image' });

  const svg = createSvg('svg');
  svg.setAttribute('class', 'visual-notes-storyboard-ink');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  host.appendChild(svg);
  for (const stroke of shot.drawings) {
    if (!stroke.points.length) continue;
    const path = createSvg('path');
    path.setAttribute('d', storyboardStrokePath(stroke));
    path.setAttribute('fill', stroke.color);
    path.setAttribute('fill-opacity', String(stroke.opacity ?? 1));
    if (stroke.brush === 'pencil') { path.setAttribute('class', 'visual-notes-storyboard-pencil-stroke'); applyPencilTexture(svg, path, stroke.id); }
    path.dataset.storyboardKind = 'stroke'; path.dataset.storyboardId = stroke.id;
    svg.appendChild(path);
  }
  for (const object of shot.objects) renderObject(host, object, compact);
}

function renderObject(host: HTMLElement, object: StoryboardObject, compact: boolean): void {
  if (object.kind === 'text') {
    const text = host.createDiv({ cls: 'visual-notes-storyboard-object-text', text: object.text });
    text.dataset.storyboardKind = 'object'; text.dataset.storyboardId = object.id;
    text.style.left = `${object.x * 100}%`; text.style.top = `${object.y * 100}%`;
    text.style.color = object.color ?? '#fff'; text.style.fontSize = `${compact ? Math.max(8, (object.size ?? 24) * .45) : object.size ?? 24}px`;
    return;
  }
  const svg = host.querySelector<SVGSVGElement>('.visual-notes-storyboard-ink');
  if (!svg) return;
  const geometry = storyboardArrowGeometry(object);
  if (geometry) {
    const line = createSvg('path');
    line.setAttribute('d', geometry.path); line.setAttribute('fill', 'none');
    line.setAttribute('stroke', object.color ?? '#ef4444'); line.setAttribute('stroke-width', String((object.width ?? 5) * 3));
    line.setAttribute('stroke-linecap', 'butt'); line.setAttribute('stroke-linejoin', 'round');
    line.dataset.storyboardKind = 'object'; line.dataset.storyboardId = object.id;
    svg.appendChild(line);
    const tip = createSvg('polygon');
    tip.setAttribute('points', geometry.tip);
    tip.setAttribute('fill', object.color ?? '#ef4444');
    tip.dataset.storyboardKind = 'object'; tip.dataset.storyboardId = object.id;
    svg.appendChild(tip);
  }
}

function applyPencilTexture(svg: SVGSVGElement, path: SVGPathElement, strokeId: string): void {
  const safeId = strokeId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filterId = `vn-pencil-${safeId}`;
  let defs = svg.querySelector<SVGDefsElement>('defs');
  if (!defs) { defs = createSvg('defs'); svg.prepend(defs); }
  const filter = createSvg('filter');
  filter.setAttribute('id', filterId); filter.setAttribute('x', '-10%'); filter.setAttribute('y', '-10%');
  filter.setAttribute('width', '120%'); filter.setAttribute('height', '120%');
  const noise = createSvg('feTurbulence');
  noise.setAttribute('type', 'fractalNoise'); noise.setAttribute('baseFrequency', '.035 .7');
  noise.setAttribute('numOctaves', '2');
  noise.setAttribute('seed', String([...strokeId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 997));
  noise.setAttribute('result', 'noise'); filter.appendChild(noise);
  const rough = createSvg('feDisplacementMap');
  rough.setAttribute('in', 'SourceGraphic'); rough.setAttribute('in2', 'noise'); rough.setAttribute('scale', '2.2');
  rough.setAttribute('xChannelSelector', 'R'); rough.setAttribute('yChannelSelector', 'G'); filter.appendChild(rough);
  defs.appendChild(filter); path.setAttribute('filter', `url(#${filterId})`);
}

class StoryboardEditorModal extends Modal {
  private sectionId: string;
  private shotId: string;
  private tool: EditorTool = 'select';
  private stage!: HTMLElement;
  private sectionList!: HTMLElement;
  private filmstrip!: HTMLElement;
  private inspector!: HTMLElement;
  private playTimer: number | null = null;
  private selection: StoryboardSelection | null = null;
  private undoStack: StoryboardCard[] = [];
  private redoStack: StoryboardCard[] = [];
  private undoBtn!: HTMLElement;
  private redoBtn!: HTMLElement;
  private durationEl!: HTMLElement;
  private onionBtn!: HTMLElement;
  private annotationClipboard: StoryboardObject | StoryboardStroke | null = null;
  private dirty = false;
  private onionSkin = false;
  private brush: StoryboardBrush = 'pen';
  private brushSize = BRUSH_PRESETS.pen.size;
  private brushColor = '#ef4444';
  private brushOpacity = BRUSH_PRESETS.pen.opacity;
  private brushSmoothing = BRUSH_PRESETS.pen.smoothing;
  private brushPressure = BRUSH_PRESETS.pen.pressure;
  private brushControls!: HTMLElement;
  private editorBody!: HTMLElement;
  private mobilePaneButtons: Partial<Record<'sections' | 'stage' | 'inspector', HTMLElement>> = {};

  constructor(app: App, private card: StoryboardCard, private changed: () => void) {
    super(app);
    const firstSection = card.sections[0] ?? { id: crypto.randomUUID(), title: 'Overall scene', shots: [newShot()] };
    if (!card.sections.length) card.sections.push(firstSection);
    if (!firstSection.shots.length) firstSection.shots.push(newShot());
    this.sectionId = firstSection.id; this.shotId = firstSection.shots[0].id;
  }

  override onOpen(): void {
    // Earlier builds placed an instruction that was no longer reliable in
    // Obsidian's modal pointer environment. Only replace the exact untouched
    // prompt; anything the user has edited remains unchanged.
    let promptUpdated = false;
    for (const section of this.card.sections) for (const shot of section.shots) for (const object of shot.objects) {
      if (object.kind === 'text' && object.text === LEGACY_TEXT_PROMPT) { object.text = TEXT_PROMPT; promptUpdated = true; }
    }
    if (promptUpdated) { this.dirty = true; this.changed(); }
    this.modalEl.addClass('visual-notes-storyboard-modal');
    this.modalEl.tabIndex = -1;
    this.contentEl.addClass('visual-notes-storyboard-editor');
    this.renderShell();
    this.modalEl.addEventListener('keydown', e => this.onEditorKeyDown(e));
    this.modalEl.focus();
  }

  private section(): StoryboardSection { return this.card.sections.find(s => s.id === this.sectionId) ?? this.card.sections[0]; }
  private shot(): StoryboardShot { return this.section().shots.find(s => s.id === this.shotId) ?? this.section().shots[0]; }
  private commit(): void { this.dirty = true; this.changed(); }
  private snapshot(): StoryboardCard { return structuredClone(this.card); }
  private checkpoint(): void { this.undoStack.push(this.snapshot()); this.redoStack = []; this.refreshHistoryButtons(); }
  private restore(snapshot: StoryboardCard): void {
    Object.assign(this.card, structuredClone(snapshot));
    const section = this.card.sections.find(s => s.id === this.sectionId) ?? this.card.sections[0];
    this.sectionId = section.id; this.shotId = section.shots.some(s => s.id === this.shotId) ? this.shotId : section.shots[0].id;
    this.selection = null; this.commit(); this.refresh();
  }
  private undo(): void {
    const previous = this.undoStack.pop(); if (!previous) return;
    this.redoStack.push(this.snapshot()); this.restore(previous); this.refreshHistoryButtons();
  }
  private redo(): void {
    const next = this.redoStack.pop(); if (!next) return;
    this.undoStack.push(this.snapshot()); this.restore(next); this.refreshHistoryButtons();
  }
  private refreshHistoryButtons(): void {
    this.undoBtn?.toggleAttribute('disabled', this.undoStack.length === 0);
    this.redoBtn?.toggleAttribute('disabled', this.redoStack.length === 0);
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLElement {
    const btn = parent.createEl('button', { cls: 'visual-notes-storyboard-tool', attr: { 'aria-label': label } });
    setIcon(btn, icon); btn.createSpan({ text: label }); btn.addEventListener('click', action); return btn;
  }

  private renderShell(): void {
    this.contentEl.empty();
    const top = this.contentEl.createDiv('visual-notes-storyboard-editor-topbar');
    const title = top.createEl('input', { cls: 'visual-notes-storyboard-title-input' });
    title.value = this.card.title ?? 'Untitled storyboard';
    title.addEventListener('change', () => { this.checkpoint(); this.card.title = title.value.trim() || 'Untitled storyboard'; this.commit(); });
    const tools = top.createDiv('visual-notes-storyboard-tools visual-notes-storyboard-tool-group');
    for (const [tool, icon, label] of [['select','mouse-pointer-2','Select'],['pen','pencil','Draw'],['eraser','eraser','Erase'],['text','type','Text'],['arrow','move-up-right','Arrow']] as const) {
      const btn = this.iconButton(tools, icon, label, () => { this.tool = tool; this.refreshToolButtons(); this.refreshBrushControls(); });
      btn.dataset.tool = tool;
    }
    const historyTools = top.createDiv('visual-notes-storyboard-tools visual-notes-storyboard-tool-group');
    this.undoBtn = this.iconButton(historyTools, 'undo-2', 'Undo', () => this.undo());
    this.redoBtn = this.iconButton(historyTools, 'redo-2', 'Redo', () => this.redo());
    const sequenceTools = top.createDiv('visual-notes-storyboard-tools visual-notes-storyboard-tool-group');
    this.iconButton(sequenceTools, 'image-plus', 'Image', () => this.chooseImage());
    this.iconButton(sequenceTools, 'images', 'Import folder', () => this.importImageFolder());
    this.onionBtn = this.iconButton(sequenceTools, 'layers-2', 'Onion skin', () => {
      this.onionSkin = !this.onionSkin; this.onionBtn.toggleClass('is-active', this.onionSkin); this.renderStage();
    });
    this.iconButton(sequenceTools, 'play', 'Play', () => this.play());
    this.iconButton(sequenceTools, 'file-down', 'Shot list', () => this.exportShotList());
    this.iconButton(sequenceTools, 'image-down', 'Export', () => void this.exportContactSheet());
    const mobileNav = top.createDiv('visual-notes-storyboard-mobile-nav');
    for (const [pane, icon, label] of [['sections', 'list-tree', 'Scenes'], ['stage', 'image', 'Stage'], ['inspector', 'sliders-horizontal', 'Shot']] as const) {
      this.mobilePaneButtons[pane] = this.iconButton(mobileNav, icon, label, () => this.showMobilePane(pane));
    }
    this.brushControls = top.createDiv('visual-notes-storyboard-brush-controls');
    this.renderBrushControls();
    this.durationEl = top.createDiv('visual-notes-storyboard-duration');

    this.editorBody = this.contentEl.createDiv('visual-notes-storyboard-editor-body');
    this.sectionList = this.editorBody.createDiv('visual-notes-storyboard-sections');
    this.stage = this.editorBody.createDiv('visual-notes-storyboard-stage');
    this.inspector = this.editorBody.createDiv('visual-notes-storyboard-inspector');
    this.showMobilePane('stage');
    this.filmstrip = this.contentEl.createDiv('visual-notes-storyboard-filmstrip-editor');
    this.refresh();
    this.refreshHistoryButtons();
  }

  private refresh(): void {
    this.renderSections(); this.renderStage(); this.renderInspector(); this.renderFilmstrip(); this.refreshToolButtons(); this.refreshDuration();
  }

  private refreshDuration(): void {
    this.durationEl?.setText(`${allShots(this.card).length} shots · ${formatDuration(storyboardDuration(this.card))}`);
  }

  private refreshToolButtons(): void {
    this.contentEl.querySelectorAll<HTMLElement>('[data-tool]').forEach(btn => btn.toggleClass('is-active', btn.dataset.tool === this.tool));
  }

  private refreshBrushControls(): void {
    this.brushControls?.toggleClass('is-visible', this.tool === 'pen');
  }

  private showMobilePane(pane: 'sections' | 'stage' | 'inspector'): void {
    if (!this.editorBody) return;
    this.editorBody.dataset.mobilePane = pane;
    for (const [name, button] of Object.entries(this.mobilePaneButtons)) button?.toggleClass('is-active', name === pane);
  }

  private renderBrushControls(): void {
    this.brushControls.empty();
    this.brushControls.setAttribute('aria-label', 'Brush settings');
    const preset = this.brushControls.createEl('select', { attr: { 'aria-label': 'Brush preset' } });
    for (const brush of ['pen', 'marker', 'highlighter', 'pencil'] as StoryboardBrush[]) {
      preset.createEl('option', { value: brush, text: brush[0].toUpperCase() + brush.slice(1) });
    }
    preset.value = this.brush;
    preset.addEventListener('change', () => {
      this.brush = preset.value as StoryboardBrush;
      const settings = BRUSH_PRESETS[this.brush];
      this.brushSize = settings.size; this.brushOpacity = settings.opacity;
      this.brushSmoothing = settings.smoothing; this.brushPressure = settings.pressure;
      this.renderBrushControls(); this.refreshBrushControls();
    });
    this.brushControls.createSpan({ cls: 'visual-notes-storyboard-brush-label', text: 'Size' });
    const size = this.brushControls.createEl('input', { attr: { type: 'range', min: '1', max: '40', step: '1', value: String(this.brushSize), 'aria-label': `Brush size ${this.brushSize}` } });
    size.title = `Size: ${this.brushSize}`;
    size.addEventListener('input', () => { this.brushSize = Number(size.value); size.title = `Size: ${size.value}`; size.setAttribute('aria-label', `Brush size ${size.value}`); preview.style.height = `${Math.max(2, Math.min(18, this.brushSize / 2))}px`; });
    const color = this.brushControls.createEl('input', { attr: { type: 'color', value: this.brushColor, 'aria-label': 'Brush colour' } });
    color.addEventListener('input', () => { this.brushColor = color.value; preview.style.backgroundColor = color.value; });
    this.brushControls.createSpan({ cls: 'visual-notes-storyboard-brush-label', text: 'Opacity' });
    const opacity = this.brushControls.createEl('input', { attr: { type: 'range', min: '.05', max: '1', step: '.05', value: String(this.brushOpacity), 'aria-label': `Brush opacity ${Math.round(this.brushOpacity * 100)} percent` } });
    opacity.title = `Opacity: ${Math.round(this.brushOpacity * 100)}%`;
    opacity.addEventListener('input', () => { this.brushOpacity = Number(opacity.value); opacity.title = `Opacity: ${Math.round(this.brushOpacity * 100)}%`; preview.style.opacity = opacity.value; });
    this.brushControls.createSpan({ cls: 'visual-notes-storyboard-brush-label', text: 'Smooth' });
    const smoothing = this.brushControls.createEl('input', { attr: { type: 'range', min: '0', max: '1', step: '.05', value: String(this.brushSmoothing), 'aria-label': 'Stroke smoothing' } });
    smoothing.title = `Smoothing: ${Math.round(this.brushSmoothing * 100)}%`;
    smoothing.addEventListener('input', () => { this.brushSmoothing = Number(smoothing.value); smoothing.title = `Smoothing: ${Math.round(this.brushSmoothing * 100)}%`; });
    const pressureLabel = this.brushControls.createEl('label', { cls: 'visual-notes-storyboard-pressure', attr: { title: 'Use stylus pressure or simulated mouse pressure' } });
    const pressure = pressureLabel.createEl('input', { attr: { type: 'checkbox', 'aria-label': 'Pressure-sensitive width' } });
    pressure.checked = this.brushPressure; pressure.addEventListener('change', () => this.brushPressure = pressure.checked);
    pressureLabel.createSpan({ text: 'Pressure' });
    const preview = this.brushControls.createDiv('visual-notes-storyboard-brush-preview');
    preview.style.backgroundColor = this.brushColor;
    preview.style.height = `${Math.max(2, Math.min(18, this.brushSize / 2))}px`;
    preview.style.opacity = String(this.brushOpacity);
    this.refreshBrushControls();
  }

  private renderSections(): void {
    this.sectionList.empty(); this.sectionList.createEl('h4', { text: 'Overall scene' });
    for (const section of this.card.sections) {
      const row = this.sectionList.createDiv({ cls: 'visual-notes-storyboard-section-row', text: section.title });
      row.toggleClass('is-active', section.id === this.sectionId);
      row.addEventListener('click', () => { this.sectionId = section.id; this.shotId = section.shots[0]?.id ?? ''; this.selection = null; this.refresh(); this.showMobilePane('stage'); });
    }
    const add = this.sectionList.createEl('button', { text: '+ Scene section' });
    add.addEventListener('click', () => {
      this.checkpoint();
      const section: StoryboardSection = { id: crypto.randomUUID(), title: `Scene section ${this.card.sections.length + 1}`, shots: [newShot(1)] };
      this.card.sections.push(section); this.sectionId = section.id; this.shotId = section.shots[0].id; this.commit(); this.refresh();
    });
  }

  private renderStage(): void {
    this.stage.empty();
    const shot = this.shot(); if (!shot) return;
    const frame = this.stage.createDiv('visual-notes-storyboard-stage-frame');
    this.renderStageFrame(frame, shot);
    this.decorateSelection(frame, shot);
    frame.addEventListener('pointerdown', e => this.beginStageGesture(e, frame, shot));
    frame.querySelectorAll<HTMLElement>('.visual-notes-storyboard-object-text').forEach(text => {
      const object = shot.objects.find(candidate => candidate.id === text.dataset.storyboardId);
      if (!object || object.kind !== 'text') return;
      // Handle the second pointerdown at the text itself, before the stage's
      // gesture listener can prevent the browser's native double-click/focus.
      text.addEventListener('pointerdown', event => {
        if (event.detail < 2) return;
        event.stopPropagation();
        this.selection = { kind: 'object', id: object.id };
        this.startTextEditing(text, object);
      });
      text.addEventListener('dblclick', e => {
        e.preventDefault(); e.stopPropagation();
        this.startTextEditing(text, object);
      });
    });
  }

  private renderStageFrame(frame: HTMLElement, shot: StoryboardShot): void {
    renderStoryboardShot(this.app, frame, shot);
    if (this.onionSkin) {
      const shots = this.section().shots;
      const index = shots.findIndex(candidate => candidate.id === shot.id);
      if (index > 0) {
        const onion = frame.createDiv('visual-notes-storyboard-onion');
        renderStoryboardShot(this.app, onion, shots[index - 1], true);
      }
    }
  }

  private startTextEditing(textEl: HTMLElement, object: Extract<StoryboardObject, { kind: 'text' }>): void {
    if (textEl.contentEditable === 'true') return;
    const original = object.text;
    textEl.contentEditable = 'true'; textEl.addClass('is-editing'); textEl.focus();
    const selection = document.getSelection(); selection?.selectAllChildren(textEl);
    const save = () => {
      const next = textEl.textContent?.trim() || 'Text';
      textEl.contentEditable = 'false'; textEl.removeClass('is-editing');
      if (next === original) return;
      this.checkpoint(); object.text = next; this.commit(); this.renderFilmstrip();
    };
    textEl.addEventListener('blur', save, { once: true });
    textEl.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); textEl.textContent = original; textEl.blur(); }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); textEl.blur(); }
    });
  }

  private decorateSelection(frame: HTMLElement, shot: StoryboardShot): void {
    if (!this.selection) return;
    const target = frame.querySelector<HTMLElement | SVGElement>(`[data-storyboard-id="${CSS.escape(this.selection.id)}"]`);
    target?.classList.add('is-selected');
    if (this.selection.kind !== 'object') return;
    const object = shot.objects.find(o => o.id === this.selection?.id); if (!object) return;
    if (object.kind === 'text') {
      const handle = frame.createDiv('visual-notes-storyboard-text-size-handle');
      handle.dataset.storyboardHandle = 'text-size'; handle.dataset.storyboardId = object.id;
      handle.style.left = `${object.x * 100}%`; handle.style.top = `${object.y * 100}%`;
    } else {
      const bendPoint = curveThroughPoint({ x: object.x, y: object.y }, { x: object.x2, y: object.y2 }, object.bend ?? 0);
      for (const [handleName, x, y] of [
        ['arrow-start', object.x, object.y], ['arrow-bend', bendPoint.x, bendPoint.y], ['arrow-end', object.x2, object.y2],
      ] as const) {
        const handle = frame.createDiv('visual-notes-storyboard-arrow-handle');
        handle.dataset.storyboardHandle = handleName; handle.dataset.storyboardId = object.id;
        handle.style.left = `${x * 100}%`; handle.style.top = `${y * 100}%`;
        handle.toggleClass('is-bend', handleName === 'arrow-bend');
      }
    }
  }

  private beginStageGesture(e: PointerEvent, frame: HTMLElement, shot: StoryboardShot): void {
    e.preventDefault(); e.stopPropagation();
    const rect = frame.getBoundingClientRect();
    const point = (ev: PointerEvent) => roundStoryboardPoint({
      x: Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
      p: ev.pressure || undefined,
    });
    const target = e.target as HTMLElement | SVGElement;
    const hit = target.closest<HTMLElement | SVGElement>('[data-storyboard-id]');
    const id = hit?.getAttribute('data-storyboard-id') ?? null;
    const handle = hit?.getAttribute('data-storyboard-handle');
    const kind = hit?.getAttribute('data-storyboard-kind');

    if (this.tool === 'eraser') {
      let erased = false;
      const eraseId = (strokeId: string | null) => {
        if (!strokeId || !shot.drawings.some(stroke => stroke.id === strokeId)) return;
        if (!erased) this.checkpoint();
        erased = true; shot.drawings = shot.drawings.filter(stroke => stroke.id !== strokeId); this.selection = null;
        this.renderStageFrame(frame, shot);
      };
      const eraseAt = (event: PointerEvent) => {
        const targetAtPoint = document.elementFromPoint(event.clientX, event.clientY);
        const strokeAtPoint = targetAtPoint?.closest<SVGElement>('[data-storyboard-kind="stroke"]');
        if (strokeAtPoint && frame.contains(strokeAtPoint)) eraseId(strokeAtPoint.dataset.storyboardId ?? null);
      };
      if (kind === 'stroke') eraseId(id);
      frame.setPointerCapture(e.pointerId);
      const move = (event: PointerEvent) => {
        const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
        for (const sample of samples.length ? samples : [event]) eraseAt(sample);
      };
      bindStoryboardPointerGesture(frame, move, () => {
        if (erased) { this.commit(); this.renderStage(); this.renderInspector(); this.renderFilmstrip(); }
      });
      return;
    }

    if (this.tool === 'select') {
      if (!id) { this.selection = null; this.renderStage(); this.renderInspector(); return; }
      const nextSelection: StoryboardSelection = { kind: kind === 'stroke' ? 'stroke' : 'object', id };
      if (this.selection?.id !== id || this.selection.kind !== nextSelection.kind) {
        this.selection = nextSelection;
        frame.querySelectorAll('.is-selected').forEach(el => el.removeClass('is-selected'));
        frame.querySelectorAll('.visual-notes-storyboard-arrow-handle,.visual-notes-storyboard-text-size-handle').forEach(el => el.remove());
        this.decorateSelection(frame, shot); this.renderInspector(); this.modalEl.focus(); return;
      }
      if (kind === 'stroke') { this.renderStage(); this.renderInspector(); this.modalEl.focus(); return; }
      const object = shot.objects.find(o => o.id === id); if (!object) return;
      if (object.kind === 'text' && e.detail >= 2 && hit?.instanceOf(HTMLElement)) {
        this.startTextEditing(hit, object); return;
      }
      const start = point(e); const original = structuredClone(object);
      let moved = false;
      frame.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (!moved) { moved = true; this.checkpoint(); }
        const p = point(ev); const dx = p.x - start.x, dy = p.y - start.y;
        if (object.kind === 'text' && original.kind === 'text') {
          if (handle === 'text-size') object.size = Math.max(8, Math.min(160, (original.size ?? 24) + dy * rect.height * .45));
          else { object.x = Math.max(0, Math.min(1, original.x + dx)); object.y = Math.max(0, Math.min(1, original.y + dy)); }
        } else if (object.kind === 'arrow' && original.kind === 'arrow') {
          if (handle === 'arrow-start') { object.x = p.x; object.y = p.y; }
          else if (handle === 'arrow-end') { object.x2 = p.x; object.y2 = p.y; }
          else if (handle === 'arrow-bend') {
            object.bend = round4(Math.max(-1, Math.min(1, perpendicularOffset(
              { x: original.x, y: original.y }, { x: original.x2, y: original.y2 }, p,
            ))));
          }
          else {
            object.x = Math.max(0, Math.min(1, original.x + dx)); object.y = Math.max(0, Math.min(1, original.y + dy));
            object.x2 = Math.max(0, Math.min(1, original.x2 + dx)); object.y2 = Math.max(0, Math.min(1, original.y2 + dy));
          }
        }
        this.renderStageFrame(frame, shot); this.decorateSelection(frame, shot);
      };
      bindStoryboardPointerGesture(frame, move, () => {
        if (moved) { this.commit(); this.renderInspector(); this.renderFilmstrip(); }
      });
      return;
    }

    if (this.tool === 'text') {
      this.checkpoint();
      const p = point(e); shot.objects.push({ id: crypto.randomUUID(), kind: 'text', x: p.x, y: p.y, text: TEXT_PROMPT, size: 24 });
      this.selection = { kind: 'object', id: shot.objects[shot.objects.length - 1].id };
      this.tool = 'select'; this.commit(); this.renderStage(); this.renderInspector(); this.refreshToolButtons();
      window.requestAnimationFrame(() => {
        const input = this.inspector.querySelector<HTMLTextAreaElement>('.visual-notes-storyboard-selected-text-input');
        input?.focus(); input?.select();
      });
      return;
    }
    this.checkpoint();
    const start = point(e);
    const stroke: StoryboardStroke = {
      id: crypto.randomUUID(), points: [start], color: this.brushColor, width: this.brushSize,
      brush: this.brush, opacity: this.brushOpacity, smoothing: this.brushSmoothing,
      pressureEnabled: this.brushPressure, simulatePressure: this.brushPressure && e.pointerType !== 'pen',
    };
    const arrow: StoryboardObject = { id: crypto.randomUUID(), kind: 'arrow', x: start.x, y: start.y, x2: start.x, y2: start.y, color: '#ef4444', width: 5 };
    if (this.tool === 'pen') { shot.drawings.push(stroke); this.selection = { kind: 'stroke', id: stroke.id }; }
    else { shot.objects.push(arrow); this.selection = { kind: 'object', id: arrow.id }; }
    frame.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const samples = this.tool === 'pen' && typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [ev];
      if (this.tool === 'pen') {
        for (const sample of samples.length ? samples : [ev]) {
          const p = point(sample); const last = stroke.points[stroke.points.length - 1];
          if (p.x !== last.x || p.y !== last.y || p.p !== last.p) stroke.points.push(p);
        }
      } else if (arrow.kind === 'arrow') { const p = point(ev); arrow.x2 = p.x; arrow.y2 = p.y; }
      this.renderStageFrame(frame, shot);
    };
    bindStoryboardPointerGesture(frame, move, () => {
      this.commit(); this.renderStage(); this.renderInspector(); this.renderFilmstrip();
    });
  }

  private renderInspector(): void {
    this.inspector.empty(); this.inspector.createEl('h4', { text: 'Shot' });
    const shot = this.shot(); if (!shot) return;
    const field = (label: string, value: string, update: (v: string) => void, type = 'text') => {
      const wrap = this.inspector.createDiv('visual-notes-storyboard-field'); wrap.createEl('label', { text: label });
      const input = wrap.createEl('input'); input.type = type; input.value = value;
      input.addEventListener('change', () => { this.checkpoint(); update(input.value); this.commit(); this.renderFilmstrip(); this.refreshDuration(); });
    };
    field('Shot', shot.shot ?? '', v => shot.shot = v);
    field('Title', shot.title ?? '', v => shot.title = v);
    field('Duration (seconds)', String(shot.duration ?? 3), v => shot.duration = Math.max(0, Number(v) || 0), 'number');
    const ratioWrap = this.inspector.createDiv('visual-notes-storyboard-field'); ratioWrap.createEl('label', { text: 'Aspect ratio' });
    const select = ratioWrap.createEl('select');
    for (const ratio of ['16:9','4:3','1:1','9:16'] as StoryboardAspectRatio[]) select.createEl('option', { text: ratio, value: ratio });
    select.value = shot.aspectRatio; select.addEventListener('change', () => { this.checkpoint(); shot.aspectRatio = select.value as StoryboardAspectRatio; this.commit(); this.renderStage(); });
    const notes = this.inspector.createEl('textarea', { cls: 'visual-notes-storyboard-notes', attr: { placeholder: 'Shot notes…' } });
    notes.value = shot.notes ?? ''; notes.addEventListener('change', () => { this.checkpoint(); shot.notes = notes.value; this.commit(); });
    if (this.card.sections.length > 1) {
      const sectionWrap = this.inspector.createDiv('visual-notes-storyboard-field'); sectionWrap.createEl('label', { text: 'Scene section' });
      const sectionSelect = sectionWrap.createEl('select');
      for (const section of this.card.sections) sectionSelect.createEl('option', { text: section.title, value: section.id });
      sectionSelect.value = this.sectionId;
      sectionSelect.addEventListener('change', () => this.moveShotToSection(shot, sectionSelect.value));
    }
    this.renderSelectionInspector(shot);
    this.iconButton(this.inspector, 'trash-2', 'Clear annotations', () => { this.checkpoint(); shot.drawings = []; shot.objects = []; this.selection = null; this.commit(); this.renderStage(); this.renderInspector(); });
    if (shot.background) this.iconButton(this.inspector, 'image-off', 'Remove background', () => { this.checkpoint(); shot.background = undefined; this.commit(); this.renderStage(); this.renderFilmstrip(); });
    if (this.section().shots.length > 1) this.iconButton(this.inspector, 'trash-2', 'Delete shot', () => {
      this.checkpoint();
      const section = this.section(); const index = section.shots.indexOf(shot); section.shots.splice(index, 1);
      this.shotId = section.shots[Math.min(index, section.shots.length - 1)].id; this.commit(); this.refresh();
    });
  }

  private renderSelectionInspector(shot: StoryboardShot): void {
    if (!this.selection) return;
    const object = this.selection.kind === 'object' ? shot.objects.find(o => o.id === this.selection?.id) : undefined;
    const stroke = this.selection.kind === 'stroke' ? shot.drawings.find(s => s.id === this.selection?.id) : undefined;
    if (!object && !stroke) { this.selection = null; return; }
    this.inspector.createEl('h4', { text: object?.kind === 'text' ? 'Text' : stroke ? 'Stroke' : 'Arrow' });
    const colorWrap = this.inspector.createDiv('visual-notes-storyboard-field'); colorWrap.createEl('label', { text: 'Colour' });
    const color = colorWrap.createEl('input'); color.type = 'color'; color.value = (object ?? stroke)?.color ?? (object?.kind === 'text' ? '#ffffff' : '#ef4444');
    color.addEventListener('change', () => { this.checkpoint(); if (object) object.color = color.value; else if (stroke) stroke.color = color.value; this.commit(); this.renderStage(); this.renderFilmstrip(); });
    const isText = object?.kind === 'text';
    if (object?.kind === 'text') {
      const textWrap = this.inspector.createDiv('visual-notes-storyboard-field'); textWrap.createEl('label', { text: 'Text' });
      const textInput = textWrap.createEl('textarea', { cls: 'visual-notes-storyboard-selected-text-input' });
      textInput.value = object.text;
      let historyStarted = false;
      textInput.addEventListener('input', () => {
        if (!historyStarted) { this.checkpoint(); historyStarted = true; }
        object.text = textInput.value || 'Text'; this.commit(); this.renderStage(); this.renderFilmstrip();
      });
      textInput.addEventListener('blur', () => { historyStarted = false; });
    }
    const sizeWrap = this.inspector.createDiv('visual-notes-storyboard-field'); sizeWrap.createEl('label', { text: isText ? 'Text size' : 'Line width' });
    const size = sizeWrap.createEl('input'); size.type = 'range'; size.min = isText ? '8' : '1'; size.max = isText ? '160' : '24';
    size.value = String(isText ? object.size ?? 24 : object?.kind === 'arrow' ? object.width ?? 5 : stroke?.width ?? 5);
    size.addEventListener('change', () => {
      this.checkpoint(); if (object?.kind === 'text') object.size = Number(size.value); else if (object?.kind === 'arrow') object.width = Number(size.value); else if (stroke) stroke.width = Number(size.value);
      this.commit(); this.renderStage(); this.renderFilmstrip();
    });
    if (object?.kind === 'text') this.iconButton(this.inspector, 'pencil', 'Edit text', () => {
      const input = this.inspector.querySelector<HTMLTextAreaElement>('.visual-notes-storyboard-selected-text-input');
      input?.focus(); input?.select();
    });
    this.iconButton(this.inspector, 'copy', 'Copy annotation', () => this.copySelection());
    this.iconButton(this.inspector, 'trash-2', 'Delete annotation', () => this.deleteSelection());
  }

  private deleteSelection(): void {
    if (!this.selection) return; this.checkpoint(); const shot = this.shot();
    if (this.selection.kind === 'object') shot.objects = shot.objects.filter(o => o.id !== this.selection?.id);
    else shot.drawings = shot.drawings.filter(s => s.id !== this.selection?.id);
    this.selection = null; this.commit(); this.renderStage(); this.renderInspector(); this.renderFilmstrip();
  }

  private copySelection(): void {
    if (!this.selection) return; const shot = this.shot();
    const selected = this.selection.kind === 'object' ? shot.objects.find(o => o.id === this.selection?.id) : shot.drawings.find(s => s.id === this.selection?.id);
    this.annotationClipboard = selected ? structuredClone(selected) : null;
  }

  private pasteSelection(): void {
    const source = this.annotationClipboard; if (!source) return; this.checkpoint(); const shot = this.shot();
    const copy = structuredClone(source); copy.id = crypto.randomUUID();
    if ('kind' in copy) {
      copy.x = Math.min(1, copy.x + .04); copy.y = Math.min(1, copy.y + .04);
      if (copy.kind === 'arrow') { copy.x2 = Math.min(1, copy.x2 + .04); copy.y2 = Math.min(1, copy.y2 + .04); }
      shot.objects.push(copy); this.selection = { kind: 'object', id: copy.id };
    } else {
      copy.points = copy.points.map(p => ({ ...p, x: Math.min(1, p.x + .04), y: Math.min(1, p.y + .04) }));
      shot.drawings.push(copy); this.selection = { kind: 'stroke', id: copy.id };
    }
    this.commit(); this.renderStage(); this.renderInspector(); this.renderFilmstrip();
  }

  private onEditorKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    const typing = target.matches('input,textarea,select,[contenteditable="true"]');
    const mod = e.metaKey || e.ctrlKey;
    if (!typing && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (!typing && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); this.redo(); return; }
    if (!typing && mod && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopPropagation(); this.copySelection(); return; }
    if (!typing && mod && e.key.toLowerCase() === 'v') { e.preventDefault(); e.stopPropagation(); this.pasteSelection(); return; }
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); e.stopPropagation(); this.deleteSelection(); }
  }

  private renderFilmstrip(): void {
    this.filmstrip.empty();
    const section = this.section(); if (!section) return;
    for (const shot of section.shots) {
      const thumb = this.filmstrip.createDiv('visual-notes-storyboard-editor-thumb'); thumb.draggable = true; thumb.dataset.shotId = shot.id;
      thumb.toggleClass('is-active', shot.id === this.shotId);
      const frame = thumb.createDiv(); renderStoryboardShot(this.app, frame, shot, true);
      thumb.createDiv({ cls: 'visual-notes-storyboard-thumb-label', text: shot.shot || `Shot ${section.shots.indexOf(shot) + 1}` });
      thumb.addEventListener('click', () => { this.shotId = shot.id; this.selection = null; this.refresh(); this.showMobilePane('stage'); });
      thumb.addEventListener('dragstart', e => e.dataTransfer?.setData('text/x-vn-storyboard-shot', shot.id));
      thumb.addEventListener('dragover', e => e.preventDefault());
      thumb.addEventListener('drop', e => {
        e.preventDefault(); const id = e.dataTransfer?.getData('text/x-vn-storyboard-shot');
        const from = section.shots.findIndex(s => s.id === id), to = section.shots.findIndex(s => s.id === shot.id);
        if (from < 0 || to < 0 || from === to) return;
        this.checkpoint();
        const [moved] = section.shots.splice(from, 1); section.shots.splice(to, 0, moved); this.commit(); this.renderFilmstrip();
      });
    }
    const add = this.filmstrip.createEl('button', { cls: 'visual-notes-storyboard-add-shot', text: '+ Shot' });
    add.addEventListener('click', () => { this.checkpoint(); const shot = newShot(section.shots.length + 1); section.shots.push(shot); this.shotId = shot.id; this.selection = null; this.commit(); this.refresh(); });
    const duplicate = this.filmstrip.createEl('button', { text: 'Duplicate' });
    duplicate.addEventListener('click', () => {
      this.checkpoint();
      const source = this.shot(); const copy = structuredClone(source); copy.id = crypto.randomUUID(); copy.shot = `${source.shot ?? 'Shot'} copy`;
      section.shots.splice(section.shots.indexOf(source) + 1, 0, copy); this.shotId = copy.id; this.commit(); this.refresh();
    });
  }

  private chooseImage(): void {
    new VaultImagePickerModal(this.app, file => { this.checkpoint(); this.shot().background = { type: 'vault', path: file.path }; this.commit(); this.renderStage(); this.renderFilmstrip(); }).open();
  }

  private importImageFolder(): void {
    new StoryboardImageFolderModal(this.app, folder => {
      const files = folder.children
        .filter((child): child is TFile => child instanceof TFile && IMAGE_EXTS.includes(child.extension.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (!files.length) { new Notice('That folder has no supported images.'); return; }
      this.checkpoint();
      const section = this.section();
      const sectionNumber = this.card.sections.indexOf(section) + 1;
      const start = section.shots.length;
      const imported = files.map((file, index): StoryboardShot => ({
        ...newShot(start + index + 1),
        shot: `${sectionNumber}.${start + index + 1}`,
        title: file.basename,
        background: { type: 'vault', path: file.path },
      }));
      section.shots.push(...imported);
      this.shotId = imported[0].id; this.selection = null;
      this.commit(); this.refresh();
      new Notice(`Imported ${imported.length} image${imported.length === 1 ? '' : 's'} as shots.`);
    }).open();
  }

  private moveShotToSection(shot: StoryboardShot, targetId: string): void {
    const source = this.section();
    const target = this.card.sections.find(section => section.id === targetId);
    if (!target || target === source) return;
    if (source.shots.length <= 1) { new Notice('A scene section must keep at least one shot.'); this.renderInspector(); return; }
    this.checkpoint();
    source.shots.splice(source.shots.indexOf(shot), 1);
    target.shots.push(shot);
    this.sectionId = target.id; this.shotId = shot.id; this.selection = null;
    this.commit(); this.refresh();
  }

  private exportShotList(): void {
    const markdown = storyboardShotListMarkdown(this.card);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    createEl('a', { href: url, attr: { download: `${storyboardExportBaseName(this.card.title)}-shot-list.md` } }).click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private play(): void {
    const shots = allShots(this.card); if (!shots.length) return;
    if (this.playTimer !== null) { window.clearTimeout(this.playTimer); this.playTimer = null; return; }
    let index = Math.max(0, shots.findIndex(s => s.id === this.shotId));
    const advance = () => {
      const shot = shots[index]; const section = this.card.sections.find(s => s.shots.some(candidate => candidate.id === shot.id));
      if (section) { this.sectionId = section.id; this.shotId = shot.id; this.refresh(); }
      index++;
      if (index >= shots.length) { this.playTimer = null; return; }
      this.playTimer = window.setTimeout(advance, Math.max(300, (shot.duration ?? 3) * 1000));
    };
    advance();
  }

  private async exportContactSheet(): Promise<void> {
    const sheet = document.body.createDiv('visual-notes-storyboard-contact-sheet');
    sheet.createEl('h1', { text: this.card.title ?? 'Storyboard' });
    for (const section of this.card.sections) {
      sheet.createEl('h2', { text: section.title });
      const grid = sheet.createDiv('visual-notes-storyboard-contact-grid');
      for (const shot of section.shots) {
        const cell = grid.createDiv('visual-notes-storyboard-contact-cell'); const frame = cell.createDiv(); renderStoryboardShot(this.app, frame, shot, true);
        cell.createDiv({ cls: 'visual-notes-storyboard-contact-meta', text: `${shot.shot ?? ''}${shot.title ? ` — ${shot.title}` : ''}` });
        if (shot.notes?.trim()) cell.createDiv({ cls: 'visual-notes-storyboard-contact-notes', text: shot.notes.trim() });
      }
    }
    try {
      // Shot backgrounds are usually vault files, but nothing stops one being
      // a remote address — and one unreachable picture would otherwise reject
      // the whole sheet. Same mechanism as board export; see inlineRemoteImages.
      // No restore needed: this sheet is a throwaway built for the render and
      // removed in the finally below, unlike the live board.
      await inlineRemoteImages(sheet);
      const url = await toPng(sheet, { pixelRatio: 2, backgroundColor: '#fff', ...EXPORT_IMAGE_TOLERANCE });
      createEl('a', { href: url, attr: { download: `${storyboardExportBaseName(this.card.title)}-contact-sheet.png` } }).click();
      new Notice('Storyboard contact sheet exported.');
    } catch (error) { console.error('Visual Notes: storyboard export failed', error); new Notice('Storyboard export failed.'); }
    finally { sheet.remove(); }
  }

  override onClose(): void {
    if (this.playTimer !== null) window.clearTimeout(this.playTimer);
    if (this.dirty) this.changed();
    this.contentEl.empty();
  }
}

export const cardsStoryboardMethods = {
  addStoryboardCard(this: FreeformRenderer): void {
    const p = this.centerPos(STORYBOARD_DEFAULT_W, STORYBOARD_DEFAULT_H); this.addStoryboardCardAt(p.x, p.y);
  },

  addStoryboardCardAt(this: FreeformRenderer, x: number, y: number): void {
    const card: StoryboardCard = {
      id: crypto.randomUUID(), kind: 'storyboard', title: 'Untitled storyboard', view: 'filmstrip', previewSize: 'md',
      x, y, w: STORYBOARD_DEFAULT_W, h: STORYBOARD_DEFAULT_H, z: this.nextZ(),
      sections: [{ id: crypto.randomUUID(), title: 'Overall scene', shots: [newShot(1), newShot(2), newShot(3)] }],
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow(); this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  renderStoryboardContent(this: FreeformRenderer, el: HTMLElement, card: StoryboardCard): void {
    const previousPlayback = cardPlaybacks.get(card.id);
    if (previousPlayback && previousPlayback.timer !== null) window.clearTimeout(previousPlayback.timer);
    cardPlaybacks.delete(card.id);
    el.addClass('visual-notes-freeform-storyboard-card');
    const header = el.createDiv('visual-notes-storyboard-card-header');
    const preview = el.createDiv(`visual-notes-storyboard-preview is-${card.view ?? 'filmstrip'} is-size-${card.previewSize ?? 'md'}`);
    header.createDiv({ cls: 'visual-notes-storyboard-card-title', text: card.title ?? 'Untitled storyboard' });
    const count = allShots(card).length; header.createSpan({ cls: 'visual-notes-storyboard-card-count', text: `${count} shot${count === 1 ? '' : 's'}` });
    const sizes = ['sm', 'md', 'lg'] as const;
    const sizeLabels = { sm: 'S', md: 'M', lg: 'L' } as const;
    const sizeNames = { sm: 'Small', md: 'Medium', lg: 'Large' } as const;
    const size = card.previewSize ?? 'md';
    const resize = header.createEl('button', {
      cls: 'visual-notes-storyboard-card-action visual-notes-storyboard-preview-size',
      text: sizeLabels[size], attr: { 'aria-label': `Shot preview size: ${sizeNames[size]}` },
    });
    resize.addEventListener('pointerdown', e => e.stopPropagation());
    resize.addEventListener('click', e => {
      e.stopPropagation();
      card.previewSize = sizes[(sizes.indexOf(card.previewSize ?? 'md') + 1) % sizes.length];
      this.renderCardContent(el, card); this.scheduleSave();
    });
    const play = header.createEl('button', { cls: 'visual-notes-storyboard-card-action', attr: { 'aria-label': 'Play storyboard' } });
    setIcon(play, 'play');
    play.addEventListener('pointerdown', e => e.stopPropagation());
    play.addEventListener('click', e => {
      e.stopPropagation();
      const active = cardPlaybacks.get(card.id);
      if (active) {
        if (active.timer !== null) window.clearTimeout(active.timer);
        cardPlaybacks.delete(card.id); this.renderCardContent(el, card); return;
      }
      const shots = allShots(card); if (!shots.length) return;
      const state: CardPlayback = { timer: null, token: Symbol(card.id) };
      cardPlaybacks.set(card.id, state); setIcon(play, 'square'); play.setAttribute('aria-label', 'Stop storyboard');
      const stop = () => {
        if (cardPlaybacks.get(card.id)?.token !== state.token) return;
        if (state.timer !== null) window.clearTimeout(state.timer);
        cardPlaybacks.delete(card.id);
        if (el.isConnected) this.renderCardContent(el, card);
      };
      const show = (index: number) => {
        if (!el.isConnected) { stop(); return; }
        if (cardPlaybacks.get(card.id)?.token !== state.token) return;
        const shot = shots[index];
        preview.empty(); preview.addClass('is-playing');
        const player = preview.createDiv('visual-notes-storyboard-player');
        const frame = player.createDiv('visual-notes-storyboard-player-frame');
        renderStoryboardShot(this.app, frame, shot);
        player.createDiv({
          cls: 'visual-notes-storyboard-player-label',
          text: `${index + 1} / ${shots.length} · ${shot.shot || 'Shot'}${shot.title ? ` — ${shot.title}` : ''}`,
        });
        state.timer = window.setTimeout(
          () => index + 1 < shots.length ? show(index + 1) : stop(),
          Math.max(300, (shot.duration ?? 3) * 1000),
        );
      };
      show(0);
    });
    const gridView = card.view === 'grid';
    const view = header.createEl('button', {
      cls: 'visual-notes-storyboard-card-action',
      attr: { 'aria-label': gridView ? 'Use filmstrip preview' : 'Use grid preview' },
    });
    setIcon(view, gridView ? 'gallery-horizontal-end' : 'layout-grid');
    view.addEventListener('pointerdown', e => e.stopPropagation()); view.addEventListener('click', e => { e.stopPropagation(); card.view = card.view === 'grid' ? 'filmstrip' : 'grid'; this.renderCardContent(el, card); this.scheduleSave(); });
    const open = header.createEl('button', { cls: 'visual-notes-storyboard-card-action', attr: { 'aria-label': 'Open storyboard editor' } }); setIcon(open, 'maximize-2');
    open.addEventListener('pointerdown', e => e.stopPropagation()); open.addEventListener('click', e => { e.stopPropagation(); this.openStoryboardEditor(card); });
    for (const shot of allShots(card)) {
      const thumb = preview.createDiv('visual-notes-storyboard-preview-shot');
      const frame = thumb.createDiv('visual-notes-storyboard-preview-frame');
      renderStoryboardShot(this.app, frame, shot, true);
      if (shot.notes?.trim()) thumb.createDiv({ cls: 'visual-notes-storyboard-preview-notes', text: shot.notes.trim() });
    }
    if (!count) preview.createDiv({ cls: 'visual-notes-storyboard-preview-empty', text: 'Open the editor to add a shot' });
    preview.addEventListener('dblclick', e => { e.stopPropagation(); this.openStoryboardEditor(card); });
    this.appendResizeHandles(el);
  },

  openStoryboardEditor(this: FreeformRenderer, card: StoryboardCard): void {
    this.pushUndo();
    new StoryboardEditorModal(this.app, card, () => { const el = this.cardEls.get(card.id); if (el) this.renderCardContent(el, card); this.scheduleSave(); }).open();
  },
};
