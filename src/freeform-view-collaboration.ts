import { screenToCanvas } from './canvas/pan-zoom';
import { Modal, Notice, Setting } from 'obsidian';
import { diffBoardOperations } from './collaboration-diff';
import { CollaborationSession, type CollaborationSessionState } from './collaboration-session';
import type { VisualNotesFile } from './file-types';
import type { FreeformRenderer } from './freeform-view';
import type { CollaborationRoomCredentials, CollaborationRoomMember } from './collaboration-rooms';
import type { HostedRoomSummary } from './collaboration-host';
import { ConfirmModal } from './tile-modal';
import { deliverExport } from './asset-manager';

declare module './freeform-view' {
  interface FreeformRenderer {
    startCollaboration(): void;
    stopCollaboration(): Promise<void>;
    scheduleCollaborationSync(): void;
    flushCollaborationSync(): Promise<void>;
    applyCollaborationState(state: CollaborationSessionState): void;
    renderCollaborationPresence(): void;
    publishCollaborationPresence(): void;
    renderCollaborationRoomControls(): void;
    renderCollaborationLeftRoom(): void;
    forgetCollaborationRoom(): Promise<void>;
  }
}

const COLLAB_SYNC_DELAY_MS = 60;
const CURSOR_INTERVAL_MS = 50;

