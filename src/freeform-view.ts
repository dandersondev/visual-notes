import {
  App, TFile, TFolder, TAbstractFile, Notice, setIcon,
  Component, Platform,
} from 'obsidian';
import {
  VisualNotesFile, TileCard,
  BookmarkCard,
  Card,
} from './file-types';
import { contrastColor } from './color-utils';
import { NamePromptModal } from './tile-modal';
import { isCustomIconRef, resolveCustomIconSrc, CUSTOM_ICONS, customIconRef } from './custom-icons';
import {
  Viewport,
  viewportTransform,
} from './canvas/pan-zoom';
import { SelectionManager } from './canvas/selection';
import { ContextBar } from './context-bar';
import { createBoardFile, writeBoardFile } from './file-io';
import { SaveQueue } from './save-queue';
import {
  TILE_DEFAULT_W, TILE_DEFAULT_H,
  DOT_SPACING,
  SupportedCard,
} from './freeform-view-shared';
import { canvasMethods } from './freeform-view-canvas';
import { PenDrawOptions, DEFAULT_PEN_DRAW_OPTIONS, PenOptionsPanel } from './pen-options-panel';
import { cardsBasicMethods } from './freeform-view-cards-basic';
import { cardsTableMethods } from './freeform-view-cards-table';
import { cardsKanbanMethods } from './freeform-view-cards-kanban';
import { cardsColumnMethods } from './freeform-view-cards-column';
import { cardsMediaMethods } from './freeform-view-cards-media';
import { cardsCalendarMethods } from './freeform-view-cards-calendar';
import { cardsCheckersMethods } from './freeform-view-cards-checkers';
import { overlaysMethods } from './freeform-view-overlays';
import { persistenceMethods } from './freeform-view-persistence';
import { clipboardMethods } from './freeform-view-clipboard';

// ── Renderer ───────────────────────────────────────────────────
// FreeformRenderer's implementation is split across this file (fields,
// constructor, and core dispatch shared by every card kind) and the
// satellite files imported above, each contributing one responsibility's
// methods onto this same prototype via Object.assign — see the bottom of
// this file. Same runtime class either way; declare-module augmentation
// in each satellite makes every method visible here (and to each other)
// at the type level too. Split by responsibility:
//   freeform-view-canvas.ts       — pan/zoom/selection/drag/connections/ink
//   freeform-view-cards-*.ts      — per-card-kind rendering and editing
//   freeform-view-overlays.ts     — toolbar/context menus/minimap/search/filters
//   freeform-view-persistence.ts  — save queue/undo/redo/archive
//   freeform-view-clipboard.ts    — copy/cut/paste of card groups, group templates
export class FreeformRenderer extends Component {
  outer!: HTMLElement;
  inner!: HTMLElement;
  marqueeEl!: HTMLElement;
  zoomPill!: HTMLElement;
  snapToggleBtn: HTMLElement | null = null;
  // Switches Obsidian's own light/dark setting; deliberately NOT the board's
  // own appearance, which boards could once pin for themselves and which was
  // removed because two places to set it confused people. Null whenever the
  // setting is off, and read back as such by refreshAppearanceButton — which
  // the css-change listener calls whether or not the button was ever built.
  appearanceBtn: HTMLElement | null = null;
  toolbarEl!: HTMLElement;
  fabEl: HTMLElement | null = null;
  // Bottom-left drop target — anything draggable (cards, kanban items,
  // column children, sketches) dropped onto it gets deleted.
  trashZoneEl: HTMLElement | null = null;
  // Stacked just above the trash zone — the only on-screen affordance for
  // undo/redo; Cmd/Ctrl+Z alone is undiscoverable on iPad, where drawing
  // with Apple Pencil means there's usually no keyboard in reach at all.
  undoBtnEl: HTMLElement | null = null;
  redoBtnEl: HTMLElement | null = null;
  // Minimap widget — collapsed to a small toggle circle by default; UI-only
  // open/closed state, not persisted (always starts collapsed on reload).
  minimapOpen = false;
  minimapEl: HTMLElement | null = null;
  minimapBodyEl: HTMLElement | null = null;
  minimapViewportEl: HTMLElement | null = null;
  minimapTransform: {
    scale: number; offX: number; offY: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
  } | null = null;
  // Last pointer position over the canvas (client coords) — where a "/"
  // quick-add drops its new card.
  lastPointerClient: { x: number; y: number } | null = null;
  // Board search — matches by any text a card carries; UI-only state.
  searchWrapEl: HTMLElement | null = null;
  searchInputEl: HTMLInputElement | null = null;
  searchCountEl: HTMLElement | null = null;
  searchMatches: string[] = [];
  searchIndex = 0;
  // Board filter — OR-match on tag/label chips ('tag:x' / 'label:y' keys);
  // UI-only state, cleared on reload.
  activeFilters = new Set<string>();
  filterWrapEl: HTMLElement | null = null;
  filterPanelEl: HTMLElement | null = null;
  filterCountEl: HTMLElement | null = null;
  svgEl!: SVGSVGElement;
  connectionPaths = new Map<string, SVGPathElement>();
  // Directly-computed arrowhead triangle(s) per connection (1 for 'end'
  // or 'start' only, 2 for 'both') — see computeArrowheadPolygons. Lives
  // in svgEl (not hitSvgEl) so arrowheads keep the same z-order (behind
  // cards) as the connection line itself.
  connectionMarkerPaths = new Map<string, SVGPolygonElement[]>();

  connectMode = false;
  connectSourceId: string | null = null;
  ghostPath: SVGPathElement | null = null;
  connectToolBtn: HTMLElement | null = null;
  // Held so the "T" shortcut can arm the tool *and* light its button up, the
  // same as clicking it would.
  textToolBtn: HTMLElement | null = null;
  connectMoveListener: ((e: PointerEvent) => void) | null = null;

  connectionHitPaths = new Map<string, SVGPathElement>();
  hitSvgEl!: SVGSVGElement;
  connectionLabelEls = new Map<string, SVGGElement>();
  connectionSelectPath: SVGPathElement | null = null;
  connectionBendHandle: SVGCircleElement | null = null;
  connectionEndpointHandles: SVGCircleElement[] = [];
  selectedConnectionId: string | null = null;
  connPropsEl: HTMLElement | null = null;
  // Connections caught by the marquee (drag-box) selection — a separate,
  // lightweight parallel to `selection` (cards) and `selectedConnectionId`
  // (single click-selected connection), since retrofitting true multi-select
  // onto the rich single-connection editing UI (bend handle, endpoints,
  // props panel) would be a much bigger change than this needs.
  marqueeConnectionIds = new Set<string>();

