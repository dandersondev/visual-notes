import {
  TFile, TFolder, Notice, setIcon,
} from 'obsidian';
// Pressure-aware tapered stroke outlines for the Pen tool.
// perfect-freehand by Steve Ruiz, MIT license:
// https://github.com/steveruizok/perfect-freehand
import { getStroke } from 'perfect-freehand';
import { EASING_FNS, PenOptionsPanel } from './pen-options-panel';
import {
  TileCard, TileTarget, NoteLinkCard,
  ImageCard, AudioCard, VideoCard,
  KanbanItem, Card, Connection, ColumnCard, ColumnChildCard,
  FileCard,
  DrawingStroke, TILE_DRAG_MIME, DraggedTilePayload,
} from './file-types';
import {
  straightAnchors, elbowAnchors, buildStraightPath, buildElbowPath, resolveOrientation, rectExitPoint,
  buildCurvedPath, curveThroughPoint, perpendicularOffset, curveControlPoint, arrowheadPoints,
  buildTrimmedStraightPath, buildTrimmedCurvedPath, buildTrimmedElbowPath,
  anchorPoint, pinPositions,
  type Point, type Anchor,
} from './canvas/geometry';
import {
  parseYouTubeId,
  isGoogleMapsUrl,
} from './thumbnail-utils';
import { TileModal } from './tile-modal';
import { toggleYouTubePlayback } from './freeform-view-cards-media';
import { snap } from './canvas/snap';
import {
  applyWheelZoom, applyPinchZoom,
  screenToCanvas, clampZoom,
} from './canvas/pan-zoom';
import { sortAssetFile, saveNewAsset } from './asset-manager';
import { isVisualNotesOwnedFile } from './file-io';
import {
  TILE_DEFAULT_W, TILE_DEFAULT_H, STICKY_DEFAULT_W, STICKY_DEFAULT_H,
  CHECKLIST_DEFAULT_W, CHECKLIST_DEFAULT_H,
  COMMENT_DEFAULT_W, COMMENT_DEFAULT_H, TABLE_DEFAULT_W, TABLE_DEFAULT_H,
  NOTELINK_DEFAULT_W, NOTELINK_DEFAULT_H,
  IMAGE_DEFAULT_W, IMAGE_DEFAULT_H,
  BOOKMARK_DEFAULT_W, BOOKMARK_DEFAULT_H, AUDIO_DEFAULT_W, AUDIO_DEFAULT_H, VIDEO_DEFAULT_W, VIDEO_DEFAULT_H,
  MAP_DEFAULT_W, MAP_DEFAULT_H, SWATCH_DEFAULT_W, SWATCH_DEFAULT_H,
  FILE_DEFAULT_W, FILE_DEFAULT_H,
  CALLOUT_DEFAULT_W, CALLOUT_DEFAULT_H, GROUP_DEFAULT_W, GROUP_DEFAULT_H,
  AUDIO_EXTS, VIDEO_EXTS,
  KANBAN_DEFAULT_W, KANBAN_DEFAULT_H, COLUMN_DEFAULT_W, COLUMN_DEFAULT_H,
  CALENDAR_DEFAULT_W, CALENDAR_DEFAULT_H,
  CHECKERS_DEFAULT_W, CHECKERS_DEFAULT_H,
  STORYBOARD_DEFAULT_W, STORYBOARD_DEFAULT_H,
  DRAG_THRESHOLD, IMAGE_EXTS, CONN_COLOR_PRESETS,
  isTypingElement, ARROW_NUDGE, NUDGE_FINE, NUDGE_COARSE, isInEdgeSwipeZone, NATIVE_DROP_GRACE_MS,
  isColumnChildKind,
  AppWithPrivateAPIs, DragManager, SupportedCard, cardMinSize,
  isValidURL, openExternalUrl,
  KanbanItemColorModal,
} from './freeform-view-shared';
import { TEXT_CARD_MIN_FONT, TEXT_CARD_MAX_FONT, TEXT_CARD_DEFAULT_FONT } from './file-types';
import { isClippedPage, clipMetaFromFrontmatter } from './web-clip-import';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    disposeCardResources(id: string): void;
    bindCanvasEvents(): void;
    isPanButton(button: number): boolean;
    dropVaultDraggableAt(draggable: DragManager['draggable'], clientX: number, clientY: number): Promise<boolean>;
    startPan(e: PointerEvent): void;
    cancelLongPress(): void;
    maybeStartTouchPan(e: PointerEvent): void;
    startTouchPan(e: PointerEvent): void;
    startMarquee(e: PointerEvent): void;
    clearMarqueeConnections(): void;
    refreshSelectionVisuals(keepMarqueeConnections?: boolean): void;
    bindDelegatedCardEvents(): void;
    appendResizeHandles(el: HTMLElement): void;
    startCardResize(e: PointerEvent, handle: HTMLElement, el: HTMLElement, card: SupportedCard): void;
    onKeyDown(e: KeyboardEvent): void;
    activateTile(tile: TileCard): Promise<void>;
    activateNoteLink(card: NoteLinkCard): Promise<void>;
    nextZ(): number;
    applySnap(val: number): number;
    toggleSnapToGrid(): void;
    centerPos(w: number, h: number): { x: number; y: number };
    alignCards(mode: 'left' | 'center-h' | 'right' | 'top' | 'middle-v' | 'bottom' | 'distribute-h' | 'distribute-v'): void;
    deleteSelected(): void;
    duplicateSelected(): void;
    activateTool(name: string, btn: HTMLElement): void;
    clearPendingTool(): void;
    placePendingTool(cx: number, cy: number): void;
    isOverTrash(clientX: number, clientY: number): boolean;
    setTrashHover(clientX: number, clientY: number): void;
    clearTrashHover(): void;
    centerOnCard(id: string): void;
    initConnectionLayer(): void;
    initInkLayer(): void;
    renderAllDrawings(): void;
    buildInkPathD(points: { x: number; y: number }[]): string;
    isHighlightStroke(stroke: DrawingStroke): boolean;
    buildStrokePathD(stroke: DrawingStroke): string;
    buildPenOutlineD(stroke: DrawingStroke): string;
    buildHighlightOutlineD(stroke: DrawingStroke): string;
    renderSingleDrawing(stroke: DrawingStroke): void;
    groupStrokes(groupId: string): DrawingStroke[];
    selectDrawing(groupId: string, additive?: boolean): void;
    refreshDrawingSelectionVisual(): void;
    deselectDrawing(): void;
    computeGroupBBox(groupId: string): { minX: number; minY: number; maxX: number; maxY: number } | null;
    isNearGroup(groupId: string, point: { x: number; y: number }, threshold: number): boolean;
    renderDrawingBox(groupId: string, bbox: { minX: number; minY: number; maxX: number; maxY: number }): void;
    removeDrawingBox(): void;
    startDrawingResize(e: PointerEvent, groupId: string, corner: 'nw' | 'ne' | 'sw' | 'se'): void;
    deleteSelectedDrawing(): void;
    rerenderGroup(groupId: string): void;
    showDrawingMenu(e: MouseEvent, groupIds: string[]): void;
    startInkStroke(startEvent: PointerEvent): void;
    startEraseScrub(startEvent: PointerEvent): void;
    togglePenMode(): void;
    enterPenMode(): void;
    exitPenMode(): void;
    showPenBanner(): void;
    hidePenBanner(): void;
    showPenColorPicker(): void;
    positionPenPicker(): void;
    hidePenColorPicker(): void;
    togglePenOptionsPanel(anchor: HTMLElement): void;
    refreshAllConnections(): void;
    renderSingleConnection(conn: Connection): void;
    removeSingleConnection(id: string): void;
    visibleCanvasBounds(): { x: number; y: number; w: number; h: number };
    isConnectionVisible(conn: Connection, view: { x: number; y: number; w: number; h: number }): boolean;
    scheduleCullingRefresh(): void;
    refreshConnectionCulling(): void;
    buildConnectionPath(conn: Connection): string | null;
    resolveConnectionAnchors(conn: Connection): {
        src: Point; tgt: Point; srcApproach: Point; tgtApproach: Point;
        ori?: 'horizontal-first' | 'vertical-first';
      } | null;
    buildVisibleConnectionPath(conn: Connection): string | null;
    getCardRect(cardId: string): { x: number; y: number; w: number; h: number } | null;
    getConnEndpointRect(
        cardId: string | undefined, point: { x: number; y: number } | undefined,
      ): { x: number; y: number; w: number; h: number } | null;
    connectionLabelPos(conn: Connection): { x: number; y: number } | null;
    renderConnectionLabel(conn: Connection): void;
    updateConnectionsForCard(cardId: string): void;
    computeArrowheadPolygons(conn: Connection): { end?: [Point, Point, Point]; start?: [Point, Point, Point] } | null;
    enterConnectMode(): void;
    exitConnectMode(): void;
    toggleConnectMode(): void;
    addConnectionHandles(el: HTMLElement, card: SupportedCard): void;
    refreshConnectionHandles(el: HTMLElement, card: SupportedCard): void;
    anchorAtPoint(clientX: number, clientY: number): { cardId: string; anchor: Anchor } | null;
    pinElementAt(clientX: number, clientY: number): HTMLElement | null;
    startHandleDrag(
        e: PointerEvent, handleEl: HTMLElement,
        card: SupportedCard, anchor: Anchor
      ): void;
    getEdgeMidpoint(card: Card, side: 'n' | 's' | 'e' | 'w'): { x: number; y: number };
    updateGhostPath(sx: number, sy: number, tx: number, ty: number): void;
    removeGhostPath(): void;
    startConnectSourceGhost(sourceId: string): void;
    stopConnectSourceGhost(): void;
    cardIdAtPoint(clientX: number, clientY: number): string | null;
    finishConnection(fromId: string, toId: string, fromAnchor?: Anchor, toAnchor?: Anchor): void;
    startFreeLineDrag(startEvent: PointerEvent): void;
    addDefaultArrowAt(cx: number, cy: number): void;
    resolveDefaultConnectionColor(): string;
    selectConnection(id: string): void;
    deselectConnection(): void;
    showConnectionEndpointHandles(conn: Connection): void;
    addEndpointAnchorHandle(conn: Connection, end: 'from' | 'to'): void;
    hideConnectionEndpointHandles(): void;
    showConnectionBendHandle(conn: Connection): void;
    rerenderConnection(conn: Connection): void;
    deleteSelectedConnection(): void;
    showConnectionProps(conn: Connection): void;
    hideConnectionProps(): void;
  }
}

// Shared between computeArrowheadPolygons (draws the arrowhead at this
// length) and buildVisibleConnectionPath (shortens the line by this same
// length so its stroke never runs into the arrowhead's tapering tip) —
// kept in sync in one place rather than duplicating the formula.
function arrowMarkerLength(thickness: number): number {
  return 10 + thickness * 2;
}

// A connection's two pinned anchors, or null for an end that should keep the
// original free-sliding behavior. An anchor is only meaningful on a
// card-anchored end — on a free-point end there's no edge to sit on, and the
// endpoint drag handle would fight a stale pin — so one left behind by a
// re-anchor is ignored rather than trusted.
// Which edge (if any) the pointer is close enough to for that edge's full
// row of connection pins to be worth revealing. Returns null while the
// pointer is out in the card's middle, which is what keeps a plain hover
// down to the four midpoint pins instead of all 28. The band scales with
// the card so it stays a band rather than swallowing a small card whole —
// and is measured in screen px, so it feels the same at any zoom.
function nearestPinEdge(rect: DOMRect, clientX: number, clientY: number): 'n' | 'e' | 's' | 'w' | null {
  const dN = clientY - rect.top, dS = rect.bottom - clientY;
  const dW = clientX - rect.left, dE = rect.right - clientX;
  const closest = Math.min(dN, dS, dW, dE);
  if (closest > Math.min(24, rect.width / 5, rect.height / 5)) return null;
  if (closest === dN) return 'n';
  if (closest === dS) return 's';
  if (closest === dW) return 'w';
  return 'e';
}

function connAnchors(conn: Connection): [Anchor | null, Anchor | null] {
  return [
    conn.fromCardId ? conn.fromAnchor ?? null : null,
    conn.toCardId ? conn.toAnchor ?? null : null,
  ];
}

