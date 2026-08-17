import { Plugin, TFile, TFolder, TAbstractFile, FileView, FileSystemAdapter, Menu, Notice, Platform, apiVersion } from 'obsidian';
import { VisualNotesView, VISUAL_NOTES_VIEW_TYPE, NATIVE_CANVAS_VIEW_TYPE } from './view';
import { VisualNotesSettingsTab } from './settings';
import { VisualNotesSettings, DEFAULT_SETTINGS } from './types';
import { Card, VisualNotesFile } from './file-types';
import {
  addClipsToBoard, announceClipImport, clipFolderExists, listClipFiles, shouldQueueClip,
} from './web-clip-import';
import { SaveQueue } from './save-queue';
import { ExplorerDecorator } from './explorer-decor';

// Long enough that clipping several pages in a row costs one board write
// rather than one each, short enough that a single clip still feels immediate.
const CLIP_IMPORT_DEBOUNCE_MS = 800;
// Roughly 30 seconds of waiting for a virtual network to finish connecting
// after Obsidian starts, checked often enough that a fast one resumes almost
// immediately. Tailscale is routinely not up when the plugin loads.
const HOST_RESUME_ATTEMPTS = 15;
const HOST_RESUME_RETRY_MS = 2_000;
import { normalizeSettings } from './settings-validate';
import { ensureCollaborationIdentity } from './collaboration-identity';
import { CreateBoardModal, TemplatePickerModal, TemplateChoice } from './create-board-modal';
import { needsMigration, migrateV1toV2 } from './migration';
import { relinkAllBoards } from './asset-manager';
import { isVisualNotesOwnedFile, listTemplates, createBoardFileFromTemplate, installStarterTemplate, TEMPLATES_FOLDER, promptSaveBoardAsTemplate, backupBeforeNativeEdit, NATIVE_BAK_SUFFIX } from './file-io';
import { STARTER_TEMPLATES } from './starter-templates';
import { LoopbackCollaborationTransport } from './collaboration-transport';
import type { CollaborationTransport } from './collaboration-transport';
import { isSafeCollaborationServerUrl, WebSocketCollaborationTransport } from './collaboration-websocket-transport';
import {
  cleanupCollaborationRoomAssets, createCollaborationChildRoom, createCollaborationRoom, deleteCollaborationRoom, exportCollaborationRoom,
  getCollaborationRoomStorage, getCollaborationRoomTree, listCollaborationRoomMembers, removeCollaborationRoomMember,
  listCollaborationAccountRooms, openCollaborationAccountRoom, openCollaborationChildRoom, resolveCollaborationRoom, rotateCollaborationRoomInvite,
  type CollaborationAccountRoom, type CollaborationAccountRoomOpen, type CollaborationRoomCredentials, type CollaborationRoomMember,
} from './collaboration-rooms';
import { CollaborationAssetClient } from './collaboration-assets';
import { CollaborationAuthClient, type CollaborationAuthStatus } from './collaboration-auth';
import {
  canUsePrivateNetworkCollaboration, collaborationSecretStore, decodePrivateNetworkInvite, encodePrivateNetworkInvite,
  generatePrivateNetworkServerToken, isUsablePrivateNetworkSecret,
  PRIVATE_NETWORK_SECRET_ID, type CollaborationSecretStore,
} from './collaboration-private-network';
import collaborationServerSource from 'visual-notes-collaboration-server-source';
import {
  CollaborationHostManager, discoverCollaborationHostAddresses,
  type CollaborationHostAddress, type CollaborationHostStatus, type HostedRoomSummary,
} from './collaboration-host';
import { createDesktopCollaborationHostRuntime, desktopNetworkInterfaces } from './collaboration-host-runtime';

export default class VisualNotesPlugin extends Plugin {
  override settings: VisualNotesSettings;
  readonly collaborationTransport = new LoopbackCollaborationTransport();
  private collaborationAuth?: CollaborationAuthClient;
  private collaborationHost?: CollaborationHostManager;

  /**
   * Collaboration needs somewhere safe to keep the server secret, and
   * SecretStorage is the only such place. Where Obsidian is too old to
   * provide it the feature stays switched off rather than falling back to a
   * plaintext store -- see collaborationSecretStore().
   */
  supportsCollaboration(): boolean {
    return !!collaborationSecretStore(this.app);
  }

  private requireSecretStore(): CollaborationSecretStore {
    const store = collaborationSecretStore(this.app);
    if (!store) throw new Error('Collaboration needs Obsidian 1.11.4 or newer, which stores the server secret securely.');
    return store;
  }

  /** The stored secret, or undefined. Never throws -- see usesWebSocketCollaboration. */
  private privateNetworkSecret(): string | undefined {
    return collaborationSecretStore(this.app)?.getSecret(PRIVATE_NETWORK_SECRET_ID)?.trim() || undefined;
  }

  hasPrivateNetworkServerSecret(): boolean {
    return isUsablePrivateNetworkSecret(this.privateNetworkSecret());
  }

  generatePrivateNetworkServerSecret(): void {
    this.requireSecretStore().setSecret(PRIVATE_NETWORK_SECRET_ID, generatePrivateNetworkServerToken());
  }

  privateNetworkHostStatus(): CollaborationHostStatus {
    return this.collaborationHost?.status() ?? { state: 'stopped' };
  }