  // ── Free-floating pen ink (drawings) ──────────────────────────
  inkSvgEl!: SVGSVGElement;
  inkPaths = new Map<string, SVGPathElement>();
  inkHitPaths = new Map<string, SVGPathElement>();
  penModeActive = false;
  penToolBtn: HTMLElement | null = null;
  penColorPicker: HTMLElement | null = null;
  penBanner: HTMLElement | null = null;
  // Advanced perfect-freehand tuning panel, opened via the gear icon in the
  // pen color/width picker — constructed lazily on first open (see
  // togglePenOptionsPanel), not on every enterPenMode.
  penOptionsPanel: PenOptionsPanel | null = null;
  // A literal CSS variable reference, not a resolved hex — re-evaluates
  // live if the user switches theme mid-session (a hex computed once from
  // body.hasClass('theme-dark') at construction time never did, which was
  // reported as new strokes staying whatever color the board opened with,
  // regardless of which theme was actually active by the time you drew).
  // Same var --visual-notes-card-text itself resolves to, so ink always matches
  // body text — legible against --visual-notes-card-bg/--visual-notes-canvas-bg in any theme.
  currentInkColor = 'var(--text-normal)';
  currentInkWidth = 4; // Medium — matches the Thin/Medium/Thick picker's own values (2/4/8)
  // Which drawing instrument is active while in pen mode. Highlighter draws
  // wide, semi-transparent strokes; eraser scrubs whole strokes away.
  penTool: 'pen' | 'highlighter' | 'eraser' = 'pen';
  // The highlighter keeps its own color selection (classic fluoro palette),
  // so flipping between pen and highlighter doesn't clobber either choice.
  currentHighlightColor = '#ffeb3b';
  // Strokes drawn close together (within PEN_GROUP_PROXIMITY, see
  // startInkStroke) share this groupId, so a multi-stroke sketch behaves as
  // one selectable/draggable/deletable unit — a new stroke starting far
  // away gets a fresh group instead of joining this one.
  currentPenGroupId: string | null = null;
  // Set for the duration of an in-progress pen stroke; calling it force-
  // aborts that stroke (removes its listeners and live preview) without
  // waiting for its own pointerup/pointercancel. startInkStroke calls this
  // defensively before starting a new stroke — see the comment there.
  activeStrokeAbort: (() => void) | null = null;
  // Holds groupIds (not individual stroke ids) — selection, drag, delete,
  // and recolor all operate on every stroke sharing any of these groups.
  // Box-select and Shift/Ctrl-click can select several separate groups at
  // once, same as card multi-select.
  selectedDrawingIds: Set<string> = new Set();
  inkSelectGroup: SVGGElement | null = null;
  drawingBoxEl: HTMLElement | null = null;

  vp: Viewport;
  selection = new SelectionManager();
  cardEls = new Map<string, HTMLElement>();
  // Current sort applied to a table card — UI-only, not persisted (resets on reload).
  tableSort = new Map<string, { colId: string; dir: 'asc' | 'desc' }>();
  // Keeps each table's zoom layer laid out at the scroll container's real
  // width while the card is resized (resize doesn't re-render content).
  tableGridResizeObs = new Map<string, ResizeObserver>();
  // Every permanent card removal (delete, archive, trash-drop, absorb into a
  // column) must go through here so a table's zoom-layer ResizeObserver is
  // disconnected instead of leaking on the now-detached DOM node forever.
  // Sheets-style rectangular cell selection on one table card — UI-only.
  // a = anchor cell (where the drag started), b = focus cell (where it is
  // now); the selected range is the rect spanned by the two.
  tableCellSel: {
    cardId: string; layer: HTMLElement;
    a: { r: number; c: number }; b: { r: number; c: number };
  } | null = null;
  tableSelOutsideBound = false;
  // Currently-selected square (board index) per checkers card, and which of
  // those cards is mid multi-jump (must keep capturing with the same piece
  // before the turn can pass) — both UI-only, not persisted.
  checkersSelected = new Map<string, number>();
  checkersForced = new Set<string>();

  undoStack: string[] = [];
  redoStack: string[] = [];

  spaceDown = false;
  isPanning = false;
  // When a real drop event last added a card. The touch-release path that
  // catches Obsidian's own iPad sidebar drag checks this so a platform firing
  // both a drop and a pointerup cannot add the same file twice.
  lastNativeDropAt = 0;
  // 'hand' turns a plain left-drag anywhere — background or over a card —
  // into a pan, and stops cards selecting or dragging. Distinct from
  // pendingTool, which is a one-shot placement armed for the next click;
  // this is a mode that stays until changed. Space still works as the
  // momentary override in either mode, so the two don't compete.
  interactionMode: 'select' | 'hand' = 'select';
  handModeBtn: HTMLElement | null = null;
  selectModeBtn: HTMLElement | null = null;
  // Set when a right-click-to-pan drag (see startPan) actually moves the
  // viewport, so the contextmenu event Chrome/Firefox fire on right-button
  // release doesn't pop a menu on top of what was really just a pan gesture.
  suppressNextContextMenu = false;

  // Debounces + serializes writeBoardFile calls — see save-queue.ts. Built
  // in the constructor (needs onSave/file, which aren't available at field-
  // initializer time).
  saveQueue!: SaveQueue;
  minimapFilterTimer: number | null = null;
  // rAF-batching flag for connection culling on pan/zoom — see
  // scheduleCullingRefresh in freeform-view-canvas.ts.
  cullFramePending = false;
  alignBarEl: HTMLElement | null = null;
  pendingTool: string | null = null;
  pendingToolBtn: HTMLElement | null = null;
  overflowPopover: HTMLElement | null = null;
  contextBar!: ContextBar;

  docKeyDown!: (e: KeyboardEvent) => void;
  docKeyUp!: (e: KeyboardEvent) => void;
  // Catches Obsidian's own touch drag from the file explorer, which fires no
  // drop event. On the document rather than the canvas because Obsidian may
  // hold pointer capture on the element being dragged — see bindCanvasEvents.
  docPointerUp!: (e: PointerEvent) => void;

  pinchDist: number | null = null;
  pinchMidX = 0;
  pinchMidY = 0;

  // Tracks how many fingers are currently touching the canvas (Pointer
  // Events don't expose "are there other active touches" directly — only
  // the touch* events give a live count via e.touches.length). Used so a
  // pinch's first-finger-down doesn't briefly start a one-finger pan before
  // the second finger arrives — see maybeStartTouchPan.
  activeTouches = 0;
  cancelActiveMarquee: (() => void) | null = null;
  cancelActiveTouchPan: (() => void) | null = null;

