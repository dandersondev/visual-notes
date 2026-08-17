import {
  setIcon,
} from 'obsidian';
import {
  CalendarCard, CalendarNote, CalendarDayStyle,
} from './file-types';
import {
  DatedItem, collectBoardDatedItems, renderCalendarGrid,
  addDaysISO, todayISO, startOfWeekISO, monthTitle, shortDate,
} from './dated-items';
import { IconPickerModal } from './icon-picker';
import {
  CALENDAR_DEFAULT_W, CALENDAR_DEFAULT_H,
  CALENDAR_IMPORTANCE_OPTIONS,
  SupportedCard,
  DueDateModal,
  KanbanItemUrlModal, CalendarNoteTextModal, KanbanItemImageSuggestModal,
  KanbanItemColorModal,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';

declare module './freeform-view' {
  interface FreeformRenderer {
    refreshAfterDateChange(sourceCardId: string): void;
    refreshPassiveDataViews(): void;
    dataViewNavBtn(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement;
    dataViewTextBtn(parent: HTMLElement, text: string, onClick: () => void): HTMLElement;
    editSimpleTitle(
        span: HTMLElement, current: string | undefined,
        apply: (v: string | undefined) => void, cardEl: HTMLElement, card: SupportedCard,
      ): void;
    addCalendarAt(x: number, y: number): void;
    renderCalendarContent(el: HTMLElement, card: CalendarCard): void;
    quickAddCalendarNote(el: HTMLElement, card: CalendarCard, date: string): void;
    ensureDayStyle(card: CalendarCard, date: string): CalendarDayStyle;
    pruneDayStyleIfEmpty(card: CalendarCard, date: string): void;
    showCalendarDayMenu(e: MouseEvent, el: HTMLElement, card: CalendarCard, date: string): void;
    showCalendarItemMenu(e: MouseEvent, el: HTMLElement, card: CalendarCard, item: DatedItem): void;
    editCalendarAnchor(label: HTMLElement, cardEl: HTMLElement, card: CalendarCard): void;
  }
}

// YYYY-MM, what <input type="month"> reads and writes.
const MONTH_INPUT_RE = /^\d{4}-\d{2}$/;

export const cardsCalendarMethods = {
  refreshAfterDateChange(this: FreeformRenderer, sourceCardId: string): void {
    for (const c of this.board.cards) {
      const showsDates = c.kind === 'calendar'
        || (c.kind === 'table' && (c.view ?? 'table') !== 'table');
      if (!showsDates && c.id !== sourceCardId) continue;
      const cel = this.cardEls.get(c.id);
      if (cel) this.rerenderCard(cel, c);
    }
  },

  refreshPassiveDataViews(this: FreeformRenderer): void {
    for (const c of this.board.cards) {
      if (c.kind !== 'calendar') continue;
      const cel = this.cardEls.get(c.id);
      if (cel) this.rerenderCard(cel, c);
    }
  },

  dataViewNavBtn(this: FreeformRenderer, parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = parent.createDiv('visual-notes-dataview-btn');
    setIcon(btn, icon);
    btn.setAttribute('aria-label', label);
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  },

  dataViewTextBtn(this: FreeformRenderer, parent: HTMLElement, text: string, onClick: () => void): HTMLElement {
    const btn = parent.createDiv({ cls: 'visual-notes-dataview-btn visual-notes-dataview-btn-text', text });
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  },

  editSimpleTitle(this: FreeformRenderer, 
    span: HTMLElement, current: string | undefined,
    apply: (v: string | undefined) => void, cardEl: HTMLElement, card: SupportedCard,
  ): void {
    const input = createEl('input');
    input.type = 'text';
    input.value = current ?? '';
    input.className = 'visual-notes-dataview-title-input';
    input.addEventListener('pointerdown', e => e.stopPropagation());
    span.replaceWith(input);
    const commit = () => {
      const v = input.value.trim() || undefined;
      if (v !== current) { this.pushUndo(); apply(v); this.scheduleSave(); }
      this.rerenderCard(cardEl, card);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.removeEventListener('blur', commit); this.rerenderCard(cardEl, card); }
    });
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
  },

  addCalendarAt(this: FreeformRenderer, x: number, y: number): void {
    const card: CalendarCard = {
      id: crypto.randomUUID(), kind: 'calendar',
      x, y, w: CALENDAR_DEFAULT_W, h: CALENDAR_DEFAULT_H, z: this.nextZ(),
    };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  renderCalendarContent(this: FreeformRenderer, el: HTMLElement, card: CalendarCard): void {
    el.addClass('visual-notes-freeform-calendar-card');
    const mode = card.mode ?? 'month';
    const anchor = card.anchor ?? todayISO();
    const items = collectBoardDatedItems(this.board);
    const rerender = () => this.rerenderCard(el, card);
    const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;

    const header = el.createDiv('visual-notes-calendar-header');
    if (!card.titleHidden) {
      const titleEl = header.createDiv({ cls: 'visual-notes-dataview-title', text: card.title || 'Calendar' });
      titleEl.toggleClass('is-untitled', !card.title);
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.editSimpleTitle(titleEl, card.title, v => { card.title = v; }, el, card);
      });
    }
    const weekStart = startOfWeekISO(anchor);
    const locked = !!card.anchorLocked;
    const monthLabel = header.createDiv({
      cls: 'visual-notes-calendar-month-label',
      text: mode === 'month' ? monthTitle(anchor) : `${shortDate(weekStart)} – ${shortDate(addDaysISO(weekStart, 6))}`,
    });
    if (locked) {
      monthLabel.addClass('is-locked');
    } else {
      // Click-to-jump: swaps the label for a native <input type="month">,
      // which covers both requested input styles at once — Chromium lets
      // you type MM/YYYY directly into it, and its own calendar-icon affordance
      // opens a year/month grid, so no custom dropdown needs building here.
      monthLabel.addClass('is-clickable');
      monthLabel.setAttribute('aria-label', 'Click to jump to a month and year');
      monthLabel.addEventListener('pointerdown', e => e.stopPropagation());
      monthLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editCalendarAnchor(monthLabel, el, card);
      });
    }
    const nav = header.createDiv('visual-notes-dataview-nav');
    const prevBtn = this.dataViewNavBtn(nav, 'chevron-left', 'Previous', () => {
      if (card.anchorLocked) return;
      card.anchor = mode === 'month' ? firstOfMonth(addDaysISO(firstOfMonth(anchor), -1)) : addDaysISO(anchor, -7);
      this.scheduleSave(); rerender();
    });
    prevBtn.toggleClass('is-disabled', locked);
    const todayBtn = this.dataViewTextBtn(nav, 'Today', () => {
      if (card.anchorLocked) return;
      card.anchor = undefined; this.scheduleSave(); rerender();
    });
    todayBtn.toggleClass('is-disabled', locked);
    const nextBtn = this.dataViewNavBtn(nav, 'chevron-right', 'Next', () => {
      if (card.anchorLocked) return;
      card.anchor = mode === 'month' ? firstOfMonth(addDaysISO(firstOfMonth(anchor), 32)) : addDaysISO(anchor, 7);
      this.scheduleSave(); rerender();
    });
    nextBtn.toggleClass('is-disabled', locked);
    // Freezes Previous/Today/Next and the month/year jump above — suggested
    // for anyone who finds a stray click expensive to undo, e.g. after
    // scrolling deep into a historical timeline. Stays clickable itself
    // either way, so locking is never a dead end.
    const lockBtn = this.dataViewNavBtn(
      nav, locked ? 'lock' : 'lock-open',
      locked ? 'Unlock month/year' : 'Lock month/year (prevents accidental changes)',
      () => { card.anchorLocked = !card.anchorLocked; this.scheduleSave(); rerender(); },
    );
    lockBtn.toggleClass('is-active', locked);
    const modeWrap = header.createDiv('visual-notes-calendar-mode');
    for (const m of ['month', 'week'] as const) {
      const b = this.dataViewTextBtn(modeWrap, m === 'month' ? 'Month' : 'Week', () => {
        if (card.mode !== m) { card.mode = m; this.scheduleSave(); rerender(); }
      });
      b.toggleClass('is-active', mode === m);
    }

    const body = el.createDiv('visual-notes-calendar-body');
    // Set by the add and delete paths immediately before they re-render, so
    // the day they touched opens and the change is actually visible instead
    // of landing past the "+N more" cap. Read once and cleared, so a later
    // unrelated re-render doesn't reopen a day the user has moved on from.
    const expandDay = el.dataset.vnExpandDay;
    delete el.dataset.vnExpandDay;
    renderCalendarGrid(body, anchor, mode, items, {
      app: this.app,
      expandDay,
      onDrop: (item, date) => {
        this.pushUndo();
        item.move(date);
        this.scheduleSave();
        this.refreshAfterDateChange(item.sourceCardId);
      },
      onDayAdd: (date) => this.quickAddCalendarNote(el, card, date),
      onDayContextMenu: (date, evt) => this.showCalendarDayMenu(evt, el, card, date),
      onItemContextMenu: (item, evt) => this.showCalendarItemMenu(evt, el, card, item),
      dayStyle: (date) => card.dayStyles?.[date],
      onDayBadgeClick: (date, style) => {
        if (style.nestedBoardPath) {
          this.openNestedBoard(style.nestedBoardPath, (p) => { style.nestedBoardPath = p; this.scheduleSave(); }, style.nestedBoardRoomId, (id) => { style.nestedBoardRoomId = id; });
        }
      },
    });

    this.appendResizeHandles(el);
  },

  // In-place month/year jump — swaps the clicked label for a real <input
  // type="month">, the same pattern editSimpleTitle uses for card titles.
  // Not undo-tracked: like Previous/Today/Next, this only moves which
  // month is *displayed*, so it belongs with those rather than with edits
  // to the card's actual data.
  editCalendarAnchor(this: FreeformRenderer, label: HTMLElement, cardEl: HTMLElement, card: CalendarCard): void {
    const original = (card.anchor ?? todayISO()).slice(0, 7);
    const input = createEl('input');
    input.type = 'month';
    input.value = original;
    input.className = 'visual-notes-calendar-month-input';
    input.addEventListener('pointerdown', e => e.stopPropagation());
    label.replaceWith(input);

    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const v = input.value;
      if (v && MONTH_INPUT_RE.test(v) && v !== original) {
        card.anchor = `${v}-01`;
        this.scheduleSave();
      }
      this.rerenderCard(cardEl, card);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; this.rerenderCard(cardEl, card); }
    });
    input.addEventListener('blur', commit);
    window.requestAnimationFrame(() => input.focus());
  },

  quickAddCalendarNote(this: FreeformRenderer, el: HTMLElement, card: CalendarCard, date: string): void {
    new CalendarNoteTextModal(this.app, '', (text) => {
      this.pushUndo();
      const note: CalendarNote = { id: crypto.randomUUID(), date, text };
      card.notes = [...(card.notes ?? []), note];
      this.scheduleSave();
      // A new note on an already-full day renders past the cap, so without
      // this the day looks unchanged and the add reads as having failed.
      el.dataset.vnExpandDay = date;
      this.rerenderCard(el, card);
    }).open();
  },

  ensureDayStyle(this: FreeformRenderer, card: CalendarCard, date: string): CalendarDayStyle {
    if (!card.dayStyles) card.dayStyles = {};
    if (!card.dayStyles[date]) card.dayStyles[date] = {};
    return card.dayStyles[date];
  },

  pruneDayStyleIfEmpty(this: FreeformRenderer, card: CalendarCard, date: string): void {
    const s = card.dayStyles?.[date];
    if (s && !s.color && !s.icon && !s.thumbnail && !s.importance && !s.nestedBoardPath) {
      delete card.dayStyles![date];
    }
  },

  showCalendarDayMenu(this: FreeformRenderer, e: MouseEvent, el: HTMLElement, card: CalendarCard, date: string): void {
    const menu = this.newMenu();
    const style = card.dayStyles?.[date];
    const commit = () => { this.scheduleSave(); this.rerenderCard(el, card); };
    const mutate = (fn: (s: CalendarDayStyle) => void) => {
      this.pushUndo();
      fn(this.ensureDayStyle(card, date));
      this.pruneDayStyleIfEmpty(card, date);
      commit();
    };

    menu.addItem(i => i.setTitle(`Add note on ${shortDate(date)}…`).setIcon('plus').onClick(() => {
      this.quickAddCalendarNote(el, card, date);
    }));

    menu.addSeparator();
    if (style?.nestedBoardPath) {
      menu.addItem(i => i.setTitle('Open nested board').setIcon('layout-template').onClick(() => {
        this.openNestedBoard(style.nestedBoardPath!, (p) => {
          this.ensureDayStyle(card, date).nestedBoardPath = p;
          this.scheduleSave();
        }, style.nestedBoardRoomId, (id) => { this.ensureDayStyle(card, date).nestedBoardRoomId = id; });
      }));
      menu.addItem(i => i.setTitle('Unlink nested board').setIcon('unlink').onClick(() => {
        mutate(s => { s.nestedBoardPath = undefined; s.nestedBoardIcon = undefined; s.nestedBoardRoomId = undefined; });
      }));
    } else {
      menu.addItem(i => i.setTitle('Create nested board…').setIcon('layout-template').onClick(() => {
        this.createNestedBoardFrom(shortDate(date), (path, icon, roomId) => {
          mutate(s => { s.nestedBoardPath = path; s.nestedBoardIcon = icon; s.nestedBoardRoomId = roomId; });
        });
      }));
    }

    menu.addSeparator();
    if (!style?.thumbnail) {
      menu.addItem(i => i.setTitle(style?.icon ? 'Change day icon…' : 'Set day icon…').setIcon('image').onClick(() => {
        new IconPickerModal(this.app, style?.iconColor ?? '#3B82F6', (selected, color) => {
          mutate(s => { s.icon = selected; s.iconColor = color; });
        }).open();
      }));
      if (style?.icon) {
        menu.addItem(i => i.setTitle('Remove day icon').setIcon('x').onClick(() => {
          mutate(s => { s.icon = undefined; s.iconColor = undefined; });
        }));
      }
    }
    if (!style?.icon) {
      menu.addItem(i => i.setTitle(style?.thumbnail ? 'Change day image…' : 'Set day image…').setIcon('image-plus').onClick(() => {
        new KanbanItemImageSuggestModal(this.app, (file) => {
          mutate(s => { s.thumbnail = { type: 'vault', path: file.path }; });
        }).open();
      }));
      menu.addItem(i => i.setTitle('Use day image URL…').setIcon('link').onClick(() => {
        new KanbanItemUrlModal(this.app, '', (url) => {
          if (!url) return;
          mutate(s => { s.thumbnail = { type: 'external', url }; });
        }).open();
      }));
      if (style?.thumbnail) {
        menu.addItem(i => i.setTitle('Remove day image').setIcon('x').onClick(() => {
          mutate(s => { s.thumbnail = undefined; });
        }));
      }
    }

    menu.addSeparator();
    menu.addItem(i => i.setTitle(style?.color ? 'Change day color…' : 'Set day color…').setIcon('palette').onClick(() => {
      new KanbanItemColorModal(this.app, style?.color, (hex) => {
        mutate(s => { s.color = hex; });
      }, this.boardIsDark()).open();
    }));

    menu.addSeparator();
    for (const { v, label } of CALENDAR_IMPORTANCE_OPTIONS) {
      menu.addItem(i => i.setTitle(label).setChecked(style?.importance === v).onClick(() => {
        mutate(s => { s.importance = v; });
      }));
    }

    menu.showAtMouseEvent(e);
  },

  showCalendarItemMenu(this: FreeformRenderer, e: MouseEvent, el: HTMLElement, card: CalendarCard, item: DatedItem): void {
    const menu = this.newMenu();
    const src = item.source;

    menu.addItem(i => i.setTitle('Change date…').setIcon('calendar').onClick(() => {
      new DueDateModal(this.app, item.start, (date) => {
        if (!date) return;
        this.pushUndo();
        item.move(date);
        this.scheduleSave();
        this.refreshAfterDateChange(item.sourceCardId);
      }).open();
    }));

    if (src.kind === 'calendar-note') {
      const note = src.note;
      const commit = () => { this.scheduleSave(); this.rerenderCard(el, card); };

      menu.addItem(i => i.setTitle('Edit text…').setIcon('pencil').onClick(() => {
        new CalendarNoteTextModal(this.app, note.text, (text) => {
          this.pushUndo(); note.text = text; commit();
        }).open();
      }));

      menu.addSeparator();
      if (note.nestedBoardPath) {
        menu.addItem(i => i.setTitle('Open nested board').setIcon('layout-template').onClick(() => {
          this.openNestedBoard(note.nestedBoardPath!, (p) => { note.nestedBoardPath = p; }, note.nestedBoardRoomId, (id) => { note.nestedBoardRoomId = id; });
        }));
        menu.addItem(i => i.setTitle('Unlink nested board').setIcon('unlink').onClick(() => {
          this.pushUndo(); note.nestedBoardPath = undefined; note.nestedBoardIcon = undefined; note.nestedBoardRoomId = undefined; commit();
        }));
      } else {
        menu.addItem(i => i.setTitle('Create nested board…').setIcon('layout-template').onClick(() => {
          this.createNestedBoardFrom(note.text || 'Note', (path, icon, roomId) => {
            this.pushUndo(); note.nestedBoardPath = path; note.nestedBoardIcon = icon; note.nestedBoardRoomId = roomId; commit();
          });
        }));
      }

      menu.addSeparator();
      if (!note.thumbnail) {
        menu.addItem(i => i.setTitle(note.icon ? 'Change icon…' : 'Set icon…').setIcon('image').onClick(() => {
          new IconPickerModal(this.app, note.iconColor ?? '#3B82F6', (selected, color) => {
            this.pushUndo(); note.icon = selected; note.iconColor = color; commit();
          }).open();
        }));
        if (note.icon) {
          menu.addItem(i => i.setTitle('Remove icon').setIcon('x').onClick(() => {
            this.pushUndo(); note.icon = undefined; note.iconColor = undefined; commit();
          }));
        }
      }
      if (!note.icon) {
        menu.addItem(i => i.setTitle(note.thumbnail ? 'Change image…' : 'Set image…').setIcon('image-plus').onClick(() => {
          new KanbanItemImageSuggestModal(this.app, (file) => {
            this.pushUndo(); note.thumbnail = { type: 'vault', path: file.path }; commit();
          }).open();
        }));
        menu.addItem(i => i.setTitle('Use image URL…').setIcon('link').onClick(() => {
          new KanbanItemUrlModal(this.app, '', (url) => {
            if (!url) return;
            this.pushUndo(); note.thumbnail = { type: 'external', url }; commit();
          }).open();
        }));
        if (note.thumbnail) {
          menu.addItem(i => i.setTitle('Remove image').setIcon('x').onClick(() => {
            this.pushUndo(); note.thumbnail = undefined; commit();
          }));
        }
      }

      menu.addSeparator();
      menu.addItem(i => i.setTitle(note.color ? 'Change color…' : 'Set color…').setIcon('palette').onClick(() => {
        new KanbanItemColorModal(this.app, note.color, (hex) => {
          this.pushUndo(); note.color = hex; commit();
        }, this.boardIsDark()).open();
      }));

      menu.addSeparator();
      for (const { v, label } of CALENDAR_IMPORTANCE_OPTIONS) {
        menu.addItem(i => i.setTitle(label).setChecked(note.importance === v).onClick(() => {
          this.pushUndo(); note.importance = v; commit();
        }));
      }

      menu.addSeparator();
      menu.addItem(i => i.setTitle('Delete note').setIcon('trash').onClick(() => {
        this.pushUndo();
        card.notes = (card.notes ?? []).filter(n => n.id !== note.id);
        // Deleting one of the visible chips pulls a hidden one up into its
        // place, leaving the same number showing — so the day stays open and
        // the removal is visible, rather than looking like nothing happened.
        el.dataset.vnExpandDay = item.start;
        commit();
      }));
    } else {
      menu.addSeparator();
      menu.addItem(i => i.setTitle(`Open on ${item.sourceName}`).setIcon('arrow-up-right').onClick(() => {
        this.selection.select(item.sourceCardId);
        this.refreshSelectionVisuals();
        this.centerOnCard(item.sourceCardId);
      }));
    }

    menu.showAtMouseEvent(e);
  },
};