  privateNetworkHostAddresses(): Promise<CollaborationHostAddress[]> {
    if (!Platform.isDesktopApp) return Promise.resolve([]);
    return Promise.resolve(discoverCollaborationHostAddresses(desktopNetworkInterfaces()));
  }

  async startPrivateNetworkHost(address: CollaborationHostAddress): Promise<CollaborationHostStatus> {
    if (!Platform.isDesktopApp) throw new Error('Hosting is available on desktop. Mobile devices can join private rooms.');
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Automatic hosting requires a local desktop vault.');
    const secrets = this.requireSecretStore();
    let token = secrets.getSecret(PRIVATE_NETWORK_SECRET_ID)?.trim();
    if (!token) {
      token = generatePrivateNetworkServerToken();
      secrets.setSecret(PRIVATE_NETWORK_SECRET_ID, token);
    }
    const port = this.settings.collaborationPrivateNetworkPort ?? 8787;
    this.settings.collaborationPrivateNetworkHostAddress = address.address;
    this.settings.collaborationPrivateNetworkUrl = `ws://${address.address.includes(':') ? `[${address.address}]` : address.address}:${port}`;
    this.settings.collaborationTransport = 'private-network';
    // Records that the user wants this device hosting, so relaunching Obsidian
    // brings the room back. Cleared only by stopHosting(), never by onunload:
    // quitting is not the same as deciding to stop.
    this.settings.collaborationPrivateNetworkHosting = true;
    await this.saveSettings();
    // Vault-relative: both live inside the vault, so the runtime creates and
    // writes them through Obsidian's adapter rather than node:fs, and resolves
    // them to absolute paths only where the server process itself needs them.
    const pluginDirectory = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const dataDirectory = `${this.app.vault.configDir}/visual-notes-collaboration`;
    this.collaborationHost ??= new CollaborationHostManager(
      collaborationServerSource, createDesktopCollaborationHostRuntime(this.app),
    );
    return this.collaborationHost.start({
      address, port, token,
      runtimeDirectory: `${pluginDirectory}/.collaboration-runtime`,
      dataDirectory,
    });
  }

  /** Shuts the server down without touching the user's intent to host. */
  async stopPrivateNetworkHost(): Promise<void> { await this.collaborationHost?.stop(); }

  /** Rooms this device is hosting right now, for recovering access to one. */
  listHostedRooms(): Promise<HostedRoomSummary[]> {
    const api = this.collaborationHost?.serverApi();
    if (!api) throw new Error('Start hosting to see the rooms stored on this device.');
    return api.listHostedCollaborationRooms();
  }

  /**
   * Re-issues owner access for a room this device hosts. Only possible from
   * the hosting machine, which is the point: the server secret cannot gate
   * this because every invitation contains one.
   */
  async claimHostedRoom(roomId: string): Promise<CollaborationRoomCredentials> {
    const api = this.collaborationHost?.serverApi();
    if (!api) throw new Error('Start hosting before reopening a room stored on this device.');
    const granted = await api.claimHostedRoomOwnership(roomId, this.currentCollaborationIdentity());
    return { roomId, accessToken: granted.accessToken, role: granted.role };
  }

  /** The user chose to stop. Do not bring it back on the next launch. */
  async stopPrivateNetworkHostingForGood(): Promise<void> {
    this.settings.collaborationPrivateNetworkHosting = false;
    await this.saveSettings();
    await this.stopPrivateNetworkHost();
  }

  /**
   * Brings hosting back when Obsidian reopens, so a host's own room is
   * reachable again without a trip to settings.
   *
   * It waits, because a plugin loads within a second or two of Obsidian
   * starting and a virtual network usually does not: Tailscale and the like
   * bring their interface up shortly afterwards, so the recorded address is
   * routinely missing on the first look and present a few seconds later.
   * Giving up on that first look is why the first version of this appeared to
   * do nothing at all.
   *
   * And it reports failure. Staying quiet was the wrong instinct -- the user
   * explicitly asked this device to host, so hosting not coming back is
   * something they need told, not something to leave them to infer from a
   * board that will not connect.
   */
  private async resumePrivateNetworkHost(): Promise<void> {
    if (!this.settings.collaborationPrivateNetworkHosting) return;
    if (!Platform.isDesktopApp || !this.supportsCollaboration()) return;
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    const wanted = this.settings.collaborationPrivateNetworkHostAddress;
    if (!wanted) return;
    try {
      const address = await this.awaitHostAddress(wanted);
      if (!address) {
        new Notice(
          `Visual Notes could not resume hosting: the network address ${wanted} is not available on this device. `
          + 'If your VPN or LAN connects later, start hosting again from Settings → Visual Notes.',
          12_000,
        );
        return;
      }
      const status = await this.startPrivateNetworkHost(address);
      if (status.state === 'running') {
        new Notice(`Visual Notes is hosting your collaboration room again on ${address.address}:${status.port}.`);
      } else {
        new Notice(`Visual Notes could not resume hosting: ${status.error ?? 'the host did not start.'}`, 12_000);
      }
    } catch (error) {
      console.error('Visual Notes: could not resume collaboration hosting', error);
      new Notice(
        `Visual Notes could not resume hosting: ${error instanceof Error ? error.message : 'unknown error'}`,
        12_000,
      );
    }
  }

