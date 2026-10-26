import { setIcon, setTooltip, Platform } from 'obsidian';
import {
  Card, StickyTextScale, STICKY_TEXT_SCALES, StickyFontFamily, STICKY_FONT_FAMILIES,
  TEXT_CARD_FONT_PRESETS,
} from './file-types';
import { placeFloatingPanel } from './floating-placement';

export type CtxEvent =
  | { type: 'delete' }
  | { type: 'tile-edit' }
  // Generic "start inline-editing this card's text/title" — the handler
  // branches on card.kind. Added so single-tap-select + one visible button
  // reaches edit mode on touch devices, where the dblclick that normally
  // starts these editors is unreliable/undiscoverable.
  | { type: 'edit-card' }
  | { type: 'sticky-color'; hex: string }
  | { type: 'sticky-top-color'; hex: string | null }
  | { type: 'sticky-text-scale'; scale: StickyTextScale }
  | { type: 'sticky-bullet' }
  | { type: 'sticky-transparent'; transparent: boolean }
  | { type: 'sticky-font'; font: StickyFontFamily | null }
  | { type: 'text-font-size'; size: number }
  | { type: 'text-font'; font: StickyFontFamily | null }
  | { type: 'text-color'; hex: string }
  | { type: 'checklist-accent'; hex: string }
  | { type: 'checklist-bg'; hex: string }
  | { type: 'checklist-top-color'; hex: string | null }
  | { type: 'checklist-title' }
  | { type: 'comment-color'; hex: string }
  | { type: 'comment-resolve' }
  | { type: 'table-bg'; hex: string }
  | { type: 'table-title' }
  | { type: 'image-caption' }
  | { type: 'notelink-display' }
  | { type: 'notelink-open' }
  | { type: 'bookmark-refresh' }
  | { type: 'bookmark-copy-url' }
  | { type: 'kanban-color'; hex: string }
  | { type: 'kanban-bg'; hex: string | null }
  | { type: 'kanban-top-color'; hex: string | null }
  | { type: 'kanban-title' }
  | { type: 'kanban-add-col' }
  | { type: 'checkers-reset' }
  | { type: 'group-color'; hex: string }
  | { type: 'group-bg'; hex: string }
  | { type: 'group-transparent'; transparent: boolean };

// ── Colour palettes ───────────────────────────────────────────────────────────

const ACCENT_COLORS  = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#a855f7','#ec4899','#6b7280','#14b8a6','#f43f5e','#8b5cf6','#84cc16'];

// Card *background* fills — unlike the accent/strip colors above (already
// fully saturated, read fine in either theme), these are pale pastels
// meant to sit under dark text on a light canvas. Sitting on a dark canvas
// instead, they glare rather than blend in, which is what "colors don't
// suit dark mode" meant in practice. bgColors() swaps in a muted, deep
// counterpart per swatch (same hue family, Tailwind's 800/900 shades) once
// Obsidian's own theme is dark, so light mode keeps the original bright
// palette untouched.
const BG_COLORS_LIGHT = ['#FFFFFF','#F3F4F6','#FEF9C3','#FEE2E2','#D1FAE5','#DBEAFE','#EDE9FE','#FCE7F3','#ECFDF5','#FFF7ED','#F0F9FF','#E0F2FE'];
const BG_COLORS_DARK  = ['#1F2937','#374151','#713F12','#7F1D1D','#064E3B','#1E3A8A','#4C1D95','#831843','#134E4A','#7C2D12','#0C4A6E','#164E63'];
function BG_COLORS(dark: boolean): string[] { return dark ? BG_COLORS_DARK : BG_COLORS_LIGHT; }

const STRIP_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#a855f7','#ec4899','#6b7280','#14b8a6','#f43f5e','#1d4ed8','#84cc16'];

// ── ContextBar ────────────────────────────────────────────────────────────────

export class ContextBar {
  private ctxPanelEl!: HTMLElement;
  private trashConfirmActive = false;
  private trashTimeout: number | null = null;
  private currentCard: Card | null = null;
  private currentCardEl: HTMLElement | null = null;
  // A floating panel above the selection has nowhere good to go on a phone
  // screen (same reasoning TextFormatToolbar is disabled there) — phone
  // keeps the original design: the same fixed toolbar element repurposed in
  // place, reflowed into a bottom-docked bar by the existing CSS media
  // query. Decided once; a phone doesn't turn into a desktop mid-session.
  private readonly floating = !Platform.isPhone;