  // Manual long-press-to-contextmenu detection. Every card/item's own
  // pointerdown handler calls preventDefault() (needed to stop iOS from
  // scrolling or selecting text mid-drag) — but that side effect also kills
  // WebKit's native long-press gesture recognizer, so a real 'contextmenu'
  // event never gets synthesized from a touch hold. Detecting the hold
  // ourselves and dispatching a synthetic 'contextmenu' event lets every
  // existing right-click menu in this file work unchanged on touch too.
  longPressTimer: number | null = null;
  longPressPointerId: number | null = null;
  longPressStartX = 0;
  longPressStartY = 0;
  longPressTarget: HTMLElement | null = null;

  constructor(
    public app: App,
    public container: HTMLElement,
    public board: VisualNotesFile,
    public file: TFile,
    public onNavigate: (boardPath: string) => Promise<void>,
    public onSave: (board: VisualNotesFile) => Promise<void>,
    public bookmarkCacheDays = 30,
    public defaultStickyColor?: string,
    public toolbarPosition: 'left' | 'right' | 'top' | 'bottom' = 'left',
    public commentAuthorName?: string,
    public cardDragAnimationEnabled = true,
    public cardDragAnimationIntensity = 1,
    public largeKanbanItems = false,
    public snapToGridEnabled = true,
    public snapGridSize = 32,
    public onToggleSnapToGrid?: (value: boolean) => void,
    public mobileFabPosition: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' = 'bottom-right',
    public penDrawOptions: PenDrawOptions = { ...DEFAULT_PEN_DRAW_OPTIONS },
    public onPenDrawOptionsChange?: (value: PenDrawOptions) => void,
    public panButton: 'middle' | 'right' | 'either' = 'middle',
    public appearanceButtonEnabled = true,
  ) {
    super();
    this.vp = { ...(board.viewport ?? { x: 0, y: 0, zoom: 1 }) };
    this.saveQueue = new SaveQueue(
      () => this.onSave(this.board),
      (err) => {
        console.error('Visual Notes: failed to save board', err);
        const reason = err instanceof Error ? err.message : String(err);
        new Notice(`Visual Notes: couldn't save "${this.file.basename}" — ${reason}. Your changes are still on screen; try again or check the console.`, 10000);
      },
    );
    // Heals nested-board chip paths live when a linked board is renamed or
    // moved while this board is open. Registered here rather than render()
    // — onVaultRename re-renders, so registering there would stack a
    // duplicate listener per rename. Cleaned up via destroy() → unload().
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)));
    // Keeps the theme toggle showing the right icon when the scheme changes
    // anywhere else — Appearance settings, the command palette, a hotkey, or
    // the system switching over on an "Adapt to system" vault. Registered
    // here for the same reason as the rename listener above: render() runs
    // again on every re-render, which would stack a duplicate each time.
    this.registerEvent(this.app.workspace.on('css-change', () => this.refreshAppearanceButton()));
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  render(): void {
    this.container.addClass('visual-notes-freeform-host');
    // WebKit (desktop Safari, and — confirmed on-device — the iPadOS/iOS
    // app too) has long-standing bugs tracking content-visibility: auto's
    // viewport intersection through a transformed ancestor — cards live
    // inside .visual-notes-canvas-inner, which pan/zoom sets a CSS
    // transform on, and can end up wrongly treated as off-screen and
    // skipped, flickering or vanishing entirely (reappearing once panning/
    // zooming forces a fresh intersection check — the reported symptom).
    // Platform.isSafari alone doesn't catch this: it did not fire inside
    // Obsidian's iPadOS app in testing, even though that app renders with
    // the same WKWebView engine desktop Safari does. Platform.isIosApp is
    // unambiguous — every iOS/iPadOS app is WebKit, no exceptions — so it's
    // included regardless of what isSafari reports.
    // See the matching CSS override on .is-safari .visual-notes-freeform-card
    // in styles.css.
    this.container.toggleClass('is-safari', Platform.isSafari || Platform.isIosApp);
    this.container.empty();
    this.cardEls.clear();
    this.connectionPaths.clear();

    this.outer = this.container.createDiv('visual-notes-canvas-outer');
    this.outer.setAttribute('tabindex', '0');
    // Obsidian mobile opens the left/right sidebar drawers on horizontal
    // swipes, via a gesture recognizer listening up at the app container —
    // on a tablet that constantly misfires while panning/drawing near the
    // screen edges. Stop touch events from bubbling out of the canvas so
    // swipes that START here never reach the recognizer; our own pan/zoom
    // uses pointer events on this same element, which are unaffected.
    // Swipes starting outside the canvas (header, tab bar, other panes)
    // still open the sidebars normally.
    for (const evt of ['touchstart', 'touchmove', 'touchend'] as const) {
      this.outer.addEventListener(evt, (e) => e.stopPropagation(), { passive: true });
    }
    // Dots always show now that the toggle is gone (see freeform-view.ts
    // history) — a board saved with dotsHidden:true from before would
    // otherwise be permanently stuck with no dots and no way to turn them
    // back on, since there's no longer any UI for it.
    // Dot color/size are configurable via plugin settings, applied as CSS
    // custom properties on document.body (see main.ts's applyCanvasAppearanceSettings)
    // so every open board updates live and in one place — not threaded
    // through here per-instance.
    this.inner = this.outer.createDiv('visual-notes-canvas-inner');
    this.marqueeEl = this.outer.createDiv('visual-notes-marquee');
    this.marqueeEl.hide();

    // SVG connection layer goes first so it renders behind cards
    this.initConnectionLayer();

    for (const card of this.board.cards) this.createCardEl(card);
    this.refreshAllConnections();

    // Ink layer initialized after cards so free-floating pen strokes render
    // on top of everything — z-index in CSS also enforces this regardless
    // of DOM order, matching the connections hit-layer's own approach.
    this.initInkLayer();
    this.renderAllDrawings();

    this.applyViewport();
    this.bindCanvasEvents();
    this.bindDelegatedCardEvents();
    this.renderToolbar();
    this.renderAlignBar();
    this.renderZoomPill();
    this.renderAppearanceButton();
    this.renderTrashZone();
    this.renderUndoRedoButtons();
    this.renderMinimap();
    this.renderSearchWidget();
    this.renderFilterWidget();

    // Re-fetch stale bookmarks — capped so a board with many stale bookmarks
    // doesn't fire dozens of simultaneous network requests (and disk saves)
    // the moment it opens.
    const staleBookmarks = this.board.cards.filter((card): card is BookmarkCard =>
      card.kind === 'bookmark' && !card.fetchFailed &&
      (!card.fetchedAt || Date.now() - card.fetchedAt > this.bookmarkCacheDays * 86_400_000));
    void this.runWithConcurrency(staleBookmarks, 3, async (card) => {
      const el = this.cardEls.get(card.id);
      if (el) await this.fetchAndUpdateBookmark(card, el);
    });

    window.setTimeout(() => this.outer.focus(), 0);
  }

  async destroy(): Promise<void> {
    this.exitConnectMode();
    this.deselectConnection();
    activeDocument.removeEventListener('keydown', this.docKeyDown);
    activeDocument.removeEventListener('keyup', this.docKeyUp);
    activeDocument.removeEventListener('pointerup', this.docPointerUp, { capture: true });
    // A pending debounced edit must actually be written, not silently
    // dropped because the timer that would have triggered it got
    // cancelled below — this is the last chance before the board object
    // itself goes away.
    const needsFlush = this.saveQueue.hasPendingWork;
    if (this.minimapFilterTimer) { window.clearTimeout(this.minimapFilterTimer); this.minimapFilterTimer = null; }
    for (const ro of this.tableGridResizeObs.values()) ro.disconnect();
    this.tableGridResizeObs.clear();
    this.contextBar?.destroy();
    if (needsFlush) await this.saveNow();
    this.unload();
  }

  setCursor(cursor: '' | 'grab' | 'grabbing' | 'crosshair'): void {
    this.outer.removeClass('visual-notes-cursor-grab', 'visual-notes-cursor-grabbing', 'visual-notes-cursor-crosshair');
    if (cursor) this.outer.addClass(`visual-notes-cursor-${cursor}`);
  }

  // Switches between select ("V") and hand ("H"). Kept here rather than
  // alongside activateTool because it is not a placement tool: nothing is
  // armed for one click, and it does not clear itself after use.
  setInteractionMode(mode: 'select' | 'hand'): void {
    if (this.interactionMode === mode) return;
    this.interactionMode = mode;
    this.outer.toggleClass('visual-notes-hand-mode', mode === 'hand');
    this.handModeBtn?.toggleClass('is-active', mode === 'hand');
    this.selectModeBtn?.toggleClass('is-active', mode === 'select');
    // Space held at the moment of the switch keeps its own grab cursor;
    // otherwise the mode decides it.
    if (!this.isPanning) this.setCursor(mode === 'hand' || this.spaceDown ? 'grab' : '');
  }

  // ── Viewport ───────────────────────────────────────────────────

  applyViewport(): void {
    this.inner.style.transform = viewportTransform(this.vp);
    const size = DOT_SPACING * this.vp.zoom;
    const posX = ((this.vp.x % size) + size) % size;
    const posY = ((this.vp.y % size) + size) % size;
    this.outer.style.backgroundSize = `${size}px ${size}px`;
    this.outer.style.backgroundPosition = `${posX}px ${posY}px`;
    this.zoomPill?.setText(`${Math.round(this.vp.zoom * 100)}%`);
    if (this.minimapOpen) this.updateMinimapViewportRect();
    this.scheduleCullingRefresh();
    this.contextBar?.reposition(); // keeps the floating bar aligned with the card through pan/zoom
  }

  // ── Canvas event binding ───────────────────────────────────────


  // ── Pan ────────────────────────────────────────────────────────


  // ── Marquee ────────────────────────────────────────────────────


  // Two-finger pinch/pan begins as one finger's pointerdown landing before
  // the second — starting the marquee immediately on that first finger
  // would briefly draw a selection box on every pinch, before the pinch
  // handler (touchmove with 2 active touches) takes over. Wait one tick,
  // tracked via activeTouches (see its declaration), and only start the
  // marquee if it's still just the one finger by then; bail out early too
  // if the finger was already lifted (a quick tap) before the tick fires.



  // ── Card creation ──────────────────────────────────────────────

  createCardEl(card: SupportedCard): HTMLElement {
    const el = this.inner.createDiv('visual-notes-freeform-card');
    el.dataset.id = card.id;
    this.positionCardEl(el, card);
    this.renderCardContent(el, card);
    this.cardEls.set(card.id, el);
    return el;
  }

  positionCardEl(el: HTMLElement, card: Card): void {
    el.style.left   = `${card.x ?? 0}px`;
    el.style.top    = `${card.y ?? 0}px`;
    // A text card is sized entirely by its content at the current font size —
    // no wrapping means no width to impose — so both axes are left to CSS.
    // Its w/h are still maintained (see syncTextCardSize) for connections,
    // the minimap and export, which read them rather than the DOM.
    el.style.width  = card.kind === 'text' ? '' : `${card.w ?? TILE_DEFAULT_W}px`;
    // Regular sticky notes auto-size to content; blank cards and every
    // other kind use their saved height.
    el.style.height = (card.kind === 'text' || (card.kind === 'sticky' && !card.blank))
      ? '' : `${card.h ?? TILE_DEFAULT_H}px`;
    el.setCssProps({ '--card-z': String(card.z ?? 0) });
  }

  // ── Content dispatch ───────────────────────────────────────────

  renderCardContent(el: HTMLElement, card: SupportedCard): void {
    el.empty();
    el.removeClass(
      'visual-notes-freeform-tile-card', 'visual-notes-freeform-sticky-card',
      'visual-notes-freeform-checklist-card', 'visual-notes-freeform-comment-card',
      'visual-notes-freeform-table-card', 'visual-notes-table-alt',
      'visual-notes-freeform-notelink-card',
      'visual-notes-freeform-image-card', 'visual-notes-freeform-audio-card',
      'visual-notes-freeform-bookmark-card', 'visual-notes-freeform-text-card'
    );
    switch (card.kind) {
      case 'tile':      this.renderTileContent(el, card);      break;
      case 'sticky':    this.renderStickyContent(el, card);    break;
      case 'checklist': this.renderChecklistContent(el, card); break;
      case 'comment':   this.renderCommentContent(el, card);   break;
      case 'table':     this.renderTableContent(el, card);     break;
      case 'note-link': this.renderNoteLinkContent(el, card);  break;
      case 'image':     this.renderImageContent(el, card);     break;
      case 'audio':     this.renderAudioContent(el, card);     break;
      case 'video':     this.renderVideoContent(el, card);     break;
      case 'bookmark':  this.renderBookmarkContent(el, card);  break;
      case 'kanban-column': this.renderKanbanColumnContent(el, card); break;
      case 'kanban-board': this.renderKanbanBoardContent(el, card); break;
      case 'column': this.renderColumnContent(el, card); break;
      case 'map': this.renderMapContent(el, card); break;
      case 'text': this.renderTextContent(el, card); break;
      case 'swatch': this.renderSwatchContent(el, card); break;
      case 'file': this.renderFileContent(el, card); break;
      case 'callout': this.renderCalloutContent(el, card); break;
      case 'group': this.renderGroupContent(el, card); break;
      case 'calendar': this.renderCalendarContent(el, card); break;
      case 'checkers': this.renderCheckersContent(el, card); break;
    }
    el.toggleClass('is-selected', this.selection.has(card.id));
    this.addConnectionHandles(el, card);
    this.renderCardBadges(el, card);
  }

  // ── Labels & reactions (universal — every card kind) ────────────
  // Rendered as a pill row inset at the card's bottom edge rather than
  // hanging off the corner: some card kinds (checklist, kanban, column)
  // clip overflow on the outer element, so anything positioned outside the
  // card's own bounds would get cut off there. Staying inset works
  // regardless of which kind is rendering it.

  renderCardBadges(el: HTMLElement, card: SupportedCard): void {
    // :scope so a container card (Column) only clears its OWN badge bar —
    // an unscoped querySelector here matched the first bar anywhere in the
    // subtree, silently deleting a child card's freshly-rendered chips.
    el.querySelector(':scope > .visual-notes-card-badges')?.remove();
    const hasLabels = !!card.labels?.length;
    const hasReactions = !!card.reactions?.length;
    if (!hasLabels && !hasReactions && !card.nestedBoardPath) return;

    const bar = el.createDiv('visual-notes-card-badges');
    if (card.nestedBoardPath) {
      // Nested-board chip goes first so it always sits at the same spot —
      // it's a navigation affordance, not a removable decoration like the
      // label/reaction pills after it (unlink lives in the context menu).
      const pill = bar.createDiv('visual-notes-card-nested-pill');
      const iconSrc = card.nestedBoardIcon && isCustomIconRef(card.nestedBoardIcon)
        ? resolveCustomIconSrc(card.nestedBoardIcon) : undefined;
      if (iconSrc) pill.createEl('img', { attr: { src: iconSrc }, cls: 'visual-notes-nested-pill-img' });
      else { const ic = pill.createSpan(); setIcon(ic, 'layout-template'); }
      const resolved = this.resolveNestedBoard(card.nestedBoardPath);
      const boardName = resolved?.basename
        ?? card.nestedBoardPath.split('/').pop()?.replace(/\.canvas$/, '') ?? 'Board';
      pill.toggleClass('is-missing', !resolved);
      pill.createSpan({ text: boardName });
      pill.setAttribute('aria-label', `Open nested board "${boardName}"`);
      pill.addEventListener('pointerdown', (e) => e.stopPropagation());
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openNestedBoard(card.nestedBoardPath!, (p) => { card.nestedBoardPath = p; });
      });
    }
    for (const label of card.labels ?? []) {
      const pill = bar.createDiv('visual-notes-card-label-pill');
      pill.style.backgroundColor = label.color;
      pill.style.color = contrastColor(label.color);
      pill.setText(label.text);
      pill.setAttribute('aria-label', `Remove label "${label.text}"`);
      pill.addEventListener('pointerdown', (e) => e.stopPropagation());
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo();
        card.labels = (card.labels ?? []).filter(l => l.id !== label.id);
        this.renderCardBadges(el, card);
        this.scheduleSave();
      });
    }
    for (const emoji of card.reactions ?? []) {
      const pill = bar.createDiv('visual-notes-card-reaction-pill');
      pill.setText(emoji);
      pill.setAttribute('aria-label', `Remove reaction ${emoji}`);
      pill.addEventListener('pointerdown', (e) => e.stopPropagation());
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo();
        card.reactions = (card.reactions ?? []).filter(r => r !== emoji);
        this.renderCardBadges(el, card);
        this.scheduleSave();
      });
    }
  }

  // ── Nested board creation ──────────────────────────────────────

  // "Create nested board…" from any card's / kanban item's context menu.
  // Prompts for a name (prefilled from the source's own title), creates a
  // freeform board in a folder named after the current board (same
  // convention as TileModal's "Create new…"), seeds it with a back-link
  // tile pointing at this board, then navigates into it. The back-link
  // tile and the chip on the source card share one randomly-picked custom
  // color icon so the two ends of the link visually match. onLinked runs
  // before the save/navigate so the caller can stamp nestedBoardPath/Icon
  // onto the source card in time for saveNow() to persist it.
  createNestedBoardFrom(defaultName: string, onLinked: (path: string, icon: string) => void): void {
    new NamePromptModal(this.app, 'New nested board', 'Board name', (name) => { void (async () => {
      const iconDef = CUSTOM_ICONS[Math.floor(Math.random() * CUSTOM_ICONS.length)];
      const iconRef = customIconRef(iconDef.id);

      const folderPath = this.file.path.replace(/\.canvas$/, '');
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        try { await this.app.vault.createFolder(folderPath); } catch { /* already exists */ }
      }
      const folderAbstract = this.app.vault.getAbstractFileByPath(folderPath);
      const folder = folderAbstract instanceof TFolder ? folderAbstract : null;

      let newFile: TFile;
      try { newFile = await createBoardFile(this.app, name, folder, 'freeform'); }
      catch { new Notice('Failed to create board.'); return; }

      const backTile: TileCard = {
        id: crypto.randomUUID(), kind: 'tile',
        x: 40, y: 40, w: TILE_DEFAULT_W, h: TILE_DEFAULT_H,
        label: this.file.basename, subtitle: 'Parent board',
        icon: iconRef, color: '#3B82F6',
        target: { kind: 'board', path: this.file.path },
      };
      const seeded: VisualNotesFile = {
        version: 3, layout: 'freeform',
        viewport: { x: 0, y: 0, zoom: 1 },
        cards: [backTile], connections: [], drawings: [],
      };
      await writeBoardFile(this.app, newFile, seeded);

      onLinked(newFile.path, iconRef);
      await this.saveNow();
      new Notice(`Created nested board "${name}".`);
      void this.onNavigate(newFile.path);
    })(); }, defaultName).open();
  }

  // Resolve a stored nested-board path to its current file. Direct path
  // lookup first; if the board was moved since the link was created, fall
  // back to Obsidian's own wikilink-style resolution by filename (extension
  // included, since .canvas isn't markdown). Renames that happen while this
  // board is open are healed live instead by the vault rename listener in
  // render(); a rename made while this board was closed can't be recovered
  // (nothing ties the old name to the new one) — the chip dims via
  // .is-missing and clicking it explains rather than silently failing.
  resolveNestedBoard(path: string): TFile | null {
    const direct = this.app.vault.getAbstractFileByPath(path);
    if (direct instanceof TFile) return direct;
    const name = path.split('/').pop() ?? path;
    return this.app.metadataCache.getFirstLinkpathDest(name, this.file.path);
  }

  // Open a nested board chip/menu target, self-healing the stored path when
  // resolution found the file somewhere else (so the next open is a direct
  // hit and the healed path gets persisted).
  openNestedBoard(path: string, heal: (newPath: string) => void): void {
    const file = this.resolveNestedBoard(path);
    if (!file) {
      new Notice('Nested board not found — it may have been renamed or deleted while this board was closed. Unlink it from the context menu.');
      return;
    }
    if (file.path !== path) { heal(file.path); this.scheduleSave(); }
    void this.onNavigate(file.path);
  }

  // Live healing for renames/moves that happen while this board is open —
  // walks every place a nested-board link can live (top-level cards, column
  // children, kanban items in both board and legacy column cards) and
  // rewrites stale paths, then re-renders so chips pick up the new name.
  onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) return;
    // Track which top-level cards need their DOM patched, rather than
    // tearing down and rebuilding the entire board over what's usually a
    // single string field on one or two cards.
    const changedCards = new Set<SupportedCard>();
    const healCard = (c: { nestedBoardPath?: string }, owner: SupportedCard) => {
      if (c.nestedBoardPath === oldPath) { c.nestedBoardPath = file.path; changedCards.add(owner); }
    };
    for (const c of this.board.cards) {
      healCard(c, c);
      if (c.kind === 'column') for (const ch of c.children) healCard(ch, c);
      if (c.kind === 'kanban-board') for (const col of c.columns) for (const it of col.items) healCard(it, c);
      if (c.kind === 'kanban-column') for (const it of c.items) healCard(it, c);
      if (c.kind === 'calendar') {
        for (const note of c.notes ?? []) healCard(note, c);
        for (const style of Object.values(c.dayStyles ?? {})) healCard(style, c);
      }
    }
    if (changedCards.size) {
      this.scheduleSave();
      for (const c of changedCards) {
        const el = this.cardEls.get(c.id);
        if (!el) continue;
        if (c.kind === 'column' || c.kind === 'kanban-board' || c.kind === 'kanban-column') {
          this.rebuildKanbanCard(c);
        } else {
          this.renderCardContent(el, c);
        }
      }
    }
  }

  // Best-guess human name for a card, used to prefill the nested board's
  // name prompt — falls back to empty (placeholder shows) when a kind has
  // no obvious title.
  cardDisplayName(card: SupportedCard): string {
    let raw = '';
    switch (card.kind) {
      case 'tile': raw = card.label; break;
      case 'sticky': case 'comment': raw = card.text; break;
      case 'checklist': case 'table': case 'audio':
      case 'kanban-column': case 'kanban-board': case 'column':
      case 'calendar':
        raw = card.title ?? ''; break;
      case 'note-link': raw = card.path.split('/').pop()?.replace(/\.md$/, '') ?? ''; break;
      case 'image': raw = card.caption ?? ''; break;
      case 'bookmark': raw = card.title ?? ''; break;
      case 'file': raw = card.path.split('/').pop() ?? ''; break;
      // No title field to fall back on by design, so the filename is the name.
      case 'video': raw = card.source.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''; break;
      case 'callout': raw = card.text; break;
      case 'group': raw = card.label ?? ''; break;
    }
    // First line only, markdown emphasis stripped, kept short enough to be
    // a sane filename.
    return raw.split('\n')[0].replace(/[*_#`[\]]/g, '').trim().slice(0, 60);
  }

  // ── Tile ───────────────────────────────────────────────────────



  // ── Sticky ─────────────────────────────────────────────────────



  // ── Checklist ──────────────────────────────────────────────────





  // Reorder-only drag within a single checklist's own list — deliberately
  // simpler than startItemDrag (kanban items): no cross-card drops, no
  // ejecting to a standalone canvas card. Dropping outside the list is a
  // no-op; the item just snaps back to where it was.



  // ── Comment ────────────────────────────────────────────────────




  // ── Table ──────────────────────────────────────────────────────











  // Splits clipboard text into a cell grid (rows by newline, cells by tab).
  // Sheets/Excel copy the full selection rectangle, so every line can end
  // in a long run of tabs for cells that are actually empty — importing a
  // modest sheet would otherwise balloon the table with dozens of blank
  // columns (thousands of DOM cells). Trims to the real content extent:
  // trailing all-empty columns and rows go, interior blanks stay.

  // Pasting tab/newline-separated clipboard data (e.g. copied out of a
  // spreadsheet) fans the values out across cells starting at the pasted
  // cell, growing rows/columns as needed. A plain single-value paste falls
  // through to a normal plain-text insert so it doesn't drag in rich
  // formatting from the clipboard.


  // Option picker for a select-typed table cell — pick, clear, or mint a
  // new option (auto-assigned a color from a rotating palette).

  // A table pasted straight out of a spreadsheet can easily run to hundreds
  // of cells. Binding pointerdown/input/paste/keydown/blur per-cell meant a
  // full-card re-render (which every add/delete/sort/paste triggers) was
  // rebuilding thousands of listeners each time — the actual source of the
  // sluggishness, not the paste logic itself. Bound once on the grid
  // container instead and dispatched by reading each cell's data-row/
  // data-col, this is O(1) per render regardless of table size.


  // ── NoteLink ───────────────────────────────────────────────────


  // ── Image ──────────────────────────────────────────────────────


  // ── Audio ──────────────────────────────────────────────────────


  // ── Bookmark ───────────────────────────────────────────────────


  // ── Map (Google Maps embed) ────────────────────────────────────


  // Follows a maps.app.goo.gl / goo.gl short link and pulls the expanded
  // maps URL out of the response (og:url meta, canonical link, or any
  // /maps/place/… URL in the page).


  // ── Swatch ─────────────────────────────────────────────────────



  // ── File (generic attachment) ─────────────────────────────────





  // ── Callout ───────────────────────────────────────────────────




  // ── Group (native-Canvas-style spatial frame) ───────────────────



  // Every card whose center point falls inside the group's current bounds
  // — recomputed fresh on every drag, never stored, exactly like native
  // Canvas's own purely-geometric group membership. Other groups are never
  // swept up (no nested-group dragging).

  // Wraps the current multi-selection in a new group frame sized to their
  // bounding box (plus padding), placed behind them in z-order so they stay
  // visible on top — the "Group selection" action from native Canvas.



  // Lays out one of the curated color palettes as a grid of swatch cards,
  // top-left corner at (x, y) — a quick way to get a full reference chart
  // on the canvas instead of adding swatches one at a time.

  // ── Kanban column ──────────────────────────────────────────────

  // Shared by the legacy single-column card and each column inside a
  // multi-column board — the file/image drag-and-drop wiring onto an items
  // list is identical in both, differing only in which "locked" flag gates
  // it (the card's own vs. the owning board's).


  // Despite the name (kept to avoid touching every existing call site),
  // this is fully generic — renderCardContent already dispatches by
  // card.kind — so it doubles as the rebuild function for Column cards too.




  // ── Multi-column kanban board ─────────────────────────────────




  // Drag the divider between two adjacent board columns to trade width
  // between them. Widths live on KanbanColumn.width as relative flex
  // weights, so columns keep their proportions when the whole card resizes.








  // ── Generic Column container (Milanote-style) ─────────────────








  // Dragging a child: reorder within its column, move into a different
  // column, or drop it back onto the open canvas to pop it back out as a
  // normal top-level card — mirrors startItemDrag's approach for kanban
  // items, just operating on full cards instead of simplified items.



  // Builds the markdown body for a sticky note created from a kanban item —
  // the item's own text plus every attachment it carries (image/audio as
  // embeds, linked note as a wikilink, web link, tags), so extracting
  // doesn't silently drop data that only a KanbanItem (not a sticky) has
  // dedicated fields for.

  // Inverse of kanbanItemToStickyText: pulls a sticky note's markdown body
  // back apart into a KanbanItem's structured fields. Works paragraph by
  // paragraph (paragraphs are how kanbanItemToStickyText joins each field)
  // — a paragraph that's *entirely* an image/audio embed, a note wikilink,
  // a bare URL, or hashtags becomes that field and is removed from the
  // body; everything else (including a plain sticky that was never an
  // extracted item) stays in item.text untouched.

  // "Extract to canvas": pops a kanban item out of its column as a
  // standalone sticky note, positioned just to the right of where the item
  // currently sits. Mirrors startColumnChildDrag's drop-onto-canvas path,
  // just synthesizing a new card from a lightweight KanbanItem instead of
  // repositioning an already-full Card. Caller is responsible for removing
  // the item from its column afterward (via the owner's own removeItem).





  // Resolves which KanbanItemsOwner a given `.visual-notes-kanban-items`
  // element represents, via the dataset tags set when it was rendered.
  // Works uniformly whether it's a legacy single-column card's own items
  // list, or one column's items list inside a multi-column board — which is
  // what lets drag-and-drop work between any combination of the two without
  // special-casing.
  // True when the container card exists and has its padlock engaged —
  // items/children may not be dragged into or out of it.

  // Small padlock toggle shown in a container card's header/title bar.
  // Toggling re-renders the card so the icon and add-item affordances stay
  // in sync with the flag.



  // rebuild() replaces the whole kanban card's DOM, so the dropped item's
  // element is a fresh node by the time this runs — found by id rather than
  // held onto, then given a brief settle pop (same idea as is-settling on
  // top-level cards, toned down to suit a small list row).

  // Runs `fn` over `items` with at most `limit` in flight at once, instead of
  // firing every item's async work simultaneously.


  // ── Selection ──────────────────────────────────────────────────

  // `keepMarqueeConnections` is only passed true from the marquee gesture's
  // own onUp, right after it populates marqueeConnectionIds — every other
  // caller (clicking a card, creating one, Escape, etc.) means the user has
  // moved on, so any arrows still pending deletion from a previous marquee
  // are dropped here rather than lingering as a surprise on the next Delete.

  // ── Card events ────────────────────────────────────────────────


  // Every right-click/"···" menu in this plugin goes through here instead
  // of `new Menu()` directly, so the lift-on-hover styling below can be
  // scoped to menus we open (via this class on the menu's own DOM) without
  // silently changing the hover behavior of Obsidian's other menus
  // elsewhere in the app (file explorer, tab context menu, etc.). `.dom` on
  // Menu isn't part of the public API — if a future Obsidian version
  // removes it, this just falls back to plain unstyled native menus.


  // ── Resize handle ──────────────────────────────────────────────



  // ── Keyboard shortcuts ─────────────────────────────────────────


  // ── Activation ─────────────────────────────────────────────────




  // ── Add cards ──────────────────────────────────────────────────


  // Grid-snaps a coordinate when "Snap to grid" is on (rounds to the
  // configured grid size); otherwise falls back to the same fine 4px
  // rounding every position on the canvas has always had, just to avoid
  // subpixel drift from zoom/pan math — never fully "unsnapped".





  // A "blank card" — same underlying sticky card as Note, just defaulting
  // to a neutral color instead of the colorful sticky palette, matching
  // native Canvas's plain default card. Deliberately not a new card kind:
  // it gets every bit of sticky's rich-text editing, resizing, and
  // connection support for free, and can still be recolored afterward via
  // the same color picker as any other sticky.




  // ── Data views: calendar, table alt views ────────────────────────
  // These cards/views render the board's dated items (see dated-items.ts)
  // rather than owning content. Rescheduling from any of them writes the
  // date back into the source kanban item / table row.

  // Re-render a card's content in place. Card interactions (select/drag,
  // dblclick, contextmenu, resize) are delegated on the canvas container,
  // so they don't need rebinding after this rebuilds the card's DOM.
  rerenderCard(el: HTMLElement, card: SupportedCard): void {
    this.renderCardContent(el, card);
  }

  // After a reschedule, re-render the card whose data changed plus every
  // card that displays dated data, so all views agree immediately.

  // Calendar cards mirror data edited elsewhere on the board (due dates,
  // table cells) — refresh them whenever a save settles so they never show
  // stale dates. Tables are deliberately excluded: the user may be mid-edit
  // in a cell, and a re-render would eat the focus.




  // ── Calendar card ──





  // A style entry with every field cleared is indistinguishable from "never
  // set" — drop it so an empty {} doesn't linger in the saved file forever.

  // Decorates the day cell itself (icon/image/color/importance/nested
  // board) — independent of any note. "Add note" lives here too since
  // right-clicking empty day space is the same gesture either way.

  // Rich editing (icon/image/color/importance/nested board/delete) only
  // applies to this card's own notes — a kanban item or table row already
  // has its full context menu on its own card, so here they just get
  // reschedule and a jump-to-source shortcut.

  // ── Table database views ──
  // One TableCard, several presentations of the same rows. The switcher
  // writes card.view; everything below is just a different render of
  // card.rows — no data is copied anywhere.



  // A cell value rendered read-only in list/gallery/board views, styled by
  // its column's type. Checkboxes stay interactive — ticking a row is too
  // useful to gate behind switching back to table view.





  // Pointer drag between board-view lanes: dropping a row card on another
  // lane writes that lane's option into the row's select cell.









  // ── Image helpers ──────────────────────────────────────────────












  // ── Delete & duplicate ─────────────────────────────────────────



  // ── Undo / redo ────────────────────────────────────────────────

  // Snapshots include `archived` so archiving/restoring round-trips through
  // undo without duplicating cards (undo of an archive must remove the
  // archive copy at the same time it restores the canvas one).






  // ── Tool placement ─────────────────────────────────────────────




  // ── Toolbar ────────────────────────────────────────────────────


  // ── Trash drop zone ────────────────────────────────────────────
  // A quiet bottom-left target: drag any card, kanban item, column child,
  // or sketch over it and release to delete. Each custom drag loop calls
  // setTrashHover on move (for the highlight) and isOverTrash on drop —
  // there's no HTML5 DnD here, so the zone can't listen for drops itself.








  // ── Accent colour popover (checklist) ─────────────────────────


  // ── Zoom pill ──────────────────────────────────────────────────


  // ── Minimap ──────────────────────────────────────────────────────
  // Collapsed to a small floating circle by default (open/closed state is
  // UI-only, not saved) — expands into a small overview panel with a
  // click/drag-to-jump body and a "zoom to fit" button. Card positions
  // redraw whenever scheduleSave() runs (i.e. after any board edit) and
  // the viewport frame redraws on every pan/zoom via applyViewport(), both
  // gated on minimapOpen so a collapsed minimap costs nothing.






  // ── Board search ─────────────────────────────────────────────────
  // Small collapsed magnifier button in the top-right of the canvas;
  // expands into an input + match counter + prev/next. Matching cards get
  // an accent outline, everything else dims; Enter / arrows cycle through
  // matches, centering the viewport on each.


  // Every human-readable string a card carries, lowercased for matching.








  // ── Board filter (by tag / label) ────────────────────────────────
  // Trello-style: pick tag/label chips from a popover; cards carrying any
  // selected key stay lit, everything else dims. OR semantics, like Trello.

  // Every 'tag:x' / 'label:y' key a card carries, including kanban items
  // across all columns and recursively through Column containers.




  // ── Archive ──────────────────────────────────────────────────────



  // ── Quick add ("/" palette) ──────────────────────────────────────


  // ── Alignment bar ──────────────────────────────────────────────


  // ── Connection layer ───────────────────────────────────────────




  // Quadratic-Bezier midpoint smoothing: each raw point becomes a curve
  // control point, and the path passes through the midpoint of every
  // consecutive pair — turns the raw polyline (straight segments between
  // sampled pointer positions) into a smooth, vector-looking stroke without
  // needing a full spline fit. The final segment curves through the actual
  // last two points so the stroke still ends exactly where the pointer was
  // released, rather than stopping one midpoint short of it.

  // True for strokes laid down by the highlighter instrument — they render
  // as a filled marker body (see buildHighlightOutlineD) instead of a
  // stroked centerline.

  // Path data for a stroke's visible ink, whichever instrument drew it.
  // The invisible hit path and the selection halo always use the plain
  // centerline (buildInkPathD) — they're stroked, not filled.

  // Classic marker look: instead of stroking the centerline with round caps
  // (which reads as a fat glossy line), trace a closed outline around it —
  // offset each point perpendicular by half the width with a small
  // deterministic wobble per point and per side, then fill the polygon.
  // That gives flat chisel ends for free (the outline just turns the corner
  // at the first/last points) and slightly irregular "hand-pressed" edges.
  // The wobble is seeded from the stroke id so re-renders (recolor, drag,
  // reload) redraw the exact same rough edge instead of shimmering.




  // Rebuilds the selection halo (one translucent, thicker path per stroke,
  // across every selected group) and — only when exactly one group is
  // selected — the dashed bounding box + resize handles, without touching
  // selectedDrawingIds — called both when the selection changes and
  // continuously while a group is being dragged or resized.


  // Padded by each stroke's own half-width so the box hugs the visible ink,
  // not just the center-line points.



  // Scales every point (and each stroke's width) of the group around the
  // corner opposite the one being dragged, which stays fixed — same mental
  // model as resizing any other card, just applied to a set of freehand
  // paths instead of a box.




  // Freehand capture: pointerdown starts a stroke, pointermove appends
  // points (as a live preview path so it feels immediate), pointerup
  // commits the finished stroke — discarded if it never moved (a stray
  // click while in pen mode shouldn't leave a dot behind). Every stroke
  // committed during the current pen session shares currentPenGroupId, so
  // several separate strokes end up as one draggable/selectable sketch.

  // If a freehand stroke is already nearly straight, snap it to a clean
  // two-point line on release — the "I meant to draw a line" case. A stroke
  // only qualifies when every point sits close to the start→end chord,
  // relative to the chord's length, so deliberate curves, hooks, and
  // scribbles are never touched.

  // Eraser scrub: while the pointer is down, any stroke whose ink passes
  // within the eraser's radius of the pointer is removed — whole strokes at
  // a time (this is "scrub out that line", not pixel erasing). One undo
  // entry covers the entire scrub gesture no matter how many strokes it
  // takes out.




  // A fixed, always-visible banner while drawing — the toolbar's pen color
  // picker lives wherever the toolbar itself is docked (left/right/top/
  // bottom), which isn't a reliable place to notice "how do I stop
  // drawing". This sits at the top of the canvas regardless of toolbar
  // position and gives a direct "Done" button in addition to Esc.








  // Resolves one end of a connection to an anchor rect — the card's rect if
  // that end is card-anchored, or a zero-size rect at the free point
  // otherwise (rectExitPoint on a w=0/h=0 rect collapses to the point
  // itself, so straight/elbow anchoring "just works" for free ends too).





  // ── Connect mode ───────────────────────────────────────────────













  // Drops a free-floating arrow: drag from one empty-canvas point to
  // another while the Line tool is armed. Both ends are canvas-space points
  // rather than card ids, so afterward it's selected with draggable
  // endpoint handles (see showConnectionEndpointHandles) plus the usual
  // bend handle, letting either end be repositioned anywhere.

  // A ready-made straight arrow (fixed length, horizontal) centered on
  // (cx, cy) — used for both a plain click on the Line tool (no drag) and
  // dragging the Line button straight from the toolbar onto the canvas, so
  // either gesture drops something usable immediately rather than requiring
  // the user to draw the line out by hand. Selected right away so its
  // endpoint/bend handles are available to reshape it afterward.


  // ── Connection selection & properties ─────────────────────────



  // Draggable handles at each free (non-card) end of a connection, so an
  // arrow dropped straight onto the canvas — or the free end of a
  // card-anchored one — can be repositioned to point anywhere. A
  // card-anchored end has no handle: it already follows its card.


  // Draggable handle at a straight-routed connection's curve-through-point
  // (the midpoint when unbent). Dragging it perpendicular to the line sets
  // conn.bend; double-clicking it resets to a plain straight line.






  // ── Save ───────────────────────────────────────────────────────


}

Object.assign(FreeformRenderer.prototype, canvasMethods, cardsBasicMethods, cardsTableMethods, cardsKanbanMethods, cardsColumnMethods, cardsMediaMethods, cardsCalendarMethods, cardsCheckersMethods, overlaysMethods, persistenceMethods, clipboardMethods);
