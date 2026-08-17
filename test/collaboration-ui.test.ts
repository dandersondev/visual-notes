// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeformRenderer, type FreeformCollaborationConfig } from '../src/freeform-view';
import { LoopbackCollaborationTransport } from '../src/collaboration-transport';
import { DEFAULT_PEN_DRAW_OPTIONS } from '../src/pen-options-panel';
import { fakeApp } from './fake-app';
import type { CollaborationIdentity } from '../src/collaboration-identity';
import type { StickyCard, VisualNotesFile } from '../src/file-types';

const live: FreeformRenderer[] = [];
afterEach(async () => {
  for (const renderer of live.splice(0)) await renderer.destroy();
  document.body.innerHTML = '';
});

const alice: CollaborationIdentity = {
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Alice', color: '#e57373',
};
const bob: CollaborationIdentity = {
  clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Bob', color: '#4fc3f7',
};

function makeRenderer(
  transport: LoopbackCollaborationTransport,
  identity: CollaborationIdentity,
  collaboration?: Partial<FreeformCollaborationConfig>,
): FreeformRenderer {
  const container = document.body.createDiv();
  const board: VisualNotesFile = {
    version: 3, layout: 'freeform', viewport: { x: 0, y: 0, zoom: 1 },
    cards: [{ id: 'card', kind: 'sticky', x: 20, y: 20, w: 220, h: 140, text: 'Original', color: '#fff' }],
    connections: [], drawings: [],
  };
  const file = { path: 'Shared.canvas', basename: 'Shared', name: 'Shared.canvas', extension: 'canvas' } as never;
  const renderer = new FreeformRenderer(
    fakeApp(), container, board, file, async () => {}, async () => {},
    30, undefined, 'left', undefined, false, 1, false, false, 32, undefined, 'bottom-right',
    { ...DEFAULT_PEN_DRAW_OPTIONS }, undefined, 'middle', true, { transport, identity, ...collaboration },
  );
  renderer.render();
  live.push(renderer);
  return renderer;
}

