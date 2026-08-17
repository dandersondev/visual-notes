import {
  TFile, Menu, Notice, setIcon, setTooltip, Platform,
} from 'obsidian';
import { TouchActionSheet } from './touch-action-sheet';
import {
  ChecklistCard, ChecklistItem, VideoCard, STICKY_FONT_FAMILIES,
} from './file-types';
import {
  parseYouTubeId,
  isGoogleMapsUrl,
} from './thumbnail-utils';
import { nearestColorName, randomNamedColor, COLOR_PALETTES } from './named-colors';
import { contrastColor, isHexColor, isDarkTheme } from './color-utils';
import { applyColorScheme, otherScheme, schemeOf } from './theme-scheme';
import { TileModal } from './tile-modal';
import { LabelPromptModal, ReactionPickerModal } from './card-badges';
import {
  screenToCanvas, clampZoom,
} from './canvas/pan-zoom';
import { ContextBar, CtxEvent } from './context-bar';
import { sortAssetFile, saveNewAsset, deliverExport } from './asset-manager';
import { promptSaveBoardAsTemplate } from './file-io';
import { CropImageModal } from './crop-modal';
import { toggleBulletList } from './bullet-list';
import { toPng } from 'html-to-image';
import { buildSingleImagePdf, dataUrlToBytes } from './pdf-export';
import {
  TILE_DEFAULT_W, TILE_DEFAULT_H, STICKY_DEFAULT_W,
  BOOKMARK_DEFAULT_W,
  SWATCH_DEFAULT_W,
  KANBAN_COLORS,
  applyStickyTextScale,
  SupportedCard,
  NoteLinkPickerModal, VaultImagePickerModal, VaultAudioPickerModal, VaultAnyFilePickerModal, VIDEO_EXTS,
  CalloutIconPickerModal, QuickAddEntry,
  QuickAddModal,
  KanbanItemColorModal, WipLimitModal, BookmarkInputModal,
  openExternalUrl, inlineRemoteImages, EXPORT_IMAGE_TOLERANCE,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    newMenu(): Menu;
    populateCardMenu(menu: Menu, el: HTMLElement, card: SupportedCard): void;
    renderToolbar(): void;
    renderTrashZone(): void;
    renderUndoRedoButtons(): void;
    refreshUndoRedoButtons(): void;
    toggleOverflow(anchor: HTMLElement): void;
    closeOverflow(): void;
    closeFab(): void;
    showAccentColorPopover(cardEl: HTMLElement, card: ChecklistCard): void;
    renderZoomPill(): void;
    renderAppearanceButton(): void;
    refreshAppearanceButton(): void;
    boardIsDark(): boolean;
    renderMinimap(): void;
    computeBoardBBox(): { minX: number; minY: number; maxX: number; maxY: number } | null;
    computeExportBBox(only?: Set<string>): { minX: number; minY: number; maxX: number; maxY: number } | null;
    exportBoard(format: 'png' | 'pdf', only?: Set<string>): Promise<void>;
    zoomToFit(): void;
    updateMinimapCards(): void;
    updateMinimapViewportRect(): void;
    stripHtml(html: string): string;
    cardSearchText(card: SupportedCard): string;
    renderSearchWidget(): void;
    openSearch(): void;
    closeSearch(): void;
    runSearch(query: string): void;
    gotoMatch(dir: number): void;
    updateSearchCount(): void;
    cardFilterKeys(card: SupportedCard, into?: Set<string>): Set<string>;
    renderFilterWidget(): void;
    rebuildFilterPanel(): void;
    applyFilters(): void;
    openQuickAdd(): void;
    renderAlignBar(): void;
    handleCtxEvent(e: CtxEvent): void;
  }
}

// ── Board export (PNG / PDF) ────────────────────────────────────────────
//
// Interactive-only chrome that lives inside `this.inner` alongside the real
// board content — resize handles, the (invisible-but-present) connection
// hit-testing SVG layer, connection endpoint/bend handles, and the drawing
// selection box — none of which should show up in an exported snapshot.
// Everything else overlay-ish (toolbar, minimap, search, zoom pill, …) is
// already a sibling of `this.inner`, not a descendant, so capturing just
// `this.inner` excludes it for free.
const EXPORT_EXCLUDED_CLASSES = [
  'visual-notes-card-resize-handle',
  'visual-notes-connections-hit-svg',
  'visual-notes-drawing-select-box',
  'visual-notes-drawing-resize-handle',
  'visual-notes-connection-handle',
  'visual-notes-connection-bend-handle',
];

function exportNodeFilter(node: HTMLElement): boolean {
  if (node.nodeType !== 1) return true;
  const el = node as Element;
  if (el.tagName === 'IFRAME') return false; // live embeds (YouTube/Maps/file) can't be rasterized
  const cl = el.classList;
  if (cl) for (const c of EXPORT_EXCLUDED_CLASSES) if (cl.contains(c)) return false;
  return true;
}