  /** Polls for the recorded interface while a VPN or LAN finishes coming up. */
  private async awaitHostAddress(wanted: string): Promise<CollaborationHostAddress | undefined> {
    for (let attempt = 0; attempt < HOST_RESUME_ATTEMPTS; attempt++) {
      const addresses = await this.privateNetworkHostAddresses();
      const address = addresses.find(candidate => candidate.address === wanted);
      if (address) return address;
      await new Promise(resolve => window.setTimeout(resolve, HOST_RESUME_RETRY_MS));
    }
    return undefined;
  }

  usesWebSocketCollaboration(): boolean {
    // The single runtime choke point. Opening a board builds the collaboration
    // options eagerly, so anything this lets through must actually work --
    // when it said yes without a stored secret, collaborationServiceToken()
    // threw and took the whole board open down with it. That stranded every
    // mobile device the moment the toggle was switched on, because mobile
    // cannot host and so has no secret until it accepts an invitation.
    if (!this.supportsCollaboration()) return false;
    if (this.settings.collaborationTransport === 'private-network') {
      return canUsePrivateNetworkCollaboration(
        this.privateNetworkSecret(), this.collaborationServerUrl(),
      );
    }
    if (this.settings.collaborationTransport !== 'websocket') return false;
    return isSafeCollaborationServerUrl(this.collaborationServerUrl());
  }

  getCollaborationTransport(room?: CollaborationRoomCredentials): CollaborationTransport {
    if (!this.usesWebSocketCollaboration()) return this.collaborationTransport;
    const url = this.collaborationServerUrl();
    return new WebSocketCollaborationTransport({
      url,
      token: this.collaborationServiceToken(),
      inviteCode: room?.inviteCode,
      accessToken: room?.accessToken,
      compatibility: {
        pluginVersion: this.manifest.version,
        obsidianVersion: apiVersion,
        supportedBoardVersions: [2, 3],
      },
    });
  }

  createCollaborationRoom(board: VisualNotesFile, label?: string): Promise<CollaborationRoomCredentials> {
    const url = this.collaborationServerUrl();
    const identity = ensureCollaborationIdentity(
      this.settings, undefined, window.localStorage, this.app.vault.getName()
    ).identity;
    return createCollaborationRoom(
      url, this.collaborationServiceToken(), board, identity, label
    );
  }

  async resolveCollaborationRoom(inviteCode: string): Promise<CollaborationRoomCredentials> {
    const privateInvite = decodePrivateNetworkInvite(inviteCode);
    if (privateInvite) {
      if (this.settings.collaborationTransport !== 'private-network') {
        throw new Error('This is a private-network invitation. Select Private network as the collaboration transport first.');
      }
      this.settings.collaborationPrivateNetworkUrl = privateInvite.serverUrl;
      this.requireSecretStore().setSecret(PRIVATE_NETWORK_SECRET_ID, privateInvite.serverToken);
      await this.saveSettings();
      inviteCode = privateInvite.inviteCode;
    }
    const url = this.collaborationServerUrl();
    const identity = ensureCollaborationIdentity(
      this.settings, undefined, window.localStorage, this.app.vault.getName()
    ).identity;
    return resolveCollaborationRoom(
      url, this.collaborationServiceToken(), inviteCode, identity
    );
  }

  formatCollaborationInvite(inviteCode: string): string {
    if (this.settings.collaborationTransport !== 'private-network') return inviteCode;
    return encodePrivateNetworkInvite(
      this.collaborationServerUrl(), this.privateNetworkServerToken(), inviteCode,
    );
  }

  listCollaborationAccountRooms(): Promise<CollaborationAccountRoom[]> {
    return listCollaborationAccountRooms(this.collaborationServerUrl(), this.collaborationServiceToken());
  }

  openCollaborationAccountRoom(roomId: string): Promise<CollaborationAccountRoomOpen> {
    return openCollaborationAccountRoom(
      this.collaborationServerUrl(), this.collaborationServiceToken(), roomId, this.currentCollaborationIdentity(),
    );
  }

  createCollaborationChildRoom(parent: CollaborationRoomCredentials, childKey: string, board: VisualNotesFile) {
    return createCollaborationChildRoom(
      this.collaborationServerUrl(), this.collaborationServiceToken(), parent, childKey, board,
      this.currentCollaborationIdentity(),
    );
  }

  openCollaborationChildRoom(parent: CollaborationRoomCredentials, childRoomId: string) {
    return openCollaborationChildRoom(
      this.collaborationServerUrl(), this.collaborationServiceToken(), parent, childRoomId,
      this.currentCollaborationIdentity(),
    );
  }

  listCollaborationRoomMembers(room: CollaborationRoomCredentials): Promise<CollaborationRoomMember[]> {
    return listCollaborationRoomMembers(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId,
    );
  }

  rotateCollaborationRoomInvite(room: CollaborationRoomCredentials, role: 'editor' | 'viewer'): Promise<string> {
    return rotateCollaborationRoomInvite(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId, role,
    );
  }

  removeCollaborationRoomMember(room: CollaborationRoomCredentials, memberClientId: string): Promise<void> {
    return removeCollaborationRoomMember(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId, memberClientId,
    );
  }

  getCollaborationRoomStorage(room: CollaborationRoomCredentials) {
    return getCollaborationRoomStorage(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId,
    );
  }

  getCollaborationRoomTree(room: CollaborationRoomCredentials) {
    return getCollaborationRoomTree(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId,
    );
  }

  cleanupCollaborationRoomAssets(room: CollaborationRoomCredentials) {
    return cleanupCollaborationRoomAssets(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId,
    );
  }