  constructor(
    private readonly toolbarEl: HTMLElement,
    private readonly container: HTMLElement,
    private readonly getTrashZoneEl: () => HTMLElement | null,
    // The board's own light/dark surface (board.appearance), not Obsidian's
    // theme — so the swatches offered match the canvas they'll land on.
    private readonly isDark: () => boolean,
    private readonly emit: (e: CtxEvent) => void,
  ) {
    if (this.floating) {
      // Screen-space sibling of the pen picker / connection-props panel /
      // pen options panel, not an in-flow toolbar child — created once and
      // toggled invisible rather than removed/recreated per show(), same
      // as the docked panel below never gets torn down either.
      this.ctxPanelEl = this.container.createDiv('visual-notes-ctx-bar-panel visual-notes-ctx-panel');
      this.ctxPanelEl.addClass('visual-notes-invisible');
    } else {
      this.ctxPanelEl = this.toolbarEl.createDiv('visual-notes-ctx-panel');
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  show(card: Card, cardEl: HTMLElement): void {
    this.currentCard = card;
    this.currentCardEl = cardEl;
    this.fill(card);
    if (this.floating) this.position(); else this.activate();
  }

  hide(): void {
    this.currentCard = null;
    this.currentCardEl = null;
    if (this.floating) { this.ctxPanelEl.addClass('visual-notes-invisible'); this.cancelTrashConfirm(); }
    else this.deactivate();
  }

  // Called after the selected card's on-screen rect changes for a reason
  // that isn't a fresh show() — dragged, resized, or the canvas itself was
  // panned/zoomed. No-op on phone (nothing floats there) or when nothing is
  // currently shown. Unlike position(), this runs synchronously with no
  // invisible/rAF flash-prevention step: the panel is already visible and
  // already close to right, this just nudges it to stay aligned.
  reposition(): void {
    if (!this.floating || !this.currentCardEl) return;
    this.applyPosition();
  }

  destroy(): void {
    if (this.trashTimeout !== null) window.clearTimeout(this.trashTimeout);
  }

  // ── Panel activation (docked/phone mode only) ───────────────────────────────

  private activate(): void {
    this.toolbarEl.addClass('visual-notes-ctx-active');
  }

  private deactivate(): void {
    this.toolbarEl.removeClass('visual-notes-ctx-active');
    this.cancelTrashConfirm();
  }

  // ── Positioning (floating mode only) ────────────────────────────────────────

  // Same measure-then-clamp approach as TextFormatToolbar.position(): hide,
  // measure on the next frame (so the just-rebuilt content has real
  // dimensions), position, reveal — avoids a visible flash at a stale spot
  // when show() targets a different card than whatever was last positioned.
  private position(): void {
    this.ctxPanelEl.addClass('visual-notes-invisible');
    window.requestAnimationFrame(() => {
      this.applyPosition();
      this.ctxPanelEl.removeClass('visual-notes-invisible');
    });
  }

  private applyPosition(): void {
    const cardEl = this.currentCardEl;
    if (!cardEl) return;
    const cardRect = cardEl.getBoundingClientRect();

    // The card is in `avoid`, not just used as the anchor: clamping the panel
    // back inside the container is what used to park it on top of a card
    // taller than the viewport, so the overlap pass has to run after the
    // clamp and win. The trash zone is the same idea — it used to need its own
    // bespoke nudge here, and now goes through the same path.
    const avoid = [cardRect];
    const trash = this.getTrashZoneEl();
    if (trash) avoid.push(trash.getBoundingClientRect());

    const { top, left } = placeFloatingPanel({
      anchor: cardRect,
      container: this.container.getBoundingClientRect(),
      panelW: this.ctxPanelEl.offsetWidth,
      panelH: this.ctxPanelEl.offsetHeight,
      prefer: 'above',
      avoid,
    });

    this.ctxPanelEl.setCssStyles({ top: `${top}px`, left: `${left}px`, right: '', bottom: '' });
  }

  // Sub-panels (color grid, bg/strip tabs) resize the already-visible panel
  // well beyond its initial icon-row footprint — re-measure in place so it
  // doesn't end up positioned for a panel half its eventual size. Safe to
  // call synchronously (unlike position()): the panel is already visible,
  // so there's nothing to flash.
  private syncPos(): void {
    if (this.floating) this.applyPosition();
  }

  // ── Fill by card type ────────────────────────────────────────────────────────

  private fill(card: Card): void {
    const p = this.ctxPanelEl;
    p.empty();
    this.cancelTrashConfirm();

    this.mkBack(p, () => this.hide());

    switch (card.kind) {
      case 'tile':
        this.mkBtn(p, 'Edit', 'edit-2', () => this.emit({ type: 'tile-edit' }));
        break;

      case 'sticky':
        // Explicit entry into edit mode — dblclick (the only other way in)
        // is unreliable on touch devices. Bold/Italic/Underline/Strike used
        // to live here too, but they only ever worked while the sticky was
        // already in text-edit mode (they applied to the current text
        // selection) — selecting the card without entering edit mode left
        // them silently doing nothing. TextFormatToolbar already covers the
        // same commands (plus Color/Highlight) the moment text is actually
        // selected, so they were pure duplication once genuinely fixed.
        this.mkBtn(p, 'Edit', 'edit-2', () => this.emit({ type: 'edit-card' }));
        // Keeps the caret alive: without suppressing the default pointerdown
        // the click blurs the editor, and the sticky's blur handler commits
        // and tears it down before the bullet could be applied. Same trick
        // TextFormatToolbar uses on its own popover.
        this.mkBtn(p, 'Bullet', 'list', () => this.emit({ type: 'sticky-bullet' }))
          .addEventListener('pointerdown', e => e.preventDefault());
        this.mkBtn(p, 'Size', 'a-large-small', () => this.openTextScaleSub(p, card));
        this.mkBtn(p, 'Font', 'type', () => this.openFontSub(p, card));
        this.mkBtn(p, 'Color', 'palette', () => this.openBgTopColorSub(
          p, card,
          BG_COLORS(this.isDark()),
          hex => this.emit({ type: 'sticky-color', hex }),
          STRIP_COLORS,
          hex => this.emit({ type: 'sticky-top-color', hex }),
          'Top strip',
          {
            value: card.transparent ?? false,
            // "No background" rather than the group frame's "Transparent":
            // the request this came from was phrased as not wanting the
            // background at all, and a note has no see-through tint state to
            // distinguish it from.
            label: 'No background',
            onChange: transparent => this.emit({ type: 'sticky-transparent', transparent }),
          },
        ));
        break;

      case 'text':
        this.mkBtn(p, 'Edit', 'edit-2', () => this.emit({ type: 'edit-card' }));
        this.mkBtn(p, 'Size', 'a-large-small', () => this.openTextSizeSub(p, card));
        this.mkBtn(p, 'Font', 'type', () => this.openFontSub(p, card));
        // Text colour only — a text card has no background to set.
        this.mkBtn(p, 'Color', 'palette', () => this.openColorSub(p, ACCENT_COLORS, hex => this.emit({ type: 'text-color', hex }), card));
        break;

      case 'checklist':
        this.mkBtn(p, 'Color', 'palette', () => this.openBgTopColorSub(
          p, card,
          BG_COLORS(this.isDark()),
          hex => this.emit({ type: 'checklist-bg', hex }),
          ACCENT_COLORS,
          hex => this.emit({ type: 'checklist-top-color', hex }),
        ));
        this.mkBtn(p, 'Title', 'heading', () => this.emit({ type: 'checklist-title' }));
        break;

      case 'table':
        this.mkBtn(p, 'Color', 'palette', () => this.openColorSub(p, BG_COLORS(this.isDark()), hex => this.emit({ type: 'table-bg', hex }), card));
        this.mkBtn(p, 'Title', 'heading', () => this.emit({ type: 'table-title' }));
        break;

      case 'comment':
        this.mkBtn(p, 'Color', 'palette', () => this.openColorSub(p, ACCENT_COLORS, hex => this.emit({ type: 'comment-color', hex }), card));
        this.mkBtn(p, card.resolved ? 'Unresolve' : 'Resolve', card.resolved ? 'rotate-ccw' : 'check', () => this.emit({ type: 'comment-resolve' }));
        break;

      case 'image':
        this.mkBtn(p, 'Caption', 'align-left', () => this.emit({ type: 'image-caption' }));
        break;

      case 'note-link':
        this.mkBtn(p, 'Display', 'layout-list',   () => this.emit({ type: 'notelink-display' }));
        this.mkBtn(p, 'Open',    'external-link', () => this.emit({ type: 'notelink-open' }));
        break;

      case 'bookmark':
        this.mkBtn(p, 'Refresh',  'refresh-cw', () => this.emit({ type: 'bookmark-refresh' }));
        this.mkBtn(p, 'Copy URL', 'copy',        () => this.emit({ type: 'bookmark-copy-url' }));
        break;

      case 'kanban-column':
        this.mkBtn(p, 'Color', 'palette', () => this.openBgTopColorSub(
          p, card,
          BG_COLORS(this.isDark()),
          hex => this.emit({ type: 'kanban-bg', hex }),
          STRIP_COLORS,
          hex => this.emit({ type: 'kanban-top-color', hex }),
        ));
        this.mkBtn(p, 'Title',   'heading', () => this.emit({ type: 'kanban-title' }));
        this.mkBtn(p, 'Add col', 'columns', () => this.emit({ type: 'kanban-add-col' }));
        break;

      case 'kanban-board':
        // Per-column color/background/WIP now live on each column's own
        // "..." menu (right-click won't do it justice with several columns
        // in play) — the global context bar just handles the board-level
        // title and adding another column.
        this.mkBtn(p, 'Title',    'heading', () => this.emit({ type: 'kanban-title' }));
        this.mkBtn(p, 'Add col',  'columns', () => this.emit({ type: 'kanban-add-col' }));
        break;

      case 'audio':
        // no specific actions
        break;

      case 'checkers':
        this.mkBtn(p, 'New game', 'rotate-ccw', () => this.emit({ type: 'checkers-reset' }));
        break;

      // Text-bearing kinds that previously had no context-bar case at all
      // (only Back + Delete) and whose editors were dblclick-only.
      case 'callout':
        this.mkBtn(p, 'Edit', 'edit-2', () => this.emit({ type: 'edit-card' }));
        break;

      case 'group':
        this.mkBtn(p, 'Rename', 'edit-2', () => this.emit({ type: 'edit-card' }));
        this.mkBtn(p, 'Color', 'palette', () => this.openBgTopColorSub(
          p, card,
          BG_COLORS(this.isDark()),
          hex => this.emit({ type: 'group-bg', hex }),
          ACCENT_COLORS,
          // "None" resets the border/label to the default grey rather than
          // removing it outright — unlike a sticky's optional top strip, a
          // group frame's border is how you tell it apart from the plain
          // canvas, so there's no sensible "no border" state to drop to.
          hex => this.emit({ type: 'group-color', hex: hex ?? '#6b7280' }),
          'Border',
          {
            value: card.transparent ?? true,
            onChange: transparent => this.emit({ type: 'group-transparent', transparent }),
          },
        ));
        break;

      case 'calendar':
      case 'column':
        this.mkBtn(p, 'Title', 'heading', () => this.emit({ type: 'edit-card' }));
        break;
    }

    this.mkTrash(p);
    this.syncPos();
  }

  // ── Background + Top strip two-tab picker ────────────────────────────────────

  private openBgTopColorSub(
    p: HTMLElement,
    card: Card,
    bgColors: string[],
    onBg: (hex: string) => void,
    stripColors: string[],
    onStrip: (hex: string | null) => void,
    // Sticky/Checklist/Kanban column all call this for an actual pale fill
    // + a top accent strip, so those two labels are the defaults. A group
    // frame reuses the same two-tab mechanics for a pale fill + its
    // border/label color — "Top strip" would describe nothing there, so it
    // passes its own second label instead of the generic one.
    stripLabel = 'Top strip',
    // Group frames only: an explicit fill can be switched off in favor of
    // the original see-through tint without losing whatever fill color was
    // picked, so flipping it back on later doesn't need reselecting.
    bgTransparent?: { value: boolean; label?: string; onChange: (transparent: boolean) => void },
  ): void {
    p.empty();
    this.cancelTrashConfirm();
    this.mkBack(p, () => this.fill(card));

    // Tab row
    const tabRow = p.createDiv('visual-notes-ctx-tab-row');
    const bgTab    = tabRow.createDiv('visual-notes-ctx-tab visual-notes-ctx-tab--active');
    bgTab.setText('Background');
    const stripTab = tabRow.createDiv('visual-notes-ctx-tab');
    stripTab.setText(stripLabel);

    // Swatch area (re-rendered on tab switch)
    const swatchArea = p.createDiv('visual-notes-ctx-swatch-area');

    const renderSwatches = (tab: 'bg' | 'strip') => {
      swatchArea.empty();
      if (tab === 'bg') {
        // bgTransparent.value is only ever the snapshot read when the panel
        // opened — mkToggleRow renders it once and has no memory of its own,
        // so without mutating it here every re-render would draw the switch
        // back at its original position regardless of how many times it'd
        // actually been flipped.
        if (bgTransparent) this.mkToggleRow(swatchArea, bgTransparent.label ?? 'Transparent', bgTransparent.value, (v) => {
          bgTransparent.value = v;
          bgTransparent.onChange(v);
          renderSwatches('bg');
        });
        const grid = swatchArea.createDiv('visual-notes-ctx-color-grid');
        for (const hex of bgColors) {
          const sw = grid.createDiv('visual-notes-ctx-color-swatch');
          sw.style.background = hex;
          if (['#FFFFFF','#F3F4F6','#E0F2FE','#F0F9FF'].includes(hex))
            sw.addClass('visual-notes-swatch-border-light');
          // Doesn't touch the Transparent toggle — picking a color and
          // choosing how solid it is are independent questions, so this
          // never silently overrides whatever the switch above is set to.
          sw.addEventListener('click', () => onBg(hex));
        }
        this.mkCustomColor(swatchArea, onBg, () => {});
      } else {
        const grid = swatchArea.createDiv('visual-notes-ctx-color-grid');
        // "None" swatch removes the strip
        const noneSw = grid.createDiv('visual-notes-ctx-color-swatch visual-notes-ctx-color-swatch--none');
        noneSw.setAttribute('aria-label', 'None');
        noneSw.addEventListener('click', () => onStrip(null));
        for (const hex of stripColors) {
          const sw = grid.createDiv('visual-notes-ctx-color-swatch');
          sw.style.background = hex;
          sw.addEventListener('click', () => onStrip(hex));
        }
        this.mkCustomColor(swatchArea, onStrip, () => {});
      }
    };

    bgTab.addEventListener('click', () => {
      bgTab.addClass('visual-notes-ctx-tab--active');
      stripTab.removeClass('visual-notes-ctx-tab--active');
      renderSwatches('bg');
      this.syncPos();
    });
    stripTab.addEventListener('click', () => {
      stripTab.addClass('visual-notes-ctx-tab--active');
      bgTab.removeClass('visual-notes-ctx-tab--active');
      renderSwatches('strip');
      this.syncPos();
    });

    renderSwatches('bg');
    this.mkTrash(p);
    this.syncPos();
  }

  // ── Text size sub-panel (Note/Card) ─────────────────────────────────────────

  // Multiplies the global "Card text size" setting rather than replacing it,
  // so a board stays internally consistent when that setting is changed later.
  private openTextScaleSub(p: HTMLElement, card: Card): void {
    p.empty();
    this.cancelTrashConfirm();
    this.mkBack(p, () => this.fill(card));

    const current = (card.kind === 'sticky' ? card.textScale : undefined) ?? 'md';
    const row = p.createDiv('visual-notes-ctx-size-row');
    const labels: Record<StickyTextScale, string> = {
      xs: 'XS', sm: 'S', md: 'M', lg: 'L', xl: 'XL', xxl: '2X', xxxl: '3X', huge: '4X',
    };
    for (const key of Object.keys(STICKY_TEXT_SCALES) as StickyTextScale[]) {
      const btn = row.createDiv('visual-notes-ctx-size-btn');
      btn.setText(labels[key]);
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-label', `Text size ${labels[key]}`);
      setTooltip(btn, `Text size ${labels[key]}`);
      if (key === current) btn.addClass('is-active');
      const choose = () => { this.emit({ type: 'sticky-text-scale', scale: key }); this.openTextScaleSub(p, card); };
      btn.addEventListener('click', choose);
      btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    }

    this.mkTrash(p);
    this.syncPos();
  }

  // ── Text card size sub-panel ─────────────────────────────────────────────────

  // Absolute px, the same unit dragging a corner writes. That's the whole
  // point: an earlier version had presets as multipliers while the drag was
  // open-ended, so picking a preset after dragging something large silently
  // shrank it.
  private openTextSizeSub(p: HTMLElement, card: Card): void {
    p.empty();
    this.cancelTrashConfirm();
    this.mkBack(p, () => this.fill(card));

    const current = card.kind === 'text' ? card.fontSize : undefined;
    const row = p.createDiv('visual-notes-ctx-size-row');
    for (const size of TEXT_CARD_FONT_PRESETS) {
      const btn = row.createDiv('visual-notes-ctx-size-btn');
      btn.setText(String(size));
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-label', `Font size ${size}`);
      setTooltip(btn, `Font size ${size}px`);
      if (current === size) btn.addClass('is-active');
      const choose = () => { this.emit({ type: 'text-font-size', size }); this.openTextSizeSub(p, card); };
      btn.addEventListener('click', choose);
      btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    }

    this.mkTrash(p);
    this.syncPos();
  }

  // ── Font sub-panel ───────────────────────────────────────────────────────────

  // Obsidian's own three fonts plus a Default reset. Deliberately not a free
  // font-name field: these are the faces the user already configured under
  // Appearance → Font, so they exist on every platform the plugin runs on and
  // a board doesn't render differently on iPad than on desktop.
  private openFontSub(p: HTMLElement, card: Card): void {
    p.empty();
    this.cancelTrashConfirm();
    this.mkBack(p, () => this.fill(card));

    const current = card.kind === 'sticky' || card.kind === 'text' ? card.fontFamily : undefined;
    const emitFont = (font: StickyFontFamily | null) =>
      this.emit(card.kind === 'text' ? { type: 'text-font', font } : { type: 'sticky-font', font });
    const options: { key: StickyFontFamily | null; label: string }[] = [
      { key: null,         label: 'Default' },
      { key: 'text',       label: 'Text' },
      { key: 'interface',  label: 'Interface' },
      { key: 'monospace',  label: 'Mono' },
    ];

    const row = p.createDiv('visual-notes-ctx-font-row');
    for (const { key, label } of options) {
      const btn = row.createDiv('visual-notes-ctx-font-btn');
      btn.setText(label);
      if (key) btn.style.fontFamily = STICKY_FONT_FAMILIES[key];
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-label', `Font ${label}`);
      setTooltip(btn, key ? `Obsidian ${label} font. Configure fonts in Settings > Appearance. Text and Interface may use the same font.` : 'Use the default card font. This may match the Obsidian Text or Interface font.');
      if ((current ?? null) === key) btn.addClass('is-active');
      const choose = () => { emitFont(key); this.openFontSub(p, card); };
      btn.addEventListener('click', choose);
      btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    }

    this.mkTrash(p);
    this.syncPos();
  }

  // ── Color sub-panel ──────────────────────────────────────────────────────────

  private openColorSub(
    p: HTMLElement,
    colors: string[],
    onSelect: (hex: string) => void,
    card: Card,
  ): void {
    p.empty();
    this.cancelTrashConfirm();
    this.mkBack(p, () => this.fill(card));

    const grid = p.createDiv('visual-notes-ctx-color-grid');
    for (const hex of colors) {
      const sw = grid.createDiv('visual-notes-ctx-color-swatch');
      sw.style.background = hex;
      if (['#F3F4F6','#D1D5DB'].includes(hex))
        sw.addClass('visual-notes-swatch-border-light');
      sw.addEventListener('click', () => { onSelect(hex); this.fill(card); });
    }

    this.mkCustomColor(p, onSelect, () => this.fill(card));
    this.mkTrash(p);
    this.syncPos();
  }

  // A labelled on/off switch — currently only the group frame's Background
  // tab needs one, so this stays a small standalone control rather than
  // wrapping Obsidian's own Setting/ToggleComponent, which expect a full
  // Setting row and don't attach to a bare panel like this one.
  private mkToggleRow(p: HTMLElement, label: string, value: boolean, onChange: (value: boolean) => void): void {
    const row = p.createDiv('visual-notes-ctx-toggle-row');
    row.createSpan({ cls: 'visual-notes-ctx-toggle-label', text: label });
    const sw = row.createDiv('visual-notes-ctx-toggle');
    sw.toggleClass('is-on', value);
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(value));
    sw.setAttribute('tabindex', '0');
    sw.createDiv('visual-notes-ctx-toggle-knob');
    const toggle = () => { const next = !sw.hasClass('is-on'); onChange(next); };
    sw.addEventListener('click', toggle);
    sw.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }

  private mkCustomColor(p: HTMLElement, onSelect: (hex: string) => void, onBack: () => void): void {
    const inp = p.createEl('input');
    inp.type = 'color';
    inp.addClass('visual-notes-ctx-color-wheel-input');
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    inp.addEventListener('change', () => { onSelect(inp.value); onBack(); });

    const btn = this.mkBtn(p, 'Custom', 'pipette', () => inp.click());
    btn.prepend(inp);
  }

  // ── Button helpers ───────────────────────────────────────────────────────────

  // The floating panel hides .visual-notes-tb-btn-label via CSS (icon-only,
  // matching native Canvas's compact selection toolbar) — setTooltip gives
  // it back as a native hover tooltip instead. Harmless to set unconditionally
  // for the docked/phone panel too, where the label is already visible.
  private mkBtn(parent: HTMLElement, label: string, icon: string, handler: () => void): HTMLElement {
    const btn = parent.createDiv('visual-notes-tb-btn');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', label);
    setTooltip(btn, label);
    const ic = btn.createDiv('visual-notes-tb-btn-icon');
    setIcon(ic, icon);
    const labelSpan = btn.createSpan('visual-notes-tb-btn-label');
    labelSpan.setText(label);
    btn.addEventListener('click', handler);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    return btn;
  }

  private mkBack(parent: HTMLElement, handler: () => void): void {
    const back = parent.createDiv('visual-notes-ctx-back-btn');
    back.setAttribute('tabindex', '0');
    back.setAttribute('aria-label', 'Back');
    setTooltip(back, 'Back');
    setIcon(back, 'arrow-left');
    back.addEventListener('click', handler);
    back.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
  }

  private mkTrash(parent: HTMLElement): void {
    parent.createDiv('visual-notes-ctx-spacer');
    parent.createDiv('visual-notes-ctx-trash-sep');

    const btn = parent.createDiv('visual-notes-tb-btn visual-notes-ctx-trash-btn');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', 'Delete');
    setTooltip(btn, 'Delete');
    const ic = btn.createDiv('visual-notes-tb-btn-icon');
    setIcon(ic, 'trash-2');
    const labelEl = btn.createSpan('visual-notes-tb-btn-label');
    labelEl.setText('Delete');

    // Icon-only mode has no visible label to show "Sure?" on, so the red
    // visual-notes-ctx-trash--confirm background is the primary confirm signal there;
    // the label/tooltip text still updates too, for the docked panel and
    // for anyone hovering the floating one.
    const confirm = () => {
      if (this.trashConfirmActive) { this.emit({ type: 'delete' }); return; }
      this.trashConfirmActive = true;
      labelEl.setText('Sure?');
      setTooltip(btn, 'Sure?');
      btn.addClass('visual-notes-ctx-trash--confirm');
      if (this.trashTimeout !== null) window.clearTimeout(this.trashTimeout);
      this.trashTimeout = window.setTimeout(() => {
        this.trashTimeout = null;
        this.trashConfirmActive = false;
        labelEl.setText('Delete');
        setTooltip(btn, 'Delete');
        btn.removeClass('visual-notes-ctx-trash--confirm');
      }, 3000);
    };

    btn.addEventListener('click', confirm);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirm(); } });
  }

  private cancelTrashConfirm(): void {
    if (this.trashTimeout !== null) { window.clearTimeout(this.trashTimeout); this.trashTimeout = null; }
    this.trashConfirmActive = false;
  }
}