export const overlaysMethods = {
  newMenu(this: FreeformRenderer): Menu {
    // Phones get a custom bottom action sheet instead of Obsidian's
    // desktop-positioned Menu — the long-press → synthetic contextmenu →
    // showAtMouseEvent chain didn't reliably produce a visible menu on the
    // iPhone app. TouchActionSheet mirrors the Menu surface every call
    // site here uses, so the cast is safe (see its header comment).
    if (Platform.isPhone) return new TouchActionSheet() as unknown as Menu;
    const menu = new Menu();
    (menu as unknown as { dom?: HTMLElement }).dom?.addClass('visual-notes-ctx-menu');
    return menu;
  },

  populateCardMenu(this: FreeformRenderer, menu: Menu, el: HTMLElement, card: SupportedCard): void {
    if (card.kind === 'storyboard') {
      menu.addItem(i => i.setTitle('Open storyboard editor').setIcon('maximize-2').onClick(() => this.openStoryboardEditor(card)));
      menu.addItem(i => i.setTitle(card.view === 'grid' ? 'Use filmstrip preview' : 'Use grid preview').setIcon('gallery-horizontal-end').onClick(() => {
        this.pushUndo(); card.view = card.view === 'grid' ? 'filmstrip' : 'grid'; this.renderCardContent(el, card); this.scheduleSave();
      }));
      menu.addSeparator();
    }

    if (card.kind === 'tile') {
      menu.addItem(i => i.setTitle('Edit').setIcon('pencil').onClick(() => {
        new TileModal(this.app, card, (updated) => {
          const idx = this.board.cards.findIndex(c => c.id === updated.id);
          if (idx !== -1) {
            this.board.cards[idx] = updated; this.cardEls.delete(card.id);
            this.renderCardContent(el, updated);
            this.cardEls.set(updated.id, el); void this.saveNow();
          }
        }, this.file).open();
      }));
    }

    if (card.kind === 'sticky') {
      menu.addItem(i => i.setTitle('Edit text').setIcon('pencil').onClick(() => this.editStickyInline(el, card)));
      if (card.blank) {
        menu.addSeparator();
        const applyShape = (shape: 'rect' | 'round') => {
          card.shape = shape;
          el.removeClass('is-shape-round');
          const fill = el.querySelector<HTMLElement>('.visual-notes-sticky-shape-fill');
          fill?.removeClass('is-shape-round');
          if (shape === 'round') { el.addClass('is-shape-round'); fill?.addClass('is-shape-round'); }
        };
        menu.addItem(i => i.setTitle('Rectangle').setIcon('square').setChecked(!card.shape || card.shape === 'rect').onClick(() => {
          this.pushUndo(); applyShape('rect'); this.scheduleSave();
        }));
        menu.addItem(i => i.setTitle('Circle').setIcon('circle').setChecked(card.shape === 'round').onClick(() => {
          this.pushUndo();
          const side = Math.max(card.w ?? STICKY_DEFAULT_W, card.h ?? STICKY_DEFAULT_W);
          card.w = side; card.h = side;
          el.style.width = `${side}px`; el.style.height = `${side}px`;
          applyShape('round');
          this.updateConnectionsForCard(card.id);
          this.scheduleSave();
        }));
      }
    }

    if (card.kind === 'checklist') {
      menu.addItem(i => i.setTitle('Add section header').setIcon('heading').onClick(() => {
        const listEl = el.querySelector<HTMLElement>('.visual-notes-checklist-list');
        if (!listEl) return;
        this.pushUndo();
        const newItem: ChecklistItem = { id: crypto.randomUUID(), text: '', done: false, isHeader: true };
        card.items.push(newItem);
        const row = this.appendChecklistItem(listEl, card, newItem);
        listEl.appendChild(row);
        window.setTimeout(() => row.querySelector<HTMLElement>('.visual-notes-checklist-item-input')?.focus(), 0);
        this.scheduleSave();
      }));
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Change accent colour…').setIcon('palette').onClick(() => {
        this.showAccentColorPopover(el, card);
      }));
    }

    if (card.kind === 'note-link') {
      menu.addItem(i => i.setTitle('Change note…').setIcon('file-text').onClick(() => {
        new NoteLinkPickerModal(this.app, (file) => {
          this.pushUndo(); card.path = file.path;
          this.renderCardContent(el, card); this.scheduleSave();
        }).open();
      }));
    }

    if (card.kind === 'image') {
      menu.addItem(i => i.setTitle('Choose from vault…').setIcon('folder-open').onClick(() => {
        new VaultImagePickerModal(this.app, (file) => {
          this.pushUndo(); card.source = { type: 'vault', path: file.path };
          // A genuinely different image — any prior crop's "original" no
          // longer applies to it.
          card.originalSource = undefined;
          this.renderCardContent(el, card); this.scheduleSave();
        }).open();
      }));
      menu.addItem(i => i.setTitle('Crop image…').setIcon('crop').onClick(() => {
        // Crop always opens on the full pre-crop original (captured the
        // first time this card is cropped, untouched by every re-crop after
        // that) — never on the previous crop's result — so re-cropping lets
        // you pick a different region of the whole image instead of
        // progressively cropping an already-cropped image down to nothing.
        const cropSource = card.originalSource ?? card.source;
        new CropImageModal(this.app, cropSource, (out) => { void (async () => {
          const baseName = (cropSource.type === 'vault'
            ? cropSource.path.split('/').pop()!.replace(/\.[^.]+$/, '')
            : 'image');
          let newPath: string;
          try { newPath = await saveNewAsset(this.app, await out.blob.arrayBuffer(), `${baseName}-cropped.${out.ext}`); }
          catch { new Notice('Failed to save cropped image.'); return; }
          this.pushUndo();
          card.originalSource = card.originalSource ?? cropSource;
          card.source = { type: 'vault', path: newPath };
          // renderImageContent's own fixAspect recomputes card.h from the
          // new image's aspect ratio against the card's existing width once
          // it loads — no need to duplicate that math here.
          this.renderCardContent(el, card);
          this.scheduleSave();
        })(); }).open();
      }));
      menu.addSeparator();
      menu.addItem(i => i
        .setTitle(card.captionHidden ? 'Show caption' : 'Hide caption')
        .setIcon('type')
        .onClick(() => {
          this.pushUndo(); card.captionHidden = !card.captionHidden;
          const wrap = el.querySelector<HTMLElement>('.visual-notes-image-caption-wrap');
          if (wrap) wrap.toggleClass('is-hidden', !!card.captionHidden);
          this.scheduleSave();
        }));
      menu.addSeparator();
      const applyCapStyle = () => {
        const view = el.querySelector<HTMLElement>('.visual-notes-image-caption-view');
        const ta = el.querySelector<HTMLElement>('.visual-notes-image-caption');
        [view, ta].forEach(n => {
          if (!n) return;
          n.className = n.className.replace(/\btext-scale-\S+/g, '').trim();
          if (card.captionScale) n.classList.add(`text-scale-${card.captionScale}`);
          n.style.color = card.captionColor ?? '';
        });
        this.scheduleSave();
      };
      menu.addItem(i => i.setTitle('Caption size: Small').setChecked(card.captionScale === 'sm').onClick(() => {
        this.pushUndo(); card.captionScale = 'sm'; applyCapStyle();
      }));
      menu.addItem(i => i.setTitle('Caption size: Medium').setChecked(!card.captionScale || card.captionScale === 'md').onClick(() => {
        this.pushUndo(); card.captionScale = 'md'; applyCapStyle();
      }));
      menu.addItem(i => i.setTitle('Caption size: Large').setChecked(card.captionScale === 'lg').onClick(() => {
        this.pushUndo(); card.captionScale = 'lg'; applyCapStyle();
      }));
      // Caption colour used to have its own discrete "Caption: Red/Grey/…"
      // menu here too — removed as a duplicate of selecting the caption
      // text and using the floating text-format toolbar's colour picker,
      // which already covers this (and more precisely, per-selection).
    }

    if (card.kind === 'audio') {
      menu.addItem(i => i.setTitle('Choose from vault…').setIcon('folder-open').onClick(() => {
        new VaultAudioPickerModal(this.app, (file) => {
          this.pushUndo(); card.source = { type: 'vault', path: file.path };
          this.renderCardContent(el, card); this.scheduleSave();
        }).open();
      }));
    }

    if (card.kind === 'bookmark') {
      menu.addItem(i => i.setTitle('Refresh preview').setIcon('refresh-cw').onClick(() => {
        card.fetchFailed = false; card.fetchedAt = undefined;
        this.renderCardContent(el, card);
        void this.fetchAndUpdateBookmark(card, el);
      }));
      menu.addItem(i => i.setTitle('Copy URL').setIcon('copy').onClick(() => {
        void navigator.clipboard.writeText(card.url); new Notice('URL copied.');
      }));
      if (parseYouTubeId(card.url)) {
        menu.addItem(i => i
          .setTitle(card.youtubeHeaderShown ? 'Hide header' : 'Show header')
          .setIcon('heading')
          .onClick(() => {
            this.pushUndo(); card.youtubeHeaderShown = !card.youtubeHeaderShown;
            this.renderCardContent(el, card);
            // Keep the video itself 16:9 — the card grows/shrinks by the
            // header strip's height instead of squishing the embed.
            const headerH = el.querySelector<HTMLElement>('.visual-notes-bookmark-youtube-header')?.offsetHeight ?? 0;
            card.h = Math.round((card.w ?? BOOKMARK_DEFAULT_W) * 9 / 16) + headerH;
            el.style.height = `${card.h}px`;
            this.scheduleSave();
          }));
      }
    }

    if (card.kind === 'map') {
      menu.addItem(i => i.setTitle('Open in Google Maps').setIcon('external-link').onClick(() => {
        openExternalUrl(card.url);
      }));
      menu.addItem(i => i.setTitle('Copy URL').setIcon('copy').onClick(() => {
        void navigator.clipboard.writeText(card.url); new Notice('URL copied.');
      }));
      menu.addItem(i => i.setTitle('Change link…').setIcon('pencil').onClick(() => {
        new BookmarkInputModal(this.app, (u) => {
          if (!isGoogleMapsUrl(u)) { new Notice('That doesn’t look like a Google Maps link.'); return; }
          this.pushUndo();
          card.url = u; card.resolvedUrl = undefined; card.resolveFailed = false;
          this.renderCardContent(el, card);
          this.scheduleSave();
        }, 'Change map link').open();
      }));
    }

    if (card.kind === 'swatch') {
      menu.addItem(i => i.setTitle('Copy hex').setIcon('copy').onClick(() => {
        void navigator.clipboard.writeText(card.color.toUpperCase()); new Notice('Hex copied.');
      }));
      menu.addItem(i => i.setTitle('Copy name').setIcon('copy').onClick(() => {
        void navigator.clipboard.writeText(nearestColorName(card.color)); new Notice('Color name copied.');
      }));
      menu.addItem(i => i.setTitle('Randomize color').setIcon('shuffle').onClick(() => {
        this.pushUndo();
        card.color = randomNamedColor().hex;
        this.renderCardContent(el, card);
        this.scheduleSave();
      }));
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Palette grid').setIcon('swatch-book').setIsLabel(true));
      for (const palette of COLOR_PALETTES) {
        menu.addItem(i => i.setTitle(palette.label).onClick(() => {
          const gx = this.applySnap((card.x ?? 0) + (card.w ?? SWATCH_DEFAULT_W) + 24);
          const gy = this.applySnap(card.y ?? 0);
          this.createSwatchGrid(gx, gy, palette.colors);
        }));
      }
    }

    if (card.kind === 'file') {
      // Boards built before video cards existed are full of file cards
      // pointing at videos, and nothing would ever upgrade them on its own —
      // rewriting them at load would edit the user's file behind their back
      // for a purely cosmetic gain. Offering it per card is explicit, and
      // undo puts it straight back.
      if (VIDEO_EXTS.includes(card.path.split('.').pop()?.toLowerCase() ?? '')) {
        menu.addItem(i => i.setTitle('Play on canvas').setIcon('file-video').onClick(() => {
          this.pushUndo();
          const video: VideoCard = {
            id: card.id, kind: 'video',
            x: card.x, y: card.y, w: card.w, h: card.h, z: card.z,
            source: { type: 'vault', path: card.path },
          };
          const i = this.board.cards.findIndex(c => c.id === card.id);
          if (i === -1) return;
          this.board.cards[i] = video;
          this.rebuildCards();
          this.selection.select(video.id);
          this.refreshSelectionVisuals();
          this.scheduleSave();
        }));
      }
      menu.addItem(i => i.setTitle('Open').setIcon('external-link').onClick(() => {
        void this.openFileCard(card);
      }));
      menu.addItem(i => i.setTitle('Copy path').setIcon('copy').onClick(() => {
        void navigator.clipboard.writeText(card.path); new Notice('Path copied.');
      }));
      menu.addItem(i => i.setTitle('Change file…').setIcon('pencil').onClick(() => {
        new VaultAnyFilePickerModal(this.app, (f) => { void (async () => {
          this.pushUndo();
          card.path = await sortAssetFile(this.app, f);
          this.renderCardContent(el, card);
          this.scheduleSave();
        })(); }).open();
      }));
    }

    if (card.kind === 'callout') {
      menu.addItem(i => i.setTitle('Change icon…').setIcon('smile').onClick(() => {
        new CalloutIconPickerModal(this.app, card.icon ?? '💡', (icon) => {
          this.pushUndo();
          card.icon = icon;
          this.renderCardContent(el, card);
          this.scheduleSave();
        }).open();
      }));
      const CALLOUT_COLORS: { name: string; hex: string }[] = [
        { name: 'Blue',   hex: '#3b82f6' },
        { name: 'Green',  hex: '#22c55e' },
        { name: 'Amber',  hex: '#f59e0b' },
        { name: 'Red',    hex: '#ef4444' },
        { name: 'Purple', hex: '#a855f7' },
        { name: 'Grey',   hex: '#6b7280' },
      ];
      for (const { name, hex } of CALLOUT_COLORS) {
        menu.addItem(i => i.setTitle(name).setChecked(card.color.toLowerCase() === hex).onClick(() => {
          this.pushUndo();
          card.color = hex;
          this.renderCardContent(el, card);
          this.scheduleSave();
        }));
      }
    }

    if (card.kind === 'group') {
      menu.addItem(i => i.setTitle('Rename…').setIcon('pencil').onClick(() => this.editGroupLabel(el, card)));
      const GROUP_COLORS: { name: string; hex: string }[] = [
        { name: 'Grey',   hex: '#6b7280' },
        { name: 'Blue',   hex: '#3b82f6' },
        { name: 'Green',  hex: '#22c55e' },
        { name: 'Amber',  hex: '#f59e0b' },
        { name: 'Red',    hex: '#ef4444' },
        { name: 'Purple', hex: '#a855f7' },
      ];
      for (const { name, hex } of GROUP_COLORS) {
        menu.addItem(i => i.setTitle(name).setChecked((card.color ?? '#6b7280').toLowerCase() === hex).onClick(() => {
          this.pushUndo();
          card.color = hex;
          this.renderCardContent(el, card);
          this.scheduleSave();
        }));
      }
    }

    if (card.kind === 'kanban-column') {
      const doneCnt = card.items.filter(i => i.done).length;
      for (const { color, name } of KANBAN_COLORS) {
        menu.addItem(i => i
          .setTitle(name)
          .setChecked(card.color.toLowerCase() === color)
          .onClick(() => {
            this.pushUndo();
            card.color = color;
            this.rebuildKanbanCard(card);
            this.scheduleSave();
          }));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Set WIP limit…').setIcon('hash').onClick(() => {
        new WipLimitModal(this.app, card.wipLimit, (limit) => {
          this.pushUndo();
          card.wipLimit = limit;
          this.rebuildKanbanCard(card);
          this.scheduleSave();
        }).open();
      }));
      if (doneCnt > 0) {
        menu.addItem(i => i
          .setTitle(`Clear ${doneCnt} done item${doneCnt !== 1 ? 's' : ''}`)
          .setIcon('check-check')
          .onClick(() => {
            this.pushUndo();
            card.items = card.items.filter(i => !i.done);
            this.rebuildKanbanCard(card);
            this.scheduleSave();
          }));
      }
      menu.addSeparator();
    }

    if (card.kind === 'column') {
      menu.addItem(i => i.setTitle(card.titleHidden ? 'Show title' : 'Hide title').setIcon('heading').onClick(() => {
        this.pushUndo();
        card.titleHidden = !card.titleHidden;
        this.rebuildKanbanCard(card);
        this.scheduleSave();
      }));
      if (!card.titleHidden) {
        menu.addItem(i => i.setTitle('Set title color…').setIcon('palette').onClick(() => {
          new KanbanItemColorModal(this.app, card.color, (hex) => {
            this.pushUndo(); card.color = hex;
            this.rebuildKanbanCard(card); this.scheduleSave();
          }, this.boardIsDark()).open();
        }));
      }
      menu.addItem(i => i.setTitle('Set background color…').setIcon('palette').onClick(() => {
        new KanbanItemColorModal(this.app, card.bgColor, (hex) => {
          this.pushUndo(); card.bgColor = hex;
          this.rebuildKanbanCard(card); this.scheduleSave();
        }, this.boardIsDark()).open();
      }));
      menu.addItem(i => i.setTitle('Set drop area color…').setIcon('palette').onClick(() => {
        new KanbanItemColorModal(this.app, card.trayColor, (hex) => {
          this.pushUndo(); card.trayColor = hex;
          this.rebuildKanbanCard(card); this.scheduleSave();
        }, this.boardIsDark()).open();
      }));
      menu.addItem(i => i.setTitle('Set border color…').setIcon('palette').onClick(() => {
        new KanbanItemColorModal(this.app, card.borderColor, (hex) => {
          this.pushUndo(); card.borderColor = hex;
          this.rebuildKanbanCard(card); this.scheduleSave();
        }, this.boardIsDark()).open();
      }));
      menu.addSeparator();
    }

    const selIds = this.selection.getIds();
    if (selIds.length > 1) {
      menu.addSeparator();
      menu.addItem(i => i.setTitle('Align left').setIcon('align-left').onClick(() => this.alignCards('left')));
      menu.addItem(i => i.setTitle('Align center').setIcon('align-center').onClick(() => this.alignCards('center-h')));
      menu.addItem(i => i.setTitle('Align right').setIcon('align-right').onClick(() => this.alignCards('right')));
      menu.addItem(i => i.setTitle('Align top').setIcon('align-start-vertical').onClick(() => this.alignCards('top')));
      menu.addItem(i => i.setTitle('Align middle').setIcon('align-center-vertical').onClick(() => this.alignCards('middle-v')));
      menu.addItem(i => i.setTitle('Align bottom').setIcon('align-end-vertical').onClick(() => this.alignCards('bottom')));
      menu.addItem(i => i.setTitle('Distribute horizontally').setIcon('arrows-left-right').onClick(() => this.alignCards('distribute-h')));
      menu.addItem(i => i.setTitle('Distribute vertically').setIcon('arrows-up-down').onClick(() => this.alignCards('distribute-v')));
    }

    if (card.nestedBoardPath) {
      menu.addItem(i => i.setTitle('Open nested board').setIcon('layout-template').onClick(() => {
        this.openNestedBoard(card.nestedBoardPath!, (p) => { card.nestedBoardPath = p; }, card.nestedBoardRoomId, (id) => { card.nestedBoardRoomId = id; });
      }));
      menu.addItem(i => i.setTitle('Unlink nested board').setIcon('unlink').onClick(() => {
        this.pushUndo();
        card.nestedBoardPath = undefined; card.nestedBoardIcon = undefined; card.nestedBoardRoomId = undefined;
        this.renderCardBadges(el, card);
        this.scheduleSave();
      }));
    } else {
      menu.addItem(i => i.setTitle('Create nested board…').setIcon('layout-template').onClick(() => {
        this.createNestedBoardFrom(this.cardDisplayName(card), (path, icon, roomId) => {
          this.pushUndo();
          card.nestedBoardPath = path; card.nestedBoardIcon = icon; card.nestedBoardRoomId = roomId;
          this.renderCardBadges(el, card);
        });
      }));
    }
    menu.addSeparator();

    menu.addItem(i => i.setTitle('Add label…').setIcon('tag').onClick(() => {
      new LabelPromptModal(this.app, (text, color) => {
        this.pushUndo();
        card.labels = [...(card.labels ?? []), { id: crypto.randomUUID(), text, color }];
        this.renderCardBadges(el, card);
        this.scheduleSave();
      }).open();
    }));
    menu.addItem(i => i.setTitle('Add reaction…').setIcon('smile').onClick(() => {
      new ReactionPickerModal(this.app, card.reactions ?? [], (emoji) => {
        this.pushUndo();
        const cur = card.reactions ?? [];
        card.reactions = cur.includes(emoji) ? cur.filter(r => r !== emoji) : [...cur, emoji];
        this.renderCardBadges(el, card);
        this.scheduleSave();
      }).open();
    }));
    menu.addSeparator();

    menu.addItem(i => i.setTitle('Copy').setIcon('copy').onClick(() => this.copySelection()));
    menu.addItem(i => i.setTitle('Cut').setIcon('scissors').onClick(() => this.copySelection(true)));
    menu.addItem(i => i.setTitle('Duplicate').setIcon('copy-plus').onClick(() => this.duplicateSelected()));
    menu.addItem(i => i.setTitle('Archive').setIcon('archive').onClick(() => this.archiveSelected()));
    if (this.selection.getIds().length > 1) {
      menu.addItem(i => i.setTitle('Group selection').setIcon('frame').onClick(() => this.groupSelected()));
    }
    // Saves the selection to _Templates/Groups/ so it can be dropped onto
    // any board later from the canvas menu's "Templates" entry.
    menu.addItem(i => i.setTitle('Create template…').setIcon('layout-template').onClick(() =>
      this.promptSaveSelectionAsTemplate()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('Bring to front').setIcon('chevrons-up').onClick(() => {
      const maxZ = Math.max(0, ...this.board.cards.map(c => c.z ?? 0));
      let off = 1;
      for (const id of this.selection.getIds()) {
        const c = this.board.cards.find(c => c.id === id);
        const cel = this.cardEls.get(id);
        if (c) { c.z = maxZ + off++; if (cel) cel.setCssProps({ '--card-z': String(c.z) }); }
      }
      this.scheduleSave();
    }));
    menu.addItem(i => i.setTitle('Send to back').setIcon('chevrons-down').onClick(() => {
      const minZ = Math.min(0, ...this.board.cards.map(c => c.z ?? 0));
      let off = 1;
      for (const id of this.selection.getIds()) {
        const c = this.board.cards.find(c => c.id === id);
        const cel = this.cardEls.get(id);
        if (c) { c.z = minZ - off++; if (cel) cel.setCssProps({ '--card-z': String(c.z) }); }
      }
      this.scheduleSave();
    }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('Delete').setIcon('trash').onClick(() => this.deleteSelected()));
  },

  renderToolbar(this: FreeformRenderer): void {
    const tb = this.toolbarEl = this.container.createDiv('visual-notes-freeform-toolbar');
    tb.addClass(`tb-pos-${this.toolbarPosition}`);

    // Obsidian opens a sidebar on a horizontal swipe, and dragging a card off
    // this toolbar is exactly that shape -- so on iPad the sidebar slid open
    // mid-drag. Two separate things had to be stopped, which is why it took
    // two goes:
    //
    //   - The *browser* treating the touch as a scroll, which cancelled the
    //     drag outright. That is touch-action: none on .visual-notes-tb-btn,
    //     and it worked: the drag now places its card.
    //   - *Obsidian's own* recogniser, which is JavaScript listening for touch
    //     events. touch-action cannot influence that at all -- it governs the
    //     browser's gestures, not another script's. The events have to stop
    //     reaching it instead.
    //
    // Hence this: touches that begin on the toolbar do not travel any further
    // up the tree. The swipe still belongs to Obsidian everywhere else,
    // including the screen edge, which is where the gesture is meant to be
    // made -- the canvas gives that strip up for the same reason, see
    // isInEdgeSwipeZone.
    //
    // preventDefault on touchmove as well as stopPropagation, because a
    // recogniser reading document-level events in the capture phase is past
    // stopPropagation's reach, and checking defaultPrevented is the usual
    // courtesy. touchstart is deliberately NOT prevented: that would suppress
    // the compatibility click these buttons need for tap-to-arm.
    //
    // Skipped on phones, where this panel is a scrolling bottom sheet that
    // needs its own touch events -- the same exemption the touch-action rule
    // makes in the max-width: 540px block.
    if (!Platform.isPhone) {
      tb.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { capture: true, passive: true });
      tb.addEventListener('touchmove', (e) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }, { capture: true, passive: false });
    }

    // ── Add panel (slot layer shown when no card is selected) ──
    const addPanel = tb.createDiv('visual-notes-add-panel');

    // ── Primary buttons ──
    const mkBtn = (label: string, icon: string, tool: string, onClick?: () => void): HTMLElement => {
      const btn = addPanel.createDiv('visual-notes-tb-btn');
      btn.setAttribute('tabindex', '0'); btn.setAttribute('aria-label', label);
      const iconEl = btn.createDiv('visual-notes-tb-btn-icon');
      setIcon(iconEl, icon);
      const labelSpan = btn.createSpan('visual-notes-tb-btn-label');
      labelSpan.setText(label);
      const handler = onClick ?? (() => this.activateTool(tool, btn));
      // closeFab: picking a tool from the phone bottom sheet dismisses the
      // sheet so the canvas is immediately tappable to place the card
      // (no-op everywhere else — the sheet only opens on phone widths).
      btn.addEventListener('click', () => { handler(); this.closeFab(); });
      btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); this.closeFab(); } });

      // ── Drag to place ──
      {
        btn.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          let dragging = false;
          let ghost: HTMLElement | null = null;
          const sx = e.clientX, sy = e.clientY;

          const onMove = (me: PointerEvent) => {
            if (!dragging && Math.hypot(me.clientX - sx, me.clientY - sy) > 8) {
              dragging = true;
              ghost = activeDocument.body.createDiv('visual-notes-toolbar-drag-ghost');
              setIcon(ghost, icon);
            }
            if (ghost) { ghost.style.left = `${me.clientX}px`; ghost.style.top = `${me.clientY}px`; }
          };
          const detach = () => {
            activeDocument.removeEventListener('pointermove', onMove);
            activeDocument.removeEventListener('pointerup', onUp);
            activeDocument.removeEventListener('pointercancel', onCancel);
            ghost?.remove(); ghost = null;
          };
          // iOS/iPadOS hands a touch to its own scroll/pan gesture rather than
          // to the page unless the element opts out with touch-action: none
          // (see .visual-notes-tb-btn). When it does, it fires pointercancel
          // and stops sending pointermove -- so before that CSS existed, no
          // drag from this toolbar could ever start on an iPad, reported as
          // being unable to drag anything onto the canvas at all. The listeners
          // were never removed either, since pointerup does not follow a
          // cancel: one leaked pair per attempted drag, each still building a
          // ghost on the next stray pointermove.
          const onCancel = () => { dragging = false; detach(); };
          const onUp = (ue: PointerEvent) => {
            detach();
            if (!dragging) return;
            const r = this.outer.getBoundingClientRect();
            if (ue.clientX < r.left || ue.clientX > r.right || ue.clientY < r.top || ue.clientY > r.bottom) return;
            const cp = screenToCanvas(ue.clientX - r.left, ue.clientY - r.top, this.vp);
            this.clearPendingTool();
            this.pendingTool = tool;
            this.pendingToolBtn = null;
            this.placePendingTool(cp.x, cp.y);
          };
          activeDocument.addEventListener('pointermove', onMove);
          activeDocument.addEventListener('pointerup', onUp);
          activeDocument.addEventListener('pointercancel', onCancel);
        });
      }

      return btn;
    };

    // ── Mode buttons: select / hand ──
    //
    // Ahead of the placement tools and separated from them, because they are
    // a different kind of control: a mode that persists, not a card waiting to
    // be placed. They deliberately skip mkBtn's drag-to-place wiring, which
    // would be meaningless here.
    //
    // Asked for as "press H for hand and V for pointer". The keys are bound in
    // docKeyDown; these exist so the same thing is discoverable and reachable
    // without a keyboard -- the request came from someone working on a
    // trackpad, where the middle/right-button pan is awkward at best.
    const mkModeBtn = (label: string, icon: string, mode: 'select' | 'hand'): HTMLElement => {
      const btn = addPanel.createDiv('visual-notes-tb-btn visual-notes-tb-mode-btn');
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-label', `${label} (${mode === 'hand' ? 'H' : 'V'})`);
      const iconEl = btn.createDiv('visual-notes-tb-btn-icon');
      setIcon(iconEl, icon);
      btn.createSpan('visual-notes-tb-btn-label').setText(label);
      const act = () => { this.setInteractionMode(mode); this.closeFab(); };
      btn.addEventListener('click', act);
      btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      return btn;
    };
    this.selectModeBtn = mkModeBtn('Select', 'mouse-pointer-2', 'select');
    this.handModeBtn = mkModeBtn('Hand', 'hand', 'hand');
    // setInteractionMode early-returns when the mode is unchanged, so the
    // starting state has to be marked here rather than by calling it.
    this.selectModeBtn.addClass('is-active');
    addPanel.createDiv('visual-notes-tb-mode-sep');

    this.textToolBtn = mkBtn('Text', 'type', 'text');
    mkBtn('Note',    'square',           'blank-card');
    mkBtn('Tile',    'layout-template', 'tile-board');
    mkBtn('Sticky',  'sticky-note',  'sticky');
    mkBtn('Link',    'link',         'bookmark');
    mkBtn('To-do',   'list-checks',  'checklist');
    this.connectToolBtn = mkBtn('Line', 'arrow-up-right', 'connect', () => this.toggleConnectMode());
    mkBtn('Kanban',  'columns-3',    'kanban');
    mkBtn('Column',  'rows-3',       'column');
    this.penToolBtn = mkBtn('Pen', 'pencil', 'pen', () => this.togglePenMode());

    // ── Overflow separator + button ──
    addPanel.createDiv('visual-notes-tb-overflow-sep');
    const overflowBtn = addPanel.createDiv('visual-notes-tb-btn visual-notes-tb-overflow-btn');
    overflowBtn.setAttribute('tabindex', '0'); overflowBtn.setAttribute('aria-label', 'More…');
    overflowBtn.setText('···');
    overflowBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleOverflow(overflowBtn); });
    overflowBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleOverflow(overflowBtn); }
    });

    // ── Mobile FAB ──
    // Corner is user-configurable (mobileFabPosition) since the default
    // bottom-right spot is also where the minimap/zoom/snap controls live.
    // The class goes on `tb` itself (that's what's actually positioned in
    // the phone media query) and again on `this.container` so those other
    // widgets — separate DOM siblings, not descendants of `tb` — can shift
    // to whichever bottom corner the FAB *isn't* in (see styles.css).
    tb.addClass(`fab-corner-${this.mobileFabPosition}`);
    this.container.addClass(`mobile-fab-${this.mobileFabPosition}`);
    const fab = this.fabEl = tb.createDiv('visual-notes-freeform-toolbar-fab');
    fab.setAttribute('aria-label', 'Add card');
    setIcon(fab, 'plus');
    fab.addEventListener('click', (e) => {
      e.stopPropagation();
      tb.toggleClass('is-open', !tb.hasClass('is-open'));
      fab.empty();
      setIcon(fab, tb.hasClass('is-open') ? 'x' : 'plus');
    });

    // ── Context bar (occupies the same slot, shown when a card is selected) ──
    this.contextBar = new ContextBar(tb, this.container, () => this.trashZoneEl, () => this.boardIsDark(), e => this.handleCtxEvent(e));
  },

  // ── Board appearance ──

  // Whether the board's surface reads as dark. Sourced from Obsidian's theme
  // alone: boards could previously pin their own light/dark surface via a
  // canvas toggle, but two independent places to change appearance confused
  // people more than the flexibility helped, so the toggle was removed and the
  // theme is now the single source of truth. A legacy `appearance` value on an
  // existing board is preserved in the file (see canvas-format) but not read.
  boardIsDark(): boolean {
    return isDarkTheme();
  },

  renderTrashZone(this: FreeformRenderer): void {
    const zone = this.container.createDiv('visual-notes-trash-zone');
    zone.setAttribute('aria-label', 'Drag here to delete');
    setIcon(zone, 'trash-2');
    this.trashZoneEl = zone;
  },

  // Stacked above the trash zone rather than tucked in the toolbar, so it
  // stays put regardless of toolbarPosition and is reachable one-handed —
  // the same reasoning as the trash zone's own placement.
  renderUndoRedoButtons(this: FreeformRenderer): void {
    const group = this.container.createDiv('visual-notes-undo-redo-group');

    const undoBtn = group.createDiv('visual-notes-undo-redo-btn');
    undoBtn.setAttribute('aria-label', 'Undo');
    setTooltip(undoBtn, 'Undo');
    setIcon(undoBtn, 'undo-2');
    undoBtn.addEventListener('click', () => { if (this.undoStack.length) this.undo(); });
    this.undoBtnEl = undoBtn;

    const redoBtn = group.createDiv('visual-notes-undo-redo-btn');
    redoBtn.setAttribute('aria-label', 'Redo');
    setTooltip(redoBtn, 'Redo');
    setIcon(redoBtn, 'redo-2');
    redoBtn.addEventListener('click', () => { if (this.redoStack.length) this.redo(); });
    this.redoBtnEl = redoBtn;

    this.refreshUndoRedoButtons();
  },

  refreshUndoRedoButtons(this: FreeformRenderer): void {
    this.undoBtnEl?.toggleClass('is-disabled', this.undoStack.length === 0);
    this.redoBtnEl?.toggleClass('is-disabled', this.redoStack.length === 0);
  },

  toggleOverflow(this: FreeformRenderer, anchor: HTMLElement): void {
    if (this.overflowPopover) { this.closeOverflow(); return; }

    const pop = this.overflowPopover = this.container.createDiv('visual-notes-tb-overflow');
    const mkItem = (label: string, icon: string, onClick: (btn: HTMLElement) => void) => {
      const btn = pop.createDiv('visual-notes-tb-overflow-item');
      btn.setAttribute('tabindex', '0');
      const iconEl = btn.createDiv('visual-notes-tb-overflow-icon');
      setIcon(iconEl, icon);
      btn.createSpan({ text: label });
      const handler = () => { this.closeOverflow(); this.closeFab(); onClick(btn); };
      btn.addEventListener('click', handler);
      btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    };
    const mkOv = (label: string, icon: string, tool: string) => {
      mkItem(label, icon, (btn) => this.activateTool(tool, btn));
    };
    mkOv('Image',     'image',     'image');
    mkOv('Audio',     'music',     'audio');
    mkOv('Video',     'file-video', 'video');
    mkOv('Note Link', 'file-text', 'notelink');
    mkOv('Comment',   'message-square', 'comment');
    mkOv('Table',     'table',     'table');
    mkOv('Map',       'map-pin',   'map');
    mkOv('Swatch',    'pipette',   'swatch');
    mkOv('File',      'paperclip', 'file');
    mkOv('Callout',   'megaphone', 'callout');
    mkOv('Group',     'frame',     'group');
    mkOv('Calendar',  'calendar-days',  'calendar');
    mkOv('Checkers',  'crown',          'checkers');
    mkOv('Storyboard','clapperboard',    'storyboard');
    pop.createDiv('visual-notes-tb-overflow-divider');
    mkItem('Save as template…', 'save', () => promptSaveBoardAsTemplate(this.app, this.file));

    // Position the overflow relative to the anchor based on toolbar side
    const aRect = anchor.getBoundingClientRect();
    const cRect = this.container.getBoundingClientRect();
    if (this.toolbarPosition === 'right') {
      pop.setCssStyles({ top: `${aRect.top - cRect.top}px`, right: `${cRect.right - aRect.left + 8}px` });
    } else if (this.toolbarPosition === 'bottom') {
      pop.setCssStyles({ bottom: `${cRect.bottom - aRect.top + 8}px`, left: `${aRect.left - cRect.left}px` });
    } else if (this.toolbarPosition === 'top') {
      pop.setCssStyles({ top: `${aRect.bottom - cRect.top + 8}px`, left: `${aRect.left - cRect.left}px` });
    } else {
      pop.setCssStyles({ top: `${aRect.top - cRect.top}px`, left: `${aRect.right - cRect.left + 8}px` });
    }

    // Clamp into the container so the panel is never cut off at an edge —
    // on short windows the "…" button sits near the toolbar's bottom and
    // the anchor-aligned position above would run past the viewport
    // (reported: menu items unreachable on small screens). Measure the
    // rendered panel, convert whichever sides were set into top/left, and
    // pull it fully inside; the CSS max-height makes it scroll instead of
    // overflowing when the container is shorter than the menu itself.
    const margin = 8;
    const pRect = pop.getBoundingClientRect();
    let top  = pRect.top  - cRect.top;
    let left = pRect.left - cRect.left;
    top  = Math.max(margin, Math.min(top,  cRect.height - margin - pRect.height));
    left = Math.max(margin, Math.min(left, cRect.width  - margin - pRect.width));
    pop.setCssStyles({ top: `${top}px`, left: `${left}px`, bottom: '', right: '' });

    // Dismiss on outside click
    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor) {
        this.closeOverflow();
        activeDocument.removeEventListener('mousedown', onOutside);
      }
    };
    window.setTimeout(() => activeDocument.addEventListener('mousedown', onOutside), 0);
  },

  closeOverflow(this: FreeformRenderer): void {
    this.overflowPopover?.remove();
    this.overflowPopover = null;
  },

  closeFab(this: FreeformRenderer): void {
    if (!this.toolbarEl.hasClass('is-open')) return;
    this.toolbarEl.removeClass('is-open');
    if (this.fabEl) { this.fabEl.empty(); setIcon(this.fabEl, 'plus'); }
  },

  showAccentColorPopover(this: FreeformRenderer, cardEl: HTMLElement, card: ChecklistCard): void {
    const existing = this.container.querySelector<HTMLElement>('.visual-notes-accent-pop');
    if (existing) { existing.remove(); return; }

    const pop = this.container.createDiv('visual-notes-accent-pop');

    const palette = pop.createDiv('visual-notes-accent-pop-palette');
    const ACCENT_COLORS = [
      '#EF4444', '#F59E0B', '#EAB308', '#84CC16',
      '#10B981', '#06B6D4', '#3B82F6', '#8B5CF6',
      '#EC4899', '#64748B', '#44403C', '#FFFFFF',
    ];
    for (const hex of ACCENT_COLORS) {
      const sw = palette.createDiv('visual-notes-accent-pop-swatch');
      sw.style.backgroundColor = hex;
      if (hex === card.accentColor) sw.addClass('is-selected');
      if (hex === '#FFFFFF') sw.addClass('has-border');
      sw.addEventListener('click', () => {
        this.pushUndo(); card.accentColor = hex;
        const bar = cardEl.querySelector<HTMLElement>('.visual-notes-checklist-accent');
        if (bar) bar.style.backgroundColor = hex;
        this.scheduleSave(); pop.remove();
      });
    }

    const hexRow = pop.createDiv('visual-notes-accent-pop-hex-row');
    const hexInput = hexRow.createEl('input', { cls: 'visual-notes-accent-pop-hex', type: 'text', placeholder: '#EF4444' });
    hexInput.value = card.accentColor ?? '';
    hexInput.addEventListener('pointerdown', e => e.stopPropagation());
    hexInput.addEventListener('change', () => {
      const val = hexInput.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        this.pushUndo(); card.accentColor = val;
        const bar = cardEl.querySelector<HTMLElement>('.visual-notes-checklist-accent');
        if (bar) bar.style.backgroundColor = val;
        this.scheduleSave(); pop.remove();
      }
    });

    // Position popover near the card
    const cRect = this.container.getBoundingClientRect();
    const eRect = cardEl.getBoundingClientRect();
    pop.style.top  = `${eRect.bottom - cRect.top + 6}px`;
    pop.style.left = `${eRect.left - cRect.left}px`;

    const dismiss = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) { pop.remove(); activeDocument.removeEventListener('mousedown', dismiss); }
    };
    window.setTimeout(() => activeDocument.addEventListener('mousedown', dismiss), 0);
  },

  renderZoomPill(this: FreeformRenderer): void {
    this.zoomPill = this.container.createDiv('visual-notes-zoom-pill');
    this.zoomPill.setAttribute('title', 'Click to reset zoom to 100%');
    this.zoomPill.setText(`${Math.round(this.vp.zoom * 100)}%`);
    this.zoomPill.addEventListener('click', () => { this.vp = { x: 0, y: 0, zoom: 1 }; this.applyViewport(); this.scheduleSave(); });

    this.snapToggleBtn = this.container.createDiv('visual-notes-snap-toggle-btn');
    this.snapToggleBtn.setAttribute('title', 'Toggle snap to grid');
    setIcon(this.snapToggleBtn, 'magnet');
    this.snapToggleBtn.toggleClass('is-active', this.snapToGridEnabled);
    this.snapToggleBtn.addEventListener('click', () => this.toggleSnapToGrid());
  },

  // Continues the bottom-right row leftward from the snap toggle. Unlike
  // everything else in that corner this reaches outside the board entirely,
  // changing Obsidian's own Appearance setting — hence the setting that
  // hides it, and the wording of the tooltip, which says "Obsidian" rather
  // than leaving the user to guess how far the switch reaches.
  renderAppearanceButton(this: FreeformRenderer): void {
    if (!this.appearanceButtonEnabled) return;
    const btn = this.appearanceBtn = this.container.createDiv('visual-notes-appearance-btn');
    btn.addEventListener('click', () => {
      const target = otherScheme(schemeOf(isDarkTheme()));
      if (!applyColorScheme(this.app, target)) {
        new Notice(
          'Visual Notes: this version of Obsidian doesn’t let plugins change the colour scheme. ' +
          'Settings → Appearance → Base color scheme still works.',
          8000,
        );
      }
      // Deliberately no icon update here. The button follows the theme, not
      // the click — refreshAppearanceButton runs on the workspace's css-change
      // event, so it can never end up showing a switch that didn't happen.
    });
    this.refreshAppearanceButton();
  },

  refreshAppearanceButton(this: FreeformRenderer): void {
    const btn = this.appearanceBtn;
    if (!btn) return;
    // Shows where the button goes, not where you are — a sun means "make it
    // light". The tooltip removes any doubt about which reading is intended.
    const target = otherScheme(schemeOf(isDarkTheme()));
    const label = target === 'dark' ? 'Switch Obsidian to dark mode' : 'Switch Obsidian to light mode';
    btn.empty();
    setIcon(btn, target === 'dark' ? 'moon' : 'sun');
    setTooltip(btn, label);
    btn.setAttribute('aria-label', label);
  },

  renderMinimap(this: FreeformRenderer): void {
    const wrap = this.minimapEl = this.container.createDiv('visual-notes-minimap');

    const panel = wrap.createDiv('visual-notes-minimap-panel');
    const header = panel.createDiv('visual-notes-minimap-header');
    header.createDiv({ cls: 'visual-notes-minimap-title', text: 'Overview' });
    const fitBtn = header.createDiv('visual-notes-minimap-fit-btn');
    setIcon(fitBtn, 'scan');
    fitBtn.setAttribute('aria-label', 'Zoom to fit all cards');
    fitBtn.addEventListener('click', (e) => { e.stopPropagation(); this.zoomToFit(); });

    const body = this.minimapBodyEl = panel.createDiv('visual-notes-minimap-body');
    this.minimapViewportEl = body.createDiv('visual-notes-minimap-viewport');

    const jumpTo = (clientX: number, clientY: number) => {
      if (!this.minimapTransform) return;
      const r = body.getBoundingClientRect();
      const { scale, offX, offY, bbox } = this.minimapTransform;
      const canvasX = (clientX - r.left - offX) / scale + bbox.minX;
      const canvasY = (clientY - r.top - offY) / scale + bbox.minY;
      const outerRect = this.outer.getBoundingClientRect();
      this.vp = {
        x: outerRect.width / 2 - canvasX * this.vp.zoom,
        y: outerRect.height / 2 - canvasY * this.vp.zoom,
        zoom: this.vp.zoom,
      };
      this.applyViewport();
    };
    body.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      jumpTo(e.clientX, e.clientY);
      const onMove = (ev: PointerEvent) => jumpTo(ev.clientX, ev.clientY);
      const onUp = () => {
        activeDocument.removeEventListener('pointermove', onMove);
        activeDocument.removeEventListener('pointerup', onUp);
        this.scheduleSave();
      };
      activeDocument.addEventListener('pointermove', onMove);
      activeDocument.addEventListener('pointerup', onUp);
    });

    const toggle = wrap.createDiv('visual-notes-minimap-toggle');
    setIcon(toggle, 'map');
    toggle.setAttribute('aria-label', 'Toggle overview map');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.minimapOpen = !this.minimapOpen;
      wrap.toggleClass('is-open', this.minimapOpen);
      if (this.minimapOpen) this.updateMinimapCards();
    });
  },

  computeBoardBBox(this: FreeformRenderer): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.board.cards.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.board.cards) {
      const x = c.x ?? 0, y = c.y ?? 0;
      const w = c.w ?? TILE_DEFAULT_W, h = c.h ?? TILE_DEFAULT_H;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    }
    return { minX, minY, maxX, maxY };
  },

  // Like computeBoardBBox, but also unions in ink drawing points and any
  // free-floating connection endpoints (fromPoint/toPoint, unset when that
  // end is anchored to a card instead) — content computeBoardBBox's callers
  // (minimap, zoom-to-fit) don't need, but a board export must include so a
  // pen stroke or dangling arrow off to the side doesn't get cropped out.
  /**
   * The area an export covers. Given a set of card ids it measures only those,
   * which is what "export what I selected" needs: the region is the selection's
   * own bounds rather than the whole board's. Drawings and free-floating
   * connection endpoints are whole-board concerns and are skipped when
   * scoping, so a selection cannot be stretched by a stray line elsewhere.
   */
  computeExportBBox(this: FreeformRenderer, only?: Set<string>): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const c of this.board.cards) {
      if (only && !only.has(c.id)) continue;
      const x = c.x ?? 0, y = c.y ?? 0;
      const w = c.w ?? TILE_DEFAULT_W, h = c.h ?? TILE_DEFAULT_H;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      any = true;
    }
    for (const d of only ? [] : this.board.drawings) {
      for (const p of d.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        any = true;
      }
    }
    for (const conn of this.board.connections) {
      if (!conn.fromCardId && conn.fromPoint) {
        minX = Math.min(minX, conn.fromPoint.x); minY = Math.min(minY, conn.fromPoint.y);
        maxX = Math.max(maxX, conn.fromPoint.x); maxY = Math.max(maxY, conn.fromPoint.y);
        any = true;
      }
      if (!conn.toCardId && conn.toPoint) {
        minX = Math.min(minX, conn.toPoint.x); minY = Math.min(minY, conn.toPoint.y);
        maxX = Math.max(maxX, conn.toPoint.x); maxY = Math.max(maxY, conn.toPoint.y);
        any = true;
      }
    }
    return any ? { minX, minY, maxX, maxY } : null;
  },

  async exportBoard(this: FreeformRenderer, format: 'png' | 'pdf', only?: Set<string>): Promise<void> {
    const bbox = this.computeExportBBox(only);
    if (!bbox) {
      new Notice(only ? 'Nothing to export — no cards are selected.' : 'Nothing to export — the board is empty.');
      return;
    }

    const notice = new Notice(only ? 'Exporting selection…' : 'Exporting board…', 0);
    try {
      const PAD = 40;
      const rawW = Math.max(1, bbox.maxX - bbox.minX) + PAD * 2;
      const rawH = Math.max(1, bbox.maxY - bbox.minY) + PAD * 2;
      // Render at 2x for a crisp export, but back off if that would produce
      // an unreasonably large canvas for a big board (memory scales with
      // width*height*4 bytes*pixelRatio^2).
      const MAX_CANVAS_DIM = 8000;
      let pixelRatio = 2;
      if (rawW * pixelRatio > MAX_CANVAS_DIM || rawH * pixelRatio > MAX_CANVAS_DIM) {
        pixelRatio = Math.max(1, Math.floor(MAX_CANVAS_DIM / Math.max(rawW, rawH)));
      }
      const width = Math.round(rawW), height = Math.round(rawH);
      const bg = getComputedStyle(this.outer).backgroundColor || '#e6e6e6';

      // Remote pictures have to be resolved before the rasteriser sees them,
      // or a single unreachable one rejects the whole export — see
      // inlineRemoteImages for the mechanism. Restored in the finally below,
      // because this mutates the live board.
      const restoreImages = await inlineRemoteImages(this.inner);
      let dataUrl: string;
      try {
        dataUrl = await toPng(this.inner, {
          width, height, pixelRatio, backgroundColor: bg,
          style: {
            transform: `translate(${PAD - bbox.minX}px, ${PAD - bbox.minY}px)`,
            transformOrigin: '0 0',
          },
          filter: exportNodeFilter,
          ...EXPORT_IMAGE_TOLERANCE,
        });
      } finally {
        restoreImages();
      }

      const base = `${this.file.basename || 'Board'}${only ? ' selection' : ''}`;
      if (format === 'png') {
        // deliverExport decides how the file reaches the user: a browser
        // download on desktop, a vault file on mobile, where the download
        // never worked. See its comment.
        await deliverExport(this.app, dataUrlToBytes(dataUrl), `${base}.png`, 'image/png');
      } else {
        // Re-render as JPEG (not the PNG already captured above) so the raw
        // bytes can be dropped straight into the PDF's DCTDecode image
        // stream with no re-encoding — see pdf-export.ts for why that beats
        // a full PDF library here.
        const canvas = createEl('canvas');
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        const ctx = canvas.getContext('2d')!;
        const img = new Image();
        img.src = dataUrl;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to decode rendered board image'));
        });
        ctx.drawImage(img, 0, 0);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const jpegBytes = dataUrlToBytes(jpegDataUrl);
        const pdfBytes = buildSingleImagePdf(jpegBytes, canvas.width, canvas.height);
        await deliverExport(this.app, pdfBytes, `${base}.pdf`, 'application/pdf');
      }
    } catch (err) {
      console.error('Visual Notes: board export failed', err);
      new Notice('Board export failed — see console for details.');
    } finally {
      notice.hide();
    }
  },

  zoomToFit(this: FreeformRenderer): void {
    const bbox = this.computeBoardBBox();
    const rect = this.outer.getBoundingClientRect();
    if (!bbox) { this.vp = { x: 0, y: 0, zoom: 1 }; this.applyViewport(); this.scheduleSave(); return; }
    const pad = 60;
    const bw = Math.max(1, bbox.maxX - bbox.minX), bh = Math.max(1, bbox.maxY - bbox.minY);
    const availW = Math.max(50, rect.width - pad * 2), availH = Math.max(50, rect.height - pad * 2);
    const zoom = clampZoom(Math.min(availW / bw, availH / bh));
    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    this.vp = { x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom, zoom };
    this.applyViewport();
    this.scheduleSave();
  },

  updateMinimapCards(this: FreeformRenderer): void {
    const body = this.minimapBodyEl;
    if (!body) return;
    body.querySelectorAll('.visual-notes-minimap-dot').forEach(d => d.remove());

    const bodyW = body.clientWidth || 220, bodyH = body.clientHeight || 140;
    let bbox = this.computeBoardBBox();
    if (!bbox) {
      // Nothing on the board yet — fall back to the current viewport's
      // visible canvas rect so the frame still shows something sensible.
      const rect = this.outer.getBoundingClientRect();
      bbox = {
        minX: -this.vp.x / this.vp.zoom, minY: -this.vp.y / this.vp.zoom,
        maxX: (rect.width - this.vp.x) / this.vp.zoom, maxY: (rect.height - this.vp.y) / this.vp.zoom,
      };
    }

    const padFrac = 0.12;
    const bw = Math.max(1, bbox.maxX - bbox.minX), bh = Math.max(1, bbox.maxY - bbox.minY);
    const padX = bw * padFrac, padY = bh * padFrac;
    const pbbox = { minX: bbox.minX - padX, minY: bbox.minY - padY, maxX: bbox.maxX + padX, maxY: bbox.maxY + padY };
    const pbw = pbbox.maxX - pbbox.minX, pbh = pbbox.maxY - pbbox.minY;

    const scale = Math.min(bodyW / pbw, bodyH / pbh);
    const offX = (bodyW - pbw * scale) / 2, offY = (bodyH - pbh * scale) / 2;
    this.minimapTransform = { scale, offX, offY, bbox: pbbox };

    for (const c of this.board.cards) {
      const x = c.x ?? 0, y = c.y ?? 0, w = c.w ?? TILE_DEFAULT_W, h = c.h ?? TILE_DEFAULT_H;
      const dot = body.createDiv('visual-notes-minimap-dot');
      dot.style.left = `${offX + (x - pbbox.minX) * scale}px`;
      dot.style.top = `${offY + (y - pbbox.minY) * scale}px`;
      dot.style.width = `${Math.max(2, w * scale)}px`;
      dot.style.height = `${Math.max(2, h * scale)}px`;
      const maybeColor = (c as unknown as { color?: unknown }).color;
      if (typeof maybeColor === 'string' && maybeColor.startsWith('#')) dot.style.background = maybeColor;
    }
    // Re-append so the viewport frame stays on top of the freshly-added dots.
    if (this.minimapViewportEl) body.appendChild(this.minimapViewportEl);

    this.updateMinimapViewportRect();
  },

  updateMinimapViewportRect(this: FreeformRenderer): void {
    if (!this.minimapViewportEl || !this.minimapTransform) return;
    const { scale, offX, offY, bbox } = this.minimapTransform;
    const rect = this.outer.getBoundingClientRect();
    const vMinX = -this.vp.x / this.vp.zoom, vMinY = -this.vp.y / this.vp.zoom;
    const vMaxX = (rect.width - this.vp.x) / this.vp.zoom, vMaxY = (rect.height - this.vp.y) / this.vp.zoom;
    this.minimapViewportEl.style.left = `${offX + (vMinX - bbox.minX) * scale}px`;
    this.minimapViewportEl.style.top = `${offY + (vMinY - bbox.minY) * scale}px`;
    this.minimapViewportEl.style.width = `${Math.max(4, (vMaxX - vMinX) * scale)}px`;
    this.minimapViewportEl.style.height = `${Math.max(4, (vMaxY - vMinY) * scale)}px`;
  },

  stripHtml(this: FreeformRenderer, html: string): string {
    return html.replace(/<[^>]*>/g, ' ');
  },

  cardSearchText(this: FreeformRenderer, card: SupportedCard): string {
    const parts: string[] = [];
    switch (card.kind) {
      case 'tile':
        parts.push(card.label, card.subtitle ?? '', card.target.path);
        break;
      case 'sticky': parts.push(this.stripHtml(card.text)); break;
      case 'comment':
        parts.push(card.text, card.author ?? '');
        for (const r of card.replies) parts.push(r.text, r.author ?? '');
        break;
      case 'checklist':
        parts.push(card.title ?? '');
        for (const item of card.items) parts.push(this.stripHtml(item.text));
        break;
      case 'table':
        parts.push(card.title ?? '');
        for (const col of card.columns) parts.push(col.label);
        for (const row of card.rows) parts.push(...Object.values(row.cells));
        break;
      case 'note-link': parts.push(card.path); break;
      case 'image': parts.push(card.caption ?? '', card.source.type === 'vault' ? card.source.path : card.source.url); break;
      case 'audio': parts.push(card.source.path); break;
      case 'video': parts.push(card.source.path); break;
      case 'bookmark': parts.push(card.title ?? '', card.description ?? '', card.url); break;
      case 'kanban-column':
        parts.push(card.title ?? '');
        for (const item of card.items) {
          parts.push(this.stripHtml(item.text), ...(item.tags ?? []));
          for (const st of item.subtasks ?? []) parts.push(st.text);
        }
        break;
      case 'kanban-board':
        parts.push(card.title ?? '');
        for (const col of card.columns) {
          parts.push(col.title ?? '');
          for (const item of col.items) {
            parts.push(this.stripHtml(item.text), ...(item.tags ?? []));
            for (const st of item.subtasks ?? []) parts.push(st.text);
          }
        }
        break;
      case 'column':
        parts.push(card.title ?? '');
        for (const child of card.children) parts.push(this.cardSearchText(child));
        break;
      case 'map': parts.push(card.url); break;
      case 'text': parts.push(this.stripHtml(card.text)); break;
      case 'swatch': parts.push(card.color, nearestColorName(card.color)); break;
      case 'file': parts.push(card.path); break;
      case 'callout': parts.push(card.text); break;
      case 'group': parts.push(card.label ?? ''); break;
      case 'calendar': parts.push(card.title ?? ''); break;
      case 'checkers': parts.push('checkers', card.winner ? `${card.winner} wins` : `${card.turn} to move`); break;
      case 'storyboard':
        parts.push(card.title ?? '');
        for (const section of card.sections) for (const shot of section.shots) parts.push(section.title, shot.shot ?? '', shot.title ?? '', shot.notes ?? '');
        break;
    }
    // Labels exist on every card kind.
    if (card.labels) parts.push(...card.labels.map(l => l.text));
    return parts.join(' ').toLowerCase();
  },

  renderSearchWidget(this: FreeformRenderer): void {
    const wrap = this.searchWrapEl = this.container.createDiv('visual-notes-search');

    const toggle = wrap.createDiv('visual-notes-search-toggle');
    setIcon(toggle, 'search');
    toggle.setAttribute('aria-label', 'Search this board');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wrap.hasClass('is-open')) this.closeSearch();
      else this.openSearch();
    });

    const bar = wrap.createDiv('visual-notes-search-bar');
    const input = this.searchInputEl = bar.createEl('input', { cls: 'visual-notes-search-input' });
    input.type = 'text';
    input.placeholder = 'Search cards…';
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('input', () => this.runSearch(input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.gotoMatch(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
    });

    this.searchCountEl = bar.createDiv({ cls: 'visual-notes-search-count', text: '' });

    const prevBtn = bar.createDiv('visual-notes-search-nav-btn');
    setIcon(prevBtn, 'chevron-up');
    prevBtn.setAttribute('aria-label', 'Previous match');
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.gotoMatch(-1); });

    const nextBtn = bar.createDiv('visual-notes-search-nav-btn');
    setIcon(nextBtn, 'chevron-down');
    nextBtn.setAttribute('aria-label', 'Next match');
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.gotoMatch(1); });

    const closeBtn = bar.createDiv('visual-notes-search-nav-btn');
    setIcon(closeBtn, 'x');
    closeBtn.setAttribute('aria-label', 'Close search');
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.closeSearch(); });
  },

  openSearch(this: FreeformRenderer): void {
    if (!this.searchWrapEl || !this.searchInputEl) return;
    this.searchWrapEl.addClass('is-open');
    this.searchInputEl.focus();
    this.searchInputEl.select();
    if (this.searchInputEl.value) this.runSearch(this.searchInputEl.value);
  },

  closeSearch(this: FreeformRenderer): void {
    if (!this.searchWrapEl) return;
    this.searchWrapEl.removeClass('is-open');
    this.searchMatches = [];
    this.searchIndex = 0;
    this.searchCountEl?.setText('');
    for (const [, el] of this.cardEls) el.removeClass('is-search-match', 'is-search-dim');
    this.outer.focus();
  },

  runSearch(this: FreeformRenderer, query: string): void {
    const q = query.trim().toLowerCase();
    if (!q) {
      this.searchMatches = [];
      this.searchIndex = 0;
      this.searchCountEl?.setText('');
      for (const [, el] of this.cardEls) el.removeClass('is-search-match', 'is-search-dim');
      return;
    }
    this.searchMatches = this.board.cards
      .filter(c => this.cardSearchText(c).includes(q))
      .map(c => c.id);
    this.searchIndex = 0;
    for (const [id, el] of this.cardEls) {
      const hit = this.searchMatches.includes(id);
      el.toggleClass('is-search-match', hit);
      el.toggleClass('is-search-dim', !hit);
    }
    this.updateSearchCount();
    if (this.searchMatches.length > 0) this.centerOnCard(this.searchMatches[0]);
  },

  gotoMatch(this: FreeformRenderer, dir: number): void {
    if (this.searchMatches.length === 0) return;
    this.searchIndex = (this.searchIndex + dir + this.searchMatches.length) % this.searchMatches.length;
    this.updateSearchCount();
    this.centerOnCard(this.searchMatches[this.searchIndex]);
  },

  updateSearchCount(this: FreeformRenderer): void {
    this.searchCountEl?.setText(this.searchMatches.length === 0
      ? 'No matches'
      : `${this.searchIndex + 1} of ${this.searchMatches.length}`);
  },

  cardFilterKeys(this: FreeformRenderer, card: SupportedCard, into = new Set<string>()): Set<string> {
    for (const l of card.labels ?? []) into.add(`label:${l.text}`);
    if (card.kind === 'kanban-column') {
      for (const item of card.items) for (const t of item.tags ?? []) into.add(`tag:${t}`);
    } else if (card.kind === 'kanban-board') {
      for (const col of card.columns) for (const item of col.items) for (const t of item.tags ?? []) into.add(`tag:${t}`);
    } else if (card.kind === 'column') {
      for (const child of card.children) this.cardFilterKeys(child, into);
    }
    return into;
  },

  renderFilterWidget(this: FreeformRenderer): void {
    const wrap = this.filterWrapEl = this.container.createDiv('visual-notes-filter');

    // Panel content is (re)built each time the popover opens, so it always
    // reflects the board's current tags/labels.
    this.filterPanelEl = wrap.createDiv('visual-notes-filter-panel');

    const toggle = wrap.createDiv('visual-notes-filter-toggle');
    setIcon(toggle, 'filter');
    this.filterCountEl = toggle.createDiv({ cls: 'visual-notes-filter-count', text: '' });
    toggle.setAttribute('aria-label', 'Filter by tag or label');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = wrap.hasClass('is-open');
      wrap.toggleClass('is-open', !open);
      if (!open) this.rebuildFilterPanel();
    });
  },

  rebuildFilterPanel(this: FreeformRenderer): void {
    const panel = this.filterPanelEl;
    if (!panel) return;
    panel.empty();

    const tags = new Set<string>();
    const labels = new Set<string>();
    for (const card of this.board.cards) {
      for (const key of this.cardFilterKeys(card)) {
        if (key.startsWith('tag:')) tags.add(key.slice(4));
        else labels.add(key.slice(6));
      }
    }

    const header = panel.createDiv('visual-notes-filter-header');
    header.createDiv({ cls: 'visual-notes-minimap-title', text: 'Filter' });
    const clearBtn = header.createDiv({ cls: 'visual-notes-filter-clear', text: 'Clear' });
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.activeFilters.clear();
      this.rebuildFilterPanel();
      this.applyFilters();
    });

    const addChipGroup = (title: string, values: Set<string>, prefix: 'tag' | 'label') => {
      if (values.size === 0) return;
      panel.createDiv({ cls: 'visual-notes-filter-group-title', text: title });
      const row = panel.createDiv('visual-notes-filter-chip-row');
      for (const v of [...values].sort()) {
        const key = `${prefix}:${v}`;
        const chip = row.createDiv({ cls: 'visual-notes-filter-chip', text: prefix === 'tag' ? `#${v}` : v });
        chip.toggleClass('is-active', this.activeFilters.has(key));
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.activeFilters.has(key)) this.activeFilters.delete(key);
          else this.activeFilters.add(key);
          chip.toggleClass('is-active', this.activeFilters.has(key));
          this.applyFilters();
        });
      }
    };
    addChipGroup('Tags', tags, 'tag');
    addChipGroup('Labels', labels, 'label');

    if (tags.size === 0 && labels.size === 0) {
      panel.createDiv({ cls: 'visual-notes-filter-empty', text: 'No tags or labels on this board yet.' });
    }
  },

  applyFilters(this: FreeformRenderer): void {
    const active = this.activeFilters;
    this.filterCountEl?.setText(active.size ? String(active.size) : '');
    this.filterWrapEl?.toggleClass('has-active', active.size > 0);
    for (const [id, el] of this.cardEls) {
      if (!active.size) { el.removeClass('is-filter-dim'); continue; }
      const card = this.board.cards.find(c => c.id === id);
      const keys = card ? this.cardFilterKeys(card) : new Set<string>();
      let match = false;
      for (const k of active) { if (keys.has(k)) { match = true; break; } }
      el.toggleClass('is-filter-dim', !match);
    }
  },

  openQuickAdd(this: FreeformRenderer): void {
    const entries: QuickAddEntry[] = [
      { label: 'Text',            tool: 'text' },
      { label: 'Note',            tool: 'blank-card' },
      { label: 'Tile',            tool: 'tile-board' },
      { label: 'Sticky note',     tool: 'sticky' },
      { label: 'To-do list',      tool: 'checklist' },
      { label: 'Kanban board',    tool: 'kanban' },
      { label: 'Column',          tool: 'column' },
      { label: 'Storyboard',      tool: 'storyboard' },
      { label: 'Table',           tool: 'table' },
      { label: 'Callout',         tool: 'callout' },
      { label: 'Group frame',     tool: 'group' },
      { label: 'Image',           tool: 'image' },
      { label: 'Audio',           tool: 'audio' },
      { label: 'Video',           tool: 'video' },
      { label: 'Link / bookmark', tool: 'bookmark' },
      { label: 'Note link',       tool: 'notelink' },
      { label: 'Comment',         tool: 'comment' },
      { label: 'Map',             tool: 'map' },
      { label: 'Swatch',          tool: 'swatch' },
      { label: 'File',            tool: 'file' },
    ];
    new QuickAddModal(this.app, entries, (entry) => {
      const rect = this.outer.getBoundingClientRect();
      const inCanvas = this.lastPointerClient
        && this.lastPointerClient.x >= rect.left && this.lastPointerClient.x <= rect.right
        && this.lastPointerClient.y >= rect.top && this.lastPointerClient.y <= rect.bottom;
      const client = inCanvas && this.lastPointerClient
        ? this.lastPointerClient
        : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const cp = screenToCanvas(client.x - rect.left, client.y - rect.top, this.vp);
      this.clearPendingTool();
      this.pendingTool = entry.tool;
      this.pendingToolBtn = null;
      this.placePendingTool(cp.x, cp.y);
    }).open();
  },

  renderAlignBar(this: FreeformRenderer): void {
    this.alignBarEl = this.container.createDiv('visual-notes-align-bar');

    type AlignMode = Parameters<FreeformRenderer['alignCards']>[0];
    // H group: horizontal alignment — adjusts X positions (left/right edges)
    const ALIGN_BTNS: { icon: string; title: string; mode: AlignMode }[] = [
      { icon: 'align-start-vertical',  title: 'Align left edges',        mode: 'left'        },
      { icon: 'align-center-vertical', title: 'Center horizontally',     mode: 'center-h'    },
      { icon: 'align-end-vertical',    title: 'Align right edges',       mode: 'right'       },
      { icon: 'arrows-left-right',     title: 'Distribute horizontally', mode: 'distribute-h'},
    ];
    // V group: vertical alignment — adjusts Y positions (top/bottom edges)
    const VALIGN_BTNS: { icon: string; title: string; mode: AlignMode }[] = [
      { icon: 'align-start-horizontal',  title: 'Align top edges',       mode: 'top'         },
      { icon: 'align-center-horizontal', title: 'Center vertically',     mode: 'middle-v'    },
      { icon: 'align-end-horizontal',    title: 'Align bottom edges',    mode: 'bottom'      },
      { icon: 'arrows-up-down',          title: 'Distribute vertically', mode: 'distribute-v'},
    ];

    const makeBtn = (parent: HTMLElement, icon: string, title: string, mode: AlignMode) => {
      const btn = parent.createDiv('visual-notes-align-bar-btn');
      btn.setAttribute('title', title);
      setIcon(btn, icon);
      btn.addEventListener('click', () => this.alignCards(mode));
    };

    const hGroup = this.alignBarEl.createDiv('visual-notes-align-bar-group');
    const hLabel = hGroup.createSpan('visual-notes-align-bar-label');
    hLabel.setText('H');
    for (const { icon, title, mode } of ALIGN_BTNS) makeBtn(hGroup, icon, title, mode);

    this.alignBarEl.createDiv('visual-notes-align-bar-sep');

    const vGroup = this.alignBarEl.createDiv('visual-notes-align-bar-group');
    const vLabel = vGroup.createSpan('visual-notes-align-bar-label');
    vLabel.setText('V');
    for (const { icon, title, mode } of VALIGN_BTNS) makeBtn(vGroup, icon, title, mode);
  },

  handleCtxEvent(this: FreeformRenderer, e: CtxEvent): void {
    const cardId = this.selection.getIds()[0];
    const card = cardId ? this.board.cards.find(c => c.id === cardId) : null;
    const el = cardId ? this.cardEls.get(cardId) ?? null : null;
    const conn = this.selectedConnectionId
      ? this.board.connections.find(c => c.id === this.selectedConnectionId) ?? null
      : null;

    switch (e.type) {
      case 'delete': {
        if (conn) { this.deleteSelectedConnection(); return; }
        if (!card || !el) return;
        this.pushUndo();
        el.remove();
        this.cardEls.delete(card.id);
        this.disposeCardResources(card.id);
        this.board.cards = this.board.cards.filter(c => c.id !== card.id);
        this.selection.clear();
        this.contextBar.hide();
        this.scheduleSave();
        break;
      }
      case 'tile-edit': {
        if (card?.kind !== 'tile' || !el) return;
        new TileModal(this.app, card, (updated) => {
          const idx = this.board.cards.findIndex(c => c.id === updated.id);
          if (idx !== -1) this.board.cards[idx] = updated;
          this.renderCardContent(el, updated); this.scheduleSave();
        }, this.file).open();
        break;
      }
      case 'edit-card': {
        // Single-tap-friendly entry into the same inline editors that
        // dblclick starts — branch per kind, resolving any kind-specific
        // child element from `el` (same pattern as 'kanban-title' below).
        if (!card || !el) return;
        switch (card.kind) {
          case 'sticky':  this.editStickyInline(el, card); break;
          case 'text':    this.editTextInline(el, card); break;
          case 'callout': this.editCalloutInline(el, card); break;
          case 'group':   this.editGroupLabel(el, card); break;
          case 'calendar': {
            const titleEl = el.querySelector<HTMLElement>('.visual-notes-dataview-title');
            if (titleEl) this.editSimpleTitle(titleEl, card.title, v => { card.title = v; }, el, card);
            break;
          }
          case 'column': {
            const titleEl = el.querySelector<HTMLElement>('.visual-notes-column-title');
            if (titleEl) this.editColumnTitle(card, titleEl);
            break;
          }
        }
        break;
      }
      case 'sticky-color': {
        if (card?.kind !== 'sticky' || !el) return;
        this.pushUndo();
        card.color = e.hex;
        const fill = el.querySelector<HTMLElement>('.visual-notes-sticky-shape-fill');
        if (fill) fill.style.backgroundColor = e.hex; else el.style.backgroundColor = e.hex;
        // Keep text readable against the new background — same
        // auto-contrast renderStickyContent applies on initial render,
        // recomputed here since picking a color doesn't re-render the card.
        if (!card.textColor) {
          const textEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text');
          if (textEl) textEl.style.color = isHexColor(e.hex) ? contrastColor(e.hex) : '';
        }
        this.scheduleSave();
        break;
      }
      case 'sticky-top-color': {
        if (card?.kind !== 'sticky' || !el) return;
        this.pushUndo();
        card.topColor = e.hex ?? undefined;
        let strip = el.querySelector<HTMLElement>('.visual-notes-card-top-strip');
        if (card.topColor) {
          if (!strip) {
            strip = el.createDiv('visual-notes-card-top-strip');
            el.insertBefore(strip, el.querySelector('.visual-notes-sticky-inner'));
          }
          strip.style.backgroundColor = card.topColor;
        } else {
          strip?.remove();
        }
        this.scheduleSave();
        break;
      }
      case 'sticky-bullet': {
        if (card?.kind !== 'sticky' || !el) return;
        // Unlike the selection-popover buttons this one is reachable with a
        // caret and no selection at all, and even with the card merely
        // selected — in which case drop into edit mode first (caret lands at
        // the end) rather than sitting there doing nothing, the exact
        // failure that got the old format buttons removed.
        let editor = el.querySelector<HTMLElement>('.visual-notes-sticky-editor');
        if (!editor) {
          this.editStickyInline(el, card);
          editor = el.querySelector<HTMLElement>('.visual-notes-sticky-editor');
        }
        if (!editor) return;
        editor.focus();
        this.pushUndo();
        if (toggleBulletList(editor)) {
          // The editor only writes back to card.text on blur, so sync it
          // here — otherwise this save would persist the pre-bullet text and
          // the change would exist only in the DOM until the user clicked
          // away. Committing on blur later just writes the same thing again.
          card.text = editor.innerHTML;
          this.scheduleSave();
        }
        break;
      }
      case 'sticky-text-scale': {
        if (card?.kind !== 'sticky' || !el) return;
        this.pushUndo();
        card.textScale = e.scale;
        // Set the CSS var in place rather than re-rendering: a re-render
        // would tear down the card element the context bar is positioned
        // against, and the inner text/editor inherit the var anyway.
        applyStickyTextScale(el, card.textScale);
        this.scheduleSave();
        break;
      }
      case 'sticky-transparent': {
        if (card?.kind !== 'sticky' || !el) return;
        this.pushUndo();
        card.transparent = e.transparent;
        el.toggleClass('is-transparent', e.transparent);
        const fillEl = el.querySelector<HTMLElement>('.visual-notes-sticky-shape-fill');
        if (fillEl) fillEl.style.backgroundColor = e.transparent ? '' : card.color;
        // The auto-contrast text colour is derived from the card's fill, so it
        // has to be recomputed here rather than left as-is: turning the fill
        // off strands dark ink on whatever the canvas happens to be, and
        // turning it back on has to restore the pairing. An explicit
        // card.textColor always wins and is left alone.
        const stickyTextEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text');
        if (stickyTextEl) {
          stickyTextEl.style.color = card.textColor
            ?? (!e.transparent && isHexColor(card.color) ? contrastColor(card.color) : '');
        }
        this.scheduleSave();
        break;
      }
      case 'sticky-font': {
        if (card?.kind !== 'sticky' || !el) return;
        this.pushUndo();
        if (e.font) {
          card.fontFamily = e.font;
          el.style.setProperty('--vn-card-font', STICKY_FONT_FAMILIES[e.font]);
        } else {
          delete card.fontFamily;
          el.style.removeProperty('--vn-card-font');
        }
        this.scheduleSave();
        break;
      }
      case 'text-font-size': {
        if (card?.kind !== 'text' || !el) return;
        this.pushUndo();
        // Same px field a corner drag writes, so the two can never disagree
        // about what size the card is.
        card.fontSize = e.size;
        this.renderCardContent(el, card);
        this.updateConnectionsForCard(card.id);
        this.scheduleSave();
        break;
      }
      case 'text-font': {
        if (card?.kind !== 'text' || !el) return;
        this.pushUndo();
        if (e.font) card.fontFamily = e.font; else delete card.fontFamily;
        this.renderCardContent(el, card);
        this.updateConnectionsForCard(card.id);
        this.scheduleSave();
        break;
      }
      case 'text-color': {
        if (card?.kind !== 'text' || !el) return;
        this.pushUndo();
        card.color = e.hex;
        const textBody = el.querySelector<HTMLElement>('.visual-notes-text-body');
        if (textBody) textBody.style.color = e.hex;
        this.scheduleSave();
        break;
      }
      case 'checklist-accent': {
        if (card?.kind !== 'checklist' || !el) return;
        this.pushUndo();
        card.accentColor = e.hex;
        const accentBarA = el.querySelector<HTMLElement>('.visual-notes-checklist-accent');
        if (accentBarA) accentBarA.style.backgroundColor = e.hex;
        this.scheduleSave();
        break;
      }
      case 'checklist-bg': {
        if (card?.kind !== 'checklist' || !el) return;
        this.pushUndo();
        card.color = e.hex;
        el.style.backgroundColor = e.hex;
        this.scheduleSave();
        break;
      }
      case 'checklist-top-color': {
        if (card?.kind !== 'checklist' || !el) return;
        this.pushUndo();
        card.accentColor = e.hex ?? undefined;
        let bar = el.querySelector<HTMLElement>('.visual-notes-checklist-accent');
        if (card.accentColor) {
          if (!bar) { bar = el.createDiv('visual-notes-checklist-accent'); el.insertBefore(bar, el.firstChild); }
          bar.style.backgroundColor = card.accentColor;
        } else {
          bar?.remove();
        }
        this.scheduleSave();
        break;
      }
      case 'checklist-title': {
        if (card?.kind !== 'checklist' || !el) return;
        this.pushUndo();
        if (card.titleHidden) {
          card.titleHidden = false;
          this.rebuildChecklistCard(card); this.refreshSelectionVisuals();
          window.setTimeout(() => (this.cardEls.get(card.id)?.querySelector<HTMLElement>('.visual-notes-checklist-title'))?.focus(), 0);
        } else {
          card.titleHidden = true;
          this.rebuildChecklistCard(card); this.refreshSelectionVisuals();
        }
        this.scheduleSave();
        break;
      }
      case 'comment-color': {
        if (card?.kind !== 'comment' || !el) return;
        this.pushUndo();
        card.color = e.hex;
        el.style.setProperty('--visual-notes-comment-accent', e.hex);
        this.scheduleSave();
        break;
      }
      case 'group-color': {
        if (card?.kind !== 'group' || !el) return;
        this.pushUndo();
        card.color = e.hex;
        // Mirrors renderGroupContent's own derivation of border/label
        // colors from card.color, rather than a full re-render — cheaper,
        // and (unlike table-title/comment-resolve, which rebuild content
        // that's actually changing shape) nothing else about a group frame
        // changes when only its border color does.
        el.style.borderColor = e.hex;
        // The border color only doubles as the fill when no bgColor has
        // been chosen — once one has, the fill is independent and shouldn't
        // shift just because the border did.
        if (!card.bgColor) {
          el.style.backgroundColor = (card.transparent ?? true) ? `${e.hex}14` : e.hex;
        }
        const groupLabel = el.querySelector<HTMLElement>('.visual-notes-group-label');
        if (groupLabel) {
          groupLabel.style.backgroundColor = e.hex;
          groupLabel.style.color = contrastColor(e.hex);
        }
        this.scheduleSave();
        break;
      }
      case 'group-bg': {
        if (card?.kind !== 'group' || !el) return;
        this.pushUndo();
        card.bgColor = e.hex;
        // Transparency is an alpha applied to whichever fill is active, not
        // a separate look to exit — picking a color doesn't change it, it
        // just changes what that alpha is now being applied to.
        el.style.backgroundColor = (card.transparent ?? true) ? `${e.hex}14` : e.hex;
        this.scheduleSave();
        break;
      }
      case 'group-transparent': {
        if (card?.kind !== 'group' || !el) return;
        this.pushUndo();
        card.transparent = e.transparent;
        const fill = card.bgColor ?? (card.color ?? '#6b7280');
        el.style.backgroundColor = e.transparent ? `${fill}14` : fill;
        this.scheduleSave();
        break;
      }
      case 'comment-resolve': {
        if (card?.kind !== 'comment' || !el) return;
        this.pushUndo();
        card.resolved = !card.resolved;
        this.renderCardContent(el, card);
        this.refreshSelectionVisuals();
        this.scheduleSave();
        break;
      }
      case 'table-bg': {
        if (card?.kind !== 'table' || !el) return;
        this.pushUndo();
        card.color = e.hex;
        el.style.backgroundColor = e.hex;
        this.scheduleSave();
        break;
      }
      case 'table-title': {
        if (card?.kind !== 'table' || !el) return;
        this.pushUndo();
        card.titleHidden = !card.titleHidden;
        this.renderCardContent(el, card); this.refreshSelectionVisuals();
        if (!card.titleHidden) {
          window.setTimeout(() => (this.cardEls.get(card.id)?.querySelector<HTMLElement>('.visual-notes-table-title'))?.focus(), 0);
        }
        this.scheduleSave();
        break;
      }
      case 'image-caption': {
        if (card?.kind !== 'image' || !el) return;
        this.pushUndo();
        card.captionHidden = !card.captionHidden;
        const wrap = el.querySelector<HTMLElement>('.visual-notes-image-caption-wrap');
        if (wrap) wrap.toggleClass('is-hidden', !!card.captionHidden);
        if (!card.captionHidden) {
          // Caption was just shown — click the view to enter edit mode
          window.setTimeout(() => {
            el.querySelector<HTMLElement>('.visual-notes-image-caption-view')?.click();
          }, 0);
        }
        this.scheduleSave();
        break;
      }
      case 'notelink-display': {
        if (card?.kind !== 'note-link' || !el) return;
        this.pushUndo();
        card.displayMode = card.displayMode === 'preview' ? 'title-only' : 'preview';
        this.renderCardContent(el, card); this.scheduleSave();
        break;
      }
      case 'notelink-open': {
        if (card?.kind !== 'note-link') return;
        const file = this.app.vault.getAbstractFileByPath(card.path);
        if (file instanceof TFile) void this.app.workspace.openLinkText(file.path, '', true);
        break;
      }
      case 'bookmark-refresh': {
        if (card?.kind !== 'bookmark' || !el) return;
        card.fetchFailed = false; card.fetchedAt = undefined;
        this.renderCardContent(el, card);
        void this.fetchAndUpdateBookmark(card, el);
        break;
      }
      case 'bookmark-copy-url': {
        if (card?.kind !== 'bookmark') return;
        void navigator.clipboard.writeText(card.url); new Notice('URL copied.');
        break;
      }
      case 'kanban-color': {
        if (card?.kind !== 'kanban-column') return;
        this.pushUndo();
        card.color = e.hex;
        this.rebuildKanbanCard(card);
        this.scheduleSave();
        break;
      }
      case 'kanban-bg': {
        if (card?.kind !== 'kanban-column' || !el) return;
        this.pushUndo();
        card.bgColor = e.hex ?? undefined;
        el.style.backgroundColor = card.bgColor ?? '';
        this.scheduleSave();
        break;
      }
      case 'kanban-top-color': {
        if (card?.kind !== 'kanban-column' || !el) return;
        this.pushUndo();
        card.topColor = e.hex ?? undefined;
        let strip = el.querySelector<HTMLElement>('.visual-notes-card-top-strip');
        if (card.topColor) {
          if (!strip) {
            strip = el.createDiv('visual-notes-card-top-strip');
            el.insertBefore(strip, el.firstChild);
          }
          strip.style.backgroundColor = card.topColor;
        } else {
          strip?.remove();
        }
        this.scheduleSave();
        break;
      }
      case 'kanban-title': {
        if (!el) return;
        if (card?.kind === 'kanban-column') {
          this.pushUndo();
          card.titleHidden = !card.titleHidden;
          this.rebuildKanbanCard(card);
          this.refreshSelectionVisuals();
          this.scheduleSave();
          if (!card.titleHidden) {
            window.setTimeout(() => {
              const newEl = this.cardEls.get(card.id);
              const titleEl = newEl?.querySelector<HTMLElement>('.visual-notes-kanban-title');
              if (newEl && titleEl) this.editKanbanTitle(card, newEl, titleEl);
            }, 0);
          }
        } else if (card?.kind === 'kanban-board') {
          this.pushUndo();
          card.titleHidden = !card.titleHidden;
          this.rebuildKanbanCard(card);
          this.refreshSelectionVisuals();
          this.scheduleSave();
          if (!card.titleHidden) {
            window.setTimeout(() => {
              const newEl = this.cardEls.get(card.id);
              const titleEl = newEl?.querySelector<HTMLElement>('.visual-notes-kanban-board-title');
              if (titleEl) this.editKanbanBoardTitle(card, titleEl);
            }, 0);
          }
        }
        break;
      }
      case 'kanban-add-col': {
        if (card?.kind !== 'kanban-board' || !el) return;
        this.addColumnToBoard(card, el);
        break;
      }
      case 'checkers-reset': {
        if (card?.kind !== 'checkers' || !el) return;
        this.resetCheckers(el, card);
        break;
      }
    }
  },
};