export const canvasMethods = {
  disposeCardResources(this: FreeformRenderer, id: string): void {
    this.tableGridResizeObs.get(id)?.disconnect();
    this.tableGridResizeObs.delete(id);
    this.textCardResizeObs.get(id)?.disconnect();
    this.textCardResizeObs.delete(id);
  },

  bindCanvasEvents(this: FreeformRenderer): void {
    // Right-click never blurs a focused input/contenteditable (unlike
    // left-click), so opening a context menu while still editing a card's
    // inline text leaves that editor focused underneath the menu. If the
    // chosen menu item then deletes the card/item, removing its element
    // from the DOM force-blurs the still-focused editor, which reentrantly
    // runs its blur-commit handler mid-deletion — against a card already
    // spliced out of the board. That reentrant commit (undo push, markdown
    // re-render, etc.) can throw, and Obsidian's Menu only calls hide()
    // *after* the clicked item's callback returns, so a throw there leaves
    // the menu stuck open. Capture-phase so this runs before any bubble-
    // phase per-card/per-item contextmenu handler builds its menu —
    // committing the edit here, while the card is still fully valid, is
    // the same thing a normal left-click-away would have done.
    this.container.addEventListener('contextmenu', (e) => {
      // A right-click drag configured as the pan gesture (see startPan)
      // still ends in a native contextmenu event on release — swallow that
      // one so panning right doesn't also drop a menu on the card/canvas
      // underneath the cursor. A right-click with no drag is unaffected.
      if (this.suppressNextContextMenu) {
        this.suppressNextContextMenu = false;
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
      (activeDocument.activeElement as HTMLElement | null)?.blur();
    }, { capture: true });

    // Passive position tracking so "/" quick-add can drop the new card
    // under the cursor rather than always at the viewport center.
    this.outer.addEventListener('pointermove', (e) => {
      this.lastPointerClient = { x: e.clientX, y: e.clientY };
    }, { passive: true });

    this.outer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.outer.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        this.vp = applyWheelZoom(e, this.vp, rect);
      } else {
        this.vp = { ...this.vp, x: this.vp.x - e.deltaX, y: this.vp.y - e.deltaY };
      }
      this.applyViewport(); this.scheduleSave();
    }, { passive: false });

    this.outer.addEventListener('touchstart', (e) => {
      this.activeTouches = e.touches.length;
      // A second finger landing mid-drag means what looked like a one-
      // finger marquee gesture just became a pinch — abort the marquee so
      // it doesn't stick around fighting with the pinch-zoom transform.
      if (this.activeTouches >= 2) {
        this.cancelActiveMarquee?.(); this.cancelActiveTouchPan?.();
        this.cancelActiveCardDrag?.(); this.cancelLongPress();
      }
    }, { passive: true });

    // On-screen-keyboard tracking: when iOS's keyboard opens it shrinks
    // visualViewport but NOT the layout viewport, so bottom-anchored UI
    // (the phone context bar with its Edit/format buttons — exactly what
    // you need mid-edit) ends up hidden underneath it. Publish the
    // keyboard's height as a custom property; the phone-width CSS
    // translates the bottom bar up by it. ~0 whenever no keyboard is up,
    // so this is inert on desktop.
    {
      const vv = window.visualViewport;
      if (vv) {
        const onVVChange = () => {
          const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
          this.container.setCssProps({ '--visual-notes-kb-offset': `${Math.round(kb)}px` });
        };
        vv.addEventListener('resize', onVVChange);
        vv.addEventListener('scroll', onVVChange);
        this.register(() => {
          vv.removeEventListener('resize', onVVChange);
          vv.removeEventListener('scroll', onVVChange);
        });
        onVVChange();
      }
    }

    // Manual long-press-to-contextmenu (see the field comments above for
    // why the native gesture doesn't fire here). Capture phase so this runs
    // before any card/item's own bubble-phase pointerdown handler — meaning
    // it starts the timer regardless of what that handler does afterward
    // (preventDefault, stopPropagation, starting its own drag).
    this.outer.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.button !== 0) return;
      if (this.penModeActive || this.connectMode) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"], button, a, .visual-notes-card-resize-handle, .visual-notes-connection-handle')) return;
      this.cancelLongPress();
      this.longPressPointerId = e.pointerId;
      this.longPressStartX = e.clientX; this.longPressStartY = e.clientY;
      this.longPressTarget = target;
      target.addClass('visual-notes-longpress-active');
      const clientX = e.clientX, clientY = e.clientY;
      this.longPressTimer = window.setTimeout(() => {
        this.longPressTimer = null;
        target.removeClass('visual-notes-longpress-active');
        this.longPressTarget = null;
        if (!target.isConnected) return;
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX, clientY, view: window,
        }));
      }, 500);
    }, { capture: true });
    this.outer.addEventListener('pointermove', (e) => {
      if (this.longPressPointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - this.longPressStartX, e.clientY - this.longPressStartY) > DRAG_THRESHOLD) this.cancelLongPress();
    }, { capture: true });
    this.outer.addEventListener('pointerup', (e) => {
      if (this.longPressPointerId === e.pointerId) this.cancelLongPress();
    }, { capture: true });
    this.outer.addEventListener('pointercancel', (e) => {
      if (this.longPressPointerId === e.pointerId) this.cancelLongPress();
    }, { capture: true });
    this.outer.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const rect = this.outer.getBoundingClientRect();
        const t1 = e.touches[0]; const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const midX = ((t1.clientX + t2.clientX) / 2) - rect.left;
        const midY = ((t1.clientY + t2.clientY) / 2) - rect.top;
        if (this.pinchDist !== null) {
          const factor = dist / this.pinchDist;
          this.vp = applyPinchZoom(midX, midY, clampZoom(this.vp.zoom * factor), this.vp);
          this.vp.x += midX - this.pinchMidX; this.vp.y += midY - this.pinchMidY;
          this.applyViewport();
        }
        this.pinchDist = dist; this.pinchMidX = midX; this.pinchMidY = midY;
      }
    }, { passive: false });

    this.outer.addEventListener('touchend', (e) => { this.activeTouches = e.touches.length; this.pinchDist = null; this.scheduleSave(); });
    this.outer.addEventListener('touchcancel', (e) => { this.activeTouches = e.touches.length; this.pinchDist = null; });

    this.docKeyDown = (e: KeyboardEvent) => {
      // A Storyboard editor is a modal sub-workspace, not part of the board
      // beneath it. In particular, Escape belongs to the modal; letting the
      // board's document-wide pen exit see it first swallowed the close key.
      const keyTarget = e.target as Node | null;
      if (keyTarget?.instanceOf(Element) && keyTarget.closest('.visual-notes-storyboard-modal')) return;
      // Pen-mode exit must work document-wide, not just while the canvas
      // itself has focus — clicking any pen-picker control (color swatch,
      // width, instrument) moves focus onto that control, and the outer
      // element's own keydown handler then never hears the Enter/Escape.
      if (this.penModeActive && (e.key === 'Escape' || e.key === 'Enter')) {
        e.preventDefault(); this.exitPenMode(); return;
      }
      // The board's other shortcuts (undo/redo, delete, select-all,
      // duplicate, group, Escape-to-clear-selection…) live in onKeyDown,
      // which used to be wired as a keydown listener on `.outer` alone —
      // that silently broke the moment focus left the canvas element
      // itself, e.g. after clicking any toolbar or pen-picker button
      // (both live outside `.outer`, as siblings under `.container`):
      // reported as undo/redo doing nothing until you clicked back into
      // empty canvas space to refocus it. Routing through here instead,
      // gated on focus being anywhere within this board specifically (not
      // just the canvas, but not some *other* board/pane sharing the same
      // document either), fixes that for all of them at once. e.target
      // (what the key event actually fired on) rather than
      // activeDocument.activeElement — the two always agree for a real
      // keypress, but target is what's actually available here.
      const withinBoard = e.target instanceof Node && this.container.contains(e.target);
      if (withinBoard) this.onKeyDown(e);

      // The shortcuts below used to carry their own, much stricter gate:
      // `activeDocument.activeElement === this.outer`, i.e. the canvas
      // element itself had to hold focus. That is the very bug the comment
      // above describes, left unfixed on these four — they died the moment
      // focus moved anywhere else and came back when you clicked empty
      // canvas, which is how it was reported: "space bar and arrow keys
      // stop working randomly, and start working the same way".
      //
      // Clicking a card, a toolbar button or (with native controls) a video
      // all move focus off `.outer`, so in practice these worked only until
      // you touched anything. The gate that was actually wanted is the one
      // onKeyDown uses: somewhere inside this board, and not typing.
      if (!withinBoard || isTypingElement(activeDocument.activeElement)) return;

      if (e.code === 'Space') {
        e.preventDefault(); this.spaceDown = true;
        if (!this.isPanning) this.setCursor('grab');
      }
      // Ctrl/Cmd+F opens board search — Obsidian has no in-view search for
      // this custom view type, so this doesn't shadow anything.
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        this.openSearch();
      }
      // "/" opens the quick-add palette (Notion-style slash command).
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.openQuickAdd();
      }
      // "T" arms the text tool, then the next click on the canvas places it —
      // the same two-step every toolbar button uses, rather than dropping a
      // card at a guessed position.
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (this.textToolBtn) this.activateTool('text', this.textToolBtn);
      }
      // "V" selects, "H" pans — the standard canvas pair, and the reason
      // they were asked for: panning otherwise needs a middle or right
      // button, which a trackpad or tablet may not comfortably offer.
      if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); this.setInteractionMode('select');
      }
      if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); this.setInteractionMode('hand');
      }
    };
    this.docKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        // Releasing space returns to whatever the mode says, which is still
        // a grab cursor in hand mode rather than the default arrow.
        if (!this.isPanning) this.setCursor(this.interactionMode === 'hand' ? 'grab' : '');
      }
    };
    activeDocument.addEventListener('keydown', this.docKeyDown);
    activeDocument.addEventListener('keyup', this.docKeyUp);

    // Capture-phase listeners: intercept middle-click / right-click / space-drag
    // over any child element before its stopPropagation can block panning.
    // The mousedown guard prevents Chrome autoscroll on scrollable/image targets.
    this.outer.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    }, { capture: true });
    this.outer.addEventListener('pointerdown', (e) => {
      // Hand mode joins the pan button and space-drag here, in the capture
      // phase, so a left-drag pans even when it starts on top of a card —
      // the card's own delegated handler never sees it.
      if (this.isPanButton(e.button) || (e.button === 0 && (this.spaceDown || this.interactionMode === 'hand'))) {
        e.preventDefault(); e.stopPropagation(); this.startPan(e);
      }
    }, { capture: true });

    this.outer.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      const isBackground = target === this.outer || target === this.inner;
      if (!isBackground) return;
      this.closeFab();
      if (this.penModeActive) {
        if (e.button !== 0) return;
        e.preventDefault();
        this.startInkStroke(e);
        return;
      }
      if (this.connectMode) {
        if (this.connectSourceId) {
          this.cardEls.get(this.connectSourceId)?.removeClass('is-connect-source');
          this.connectSourceId = null;
          this.stopConnectSourceGhost();
          return;
        }
        // No card selected as a source yet — drag on open canvas drops a
        // free-floating line instead of connecting two cards.
        if (e.button !== 0) return;
        e.preventDefault();
        this.startFreeLineDrag(e);
        return;
      }
      if (this.selectedConnectionId) this.deselectConnection();
      // Shift-clicking empty canvas to start a marquee keeps any existing
      // drawing selection so the marquee can add more strokes to it —
      // matches the shift-aware card selection just below.
      if (!e.shiftKey && this.selectedDrawingIds.size > 0) this.deselectDrawing();
      if (this.isPanButton(e.button) || (e.button === 0 && this.spaceDown)) {
        e.preventDefault(); this.startPan(e);
      } else if (e.button === 0 && this.pendingTool) {
        e.preventDefault();
        const rect = this.outer.getBoundingClientRect();
        const cp = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, this.vp);
        this.placePendingTool(cp.x, cp.y);
      } else if (e.button === 0) {
        this.closeOverflow();
        if (!e.shiftKey) { this.selection.clear(); this.refreshSelectionVisuals(); }
        // One finger pans the canvas (two-finger pinch still zooms — see
        // the touchmove handler above); a mouse drag on empty canvas still
        // rubber-band selects, since a mouse has no competing pinch gesture.
        //
        // A touch starting at a screen edge is left alone: that is Obsidian's
        // gesture for opening a sidebar, and panning from there took it every
        // time — reported on iPad as "swipe from left to right to open the
        // sidebar, nothing happens, the canvas just moves right". Declining
        // the gesture is the only reliable way to yield it; there is nothing
        // to cancel afterwards, because by the time a pan is recognisable the
        // swipe has already been lost.
        if (e.pointerType === 'touch') {
          if (isInEdgeSwipeZone(e.clientX, activeWindow.innerWidth)) return;
          this.maybeStartTouchPan(e);
        } else this.startMarquee(e);
      }
    });

    // Canvas right-click
    this.outer.addEventListener('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      if (target !== this.outer && target !== this.inner) return;
      e.preventDefault();
      const rect = this.outer.getBoundingClientRect();
      const cp = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, this.vp);
      const menu = this.newMenu();

      // Grouped with non-clickable label headers (Obsidian's Menu has no
      // public submenu API — see the swatch palette-grid menu for the same
      // pattern) rather than one 14-item flat list.
      menu.addItem(i => i.setTitle('Write').setIsLabel(true));
      menu.addItem(i => i.setTitle('Sticky note').setIcon('sticky-note').onClick(() =>
        this.addStickyAt(this.applySnap(cp.x - STICKY_DEFAULT_W / 2), this.applySnap(cp.y - STICKY_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('To-do list').setIcon('check-square').onClick(() =>
        this.addChecklistAt(this.applySnap(cp.x - CHECKLIST_DEFAULT_W / 2), this.applySnap(cp.y - CHECKLIST_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Comment').setIcon('message-square').onClick(() =>
        this.addCommentAt(this.applySnap(cp.x - COMMENT_DEFAULT_W / 2), this.applySnap(cp.y - COMMENT_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Callout').setIcon('megaphone').onClick(() =>
        this.addCalloutAt(this.applySnap(cp.x - CALLOUT_DEFAULT_W / 2), this.applySnap(cp.y - CALLOUT_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Table').setIcon('table').onClick(() =>
        this.addTableAt(this.applySnap(cp.x - TABLE_DEFAULT_W / 2), this.applySnap(cp.y - TABLE_DEFAULT_H / 2))));

      menu.addSeparator();
      menu.addItem(i => i.setTitle('Media & links').setIsLabel(true));
      menu.addItem(i => i.setTitle('Image').setIcon('image').onClick(() =>
        this.addImageAt(this.applySnap(cp.x - IMAGE_DEFAULT_W / 2), this.applySnap(cp.y - IMAGE_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Audio').setIcon('music').onClick(() =>
        this.addAudioAt(this.applySnap(cp.x - AUDIO_DEFAULT_W / 2), this.applySnap(cp.y - AUDIO_DEFAULT_H / 2))));
      // Missing from this menu until 1.1.31, though present in the toolbar
      // overflow and the "/" palette since video cards arrived in 1.1.27.
      // It matters most on a tablet: long-press is the way things get added
      // there, and dragging a video in from the file explorer is not something
      // Obsidian offers on touch, so this menu was the only route and it did
      // not have one.
      menu.addItem(i => i.setTitle('Video').setIcon('file-video').onClick(() =>
        this.addVideoAt(this.applySnap(cp.x - VIDEO_DEFAULT_W / 2), this.applySnap(cp.y - VIDEO_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('File').setIcon('paperclip').onClick(() =>
        this.addFileAt(this.applySnap(cp.x - FILE_DEFAULT_W / 2), this.applySnap(cp.y - FILE_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Bookmark').setIcon('bookmark').onClick(() =>
        this.addBookmarkAt(this.applySnap(cp.x - BOOKMARK_DEFAULT_W / 2), this.applySnap(cp.y - BOOKMARK_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Map').setIcon('map-pin').onClick(() =>
        this.addMapAt(this.applySnap(cp.x - MAP_DEFAULT_W / 2), this.applySnap(cp.y - MAP_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Note link').setIcon('file-text').onClick(() =>
        this.addNoteLinkAt(this.applySnap(cp.x - NOTELINK_DEFAULT_W / 2), this.applySnap(cp.y - NOTELINK_DEFAULT_H / 2))));

      menu.addSeparator();
      menu.addItem(i => i.setTitle('Organize').setIsLabel(true));
      menu.addItem(i => i.setTitle('Tile').setIcon('layout-grid').onClick(() =>
        this.addTileAt(this.applySnap(cp.x - TILE_DEFAULT_W / 2), this.applySnap(cp.y - TILE_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Kanban board').setIcon('columns-3').onClick(() =>
        this.addKanbanBoardAt(this.applySnap(cp.x - (KANBAN_DEFAULT_W * 2 + 12) / 2), this.applySnap(cp.y - KANBAN_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Column').setIcon('rows-3').onClick(() =>
        this.addColumnCardAt(this.applySnap(cp.x - COLUMN_DEFAULT_W / 2), this.applySnap(cp.y - COLUMN_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Storyboard').setIcon('clapperboard').onClick(() =>
        this.addStoryboardCardAt(this.applySnap(cp.x - STORYBOARD_DEFAULT_W / 2), this.applySnap(cp.y - STORYBOARD_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Group frame').setIcon('frame').onClick(() =>
        this.addGroupAt(this.applySnap(cp.x - GROUP_DEFAULT_W / 2), this.applySnap(cp.y - GROUP_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Swatch').setIcon('pipette').onClick(() =>
        this.addSwatchAt(this.applySnap(cp.x - SWATCH_DEFAULT_W / 2), this.applySnap(cp.y - SWATCH_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Checkers').setIcon('crown').onClick(() =>
        this.addCheckersAt(this.applySnap(cp.x - CHECKERS_DEFAULT_W / 2), this.applySnap(cp.y - CHECKERS_DEFAULT_H / 2))));
      menu.addItem(i => i.setTitle('Calendar').setIcon('calendar-days').onClick(() =>
        this.addCalendarAt(this.applySnap(cp.x - CALENDAR_DEFAULT_W / 2), this.applySnap(cp.y - CALENDAR_DEFAULT_H / 2))));

      menu.addSeparator();
      // Opens a second menu listing the user's saved card-group templates
      // — Menu has no submenu API, so this is a manual two-level flow.
      menu.addItem(i => i.setTitle('Templates').setIcon('layout-template').onClick(() =>
        this.showGroupTemplateMenu(e, cp.x, cp.y)));
      if (this.hasClipboardBundle()) {
        menu.addItem(i => i.setTitle('Paste').setIcon('clipboard-paste').onClick(() =>
          this.pasteFromClipboard(cp.x, cp.y)));
      }

      menu.addSeparator();
      menu.addItem(i => i.setTitle('Archived cards…').setIcon('archive').onClick(() => this.openArchiveBrowser()));
      menu.addItem(i => i.setTitle('Reset view').setIcon('maximize').onClick(() => {
        this.vp = { x: 0, y: 0, zoom: 1 }; this.applyViewport(); this.scheduleSave();
      }));
      menu.addItem(i => i.setTitle('Export as PNG…').setIcon('image-down').onClick(() => void this.exportBoard('png')));
      menu.addItem(i => i.setTitle('Export as PDF…').setIcon('file-down').onClick(() => void this.exportBoard('pdf')));
      // Offered only when there is a selection, because the whole-board items
      // above already cover the empty case and a disabled entry explains less
      // than an absent one.
      const selectedIds = this.selection.getIds();
      if (selectedIds.length > 0) {
        menu.addItem(i => i
          .setTitle(`Export ${selectedIds.length} selected as PNG…`)
          .setIcon('image-down')
          .onClick(() => void this.exportBoard('png', new Set(selectedIds))));
      }
      menu.showAtMouseEvent(e);
    });

    // Clipboard paste
    this.outer.addEventListener('paste', (e) => { void (async () => {
      const active = activeDocument.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        || (active instanceof HTMLElement && active.getAttribute('contenteditable'))) return;
      e.preventDefault();
      const data = e.clipboardData; if (!data) return;
      // Cards copied from a Visual Notes board (this one or another
      // window's) — checked first so our own marker JSON is never mistaken
      // for a plain text paste and turned into a sticky note.
      const raw = data.getData('text/plain').trim();
      const copied = raw ? this.readBundleFromText(raw) : null;
      if (copied) { this.pasteBundleAt(copied); return; }
      // Image?
      for (const item of Array.from(data.items)) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile(); if (f) { await this.handlePastedImage(f); return; }
        }
      }
      // Text?
      const text = raw;
      // Nothing usable on the system clipboard: fall back to the in-session
      // copy, which is all there is when writing to the system clipboard
      // was unavailable or denied.
      if (!text) { this.pasteFromClipboard(); return; }
      if (isValidURL(text) && isGoogleMapsUrl(text)) {
        const { x, y } = this.centerPos(MAP_DEFAULT_W, MAP_DEFAULT_H);
        this.createMapCard(x, y, text);
      } else if (isValidURL(text)) {
        const { x, y } = this.centerPos(BOOKMARK_DEFAULT_W, BOOKMARK_DEFAULT_H);
        this.createBookmarkCard(x, y, text);
      } else {
        const { x, y } = this.centerPos(STICKY_DEFAULT_W, STICKY_DEFAULT_H);
        this.addStickyAt(x, y, text);
      }
    })(); });

    // Drag-and-drop from Finder or vault sidebar
    this.outer.addEventListener('dragover', (e) => {
      if (this.isDropAccepted(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; }
    });
    this.outer.addEventListener('drop', (e) => { void (async () => {
      e.preventDefault();

      // A grid-mode board's tile, dragged in from another pane (see
      // GridRenderer.renderTile) — recreate it here as an equivalent Tile
      // card, same icon/color/label/thumbnail/target, rather than treating
      // it like a generic external file drop.
      const tileData = e.dataTransfer?.getData(TILE_DRAG_MIME);
      if (tileData) {
        let payload: DraggedTilePayload;
        try { payload = JSON.parse(tileData) as DraggedTilePayload; } catch { return; }
        const rect = this.outer.getBoundingClientRect();
        const cp = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, this.vp);
        const card: TileCard = {
          id: crypto.randomUUID(), kind: 'tile',
          x: this.applySnap(cp.x - TILE_DEFAULT_W / 2), y: this.applySnap(cp.y - TILE_DEFAULT_H / 2),
          w: TILE_DEFAULT_W, h: TILE_DEFAULT_H, z: this.nextZ(),
          label: payload.label, subtitle: payload.subtitle, icon: payload.icon,
          color: payload.color, thumbnail: payload.thumbnail, target: payload.target,
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
        return;
      }

      const files = e.dataTransfer?.files;
      if (files?.length) {
        const rect = this.outer.getBoundingClientRect();
        let offsetX = 0;
        for (const f of Array.from(files)) {
          if (f.type.startsWith('image/')) {
            const cp = screenToCanvas(e.clientX - rect.left + offsetX, e.clientY - rect.top, this.vp);
            await this.handleDroppedImage(f, this.applySnap(cp.x - IMAGE_DEFAULT_W / 2), this.applySnap(cp.y - IMAGE_DEFAULT_H / 2));
            offsetX += IMAGE_DEFAULT_W + 16;
          } else if (f.type.startsWith('audio/')) {
            const cp = screenToCanvas(e.clientX - rect.left + offsetX, e.clientY - rect.top, this.vp);
            await this.handleDroppedAudio(f, this.applySnap(cp.x - AUDIO_DEFAULT_W / 2), this.applySnap(cp.y - AUDIO_DEFAULT_H / 2));
            offsetX += AUDIO_DEFAULT_W + 16;
          } else if (f.type.startsWith('video/') || VIDEO_EXTS.includes(f.name.split('.').pop()?.toLowerCase() ?? '')) {
            // Checked after audio so the MIME type settles .webm, which is a
            // container for both — audio/webm stays audio, video/webm becomes
            // video. The extension is only a fallback for when the OS reports
            // no type at all, which Windows does often enough to matter; an
            // untyped .webm is far more likely to be video.
            const cp = screenToCanvas(e.clientX - rect.left + offsetX, e.clientY - rect.top, this.vp);
            await this.handleDroppedVideo(f, this.applySnap(cp.x - VIDEO_DEFAULT_W / 2), this.applySnap(cp.y - VIDEO_DEFAULT_H / 2));
            offsetX += VIDEO_DEFAULT_W + 16;
          } else {
            // Anything else from the OS becomes a generic file card,
            // saved into _Assets/ like every other imported binary.
            const cp = screenToCanvas(e.clientX - rect.left + offsetX, e.clientY - rect.top, this.vp);
            let path: string;
            try { path = await saveNewAsset(this.app, await f.arrayBuffer(), f.name); }
            catch { new Notice(`Failed to save ${f.name}.`); continue; }
            const isPdf = path.toLowerCase().endsWith('.pdf');
            const card: FileCard = {
              id: crypto.randomUUID(), kind: 'file',
              x: this.applySnap(cp.x - FILE_DEFAULT_W / 2), y: this.applySnap(cp.y - FILE_DEFAULT_H / 2),
              w: FILE_DEFAULT_W, h: isPdf ? FILE_DEFAULT_H : 150, z: this.nextZ(), path,
            };
            this.pushUndo(); this.board.cards.push(card); await this.saveNow();
            this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
            offsetX += FILE_DEFAULT_W + 16;
          }
        }
        return;
      }
      // Vault sidebar file drag
      const dragMgr = (this.app as AppWithPrivateAPIs).dragManager;
      const draggable = dragMgr?.draggable;
      if (await this.dropVaultDraggableAt(draggable, e.clientX, e.clientY)) {
        this.lastNativeDropAt = Date.now();
      }
    })(); });

    // The same drop, arriving as a touch release instead.
    //
    // Obsidian's sidebar drag on iPad is its own, driven by touch: it sets
    // dragManager.draggable and paints a filename pill under the finger, but
    // it is not a native drag session, so no dragover/drop pair is ever fired
    // and the handler above cannot see it. Reported as being able to drag a
    // file over the canvas, see its name follow the finger, and have nothing
    // happen on release.
    //
    // Reading dragManager on release is what catches it. Nothing here
    // simulates a drag or tracks one in progress — Obsidian has already done
    // that work, and this only asks what it is holding at the moment the
    // finger lifts over this board.
    // Registered on the document, not on `.outer`, and in the capture phase:
    // Obsidian is dragging its own element, and if it has taken pointer
    // capture then every later pointer event — the release included — is
    // retargeted at that element and never reaches this canvas at all. That
    // is the same retargeting that made the video controls unusable for three
    // releases, so it is designed around here rather than discovered later.
    // Which board it belongs to is settled by hit-testing the release point
    // against this canvas, which also keeps two open panes from both acting.
    this.docPointerUp = (e: PointerEvent) => { void (async () => {
      // Touch only. A mouse drag produces a real drop event, and running both
      // paths would add the card twice.
      if (e.pointerType !== 'touch') return;
      // Belt and braces for any platform that fires both: a native drop that
      // just landed wins, and this stands down.
      if (Date.now() - this.lastNativeDropAt < NATIVE_DROP_GRACE_MS) return;
      const draggable = (this.app as AppWithPrivateAPIs).dragManager?.draggable;
      if (!draggable) return;
      const r = this.outer.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      // Building the card touches the vault -- sortAssetFile moves the file
      // into _Assets, and that can fail for ordinary reasons: the file was
      // renamed or deleted while the drag was in flight, a name already taken,
      // permissions. Unlike the drop handler this runs from a listener that
      // fires on *every* touch release, so an uncaught rejection here is not a
      // one-off: it repeats for the rest of the session. Reported as a failed
      // release rather than thrown into the void.
      try {
        await this.dropVaultDraggableAt(draggable, e.clientX, e.clientY);
      } catch (err) {
        console.error('Visual Notes: failed to add the dragged file', err);
        new Notice(`Visual Notes: couldn't add that file to the board — ${err instanceof Error ? err.message : String(err)}`);
      }
    })(); };
    activeDocument.addEventListener('pointerup', this.docPointerUp, { capture: true });
  },

  // Builds the right card for a file or folder dragged out of Obsidian's own
  // sidebar, at the given screen point. Extracted from the drop handler so a
  // touch drag can reach it too: on iPad the sidebar drag is driven by touch
  // and never produces a dragover/drop pair, so the handler below is never
  // called. See the pointerup listener in bindCanvasEvents.
  //
  // Returns whether a card was actually added, so a caller can tell a handled
  // drop from one that fell through.
  async dropVaultDraggableAt(this: FreeformRenderer, draggable: DragManager['draggable'], clientX: number, clientY: number): Promise<boolean> {
    const e = { clientX, clientY };
    if (draggable?.type === 'file' && draggable.file instanceof TFile) {
      const vf = draggable.file;
      const ext = vf.extension.toLowerCase();
      const rect = this.outer.getBoundingClientRect();
      const cp = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, this.vp);
      if (IMAGE_EXTS.includes(ext)) {
        const newPath = await sortAssetFile(this.app, vf);
        const newFile = this.app.vault.getAbstractFileByPath(newPath);
        if (!(newFile instanceof TFile)) return false;
        const h = await this.measureImageH(this.app.vault.getResourcePath(newFile));
        const card: ImageCard = {
          id: crypto.randomUUID(), kind: 'image',
          x: this.applySnap(cp.x - IMAGE_DEFAULT_W / 2), y: this.applySnap(cp.y - h / 2),
          w: IMAGE_DEFAULT_W, h, z: this.nextZ(),
          source: { type: 'vault', path: newPath }, captionHidden: true,
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      } else if (AUDIO_EXTS.includes(ext)) {
        const newPath = await sortAssetFile(this.app, vf);
        const card: AudioCard = {
          id: crypto.randomUUID(), kind: 'audio',
          x: this.applySnap(cp.x - AUDIO_DEFAULT_W / 2), y: this.applySnap(cp.y - AUDIO_DEFAULT_H / 2),
          w: AUDIO_DEFAULT_W, h: AUDIO_DEFAULT_H, z: this.nextZ(),
          source: { type: 'vault', path: newPath },
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      } else if (VIDEO_EXTS.includes(ext)) {
        // Plays where it lands, rather than becoming an icon you have to
        // open elsewhere — which is what Obsidian's own Canvas does with a
        // dropped video, and what this was missing.
        const newPath = await sortAssetFile(this.app, vf);
        const card: VideoCard = {
          id: crypto.randomUUID(), kind: 'video',
          x: this.applySnap(cp.x - VIDEO_DEFAULT_W / 2), y: this.applySnap(cp.y - VIDEO_DEFAULT_H / 2),
          w: VIDEO_DEFAULT_W, h: VIDEO_DEFAULT_H, z: this.nextZ(),
          source: { type: 'vault', path: newPath },
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      } else if (ext === 'md' && isClippedPage(this.app, vf)) {
        // A clipped page dropped onto the canvas becomes the same card the
        // clip importer would have made, rather than a tile you have to
        // open to see anything. Identified by the note carrying a source
        // URL in its properties rather than by which folder it sits in, so
        // a clip filed away somewhere else still looks like a clip.
        const card: NoteLinkCard = {
          id: crypto.randomUUID(), kind: 'note-link',
          x: this.applySnap(cp.x - NOTELINK_DEFAULT_W / 2), y: this.applySnap(cp.y - NOTELINK_DEFAULT_H / 2),
          w: NOTELINK_DEFAULT_W, h: NOTELINK_DEFAULT_H, z: this.nextZ(),
          path: vf.path, displayMode: 'preview',
          clipSourceUrl: clipMetaFromFrontmatter(this.app.metadataCache.getFileCache(vf)?.frontmatter).sourceUrl,
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      } else if (ext === 'canvas' || ext === 'md') {
        // Note / canvas link, dropped the same way native Canvas turns a
        // dragged file into a file node — here it becomes a tile that
        // navigates to (or opens) the dropped file. A dropped .canvas
        // file that's itself a Visual Notes board becomes a "nested
        // board" tile (kind 'board'); a plain native canvas becomes a
        // "canvas" tile (kind 'canvas') that just opens it directly.
        const isBoard = ext === 'canvas' && await isVisualNotesOwnedFile(this.app, vf);
        const targetKind: TileTarget['kind'] = ext === 'md' ? 'note' : (isBoard ? 'board' : 'canvas');
        const card: TileCard = {
          id: crypto.randomUUID(), kind: 'tile',
          x: this.applySnap(cp.x - TILE_DEFAULT_W / 2), y: this.applySnap(cp.y - TILE_DEFAULT_H / 2),
          w: TILE_DEFAULT_W, h: TILE_DEFAULT_H, z: this.nextZ(),
          label: vf.basename,
          icon: targetKind === 'board' ? 'layout-dashboard' : ext === 'md' ? 'file-text' : 'layout-grid',
          color: '#3B82F6',
          target: { kind: targetKind, path: vf.path },
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      } else {
        // Any other vault file (PDF, zip, spreadsheet, …) → generic file card.
        const newPath = await sortAssetFile(this.app, vf);
        const isPdf = ext === 'pdf';
        const card: FileCard = {
          id: crypto.randomUUID(), kind: 'file',
          x: this.applySnap(cp.x - FILE_DEFAULT_W / 2), y: this.applySnap(cp.y - FILE_DEFAULT_H / 2),
          w: FILE_DEFAULT_W, h: isPdf ? FILE_DEFAULT_H : 150, z: this.nextZ(), path: newPath,
        };
        this.pushUndo(); this.board.cards.push(card); await this.saveNow();
        this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      }
      return true;
    } else if (draggable?.type === 'folder' && draggable.file instanceof TFolder) {
      const folder = draggable.file;
      const rect = this.outer.getBoundingClientRect();
      const cp = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, this.vp);
      const card: TileCard = {
        id: crypto.randomUUID(), kind: 'tile',
        x: this.applySnap(cp.x - TILE_DEFAULT_W / 2), y: this.applySnap(cp.y - TILE_DEFAULT_H / 2),
        w: TILE_DEFAULT_W, h: TILE_DEFAULT_H, z: this.nextZ(),
        label: folder.name || folder.path,
        icon: 'folder', color: '#3B82F6',
        target: { kind: 'folder', path: folder.path },
      };
      this.pushUndo(); this.board.cards.push(card); await this.saveNow();
      this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
      return true;
    }
    return false;
  },

  // Whether a mousedown/pointerdown with this button should start a canvas
  // pan, per the "Pan with" setting — middle-click always qualifies unless
  // the user has dedicated it solely to right-click.
  isPanButton(this: FreeformRenderer, button: number): boolean {
    if (button === 1) return this.panButton !== 'right';
    if (button === 2) return this.panButton === 'right' || this.panButton === 'either';
    return false;
  },

  startPan(this: FreeformRenderer, e: PointerEvent): void {
    this.isPanning = true; this.setCursor('grabbing');
    const sx = e.clientX, sy = e.clientY, svx = this.vp.x, svy = this.vp.y;
    const pid = e.pointerId;
    let moved = false;
    // Use window capture-phase listeners so autoscroll or child stopPropagation
    // can't block move/up events (e.g. middle-click over <img> or scrollable kanban).
    const onMove = (me: PointerEvent) => {
      if (me.pointerId !== pid) return;
      if (!moved && Math.hypot(me.clientX - sx, me.clientY - sy) > DRAG_THRESHOLD) moved = true;
      this.vp = { ...this.vp, x: svx + (me.clientX - sx), y: svy + (me.clientY - sy) };
      this.applyViewport();
    };
    const onUp = (ue: PointerEvent) => {
      if (ue.pointerId !== pid) return;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      this.isPanning = false; this.setCursor(this.spaceDown || this.interactionMode === 'hand' ? 'grab' : ''); this.scheduleSave();
      // A right-button pan that actually moved the viewport shouldn't also
      // pop the browser's context menu on release — see the contextmenu
      // listener above, which consumes this flag.
      if (e.button === 2 && moved) this.suppressNextContextMenu = true;
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  },

  cancelLongPress(this: FreeformRenderer): void {
    if (this.longPressTimer !== null) { window.clearTimeout(this.longPressTimer); this.longPressTimer = null; }
    this.longPressTarget?.removeClass('visual-notes-longpress-active');
    this.longPressTarget = null;
    this.longPressPointerId = null;
  },

  // Same 60ms "wait to see if a second finger joins" debounce
  // maybeStartTouchMarquee used to use — without it, panning would start
  // moving the view for the first ~60ms of every two-finger pinch, before
  // the second touch point is even reported, producing a visible jump/fight
  // with the pinch-zoom transform once it takes over.
  maybeStartTouchPan(this: FreeformRenderer, e: PointerEvent): void {
    const pointerId = e.pointerId;
    let released = false;
    const onEarlyUp = (ue: PointerEvent) => { if (ue.pointerId === pointerId) released = true; };
    this.outer.addEventListener('pointerup', onEarlyUp, { once: true });
    this.outer.addEventListener('pointercancel', onEarlyUp, { once: true });
    window.setTimeout(() => {
      this.outer.removeEventListener('pointerup', onEarlyUp);
      this.outer.removeEventListener('pointercancel', onEarlyUp);
      if (released || this.activeTouches >= 2) return;
      this.startTouchPan(e);
    }, 60);
  },

  // One-finger pan for touch — separate from startPan (used for desktop
  // space+drag / middle-click) because a second finger landing mid-pan
  // needs to cancel it cleanly and hand off to pinch-zoom, which desktop
  // panning never has to worry about.
  startTouchPan(this: FreeformRenderer, e: PointerEvent): void {
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY, svx = this.vp.x, svy = this.vp.y;
    this.isPanning = true;
    const onMove = (me: PointerEvent) => {
      if (me.pointerId !== pid) return;
      this.vp = { ...this.vp, x: svx + (me.clientX - sx), y: svy + (me.clientY - sy) };
      this.applyViewport();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      this.cancelActiveTouchPan = null;
      this.isPanning = false;
      this.scheduleSave();
    };
    const onUp = (ue: PointerEvent) => { if (ue.pointerId === pid) cleanup(); };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    this.cancelActiveTouchPan = cleanup;
  },

  startMarquee(this: FreeformRenderer, e: PointerEvent): void {
    const rect = this.outer.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    this.marqueeEl.style.left = `${sx}px`;
    this.marqueeEl.style.top = `${sy}px`;
    this.marqueeEl.setCssProps({ '--visual-notes-marquee-w': '0px', '--visual-notes-marquee-h': '0px' });
    this.marqueeEl.show();
    this.outer.setPointerCapture(e.pointerId);
    const onMove = (e: PointerEvent) => {
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      this.marqueeEl.style.left = `${Math.min(sx, cx)}px`;
      this.marqueeEl.style.top  = `${Math.min(sy, cy)}px`;
      this.marqueeEl.setCssProps({ '--visual-notes-marquee-w': `${Math.abs(cx - sx)}px`, '--visual-notes-marquee-h': `${Math.abs(cy - sy)}px` });
    };
    const onUp = (e: PointerEvent) => {
      this.outer.removeEventListener('pointermove', onMove); this.outer.removeEventListener('pointerup', onUp);
      this.cancelActiveMarquee = null;
      this.marqueeEl.hide();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const mL = Math.min(sx, cx), mT = Math.min(sy, cy), mR = Math.max(sx, cx), mB = Math.max(sy, cy);
      if (mR - mL < 4 && mB - mT < 4) return;
      for (const [id, el] of this.cardEls) {
        const er = el.getBoundingClientRect();
        const eL = er.left - rect.left, eT = er.top - rect.top;
        if (eL < mR && eL + er.width > mL && eT < mB && eT + er.height > mT) this.selection.add(id);
      }
      // Arrows caught in the box get marked for deletion alongside whatever
      // cards were selected — otherwise deleting a marquee-selected section
      // left every connection through it dangling on screen.
      for (const [id, path] of this.connectionPaths) {
        const pr = path.getBoundingClientRect();
        const pL = pr.left - rect.left, pT = pr.top - rect.top;
        if (pL < mR && pL + pr.width > mL && pT < mB && pT + pr.height > mT) {
          this.marqueeConnectionIds.add(id);
          path.addClass('is-marquee-selected');
        }
      }
      // Pen/marker strokes caught in the box get their whole group selected
      // too (not clearing first — the pre-marquee pointerdown handler
      // already cleared any prior drawing selection unless Shift was held,
      // same as it does for cards above).
      for (const stroke of this.board.drawings) {
        const hitPath = this.inkHitPaths.get(stroke.id);
        if (!hitPath) continue;
        const sr = hitPath.getBoundingClientRect();
        const sL = sr.left - rect.left, sT = sr.top - rect.top;
        if (sL < mR && sL + sr.width > mL && sT < mB && sT + sr.height > mT) this.selectedDrawingIds.add(stroke.groupId);
      }
      if (this.selectedDrawingIds.size > 0) this.refreshDrawingSelectionVisual();
      this.refreshSelectionVisuals(true);
    };
    this.outer.addEventListener('pointermove', onMove); this.outer.addEventListener('pointerup', onUp);
    // Lets a second finger landing mid-drag (touchstart handler above)
    // abort this marquee instead of leaving it stuck fighting the pinch
    // transform for the rest of the gesture.
    this.cancelActiveMarquee = () => {
      this.outer.removeEventListener('pointermove', onMove); this.outer.removeEventListener('pointerup', onUp);
      this.cancelActiveMarquee = null;
      this.marqueeEl.hide();
    };
  },

  clearMarqueeConnections(this: FreeformRenderer): void {
    for (const id of this.marqueeConnectionIds) this.connectionPaths.get(id)?.removeClass('is-marquee-selected');
    this.marqueeConnectionIds.clear();
  },

  refreshSelectionVisuals(this: FreeformRenderer, keepMarqueeConnections = false): void {
    if (!keepMarqueeConnections) this.clearMarqueeConnections();
    for (const [id, el] of this.cardEls) el.toggleClass('is-selected', this.selection.has(id));
    this.alignBarEl?.toggleClass('is-visible', this.selection.getIds().length > 1);

    const ids = this.selection.getIds();
    // Selecting a card swaps the toolbar into context-bar mode; if the
    // phone add-sheet was open, drop its is-open state now so it doesn't
    // silently pop back open the moment the card is deselected.
    if (ids.length > 0) this.closeFab();
    const ctxBarActive = ids.length === 1 && !!this.board.cards.find(c => c.id === ids[0]);
    if (ids.length === 1) {
      const card = this.board.cards.find(c => c.id === ids[0]);
      const cardEl = card ? this.cardEls.get(card.id) : undefined;
      if (card && cardEl) this.contextBar?.show(card, cardEl);
      else this.contextBar?.hide();
    } else {
      this.contextBar?.hide();
    }
    // The phone context bar is a full-width bottom bar that would otherwise
    // sit on top of the minimap/zoom-pill/snap-toggle stack (only a concern
    // at phone widths — the CSS these classes drive is scoped there).
    this.zoomPill?.toggleClass('is-hidden-for-ctx-bar', ctxBarActive);
    this.snapToggleBtn?.toggleClass('is-hidden-for-ctx-bar', ctxBarActive);
    this.minimapEl?.toggleClass('is-hidden-for-ctx-bar', ctxBarActive);
    this.publishCollaborationPresence();
  },

  // Single delegated listener set on the canvas content container instead
  // of one pointerdown/dblclick/contextmenu (+ 4 resize-handle pointerdowns)
  // per card — with hundreds of cards that's thousands of idle listeners.
  // Resolving the card via closest()/dataset on each event keeps identical
  // behavior at a fraction of the standing listener count, and as a side
  // effect no longer needs rebinding after an in-place re-render (event
  // delegation covers new DOM automatically) — see the many now-removed
  // "renderCardContent(...); bindCardEvents(...)" call-site pairs.
  bindDelegatedCardEvents(this: FreeformRenderer): void {
    this.inner.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;

      // Resize handles take priority over everything below — even pen mode
      // (matches the old per-handle listener, which stopped propagation
      // before a card's own pointerdown handler, incl. its pen-mode check,
      // ever ran).
      const handle = target.closest<HTMLElement>('.visual-notes-card-resize-handle');
      if (handle) {
        const handleCardEl = handle.closest<HTMLElement>('.visual-notes-freeform-card');
        const handleCard = handleCardEl && this.board.cards.find(c => c.id === handleCardEl.dataset.id);
        if (handleCardEl && handleCard) this.startCardResize(e, handle, handleCardEl, handleCard);
        return;
      }
      // Connection handles stop propagation in their own listener before
      // this ever runs — kept as a defensive no-op for parity.
      if (target.classList.contains('visual-notes-connection-handle')) return;

      const el = target.closest<HTMLElement>('.visual-notes-freeform-card');
      if (!el) return; // not a card — let the background canvas handlers process it
      const card = this.board.cards.find(c => c.id === el.dataset.id);
      if (!card) return;

      // While drawing, a click on a card should never select/drag/edit it —
      // draw right over it instead. Stopping propagation keeps the canvas's
      // own background pointerdown handler from also trying to act on it.
      if (this.penModeActive) {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        this.startInkStroke(e);
        return;
      }
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return;
      if (target.closest('[contenteditable="true"]')) return;
      if (target.closest('a')) return;
      if (e.button !== 0) return;

      let dragMoved = false;

      // A YouTube card's drag overlay can't detect its own click: the drag
      // path below takes pointer capture on `el`, which retargets the rest
      // of the gesture (the compatibility `click` included) at the capturing
      // element, so nothing on the overlay ever sees it. Noted here and acted
      // on in onUp, once it's known whether this turned into a drag.
      const onYouTubeOverlay = !!target.closest('.visual-notes-bookmark-youtube-overlay');


      if (this.connectMode) {
        e.stopPropagation(); e.preventDefault();
        if (!this.connectSourceId) {
          this.connectSourceId = card.id;
          el.addClass('is-connect-source');
          this.startConnectSourceGhost(card.id);
        } else if (this.connectSourceId !== card.id) {
          const fromId = this.connectSourceId;
          this.exitConnectMode();
          this.finishConnection(fromId, card.id);
        }
        return;
      }

      // Skip preventDefault anywhere in a kanban/column header or board
      // titlebar — not just the title text itself — so a double-click
      // there still produces a real dblclick event (drag still works via
      // capture, further down, which doesn't depend on preventDefault at
      // all). preventDefault() on pointerdown suppresses the browser's own
      // compatibility mousedown/click/dblclick for that same press, for
      // every pointer type — the same mechanism that broke the kanban
      // board's add-item/add-column buttons before they got their own
      // pointerdown-stopPropagation guards. Titles used to be the only
      // exemption, which left the header's own background (surrounding the
      // title, incl. the whole "Untitled" placeholder's dim padding) still
      // swallowing every click.
      const isKanbanHeaderArea = (card.kind === 'kanban-column' || card.kind === 'kanban-board' || card.kind === 'column')
        && !!target.closest('.visual-notes-kanban-header, .visual-notes-kanban-board-titlebar, .visual-notes-column-header');

      // A video's own controls are drawn by the browser inside a shadow root
      // we cannot hit-test, and their height changes with the video's width
      // (Chromium splits them onto two rows when it is narrow). Every attempt
      // to carve out "the controls" by measurement has been wrong for some
      // video, so this carves out nothing: a press on a video is left alone
      // entirely until it moves. If it never moves, the browser handles it --
      // play, scrub, volume, fullscreen, whatever it landed on. If it does
      // move, the drag engages at the same threshold as every other card,
      // taking capture then (see takeCapture below).
      //
      // instanceOf rather than instanceof: a board in a popout window has its
      // own constructors, and a plain instanceof against this window's would
      // answer false there — leaving that board back on the intercepting path
      // whose controls don't work.
      const onVideo = target.instanceOf(HTMLVideoElement);

      e.stopPropagation();
      // preventDefault suppresses the compatibility mouse events the video's
      // controls are driven by, so it has to be skipped for the same reason
      // the kanban header skips it.
      if (!isKanbanHeaderArea && !onVideo) e.preventDefault();

      if (this.selectedConnectionId) this.deselectConnection();

      // Legacy single-column kanban: body area never drags the card — only
      // the column header does, so clicking around the items list can't
      // accidentally move it. Multi-column boards drag from anywhere that
      // isn't an interactive child (items stop their own pointerdown, and
      // drag only engages past the movement threshold, so header buttons
      // still click fine).
      const isKanbanColumnBody = card.kind === 'kanban-column' && !target.closest('.visual-notes-kanban-header');
      if (isKanbanColumnBody) {
        if (e.shiftKey) { this.selection.toggle(card.id); this.refreshSelectionVisuals(); }
        else if (!this.selection.has(card.id)) { this.selection.select(card.id); this.refreshSelectionVisuals(); }
        return;
      }

      if (e.shiftKey) { this.selection.toggle(card.id); this.refreshSelectionVisuals(); return; }
      if (!this.selection.has(card.id)) { this.selection.select(card.id); this.refreshSelectionVisuals(); }

      dragMoved = false;
      const sc = { x: e.clientX, y: e.clientY };
      const startPos = new Map<string, { x: number; y: number }>();
      // Snapshotted once here instead of `board.cards.find()` per selected
      // card on every pointermove frame during the drag.
      const dragCardsById = new Map<string, SupportedCard>();
      const captureId = e.pointerId;
      // Captured immediately (not gated behind the drag-threshold check
      // below) so pointerup/pointercancel are guaranteed to reach `el`
      // wherever the button is released. Without this, a small below-
      // threshold nudge that ends off the card leaves onUp never firing —
      // its pointermove/pointerup listeners stay attached, and the next
      // plain hover over the card (pointermove fires on hover regardless
      // of button state) replays into the stale onMove and starts a
      // "drag" with no button held at all.
      //
      // The exception is a press on a video: capture retargets every later
      // pointer event at `el`, so the controls would never see the release
      // and no button would ever fire. There it is deferred until the drag
      // actually engages, and document-level listeners below stand in for the
      // guarantee capture would otherwise give.
      let captured = false;
      const takeCapture = () => {
        if (captured) return;
        el.setPointerCapture(captureId);
        captured = true;
      };
      if (!onVideo) takeCapture();
      for (const id of this.selection.getIds()) {
        const c = this.board.cards.find(c => c.id === id);
        if (c) { startPos.set(id, { x: c.x ?? 0, y: c.y ?? 0 }); dragCardsById.set(id, c); }
      }
      // Dragging a lone group frame carries along everything geometrically
      // inside it, native-Canvas-style — not just the frame itself.
      if (card.kind === 'group' && this.selection.getIds().length === 1) {
        for (const id of this.cardsContainedInGroup(card)) {
          if (startPos.has(id)) continue;
          const c = this.board.cards.find(c => c.id === id);
          if (c) { startPos.set(id, { x: c.x ?? 0, y: c.y ?? 0 }); dragCardsById.set(id, c); }
        }
      }

      let hoveredCardId: string | null = null;
      let hoveredKind: 'kanban' | 'column' | null = null;

      // Candidate kanban/column drop targets are snapshotted once here
      // (id, kind, and its rect) instead of re-scanning every card on the
      // board and re-measuring every candidate's getBoundingClientRect() on
      // every pointermove frame. Safe because this absorb-into-container
      // logic only ever runs when exactly one card is selected/dragged
      // (`startPos.size === 1` below), so no candidate container is itself
      // moving mid-drag and its rect can't go stale.
      const isKanbanEligible = card.kind === 'image' || card.kind === 'audio' || card.kind === 'sticky';
      const isColumnEligible = isColumnChildKind(card.kind);
      const dropCandidates: { id: string; kind: 'kanban' | 'column'; rect: DOMRect }[] = [];
      if ((isKanbanEligible || isColumnEligible) && startPos.size === 1) {
        for (const kc of this.board.cards) {
          const isKanbanContainer = kc.kind === 'kanban-column' || kc.kind === 'kanban-board';
          const isColumnContainer = kc.kind === 'column';
          if (!(isKanbanEligible && isKanbanContainer) && !(isColumnEligible && isColumnContainer)) continue;
          if (kc.locked) continue; // padlocked: not a drop target
          const kEl = this.cardEls.get(kc.id);
          if (!kEl) continue;
          dropCandidates.push({ id: kc.id, kind: isKanbanContainer ? 'kanban' : 'column', rect: kEl.getBoundingClientRect() });
        }
      }

      // ── Lift / tilt / settle animation state ──
      // Velocity is exponentially smoothed and mapped to a small rotation
      // + counter-drift, so the card "leans back" against the direction of
      // motion with a bit of lag — the Milanote hover-with-weight feel.
      // Driven by a rAF loop (not per-pointermove) so the tilt keeps
      // easing back to rest even when the pointer pauses mid-drag.
      let tiltVX = 0, tiltVY = 0;
      let lastMoveX = e.clientX, lastMoveY = e.clientY, lastMoveT = performance.now();
      let tiltRafId = 0;
      const draggedEls: HTMLElement[] = [];
      const intensity = this.cardDragAnimationIntensity;
      const tiltLoop = () => {
        // Ease velocity back toward zero continuously
        tiltVX *= 0.88; tiltVY *= 0.88;
        const rot = Math.max(-7 * intensity, Math.min(7 * intensity, tiltVX * 0.012 * intensity));
        const liftScale = 1 + 0.03 * intensity;
        for (const cel of draggedEls) {
          cel.style.transform = `scale(${liftScale}) rotate(${rot.toFixed(2)}deg) translate(${(-tiltVX * 0.006 * intensity).toFixed(2)}px, ${(-tiltVY * 0.006 * intensity).toFixed(2)}px)`;
        }
        tiltRafId = window.requestAnimationFrame(tiltLoop);
      };
      const startLift = () => {
        if (!this.cardDragAnimationEnabled) return;
        for (const id of startPos.keys()) {
          const cel = this.cardEls.get(id);
          if (cel) { cel.addClass('is-lifted'); draggedEls.push(cel); }
        }
        tiltRafId = window.requestAnimationFrame(tiltLoop);
      };
      const endLift = (settled: boolean) => {
        if (!this.cardDragAnimationEnabled) return;
        window.cancelAnimationFrame(tiltRafId);
        for (const cel of draggedEls) {
          cel.removeClass('is-lifted');
          cel.setCssStyles({ transform: '' });
          if (settled) {
            cel.addClass('is-settling');
            window.setTimeout(() => cel.removeClass('is-settling'), 260);
          }
        }
      };

      // The per-move work below (position writes, connection path rebuilds
      // for every dragged card, trash/drop-target hit-testing) involves
      // getBoundingClientRect() reads right after style writes — doing it
      // once per raw pointermove forces a synchronous layout flush on every
      // event, which on a high-polling-rate input fires far more often than
      // the screen can even repaint. Coalesce into a single rAF flush per
      // frame: onMove just records the latest position; flushMoveFrame does
      // the actual (expensive) work using whatever the latest position was
      // by the time the frame is ready to paint.
      let latestX = sc.x, latestY = sc.y;
      let moveFrameId = 0;
      let moveFramePending = false;
      const flushMoveFrame = () => {
        moveFramePending = false;
        const dx = latestX - sc.x, dy = latestY - sc.y;
        // Snap the anchor card (the one under the pointer) to the grid, then
        // move every other selected card by that same snapped delta —
        // snapping each card's absolute position independently would drift
        // a multi-card selection out of its original relative layout.
        const anchorStart = startPos.get(card.id);
        const moveDx = anchorStart ? this.applySnap(anchorStart.x + dx / this.vp.zoom) - anchorStart.x : dx / this.vp.zoom;
        const moveDy = anchorStart ? this.applySnap(anchorStart.y + dy / this.vp.zoom) - anchorStart.y : dy / this.vp.zoom;
        for (const [id, start] of startPos) {
          const c = dragCardsById.get(id); const cel = this.cardEls.get(id);
          if (!c || !cel) continue;
          c.x = start.x + moveDx; c.y = start.y + moveDy;
          cel.style.left = `${c.x}px`; cel.style.top = `${c.y}px`;
          this.updateConnectionsForCard(id);
        }
        this.setTrashHover(latestX, latestY);
        if (dropCandidates.length) {
          const elRect = el.getBoundingClientRect();
          let foundId: string | null = null;
          let foundKind: 'kanban' | 'column' | null = null;
          for (const dc of dropCandidates) {
            if (elRect.left < dc.rect.right && elRect.right > dc.rect.left && elRect.top < dc.rect.bottom && elRect.bottom > dc.rect.top) {
              foundId = dc.id; foundKind = dc.kind; break;
            }
          }
          if (foundId !== hoveredCardId) {
            if (hoveredCardId) this.cardEls.get(hoveredCardId)?.removeClass('is-kanban-drop-target');
            hoveredCardId = foundId; hoveredKind = foundKind;
            if (foundId) this.cardEls.get(foundId)?.addClass('is-kanban-drop-target');
          }
        }
        // No-ops for multi-select (context bar only ever shows for a single
        // selected card) or when nothing's shown — otherwise keeps the
        // floating bar aligned with the card as it moves, same rAF batching
        // as everything else in this flush.
        this.contextBar?.reposition();
      };

      const onMove = (e: PointerEvent) => {
        // Only the finger that started this drag may move it. Pointer capture
        // is per-pointerId, so a *second* touch landing on the same card still
        // fires pointermove here — and without this the card was moved to
        // that finger's position measured from the first finger's start,
        // which reads as the card teleporting. Reported on iPad against
        // storyboards, which get it worst by being the largest card kind by
        // some way: a second finger lands on one far more easily, and a
        // pinch-zoom over a full-screen storyboard is the natural gesture.
        // startTouchPan has always filtered this way; the card drag did not.
        if (e.pointerId !== captureId) return;
        // Defensive: with capture already held (see above), a genuine
        // release always arrives as pointerup/pointercancel — but if the
        // button is somehow already up by the time a move event lands
        // (e.g. it was released while the window was unfocused), clean up
        // instead of starting a drag with nothing held down.
        if (e.buttons === 0) { onUp(e); return; }
        const dx = e.clientX - sc.x, dy = e.clientY - sc.y;
        if (!dragMoved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          dragMoved = true;
          // No-op unless this press began on a video, where capture was held
          // back so the controls could work. From here it is a real drag, so
          // the usual guarantees are wanted.
          takeCapture();
          this.pushUndo();
          startLift();
        }
        // Update smoothed velocity from instantaneous pointer speed — kept
        // per-event (cheap, no layout access) rather than batched below.
        const now = performance.now();
        const dt = Math.max(1, now - lastMoveT);
        const ivx = (e.clientX - lastMoveX) / dt * 100;
        const ivy = (e.clientY - lastMoveY) / dt * 100;
        tiltVX = tiltVX * 0.7 + ivx * 0.3;
        tiltVY = tiltVY * 0.7 + ivy * 0.3;
        lastMoveX = e.clientX; lastMoveY = e.clientY; lastMoveT = now;

        latestX = e.clientX; latestY = e.clientY;
        if (!moveFramePending) {
          moveFramePending = true;
          moveFrameId = window.requestAnimationFrame(flushMoveFrame);
        }
      };
      // `cancelled` says this drag was abandoned rather than released — see
      // cancelActiveCardDrag, which is the one caller that has no event of its
      // own to speak for it.
      const onUp = (ue: PointerEvent, cancelled = false) => {
        // Same reason as onMove: a second finger lifting off the card is not
        // this drag ending. Skipped when cancelActiveCardDrag calls in, which
        // passes the drag's own id deliberately.
        if (ue.pointerId !== captureId) return;
        // Only a real release says anything about *where* the drag ended.
        // Everything else is the gesture being taken away mid-flight: a second
        // finger arriving, or the browser claiming the touch — which iPadOS
        // does the moment a drag begins inside a scrolling region, and a
        // storyboard's shot strip is one. Both arrive as a pointercancel whose
        // coordinates are worthless: the synthetic one has none, and WebKit
        // reports (0, 0). Resolving the drag against those put the card at
        // minus the grab point in board units — reported as a storyboard
        // "zipping somewhere else on the canvas really quickly" when dragged
        // by its body, while its header, with no scroll container under it and
        // so no cancel, dragged normally.
        //
        // Note what this deliberately does NOT do: put the cards back. 1.2.4
        // tried that and broke dragging outright, because a browser cancels a
        // touch far more readily than the word suggests (iPadOS does it for a
        // long press, a resting palm, a scroll it decides to claim) — so every
        // drag that met one snapped home, reported as being unable to move
        // anything on the canvas at all. A cancelled drag still moved a card
        // and the user still watched it move; leaving it where the pointer was
        // last seen is the answer that is never wrong. Only the coordinates
        // are distrusted, never the movement itself.
        const released = !cancelled && ue.type !== 'pointercancel';
        this.cancelActiveCardDrag = null;
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        // Harmless when they were never added (the non-video path).
        activeDocument.removeEventListener('pointerup', onUp);
        activeDocument.removeEventListener('pointercancel', onUp);
        // The pending frame is unscheduled and flushed by hand, so it can
        // neither be lost nor fire after the drag is over. A release refines
        // it with the release coordinates, landing the card exactly under the
        // pointer instead of one frame behind it; a cancel's coordinates are
        // worthless, so it flushes at the last position a pointermove
        // actually reported. Overwriting with them regardless is what threw
        // the card off the board.
        if (moveFramePending) {
          window.cancelAnimationFrame(moveFrameId);
          if (released) { latestX = ue.clientX; latestY = ue.clientY; }
          flushMoveFrame();
        }
        if (hoveredCardId) this.cardEls.get(hoveredCardId)?.removeClass('is-kanban-drop-target');
        this.clearTrashHover();
        // A cancelled drag drops nowhere — not on the trash, not into a
        // container. Judged against a cancel's coordinates instead, whatever
        // sits at the origin would silently swallow the card.
        const trashing = released && dragMoved && this.isOverTrash(ue.clientX, ue.clientY);
        // No settle animation when the card is about to be absorbed into a
        // kanban/column container or dropped on the trash — its element gets
        // removed immediately, so animating it would just flash. Settle only
        // on a normal canvas drop.
        const absorbing = released && (!!(dragMoved && hoveredCardId) || trashing);
        endLift(dragMoved && !absorbing);
        // Pressed the video overlay and let go without dragging — that's the
        // "Click to play or pause" the overlay's tooltip promises.
        if (onYouTubeOverlay && !dragMoved) toggleYouTubePlayback(el);
        // A video that was actually dragged must not also be toggled: the
        // browser still emits a click at the end of the gesture, and its
        // default action on a video is play/pause, so repositioning a card
        // would start it playing. Swallowed once, in the capture phase, before
        // it can reach the element. The timeout is for the case where no click
        // follows at all (a drag released off the card), so the listener can't
        // outlive the gesture and eat an unrelated one.
        if (onVideo && dragMoved) {
          const swallowClick = (ce: Event) => { ce.stopPropagation(); ce.preventDefault(); };
          activeDocument.addEventListener('click', swallowClick, { capture: true, once: true });
          window.setTimeout(() => activeDocument.removeEventListener('click', swallowClick, true), 0);
        }
        if (trashing) {
          // pushUndo already ran when the drag crossed its threshold, so a
          // single undo restores the cards at their pre-drag positions.
          for (const id of startPos.keys()) {
            this.board.cards = this.board.cards.filter(c => c.id !== id);
            this.cardEls.get(id)?.remove(); this.cardEls.delete(id);
            this.disposeCardResources(id);
            this.board.connections = this.board.connections.filter(
              c => c.fromCardId !== id && c.toCardId !== id
            );
          }
          this.selection.clear();
          this.refreshSelectionVisuals();
          this.refreshAllConnections();
          this.scheduleSave();
          return;
        }
        if (dragMoved && hoveredCardId && hoveredKind === 'kanban' && (card.kind === 'image' || card.kind === 'audio' || card.kind === 'sticky')) {
          const targetEl = this.cardEls.get(hoveredCardId);
          const elRect = el.getBoundingClientRect();
          // A legacy single-column card has exactly one items list; a board
          // has one per column — pick whichever column's items list is
          // horizontally closest to where the dropped card ended up.
          const itemsEls = targetEl ? Array.from(targetEl.querySelectorAll<HTMLElement>('.visual-notes-kanban-items')) : [];
          const cx = (elRect.left + elRect.right) / 2;
          let bestItemsEl: HTMLElement | null = null; let bestDist = Infinity;
          for (const ie of itemsEls) {
            const ir = ie.getBoundingClientRect();
            const d = Math.abs((ir.left + ir.right) / 2 - cx);
            if (d < bestDist) { bestDist = d; bestItemsEl = ie; }
          }
          const owner = bestItemsEl ? this.resolveKanbanItemsOwner(bestItemsEl) : null;
          // Sticky notes carry the inverse of kanbanItemToStickyText's
          // markdown so a previously-extracted item round-trips back into
          // its structured fields; image/audio cards keep their prior
          // one-field mapping.
          let item: KanbanItem | null = null;
          if (card.kind === 'sticky') {
            item = this.stickyTextToKanbanItem(card);
          } else if (card.source.type === 'vault') {
            const path = card.source.path;
            item = card.kind === 'image'
              ? { id: crypto.randomUUID(), text: '', imagePath: path }
              : { id: crypto.randomUUID(), text: '', audioPath: path };
          }
          if (owner && bestItemsEl && item) {
            owner.setItems([...owner.getItems(), item]);
            this.appendKanbanItem(bestItemsEl, owner, item);
            owner.updateCount();
            this.board.cards = this.board.cards.filter(c => c.id !== card.id);
            el.remove(); this.cardEls.delete(card.id);
            this.refreshSelectionVisuals();
          }
          this.scheduleSave();
          return;
        }
        if (dragMoved && hoveredCardId && hoveredKind === 'column' && isColumnChildKind(card.kind)) {
          const targetColumn = this.board.cards.find(c => c.id === hoveredCardId && c.kind === 'column') as ColumnCard | undefined;
          if (targetColumn) {
            this.board.cards = this.board.cards.filter(c => c.id !== card.id);
            targetColumn.children.push(card as unknown as ColumnChildCard);
            this.rebuildKanbanCard(targetColumn);
            el.remove(); this.cardEls.delete(card.id);
            this.disposeCardResources(card.id);
            this.refreshSelectionVisuals();
          }
          this.scheduleSave();
          return;
        }
        if (dragMoved) this.scheduleSave();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      // A second finger means this stopped being a drag and became a pinch.
      // The marquee and the one-finger pan have always stood down for that
      // (see the touchstart handler); the card drag never did, so a pinch
      // begun on a card left a live drag fighting the zoom transform.
      // Synthesised with this drag's own pointerId so onUp's filter admits it.
      this.cancelActiveCardDrag = () => {
        onUp(new PointerEvent('pointercancel', { pointerId: captureId }), true);
      };
      if (onVideo) {
        // Standing in for the capture that wasn't taken. Without it, a press
        // released anywhere but over this card never reaches `el`, leaving
        // onMove attached — and a later hover (pointermove fires on hover
        // regardless of buttons) would replay into it and "drag" the card
        // with nothing held down. That is the exact bug immediate capture was
        // introduced to prevent, so the deferral has to answer for it too.
        // `el` sees the release first and detaches these before the event
        // reaches the document, so onUp still runs exactly once.
        activeDocument.addEventListener('pointerup', onUp);
        activeDocument.addEventListener('pointercancel', onUp);
      }
    });

    this.inner.addEventListener('dblclick', (e) => { void (async () => {
      if (this.penModeActive) return;
      const target = e.target as HTMLElement;
      const el = target.closest<HTMLElement>('.visual-notes-freeform-card');
      if (!el) return;
      const card = this.board.cards.find(c => c.id === el.dataset.id);
      if (!card) return;
      e.stopPropagation();
      switch (card.kind) {
        case 'tile':      await this.activateTile(card); break;
        case 'sticky':    this.editStickyInline(el, card); break;
        case 'text':      this.editTextInline(el, card); break;
        case 'note-link': await this.activateNoteLink(card); break;
        case 'image':
          if (target.closest('.visual-notes-image-caption-wrap')) break;
          this.openImageSource(card); break;
        case 'bookmark':
          // YouTube cards are live iframes now — they handle play/pause/
          // fullscreen themselves. Only non-YouTube bookmarks open externally.
          if (!parseYouTubeId(card.url)) openExternalUrl(card.url);
          break;
        case 'swatch':
          el.querySelector<HTMLInputElement>('.visual-notes-swatch-color-input')?.click();
          break;
        case 'file':
          await this.openFileCard(card);
          break;
        case 'callout':
          this.editCalloutInline(el, card);
          break;
      }
    })(); });

    this.inner.addEventListener('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      const el = target.closest<HTMLElement>('.visual-notes-freeform-card');
      if (!el) return;
      const card = this.board.cards.find(c => c.id === el.dataset.id);
      if (!card) return;
      e.preventDefault(); e.stopPropagation();
      if (!this.selection.has(card.id)) { this.selection.select(card.id); this.refreshSelectionVisuals(); }
      const menu = this.newMenu();
      this.populateCardMenu(menu, el, card);
      menu.showAtMouseEvent(e);
    });
  },

  appendResizeHandles(this: FreeformRenderer, el: HTMLElement): void {
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const)
      el.createDiv(`visual-notes-card-resize-handle visual-notes-card-resize-handle--${corner}`);
  },

  startCardResize(this: FreeformRenderer, e: PointerEvent, handle: HTMLElement, el: HTMLElement, card: SupportedCard): void {
    const corner = (['nw','ne','sw','se'] as const).find(c => handle.classList.contains(`visual-notes-card-resize-handle--${c}`)) ?? 'se';

    e.stopPropagation(); e.preventDefault(); this.pushUndo();
    const sc = { x: e.clientX, y: e.clientY };
    const startX = card.x ?? 0, startY = card.y ?? 0;
    const startW = card.w ?? TILE_DEFAULT_W, startH = card.h ?? TILE_DEFAULT_H;
    const { w: minW, h: minH } = cardMinSize(card.kind);
    // Snapshot, so a drag multiplies from the size the card actually is
    // rather than restarting each frame.
    const startFontSize = card.kind === 'text' ? card.fontSize : TEXT_CARD_DEFAULT_FONT;
    el.setPointerCapture(e.pointerId);

    let imgAspect: number | null = null;
    if (card.kind === 'image') {
      const imgEl = el.querySelector<HTMLImageElement>('.visual-notes-image-img');
      imgAspect = (imgEl && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0)
        ? imgEl.naturalHeight / imgEl.naturalWidth
        : startH / startW;
    } else if (card.kind === 'bookmark' && parseYouTubeId(card.url) && !card.youtubeHeaderShown) {
      // Headerless YouTube embed is a bare video — keep it 16:9 while
      // resizing. With the header strip shown the extra height makes a
      // fixed ratio feel wrong, so resize stays free in that case.
      imgAspect = 9 / 16;
    }

    // Same rAF-coalescing as card drag above: the resize math + style
    // writes + connection path rebuild only need to happen once per painted
    // frame, not once per raw pointermove.
    let latestEv = e;
    let moveFrameId = 0;
    let moveFramePending = false;
    const applyResize = (ev: PointerEvent) => {
      const cdx = (ev.clientX - sc.x) / this.vp.zoom;
      const cdy = (ev.clientY - sc.y) / this.vp.zoom;
      const wSign = (corner === 'se' || corner === 'ne') ? 1 : -1;
      const hSign = (corner === 'se' || corner === 'sw') ? 1 : -1;
      const newW = Math.max(minW, this.applySnap(startW + wSign * cdx));

      if (card.kind === 'text') {
        // Scales the type rather than reflowing to a new width. Because a text
        // card never wraps, the box grows in exact proportion to the font
        // size, so the new size can be *computed* rather than measured — no
        // per-frame reflow read, which is what made the first attempt at this
        // feel like it was snapping around under the cursor.
        const ratio = startW > 0 ? (startW + wSign * cdx) / startW : 1;
        const next = Math.min(TEXT_CARD_MAX_FONT, Math.max(TEXT_CARD_MIN_FONT, startFontSize * ratio));
        const grew = next / startFontSize;
        card.fontSize = next;
        card.w = startW * grew;
        card.h = startH * grew;
        // Pin the corner opposite the one being dragged.
        card.x = corner === 'sw' || corner === 'nw' ? startX + startW - card.w : startX;
        card.y = corner === 'nw' || corner === 'ne' ? startY + startH - card.h : startY;
        const inner = el.querySelector<HTMLElement>('.visual-notes-text-body');
        if (inner) inner.style.fontSize = `${next}px`;
        el.style.left = `${card.x}px`;
        el.style.top = `${card.y}px`;
      } else if (card.kind === 'sticky' && !card.blank) {
        card.w = newW;
        if (corner === 'sw' || corner === 'nw') card.x = this.applySnap(startX + startW - newW);
        el.style.width = `${card.w}px`;
        el.style.left = `${card.x ?? startX}px`;
      } else if (imgAspect !== null) {
        card.w = newW;
        card.h = Math.max(minH, snap(newW * imgAspect));
        if (corner === 'sw' || corner === 'nw') card.x = this.applySnap(startX + startW - card.w);
        if (corner === 'nw' || corner === 'ne') card.y = this.applySnap(startY + startH - card.h);
        el.style.width = `${card.w}px`; el.style.height = `${card.h}px`;
        el.style.left = `${card.x ?? startX}px`; el.style.top = `${card.y ?? startY}px`;
      } else {
        card.w = newW;
        card.h = Math.max(minH, this.applySnap(startH + hSign * cdy));
        if (corner === 'sw' || corner === 'nw') card.x = this.applySnap(startX + startW - card.w);
        if (corner === 'nw' || corner === 'ne') card.y = this.applySnap(startY + startH - card.h);
        el.style.width = `${card.w}px`; el.style.height = `${card.h}px`;
        el.style.left = `${card.x ?? startX}px`; el.style.top = `${card.y ?? startY}px`;
      }

      if (card.kind === 'tile') {
        const tileSize = Math.max(40, Math.min((card.w ?? minW) - 20, (card.h ?? minH) - 50 - 16));
        const sq = el.querySelector<HTMLElement>('.visual-notes-freeform-tile-square');
        const ic = el.querySelector<HTMLElement>('.visual-notes-tile-icon');
        if (sq) { sq.style.width = `${tileSize}px`; sq.style.height = `${tileSize}px`; sq.style.borderRadius = `${Math.round(tileSize * 0.2)}px`; }
        if (ic) {
          const is = Math.round(tileSize * 0.55);
          ic.style.width = `${is}px`; ic.style.height = `${is}px`;
          if (ic.classList.contains('visual-notes-tile-emoji')) ic.style.fontSize = `${Math.round(is * 0.9)}px`;
        }
      }
      this.updateConnectionsForCard(card.id);
      this.contextBar?.reposition(); // keeps the floating bar aligned as the card resizes
    };
    const onMove = (ev: PointerEvent) => {
      latestEv = ev;
      if (moveFramePending) return;
      moveFramePending = true;
      moveFrameId = window.requestAnimationFrame(() => { moveFramePending = false; applyResize(latestEv); });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (moveFramePending) { window.cancelAnimationFrame(moveFrameId); moveFramePending = false; applyResize(latestEv); }
      this.renderCardContent(el, card);
      // The drag worked from predicted sizes to avoid a layout read per frame;
      // reconcile with what the browser actually laid out, once, at the end.
      if (card.kind === 'text') this.syncTextCardSize(el, card);
      this.updateConnectionsForCard(card.id);
      this.scheduleSave();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  },

  // Only ever called from docKeyDown, which already handles pen-mode exit
  // (Escape/Enter) unconditionally before reaching here — see there.
  onKeyDown(this: FreeformRenderer, e: KeyboardEvent): void {
    if (isTypingElement(activeDocument.activeElement)) return;

    const meta = e.metaKey || e.ctrlKey;

    // Arrow keys nudge the selection, the movement every canvas offers for
    // placement finer than a drag. Shift makes it a coarse step. Deliberately
    // not bound while nothing is selected, so the keypress still reaches
    // whatever else might want it.
    const nudge = ARROW_NUDGE[e.key];
    if (nudge && !meta && !this.selection.isEmpty()) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE_FINE;
      this.pushUndo();
      for (const id of this.selection.getIds()) {
        const c = this.board.cards.find(x => x.id === id);
        if (!c) continue;
        c.x = (c.x ?? 0) + nudge.dx * step; c.y = (c.y ?? 0) + nudge.dy * step;
        const cardEl = this.cardEls.get(id);
        if (cardEl) { cardEl.style.left = `${c.x}px`; cardEl.style.top = `${c.y}px`; }
        this.updateConnectionsForCard(id);
      }
      this.contextBar?.reposition();
      this.scheduleSave();
      return;
    }
    if (e.key === 'Escape') {
      if (this.pendingTool) { this.clearPendingTool(); return; }
      if (this.interactionMode === 'hand') { this.setInteractionMode('select'); return; }
      if (this.overflowPopover) { this.closeOverflow(); return; }
      if (this.connectMode) { this.exitConnectMode(); return; }
      if (this.selectedConnectionId) { this.deselectConnection(); return; }
      if (this.selectedDrawingIds.size > 0) { this.deselectDrawing(); return; }
      this.selection.clear(); this.refreshSelectionVisuals(); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.selection.isEmpty() || this.marqueeConnectionIds.size > 0) { e.preventDefault(); this.deleteSelected(); return; }
      if (this.selectedConnectionId) { e.preventDefault(); this.deleteSelectedConnection(); return; }
      if (this.selectedDrawingIds.size > 0) { e.preventDefault(); this.deleteSelectedDrawing(); return; }
    }
    if (meta && e.key === 'a') { e.preventDefault(); for (const c of this.board.cards) this.selection.add(c.id); this.refreshSelectionVisuals(); return; }
    if (meta && e.key === 'd') { e.preventDefault(); this.duplicateSelected(); return; }
    if (meta && e.key === 'g' && this.selection.getIds().length > 0) { e.preventDefault(); this.groupSelected(); return; }
    if (meta && !e.shiftKey && e.key === 'z') { e.preventDefault(); this.undo(); return; }
    if ((meta && e.shiftKey && e.key === 'z') || (meta && e.key === 'y')) { e.preventDefault(); this.redo(); return; }
    // Copy/cut the selection. Left un-prevented when nothing is selected so
    // a plain Cmd/Ctrl+C still reaches the OS (e.g. to copy a text
    // selection made elsewhere in the pane). Cmd/Ctrl+V is deliberately NOT
    // handled here — the canvas already has a `paste` listener, and pasting
    // from both would insert everything twice; see bindCanvasEvents.
    if (meta && !e.shiftKey && (e.key === 'c' || e.key === 'x')) {
      if (this.selection.isEmpty() && this.selectedDrawingIds.size === 0) return;
      e.preventDefault(); this.copySelection(e.key === 'x'); return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === 'c') {
      const imageCards = this.selection.getIds()
        .map(id => this.board.cards.find(c => c.id === id))
        .filter((c): c is ImageCard => !!c && c.kind === 'image');
      if (imageCards.length > 0) {
        e.preventDefault();
        this.pushUndo();
        for (const card of imageCards) {
          card.captionHidden = !card.captionHidden;
          const cardEl = this.cardEls.get(card.id);
          if (cardEl) {
            const wrap = cardEl.querySelector<HTMLElement>('.visual-notes-image-caption-wrap');
            if (wrap) wrap.toggleClass('is-hidden', !!card.captionHidden);
          }
        }
        this.scheduleSave();
        return;
      }
    }
  },

  async activateTile(this: FreeformRenderer, tile: TileCard): Promise<void> {
    const { target } = tile;
    if (!target.path) { new Notice('This tile has no target set.'); return; }
    if (target.kind === 'board') {
      this.openNestedBoard(
        target.path,
        path => { target.path = path; },
        target.roomId,
        roomId => { target.roomId = roomId; },
      );
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(target.path);
    if (!file) { new Notice(`Target no longer exists: ${target.path}`); return; }
    if (target.kind === 'note' || target.kind === 'canvas') {
      if (!(file instanceof TFile)) return;
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(file); void this.app.workspace.revealLeaf(leaf); return;
    }

    if (target.kind === 'kanban') {
      if (!(file instanceof TFile)) return;
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(file); void this.app.workspace.revealLeaf(leaf);
      const isInstalled = (this.app as AppWithPrivateAPIs).plugins?.enabledPlugins?.has('obsidian-kanban') ?? false;
      if (!isInstalled) new Notice('Install the community "Kanban" plugin to view this as a board.');
      return;
    }
    if (target.kind === 'folder') {
      if (!(file instanceof TFolder)) return;
      const ex = this.app.workspace.getLeavesOfType('file-explorer');
      if (ex.length > 0) { const v = ex[0].view as { revealInFolder?: (f: TFolder) => void }; v.revealInFolder?.(file); }
      const firstNote = file.children?.find((f): f is TFile => f instanceof TFile && f.extension === 'md');
      if (firstNote) { const leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(firstNote); void this.app.workspace.revealLeaf(leaf); }
    }
  },

  async activateNoteLink(this: FreeformRenderer, card: NoteLinkCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (!(file instanceof TFile)) { new Notice(`Note no longer exists: ${card.path}`); return; }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file); void this.app.workspace.revealLeaf(leaf);
  },

  nextZ(this: FreeformRenderer): number { return Math.max(0, ...this.board.cards.map(c => c.z ?? 0)) + 1; },

  applySnap(this: FreeformRenderer, val: number): number {
    return snap(val, this.snapToGridEnabled ? this.snapGridSize : 4);
  },

  toggleSnapToGrid(this: FreeformRenderer): void {
    this.snapToGridEnabled = !this.snapToGridEnabled;
    this.snapToggleBtn?.toggleClass('is-active', this.snapToGridEnabled);
    this.onToggleSnapToGrid?.(this.snapToGridEnabled);
  },

  centerPos(this: FreeformRenderer, w: number, h: number): { x: number; y: number } {
    const rect = this.outer.getBoundingClientRect();
    const c = screenToCanvas(rect.width / 2, rect.height / 2, this.vp);
    return { x: this.applySnap(c.x - w / 2), y: this.applySnap(c.y - h / 2) };
  },

  alignCards(this: FreeformRenderer, mode: 'left' | 'center-h' | 'right' | 'top' | 'middle-v' | 'bottom' | 'distribute-h' | 'distribute-v'): void {
    const ids = this.selection.getIds();
    const cards = ids.map(id => this.board.cards.find(c => c.id === id)).filter((c): c is Card => !!c);
    if (cards.length < 2) return;
    this.pushUndo();
    if (mode === 'left') {
      const ref = Math.min(...cards.map(c => c.x ?? 0));
      for (const c of cards) c.x = ref;
    } else if (mode === 'center-h') {
      const cx = cards.reduce((s, c) => s + (c.x ?? 0) + (c.w ?? 0) / 2, 0) / cards.length;
      for (const c of cards) c.x = cx - (c.w ?? 0) / 2;
    } else if (mode === 'right') {
      const ref = Math.max(...cards.map(c => (c.x ?? 0) + (c.w ?? 0)));
      for (const c of cards) c.x = ref - (c.w ?? 0);
    } else if (mode === 'top') {
      const ref = Math.min(...cards.map(c => c.y ?? 0));
      for (const c of cards) c.y = ref;
    } else if (mode === 'middle-v') {
      const cy = cards.reduce((s, c) => s + (c.y ?? 0) + (c.h ?? 0) / 2, 0) / cards.length;
      for (const c of cards) c.y = cy - (c.h ?? 0) / 2;
    } else if (mode === 'bottom') {
      const ref = Math.max(...cards.map(c => (c.y ?? 0) + (c.h ?? 0)));
      for (const c of cards) c.y = ref - (c.h ?? 0);
    } else if (mode === 'distribute-h') {
      const sorted = [...cards].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
      const left = sorted[0].x ?? 0;
      const right = (sorted[sorted.length - 1].x ?? 0) + (sorted[sorted.length - 1].w ?? 0);
      const totalW = cards.reduce((s, c) => s + (c.w ?? 0), 0);
      const gap = (right - left - totalW) / (cards.length - 1);
      let x = left;
      for (const c of sorted) { c.x = x; x += (c.w ?? 0) + gap; }
    } else if (mode === 'distribute-v') {
      const sorted = [...cards].sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
      const top = sorted[0].y ?? 0;
      const bottom = (sorted[sorted.length - 1].y ?? 0) + (sorted[sorted.length - 1].h ?? 0);
      const totalH = cards.reduce((s, c) => s + (c.h ?? 0), 0);
      const gap = (bottom - top - totalH) / (cards.length - 1);
      let y = top;
      for (const c of sorted) { c.y = y; y += (c.h ?? 0) + gap; }
    }
    for (const c of cards) {
      const cardEl = this.cardEls.get(c.id);
      if (cardEl) { cardEl.style.left = `${c.x}px`; cardEl.style.top = `${c.y}px`; }
    }
    this.refreshAllConnections();
    this.scheduleSave();
  },

  deleteSelected(this: FreeformRenderer): void {
    const ids = this.selection.getIds();
    const connectionIds = this.marqueeConnectionIds;
    if (!ids.length && !connectionIds.size) return;
    this.pushUndo();
    for (const id of ids) {
      this.board.cards = this.board.cards.filter(c => c.id !== id);
      this.cardEls.get(id)?.remove(); this.cardEls.delete(id);
      this.disposeCardResources(id);
      // Cascade: remove any connection that references the deleted card
      this.board.connections = this.board.connections.filter(
        c => c.fromCardId !== id && c.toCardId !== id
      );
    }
    // Arrows caught by a marquee (drag-box) selection, including
    // free-floating ones with no card at either end to cascade from.
    if (connectionIds.size) {
      this.board.connections = this.board.connections.filter(c => !connectionIds.has(c.id));
      connectionIds.clear();
    }
    this.selection.clear();
    this.refreshSelectionVisuals();
    this.refreshAllConnections();
    this.scheduleSave();
  },

  duplicateSelected(this: FreeformRenderer): void {
    const ids = this.selection.getIds(); if (!ids.length) return;
    this.pushUndo();
    const maxZ = Math.max(0, ...this.board.cards.map(c => c.z ?? 0));
    this.selection.clear(); let zOff = 1;
    for (const id of ids) {
      const orig = this.board.cards.find(c => c.id === id); if (!orig) continue;
      const copy = { ...JSON.parse(JSON.stringify(orig)), id: crypto.randomUUID(), x: snap((orig.x ?? 0) + 20), y: snap((orig.y ?? 0) + 20), z: maxZ + zOff++ } as SupportedCard;
      if (copy.kind === 'kanban-column') {
        copy.items = copy.items.map(item => ({ ...item, id: crypto.randomUUID(), done: false }));
      }
      this.board.cards.push(copy); this.createCardEl(copy); this.selection.add(copy.id);
    }
    this.refreshSelectionVisuals(); this.scheduleSave();
  },

  activateTool(this: FreeformRenderer, name: string, btn: HTMLElement): void {
    if (this.pendingTool === name) { this.clearPendingTool(); return; }
    // Only one tool button may ever show as active at a time — Pen and
    // Line/Connect are separate mode flags from pendingTool, each with
    // their own toolbar highlight, so activating one of these must tear
    // the other two down explicitly rather than relying on them to have
    // cleared themselves already.
    this.exitConnectMode();
    this.exitPenMode();
    this.clearPendingTool();
    // Arming a placement tool implies wanting to click the canvas, which
    // hand mode would swallow as a pan — so picking a tool leaves it.
    this.setInteractionMode('select');
    this.pendingTool = name;
    this.pendingToolBtn = btn;
    btn.addClass('is-active');
    this.setCursor('crosshair');
  },

  clearPendingTool(this: FreeformRenderer): void {
    this.pendingToolBtn?.removeClass('is-active');
    this.pendingTool = null;
    this.pendingToolBtn = null;
    if (!this.connectMode) this.setCursor(this.interactionMode === 'hand' ? 'grab' : '');
  },

  placePendingTool(this: FreeformRenderer, cx: number, cy: number): void {
    const tool = this.pendingTool;
    this.clearPendingTool();
    this.closeOverflow();
    if (!tool) return;
    const s = snap;
    switch (tool) {
      case 'connect':
        this.addDefaultArrowAt(cx, cy); break;
      case 'blank-card':
        this.addBlankCardAt(s(cx - STICKY_DEFAULT_W / 2), s(cy - STICKY_DEFAULT_H / 2)); break;
      case 'text':
        this.addTextCardAt(s(cx - STICKY_DEFAULT_W / 2), s(cy - STICKY_DEFAULT_H / 2)); break;
      case 'sticky':
        this.addStickyAt(s(cx - STICKY_DEFAULT_W / 2), s(cy - STICKY_DEFAULT_H / 2)); break;
      case 'checklist':
        this.addChecklistAt(s(cx - CHECKLIST_DEFAULT_W / 2), s(cy - CHECKLIST_DEFAULT_H / 2)); break;
      case 'comment':
        this.addCommentAt(s(cx - COMMENT_DEFAULT_W / 2), s(cy - COMMENT_DEFAULT_H / 2)); break;
      case 'table':
        this.addTableAt(s(cx - TABLE_DEFAULT_W / 2), s(cy - TABLE_DEFAULT_H / 2)); break;
      case 'kanban':
        this.addKanbanBoardAt(s(cx - (KANBAN_DEFAULT_W * 2 + 12) / 2), s(cy - KANBAN_DEFAULT_H / 2)); break;
      case 'column':
        this.addColumnCardAt(s(cx - COLUMN_DEFAULT_W / 2), s(cy - COLUMN_DEFAULT_H / 2)); break;
      case 'storyboard':
        this.addStoryboardCardAt(s(cx - STORYBOARD_DEFAULT_W / 2), s(cy - STORYBOARD_DEFAULT_H / 2)); break;
      case 'image':
        this.addImageAt(s(cx - IMAGE_DEFAULT_W / 2), s(cy - IMAGE_DEFAULT_H / 2)); break;
      case 'audio':
        this.addAudioAt(s(cx - AUDIO_DEFAULT_W / 2), s(cy - AUDIO_DEFAULT_H / 2)); break;
      case 'video':
        this.addVideoAt(s(cx - VIDEO_DEFAULT_W / 2), s(cy - VIDEO_DEFAULT_H / 2)); break;
      case 'bookmark':
        this.addBookmarkAt(s(cx - BOOKMARK_DEFAULT_W / 2), s(cy - BOOKMARK_DEFAULT_H / 2)); break;
      case 'map':
        this.addMapAt(s(cx - MAP_DEFAULT_W / 2), s(cy - MAP_DEFAULT_H / 2)); break;
      case 'swatch':
        this.addSwatchAt(s(cx - SWATCH_DEFAULT_W / 2), s(cy - SWATCH_DEFAULT_H / 2)); break;
      case 'file':
        this.addFileAt(s(cx - FILE_DEFAULT_W / 2), s(cy - FILE_DEFAULT_H / 2)); break;
      case 'callout':
        this.addCalloutAt(s(cx - CALLOUT_DEFAULT_W / 2), s(cy - CALLOUT_DEFAULT_H / 2)); break;
      case 'group':
        this.addGroupAt(s(cx - GROUP_DEFAULT_W / 2), s(cy - GROUP_DEFAULT_H / 2)); break;
      case 'calendar':
        this.addCalendarAt(s(cx - CALENDAR_DEFAULT_W / 2), s(cy - CALENDAR_DEFAULT_H / 2)); break;
      case 'checkers':
        this.addCheckersAt(s(cx - CHECKERS_DEFAULT_W / 2), s(cy - CHECKERS_DEFAULT_H / 2)); break;
      case 'notelink':
        this.addNoteLinkAt(s(cx - NOTELINK_DEFAULT_W / 2), s(cy - NOTELINK_DEFAULT_H / 2)); break;
      case 'tile':
        this.addTileAt(s(cx - TILE_DEFAULT_W / 2), s(cy - TILE_DEFAULT_H / 2)); break;
      case 'tile-folder':
        new TileModal(this.app, null, (t) => {
          t.x = s(cx - TILE_DEFAULT_W / 2); t.y = s(cy - TILE_DEFAULT_H / 2);
          t.w = TILE_DEFAULT_W; t.h = TILE_DEFAULT_H; t.z = this.nextZ();
          this.pushUndo(); this.board.cards.push(t); void this.saveNow();
          this.createCardEl(t); this.selection.select(t.id); this.refreshSelectionVisuals();
        }, this.file, 'folder').open(); break;
      case 'tile-canvas':
        new TileModal(this.app, null, (t) => {
          t.x = s(cx - TILE_DEFAULT_W / 2); t.y = s(cy - TILE_DEFAULT_H / 2);
          t.w = TILE_DEFAULT_W; t.h = TILE_DEFAULT_H; t.z = this.nextZ();
          this.pushUndo(); this.board.cards.push(t); void this.saveNow();
          this.createCardEl(t); this.selection.select(t.id); this.refreshSelectionVisuals();
        }, this.file, 'canvas').open(); break;
      case 'tile-board':
        new TileModal(this.app, null, (t) => {
          t.x = s(cx - TILE_DEFAULT_W / 2); t.y = s(cy - TILE_DEFAULT_H / 2);
          t.w = TILE_DEFAULT_W; t.h = TILE_DEFAULT_H; t.z = this.nextZ();
          this.pushUndo(); this.board.cards.push(t); void this.saveNow();
          this.createCardEl(t); this.selection.select(t.id); this.refreshSelectionVisuals();
        }, this.file, 'board').open(); break;
    }
  },

  isOverTrash(this: FreeformRenderer, clientX: number, clientY: number): boolean {
    if (!this.trashZoneEl) return false;
    const r = this.trashZoneEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  },

  setTrashHover(this: FreeformRenderer, clientX: number, clientY: number): void {
    this.trashZoneEl?.toggleClass('is-drag-over', this.isOverTrash(clientX, clientY));
  },

  clearTrashHover(this: FreeformRenderer): void {
    this.trashZoneEl?.removeClass('is-drag-over');
  },

  centerOnCard(this: FreeformRenderer, id: string): void {
    const card = this.board.cards.find(c => c.id === id);
    if (!card) return;
    const rect = this.outer.getBoundingClientRect();
    const cx = (card.x ?? 0) + (card.w ?? TILE_DEFAULT_W) / 2;
    const cy = (card.y ?? 0) + (card.h ?? TILE_DEFAULT_H) / 2;
    this.vp = {
      x: rect.width / 2 - cx * this.vp.zoom,
      y: rect.height / 2 - cy * this.vp.zoom,
      zoom: this.vp.zoom,
    };
    this.applyViewport();
    this.scheduleSave();
  },

  initConnectionLayer(this: FreeformRenderer): void {
    // Visual layer — behind cards (first child of inner)
    const svg = createSvg('svg');
    svg.classList.add('visual-notes-connections-svg');
    if (this.inner.firstChild) this.inner.insertBefore(svg, this.inner.firstChild);
    else this.inner.appendChild(svg);
    this.svgEl = svg;

    // Hit layer — above all cards so connection lines are always clickable
    const hitSvg = createSvg('svg');
    hitSvg.classList.add('visual-notes-connections-hit-svg');
    this.inner.appendChild(hitSvg);
    this.hitSvgEl = hitSvg;
  },

  initInkLayer(this: FreeformRenderer): void {
    const svg = createSvg('svg');
    svg.classList.add('visual-notes-ink-svg');
    this.inner.appendChild(svg);
    this.inkSvgEl = svg;
  },

  renderAllDrawings(this: FreeformRenderer): void {
    this.inkPaths.forEach(p => p.remove()); this.inkPaths.clear();
    this.inkHitPaths.forEach(p => p.remove()); this.inkHitPaths.clear();
    for (const stroke of this.board.drawings) this.renderSingleDrawing(stroke);
  },

  buildInkPathD(this: FreeformRenderer, points: { x: number; y: number }[]): string {
    if (points.length === 0) return '';
    const r = (n: number) => Math.round(n * 100) / 100;
    if (points.length < 3) {
      let d = `M ${r(points[0].x)} ${r(points[0].y)}`;
      for (let i = 1; i < points.length; i++) d += ` L ${r(points[i].x)} ${r(points[i].y)}`;
      return d;
    }
    let d = `M ${r(points[0].x)} ${r(points[0].y)}`;
    let i = 1;
    for (; i < points.length - 2; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      d += ` Q ${r(points[i].x)} ${r(points[i].y)}, ${r(midX)} ${r(midY)}`;
    }
    d += ` Q ${r(points[i].x)} ${r(points[i].y)}, ${r(points[i + 1].x)} ${r(points[i + 1].y)}`;
    return d;
  },

  isHighlightStroke(this: FreeformRenderer, stroke: DrawingStroke): boolean {
    return stroke.opacity != null;
  },

  buildStrokePathD(this: FreeformRenderer, stroke: DrawingStroke): string {
    return this.isHighlightStroke(stroke)
      ? this.buildHighlightOutlineD(stroke)
      : this.buildPenOutlineD(stroke);
  },

  // Pen strokes render as a filled outline (like the highlighter) rather
  // than a constant-width stroked polyline, via perfect-freehand.
  //
  // Options come from this.penDrawOptions (tuned live via the pen options
  // panel — see pen-options-panel.ts), not from stroke.width/pressure: this
  // means the Thin/Medium/Thick picker and real Apple Pencil/Wacom pressure
  // don't change the rendered shape, and every stroke on the board re-
  // renders through the same shared, currently-live config — an
  // intentional simplification, not a bug.
  buildPenOutlineD(this: FreeformRenderer, stroke: DrawingStroke): string {
    const pts = stroke.points;
    if (pts.length === 0) return '';
    const o = this.penDrawOptions;
    const outline = getStroke(
      pts.map(p => [p.x, p.y, p.p ?? 0.5]),
      {
        size: o.size,
        smoothing: o.smoothing,
        thinning: o.thinning,
        streamline: o.streamline,
        easing: EASING_FNS[o.easing],
        start: { taper: o.taperStart, cap: o.capStart },
        end: { taper: o.taperEnd, cap: o.capEnd },
      },
    );
    if (outline.length < 3) return this.buildInkPathD(pts);
    const r = (n: number) => Math.round(n * 100) / 100;
    let d = `M ${r(outline[0][0])} ${r(outline[0][1])}`;
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i - 1];
      const [x1, y1] = outline[i];
      d += ` Q ${r(x0)} ${r(y0)}, ${r((x0 + x1) / 2)} ${r((y0 + y1) / 2)}`;
    }
    return d + ' Z';
  },

  buildHighlightOutlineD(this: FreeformRenderer, stroke: DrawingStroke): string {
    // Resample first: straight-line strokes (Shift-drawn or auto-straightened)
    // are stored as just two points, which would outline as a perfect
    // rectangle — no hand-drawn character at all. Inserting points every
    // ~12px along long segments gives the wobble something to grip.
    const pts: { x: number; y: number }[] = [];
    const SAMPLE = 12;
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      if (pts.length) {
        const prev = pts[pts.length - 1];
        const segLen = Math.hypot(p.x - prev.x, p.y - prev.y);
        const steps = Math.floor(segLen / SAMPLE);
        for (let s = 1; s <= steps; s++) {
          const t = s / (steps + 1);
          pts.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
        }
      }
      pts.push({ ...p });
    }
    if (pts.length < 2) return '';

    let seed = 0;
    for (let i = 0; i < stroke.id.length; i++) seed = (seed * 31 + stroke.id.charCodeAt(i)) >>> 0;
    const rand = (i: number): number => {
      let x = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0;
      x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
      return ((x >>> 8) / 0xffffff) * 2 - 1; // -1..1
    };

    const r = (n: number) => Math.round(n * 100) / 100;
    const half = stroke.width / 2;
    const left: { x: number; y: number }[] = [];
    const right: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy, ny = dx;
      // Independent wobble per side so the two edges don't move in lockstep
      // (which would read as the whole line wiggling, not a rough edge).
      const wobA = 1 + rand(i) * 0.13;
      const wobB = 1 + rand(i + 7919) * 0.13;
      left.push({ x: pts[i].x + nx * half * wobA, y: pts[i].y + ny * half * wobA });
      right.push({ x: pts[i].x - nx * half * wobB, y: pts[i].y - ny * half * wobB });
    }
    let d = `M ${r(left[0].x)} ${r(left[0].y)}`;
    for (let i = 1; i < left.length; i++) d += ` L ${r(left[i].x)} ${r(left[i].y)}`;
    for (let i = right.length - 1; i >= 0; i--) d += ` L ${r(right[i].x)} ${r(right[i].y)}`;
    return d + ' Z';
  },

  renderSingleDrawing(this: FreeformRenderer, stroke: DrawingStroke): void {
    const d = this.buildInkPathD(stroke.points);

    const path = createSvg('path');
    if (this.isHighlightStroke(stroke)) {
      path.setAttribute('d', this.buildHighlightOutlineD(stroke));
      path.setAttribute('fill', stroke.color);
      path.setAttribute('fill-opacity', String(stroke.opacity));
      path.setAttribute('stroke', 'none');
      path.classList.add('visual-notes-highlight-stroke');
    } else {
      // Filled pressure-tapered ribbon, not a stroked polyline — see
      // buildPenOutlineD.
      path.setAttribute('d', this.buildPenOutlineD(stroke));
      path.setAttribute('fill', stroke.color);
      path.setAttribute('stroke', 'none');
    }
    path.setAttribute('pointer-events', 'none');
    this.inkSvgEl.appendChild(path);
    this.inkPaths.set(stroke.id, path);

    // Invisible, much thicker hit path so a thin stroke is still easy to
    // click for selection — same trick used for connection lines.
    const hit = createSvg('path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', String(Math.max(16, stroke.width + 12)));
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke-linecap', 'round');
    hit.setAttribute('stroke-linejoin', 'round');
    hit.setCssStyles({ cursor: 'pointer', pointerEvents: this.penModeActive ? 'none' : 'stroke' });
    hit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      this.selectDrawing(stroke.groupId, additive);
      // A modifier-click only toggles selection membership — same as card
      // multi-select, it doesn't also start a drag.
      if (additive) return;

      // Drags every currently-selected group together (not just the one
      // clicked) — selectDrawing above only replaced the selection if the
      // clicked stroke wasn't already part of it, so an existing
      // multi-selection survives a plain click-and-drag on one of its
      // members, matching card behavior.
      const groupIds: string[] = [...this.selectedDrawingIds];
      // A plain loop (not .flatMap) — some type checkers lose track of
      // `this` inside an arrow callback passed to a generic Array method
      // like flatMap, flagging the call as unsafe even though the return
      // type is pinned explicitly; a for..of over a plain method call
      // (same shape as the working loop in rerenderGroup) sidesteps it.
      const groupStrokes: DrawingStroke[] = [];
      for (const id of groupIds) {
        const strokesInGroup: DrawingStroke[] = this.groupStrokes(id);
        groupStrokes.push(...strokesInGroup);
      }
      const startPoints: DrawingStroke['points'][] = groupStrokes.map(s => s.points.map(p => ({ ...p })));
      const sx = e.clientX, sy = e.clientY;
      let moved = false;

      const onMove = (e2: PointerEvent) => {
        if (!moved && Math.hypot(e2.clientX - sx, e2.clientY - sy) < DRAG_THRESHOLD) return;
        if (!moved) { moved = true; this.pushUndo(); }
        const dx = (e2.clientX - sx) / this.vp.zoom;
        const dy = (e2.clientY - sy) / this.vp.zoom;
        groupStrokes.forEach((s, i) => {
          s.points = startPoints[i].map(p =>
            p.p != null
              ? { x: p.x + dx, y: p.y + dy, p: p.p }
              : { x: p.x + dx, y: p.y + dy },
          );
          this.inkPaths.get(s.id)?.setAttribute('d', this.buildStrokePathD(s));
          this.inkHitPaths.get(s.id)?.setAttribute('d', this.buildInkPathD(s.points));
        });
        this.refreshDrawingSelectionVisual();
        this.setTrashHover(e2.clientX, e2.clientY);
      };
      const onUp = (e2: PointerEvent) => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
        this.clearTrashHover();
        // Dropped on the trash zone: delete every dragged sketch group. The
        // drag's own pushUndo (on first movement) already covers this, so
        // one undo brings every group back where it started.
        if (moved && this.isOverTrash(e2.clientX, e2.clientY)) {
          this.board.drawings = this.board.drawings.filter(s => !groupIds.includes(s.groupId));
          for (const s of groupStrokes) {
            this.inkPaths.get(s.id)?.remove(); this.inkPaths.delete(s.id);
            this.inkHitPaths.get(s.id)?.remove(); this.inkHitPaths.delete(s.id);
          }
          this.deselectDrawing();
          this.scheduleSave();
          return;
        }
        if (moved) this.scheduleSave();
      };
      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!this.selectedDrawingIds.has(stroke.groupId)) this.selectDrawing(stroke.groupId);
      this.showDrawingMenu(e, [...this.selectedDrawingIds]);
    });
    this.inkSvgEl.appendChild(hit);
    this.inkHitPaths.set(stroke.id, hit);
  },

  groupStrokes(this: FreeformRenderer, groupId: string): DrawingStroke[] {
    return this.board.drawings.filter(s => s.groupId === groupId);
  },

  selectDrawing(this: FreeformRenderer, groupId: string, additive = false): void {
    if (additive) {
      if (this.selectedDrawingIds.has(groupId)) this.selectedDrawingIds.delete(groupId);
      else this.selectedDrawingIds.add(groupId);
    } else if (this.selectedDrawingIds.size === 1 && this.selectedDrawingIds.has(groupId)) {
      // Already the sole selection — nothing to change.
      this.outer.focus();
      return;
    } else if (!this.selectedDrawingIds.has(groupId)) {
      // Only reset to a single-group selection when the clicked stroke
      // isn't already part of the current (possibly multi-group)
      // selection — so a plain click-and-drag on an already-selected
      // stroke keeps the whole selection intact, same as cards.
      this.selection.clear(); this.refreshSelectionVisuals();
      this.deselectConnection();
      this.selectedDrawingIds = new Set([groupId]);
    }
    this.refreshDrawingSelectionVisual();
    this.outer.focus();
  },

  refreshDrawingSelectionVisual(this: FreeformRenderer): void {
    this.inkSelectGroup?.remove();
    this.inkSelectGroup = null;
    if (this.selectedDrawingIds.size === 0) { this.removeDrawingBox(); return; }

    const g = createSvg('g');
    g.setAttribute('pointer-events', 'none');
    for (const groupId of this.selectedDrawingIds) {
      for (const stroke of this.groupStrokes(groupId)) {
        const p = createSvg('path');
        p.setAttribute('d', this.buildInkPathD(stroke.points));
        p.setAttribute('stroke', 'var(--interactive-accent)');
        p.setAttribute('stroke-width', String(stroke.width + 8));
        p.setAttribute('stroke-opacity', '0.3');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        g.appendChild(p);
      }
    }
    this.inkSvgEl.insertBefore(g, this.inkSvgEl.firstChild);
    this.inkSelectGroup = g;

    // Resize handles only make sense for a single group at a time — a
    // multi-group selection still shows the halo above, just without a box.
    if (this.selectedDrawingIds.size === 1) {
      const groupId = [...this.selectedDrawingIds][0];
      const bbox = this.computeGroupBBox(groupId);
      if (bbox) this.renderDrawingBox(groupId, bbox);
      else this.removeDrawingBox();
    } else {
      this.removeDrawingBox();
    }
  },

  deselectDrawing(this: FreeformRenderer): void {
    this.inkSelectGroup?.remove();
    this.inkSelectGroup = null;
    this.selectedDrawingIds.clear();
    this.removeDrawingBox();
  },

  computeGroupBBox(this: FreeformRenderer, groupId: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const strokes = this.groupStrokes(groupId);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      const pad = s.width / 2;
      for (const p of s.points) {
        minX = Math.min(minX, p.x - pad); maxX = Math.max(maxX, p.x + pad);
        minY = Math.min(minY, p.y - pad); maxY = Math.max(maxY, p.y + pad);
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  },

  // True point-to-point proximity, not "inside the group's bounding box" —
  // a bbox check let a stroke starting anywhere inside a large or
  // diagonal shape's rectangle (e.g. a big circle, or a line from corner
  // to corner) get pulled into the group even when it started nowhere near
  // the actual drawn line, which is what "too aggressive" grouping meant
  // in practice. Same reach math as the eraser's hit test.
  isNearGroup(this: FreeformRenderer, groupId: string, point: { x: number; y: number }, threshold: number): boolean {
    for (const s of this.groupStrokes(groupId)) {
      const reach = threshold + s.width / 2;
      for (const p of s.points) {
        if (Math.hypot(p.x - point.x, p.y - point.y) <= reach) return true;
      }
    }
    return false;
  },

  renderDrawingBox(this: FreeformRenderer, groupId: string, bbox: { minX: number; minY: number; maxX: number; maxY: number }): void {
    this.removeDrawingBox();
    const box = this.inner.createDiv('visual-notes-drawing-select-box');
    box.style.left = `${bbox.minX}px`;
    box.style.top = `${bbox.minY}px`;
    box.style.width = `${Math.max(1, bbox.maxX - bbox.minX)}px`;
    box.style.height = `${Math.max(1, bbox.maxY - bbox.minY)}px`;
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = box.createDiv(`visual-notes-drawing-resize-handle visual-notes-drawing-resize-handle--${corner}`);
      handle.addEventListener('pointerdown', (e) => this.startDrawingResize(e, groupId, corner));
    }
    this.drawingBoxEl = box;
  },

  removeDrawingBox(this: FreeformRenderer): void {
    this.drawingBoxEl?.remove();
    this.drawingBoxEl = null;
  },

  startDrawingResize(this: FreeformRenderer, e: PointerEvent, groupId: string, corner: 'nw' | 'ne' | 'sw' | 'se'): void {
    e.stopPropagation(); e.preventDefault();
    const strokes = this.groupStrokes(groupId);
    const bbox = this.computeGroupBBox(groupId);
    if (!bbox || !strokes.length) return;
    this.pushUndo();

    const startPoints = strokes.map(s => s.points.map(p => ({ ...p })));
    const startWidths = strokes.map(s => s.width);
    const anchorX = corner.includes('w') ? bbox.maxX : bbox.minX;
    const anchorY = corner.includes('n') ? bbox.maxY : bbox.minY;
    const dragStartX = corner.includes('w') ? bbox.minX : bbox.maxX;
    const dragStartY = corner.includes('n') ? bbox.minY : bbox.maxY;
    const spanX = dragStartX - anchorX;
    const spanY = dragStartY - anchorY;
    const sx = e.clientX, sy = e.clientY;
    const MIN_SCALE = 0.15;

    const clampScale = (scale: number): number => {
      if (Math.abs(scale) < MIN_SCALE) return scale < 0 ? -MIN_SCALE : MIN_SCALE;
      return scale;
    };

    const onMove = (e2: PointerEvent) => {
      const dx = (e2.clientX - sx) / this.vp.zoom;
      const dy = (e2.clientY - sy) / this.vp.zoom;
      const scaleX = clampScale(spanX !== 0 ? (spanX + dx) / spanX : 1);
      const scaleY = clampScale(spanY !== 0 ? (spanY + dy) / spanY : 1);
      const widthScale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;

      strokes.forEach((s, i) => {
        s.points = startPoints[i].map(p =>
          p.p != null
            ? {
                x: anchorX + (p.x - anchorX) * scaleX,
                y: anchorY + (p.y - anchorY) * scaleY,
                p: p.p,
              }
            : {
                x: anchorX + (p.x - anchorX) * scaleX,
                y: anchorY + (p.y - anchorY) * scaleY,
              },
        );
        s.width = Math.max(1, startWidths[i] * widthScale);
        // Highlight strokes bake the width into their filled outline, so
        // regenerating d covers them; stroke-width only matters for pen ink.
        this.inkPaths.get(s.id)?.setAttribute('d', this.buildStrokePathD(s));
        if (!this.isHighlightStroke(s)) this.inkPaths.get(s.id)?.setAttribute('stroke-width', String(s.width));
        this.inkHitPaths.get(s.id)?.setAttribute('d', this.buildInkPathD(s.points));
        this.inkHitPaths.get(s.id)?.setAttribute('stroke-width', String(Math.max(16, s.width + 12)));
      });
      this.refreshDrawingSelectionVisual();
    };
    const onUp = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      this.scheduleSave();
    };
    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
  },

  deleteSelectedDrawing(this: FreeformRenderer): void {
    if (this.selectedDrawingIds.size === 0) return;
    const groupIds = [...this.selectedDrawingIds];
    this.pushUndo();
    const toRemove = this.board.drawings.filter(s => groupIds.includes(s.groupId));
    this.board.drawings = this.board.drawings.filter(s => !groupIds.includes(s.groupId));
    for (const s of toRemove) {
      this.inkPaths.get(s.id)?.remove(); this.inkPaths.delete(s.id);
      this.inkHitPaths.get(s.id)?.remove(); this.inkHitPaths.delete(s.id);
    }
    this.deselectDrawing();
    this.scheduleSave();
  },

  rerenderGroup(this: FreeformRenderer, groupId: string): void {
    const wasSelected = this.selectedDrawingIds.has(groupId);
    for (const s of this.groupStrokes(groupId)) {
      this.inkPaths.get(s.id)?.remove(); this.inkPaths.delete(s.id);
      this.inkHitPaths.get(s.id)?.remove(); this.inkHitPaths.delete(s.id);
      this.renderSingleDrawing(s);
    }
    if (wasSelected) this.refreshDrawingSelectionVisual();
  },

  showDrawingMenu(this: FreeformRenderer, e: MouseEvent, groupIds: string[]): void {
    // Plain loop, not .flatMap — see the comment on the matching pattern in
    // the drag handler above.
    const strokes: DrawingStroke[] = [];
    for (const id of groupIds) {
      const strokesInGroup: DrawingStroke[] = this.groupStrokes(id);
      strokes.push(...strokesInGroup);
    }
    if (!strokes.length) return;
    const menu = this.newMenu();
    menu.addItem(i => i.setTitle('Change color…').setIcon('palette').onClick(() => {
      new KanbanItemColorModal(this.app, strokes[0].color, (hex) => {
        if (!hex) return;
        this.pushUndo();
        for (const s of strokes) s.color = hex;
        for (const id of groupIds) this.rerenderGroup(id);
        this.scheduleSave();
      }, this.boardIsDark()).open();
    }));
    // Highlighter strokes carry the marker's 3.5× width scale, so the same
    // Thin/Medium/Thick labels map to proportionally broader ink for them.
    const setWidth = (w: number) => {
      this.pushUndo();
      for (const s of strokes) s.width = w * (this.isHighlightStroke(s) ? 3.5 : 1);
      for (const id of groupIds) this.rerenderGroup(id);
      this.scheduleSave();
    };
    menu.addItem(i => i.setTitle('Thin').setIcon('minus').onClick(() => setWidth(2)));
    menu.addItem(i => i.setTitle('Medium').setIcon('minus').onClick(() => setWidth(4)));
    menu.addItem(i => i.setTitle('Thick').setIcon('minus').onClick(() => setWidth(8)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('Copy').setIcon('copy').onClick(() => this.copySelection()));
    menu.addItem(i => i.setTitle('Cut').setIcon('scissors').onClick(() => this.copySelection(true)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle(groupIds.length > 1 ? `Delete ${groupIds.length} sketches` : 'Delete').setIcon('trash').onClick(() => this.deleteSelectedDrawing()));
    menu.showAtMouseEvent(e);
  },

  startInkStroke(this: FreeformRenderer, startEvent: PointerEvent): void {
    // Every pen-mode pointerdown funnels through here (canvas, cards, kanban
    // items, column children all call it), so the eraser branch lives at the
    // top rather than being re-checked at each call site.
    if (this.penTool === 'eraser') { this.startEraseScrub(startEvent); return; }

    // Never start a stroke from a secondary touch — the second finger of a
    // pinch-zoom gesture fires its own pointerdown (isPrimary: false), which
    // used to draw a line while zooming. Both checks below are scoped to
    // finger input only: there's no such thing as a second Apple Pencil, so
    // for pen input a false isPrimary or a stray activeTouches count is
    // just WebKit's own hover/touch bookkeeping around the same lift-and-
    // retouch transition mentioned below, not a real second contact —
    // treating it as one was silently discarding whole strokes with no
    // palm or extra finger anywhere near the screen.
    const isTouchStroke = startEvent.pointerType === 'touch';
    if (isTouchStroke && (!startEvent.isPrimary || this.activeTouches >= 2)) return;

    // Defensive: force-close any stroke still waiting on its own pointerup/
    // pointercancel before starting a new one. Reported specifically with
    // hover-capable Apple Pencil (iPad Pro + Pencil 2/Pro) — finger touches
    // were unaffected — as the Pencil "stopping responding" after the first
    // stroke. Apple Pencil keeps the same pointerId across separate taps
    // (it's tracked as one persistent hoverable device, unlike a finger
    // touch, which always gets a fresh id), and can emit hover-driven
    // pointer activity around the lift/re-touch transition; if that means
    // the previous stroke's pointerup is ever missed or delayed past the
    // next stroke's pointerdown, its listeners were left dangling forever,
    // silently absorbing events the new stroke needed. Whatever the exact
    // WebKit sequence, this guarantees the new stroke always starts clean.
    this.activeStrokeAbort?.();

    const isHighlighter = this.penTool === 'highlighter';
    const rect = this.outer.getBoundingClientRect();
    // Pen strokes drawn close together share a group so a multi-stroke
    // sketch acts as one unit — but a new stroke only joins the current
    // group if it actually starts near it; one that starts far away (e.g.
    // a second, unrelated doodle drawn without toggling the Pen tool off
    // in between) starts a fresh group instead of getting lumped into the
    // first one. Highlighter strokes always get their own fresh group
    // regardless — each swipe marks its own word or area and stays
    // independently selectable, movable, and deletable.
    const PEN_GROUP_PROXIMITY = 48; // canvas px
    let groupId: string;
    if (isHighlighter) {
      groupId = crypto.randomUUID();
    } else {
      const startCp = screenToCanvas(startEvent.clientX - rect.left, startEvent.clientY - rect.top, this.vp);
      const nearCurrentGroup = !!this.currentPenGroupId
        && this.isNearGroup(this.currentPenGroupId, startCp, PEN_GROUP_PROXIMITY);
      groupId = nearCurrentGroup ? this.currentPenGroupId! : (this.currentPenGroupId = crypto.randomUUID());
    }
    const stroke: DrawingStroke = {
      id: crypto.randomUUID(),
      groupId,
      points: [],
      color: isHighlighter ? this.currentHighlightColor : this.currentInkColor,
      // A real highlighter is a broad chisel of translucent ink — scale the
      // chosen pen width up rather than asking for a separate width setting.
      width: isHighlighter ? this.currentInkWidth * 3.5 : this.currentInkWidth,
      opacity: isHighlighter ? 0.45 : undefined,
    };
    // Highlighter strokes still go through the old capture pipeline: drop
    // pointermove samples closer together than ~4 screen px, then a
    // trailing exponential smoothing pass on top, since buildHighlightOutlineD
    // draws straight through whatever points it's given and has no smoothing
    // of its own.
    //
    // Pen strokes skip both — perfect-freehand's own `smoothing`/`streamline`
    // options (see buildPenOutlineD) are built to consume a raw, noisy
    // pointer stream directly, and pre-smoothing here fought them: the
    // distance cutoff silently dropped real pressure changes recorded while
    // the pen barely moved (pressing harder mid-stroke without much
    // travel), and the trailing lag blurred exactly the kind of fine
    // position detail the pressure taper is supposed to ride on.
    const MIN_POINT_DIST = 4 / this.vp.zoom;
    const TRAIL = 0.35;
    let smoothed: { x: number; y: number } | null = null;
    const addPoint = (clientX: number, clientY: number, pressure?: number) => {
      const cp = screenToCanvas(clientX - rect.left, clientY - rect.top, this.vp);
      // Only store real stylus pressure — mouse/touch report a constant
      // 0.5/0, which buildPenOutlineD treats as "no data, simulate".
      const p = pressure != null && pressure > 0 && pressure !== 0.5 ? pressure : undefined;
      if (!isHighlighter) {
        stroke.points.push(p != null ? { x: cp.x, y: cp.y, p } : { x: cp.x, y: cp.y });
        return;
      }
      smoothed = smoothed
        ? { x: smoothed.x + (cp.x - smoothed.x) * TRAIL, y: smoothed.y + (cp.y - smoothed.y) * TRAIL }
        : { x: cp.x, y: cp.y };
      const last = stroke.points[stroke.points.length - 1];
      if (last && Math.hypot(smoothed.x - last.x, smoothed.y - last.y) < MIN_POINT_DIST) return;
      stroke.points.push(p != null ? { x: smoothed.x, y: smoothed.y, p } : { x: smoothed.x, y: smoothed.y });
    };
    addPoint(startEvent.clientX, startEvent.clientY, startEvent.pressure);
    // Anchor for Shift-drawn straight lines: the true (unsmoothed) start.
    const firstPoint = { ...stroke.points[0] };

    const livePath = createSvg('path');
    if (isHighlighter) {
      livePath.setAttribute('fill', stroke.color);
      livePath.setAttribute('fill-opacity', String(stroke.opacity));
      livePath.setAttribute('stroke', 'none');
      livePath.classList.add('visual-notes-highlight-stroke');
    } else {
      livePath.setAttribute('fill', stroke.color);
      livePath.setAttribute('stroke', 'none');
    }
    livePath.setAttribute('pointer-events', 'none');
    livePath.setAttribute('d', this.buildStrokePathD(stroke));
    this.inkSvgEl.appendChild(livePath);

    // Every other drag-style gesture in this file (card drag, connection
    // drag, resize handles) filters move/up events to the pointerId that
    // actually started it — this one didn't. Since these listeners live on
    // activeDocument (not a narrow element), they heard *any* pointer's
    // events: a palm-rejection contact, a stray second touch, or the next
    // stroke's own pointerdown landing before this one's listeners finished
    // detaching could all feed points into the wrong stroke — reported as
    // the second stroke of a quick pair coming out corrupted.
    const pointerId = startEvent.pointerId;
    // Batch live-outline recomputes to one per animation frame — on a
    // 120Hz stylus (iPad) getStroke over the whole growing point array on
    // every single pointermove was heavy enough to visibly lag the line.
    let rafId = 0;
    const redrawLive = () => { rafId = 0; livePath.setAttribute('d', this.buildStrokePathD(stroke)); };
    const onMove = (e2: PointerEvent) => {
      if (e2.pointerId !== pointerId) return;
      // A second finger landing mid-stroke means this "stroke" is really a
      // pinch — abort it entirely rather than committing a stray line.
      // Same finger-only gate as the start check above: a Pencil stroke
      // shouldn't be discarded because a palm settled onto the glass mid-word.
      if (isTouchStroke && this.activeTouches >= 2) { onCancel(); return; }
      if (e2.shiftKey) {
        // Ruler mode: while Shift is held the stroke is just anchor →
        // pointer, redrawn live as a perfectly straight segment. Releasing
        // Shift mid-stroke resumes freehand from wherever the line ended.
        const cp = screenToCanvas(e2.clientX - rect.left, e2.clientY - rect.top, this.vp);
        const p = e2.pressure > 0 && e2.pressure !== 0.5 ? e2.pressure : undefined;
        stroke.points = [{ ...firstPoint }, p != null ? { x: cp.x, y: cp.y, p } : { x: cp.x, y: cp.y }];
        smoothed = { x: cp.x, y: cp.y };
      } else {
        addPoint(e2.clientX, e2.clientY, e2.pressure);
      }
      if (!rafId) rafId = window.requestAnimationFrame(redrawLive);
    };
    const removeListeners = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      activeDocument.removeEventListener('pointercancel', onCancel);
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
      // Only clear if this stroke is still the one on record — the
      // defensive call in startInkStroke already reassigns this to the
      // *new* stroke's own abort before that new stroke's setup finishes,
      // so an old, already-superseded removeListeners running late (there
      // shouldn't be a path where it does, but this is cheap insurance)
      // can't null out a newer stroke's still-active entry.
      if (this.activeStrokeAbort === abortThisStroke) this.activeStrokeAbort = null;
    };
    // iOS fires pointercancel (not pointerup) when the OS takes the touch
    // over — palm rejection, a pinch, a system gesture. Without handling
    // it, the move/up listeners above stayed attached and the next stroke
    // fought them — the "can't draw again for a second" symptom. Also
    // called directly (no event) from onMove's own pinch-abort check above,
    // and from the next stroke's defensive activeStrokeAbort call — both
    // already only run for the matching pointerId or don't pass one.
    const onCancel = (e2?: PointerEvent) => {
      if (e2 && e2.pointerId !== pointerId) return;
      removeListeners(); livePath.remove();
    };
    const abortThisStroke = () => onCancel();
    this.activeStrokeAbort = abortThisStroke;
    const onUp = (e2: PointerEvent) => {
      if (e2.pointerId !== pointerId) return;
      removeListeners();
      // Snap the very last point to the true release position — highlighter
      // strokes still run through addPoint's trailing smoothing, which
      // intentionally lags a bit behind the live pointer for a fluid line,
      // so without this the stroke would stop just short of wherever the
      // pointer was actually lifted.
      const cp = screenToCanvas(e2.clientX - rect.left, e2.clientY - rect.top, this.vp);
      const lastP = e2.pressure > 0 && e2.pressure !== 0.5 ? e2.pressure : undefined;
      const last = stroke.points[stroke.points.length - 1];
      if (!last || Math.hypot(cp.x - last.x, cp.y - last.y) > 0.01) {
        stroke.points.push(lastP != null ? { x: cp.x, y: cp.y, p: lastP } : { x: cp.x, y: cp.y });
      }
      livePath.remove();
      if (stroke.points.length < 2) return;
      this.pushUndo();
      this.board.drawings.push(stroke);
      this.renderSingleDrawing(stroke);
      this.scheduleSave();
    };
    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
    activeDocument.addEventListener('pointercancel', onCancel);
  },


  startEraseScrub(this: FreeformRenderer, startEvent: PointerEvent): void {
    const rect = this.outer.getBoundingClientRect();
    let erasedAny = false;
    type Pt = { x: number; y: number };

    // Distance-based checks against sampled *points* alone made straight
    // lines nearly impossible to erase mid-span — a straight segment is
    // stored as just its two endpoints, so criss-crossing its middle never
    // came near any stored point. The scrub is treated as a moving line
    // segment instead: a stroke is hit when the eraser's movement vector
    // intersects one of its segments, or passes within reach of one
    // (point-to-segment distance, covering slow scrubs and endpoints).
    const segSegIntersect = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
      const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
    };
    const pointSegDist = (p: Pt, a: Pt, b: Pt): number => {
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
      return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    };

    // Per-stroke AABBs, cached once at scrub start — a cheap rect test
    // rejects far-away strokes before any per-segment math runs.
    const aabbs = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const s of this.board.drawings) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const pad = s.width / 2;
      for (const p of s.points) {
        if (p.x - pad < minX) minX = p.x - pad; if (p.x + pad > maxX) maxX = p.x + pad;
        if (p.y - pad < minY) minY = p.y - pad; if (p.y + pad > maxY) maxY = p.y + pad;
      }
      aabbs.set(s.id, { minX, minY, maxX, maxY });
    }

    let prev: Pt | null = null;
    const eraseAlong = (clientX: number, clientY: number) => {
      const cur = screenToCanvas(clientX - rect.left, clientY - rect.top, this.vp);
      const from = prev ?? cur;
      prev = cur;
      const radius = 10 / this.vp.zoom;
      const moveMinX = Math.min(from.x, cur.x), moveMaxX = Math.max(from.x, cur.x);
      const moveMinY = Math.min(from.y, cur.y), moveMaxY = Math.max(from.y, cur.y);
      const hits = this.board.drawings.filter(s => {
        const reach = radius + s.width / 2;
        const bb = aabbs.get(s.id);
        if (bb && (moveMaxX < bb.minX - radius || moveMinX > bb.maxX + radius
          || moveMaxY < bb.minY - radius || moveMinY > bb.maxY + radius)) return false;
        for (let i = 0; i < s.points.length; i++) {
          const p1 = s.points[i];
          if (i + 1 < s.points.length) {
            const p2 = s.points[i + 1];
            if (segSegIntersect(from, cur, p1, p2)) return true;
            if (pointSegDist(cur, p1, p2) <= reach) return true;
          } else if (Math.hypot(p1.x - cur.x, p1.y - cur.y) <= reach) {
            return true;
          }
        }
        return false;
      });
      if (!hits.length) return;
      if (!erasedAny) { erasedAny = true; this.pushUndo(); }
      const ids = new Set(hits.map(s => s.id));
      this.board.drawings = this.board.drawings.filter(s => !ids.has(s.id));
      for (const s of hits) {
        this.inkPaths.get(s.id)?.remove(); this.inkPaths.delete(s.id);
        this.inkHitPaths.get(s.id)?.remove(); this.inkHitPaths.delete(s.id);
      }
    };
    eraseAlong(startEvent.clientX, startEvent.clientY);

    const onMove = (e2: PointerEvent) => eraseAlong(e2.clientX, e2.clientY);
    const onUp = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      activeDocument.removeEventListener('pointercancel', onUp);
      if (erasedAny) this.scheduleSave();
    };
    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
    activeDocument.addEventListener('pointercancel', onUp);
  },

  togglePenMode(this: FreeformRenderer): void {
    if (this.penModeActive) this.exitPenMode(); else this.enterPenMode();
  },

  enterPenMode(this: FreeformRenderer): void {
    this.exitConnectMode();
    this.clearPendingTool();
    this.deselectConnection();
    this.deselectDrawing();
    this.penModeActive = true;
    this.currentPenGroupId = crypto.randomUUID();
    this.outer.addClass('is-pen-mode');
    // penTool persists across sessions, so re-entering pen mode with the
    // eraser still selected needs the eraser cursor back immediately.
    this.outer.toggleClass('is-eraser-mode', this.penTool === 'eraser');
    this.penToolBtn?.addClass('is-active');
    this.inkHitPaths.forEach(p => { p.setCssStyles({ pointerEvents: 'none' }); });
    this.showPenColorPicker();
    this.showPenBanner();
  },

  exitPenMode(this: FreeformRenderer): void {
    this.penModeActive = false;
    // Ends the session — the next stroke (from either a fresh enterPenMode
    // or, defensively, a stray call) starts a new group rather than
    // silently joining whatever was just finished.
    this.currentPenGroupId = null;
    this.outer.removeClass('is-pen-mode');
    this.outer.removeClass('is-eraser-mode');
    this.penToolBtn?.removeClass('is-active');
    this.inkHitPaths.forEach(p => { p.setCssStyles({ pointerEvents: 'stroke' }); });
    this.hidePenColorPicker();
    this.hidePenBanner();
    this.penOptionsPanel?.hide();
  },

  togglePenOptionsPanel(this: FreeformRenderer, anchor: HTMLElement): void {
    if (!this.penOptionsPanel) {
      this.penOptionsPanel = new PenOptionsPanel(
        this.container,
        this.penDrawOptions,
        () => this.renderAllDrawings(),
        () => this.onPenDrawOptionsChange?.(this.penDrawOptions),
      );
    }
    this.penOptionsPanel.toggle(anchor);
  },

  showPenBanner(this: FreeformRenderer): void {
    this.hidePenBanner();
    const banner = this.container.createDiv('visual-notes-pen-banner');
    const iconEl = banner.createDiv('visual-notes-pen-banner-icon');
    setIcon(iconEl, 'pencil');
    banner.createSpan({ cls: 'visual-notes-pen-banner-text', text: 'Drawing — hold Shift for straight lines' });
    const doneBtn = banner.createDiv('visual-notes-pen-banner-done');
    doneBtn.setText('Done (Enter)');
    doneBtn.addEventListener('click', (e) => { e.stopPropagation(); this.exitPenMode(); });
    this.penBanner = banner;
  },

  hidePenBanner(this: FreeformRenderer): void {
    this.penBanner?.remove();
    this.penBanner = null;
  },

  showPenColorPicker(this: FreeformRenderer): void {
    this.hidePenColorPicker();
    // A floating panel next to the toolbar, not an in-flow toolbar child —
    // the toolbar is vertically centered (top: 50%; translateY(-50%)), so
    // growing it in place to fit this picker pushed its bottom edge
    // further down the screen every time it opened, far enough at common
    // resolutions (reported at 1920×1080) to run under the bottom-left
    // trash zone. Floating it beside the Pen button instead leaves the
    // toolbar's own size/position untouched; positionPenPicker (called at
    // the end, once the rows below exist to measure) anchors and clamps
    // it, same approach as the "…" overflow menu (see toggleOverflow).
    const picker = this.container.createDiv('visual-notes-pen-picker');
    this.penColorPicker = picker;

    // Instrument row: pen / highlighter / eraser.
    const toolRow = picker.createDiv('visual-notes-pen-picker-row');
    const tools: [typeof this.penTool, string, string][] = [
      ['pen', 'pencil', 'Pen'],
      ['highlighter', 'highlighter', 'Highlighter'],
      ['eraser', 'eraser', 'Eraser'],
    ];
    for (const [tool, icon, label] of tools) {
      const btn = toolRow.createDiv('visual-notes-pen-tool-btn');
      btn.setAttribute('aria-label', label);
      setIcon(btn, icon);
      btn.toggleClass('is-selected', tool === this.penTool);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.penTool = tool;
        this.outer.toggleClass('is-eraser-mode', tool === 'eraser');
        // Rebuild the whole picker: the swatch palette swaps between pen
        // and highlighter colors, and the eraser has no rows at all.
        this.showPenColorPicker();
      });
    }
    // Advanced perfect-freehand tuning (size/thinning/taper/etc, see
    // pen-options-panel.ts) only applies to actual pen strokes — the
    // highlighter uses a completely different rendering path
    // (buildHighlightOutlineD) and the eraser doesn't render anything.
    if (this.penTool === 'pen') {
      const gearBtn = toolRow.createDiv('visual-notes-pen-tool-btn visual-notes-pen-options-gear');
      gearBtn.setAttribute('aria-label', 'Pen options');
      setIcon(gearBtn, 'settings');
      gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePenOptionsPanel(gearBtn);
      });
    }

    // The eraser has no color or width — just the instrument row.
    if (this.penTool === 'eraser') { this.positionPenPicker(); return; }

    const isHl = this.penTool === 'highlighter';
    const swatchRow = picker.createDiv('visual-notes-pen-picker-row');
    // First entry matches currentInkColor's own default so the is-selected
    // ring below has something to land on out of the box.
    const PEN_COLORS = ['var(--text-normal)', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];
    // The colors an actual highlighter set comes in — fluoro yellow first.
    const HIGHLIGHT_COLORS = ['#ffeb3b', '#b2ff59', '#ff80ab', '#ffb74d', '#81d4fa', '#ce93d8'];
    const palette = isHl ? HIGHLIGHT_COLORS : PEN_COLORS;
    const currentColor = isHl ? this.currentHighlightColor : this.currentInkColor;
    for (const hex of palette) {
      const sw = swatchRow.createDiv('visual-notes-pen-swatch');
      sw.style.backgroundColor = hex;
      sw.toggleClass('is-selected', hex === currentColor);
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isHl) this.currentHighlightColor = hex; else this.currentInkColor = hex;
        swatchRow.querySelectorAll<HTMLElement>('.visual-notes-pen-swatch').forEach(s => s.removeClass('is-selected'));
        sw.addClass('is-selected');
      });
    }

    const widthRow = picker.createDiv('visual-notes-pen-picker-row');
    const widths: [number, string][] = [[2, 'Thin'], [4, 'Medium'], [8, 'Thick']];
    for (const [w, label] of widths) {
      const btn = widthRow.createDiv('visual-notes-pen-width-btn');
      btn.setText(label);
      btn.toggleClass('is-selected', w === this.currentInkWidth);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.currentInkWidth = w;
        widthRow.querySelectorAll<HTMLElement>('.visual-notes-pen-width-btn').forEach(b => b.removeClass('is-selected'));
        btn.addClass('is-selected');
      });
    }
    this.positionPenPicker();
  },

  // Anchors the picker beside the Pen toolbar button (side depends on
  // toolbarPosition, mirroring toggleOverflow's anchor logic), clamps it
  // fully inside the container, then nudges it clear of the trash zone
  // specifically if it still overlaps — the concrete collision reported at
  // 1920×1080 with the old in-flow layout.
  positionPenPicker(this: FreeformRenderer): void {
    const picker = this.penColorPicker;
    const anchor = this.penToolBtn;
    if (!picker || !anchor) return;
    const aRect = anchor.getBoundingClientRect();
    const cRect = this.container.getBoundingClientRect();
    const gap = 8;
    if (this.toolbarPosition === 'right') {
      picker.setCssStyles({ top: `${aRect.top - cRect.top}px`, right: `${cRect.right - aRect.left + gap}px`, bottom: '', left: '' });
    } else if (this.toolbarPosition === 'bottom') {
      picker.setCssStyles({ bottom: `${cRect.bottom - aRect.top + gap}px`, left: `${aRect.left - cRect.left}px`, top: '', right: '' });
    } else if (this.toolbarPosition === 'top') {
      picker.setCssStyles({ top: `${aRect.bottom - cRect.top + gap}px`, left: `${aRect.left - cRect.left}px`, bottom: '', right: '' });
    } else {
      picker.setCssStyles({ top: `${aRect.top - cRect.top}px`, left: `${aRect.right - cRect.left + gap}px`, bottom: '', right: '' });
    }

    // Clamp fully inside the container so it's never cut off at a screen
    // edge — same measure-then-pull-in approach as toggleOverflow.
    const margin = 8;
    let pRect = picker.getBoundingClientRect();
    let top = pRect.top - cRect.top;
    let left = pRect.left - cRect.left;
    top = Math.max(margin, Math.min(top, cRect.height - margin - pRect.height));
    left = Math.max(margin, Math.min(left, cRect.width - margin - pRect.width));
    picker.setCssStyles({ top: `${top}px`, left: `${left}px`, bottom: '', right: '' });

    // Still overlapping the trash zone (bottom-left — only ever a concern
    // for a left/bottom toolbar)? Move above it instead of just clamping,
    // since clamping alone would just slide the picker sideways into the
    // same row rather than actually clearing it.
    const trash = this.trashZoneEl;
    if (!trash) return;
    pRect = picker.getBoundingClientRect();
    const tRect = trash.getBoundingClientRect();
    const overlaps = pRect.left < tRect.right + margin && pRect.right > tRect.left - margin
      && pRect.top < tRect.bottom + margin && pRect.bottom > tRect.top - margin;
    if (overlaps) {
      const flippedTop = Math.max(margin, tRect.top - cRect.top - pRect.height - margin);
      picker.setCssStyles({ top: `${flippedTop}px` });
    }
  },

  hidePenColorPicker(this: FreeformRenderer): void {
    this.penColorPicker?.remove();
    this.penColorPicker = null;
  },

  refreshAllConnections(this: FreeformRenderer): void {
    this.connectionPaths.forEach(p => p.remove());
    this.connectionPaths.clear();
    this.connectionHitPaths.forEach(p => p.remove());
    this.connectionHitPaths.clear();
    this.connectionMarkerPaths.forEach(polys => polys.forEach(p => p.remove()));
    this.connectionMarkerPaths.clear();
    this.connectionLabelEls.forEach(g => g.remove());
    this.connectionLabelEls.clear();
    this.connectionSelectPath?.remove(); this.connectionSelectPath = null;
    this.connectionBendHandle?.remove(); this.connectionBendHandle = null;
    this.hideConnectionEndpointHandles();
    this.selectedConnectionId = null;
    this.hideConnectionProps();
    // On a board with hundreds of connections, building the (potentially
    // curved/elbow-routed) path for every one of them up front — most of
    // which are nowhere near the visible viewport — is real, avoidable
    // work. Only construct DOM/paths for connections visible now; panning/
    // zooming promotes and demotes the rest via refreshConnectionCulling
    // (scheduled from applyViewport).
    const view = this.visibleCanvasBounds();
    for (const conn of this.board.connections) {
      if (this.isConnectionVisible(conn, view)) this.renderSingleConnection(conn);
    }
  },

  // Canvas-space rect of the area actually on screen right now, expanded by
  // a screen-space margin so connections don't visibly pop in/out right at
  // the viewport edge.
  visibleCanvasBounds(this: FreeformRenderer): { x: number; y: number; w: number; h: number } {
    const rect = this.outer.getBoundingClientRect();
    const margin = 300;
    const topLeft = screenToCanvas(-margin, -margin, this.vp);
    const bottomRight = screenToCanvas(rect.width + margin, rect.height + margin, this.vp);
    return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
  },

  // A connection is worth rendering if EITHER endpoint is anywhere near the
  // visible area — cheap data-only check (card.x/y/w/h or a free point),
  // no DOM measurement, safe to run for every connection on every viewport
  // change.
  isConnectionVisible(this: FreeformRenderer, conn: Connection, view: { x: number; y: number; w: number; h: number }): boolean {
    const from = this.getConnEndpointRect(conn.fromCardId, conn.fromPoint);
    const to = this.getConnEndpointRect(conn.toCardId, conn.toPoint);
    const intersects = (r: { x: number; y: number; w: number; h: number } | null) =>
      !!r && r.x < view.x + view.w && r.x + r.w > view.x && r.y < view.y + view.h && r.y + r.h > view.y;
    return intersects(from) || intersects(to);
  },

  removeSingleConnection(this: FreeformRenderer, id: string): void {
    this.connectionPaths.get(id)?.remove(); this.connectionPaths.delete(id);
    this.connectionHitPaths.get(id)?.remove(); this.connectionHitPaths.delete(id);
    this.connectionMarkerPaths.get(id)?.forEach(p => p.remove()); this.connectionMarkerPaths.delete(id);
    this.connectionLabelEls.get(id)?.remove(); this.connectionLabelEls.delete(id);
    if (this.selectedConnectionId === id) this.deselectConnection();
  },

  // rAF-batched: applyViewport fires on every raw wheel/pointermove event
  // during a pan/zoom gesture, but re-checking a few hundred connections'
  // visibility doesn't need to happen more often than once per painted
  // frame — same reasoning as the drag/resize batching in bindCanvasEvents.
  scheduleCullingRefresh(this: FreeformRenderer): void {
    if (this.cullFramePending) return;
    this.cullFramePending = true;
    window.requestAnimationFrame(() => {
      this.cullFramePending = false;
      this.refreshConnectionCulling();
    });
  },

  refreshConnectionCulling(this: FreeformRenderer): void {
    const view = this.visibleCanvasBounds();
    for (const conn of this.board.connections) {
      const visible = this.isConnectionVisible(conn, view);
      const rendered = this.connectionPaths.has(conn.id);
      if (visible && !rendered) this.renderSingleConnection(conn);
      else if (!visible && rendered) this.removeSingleConnection(conn.id);
    }
  },

  renderSingleConnection(this: FreeformRenderer, conn: Connection): void {
    const d = this.buildConnectionPath(conn); if (!d) return;

    // Wide transparent hit area for easy clicking
    const hit = createSvg('path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke', '#000000');
    hit.setAttribute('stroke-opacity', '0');
    hit.setAttribute('stroke-width', '12');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('cursor', 'pointer');
    hit.setAttribute('pointer-events', 'stroke');
    hit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.selectConnection(conn.id);
      // A fully card-anchored connection already follows its cards — only
      // one with at least one free end can be dragged as a whole; grabbing
      // the line body (rather than an endpoint handle) moves every free end
      // together, card-anchored ends (if any) staying put.
      if (conn.fromCardId && conn.toCardId) return;
      const startFrom = conn.fromPoint ? { ...conn.fromPoint } : null;
      const startTo = conn.toPoint ? { ...conn.toPoint } : null;
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      const onMove = (e2: PointerEvent) => {
        if (!moved) {
          if (Math.hypot(e2.clientX - sx, e2.clientY - sy) < DRAG_THRESHOLD) return;
          moved = true; this.pushUndo();
        }
        const dx = (e2.clientX - sx) / this.vp.zoom;
        const dy = (e2.clientY - sy) / this.vp.zoom;
        if (startFrom && !conn.fromCardId) conn.fromPoint = { x: startFrom.x + dx, y: startFrom.y + dy };
        if (startTo && !conn.toCardId) conn.toPoint = { x: startTo.x + dx, y: startTo.y + dy };
        this.rerenderConnection(conn);
      };
      const onUp = () => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
        if (moved) this.scheduleSave();
      };
      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.selectConnection(conn.id);
      const menu = this.newMenu();
      menu.addItem(i => i.setTitle('Delete connection').setIcon('trash-2').onClick(() => this.deleteSelectedConnection()));
      menu.showAtMouseEvent(e);
    });
    this.hitSvgEl.appendChild(hit);
    this.connectionHitPaths.set(conn.id, hit);

    // Visible path (pointer-events:none so hit area handles all events).
    // Uses the SHORTENED path — see buildVisibleConnectionPath — so the
    // stroke stops before reaching into an arrowhead's base, rather than
    // running all the way to its tip and poking out past the narrowing
    // sides near the point. Empty when the arrowheads alone cover the
    // whole (very short) connection.
    const visibleD = this.buildVisibleConnectionPath(conn) ?? '';
    const path = createSvg('path');
    path.setAttribute('d', visibleD);
    path.setAttribute('stroke', conn.color);
    path.setAttribute('stroke-width', String(conn.thickness));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'butt');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('pointer-events', 'none');
    if (conn.style === 'dashed') {
      path.setAttribute('stroke-dasharray', `${conn.thickness * 5} ${conn.thickness * 4}`);
    }
    this.svgEl.appendChild(path);
    this.connectionPaths.set(conn.id, path);

    const arrowheads = this.computeArrowheadPolygons(conn);
    if (arrowheads) {
      const polys: SVGPolygonElement[] = [];
      for (const pts of [arrowheads.end, arrowheads.start]) {
        if (!pts) continue;
        const poly = createSvg('polygon');
        poly.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', conn.color);
        poly.setAttribute('pointer-events', 'none');
        this.svgEl.appendChild(poly);
        polys.push(poly);
      }
      this.connectionMarkerPaths.set(conn.id, polys);
    }
    this.renderConnectionLabel(conn);
  },

  // The connection's true geometry — endpoints exactly at the card edges
  // or free points, whatever the routing mode. Used for hit-testing, the
  // selection halo, the bend/endpoint drag handles, and label placement,
  // and (see buildVisibleConnectionPath's comment) for anchoring arrowhead
  // markers, since all of those need the connection's REAL endpoints, not
  // a shortened stand-in.
  buildConnectionPath(this: FreeformRenderer, conn: Connection): string | null {
    const from = this.getConnEndpointRect(conn.fromCardId, conn.fromPoint);
    const to   = this.getConnEndpointRect(conn.toCardId, conn.toPoint);
    if (!from || !to) return null;
    const [fa, ta] = connAnchors(conn);
    if (conn.routing === 'elbow') {
      const ori = resolveOrientation(from, to, conn.elbowOrientation ?? 'auto', fa, ta);
      const { src, tgt } = elbowAnchors(from, to, ori, fa, ta);
      return buildElbowPath(src, tgt, ori);
    }
    const { src, tgt } = straightAnchors(from, to, fa, ta);
    if (conn.bend) return buildCurvedPath(src, tgt, conn.bend);
    return buildStraightPath(src, tgt);
  },

  // Resolves a connection's true endpoints AND, for each end, the
  // adjacent "approach" point one step back along the path (src/ctrl/an
  // elbow's own axis-aligned corner, whichever routing applies) — i.e.
  // the reference needed to know which DIRECTION each endpoint is
  // approached from. Shared by buildVisibleConnectionPath (shortens the
  // line by moving each arrowhead-bearing endpoint toward its approach
  // point) and computeArrowheadPolygons (points the arrowhead's base
  // away from its approach point, toward the true endpoint), so both
  // agree on exactly the same direction and neither can drift out of
  // sync with the other.
  resolveConnectionAnchors(this: FreeformRenderer, conn: Connection): {
    src: Point; tgt: Point; srcApproach: Point; tgtApproach: Point;
    ori?: 'horizontal-first' | 'vertical-first';
  } | null {
    const from = this.getConnEndpointRect(conn.fromCardId, conn.fromPoint);
    const to   = this.getConnEndpointRect(conn.toCardId, conn.toPoint);
    if (!from || !to) return null;
    const [fa, ta] = connAnchors(conn);

    if (conn.routing === 'elbow') {
      const ori = resolveOrientation(from, to, conn.elbowOrientation ?? 'auto', fa, ta);
      const { src, tgt } = elbowAnchors(from, to, ori, fa, ta);
      // The segment arriving at/leaving each endpoint is purely
      // horizontal or vertical (matching `ori`), so the adjacent corner
      // one axis-aligned step back is exact, not an approximation.
      const midX = (src.x + tgt.x) / 2, midY = (src.y + tgt.y) / 2;
      const srcApproach = ori === 'horizontal-first' ? { x: midX, y: src.y } : { x: src.x, y: midY };
      const tgtApproach = ori === 'horizontal-first' ? { x: midX, y: tgt.y } : { x: tgt.x, y: midY };
      return { src, tgt, srcApproach, tgtApproach, ori };
    }

    const { src, tgt } = straightAnchors(from, to, fa, ta);
    if (conn.bend) {
      // Both ends' tangents reference the same quadratic-bezier control
      // point — only the direction (ctrl→tgt vs ctrl→src) differs.
      const ctrl = curveControlPoint(src, tgt, conn.bend);
      return { src, tgt, srcApproach: ctrl, tgtApproach: ctrl };
    }
    return { src, tgt, srcApproach: tgt, tgtApproach: src };
  },

  // The path used ONLY for the visible colored stroke, trimmed so the
  // shaft never reaches into an arrowhead's tapering tip. Hard-won
  // constraints, each from a shipped-wrong iteration of this fix:
  //  1. Never shorten buildConnectionPath itself — hit-testing, the
  //     selection outline, label placement, and the bend handle all need
  //     the true endpoints (and an SVG <marker> attached to a shortened
  //     path just relocates the arrowhead instead of fixing the overlap;
  //     arrowheads are directly-computed polygons now, see
  //     computeArrowheadPolygons).
  //  2. The trimmed stroke must be an EXACT SUB-SEGMENT of the true path
  //     (buildTrimmed*Path in geometry.ts) — rebuilding a curve from
  //     pulled-back endpoints with the same bend, or an elbow from moved
  //     endpoints, yields a different shape whose middle visibly separates
  //     from the hit path/selection outline and breaks clicking near the
  //     center of extreme bends (reported after the first polygon fix).
  // Returns null when the trims consume the whole path (connection shorter
  // than its arrowheads) — callers render no stroke at all then.
  buildVisibleConnectionPath(this: FreeformRenderer, conn: Connection): string | null {
    const pullEnd = conn.arrowhead === 'end' || conn.arrowhead === 'both';
    const pullStart = conn.arrowhead === 'both';
    if (!pullEnd && !pullStart) return this.buildConnectionPath(conn);

    const anchors = this.resolveConnectionAnchors(conn);
    if (!anchors) return null;
    const pull = arrowMarkerLength(conn.thickness);
    const trimStart = pullStart ? pull : 0;
    const trimEnd = pullEnd ? pull : 0;

    if (conn.routing === 'elbow') return buildTrimmedElbowPath(anchors.src, anchors.tgt, anchors.ori!, trimStart, trimEnd);
    if (conn.bend) return buildTrimmedCurvedPath(anchors.src, anchors.tgt, conn.bend, trimStart, trimEnd);
    return buildTrimmedStraightPath(anchors.src, anchors.tgt, trimStart, trimEnd);
  },

  // Arrowhead triangle(s) for a connection, computed directly rather than
  // via SVG marker auto-orientation (see buildVisibleConnectionPath's
  // comment for why) — each is [tip, baseCorner1, baseCorner2], with the
  // tip exactly at the connection's true endpoint.
  computeArrowheadPolygons(this: FreeformRenderer, conn: Connection): { end?: [Point, Point, Point]; start?: [Point, Point, Point] } | null {
    if (conn.arrowhead === 'none') return null;
    const anchors = this.resolveConnectionAnchors(conn);
    if (!anchors) return null;
    const length = arrowMarkerLength(conn.thickness);
    const halfWidth = Math.round(length * 0.42);
    const result: { end?: [Point, Point, Point]; start?: [Point, Point, Point] } = {};
    if (conn.arrowhead === 'end' || conn.arrowhead === 'both') {
      result.end = arrowheadPoints(anchors.tgt, anchors.tgtApproach, length, halfWidth);
    }
    if (conn.arrowhead === 'both') {
      result.start = arrowheadPoints(anchors.src, anchors.srcApproach, length, halfWidth);
    }
    return result;
  },

  getCardRect(this: FreeformRenderer, cardId: string): { x: number; y: number; w: number; h: number } | null {
    const card = this.board.cards.find(c => c.id === cardId);
    if (!card) return null;
    return { x: card.x ?? 0, y: card.y ?? 0, w: card.w ?? TILE_DEFAULT_W, h: card.h ?? TILE_DEFAULT_H };
  },

  getConnEndpointRect(this: FreeformRenderer, 
    cardId: string | undefined, point: { x: number; y: number } | undefined,
  ): { x: number; y: number; w: number; h: number } | null {
    if (cardId) return this.getCardRect(cardId);
    if (point) return { x: point.x, y: point.y, w: 0, h: 0 };
    return null;
  },

  connectionLabelPos(this: FreeformRenderer, conn: Connection): { x: number; y: number } | null {
    const from = this.getConnEndpointRect(conn.fromCardId, conn.fromPoint);
    const to   = this.getConnEndpointRect(conn.toCardId, conn.toPoint);
    if (!from || !to) return null;
    const [fa, ta] = connAnchors(conn);
    const { src, tgt } = conn.routing === 'elbow'
      ? elbowAnchors(from, to, resolveOrientation(from, to, conn.elbowOrientation ?? 'auto', fa, ta), fa, ta)
      : straightAnchors(from, to, fa, ta);
    if (conn.routing !== 'elbow' && conn.bend) return curveThroughPoint(src, tgt, conn.bend);
    return { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 };
  },

  renderConnectionLabel(this: FreeformRenderer, conn: Connection): void {
    if (!conn.label) return;
    const pos = this.connectionLabelPos(conn); if (!pos) return;
    const g = createSvg('g');
    g.setAttribute('pointer-events', 'none');
    const bg = getComputedStyle(activeDocument.body).getPropertyValue('--background-primary').trim() || '#ffffff';
    const size = conn.labelSize ?? 14;
    const addText = (strokeColor: string | null, fillColor: string) => {
      const t = createSvg('text');
      t.setAttribute('x', String(pos.x)); t.setAttribute('y', String(pos.y));
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('font-size', String(size));
      // Halo stroke scales with the font so the knockout stays proportionate.
      if (strokeColor) { t.setAttribute('stroke', strokeColor); t.setAttribute('stroke-width', String(Math.round(size * 0.45))); t.setAttribute('stroke-linejoin', 'round'); }
      t.setAttribute('fill', fillColor);
      t.textContent = conn.label ?? '';
      g.appendChild(t);
    };
    addText(bg, bg);
    addText(null, conn.color);
    this.svgEl.appendChild(g);
    this.connectionLabelEls.set(conn.id, g);
  },

  updateConnectionsForCard(this: FreeformRenderer, cardId: string): void {
    for (const conn of this.board.connections) {
      if (conn.fromCardId !== cardId && conn.toCardId !== cardId) continue;
      // Culled (off-screen, no DOM) — nothing to update. Its data-derived
      // path gets rebuilt correctly if/when it's promoted back into view.
      if (!this.connectionPaths.has(conn.id)) continue;
      const d = this.buildConnectionPath(conn); if (!d) continue;
      this.connectionHitPaths.get(conn.id)?.setAttribute('d', d);
      this.connectionPaths.get(conn.id)?.setAttribute('d', this.buildVisibleConnectionPath(conn) ?? '');
      const polys = this.connectionMarkerPaths.get(conn.id);
      if (polys) {
        // Same creation order as renderSingleConnection: [end, start].
        const arrowheads = this.computeArrowheadPolygons(conn);
        const ptsList = [arrowheads?.end, arrowheads?.start];
        polys.forEach((poly, i) => {
          const pts = ptsList[i];
          if (pts) poly.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
        });
      }
      if (this.selectedConnectionId === conn.id && this.connectionSelectPath) {
        this.connectionSelectPath.setAttribute('d', d);
        this.showConnectionBendHandle(conn);
      }
      const labelPos = this.connectionLabelPos(conn);
      const labelG = this.connectionLabelEls.get(conn.id);
      if (labelPos && labelG) {
        labelG.querySelectorAll('text').forEach(t => {
          t.setAttribute('x', String(labelPos.x));
          t.setAttribute('y', String(labelPos.y));
        });
      }
    }
  },

  enterConnectMode(this: FreeformRenderer): void {
    // See activateTool's comment — Pen and any pending placement tool must
    // be torn down first so only Line ever shows as active.
    this.exitPenMode();
    this.clearPendingTool();
    this.connectMode = true;
    this.outer.addClass('is-connect-mode');
    this.connectToolBtn?.addClass('is-active');
    // Pins show without hovering in this mode, so any card resized since it
    // was last hovered needs its pin count brought up to date now.
    for (const [id, el] of this.cardEls) {
      const card = this.board.cards.find(c => c.id === id);
      if (card) this.refreshConnectionHandles(el, card);
    }
  },

  exitConnectMode(this: FreeformRenderer): void {
    this.connectMode = false;
    this.outer?.removeClass('is-connect-mode');
    this.connectToolBtn?.removeClass('is-active');
    if (this.connectSourceId) {
      this.cardEls.get(this.connectSourceId)?.removeClass('is-connect-source');
      this.connectSourceId = null;
    }
    this.stopConnectSourceGhost();
  },

  toggleConnectMode(this: FreeformRenderer): void {
    if (this.connectMode) this.exitConnectMode(); else this.enterConnectMode();
  },

  addConnectionHandles(this: FreeformRenderer, el: HTMLElement, card: SupportedCard): void {
    // Called from renderCardContent, which empties `el` first — so the pins
    // are already gone even though the signature left on the element says
    // otherwise. Clearing it forces the rebuild that guard would skip.
    delete el.dataset.pinSig;
    this.refreshConnectionHandles(el, card);

    // How MANY pins a side gets depends on its length, so a resize can
    // change it. Refreshing on hover (exactly when they become visible)
    // keeps them current without hooking the resize path — and costs
    // nothing in the common case where the count is unchanged. Bound once
    // per element: re-rendering a card's content reuses the same element,
    // so an unguarded listener here would stack up one copy per render.
    if (el.dataset.pinHoverBound) return;
    el.dataset.pinHoverBound = '1';
    let hoverRect: DOMRect | null = null;
    el.addEventListener('pointerenter', () => {
      // Looked up fresh rather than closing over `card`, whose object may
      // have been replaced by a later render of the same card.
      const current = this.board.cards.find(c => c.id === card.id);
      if (current) this.refreshConnectionHandles(el, current);
      // Measured once per hover rather than per move: a card doesn't
      // change geometry while the pointer sits over it, and reading a rect
      // on every pointermove would force layout on each one.
      hoverRect = el.getBoundingClientRect();
    });

    // Reveals one edge's full row of pins as the pointer approaches it —
    // see nearestPinEdge. rAF-coalesced like the other pointermove work in
    // this file so a fast mouse can't outrun the screen refresh.
    let pending = false;
    let latest: PointerEvent | null = null;
    el.addEventListener('pointermove', (e) => {
      latest = e;
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(() => {
        pending = false;
        if (!latest || !hoverRect) return;
        const edge = nearestPinEdge(hoverRect, latest.clientX, latest.clientY);
        if (edge) el.dataset.pinEdge = edge; else delete el.dataset.pinEdge;
      });
    });
    el.addEventListener('pointerleave', () => { delete el.dataset.pinEdge; hoverRect = null; });
  },

  // Lays out the row/column of connection pins along each edge. Positions
  // are percentages, so they track a resize on their own; only the count
  // needs recomputing, which the signature guard below detects. Rebuilding
  // unconditionally would delete the very pin the pointer is hovering (or
  // mid-drag on) and cancel the gesture.
  refreshConnectionHandles(this: FreeformRenderer, el: HTMLElement, card: SupportedCard): void {
    const w = card.w ?? TILE_DEFAULT_W, h = card.h ?? TILE_DEFAULT_H;
    const across = pinPositions(w), down = pinPositions(h);
    const sig = `${across.length}x${down.length}`;
    if (el.dataset.pinSig === sig) return;
    el.dataset.pinSig = sig;
    // `:scope >` matters: a column card holds its child cards inside its own
    // element, and an unscoped selector here would delete THEIR pins too.
    el.querySelectorAll(':scope > .visual-notes-connection-handle').forEach(n => n.remove());

    for (const side of ['n', 's', 'e', 'w'] as const) {
      const horizontal = side === 'n' || side === 's';
      for (const t of horizontal ? across : down) {
        // The midpoint pin is the only one shown on a plain hover (see the
        // stylesheet) — it stands in for the single handle each side had
        // before pins existed, so hovering a card is no busier than it was.
        const mid = Math.abs(t - 0.5) < 1e-9 ? ' is-mid' : '';
        const handle = el.createDiv(`visual-notes-connection-handle visual-notes-connection-handle-${side}${mid}`);
        handle.dataset.side = side;
        handle.dataset.t = String(t);
        // Only the along-edge axis is set here; the perpendicular offset
        // that straddles the border comes from the per-side CSS class.
        // The 7px back-off is half the pin's hit target, centring it on
        // its fraction of the edge — keep in step with the stylesheet.
        if (horizontal) handle.style.left = `calc(${t * 100}% - 7px)`;
        else handle.style.top = `calc(${t * 100}% - 7px)`;
        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation(); e.preventDefault();
          handle.setPointerCapture(e.pointerId);
          this.startHandleDrag(e, handle, card, { side, t });
        });
      }
    }
  },

  // The pin under a screen point, if any — used to decide whether a
  // dropped connection lands on a specific pin (pinned) or just somewhere
  // on the card (left free-sliding, as before).
  anchorAtPoint(this: FreeformRenderer, clientX: number, clientY: number): { cardId: string; anchor: Anchor } | null {
    for (const el of activeDocument.elementsFromPoint(clientX, clientY)) {
      const handle = el.closest<HTMLElement>('.visual-notes-connection-handle');
      if (!handle) continue;
      const cardId = handle.closest<HTMLElement>('[data-id]')?.dataset.id;
      const side = handle.dataset.side as Anchor['side'] | undefined;
      const t = Number(handle.dataset.t);
      if (!cardId || !side || !Number.isFinite(t)) continue;
      if (!this.cardEls.has(cardId)) continue;
      return { cardId, anchor: { side, t } };
    }
    return null;
  },

  /** The pin element itself at a screen point — for highlighting it as a drop target. */
  pinElementAt(this: FreeformRenderer, clientX: number, clientY: number): HTMLElement | null {
    for (const el of activeDocument.elementsFromPoint(clientX, clientY)) {
      const handle = el.closest<HTMLElement>('.visual-notes-connection-handle');
      if (handle) return handle;
    }
    return null;
  },

  startHandleDrag(this: FreeformRenderer,
    e: PointerEvent, handleEl: HTMLElement,
    card: SupportedCard, anchor: Anchor
  ): void {
    const outerRect = this.outer.getBoundingClientRect();
    const cardRect = this.getCardRect(card.id);
    const srcEdge = cardRect ? anchorPoint(cardRect, anchor) : this.getEdgeMidpoint(card, anchor.side);
    let hoveredId: string | null = null;
    // Reveals every card's pins for the duration of the drag — the target
    // card isn't hovered in the CSS sense while the source handle holds
    // pointer capture, so without this you'd be aiming at invisible pins.
    this.outer.addClass('is-linking');

    // cardIdAtPoint (elementsFromPoint) and the ghost-path rebuild are
    // layout-dependent — same rAF coalescing as card drag/resize above, so
    // a fast mouse doesn't run them more often than the screen repaints.
    let latestEv: PointerEvent | null = null;
    let moveFrameId = 0;
    let moveFramePending = false;
    let hoveredPin: HTMLElement | null = null;
    const applyHandleMove = (ev: PointerEvent) => {
      const cp = screenToCanvas(ev.clientX - outerRect.left, ev.clientY - outerRect.top, this.vp);
      // Snap the ghost line's far end onto a pin the moment the pointer is
      // over one, so it's unambiguous which pin a release would land on.
      const overPin = this.anchorAtPoint(ev.clientX, ev.clientY);
      const pinRect = overPin && overPin.cardId !== card.id ? this.getCardRect(overPin.cardId) : null;
      const end = pinRect && overPin ? anchorPoint(pinRect, overPin.anchor) : cp;
      this.updateGhostPath(srcEdge.x, srcEdge.y, end.x, end.y);

      const nextPin = pinRect ? this.pinElementAt(ev.clientX, ev.clientY) : null;
      if (nextPin !== hoveredPin) {
        hoveredPin?.removeClass('is-pin-target');
        hoveredPin = nextPin;
        hoveredPin?.addClass('is-pin-target');
      }

      const id = this.cardIdAtPoint(ev.clientX, ev.clientY);
      const newHover = (id && id !== card.id) ? id : null;
      if (newHover !== hoveredId) {
        if (hoveredId) this.cardEls.get(hoveredId)?.removeClass('is-connect-target');
        hoveredId = newHover;
        if (hoveredId) this.cardEls.get(hoveredId)?.addClass('is-connect-target');
      }
    };
    const onMove = (ev: PointerEvent) => {
      latestEv = ev;
      if (moveFramePending) return;
      moveFramePending = true;
      moveFrameId = window.requestAnimationFrame(() => { moveFramePending = false; if (latestEv) applyHandleMove(latestEv); });
    };

    const onUp = (ev: PointerEvent) => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      if (moveFramePending) { window.cancelAnimationFrame(moveFrameId); moveFramePending = false; }
      // Read what's under the cursor BEFORE tearing down the linking
      // state. Clearing `is-linking` returns every pin to pointer-events:
      // none, and elementsFromPoint skips those — so querying afterwards
      // finds the card but never the pin on it, leaving the target end
      // silently unpinned however precisely it was aimed.
      const targetId = this.cardIdAtPoint(ev.clientX, ev.clientY);
      const dropped = this.anchorAtPoint(ev.clientX, ev.clientY);

      this.removeGhostPath();
      this.outer.removeClass('is-linking');
      hoveredPin?.removeClass('is-pin-target');
      if (hoveredId) this.cardEls.get(hoveredId)?.removeClass('is-connect-target');

      if (!targetId || targetId === card.id) return;
      // Released squarely on one of the target's pins → pin that end too.
      // Released anywhere else on the card → leave it free-sliding, which
      // is what a plain card-to-card drag has always produced.
      const toAnchor = dropped && dropped.cardId === targetId ? dropped.anchor : undefined;
      this.finishConnection(card.id, targetId, anchor, toAnchor);
    };

    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
  },

  getEdgeMidpoint(this: FreeformRenderer, card: Card, side: 'n' | 's' | 'e' | 'w'): { x: number; y: number } {
    const cx = (card.x ?? 0) + (card.w ?? TILE_DEFAULT_W) / 2;
    const cy = (card.y ?? 0) + (card.h ?? TILE_DEFAULT_H) / 2;
    switch (side) {
      case 'n': return { x: cx, y: card.y ?? 0 };
      case 's': return { x: cx, y: (card.y ?? 0) + (card.h ?? TILE_DEFAULT_H) };
      case 'e': return { x: (card.x ?? 0) + (card.w ?? TILE_DEFAULT_W), y: cy };
      case 'w': return { x: card.x ?? 0, y: cy };
    }
  },

  updateGhostPath(this: FreeformRenderer, sx: number, sy: number, tx: number, ty: number): void {
    if (!this.ghostPath) {
      this.ghostPath = createSvg('path');
      this.ghostPath.setAttribute('fill', 'none');
      this.ghostPath.setAttribute('stroke', 'var(--interactive-accent)');
      this.ghostPath.setAttribute('stroke-width', '1.5');
      this.ghostPath.setAttribute('stroke-dasharray', '6 4');
      this.ghostPath.setAttribute('stroke-linecap', 'round');
      this.ghostPath.setAttribute('pointer-events', 'none');
      this.svgEl.appendChild(this.ghostPath);
    }
    this.ghostPath.setAttribute('d', `M ${sx} ${sy} L ${tx} ${ty}`);
  },

  removeGhostPath(this: FreeformRenderer): void {
    if (this.ghostPath) { this.ghostPath.remove(); this.ghostPath = null; }
  },

  startConnectSourceGhost(this: FreeformRenderer, sourceId: string): void {
    const sourceCard = this.board.cards.find(c => c.id === sourceId);
    if (!sourceCard) return;
    this.connectMoveListener = (ev: PointerEvent) => {
      const rect = this.outer.getBoundingClientRect();
      const cursor = screenToCanvas(ev.clientX - rect.left, ev.clientY - rect.top, this.vp);
      const rect2 = this.getCardRect(sourceId);
      if (!rect2) return;
      const fcx = rect2.x + rect2.w / 2, fcy = rect2.y + rect2.h / 2;
      const src = rectExitPoint(fcx, fcy, cursor.x, cursor.y, rect2);
      this.updateGhostPath(src.x, src.y, cursor.x, cursor.y);
    };
    this.outer.addEventListener('pointermove', this.connectMoveListener);
  },

  stopConnectSourceGhost(this: FreeformRenderer): void {
    if (this.connectMoveListener) {
      this.outer.removeEventListener('pointermove', this.connectMoveListener);
      this.connectMoveListener = null;
    }
    this.removeGhostPath();
  },

  cardIdAtPoint(this: FreeformRenderer, clientX: number, clientY: number): string | null {
    const els = activeDocument.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const cardEl = el.closest<HTMLElement>('[data-id]');
      if (cardEl?.dataset.id && this.cardEls.has(cardEl.dataset.id)) return cardEl.dataset.id;
    }
    return null;
  },

  finishConnection(this: FreeformRenderer, fromId: string, toId: string, fromAnchor?: Anchor, toAnchor?: Anchor): void {
    if (fromId === toId) return;
    // Two cards may now be joined more than once, as long as the new line
    // lands on a different pair of pins — that's the whole point of pinning
    // in a node graph. Only an exact duplicate (same pair, same pins, in
    // either direction) is still rejected.
    const sameAnchor = (a?: Anchor | null, b?: Anchor | null) =>
      (!a && !b) || (!!a && !!b && a.side === b.side && a.t === b.t);
    const exists = this.board.connections.some(c =>
      (c.fromCardId === fromId && c.toCardId === toId &&
        sameAnchor(c.fromAnchor, fromAnchor) && sameAnchor(c.toAnchor, toAnchor)) ||
      (c.fromCardId === toId && c.toCardId === fromId &&
        sameAnchor(c.fromAnchor, toAnchor) && sameAnchor(c.toAnchor, fromAnchor))
    );
    if (exists) return;
    const conn: Connection = {
      id: crypto.randomUUID(),
      fromCardId: fromId,
      toCardId: toId,
      fromAnchor,
      toAnchor,
      routing: 'straight',
      color: this.resolveDefaultConnectionColor(),
      style: 'solid',
      arrowhead: 'end',
      thickness: 2,
    };
    this.pushUndo();
    this.board.connections.push(conn);
    this.renderSingleConnection(conn);
    this.scheduleSave();
  },

  startFreeLineDrag(this: FreeformRenderer, startEvent: PointerEvent): void {
    const rect = this.outer.getBoundingClientRect();
    const startCp = screenToCanvas(startEvent.clientX - rect.left, startEvent.clientY - rect.top, this.vp);

    const livePath = createSvg('path');
    livePath.setAttribute('fill', 'none');
    livePath.setAttribute('stroke', 'var(--interactive-accent)');
    livePath.setAttribute('stroke-width', '1.5');
    livePath.setAttribute('stroke-dasharray', '6 4');
    livePath.setAttribute('stroke-linecap', 'round');
    livePath.setAttribute('pointer-events', 'none');
    livePath.setAttribute('d', `M ${startCp.x} ${startCp.y} L ${startCp.x} ${startCp.y}`);
    this.svgEl.appendChild(livePath);

    let endCp = { ...startCp };
    const onMove = (e: PointerEvent) => {
      endCp = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, this.vp);
      livePath.setAttribute('d', `M ${startCp.x} ${startCp.y} L ${endCp.x} ${endCp.y}`);
    };
    const onUp = () => {
      activeDocument.removeEventListener('pointermove', onMove);
      activeDocument.removeEventListener('pointerup', onUp);
      livePath.remove();
      this.exitConnectMode();
      // A plain click (no real drag) still drops a default straight arrow —
      // same as dragging the Line button straight from the toolbar does —
      // rather than requiring the user to drag one out by hand every time.
      if (Math.hypot(endCp.x - startCp.x, endCp.y - startCp.y) < 8) {
        this.addDefaultArrowAt(startCp.x, startCp.y);
        return;
      }
      const conn: Connection = {
        id: crypto.randomUUID(),
        fromPoint: { x: startCp.x, y: startCp.y },
        toPoint: { x: endCp.x, y: endCp.y },
        routing: 'straight',
        color: this.resolveDefaultConnectionColor(),
        style: 'solid',
        arrowhead: 'end',
        thickness: 2,
      };
      this.pushUndo();
      this.board.connections.push(conn);
      this.renderSingleConnection(conn);
      this.selectConnection(conn.id);
      this.scheduleSave();
    };
    activeDocument.addEventListener('pointermove', onMove);
    activeDocument.addEventListener('pointerup', onUp);
  },

  addDefaultArrowAt(this: FreeformRenderer, cx: number, cy: number): void {
    const half = 80;
    const conn: Connection = {
      id: crypto.randomUUID(),
      fromPoint: { x: snap(cx - half), y: snap(cy) },
      toPoint: { x: snap(cx + half), y: snap(cy) },
      routing: 'straight',
      color: this.resolveDefaultConnectionColor(),
      style: 'solid',
      arrowhead: 'end',
      thickness: 2,
    };
    this.pushUndo();
    this.board.connections.push(conn);
    this.renderSingleConnection(conn);
    this.selectConnection(conn.id);
    this.scheduleSave();
  },

  resolveDefaultConnectionColor(this: FreeformRenderer): string {
    const tmp = activeDocument.body.createDiv('visual-notes-color-probe');
    const computed = getComputedStyle(tmp).color;
    tmp.remove();
    const m = computed.match(/\d+/g);
    if (!m || m.length < 3) return '#888888';
    return '#' + [m[0], m[1], m[2]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
  },

  selectConnection(this: FreeformRenderer, id: string): void {
    if (this.selectedConnectionId === id) return;
    this.deselectConnection();
    this.selection.clear(); this.refreshSelectionVisuals();
    this.selectedConnectionId = id;
    const conn = this.board.connections.find(c => c.id === id); if (!conn) return;
    const d = this.buildConnectionPath(conn); if (!d) return;

    this.connectionSelectPath = createSvg('path');
    this.connectionSelectPath.setAttribute('d', d);
    this.connectionSelectPath.setAttribute('stroke', 'var(--interactive-accent)');
    this.connectionSelectPath.setAttribute('stroke-width', String(conn.thickness + 6));
    this.connectionSelectPath.setAttribute('stroke-opacity', '0.3');
    this.connectionSelectPath.setAttribute('fill', 'none');
    this.connectionSelectPath.setAttribute('stroke-linecap', 'round');
    this.connectionSelectPath.setAttribute('pointer-events', 'none');
    this.hitSvgEl.appendChild(this.connectionSelectPath);
    this.showConnectionBendHandle(conn);
    this.showConnectionEndpointHandles(conn);
    this.showConnectionProps(conn);
  },

  deselectConnection(this: FreeformRenderer): void {
    if (!this.selectedConnectionId) return;
    this.connectionSelectPath?.remove(); this.connectionSelectPath = null;
    this.connectionBendHandle?.remove(); this.connectionBendHandle = null;
    this.hideConnectionEndpointHandles();
    this.selectedConnectionId = null;
    this.hideConnectionProps();
    this.contextBar?.hide();
  },

  showConnectionEndpointHandles(this: FreeformRenderer, conn: Connection): void {
    this.hideConnectionEndpointHandles();

    const addHandle = (getPoint: () => { x: number; y: number } | undefined, setPoint: (p: { x: number; y: number }) => void) => {
      const p = getPoint();
      if (!p) return;
      const handle = createSvg('circle');
      handle.setAttribute('cx', String(p.x));
      handle.setAttribute('cy', String(p.y));
      handle.setAttribute('r', '6');
      handle.setAttribute('fill', 'var(--interactive-accent)');
      handle.setAttribute('stroke', 'var(--background-primary)');
      handle.setAttribute('stroke-width', '2');
      handle.classList.add('visual-notes-connection-bend-handle');
      this.hitSvgEl.appendChild(handle);
      this.connectionEndpointHandles.push(handle);

      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.pushUndo();
        const rect = this.outer.getBoundingClientRect();
        const onMove = (e2: PointerEvent) => {
          const cp = screenToCanvas(e2.clientX - rect.left, e2.clientY - rect.top, this.vp);
          setPoint({ x: cp.x, y: cp.y });
          this.rerenderConnection(conn);
        };
        const onUp = () => {
          activeDocument.removeEventListener('pointermove', onMove);
          activeDocument.removeEventListener('pointerup', onUp);
          this.scheduleSave();
        };
        activeDocument.addEventListener('pointermove', onMove);
        activeDocument.addEventListener('pointerup', onUp);
      });
    };

    if (!conn.fromCardId) addHandle(() => conn.fromPoint, (p) => { conn.fromPoint = p; });
    if (!conn.toCardId) addHandle(() => conn.toPoint, (p) => { conn.toPoint = p; });
    if (conn.fromCardId) this.addEndpointAnchorHandle(conn, 'from');
    if (conn.toCardId) this.addEndpointAnchorHandle(conn, 'to');
  },

  // Drag handle on a card-anchored end, letting an existing connection be
  // moved to a different pin — the counterpart to choosing a pin when the
  // connection was first drawn, without which a mis-aimed line could only
  // be deleted and redrawn. Double-click releases the pin back to the
  // free-sliding default, mirroring the bend handle's double-click reset.
  addEndpointAnchorHandle(this: FreeformRenderer, conn: Connection, end: 'from' | 'to'): void {
    const anchors = this.resolveConnectionAnchors(conn);
    if (!anchors) return;
    const p = end === 'from' ? anchors.src : anchors.tgt;
    const pinned = end === 'from' ? conn.fromAnchor : conn.toAnchor;

    const handle = createSvg('circle');
    handle.setAttribute('cx', String(p.x));
    handle.setAttribute('cy', String(p.y));
    handle.setAttribute('r', '6');
    handle.setAttribute('fill', pinned ? 'var(--interactive-accent)' : 'var(--background-primary)');
    handle.setAttribute('stroke', 'var(--interactive-accent)');
    handle.setAttribute('stroke-width', '2');
    handle.classList.add('visual-notes-connection-bend-handle');
    this.hitSvgEl.appendChild(handle);
    this.connectionEndpointHandles.push(handle);

    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      const rect = this.outer.getBoundingClientRect();
      // The far end stays put and acts as the ghost line's origin, so the
      // preview reads as "this end is being re-aimed".
      const origin = end === 'from' ? anchors.tgt : anchors.src;
      this.outer.addClass('is-linking');
      let hoveredPin: HTMLElement | null = null;
      let moved = false;

      const onMove = (e2: PointerEvent) => {
        moved = true;
        const cp = screenToCanvas(e2.clientX - rect.left, e2.clientY - rect.top, this.vp);
        const over = this.anchorAtPoint(e2.clientX, e2.clientY);
        const overRect = over ? this.getCardRect(over.cardId) : null;
        const tip = over && overRect ? anchorPoint(overRect, over.anchor) : cp;
        this.updateGhostPath(origin.x, origin.y, tip.x, tip.y);
        const nextPin = overRect ? this.pinElementAt(e2.clientX, e2.clientY) : null;
        if (nextPin !== hoveredPin) {
          hoveredPin?.removeClass('is-pin-target');
          hoveredPin = nextPin;
          hoveredPin?.addClass('is-pin-target');
        }
      };

      const onUp = (e2: PointerEvent) => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
        // Same ordering rule as startHandleDrag's release: query the drop
        // target while the pins are still hit-testable, then clean up.
        const dropCardId = this.cardIdAtPoint(e2.clientX, e2.clientY);
        const dropped = this.anchorAtPoint(e2.clientX, e2.clientY);

        this.removeGhostPath();
        this.outer.removeClass('is-linking');
        hoveredPin?.removeClass('is-pin-target');
        if (!moved) return;

        // Dropped off any card — leave the connection exactly as it was
        // rather than silently detaching it from the card it belongs to.
        if (!dropCardId) return;
        const otherId = end === 'from' ? conn.toCardId : conn.fromCardId;
        if (dropCardId === otherId) return; // would collapse both ends onto one card
        const newAnchor = dropped && dropped.cardId === dropCardId ? dropped.anchor : undefined;

        this.pushUndo();
        if (end === 'from') { conn.fromCardId = dropCardId; conn.fromAnchor = newAnchor; }
        else { conn.toCardId = dropCardId; conn.toAnchor = newAnchor; }
        this.rerenderConnection(conn);
        this.scheduleSave();
      };

      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (!pinned) return;
      this.pushUndo();
      if (end === 'from') conn.fromAnchor = undefined; else conn.toAnchor = undefined;
      this.rerenderConnection(conn);
      this.scheduleSave();
    });
  },

  hideConnectionEndpointHandles(this: FreeformRenderer): void {
    this.connectionEndpointHandles.forEach(h => h.remove());
    this.connectionEndpointHandles = [];
  },

  showConnectionBendHandle(this: FreeformRenderer, conn: Connection): void {
    this.connectionBendHandle?.remove();
    this.connectionBendHandle = null;
    if (conn.routing === 'elbow') return; // bending only applies to straight routing

    const from = this.getConnEndpointRect(conn.fromCardId, conn.fromPoint);
    const to = this.getConnEndpointRect(conn.toCardId, conn.toPoint);
    if (!from || !to) return;
    const [fa0, ta0] = connAnchors(conn);
    const { src, tgt } = straightAnchors(from, to, fa0, ta0);
    const pt = curveThroughPoint(src, tgt, conn.bend ?? 0);

    const handle = createSvg('circle');
    handle.setAttribute('cx', String(pt.x));
    handle.setAttribute('cy', String(pt.y));
    handle.setAttribute('r', '6');
    handle.setAttribute('fill', 'var(--interactive-accent)');
    handle.setAttribute('stroke', 'var(--background-primary)');
    handle.setAttribute('stroke-width', '2');
    handle.classList.add('visual-notes-connection-bend-handle');
    this.hitSvgEl.appendChild(handle);
    this.connectionBendHandle = handle;

    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = this.outer.getBoundingClientRect();
      let dragged = false;
      const onMove = (e2: PointerEvent) => {
        dragged = true;
        const cp = screenToCanvas(e2.clientX - rect.left, e2.clientY - rect.top, this.vp);
        const from2 = this.getConnEndpointRect(conn.fromCardId, conn.fromPoint);
        const to2 = this.getConnEndpointRect(conn.toCardId, conn.toPoint);
        if (!from2 || !to2) return;
        const [fa2, ta2] = connAnchors(conn);
        const anchors = straightAnchors(from2, to2, fa2, ta2);
        conn.bend = Math.round(perpendicularOffset(anchors.src, anchors.tgt, cp));
        this.rerenderConnection(conn);
      };
      const onUp = () => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
        if (dragged) { this.scheduleSave(); }
      };
      this.pushUndo();
      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (!conn.bend) return;
      this.pushUndo();
      conn.bend = undefined;
      this.rerenderConnection(conn);
      this.scheduleSave();
    });
  },

  rerenderConnection(this: FreeformRenderer, conn: Connection): void {
    this.connectionPaths.get(conn.id)?.remove();
    this.connectionHitPaths.get(conn.id)?.remove();
    this.connectionMarkerPaths.get(conn.id)?.forEach(p => p.remove());
    this.connectionPaths.delete(conn.id);
    this.connectionHitPaths.delete(conn.id);
    this.connectionMarkerPaths.delete(conn.id);
    this.connectionLabelEls.get(conn.id)?.remove();
    this.connectionLabelEls.delete(conn.id);
    this.renderSingleConnection(conn);
    if (this.selectedConnectionId === conn.id && this.connectionSelectPath) {
      const d = this.buildConnectionPath(conn);
      if (d) {
        this.connectionSelectPath.setAttribute('d', d);
        this.connectionSelectPath.setAttribute('stroke-width', String(conn.thickness + 6));
      }
      // Halo stays in hitSvgEl — just update its path data above
      this.showConnectionBendHandle(conn);
      this.showConnectionEndpointHandles(conn);
    }
  },

  deleteSelectedConnection(this: FreeformRenderer): void {
    if (!this.selectedConnectionId) return;
    const id = this.selectedConnectionId;
    this.pushUndo();
    this.deselectConnection();
    this.board.connections = this.board.connections.filter(c => c.id !== id);
    this.connectionPaths.get(id)?.remove(); this.connectionPaths.delete(id);
    this.connectionHitPaths.get(id)?.remove(); this.connectionHitPaths.delete(id);
    this.connectionMarkerPaths.get(id)?.forEach(p => p.remove()); this.connectionMarkerPaths.delete(id);
    this.connectionLabelEls.get(id)?.remove(); this.connectionLabelEls.delete(id);
    this.scheduleSave();
  },

  showConnectionProps(this: FreeformRenderer, conn: Connection): void {
    this.hideConnectionProps();
    const panel = this.container.createDiv('visual-notes-conn-props');
    // Both this panel and the card toolbar default to bottom-center — when
    // the toolbar is docked there, shift this panel up above it.
    if (this.toolbarPosition === 'bottom') panel.addClass('is-above-toolbar');
    this.connPropsEl = panel;

    // ── Label ────────────────────────────────────────────────────
    const labelWrap = panel.createDiv('visual-notes-conn-props-label-wrap');
    const labelInput = labelWrap.createEl('input');
    labelInput.type = 'text'; labelInput.placeholder = 'Add label…';
    labelInput.addClass('visual-notes-conn-props-label-input');
    labelInput.value = conn.label ?? '';
    const origLabel = conn.label;
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') labelInput.blur();
      else if (e.key === 'Escape') { labelInput.value = origLabel ?? ''; labelInput.blur(); }
      e.stopPropagation();
    });
    labelInput.addEventListener('blur', () => {
      const val = labelInput.value.trim() || undefined;
      if (val === conn.label) return;
      this.pushUndo(); conn.label = val;
      this.rerenderConnection(conn); this.scheduleSave();
    });

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Label size ──────────────────────────────────────────────
    const sizeGroup = panel.createDiv('visual-notes-conn-props-group visual-notes-conn-props-size-group');
    sizeGroup.createSpan({ text: 'Aa', cls: 'visual-notes-conn-props-size-hint' });
    const sizeSlider = sizeGroup.createEl('input');
    sizeSlider.type = 'range';
    sizeSlider.min = '10'; sizeSlider.max = '32'; sizeSlider.step = '1';
    sizeSlider.value = String(conn.labelSize ?? 14);
    sizeSlider.addClass('visual-notes-conn-props-size-slider');
    sizeSlider.setAttribute('aria-label', 'Label text size');
    sizeSlider.addEventListener('pointerdown', e => e.stopPropagation());
    const sizeReadout = sizeGroup.createSpan({ text: `${sizeSlider.value}`, cls: 'visual-notes-conn-props-size-value' });
    sizeReadout.setAttribute('title', 'Double-click to reset');
    // The slider fires continuously while dragging — snapshot undo once per
    // gesture (detected by a pause), not once per pixel of movement.
    let sizeUndoAt = 0;
    const applySize = (size: number) => {
      const now = Date.now();
      if (now - sizeUndoAt > 600) this.pushUndo();
      sizeUndoAt = now;
      conn.labelSize = size;
      this.rerenderConnection(conn);
      this.scheduleSave();
    };
    sizeSlider.addEventListener('input', () => {
      sizeReadout.setText(sizeSlider.value);
      applySize(Number(sizeSlider.value));
    });
    sizeReadout.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      sizeSlider.value = '14';
      sizeReadout.setText('14');
      applySize(14);
    });

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Color swatches ──────────────────────────────────────────
    const colorGroup = panel.createDiv('visual-notes-conn-props-group');
    for (const hex of CONN_COLOR_PRESETS) {
      const swatch = colorGroup.createDiv('visual-notes-conn-props-swatch');
      swatch.style.background = hex;
      swatch.setAttribute('aria-label', hex);
      swatch.toggleClass('is-active', conn.color.toLowerCase() === hex);
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo(); conn.color = hex;
        this.rerenderConnection(conn);
        colorGroup.querySelectorAll<HTMLElement>('.visual-notes-conn-props-swatch').forEach(s => s.removeClass('is-active'));
        swatch.addClass('is-active');
        this.scheduleSave();
      });
    }

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Thickness ───────────────────────────────────────────────
    const thickGroup = panel.createDiv('visual-notes-conn-props-group');
    for (const t of [2, 4, 6] as const) {
      const btn = thickGroup.createDiv('visual-notes-conn-props-btn');
      btn.setAttribute('aria-label', `Thickness ${t}`);
      btn.toggleClass('is-active', conn.thickness === t);
      const svg = createSvg('svg');
      svg.setAttribute('width', '20'); svg.setAttribute('height', '16');
      svg.setAttribute('viewBox', '0 0 20 16');
      const line = createSvg('line');
      line.setAttribute('x1', '2'); line.setAttribute('y1', '8');
      line.setAttribute('x2', '18'); line.setAttribute('y2', '8');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', String(t));
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line); btn.appendChild(svg);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo(); conn.thickness = t;
        this.rerenderConnection(conn);
        thickGroup.querySelectorAll<HTMLElement>('.visual-notes-conn-props-btn').forEach(b => b.removeClass('is-active'));
        btn.addClass('is-active');
        this.scheduleSave();
      });
    }

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Style: solid / dashed ───────────────────────────────────
    const styleGroup = panel.createDiv('visual-notes-conn-props-group');
    for (const style of ['solid', 'dashed'] as const) {
      const btn = styleGroup.createDiv('visual-notes-conn-props-btn');
      btn.setAttribute('aria-label', style);
      btn.toggleClass('is-active', conn.style === style);
      const svg = createSvg('svg');
      svg.setAttribute('width', '22'); svg.setAttribute('height', '16');
      svg.setAttribute('viewBox', '0 0 22 16');
      const line = createSvg('line');
      line.setAttribute('x1', '2'); line.setAttribute('y1', '8');
      line.setAttribute('x2', '20'); line.setAttribute('y2', '8');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-linecap', 'round');
      if (style === 'dashed') line.setAttribute('stroke-dasharray', '4 3');
      svg.appendChild(line); btn.appendChild(svg);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo(); conn.style = style;
        this.rerenderConnection(conn);
        styleGroup.querySelectorAll<HTMLElement>('.visual-notes-conn-props-btn').forEach(b => b.removeClass('is-active'));
        btn.addClass('is-active');
        this.scheduleSave();
      });
    }

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Arrowhead ───────────────────────────────────────────────
    const arrowGroup = panel.createDiv('visual-notes-conn-props-group');
    const arrowOpts: Array<{ val: Connection['arrowhead']; label: string; icon: string }> = [
      { val: 'none', label: 'No arrowheads', icon: 'minus'           },
      { val: 'end',  label: 'Arrow at end',  icon: 'arrow-right'     },
      { val: 'both', label: 'Both ends',     icon: 'arrow-left-right' },
    ];
    for (const { val, label, icon } of arrowOpts) {
      const btn = arrowGroup.createDiv('visual-notes-conn-props-btn');
      btn.setAttribute('aria-label', label);
      btn.toggleClass('is-active', conn.arrowhead === val);
      setIcon(btn, icon);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo(); conn.arrowhead = val;
        this.rerenderConnection(conn);
        arrowGroup.querySelectorAll<HTMLElement>('.visual-notes-conn-props-btn').forEach(b => b.removeClass('is-active'));
        btn.addClass('is-active');
        this.scheduleSave();
      });
    }

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Routing ─────────────────────────────────────────────────
    const routeGroup = panel.createDiv('visual-notes-conn-props-group');
    const routeOpts: Array<{ val: Connection['routing']; label: string; icon: string }> = [
      { val: 'straight', label: 'Straight line', icon: 'minus'            },
      { val: 'elbow',    label: 'Elbow route',   icon: 'corner-down-right' },
    ];
    for (const { val, label, icon } of routeOpts) {
      const btn = routeGroup.createDiv('visual-notes-conn-props-btn');
      btn.setAttribute('aria-label', label);
      btn.toggleClass('is-active', conn.routing === val);
      setIcon(btn, icon);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pushUndo(); conn.routing = val;
        this.rerenderConnection(conn);
        routeGroup.querySelectorAll<HTMLElement>('.visual-notes-conn-props-btn').forEach(b => b.removeClass('is-active'));
        btn.addClass('is-active');
        this.scheduleSave();
      });
    }

    panel.createDiv('visual-notes-conn-props-sep');

    // ── Delete ──────────────────────────────────────────────────
    const delBtn = panel.createDiv('visual-notes-conn-props-btn visual-notes-conn-props-delete');
    delBtn.setAttribute('aria-label', 'Delete connection');
    setIcon(delBtn, 'trash-2');
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSelectedConnection(); });
  },

  hideConnectionProps(this: FreeformRenderer): void {
    this.connPropsEl?.remove();
    this.connPropsEl = null;
  },
};