export const collaborationMethods = {
  startCollaboration(this: FreeformRenderer): void {
    if (!this.collaborationConfig || this.collaborationSession) return;
    if (!this.collaborationPresenceEl) {
      this.collaborationPresenceEl = this.outer.createDiv('visual-notes-collaboration-presence');
      this.collaborationPresenceEl.addEventListener('pointerdown', event => event.stopPropagation());
    }
    if (this.collaborationConfig.createRoom && !this.collaborationConfig.room) {
      this.renderCollaborationRoomControls();
      return;
    }
    this.collaborationLastBoard = collaborationBoard(this.board);
    const roomId = this.collaborationConfig.room?.roomId ?? `local:${this.file.path}`;
    const session = new CollaborationSession({
      roomId,
      boardId: this.collaborationConfig.room?.roomId ?? this.file.path,
      identity: this.collaborationConfig.identity,
      initialBoard: collaborationBoard(this.board),
      transport: this.collaborationConfig.transport,
      initialRole: this.collaborationConfig.room?.role,
    });
    this.collaborationSession = session;
    this.collaborationUnsubscribe = session.onStateChange(state => this.applyCollaborationState(state));
    if (!this.collaborationAssetUnsubscribe && this.collaborationConfig.assetClient) {
      this.collaborationAssetUnsubscribe = this.collaborationConfig.assetClient.subscribeTransfers(() => this.renderCollaborationPresence());
    }

    if (!this.collaborationPointerEventsBound) {
      this.collaborationPointerEventsBound = true;
      this.outer.addEventListener('pointermove', (event) => {
        if (this.collaborationCursorLeaveTimer !== null) {
          window.clearTimeout(this.collaborationCursorLeaveTimer);
          this.collaborationCursorLeaveTimer = null;
        }
        if (!this.collaborationSession || performance.now() - this.collaborationPointerAt < CURSOR_INTERVAL_MS) return;
        this.collaborationPointerAt = performance.now();
        const rect = this.outer.getBoundingClientRect();
        const cursor = screenToCanvas(event.clientX - rect.left, event.clientY - rect.top, this.vp);
        void this.collaborationSession.updatePresence({ cursor });
      });
      this.outer.addEventListener('pointerleave', () => {
        if (this.collaborationCursorLeaveTimer !== null) window.clearTimeout(this.collaborationCursorLeaveTimer);
        // A short grace period makes remote cursors observable while testing
        // two vault windows with one mouse: changing windows necessarily
        // leaves the first canvas before the second can display its cursor.
        // It also prevents a tiny toolbar crossing from making cursors blink.
        this.collaborationCursorLeaveTimer = window.setTimeout(() => {
          this.collaborationCursorLeaveTimer = null;
          void this.collaborationSession?.updatePresence({ cursor: null });
        }, 2500);
      });
    }
    void session.connect().then(() => {
      if (this.collaborationConfig?.room && this.collaborationConfig.assetClient) void this.flushCollaborationSync();
    }).catch(error => {
      console.error('Visual Notes: local collaboration session failed', error);
      this.collaborationPresenceEl?.setText('Collaboration unavailable');
      this.collaborationPresenceEl?.addClass('is-error');
    });
  },

  async stopCollaboration(this: FreeformRenderer): Promise<void> {
    if (this.collaborationSyncTimer !== null) {
      window.clearTimeout(this.collaborationSyncTimer);
      this.collaborationSyncTimer = null;
    }
    if (this.collaborationCursorLeaveTimer !== null) {
      window.clearTimeout(this.collaborationCursorLeaveTimer);
      this.collaborationCursorLeaveTimer = null;
    }
    this.collaborationUnsubscribe?.();
    this.collaborationUnsubscribe = null;
    this.collaborationAssetUnsubscribe?.();
    this.collaborationAssetUnsubscribe = null;
    const session = this.collaborationSession;
    this.collaborationSession = null;
    if (session) await session.disconnect();
    this.collaborationPresenceEl?.remove();
    this.collaborationPresenceEl = null;
    for (const element of this.collaborationCursorEls.values()) element.remove();
    this.collaborationCursorEls.clear();
    for (const element of this.collaborationSelectionEls) element.remove();
    this.collaborationSelectionEls = [];
  },

  scheduleCollaborationSync(this: FreeformRenderer): void {
    if (!this.collaborationSession || this.collaborationPublishingLocal) return;
    if (this.collaborationSyncTimer !== null) window.clearTimeout(this.collaborationSyncTimer);
    this.collaborationSyncTimer = window.setTimeout(() => {
      this.collaborationSyncTimer = null;
      void this.flushCollaborationSync();
    }, COLLAB_SYNC_DELAY_MS);
  },

  async flushCollaborationSync(this: FreeformRenderer): Promise<void> {
    if (this.collaborationSyncTimer !== null) {
      window.clearTimeout(this.collaborationSyncTimer);
      this.collaborationSyncTimer = null;
    }
    const session = this.collaborationSession;
    const before = this.collaborationLastBoard;
    if (!session || !before || this.collaborationPublishingLocal) return;
    const room = this.collaborationConfig?.room;
    if (room && this.collaborationConfig?.assetClient && session.getState().role !== 'viewer') {
      try { await this.collaborationConfig.assetClient.prepareBoard(this.board, room); }
      catch (error) {
        console.error('Visual Notes: could not share collaboration asset', error);
        new Notice(error instanceof Error ? `Could not share image: ${error.message}` : 'Could not share image.');
        return;
      }
    }
    const after = collaborationBoard(this.board);
    let actions: ReturnType<typeof diffBoardOperations>;
    try { actions = diffBoardOperations(before, after); }
    catch (error) {
      console.error('Visual Notes: could not prepare local collaboration edit', error);
      new Notice(error instanceof Error ? `Could not sync edit: ${error.message}` : 'Could not sync edit.');
      return;
    }
    if (actions.length === 0) return;
    if (session.getState().role === 'viewer') {
      // Canvas interactions are optimistic, so restore the authoritative
      // snapshot before the ordinary file-save debounce can persist a local
      // change that the server correctly refuses for a viewer.
      this.collaborationLastBoard = after;
      this.applyCollaborationState(session.getState());
      new Notice('This collaboration room is view-only for you.');
      return;
    }
    this.collaborationPublishingLocal = true;
    try {
      for (const action of actions) await session.submit(action);
      this.collaborationLastBoard = after;
    } catch (error) {
      console.error('Visual Notes: could not publish local collaboration edit', error);
    } finally {
      this.collaborationPublishingLocal = false;
    }
    this.applyCollaborationState(session.getState());
  },

  applyCollaborationState(this: FreeformRenderer, state: CollaborationSessionState): void {
    this.collaborationState = state;
    this.renderCollaborationPresence();
    if (this.collaborationPublishingLocal) return;
    const current = collaborationBoard(this.board);

    // Presence updates carry the session's latest board snapshot too. While a
    // local gesture is in progress, that snapshot is necessarily one step
    // behind the renderer: card dragging updates x/y immediately and only
    // schedules its collaboration flush when the gesture ends. Applying a
    // cursor/selection update in that window used to rebuild the board from
    // the stale snapshot, snapping the card back on every remote pointer move
    // and making cards appear impossible to drag with two people connected.
    //
    // Keep the renderer authoritative until its pending local delta has been
    // submitted. flushCollaborationSync() explicitly reapplies the session
    // state afterwards, so remote operations received during the gesture are
    // merged as soon as the local edit is safely represented in the session.
    const localBaseline = this.collaborationLastBoard;
    if (localBaseline && diffBoardOperations(localBaseline, current).length > 0) return;
    if (diffBoardOperations(current, state.board).length === 0) return;

    const baseline = this.board.baseline;
    const viewport = this.board.viewport;
    applySerializableBoard(this.board, state.board);
    this.board.baseline = baseline;
    this.board.viewport = viewport;
    this.collaborationLastBoard = collaborationBoard(this.board);
    this.rebuildCards();
    this.saveQueue.schedule();
    this.renderCollaborationPresence();
  },

  renderCollaborationPresence(this: FreeformRenderer): void {
    const state = this.collaborationState;
    const host = this.collaborationPresenceEl;
    if (!state || !host || !this.collaborationConfig) return;
    host.empty();
    host.toggleClass('is-connected', state.status === 'connected');
    const status = host.createDiv('visual-notes-collaboration-status');
    status.createSpan('visual-notes-collaboration-dot');
    status.createSpan().setText(state.status === 'connected' ? (this.collaborationConfig.label ?? 'Local session') : state.status);
    if (state.compatibilityWarnings.length > 0) {
      const warning = status.createSpan('visual-notes-collaboration-compatibility-warning');
      warning.setText('⚠');
      warning.setAttribute('aria-label', state.compatibilityWarnings.join(' '));
      warning.setAttribute('data-tooltip-position', 'bottom');
    }
    const transfer = this.collaborationConfig.assetClient?.transfer();
    if (transfer) {
      const transferEl = host.createDiv(`visual-notes-collaboration-transfer is-${transfer.phase}`);
      const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.loaded / transfer.total) * 100)) : 0;
      transferEl.createSpan().setText(transfer.phase === 'preparing'
        ? `Preparing ${transfer.name}`
        : transfer.phase === 'uploading' ? `Uploading ${transfer.name} ${percent}%` : `${transfer.name}: ${transfer.error ?? 'Upload failed'}`);
      const transferAction = transferEl.createEl('button', {
        text: transfer.phase === 'failed' ? 'Retry' : 'Cancel',
        attr: { 'aria-label': transfer.phase === 'failed' ? 'Retry media upload' : 'Cancel media upload' },
      });
      transferAction.addEventListener('click', () => {
        if (transfer.phase === 'failed') void this.flushCollaborationSync();
        else this.collaborationConfig?.assetClient?.cancelTransfer();
      });
    }
    const avatars = host.createDiv('visual-notes-collaboration-avatars');
    for (const person of state.collaborators) {
      const avatar = avatars.createDiv('visual-notes-collaboration-avatar');
      avatar.style.backgroundColor = person.color;
      avatar.setText(initials(person.displayName));
      avatar.setAttribute('aria-label', `${person.displayName}${person.clientId === this.collaborationConfig.identity.clientId ? ' (you)' : ''}`);
      avatar.setAttribute('data-tooltip-position', 'bottom');
    }
    if (this.collaborationConfig.room) {
      const room = this.collaborationConfig.room;
      const actions = host.createDiv('visual-notes-collaboration-room-actions');
      actions.createSpan('visual-notes-collaboration-role').setText(room.role);
      if (room.role === 'owner') {
        if (room.inviteCode) addCopyInviteButton(actions, 'Copy editor invite',
          this.collaborationConfig.formatInvite?.(room.inviteCode) ?? room.inviteCode);
        if (room.viewerInviteCode) addCopyInviteButton(actions, 'Copy viewer invite',
          this.collaborationConfig.formatInvite?.(room.viewerInviteCode) ?? room.viewerInviteCode);
        const manage = actions.createEl('button', { text: 'Manage' });
        manage.addEventListener('click', () => {
          new CollaborationRoomManagementModal(this.app, room, this.collaborationConfig!, () => {
            this.renderCollaborationPresence();
          }, async () => {
            await this.stopCollaboration();
            if (!this.collaborationConfig) return;
            this.collaborationConfig.room = undefined;
            await this.collaborationConfig.saveRoom?.(undefined);
            this.startCollaboration();
          }).open();
        });
      }
      // Leave stops syncing but keeps the room. It used to discard it, and for
      // an owner that was a one-way door: the access token existed nowhere
      // else, and the server refuses to hand an owner a new one through an
      // invite, so leaving your own room locked you out of it permanently
      // while its data sat intact on the host's disk. Forgetting a room is now
      // its own deliberate action.
      const leave = actions.createEl('button', { text: 'Leave', attr: { 'aria-label': 'Stop syncing this board' } });
      leave.addEventListener('click', () => { void (async () => {
        await this.stopCollaboration();
        this.collaborationLeftRoom = true;
        this.renderCollaborationLeftRoom();
      })(); });
      const forget = actions.createEl('button', {
        text: 'Forget', attr: { 'aria-label': 'Forget this collaboration room on this device' },
      });
      forget.addEventListener('click', () => { void this.forgetCollaborationRoom(); });
    }

    // Cursors are reused, not rebuilt. Presence arrives many times a second,
    // and tearing down three elements per collaborator per update was enough
    // DOM churn to show as cursor lag. Position moves through `transform`
    // rather than left/top: left/top forces a synchronous layout on every
    // update (the "Forced reflow" console violation came from here), and on
    // iOS an absolutely positioned element moved that way -- with a
    // drop-shadow filter on its tip -- leaves paint trails, which is the
    // ghosting where old cursors pile up until something else repaints.
    //
    // Selection outlines still rebuild: they live inside card elements, which
    // the board re-render replaces, so a reused outline would be orphaned.
    for (const element of this.collaborationSelectionEls) element.remove();
    this.collaborationSelectionEls = [];
    const seen = new Set<string>();
    for (const person of state.collaborators) {
      if (person.clientId === this.collaborationConfig.identity.clientId) continue;
      if (person.cursor) {
        seen.add(person.clientId);
        let cursor = this.collaborationCursorEls.get(person.clientId);
        if (!cursor) {
          cursor = this.inner.createDiv('visual-notes-remote-cursor');
          cursor.createDiv('visual-notes-remote-cursor-tip');
          cursor.createDiv('visual-notes-remote-cursor-name');
          this.collaborationCursorEls.set(person.clientId, cursor);
        }
        cursor.style.transform = `translate3d(${person.cursor.x}px, ${person.cursor.y}px, 0)`;
        cursor.style.setProperty('--visual-notes-collaborator-color', person.color);
        const name = cursor.querySelector<HTMLElement>('.visual-notes-remote-cursor-name');
        if (name && name.textContent !== person.displayName) name.setText(person.displayName);
      }
      person.selectedIds.forEach((id, index) => {
        const card = this.cardEls.get(id);
        if (!card) return;
        const outline = card.createDiv('visual-notes-remote-selection');
        outline.style.setProperty('--visual-notes-collaborator-color', person.color);
        outline.style.inset = `${2 + index * 3}px`;
        outline.setAttribute('aria-label', `Selected by ${person.displayName}`);
        this.collaborationSelectionEls.push(outline);
      });
    }
    // Whoever stopped pointing, or left the room, loses their cursor. Without
    // this the reused elements would be the thing that piles up.
    for (const [clientId, element] of this.collaborationCursorEls) {
      if (seen.has(clientId)) continue;
      element.remove();
      this.collaborationCursorEls.delete(clientId);
    }
  },

  publishCollaborationPresence(this: FreeformRenderer): void {
    const session = this.collaborationSession;
    if (!session) return;
    const selectedIds = this.selection.getIds().sort();
    const key = selectedIds.join('\u0000');
    if (key === this.collaborationPresenceKey) return;
    this.collaborationPresenceKey = key;
    void session.updatePresence({ selectedIds });
  },

  renderCollaborationLeftRoom(this: FreeformRenderer): void {
    const config = this.collaborationConfig;
    if (!config?.room) return;
    if (!this.collaborationPresenceEl) {
      this.collaborationPresenceEl = this.outer.createDiv('visual-notes-collaboration-presence');
      this.collaborationPresenceEl.addEventListener('pointerdown', event => event.stopPropagation());
    }
    const host = this.collaborationPresenceEl;
    host.empty();
    host.removeClass('is-connected');
    host.createSpan('visual-notes-collaboration-room-label').setText('Not syncing');
    const actions = host.createDiv('visual-notes-collaboration-room-actions');
    const rejoin = actions.createEl('button', {
      text: 'Rejoin', attr: { 'aria-label': 'Rejoin this collaboration room' },
    });
    rejoin.addEventListener('click', () => {
      this.collaborationLeftRoom = false;
      this.startCollaboration();
    });
    const forget = actions.createEl('button', {
      text: 'Forget', attr: { 'aria-label': 'Forget this collaboration room on this device' },
    });
    forget.addEventListener('click', () => { void this.forgetCollaborationRoom(); });
  },

  /**
   * Discards this device's credentials for the room. Deliberately separate
   * from Leave: for an owner this is irreversible from anywhere but the host,
   * because the server will not reissue owner access through an invite.
   */
  async forgetCollaborationRoom(this: FreeformRenderer): Promise<void> {
    const config = this.collaborationConfig;
    if (!config?.room) return;
    const owner = config.room.role === 'owner';
    const message = owner
      ? 'Forget this room on this device?\n\n'
        + 'You own it. Its data stays on the host, and you can restore access with "Reopen my room" '
        + 'while hosting. Everyone else keeps the access they already have.'
      : 'Forget this room on this device?\n\n'
        + 'You will need an invitation to join it again.';
    if (!window.confirm(message)) return;
    await this.stopCollaboration();
    config.room = undefined;
    await config.saveRoom?.(undefined);
    this.collaborationLeftRoom = false;
    this.startCollaboration();
  },

  renderCollaborationRoomControls(this: FreeformRenderer): void {
    const host = this.collaborationPresenceEl;
    const config = this.collaborationConfig;
    if (!host || !config) return;
    host.empty();
    host.createSpan('visual-notes-collaboration-room-label').setText('Collaboration off');
    const actions = host.createDiv('visual-notes-collaboration-room-actions');
    const create = actions.createEl('button', { text: 'Create room' });
    const join = actions.createEl('button', { text: 'Join room' });
    // Only offered where it can work: recovering owner access reads the room
    // files, which only the hosting machine has. Attaching happens here rather
    // than in settings because "this board" is unambiguous on a board and
    // guesswork anywhere else.
    if (config.listHostedRooms && config.claimHostedRoom) {
      const reopen = actions.createEl('button', {
        text: 'Reopen my room', attr: { 'aria-label': 'Reopen a room hosted on this device' },
      });
      reopen.addEventListener('click', () => { void (async () => {
        reopen.disabled = true;
        try {
          const rooms = await config.listHostedRooms!();
          if (rooms.length === 0) { new Notice('No collaboration rooms are stored on this device yet.'); return; }
          new HostedRoomPickerModal(this.app, rooms, summary => { void (async () => {
            try {
              const room = await config.claimHostedRoom!(summary.roomId);
              config.room = room;
              if (config.transportForRoom) config.transport = config.transportForRoom(room);
              config.assetClient?.destroy();
              config.assetClient = config.assetClientForRoom?.() ?? config.assetClient;
              await config.saveRoom?.(room);
              this.collaborationLeftRoom = false;
              new Notice('Owner access restored. Use Manage to rotate invitations if you need to share it again.');
              this.startCollaboration();
            } catch (error) {
              new Notice(`Could not reopen the room: ${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          })(); }).open();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : 'Could not list hosted rooms.', 10000);
        } finally {
          reopen.disabled = false;
        }
      })(); });
    }
    create.addEventListener('click', () => { void (async () => {
      create.disabled = true; join.disabled = true;
      try {
        const room = await config.createRoom?.(collaborationBoard(this.board));
        if (!room) return;
        config.room = room;
        if (config.transportForRoom) config.transport = config.transportForRoom(room);
        config.assetClient = config.assetClientForRoom?.() ?? config.assetClient;
        await config.saveRoom?.(room);
        new Notice('Collaboration room created. Use Copy editor invite or Copy viewer invite to share it.');
        this.startCollaboration();
      } catch (error) {
        new Notice(`Could not create collaboration room: ${error instanceof Error ? error.message : String(error)}`, 10000);
        create.disabled = false; join.disabled = false;
      }
    })(); });
    join.addEventListener('click', () => {
      new CollaborationInviteModal(this.app, (inviteCode) => { void (async () => {
        try {
          const room = await config.joinRoom?.(inviteCode);
          if (!room) return;
          config.room = room;
          if (config.transportForRoom) config.transport = config.transportForRoom(room);
          config.assetClient?.destroy();
          config.assetClient = config.assetClientForRoom?.() ?? config.assetClient;
          await config.saveRoom?.(room);
          this.startCollaboration();
        } catch (error) {
          new Notice(`Could not join collaboration room: ${error instanceof Error ? error.message : String(error)}`, 10000);
        }
      })(); }).open();
    });
  },
};

class CollaborationInviteModal extends Modal {
  private inviteCode = '';

  constructor(app: FreeformRenderer['app'], private readonly submit: (inviteCode: string) => void) { super(app); }

  override onOpen(): void {
    this.setTitle('Join collaboration room');
    new Setting(this.contentEl)
      .setName('Invitation')
      .setDesc('Paste the complete private-network invitation or a legacy hosted room code.')
      .addText(text => text.setPlaceholder('visual-notes-collab:v1:...').onChange(value => { this.inviteCode = value; }));
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(button => button.setButtonText('Join room').setCta().onClick(() => {
        const value = this.inviteCode.trim();
        if (!value) { new Notice('Enter an invite code.'); return; }
        this.close();
        this.submit(value);
      }));
  }

  override onClose(): void { this.contentEl.empty(); }
}

class CollaborationRoomManagementModal extends Modal {
  constructor(
    app: FreeformRenderer['app'],
    private readonly room: CollaborationRoomCredentials,
    private readonly config: NonNullable<FreeformRenderer['collaborationConfig']>,
    private readonly changed: () => void,
    private readonly deleted: () => Promise<void>,
  ) { super(app); }

  override onOpen(): void {
    this.setTitle('Manage collaboration room');
    void this.renderBody();
  }

  override onClose(): void { this.contentEl.empty(); }

  private async renderBody(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'Invitations' });
    for (const role of ['editor', 'viewer'] as const) {
      const code = role === 'editor' ? this.room.inviteCode : this.room.viewerInviteCode;
      new Setting(this.contentEl)
        .setName(`${capitalize(role)} invite`)
        .setDesc(code ?? 'No active invite')
        .addButton(button => button.setButtonText('Copy').setDisabled(!code).onClick(() => {
          if (code) void copyInviteCode(this.config.formatInvite?.(code) ?? code);
        }))
        .addButton(button => button.setButtonText('Replace').onClick(() => { void this.rotate(role, button.buttonEl); }));
    }
    this.contentEl.createEl('h3', { text: 'Members' });
    const loading = this.contentEl.createDiv({ text: 'Loading members…', cls: 'visual-notes-collaboration-members-loading' });
    try {
      const [members, storage, tree] = await Promise.all([
        this.config.listMembers?.(this.room) ?? Promise.resolve([]),
        this.config.getRoomStorage?.(this.room) ?? Promise.resolve(undefined),
        this.config.getRoomTree?.(this.room) ?? Promise.resolve([]),
      ]);
      loading.remove();
      for (const member of members) this.renderMember(member);
      if (storage) {
        this.contentEl.createEl('h3', { text: 'Shared media storage' });
        new Setting(this.contentEl)
          .setName(`${formatBytes(storage.usedBytes)} used`)
          .setDesc(`${formatBytes(storage.activeBytes)} active · ${formatBytes(storage.orphanedBytes)} recoverable for ${formatGrace(storage.graceMs)} · ${formatBytes(storage.limitBytes)} limit`)
          .addButton(button => button.setButtonText('Clean up').setDisabled(storage.cleanupEligibleCount === 0).onClick(() => {
            void this.cleanup(button.buttonEl);
          }));
      }
      if (tree.length > 0) {
        this.contentEl.createEl('h3', { text: 'Board tree' });
        for (const entry of tree) {
          new Setting(this.contentEl)
            .setName(`${'\u00a0\u00a0'.repeat(entry.depth)}${entry.roomId === this.room.roomId ? 'Current board' : entry.roomId}`)
            .setDesc(`${entry.cardCount} card${entry.cardCount === 1 ? '' : 's'} · ${formatBytes(entry.assetBytes)} shared media`);
        }
      }
      this.contentEl.createEl('h3', { text: 'Room data' });
      new Setting(this.contentEl)
        .setName('Export room')
        .setDesc('Download every board in this collaboration tree and its shared-media manifest. Media files remain on the server.')
        .addButton(button => button.setButtonText('Export JSON').onClick(() => { void this.exportRoom(button.buttonEl); }));
      new Setting(this.contentEl)
        .setName('Delete hosted room')
        .setDesc('The local Canvas remains in your vault. This room and all nested rooms beneath it will be deleted and collaborators disconnected.')
        .addButton(button => button.setButtonText('Delete room').setWarning().onClick(() => this.confirmDelete()));
    } catch (error) {
      loading.setText(`Could not load members: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderMember(member: CollaborationRoomMember): void {
    const own = member.clientId === this.config.identity.clientId;
    const setting = new Setting(this.contentEl)
      .setName(`${member.displayName}${own ? ' (you)' : ''}`)
      .setDesc(capitalize(member.role));
    if (!own && member.role !== 'owner') {
      setting.addButton(button => button.setButtonText('Remove').onClick(() => { void (async () => {
        button.setDisabled(true);
        try {
          await this.config.removeMember?.(this.room, member.clientId);
          new Notice(`${member.displayName} was removed from the room.`);
          await this.renderBody();
        } catch (error) {
          button.setDisabled(false);
          new Notice(`Could not remove member: ${error instanceof Error ? error.message : String(error)}`, 10000);
        }
      })(); }));
    }
  }

  private async rotate(role: 'editor' | 'viewer', button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const code = await this.config.rotateInvite?.(this.room, role);
      if (!code) return;
      if (role === 'editor') this.room.inviteCode = code;
      else this.room.viewerInviteCode = code;
      await this.config.saveRoom?.(this.room);
      this.changed();
      new Notice(`${capitalize(role)} invite replaced. The previous code no longer works.`);
      await this.renderBody();
    } catch (error) {
      button.disabled = false;
      new Notice(`Could not replace invite: ${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  private async cleanup(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const result = await this.config.cleanupRoomAssets?.(this.room);
      if (!result) return;
      new Notice(`Removed ${result.removedFromRoom} expired media reference${result.removedFromRoom === 1 ? '' : 's'}; deleted ${result.deletedFiles} unshared file${result.deletedFiles === 1 ? '' : 's'}.`);
      await this.renderBody();
    } catch (error) {
      button.disabled = false;
      new Notice(`Could not clean up media: ${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  private async exportRoom(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const exported = await this.config.exportRoom?.(this.room);
      if (!exported) return;
      const filename = `Visual Notes room ${this.room.roomId.replace(/[^a-z0-9_-]+/gi, '-')}.json`;
      await deliverExport(this.app, new TextEncoder().encode(JSON.stringify(exported, null, 2)), filename, 'application/json');
      new Notice('Collaboration room export created.');
    } catch (error) {
      new Notice(`Could not export room: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally { button.disabled = false; }
  }

  private confirmDelete(): void {
    new ConfirmModal(
      this.app,
      'Delete this hosted collaboration room and every nested room beneath it? Local Canvas files stay in each vault, but collaborators will be disconnected and the hosted board tree cannot be rejoined.',
      () => { void this.deleteRoom(); },
      'Delete hosted room',
    ).open();
  }

  private async deleteRoom(): Promise<void> {
    try {
      await this.config.deleteRoom?.(this.room);
      this.close();
      await this.deleted();
      new Notice('Hosted collaboration room deleted. The local board is unchanged.');
    } catch (error) {
      new Notice(`Could not delete room: ${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }
}

function addCopyInviteButton(host: HTMLElement, label: string, code: string): void {
  const button = host.createEl('button', { text: label, attr: { 'aria-label': label } });
  button.addEventListener('click', () => { void copyInviteCode(code); });
}

async function copyInviteCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    new Notice('Collaboration invitation copied. Treat it like a password.');
  } catch { new Notice(`Invite code: ${code}`, 10000); }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatGrace(milliseconds: number): string {
  const days = Math.max(1, Math.round(milliseconds / 86_400_000));
  return `${days} day${days === 1 ? '' : 's'}`;
}

function collaborationBoard(board: VisualNotesFile): VisualNotesFile {
  const clone = structuredClone(board);
  delete clone.baseline;
  delete clone.unreadable;
  delete clone.recoveredFromNativeEdit;
  delete clone.viewport;
  return clone;
}

function applySerializableBoard(target: VisualNotesFile, source: VisualNotesFile): void {
  target.version = source.version;
  target.layout = source.layout;
  target.cards = structuredClone(source.cards);
  target.connections = structuredClone(source.connections);
  target.drawings = structuredClone(source.drawings);
  copyOptional(target, source, 'dotsHidden');
  copyOptional(target, source, 'appearance');
  copyOptional(target, source, 'archived');
  copyOptional(target, source, 'foreignNodes');
  copyOptional(target, source, 'foreignEdges');
}

function copyOptional<K extends keyof VisualNotesFile>(target: VisualNotesFile, source: VisualNotesFile, key: K): void {
  if (source[key] === undefined) delete target[key];
  else target[key] = structuredClone(source[key]);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase();
}

/** Picks one of the rooms this device is hosting, to recover access to it. */
class HostedRoomPickerModal extends Modal {
  constructor(
    app: FreeformRenderer['app'],
    private readonly rooms: HostedRoomSummary[],
    private readonly choose: (room: HostedRoomSummary) => void,
  ) { super(app); }

  override onOpen(): void {
    this.setTitle('Reopen a room hosted on this device');
    this.contentEl.createEl('p', {
      text: 'Restores your owner access to a room stored here. Everyone else keeps the access they already have.',
    });
    for (const room of this.rooms) {
      // Named by the board it was created from, falling back to a summary of
      // what is on it. The room ID identifies nothing to a person -- it is
      // random, and a private room's boardId is just the room ID again -- so
      // it is shown quietly underneath rather than as the heading.
      const setting = new Setting(this.contentEl).setName(room.title);
      const details = [
        `${room.cardCount} card${room.cardCount === 1 ? '' : 's'}`,
        room.memberNames.length > 0
          ? `shared with ${formatNameList(room.memberNames)}`
          : `${room.memberCount} member${room.memberCount === 1 ? '' : 's'}`,
      ];
      setting.setDesc(details.join(' · '));
      setting.descEl.createDiv({ cls: 'visual-notes-collaboration-room-id', text: room.roomId });
      setting.addButton(button => button.setButtonText('Reopen').setCta().onClick(() => {
        this.close();
        this.choose(room);
      }));
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}

/** "Alice", "Alice and Bob", "Alice, Bob and 2 others". */
function formatNameList(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} other${unique.length - 2 === 1 ? '' : 's'}`;
}