describe('experimental collaboration UI adapter', () => {
  it('shows collaborators and applies an ordinary board edit in the other view', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = makeRenderer(transport, alice);
    const b = makeRenderer(transport, bob);
    await vi.waitFor(() => expect(a.container.querySelectorAll('.visual-notes-collaboration-avatar')).toHaveLength(2));
    (a.board.cards[0] as StickyCard).text = 'Edited live';
    await a.flushCollaborationSync();

    expect((b.board.cards[0] as StickyCard).text).toBe('Edited live');
    expect(b.container.textContent).toContain('Edited live');
  });

  it('renders remote selection and cursor presence without changing board data', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = makeRenderer(transport, alice);
    const b = makeRenderer(transport, bob);
    await vi.waitFor(() => expect(a.container.querySelectorAll('.visual-notes-collaboration-avatar')).toHaveLength(2));
    const before = structuredClone(b.board);

    a.selection.select('card');
    a.refreshSelectionVisuals();
    await a.collaborationSession?.updatePresence({ cursor: { x: 80, y: 90 } });

    expect(b.container.querySelector('.visual-notes-remote-selection')).toBeTruthy();
    expect(b.container.querySelector('.visual-notes-remote-cursor-name')?.textContent).toBe('Alice');
    expect(b.board).toEqual(before);
  });

  it('surfaces a compatible plugin-version mismatch without disconnecting', async () => {
    const transport = new LoopbackCollaborationTransport();
    const renderer = makeRenderer(transport, alice);
    await vi.waitFor(() => expect(renderer.collaborationSession?.getState().status).toBe('connected'));
    const state = renderer.collaborationSession!.getState();
    renderer.applyCollaborationState({
      ...state,
      compatibilityWarnings: ['Collaborators are using different Visual Notes versions.'],
    });

    const warning = renderer.container.querySelector('.visual-notes-collaboration-compatibility-warning');
    expect(warning?.getAttribute('aria-label')).toMatch(/different Visual Notes versions/);
    expect(renderer.collaborationSession?.getState().status).toBe('connected');
  });

  it('does not let remote presence snap back a local card drag before it is published', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = makeRenderer(transport, alice);
    const b = makeRenderer(transport, bob);
    await vi.waitFor(() => expect(a.container.querySelectorAll('.visual-notes-collaboration-avatar')).toHaveLength(2));

    // Card drag frames mutate board coordinates immediately; scheduleSave is
    // deliberately deferred until pointerup. A presence event can arrive in
    // between any two of those frames.
    a.board.cards[0].x = 180;
    a.board.cards[0].y = 140;
    await b.collaborationSession?.updatePresence({ cursor: { x: 400, y: 300 } });

    expect(a.board.cards[0]).toMatchObject({ x: 180, y: 140 });

    await a.flushCollaborationSync();
    expect(b.board.cards[0]).toMatchObject({ x: 180, y: 140 });
  });

  it('publishes undo and keeps both collaborators connected', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = makeRenderer(transport, alice);
    const b = makeRenderer(transport, bob);
    await vi.waitFor(() => expect(a.container.querySelectorAll('.visual-notes-collaboration-avatar')).toHaveLength(2));

    a.pushUndo();
    (a.board.cards[0] as StickyCard).text = 'Changed before undo';
    await a.flushCollaborationSync();
    expect((b.board.cards[0] as StickyCard).text).toBe('Changed before undo');

    a.undo();
    await a.flushCollaborationSync();
    expect((a.board.cards[0] as StickyCard).text).toBe('Original');
    expect((b.board.cards[0] as StickyCard).text).toBe('Original');
    expect(a.collaborationSession?.getState().status).toBe('connected');
    expect(b.collaborationSession?.getState().status).toBe('connected');
  });

  it('creates and leaves a private room from the board controls', async () => {
    const transport = new LoopbackCollaborationTransport();
    const saveRoom = vi.fn(() => Promise.resolve());
    const room = {
      roomId: 'private:test-room', accessToken: 'owner-token', role: 'owner' as const,
      inviteCode: 'VN2-TESTROOMAB-ABCDEFGHIJKL', viewerInviteCode: 'VN2-TESTROOMAB-MNPQRSTUVWY',
    };
    const renderer = makeRenderer(transport, alice, {
      createRoom: vi.fn(() => Promise.resolve(room)),
      joinRoom: vi.fn(),
      saveRoom,
      transportForRoom: () => transport,
    });

    const create = Array.from(renderer.container.querySelectorAll('button')).find(button => button.textContent === 'Create room');
    expect(create).toBeTruthy();
    create?.click();
    await vi.waitFor(() => expect(renderer.collaborationSession).not.toBeNull());
    expect(saveRoom).toHaveBeenCalledWith(room);
    expect(renderer.container.textContent).toContain('Copy editor invite');

    // Leaving stops syncing and keeps the room. It used to discard it, which
    // for an owner was a one-way door: the access token lived nowhere else,
    // and the server refuses to reissue one to an owner through an invite, so
    // leaving your own room locked you out of it for good.
    const leave = Array.from(renderer.container.querySelectorAll('button')).find(button => button.textContent === 'Leave');
    leave?.click();
    await vi.waitFor(() => expect(renderer.container.textContent).toContain('Rejoin'));
    expect(renderer.collaborationSession).toBeNull();
    expect(saveRoom).not.toHaveBeenCalledWith(undefined);
    expect(renderer.collaborationConfig?.room).toEqual(room);
  });

  it('only discards a room when it is explicitly forgotten', async () => {
    const transport = new LoopbackCollaborationTransport();
    const saveRoom = vi.fn(() => Promise.resolve());
    const room = {
      roomId: 'private:test-room', accessToken: 'owner-token', role: 'owner' as const,
      inviteCode: 'VN2-TESTROOMAB-ABCDEFGHIJKL', viewerInviteCode: 'VN2-TESTROOMAB-MNPQRSTUVWY',
    };
    const renderer = makeRenderer(transport, alice, {
      room, saveRoom, transportForRoom: () => transport, joinRoom: vi.fn(), createRoom: vi.fn(),
    });
    await vi.waitFor(() => expect(renderer.collaborationSession).not.toBeNull());

    // Forget opens a confirmation and does nothing on its own. Asserted rather
    // than driven, because the point of the button is that it is not the
    // discard -- a Forget that discarded immediately would pass a test that
    // only checked the end state.
    const forget = Array.from(renderer.container.querySelectorAll('button')).find(button => button.textContent === 'Forget');
    expect(forget).toBeTruthy();
    forget?.click();
    await Promise.resolve();
    expect(saveRoom).not.toHaveBeenCalledWith(undefined);
    expect(renderer.collaborationConfig?.room).toEqual(room);

    // Confirming runs this, which is what the modal's callback invokes.
    await renderer.discardCollaborationRoom();
    expect(saveRoom).toHaveBeenLastCalledWith(undefined);
    expect(renderer.collaborationConfig?.room).toBeUndefined();
  });

  it('restores optimistic canvas changes for a viewer instead of publishing them', async () => {
    const transport = new LoopbackCollaborationTransport();
    const renderer = makeRenderer(transport, alice, {
      room: { roomId: 'private:view-only', accessToken: 'viewer-token', role: 'viewer' },
    });
    await vi.waitFor(() => expect(renderer.collaborationSession?.getState().status).toBe('connected'));
    expect(renderer.collaborationSession?.getState().role).toBe('viewer');

    renderer.board.cards[0].x = 500;
    await renderer.flushCollaborationSync();

    expect(renderer.board.cards[0].x).toBe(20);
    expect(renderer.collaborationSession?.getState().pendingOperations).toBe(0);
    expect(renderer.container.textContent).toContain('viewer');
  });
});