  exportCollaborationRoom(room: CollaborationRoomCredentials) {
    return exportCollaborationRoom(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId,
    );
  }

  deleteCollaborationRoom(room: CollaborationRoomCredentials) {
    return deleteCollaborationRoom(
      this.collaborationServerUrl(), this.collaborationServiceToken(), room,
      this.currentCollaborationIdentity().clientId,
    );
  }

  createCollaborationAssetClient() {
    return new CollaborationAssetClient(
      this.app, this.collaborationServerUrl(), this.collaborationServiceToken(), this.currentCollaborationIdentity(),
    );
  }

  private collaborationServerUrl(): string {
    if (this.settings.collaborationTransport === 'private-network') {
      return this.settings.collaborationPrivateNetworkUrl?.trim() || 'ws://127.0.0.1:8787';
    }
    return this.settings.collaborationServerUrl?.trim() || 'ws://127.0.0.1:8787';
  }

  private collaborationServiceToken(): string | (() => Promise<string>) {
    if (this.settings.collaborationTransport === 'private-network') return this.privateNetworkServerToken();
    if (this.settings.collaborationAuthentication === 'oidc') return () => this.collaborationAuthClient().accessToken();
    return this.settings.collaborationDevelopmentToken || 'visual-notes-local-dev';
  }

  private privateNetworkServerToken(): string {
    const token = this.requireSecretStore().getSecret(PRIVATE_NETWORK_SECRET_ID)?.trim();
    if (!isUsablePrivateNetworkSecret(token ?? undefined)) {
      // Reached on a device that has collaboration on but has never obtained
      // the shared secret. Telling a phone to "configure a secret" is useless
      // -- it cannot host, so the only way it ever gets one is an invitation.
      throw new Error(
        'This device does not have the collaboration server secret yet. Join a room using a complete '
        + 'invitation, or start hosting on a desktop device to create one.',
      );
    }
    return token as string;
  }

  collaborationAuthStatus(): CollaborationAuthStatus {
    return this.collaborationAuthClient().status();
  }

  async beginCollaborationSignIn(): Promise<void> {
    const url = await this.collaborationAuthClient().begin({
      issuer: this.settings.collaborationOidcIssuer ?? '',
      clientId: this.settings.collaborationOidcClientId ?? '',
      scope: this.settings.collaborationOidcScope,
      audience: this.settings.collaborationOidcAudience,
    });
    const opened = window.open(url, '_blank');
    if (!opened) throw new Error('Could not open your browser. Allow pop-ups for Obsidian and try again.');
  }

  signOutCollaboration(): void {
    this.collaborationAuthClient().signOut();
  }

  private async completeCollaborationSignIn(params: Record<string, string>): Promise<void> {
    try {
      await this.collaborationAuthClient().complete(params);
      new Notice('Signed in for experimental collaboration.');
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Collaboration sign-in failed.');
    }
  }

  private collaborationAuthClient(): CollaborationAuthClient {
    return this.collaborationAuth ??= new CollaborationAuthClient({
      storage: window.localStorage,
      namespace: this.app.vault.getName(),
    });
  }

  private currentCollaborationIdentity() {
    return ensureCollaborationIdentity(
      this.settings, undefined, window.localStorage, this.app.vault.getName()
    ).identity;
  }

  // Files the user has explicitly chosen to view with Obsidian's native
  // Canvas instead of Visual Notes' own UI for this session — e.g. so a
  // plugin that patches the native Canvas view class (something Visual
  // Notes' separately-drawn UI can never expose a hook for) can work on
  // them. Session-only by design: not persisted to disk, so a restart
  // always goes back to Visual Notes' rich rendering by default.
  private nativeOverrides = new Set<string>();

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.applyCanvasAppearanceSettings();
    // Deliberately not awaited: starting the server writes and loads a bundle,
    // and onload blocks Obsidian's startup.
    void this.resumePrivateNetworkHost();
    // Hosted account sign-in is a dormant foundation, not a shipped feature,
    // so this callback has no reachable caller. Registering it anyway would
    // leave any web page able to drive obsidian://visual-notes-auth into the
    // plugin; the guard keeps the handler unregistered until the hosted path
    // is actually switched on.
    if (hostedCollaborationSignInEnabled(this.settings)) {
      this.registerObsidianProtocolHandler('visual-notes-auth', params => {
        void this.completeCollaborationSignIn(params);
      });
    }

    // Register the view
    this.registerView(
      VISUAL_NOTES_VIEW_TYPE,
      (leaf) => new VisualNotesView(leaf, this)
    );

