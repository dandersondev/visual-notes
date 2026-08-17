import { App, requestUrl, TFile } from 'obsidian';
import type { SharedAssetRef, VisualNotesFile } from './file-types';
import type { CollaborationIdentity } from './collaboration-identity';
import {
  collaborationHttpBase, type CollaborationRoomCredentials, type CollaborationServiceToken,
} from './collaboration-rooms';

const ALLOWED_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm',
]);

type VaultAssetSource = { type: 'vault'; path: string; sharedAsset?: SharedAssetRef };

export interface CollaborationAssetTransfer {
  name: string;
  phase: 'preparing' | 'uploading' | 'failed';
  loaded: number;
  total: number;
  error?: string;
}

export class CollaborationAssetClient {
  private readonly objectUrls = new Map<string, string>();
  private readonly downloads = new Map<string, Promise<string>>();
  private readonly uploaded = new Set<string>();
  private readonly streamUrls = new Map<string, string>();
  private readonly streamRequests = new Map<string, Promise<string>>();
  private readonly transferListeners = new Set<(transfer: CollaborationAssetTransfer | undefined) => void>();
  private activeTransfer?: CollaborationAssetTransfer;
  private activeUpload?: XMLHttpRequest;
  private cancelRequested = false;

  constructor(
    private readonly app: App,
    private readonly websocketUrl: string,
    private readonly serviceToken: CollaborationServiceToken,
    private readonly identity: CollaborationIdentity,
    private readonly xhrFactory: (() => XMLHttpRequest) | null = typeof XMLHttpRequest === 'undefined' ? null : () => new XMLHttpRequest(),
  ) {}

  cachedUrl(asset: SharedAssetRef | undefined): string | undefined {
    return asset ? this.objectUrls.get(asset.hash) : undefined;
  }

  transfer(): CollaborationAssetTransfer | undefined { return this.activeTransfer ? { ...this.activeTransfer } : undefined; }

  subscribeTransfers(listener: (transfer: CollaborationAssetTransfer | undefined) => void): () => void {
    this.transferListeners.add(listener);
    listener(this.transfer());
    return () => this.transferListeners.delete(listener);
  }

  cancelTransfer(): void {
    this.cancelRequested = true;
    if (this.activeUpload) this.activeUpload.abort();
    else if (this.activeTransfer) this.setTransfer({ ...this.activeTransfer, phase: 'failed', error: 'Upload cancelled.' });
  }

  async prepareBoard(board: VisualNotesFile, room: CollaborationRoomCredentials): Promise<boolean> {
    if (room.role === 'viewer') return false;
    this.cancelRequested = false;
    let changed = false;
    for (const source of vaultAssetSources(board)) {
      if (source.sharedAsset) continue;
      const file = this.app.vault.getAbstractFileByPath(source.path);
      if (!(file instanceof TFile)) continue;
      const mimeType = mediaMimeType(file.extension);
      if (!mimeType) continue;
      this.setTransfer({ name: file.name, phase: 'preparing', loaded: 0, total: file.stat?.size ?? 0 });
      const bytes = await this.app.vault.readBinary(file);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if (this.cancelRequested) throw new Error('Upload cancelled.');
      const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const asset = { hash, mimeType, size: bytes.byteLength, name: file.name } satisfies SharedAssetRef;
      if (!this.uploaded.has(hash)) {
        await this.upload(room, asset, bytes);
        this.uploaded.add(hash);
      }
      source.sharedAsset = asset;
      changed = true;
      this.setTransfer(undefined);
    }
    return changed;
  }

  ensureUrl(room: CollaborationRoomCredentials, asset: SharedAssetRef): Promise<string> {
    const cached = this.objectUrls.get(asset.hash);
    if (cached) return Promise.resolve(cached);
    const pending = this.downloads.get(asset.hash);
    if (pending) return pending;
    const promise = this.download(room, asset).finally(() => this.downloads.delete(asset.hash));
    this.downloads.set(asset.hash, promise);
    return promise;
  }

  cachedStreamUrl(asset: SharedAssetRef | undefined): string | undefined {
    return asset ? this.streamUrls.get(asset.hash) : undefined;
  }

  ensureStreamUrl(room: CollaborationRoomCredentials, asset: SharedAssetRef): Promise<string> {
    const cached = this.streamUrls.get(asset.hash);
    if (cached) return Promise.resolve(cached);
    const pending = this.streamRequests.get(asset.hash);
    if (pending) return pending;
    const promise = this.createStreamTicket(room, asset).finally(() => this.streamRequests.delete(asset.hash));
    this.streamRequests.set(asset.hash, promise);
    return promise;
  }

  destroy(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.downloads.clear();
    this.uploaded.clear();
    this.streamUrls.clear();
    this.streamRequests.clear();
    this.activeUpload?.abort();
    this.activeUpload = undefined;
    this.cancelRequested = false;
    this.setTransfer(undefined);
    this.transferListeners.clear();
  }

  private async upload(room: CollaborationRoomCredentials, asset: SharedAssetRef, bytes: ArrayBuffer): Promise<void> {
    if (this.xhrFactory) {
      await this.uploadWithProgress(room, asset, bytes); return;
    }
    const response = await requestUrl({
      url: `${collaborationHttpBase(this.websocketUrl)}/assets/${asset.hash}`,
      method: 'PUT', headers: await this.headers(room, asset), body: bytes, throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(response.text || `Asset upload failed (${response.status}).`);
  }

  private async uploadWithProgress(room: CollaborationRoomCredentials, asset: SharedAssetRef, bytes: ArrayBuffer): Promise<void> {
    const headers = await this.headers(room, asset);
    return new Promise((resolve, reject) => {
      const request = this.xhrFactory!();
      this.activeUpload = request;
      request.open('PUT', `${collaborationHttpBase(this.websocketUrl)}/assets/${asset.hash}`);
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
      this.setTransfer({ name: asset.name ?? 'media', phase: 'uploading', loaded: 0, total: bytes.byteLength });
      request.upload.addEventListener('progress', event => {
        this.setTransfer({
          name: asset.name ?? 'media', phase: 'uploading', loaded: event.loaded,
          total: event.lengthComputable ? event.total : bytes.byteLength,
        });
      });
      const finish = () => { if (this.activeUpload === request) this.activeUpload = undefined; };
      request.addEventListener('load', () => {
        finish();
        if (request.status >= 200 && request.status < 300) { resolve(); return; }
        const message = responseError(request.responseText, `Asset upload failed (${request.status}).`);
        this.setTransfer({ name: asset.name ?? 'media', phase: 'failed', loaded: 0, total: bytes.byteLength, error: message });
        reject(new Error(message));
      });
      request.addEventListener('error', () => {
        finish(); const message = 'The media upload could not reach the collaboration server.';
        this.setTransfer({ name: asset.name ?? 'media', phase: 'failed', loaded: 0, total: bytes.byteLength, error: message });
        reject(new Error(message));
      });
      request.addEventListener('abort', () => {
        finish(); const message = 'Upload cancelled.';
        this.setTransfer({ name: asset.name ?? 'media', phase: 'failed', loaded: 0, total: bytes.byteLength, error: message });
        reject(new Error(message));
      });
      request.send(bytes);
    });
  }

  private async download(room: CollaborationRoomCredentials, asset: SharedAssetRef): Promise<string> {
    const response = await requestUrl({
      url: `${collaborationHttpBase(this.websocketUrl)}/assets/${asset.hash}`,
      method: 'GET', headers: await this.headers(room), throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(response.text || `Asset download failed (${response.status}).`);
    if (response.arrayBuffer.byteLength !== asset.size) throw new Error('Shared image size does not match the board reference.');
    const digest = await crypto.subtle.digest('SHA-256', response.arrayBuffer);
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.hash) throw new Error('Shared image content could not be verified.');
    const url = URL.createObjectURL(new Blob([response.arrayBuffer], { type: asset.mimeType }));
    this.objectUrls.set(asset.hash, url);
    return url;
  }

  private async createStreamTicket(room: CollaborationRoomCredentials, asset: SharedAssetRef): Promise<string> {
    const response = await requestUrl({
      url: `${collaborationHttpBase(this.websocketUrl)}/assets/${asset.hash}/ticket`,
      method: 'POST', headers: await this.headers(room), throw: false,
    });
    const payload = response.json as Record<string, unknown>;
    if (response.status < 200 || response.status >= 300 || typeof payload.ticket !== 'string') {
      throw new Error(typeof payload.error === 'string' ? payload.error : `Video playback authorization failed (${response.status}).`);
    }
    const url = `${collaborationHttpBase(this.websocketUrl)}/assets/${asset.hash}?ticket=${encodeURIComponent(payload.ticket)}`;
    this.streamUrls.set(asset.hash, url);
    return url;
  }

  private async headers(room: CollaborationRoomCredentials, asset?: SharedAssetRef): Promise<Record<string, string>> {
    const token = typeof this.serviceToken === 'string' ? this.serviceToken : await this.serviceToken();
    return {
      authorization: `Bearer ${token}`,
      'x-visual-notes-room': room.roomId,
      'x-visual-notes-client': this.identity.clientId,
      'x-visual-notes-access': room.accessToken,
      ...(asset ? {
        'content-type': asset.mimeType,
        'x-visual-notes-asset-name': encodeURIComponent(asset.name ?? 'image'),
      } : {}),
    };
  }

  private setTransfer(transfer: CollaborationAssetTransfer | undefined): void {
    this.activeTransfer = transfer;
    for (const listener of this.transferListeners) listener(this.transfer());
  }
}

function responseError(text: string, fallback: string): string {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    return typeof payload.error === 'string' ? payload.error : fallback;
  } catch { return text.trim() || fallback; }
}

function vaultAssetSources(board: VisualNotesFile): VaultAssetSource[] {
  const sources: VaultAssetSource[] = [];
  for (const card of board.cards) {
    if (card.kind === 'image' && card.source.type === 'vault') sources.push(card.source);
    if (card.kind === 'image' && card.originalSource?.type === 'vault') sources.push(card.originalSource);
    if (card.kind === 'video') sources.push(card.source);
    if (card.kind === 'storyboard') for (const section of card.sections) for (const shot of section.shots) {
      if (shot.background?.type === 'vault') sources.push(shot.background);
    }
  }
  return sources;
}

function mediaMimeType(extension: string): string | undefined {
  const mime = ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  } as Record<string, string>)[extension.toLowerCase()];
  return mime && ALLOWED_MEDIA_TYPES.has(mime) ? mime : undefined;
}