    // .canvas is NOT registered the same way — Obsidian's core Canvas
    // plugin already owns that extension, and a second registerExtensions
    // call for it would conflict. Instead, Visual Notes lets native Canvas
    // stay the default and reactively takes over the leaf at runtime for
    // any .canvas file that carries Visual Notes' own marker (see
    // isVisualNotesOwnedFile in file-io.ts / canvas-format.ts). Plain native
    // canvases — anything without that marker — are left alone entirely.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && file.extension === 'canvas') void this.maybeTakeOverCanvasLeaf(file);
      })
    );

    // Ribbon — opens (or focuses) the default board. Right-click for more
    // options: left-click alone gave no way to create an *additional*
    // board once one already existed (the ribbon would just refocus the
    // one you had), and the only command for it lived in the command
    // palette where it was easy to miss.
    const ribbonEl = this.addRibbonIcon('layout-grid', 'Visual Notes', () => {
      void this.openDefaultBoard();
    });
    ribbonEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem(item =>
        item.setTitle('Open default board').setIcon('layout-grid').onClick(() => {
          void this.openDefaultBoard();
        })
      );
      menu.addItem(item =>
        item.setTitle('Create new board…').setIcon('plus').onClick(() => {
          new CreateBoardModal(this.app, this, (file) => { void this.openBoardFile(file); }).open();
        })
      );
      menu.addItem(item =>
        item.setTitle('New board from template…').setIcon('layout-template').onClick(() => {
          this.openTemplatePicker((file) => { void this.openBoardFile(file); });
        })
      );
      menu.showAtMouseEvent(e);
    });

    // File explorer: right-clicking a folder gets a "New Visual Notes board"
    // entry too, matching how Obsidian's own "New canvas" works — and the
    // new board is created directly inside that folder.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem(item =>
          item.setTitle('New Visual Notes board').setIcon('layout-grid').onClick(() => {
            new CreateBoardModal(this.app, this, (created) => { void this.openBoardFile(created); }, file).open();
          })
        );
        menu.addItem(item =>
          item.setTitle('New Visual Notes from template…').setIcon('layout-template').onClick(() => {
            this.openTemplatePicker((created) => { void this.openBoardFile(created); }, file);
          })
        );
      })
    );

    // Command: open default board
    this.addCommand({
      id: 'open',
      name: 'Open',
      callback: () => { void this.openDefaultBoard(); },
    });

    // Command: pull in any web clips not already on the board. Exists partly
    // as recovery: clips made while Obsidian was closed never fire a vault
    // event we could act on, and a sync can deliver a batch at any moment.
    // Safe to run repeatedly — the import skips whatever is already there.
    this.addCommand({
      id: 'import-web-clips',
      name: 'Import web clips now',
      callback: () => { void this.importWebClips({ silent: false }); },
    });

    // Command: create a new board
    this.addCommand({
      id: 'create-board',
      name: 'Create new board',
      callback: () => {
        new CreateBoardModal(this.app, this, (file) => {
          void this.openBoardFile(file);
        }).open();
      },
    });

    // Command: create a new board from a template
    this.addCommand({
      id: 'new-board-from-template',
      name: 'New board from template',
      callback: () => {
        this.openTemplatePicker((file) => { void this.openBoardFile(file); });
      },
    });

    // Command: relink all board assets
    this.addCommand({
      id: 'relink-board-assets',
      name: 'Relink all board assets',
      callback: async () => {
        const n = await relinkAllBoards(this.app);
        new Notice(n > 0
          ? `Visual Notes: Fixed ${n} broken link${n === 1 ? '' : 's'} across all boards.`
          : 'Visual Notes: No broken links found.');
      },
    });

    // Command: toggle between Visual Notes' rich view and Obsidian's native
    // Canvas view for the currently open board. Useful when another plugin
    // (e.g. one that patches the native Canvas view class) needs to act on
    // the file — that only works while native Canvas is actually rendering
    // it, which Visual Notes' own UI otherwise pre-empts.
    this.addCommand({
      id: 'toggle-native-canvas-view',
      name: 'Toggle native Canvas view for this file',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(FileView);
        const file = view?.file;
        if (!file || file.extension !== 'canvas') return false;
        if (!checking) void this.toggleNativeView(view);
        return true;
      },
    });

    // Command: save the current board as a template — was previously only
    // reachable via a dedicated header button (removed: it was one of the
    // least-used actions taking up permanent header space); now also in
    // the toolbar's "…" overflow menu.
    this.addCommand({
      id: 'save-board-as-template',
      name: 'Save current board as template',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(VisualNotesView);
        const file = view?.file;
        if (!file) return false;
        if (!checking) promptSaveBoardAsTemplate(this.app, file);
        return true;
      },
    });

    // Settings tab
    this.addSettingTab(new VisualNotesSettingsTab(this.app, this));

    // Run migration + startup open + a one-time sweep of already-open
    // .canvas leaves (from a restored workspace layout) after the
    // workspace is ready. The file-open event above only fires going
    // forward, so leaves that were already open when Obsidian launched
    // need this separate pass.
    this.app.workspace.onLayoutReady(async () => {
      await this.runMigrationIfNeeded();
      await this.sweepOpenCanvasLeaves();

      // Catch up on clips that arrived while Obsidian wasn't running, which
      // no vault event will ever report. Only safe because the import skips
      // paths already on the board — without that, this would re-add every
      // clip ever made, every launch.
      if (this.settings.clipAutoImport !== false) await this.importWebClips({ silent: true });

      // Only now start listening. Registered here rather than in onload
      // because vault load emits 'create' for every existing file, so an
      // earlier registration would queue the entire clippings folder on
      // every launch — the reconcile above already covers that ground, once,
      // deliberately.
      this.applyExplorerTintSetting();
      // A canvas can stop being one of ours (or become one) through an edit
      // made anywhere — including Obsidian's own Canvas view rewriting it —
      // so what we knew about a path is dropped whenever it changes.
      this.registerEvent(this.app.vault.on('modify', (file) => { this.explorerDecorator?.forget(file); }));
      this.registerEvent(this.app.vault.on('rename', (file) => { this.explorerDecorator?.forget(file); }));
      this.registerEvent(this.app.vault.on('delete', (file) => { this.explorerDecorator?.forget(file); }));

      this.registerEvent(this.app.vault.on('create', (file) => { this.queueClip(file); }));
      // 'rename' as well as 'create': sync and other tools frequently *move*
      // a note into the folder rather than creating it there, and a create
      // listener alone never sees those at all.
      this.registerEvent(this.app.vault.on('rename', (file) => { this.queueClip(file); }));

      if (this.settings.openOnStartup) {
        await this.openDefaultBoard();
      }
    });
  }

  // ── File-explorer tint ───────────────────────────────────────

  private explorerDecorator: ExplorerDecorator | null = null;

  /** Starts or stops the explorer tint to match the current setting. */
  applyExplorerTintSetting(): void {
    const wanted = this.settings.explorerBoardTint !== false;
    if (wanted) {
      this.explorerDecorator ??= new ExplorerDecorator(this.app);
      this.explorerDecorator.start();
    } else {
      this.explorerDecorator?.stop();
    }
  }

  override onunload(): void {
    void this.stopPrivateNetworkHost();
    // Removes the class from every row it added it to, so disabling the
    // plugin leaves the explorer exactly as Obsidian drew it.
    this.explorerDecorator?.stop();

    // A debounced clip import must not fire against a plugin that has been
    // disabled. Nothing is lost by dropping it: the queue only holds paths,
    // and the startup reconcile picks up anything missed the next time the
    // plugin loads. That is the same idempotence the whole feature rests on.
    this.clipQueue?.cancel();
    this.clipPending.clear();
  }

  // ── Web clips ────────────────────────────────────────────────

  // Paths waiting to be imported, drained by clipQueue. A set because the
  // same note can raise several events (create then rename) before the queue
  // fires, and because a batch of clips should cost one board write.
  private clipPending = new Set<string>();
  private clipQueue: SaveQueue | null = null;

  /** Queues a vault event's file for import, if it looks like a clip. */
  private queueClip(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (!shouldQueueClip(file.path, file.extension, this.settings)) return;
    this.clipPending.add(file.path);
    // Reuses the board save queue rather than a second debouncer: it already
    // coalesces a burst into one run and refuses to start a second run while
    // one is in flight, which is exactly what a batch of clips needs.
    this.clipQueue ??= new SaveQueue(
      () => this.drainClipQueue(),
      (err) => { console.error('Visual Notes: failed to import web clips', err); },
      CLIP_IMPORT_DEBOUNCE_MS,
    );
    this.clipQueue.schedule();
  }

  /** Imports everything queued since the last run, as a single batch. */
  private async drainClipQueue(): Promise<void> {
    const paths = [...this.clipPending];
    this.clipPending.clear();
    if (paths.length === 0) return;
    const result = await addClipsToBoard(
      this.app, this.settings.clipBoardPath, paths,
      (boardPath, add) => this.addToOpenBoard(boardPath, add),
    );
    // silent: true only suppresses "nothing to do" — an actual import still
    // announces itself, which is the whole point of it being automatic.
    announceClipImport(result, true);
  }

  /**
   * Adds every clip in the configured folder that isn't already on the
   * configured board.
   *
   * `silent` suppresses the "nothing to do" message so the startup pass is
   * quiet on a normal launch, while the manual command always says what it
   * did — a command that appears to do nothing reads as broken.
   */
  async importWebClips(opts: { silent: boolean }): Promise<void> {
    const { clipFolder, clipBoardPath } = this.settings;
    if (!clipFolder || !clipBoardPath) {
      announceClipImport(
        { added: 0, alreadyPresent: 0, refusal: 'No clippings folder and board are set yet. Choose them in Visual Notes settings.' },
        opts.silent,
      );
      return;
    }
    if (!clipFolderExists(this.app, clipFolder)) {
      announceClipImport(
        { added: 0, alreadyPresent: 0, refusal: `The clippings folder ("${clipFolder}") doesn't exist.` },
        opts.silent,
      );
      return;
    }
    const paths = listClipFiles(this.app, clipFolder).map(f => f.path);
    const result = await addClipsToBoard(
      this.app, clipBoardPath, paths,
      (boardPath, add) => this.addToOpenBoard(boardPath, add),
    );
    announceClipImport(result, opts.silent);
  }

  /**
   * Adds cards to a board that is open in one or more views, or returns null
   * if none is showing it.
   *
   * The ordering here is the whole point. Flush every open view first, so no
   * unsaved edit is lost; then reload the one we're about to mutate, so its
   * in-memory board includes what the others just wrote — skip that and its
   * save would quietly undo them. The rest are reloaded afterwards so they
   * show the new cards instead of holding a board that is now stale.
   */
  private async addToOpenBoard(
    boardPath: string,
    add: (board: VisualNotesFile) => Card[],
  ): Promise<number | null> {
    const views = this.app.workspace.getLeavesOfType(VISUAL_NOTES_VIEW_TYPE)
      .map(leaf => leaf.view)
      .filter((v): v is VisualNotesView => v instanceof VisualNotesView && v.isShowingBoard(boardPath));
    if (views.length === 0) return null;

    for (const v of views) await v.flushPendingSave();
    const [canonical, ...rest] = views;
    await canonical.reloadFromDisk();
    const added = await canonical.addCardsLive(add);
    // null means this view can't take them (a grid board). Reporting null
    // upward sends the caller down the on-disk path, which reads the board
    // and refuses with a reason rather than failing silently here.
    if (added === null) return null;
    for (const v of rest) await v.reloadFromDisk();
    return added;
  }

  async loadSettings(): Promise<void> {
    // No assertion needed: loadData() is typed `unknown`, and intersecting
    // that with DEFAULT_SETTINGS' type already yields VisualNotesSettings.
    // Normalised because data.json is just a file on disk: hand-edited,
    // synced across devices, or written by an older version. A bad value used
    // to survive load and fail much later at a render site instead.
    const loaded: unknown = await this.loadData();
    const hadDormantHostedCredentials = hasDormantHostedCollaborationSettings(loaded);
    const legacyPrivateNetworkToken = legacyPrivateNetworkSecret(loaded);
    const secrets = collaborationSecretStore(this.app);
    if (legacyPrivateNetworkToken && secrets && !secrets.getSecret(PRIVATE_NETWORK_SECRET_ID)) {
      secrets.setSecret(PRIVATE_NETWORK_SECRET_ID, legacyPrivateNetworkToken);
    }
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, loaded));
    // OAuth access/refresh tokens live in localStorage rather than data.json.
    // Hosted sign-in is dormant, so clear both completed and pending sessions
    // on every load to leave no hidden account credential behind.
    purgeDormantCollaborationAuthStorage(window.localStorage);
    const identity = ensureCollaborationIdentity(this.settings, undefined, window.localStorage, this.app.vault.getName());
    if (identity.changed || hadDormantHostedCredentials) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Applies the dot-grid color/size and canvas background color as CSS
  // custom properties on the whole app body — every open (and future)
  // board's canvas reads these via var(--visual-notes-dot-color, ...), etc. with
  // inheritance, so setting them here updates every open board live in one
  // shot — no need to reach into each board's individual FreeformRenderer
  // instance.
  applyCanvasAppearanceSettings(): void {
    if (this.settings.dotColor) document.body.style.setProperty('--visual-notes-dot-color', this.settings.dotColor);
    else document.body.style.removeProperty('--visual-notes-dot-color');

    if (this.settings.dotSize !== undefined) document.body.style.setProperty('--visual-notes-dot-radius', `${this.settings.dotSize}px`);
    else document.body.style.removeProperty('--visual-notes-dot-radius');

    if (this.settings.canvasBgColor) document.body.style.setProperty('--visual-notes-canvas-bg', this.settings.canvasBgColor);
    else document.body.style.removeProperty('--visual-notes-canvas-bg');

    document.body.style.setProperty('--visual-notes-trash-zone-size', `${this.settings.trashZoneSize ?? 56}px`);

    // Unitless multiplier every card-content font-size is written against —
    // see the "Text scale" block in styles.css. Deliberately does not reach
    // the plugin's own UI chrome, which stays at its authored px sizes.
    document.body.style.setProperty('--visual-notes-text-scale', String(this.settings.textScale ?? 1));
  }

  // ── Canvas leaf takeover ─────────────────────────────────────

  async toggleNativeView(view: FileView): Promise<void> {
    const file = view.file;
    if (!file || file.extension !== 'canvas') return;
    const leaf = view.leaf;

    if (view.getViewType() === VISUAL_NOTES_VIEW_TYPE) {
      // Visual Notes → native: remember this choice for the session so the
      // file-open takeover hook doesn't immediately swap it back.
      //
      // Native Canvas rebuilds a file from its own model whenever it saves,
      // and that model has no room for root-level extra keys — so as soon as
      // anything writes over there, this board's layout, viewport, free
      // drawings and archive are gone. Snapshot it first and say so plainly,
      // rather than letting a one-line notice imply the trip is free.
      const backed = await backupBeforeNativeEdit(this.app, file);
      this.nativeOverrides.add(file.path);
      await leaf.setViewState({ type: NATIVE_CANVAS_VIEW_TYPE, state: { file: file.path } });
      new Notice(
        'Opened with Obsidian\'s native Canvas view. Editing here drops board metadata Visual Notes ' +
        'needs — free drawings and archived cards especially. ' +
        (backed ? `A backup was saved as "${file.name}${NATIVE_BAK_SUFFIX}".` : 'No backup could be saved.'),
        12000
      );
      return;
    }

    // Native → Visual Notes: only makes sense for files Visual Notes actually
    // authored (has its `vn` marker) — anything else, there's no rich card
    // data to render.
    if (!(await isVisualNotesOwnedFile(this.app, file))) {
      new Notice('This canvas wasn\'t created by Visual Notes — nothing to switch to.');
      return;
    }
    this.nativeOverrides.delete(file.path);
    await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
  }

  private async maybeTakeOverCanvasLeaf(file: TFile): Promise<void> {
    if (this.nativeOverrides.has(file.path)) return;
    if (!(await isVisualNotesOwnedFile(this.app, file))) return;
    const leaves = this.app.workspace.getLeavesOfType(NATIVE_CANVAS_VIEW_TYPE);
    const leaf = leaves.find(l => (l.view as { file?: TAbstractFile }).file?.path === file.path);
    if (!leaf) return;
    await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
  }

  private async sweepOpenCanvasLeaves(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(NATIVE_CANVAS_VIEW_TYPE)) {
      const file = (leaf.view as { file?: TAbstractFile }).file;
      if (!(file instanceof TFile) || this.nativeOverrides.has(file.path)) continue;
      if (await isVisualNotesOwnedFile(this.app, file)) {
        await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
      }
    }
  }

  // ── Board opening ─────────────────────────────────────────────

  async openDefaultBoard(): Promise<void> {
    const { workspace } = this.app;

    // If a board leaf is already visible AND actually has a file loaded,
    // just focus it. A leaf can exist with no file (e.g. after a workspace
    // restore whose saved file no longer exists) — that's the "No board is
    // open" empty state, not a real board, so it must NOT short-circuit
    // here; otherwise clicking the ribbon just reveals a dead empty view
    // forever instead of ever reaching the create/open flow below.
    const existing = workspace.getLeavesOfType(VISUAL_NOTES_VIEW_TYPE);
    const existingWithFile = existing.find(l => (l.view as { file?: TFile }).file instanceof TFile);
    if (existingWithFile) {
      void workspace.revealLeaf(existingWithFile);
      return;
    }

    // Try the stored default board path
    if (this.settings.defaultBoardPath) {
      const file = this.app.vault.getAbstractFileByPath(this.settings.defaultBoardPath);
      if (file instanceof TFile) {
        // Reuse an existing empty leaf instead of opening a new tab, if one's there.
        if (existing.length > 0) {
          await existing[0].setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
          void workspace.revealLeaf(existing[0]);
          return;
        }
        await this.openBoardFile(file);
        return;
      }
      // Path is stale — clear it
      this.settings.defaultBoardPath = undefined;
      await this.saveSettings();
    }

    // No default board — prompt to create one
    new CreateBoardModal(this.app, this, (file) => {
      this.settings.defaultBoardPath = file.path;
      void this.saveSettings().then(() => this.openBoardFile(file));
    }).open();
  }

  // Shared by every "new board from template" entry point (ribbon menu,
  // folder context menu, command palette, and the empty-state screen in
  // view.ts) — each just supplies its own onCreated (open in a new tab vs.
  // reuse the current empty leaf) and an optional target folder.
  //
  // The picker lists the vault's own _Templates/ files plus any bundled
  // starter templates not yet installed. Starters are install-on-pick:
  // nothing is written to the vault until the user explicitly chooses one,
  // at which point the template file is added to _Templates/ (so it's theirs
  // to edit or delete from then on) and a fresh board is spawned from it.
  openTemplatePicker(onCreated: (file: TFile) => void, folder: TFolder | null = null): void {
    const vaultTemplates = listTemplates(this.app);
    const installedNames = new Set(vaultTemplates.map(f => f.basename));

    const choices: TemplateChoice[] = vaultTemplates.map(f => ({
      label: f.basename,
      onPick: () => { void (async () => {
        const file = await createBoardFileFromTemplate(this.app, f, folder);
        onCreated(file);
      })(); },
    }));

    for (const starter of STARTER_TEMPLATES) {
      if (installedNames.has(starter.name)) continue;
      choices.push({
        label: `${starter.name} — starter`,
        onPick: () => { void (async () => {
          const templateFile = await installStarterTemplate(this.app, starter.name, starter.json);
          new Notice(`Visual Notes: Added starter template to ${TEMPLATES_FOLDER}/${starter.name}.canvas — edit it there to make it your own.`);
          const file = await createBoardFileFromTemplate(this.app, templateFile, folder);
          onCreated(file);
        })(); },
      });
    }

    new TemplatePickerModal(this.app, choices).open();
  }

  async openBoardFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab');
    // Force Visual Notes' view type directly rather than leaf.openFile(),
    // since for .canvas files that would resolve via extension to
    // Obsidian's native Canvas view (which Visual Notes no longer claims).
    await leaf.setViewState({ type: VISUAL_NOTES_VIEW_TYPE, state: { file: file.path } });
    void this.app.workspace.revealLeaf(leaf);
  }

  // ── Migration ─────────────────────────────────────────────────

  private async runMigrationIfNeeded(): Promise<void> {
    if (!needsMigration(this.settings)) return;

    try {
      const homeFile = await migrateV1toV2(this.app, this);
      // Immediately open the migrated home board
      await this.openBoardFile(homeFile);
    } catch (e) {
      console.error('Visual Notes: migration failed', e);
      new Notice('Visual Notes: Migration failed — your v1 tiles are still in plugin settings. Please report this issue.', 10000);
    }
  }
}

const DORMANT_HOSTED_COLLABORATION_KEYS = [
  'collaborationServerUrl', 'collaborationDevelopmentToken', 'collaborationAuthentication',
  'collaborationOidcIssuer', 'collaborationOidcClientId', 'collaborationOidcScope', 'collaborationOidcAudience',
  'collaborationPrivateNetworkToken',
] as const;

/**
 * True only while the dormant hosted/OIDC path is switched on, which
 * normalizeSettings() currently makes impossible -- it forces every
 * collaborating install onto 'private-network'. Reading the setting rather
 * than hard-coding false means re-enabling the hosted path is one honest
 * change in settings-validate.ts, not a hunt for scattered `false`s.
 */
function hostedCollaborationSignInEnabled(settings: VisualNotesSettings): boolean {
  return settings.collaborationTransport === 'websocket'
    && settings.collaborationAuthentication === 'oidc';
}

function hasDormantHostedCollaborationSettings(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return DORMANT_HOSTED_COLLABORATION_KEYS.some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function purgeDormantCollaborationAuthStorage(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith('visual-notes:collaboration-auth:')) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

function legacyPrivateNetworkSecret(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const token: unknown = (value as Record<string, unknown>).collaborationPrivateNetworkToken;
  return typeof token === 'string' && token.trim().length >= 24 ? token.trim() : undefined;
}
