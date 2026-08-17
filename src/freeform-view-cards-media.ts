import {
  TFile, TFolder, Notice, setIcon,
  MarkdownRenderer, requestUrl, sanitizeHTMLToDom,
} from 'obsidian';
import {
  ImageCard, AudioCard, VideoCard, BookmarkCard,
  MapCard,
  TILE_DRAG_MIME,
} from './file-types';
import {
  parseYouTubeId,
  isGoogleMapsUrl, isGoogleMapsShortLink, googleMapsEmbedSrc,
} from './thumbnail-utils';
import { TextFormatToolbar } from './text-format-toolbar';
import { snap } from './canvas/snap';
import { sortAssetFile, saveNewAsset } from './asset-manager';
import {
  IMAGE_DEFAULT_W, IMAGE_DEFAULT_H, IMAGE_MIN_H,
  BOOKMARK_DEFAULT_W, BOOKMARK_DEFAULT_H, AUDIO_DEFAULT_W, AUDIO_DEFAULT_H,
  VIDEO_DEFAULT_W, VIDEO_DEFAULT_H, VIDEO_MAX_H, VIDEO_MIN_W, VIDEO_MIN_H, formatVideoTime,
  MAP_DEFAULT_W, MAP_DEFAULT_H,
  AUDIO_EXTS,
  VIDEO_EXTS,
  IMAGE_EXTS,
  AppWithPrivateAPIs,
  VaultImagePickerModal, VaultAudioPickerModal, VaultVideoPickerModal,
  MediaSourceModal, BookmarkInputModal, KanbanItemUrlModal, isValidURL, openExternalUrl, safeRemoteImageSrc,
} from './freeform-view-shared';
import type { FreeformRenderer } from './freeform-view';

/**
 * A dropped video's own extension, kept rather than guessed at.
 *
 * handleDroppedAudio picks from a hardcoded list of three, so anything that
 * isn't .mp3 or .ogg is saved as .wav whatever it really was. That is survivable
 * for audio because the player sniffs the content anyway, but it makes the
 * vault untidy, and there is no reason to repeat it here. Falls back to mp4
 * only when the name carries no recognisable video extension at all.
 */
function safeVideoFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const base = name.replace(/\.[^.]+$/, '') || 'video';
  return VIDEO_EXTS.includes(ext) ? `${base}.${ext}` : `${base}.mp4`;
}

declare module './freeform-view' {
  interface FreeformRenderer {
    renderImageContent(el: HTMLElement, card: ImageCard): void;
    renderAudioContent(el: HTMLElement, card: AudioCard): void;
    renderVideoContent(el: HTMLElement, card: VideoCard): void;
    showVideoFallback(el: HTMLElement, card: VideoCard, vf: TFile | null): void;
    addVideo(): void;
    addVideoAt(x: number, y: number): void;
    handleDroppedVideo(file: File, x: number, y: number): Promise<void>;
    renderBookmarkContent(el: HTMLElement, card: BookmarkCard): void;
    renderMapContent(el: HTMLElement, card: MapCard): void;
    resolveMapShortLink(card: MapCard, el: HTMLElement): Promise<void>;
    createMapCard(x: number, y: number, url: string): void;
    runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>;
    fetchAndUpdateBookmark(card: BookmarkCard, el: HTMLElement): Promise<void>;
    openImageSource(card: ImageCard): void;
    addImage(): void;
    addImageAt(x: number, y: number): void;
    addAudio(): void;
    addAudioAt(x: number, y: number): void;
    addBookmark(): void;
    addBookmarkAt(x: number, y: number, url?: string): void;
    addMapAt(x: number, y: number, url?: string): void;
    createBookmarkCard(x: number, y: number, url: string): void;
    measureImageH(fileOrSrc: File | string): Promise<number>;
    ensureFolder(path: string): Promise<void>;
    handlePastedImage(file: File): Promise<void>;
    handleDroppedImage(file: File, x: number, y: number): Promise<void>;
    isDropAccepted(e: DragEvent): boolean;
    handleDroppedAudio(file: File, x: number, y: number): Promise<void>;
  }
}

export const cardsMediaMethods = {
  renderImageContent(this: FreeformRenderer, el: HTMLElement, card: ImageCard): void {
    el.addClass('visual-notes-freeform-image-card');

    const wrap = el.createDiv('visual-notes-image-wrap');
    const img = wrap.createEl('img', { cls: 'visual-notes-image-img' });

    if (card.source.type === 'vault') {
      const vf = this.app.vault.getAbstractFileByPath(card.source.path);
      if (vf instanceof TFile) {
        img.src = this.app.vault.getResourcePath(vf);
      } else if (card.source.sharedAsset && this.collaborationConfig?.room && this.collaborationConfig.assetClient) {
        wrap.addClass('visual-notes-image-missing');
        const label = wrap.createDiv({ cls: 'visual-notes-image-missing-label', text: 'Loading shared image…' });
        void this.collaborationConfig.assetClient.ensureUrl(this.collaborationConfig.room, card.source.sharedAsset)
          .then(url => { label.remove(); wrap.removeClass('visual-notes-image-missing'); img.src = url; })
          .catch(() => { label.setText('Shared image unavailable'); img.remove(); });
      } else {
        wrap.addClass('visual-notes-image-missing');
        wrap.createDiv({ cls: 'visual-notes-image-missing-label', text: 'Image not found' });
        img.remove();
      }
    } else {
      // A URL out of the file, so it gets the same http(s) check a typed one
      // does rather than being handed straight to the element.
      const remote = safeRemoteImageSrc(card.source.url);
      if (remote) {
        img.src = remote;
      } else {
        wrap.addClass('visual-notes-image-missing');
        wrap.createDiv({ cls: 'visual-notes-image-missing-label', text: 'Image not found' });
        img.remove();
      }
    }

    img.addEventListener('error', () => {
      img.remove(); wrap.addClass('visual-notes-image-missing');
      wrap.createDiv({ cls: 'visual-notes-image-missing-label', text: 'Failed to load' });
    });

    // wrap's own background is a visible placeholder while loading (and
    // stays for the missing/failed states above) — but a successfully
    // loaded image needs it cleared, otherwise it shows solid through any
    // transparent (alpha) areas of a PNG instead of true transparency.
    const clearPlaceholderBg = () => wrap.addClass('is-loaded');
    img.addEventListener('load', clearPlaceholderBg);
    if (img.complete) clearPlaceholderBg();

    const fixAspect = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const correctH = Math.max(IMAGE_MIN_H, snap((card.w ?? IMAGE_DEFAULT_W) * img.naturalHeight / img.naturalWidth));
        if (correctH !== card.h) {
          card.h = correctH;
          el.style.height = `${correctH}px`;
          this.scheduleSave();
        }
      }
    };
    img.addEventListener('load', fixAspect);
    if (img.complete) fixAspect();

    // Caption — render/edit two-state with TextFormatToolbar
    const captionWrap = el.createDiv('visual-notes-image-caption-wrap');
    if (card.captionHidden) captionWrap.addClass('is-hidden');

    const captionViewEl = captionWrap.createDiv('visual-notes-image-caption-view');
    if (card.captionScale) captionViewEl.addClass(`text-scale-${card.captionScale}`);
    if (card.captionColor) captionViewEl.style.color = card.captionColor;
    const renderCaptionView = () => {
      captionViewEl.empty();
      if (card.caption) {
        void MarkdownRenderer.render(this.app, card.caption, captionViewEl, '', this);
      } else {
        captionViewEl.createSpan({ cls: 'visual-notes-caption-placeholder', text: 'Add caption…' });
      }
    };
    renderCaptionView();

    const captionEditor = captionWrap.createDiv('visual-notes-image-caption-editor') as HTMLElement;
    captionEditor.contentEditable = 'true';
    captionEditor.hide();
    captionEditor.addEventListener('pointerdown', e => e.stopPropagation());

    let captionFmtToolbar: TextFormatToolbar | null = null;

    const enterCaptionEdit = () => {
      captionViewEl.hide();
      captionEditor.show();
      captionEditor.empty();
      if (card.caption) captionEditor.appendChild(sanitizeHTMLToDom(captionViewEl.innerHTML));
      captionEditor.focus();
      const r = activeDocument.createRange();
      r.selectNodeContents(captionEditor); r.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges(); s?.addRange(r);
      captionFmtToolbar = new TextFormatToolbar(captionEditor, captionWrap, this.container);
    };

    const exitCaptionEdit = () => {
      captionFmtToolbar?.destroy(); captionFmtToolbar = null;
      card.caption = captionEditor.innerHTML;
      captionEditor.hide();
      captionViewEl.show();
      renderCaptionView();
      this.scheduleSave();
    };

    captionViewEl.addEventListener('click', (e) => { e.stopPropagation(); enterCaptionEdit(); });
    captionViewEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    captionEditor.addEventListener('blur', exitCaptionEdit);
    captionEditor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        captionFmtToolbar?.destroy(); captionFmtToolbar = null;
        captionEditor.removeEventListener('blur', exitCaptionEdit);
        captionEditor.hide();
        captionViewEl.show();
        renderCaptionView();
      }
    });

    this.appendResizeHandles(el);
  },

  renderAudioContent(this: FreeformRenderer, el: HTMLElement, card: AudioCard): void {
    el.addClass('visual-notes-freeform-audio-card');
    const header = el.createDiv('visual-notes-audio-header');
    const iconEl = header.createDiv('visual-notes-audio-icon');
    setIcon(iconEl, 'music');
    const name = card.title ?? card.source.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Audio';
    header.createDiv({ cls: 'visual-notes-audio-title', text: name });
    const vf = this.app.vault.getAbstractFileByPath(card.source.path);
    if (vf instanceof TFile) {
      const audio = el.createEl('audio');
      audio.src = this.app.vault.getResourcePath(vf);
      audio.controls = true;
      audio.addClass('visual-notes-audio-player');
      audio.addEventListener('pointerdown', (e) => e.stopPropagation());
      audio.addEventListener('click', (e) => e.stopPropagation());
    } else {
      el.createDiv({ cls: 'visual-notes-audio-missing', text: 'File not found' });
    }
    this.appendResizeHandles(el);
  },

  // Chrome-free, like an image card: the picture is the point on a moodboard,
  // and a filename header would cost ~35px of every card. The name is still
  // reachable from the context menu and the card's tooltip.
  renderVideoContent(this: FreeformRenderer, el: HTMLElement, card: VideoCard): void {
    el.addClass('visual-notes-freeform-video-card');
    const vf = this.app.vault.getAbstractFileByPath(card.source.path);
    const localFile = vf instanceof TFile ? vf : null;
    const assetClient = this.collaborationConfig?.assetClient;
    const room = this.collaborationConfig?.room;
    const videoSrc = localFile ? this.app.vault.getResourcePath(localFile) : assetClient?.cachedStreamUrl(card.source.sharedAsset);
    if (!videoSrc) {
      if (assetClient && room && card.source.sharedAsset?.mimeType.startsWith('video/')) {
        const loading = el.createDiv({ cls: 'visual-notes-video-missing', text: 'Loading shared video…' });
        void assetClient.ensureStreamUrl(room, card.source.sharedAsset)
          .then(() => { if (el.isConnected) this.renderCardContent(el, card); })
          .catch(error => {
            console.error('Visual Notes: could not authorize shared video playback', error);
            loading.setText('Shared video unavailable');
          });
      } else {
        el.createDiv({ cls: 'visual-notes-video-missing', text: 'File not found' });
      }
      this.appendResizeHandles(el); return;
    }

    const video = el.createEl('video');
    video.src = videoSrc;
    // Chromium's own controls are deliberately NOT used. They live in a closed
    // shadow root, so nothing here can ask whether a press landed on them --
    // which is what defeated 1.1.28 (a fixed 40px strip, wrong the moment
    // Chromium split the controls onto two rows on a narrow clip) and then
    // 1.1.29 (no geometry at all, deferring the drag until the pointer moved).
    //
    // 1.1.29 still lost, and the reason names the real problem: it worked with
    // a mouse and failed on a trackpad. A trackpad click carries a few px of
    // travel between press and release, which crosses DRAG_THRESHOLD; the card
    // then takes pointer capture, every remaining event retargets to the card,
    // and the controls never see the release. No threshold can fix that --
    // trackpad jitter has no upper bound, and DRAG_THRESHOLD is shared with the
    // marquee besides.
    //
    // Controls we render ourselves have none of that: they are ordinary
    // elements in this document, so their pointerdown handler stops the canvas
    // from ever starting a drag, at any jitter, at any card size, on any input
    // device. The geometry problem does not exist because there is no geometry
    // to guess.
    video.controls = false;
    // Enough to draw the first frame as a still, and no more: a moodboard can
    // hold dozens of these, and preloading them whole would read the lot off
    // disk to show pictures nobody has asked to play yet.
    video.preload = 'metadata';
    video.addClass('visual-notes-video-player');
    const displayName = localFile?.name ?? card.source.sharedAsset?.name ?? card.source.path.split('/').pop() ?? 'Shared video';
    video.setAttribute('aria-label', displayName.replace(/\.[^.]+$/, ''));
    // Focus must never land here. A focused <video> consumes space and the
    // arrow keys for its own play/seek, which is what made the board's space-
    // to-pan "stop working randomly" -- and those shortcuts were separately
    // gated on the canvas holding focus, so a click on a video killed them
    // both ways. See docKeyDown.
    video.setAttribute('tabindex', '-1');
    el.setAttribute('title', displayName);

    // A press on the video body is still left alone until it moves, so the
    // card drags from its picture as asked. Body click toggles playback, which
    // was the browser's own behaviour under native controls and is kept here
    // now that the controls are ours. A click that ends a real drag is
    // swallowed by the canvas before it arrives (see bindDelegatedCardEvents).
    video.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    // Not prevented, only kept from the canvas, and mapped to the same thing
    // the browser used to do with it.
    video.addEventListener('dblclick', (e) => { e.stopPropagation(); toggleFullscreen(); });

    // ── Controls ────────────────────────────────────────────────────────
    const controls = el.createDiv('visual-notes-video-controls');
    // The whole fix, in one line. Our controls are real elements in this
    // document, so a press on them can be recognised and stopped here before
    // the canvas's delegated card handler ever sees it -- no capture is taken,
    // no drag begins, and a few px of trackpad travel changes nothing.
    controls.addEventListener('pointerdown', (e) => e.stopPropagation());
    controls.addEventListener('click', (e) => e.stopPropagation());
    controls.addEventListener('dblclick', (e) => e.stopPropagation());

    const button = (icon: string, label: string): HTMLElement => {
      const b = controls.createDiv('visual-notes-video-btn');
      b.setAttribute('role', 'button');
      // Not focusable: focus belongs to the canvas, see the video's tabindex
      // above. The controls are reachable by pointer, and the card's own
      // context menu carries the same actions for the keyboard.
      b.setAttribute('tabindex', '-1');
      b.setAttribute('aria-label', label);
      setIcon(b, icon);
      return b;
    };

    const playBtn = button('play', 'Play');
    const scrub = controls.createEl('input', { cls: 'visual-notes-video-scrub' });
    scrub.type = 'range'; scrub.min = '0'; scrub.max = '1000'; scrub.value = '0'; scrub.step = '1';
    scrub.setAttribute('tabindex', '-1');
    scrub.setAttribute('aria-label', 'Seek');
    const timeEl = controls.createDiv({ cls: 'visual-notes-video-time', text: '0:00' });
    const muteBtn = button('volume-2', 'Mute');
    const fsBtn = button('maximize', 'Fullscreen');

    function togglePlay(): void {
      if (video.paused) void video.play().catch(() => { /* error event handles it */ });
      else video.pause();
    }

    function toggleFullscreen(): void {
      const doc = el.doc;
      if (doc.fullscreenElement) { void doc.exitFullscreen().catch(() => { /* nothing useful to do */ }); return; }
      // Native controls are exactly right in fullscreen -- there is no canvas
      // there to fight over the gesture, and they handle the keyboard too.
      video.controls = true;
      void video.requestFullscreen().catch(() => { video.controls = false; });
    }
    // Fires on the element in Chromium, so no document-level listener has to
    // be registered and torn down.
    video.addEventListener('fullscreenchange', () => { video.controls = !!el.doc.fullscreenElement; });

    const syncPlay = (): void => {
      setIcon(playBtn, video.paused ? 'play' : 'pause');
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      el.toggleClass('is-playing', !video.paused);
    };
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPlay);
    video.addEventListener('ended', syncPlay);
    playBtn.addEventListener('click', togglePlay);

    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted;
      setIcon(muteBtn, video.muted ? 'volume-x' : 'volume-2');
      muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    });
    fsBtn.addEventListener('click', toggleFullscreen);

    // Seeking is driven as a permille of duration rather than in seconds, so
    // the slider needs no rescaling when the duration arrives late.
    let scrubbing = false;
    scrub.addEventListener('pointerdown', () => { scrubbing = true; });
    scrub.addEventListener('pointerup', () => { scrubbing = false; });
    scrub.addEventListener('input', () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      video.currentTime = (Number(scrub.value) / 1000) * video.duration;
    });
    video.addEventListener('timeupdate', () => {
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      if (!scrubbing) scrub.value = String(Math.round((video.currentTime / dur) * 1000));
      timeEl.setText(`${formatVideoTime(video.currentTime)} / ${formatVideoTime(dur)}`);
    });

    // mkv and avi generally cannot be decoded by Electron's Chromium, and mov
    // depends on its codec. Rather than a dead black rectangle, offer the one
    // thing that definitely works.
    video.addEventListener('error', () => { this.showVideoFallback(el, card, localFile); });

    // Fit the card to the clip rather than letterboxing it -- a portrait phone
    // video in a 16:9 box is mostly empty. Mirrors what measureImageH does for
    // images, but from metadata we are loading anyway.
    video.addEventListener('loadedmetadata', () => {
      // Duration is known now; showing it here rather than waiting for the
      // first timeupdate means a card that has never been played still reads
      // "0:00 / 1:23" instead of a bare "0:00".
      if (Number.isFinite(video.duration) && video.duration > 0) {
        timeEl.setText(`${formatVideoTime(0)} / ${formatVideoTime(video.duration)}`);
      }
      if (!video.videoWidth || !video.videoHeight) return;
      const cardEl = this.cardEls.get(card.id);

      // A card still at its untouched default size is one nobody has sized
      // yet, so both dimensions are ours to choose: fit the clip inside a box
      // instead of hanging its height off a fixed width. That distinction is
      // what keeps this from fighting the user — anything they have resized
      // takes the aspect-only path below and keeps its width.
      if (card.w === VIDEO_DEFAULT_W && card.h === VIDEO_DEFAULT_H) {
        const scale = Math.min(VIDEO_DEFAULT_W / video.videoWidth, VIDEO_MAX_H / video.videoHeight);
        const w = Math.max(VIDEO_MIN_W, Math.round(video.videoWidth * scale));
        const h = Math.max(VIDEO_MIN_H, Math.round(video.videoHeight * scale));
        if (w === card.w && h === card.h) return; // 16:9 already lands here
        card.w = w; card.h = h;
        if (cardEl) { cardEl.style.width = `${w}px`; cardEl.style.height = `${h}px`; }
        this.scheduleSave();
        return;
      }

      // Resized by hand at some point: keep the width they chose and only
      // correct the height, so the clip is never stretched or letterboxed.
      const w = card.w ?? VIDEO_DEFAULT_W;
      const h = Math.round(w * (video.videoHeight / video.videoWidth));
      if (h < 1 || Math.abs(h - (card.h ?? VIDEO_DEFAULT_H)) < 2) return;
      card.h = h;
      if (cardEl) cardEl.style.height = `${h}px`;
      this.scheduleSave();
    });

    this.appendResizeHandles(el);
  },

  /** Replaces an unplayable video with something that can still be acted on. */
  showVideoFallback(this: FreeformRenderer, el: HTMLElement, card: VideoCard, vf: TFile | null): void {
    el.empty();
    el.addClass('is-unplayable');
    const wrap = el.createDiv('visual-notes-video-fallback');
    const iconEl = wrap.createDiv('visual-notes-video-fallback-icon');
    setIcon(iconEl, 'file-video');
    const name = vf?.name ?? card.source.sharedAsset?.name ?? card.source.path.split('/').pop() ?? 'Shared video';
    wrap.createDiv({ cls: 'visual-notes-video-fallback-name', text: name });
    wrap.createDiv({
      cls: 'visual-notes-video-fallback-msg',
      text: 'Obsidian can’t play this format on the canvas.',
    });
    if (vf) {
      const btn = wrap.createDiv({ cls: 'visual-notes-video-fallback-btn', text: 'Open externally' });
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.workspace.getLeaf('tab').openFile(vf).catch(() => {
          new Notice(`Could not open ${vf.name}.`);
        });
      });
    }
    this.appendResizeHandles(el);
  },

  renderBookmarkContent(this: FreeformRenderer, el: HTMLElement, card: BookmarkCard): void {
    el.addClass('visual-notes-freeform-bookmark-card');

    const youTubeId = parseYouTubeId(card.url);
    if (youTubeId) {
      el.addClass('is-youtube-embed');
      // Optional header strip — a fixed drag handle regardless of whether
      // the body overlay below is currently passing clicks through to the
      // iframe. Hidden by default (bare 16:9 video look); toggled via the
      // card's right-click menu.
      if (card.youtubeHeaderShown) {
        const header = el.createDiv('visual-notes-bookmark-youtube-header');
        const iconEl = header.createDiv('visual-notes-bookmark-youtube-icon');
        setIcon(iconEl, 'play');
        header.createDiv({ cls: 'visual-notes-bookmark-youtube-title', text: card.title || 'YouTube' });
      }

      // A live iframe swallows every pointer event over it (it's a separate
      // browsing context), so the card underneath would never see a drag
      // start. `body` wraps the iframe with an invisible overlay on top of
      // it — the overlay is a normal element, so pointerdown on it bubbles
      // to the card's own drag handler exactly like clicking anywhere else
      // on the card ("draggable via the main body"), and the wheel keeps
      // zooming the canvas rather than disappearing into the player.
      //
      // The overlay therefore STAYS on top for good, and a plain click on it
      // drives play/pause through the iframe API instead of punching
      // through. Letting the click punch through instead would mean the card
      // could no longer be dragged from its body and the canvas could no
      // longer be zoomed over the video — and it would still cost two clicks
      // to pause after touching anything else, since the punch-through had
      // to be re-done every time. Reaching YouTube's own controls (seek,
      // volume, fullscreen) is a deliberate extra step via the button below.
      const body = el.createDiv('visual-notes-bookmark-youtube-body');
      const iframe = body.createEl('iframe', { cls: 'visual-notes-bookmark-youtube-iframe' });
      // enablejsapi is what makes the postMessage commands below work at all
      // — both the play/pause commands we send and the state updates the
      // player sends back.
      iframe.src = `https://www.youtube.com/embed/${youTubeId}?enablejsapi=1`;
      iframe.setAttribute('title', card.title || 'YouTube video player');
      iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('frameborder', '0');
      watchYouTubeState(iframe);

      const overlay = body.createDiv('visual-notes-bookmark-youtube-overlay');
      overlay.setAttribute('title', 'Click to play or pause. Drag to move.');
      // The play/pause trigger deliberately does NOT live on the overlay.
      // The card's own pointerdown handler calls setPointerCapture() on the
      // card element to drive dragging, and pointer capture retargets the
      // rest of that gesture — the compatibility `click` included — at the
      // capturing element, so a listener here never fires for a plain click.
      // It only ever fired with Shift held, because that path returns before
      // capture is taken; that was the whole reason Shift-click was once the
      // only way to start playback. The card's own pointerup calls
      // toggleYouTubePlayback() instead, where the drag/no-drag distinction
      // is already known.

      // Escape hatch to YouTube's own UI. A real <button> on purpose: the
      // card's delegated pointerdown handler returns early for BUTTON
      // targets, so this is exempt from both the drag path and the
      // play/pause toggle without needing its own guards.
      const controlsBtn = overlay.createEl('button', { cls: 'visual-notes-bookmark-youtube-controls-btn' });
      controlsBtn.setAttribute('title', 'Use YouTube\'s own controls (seek, volume, fullscreen)');
      controlsBtn.setAttribute('aria-label', 'Use YouTube\'s own controls');
      setIcon(controlsBtn, 'settings-2');
      controlsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activateYouTubeEmbed(el);
      });

      this.appendResizeHandles(el);
      return;
    }

    if (card.fetchFailed) {
      const fail = el.createDiv('visual-notes-bookmark-fail');
      fail.createDiv({ cls: 'visual-notes-bookmark-fail-url', text: card.url });
      const retry = fail.createEl('button', { cls: 'visual-notes-bookmark-retry', text: 'Retry' });
      retry.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        card.fetchFailed = false;
        this.renderCardContent(el, card);
        void this.fetchAndUpdateBookmark(card, el);
      });
    } else if (!card.title && !card.fetchedAt) {
      const loading = el.createDiv('visual-notes-bookmark-loading');
      const spinnerEl = loading.createDiv('visual-notes-bookmark-spinner');
      setIcon(spinnerEl, 'loader');
      loading.createDiv({ cls: 'visual-notes-bookmark-loading-text', text: 'Fetching preview…' });
      try { el.createDiv({ cls: 'visual-notes-bookmark-domain', text: new URL(card.url).hostname }); } catch { /* ignore */ }
    } else {
      // imageUrl and favicon are both scraped out of a remote page, so they
      // are the least trusted strings on the card — checked before they
      // reach an element rather than after.
      const previewSrc = safeRemoteImageSrc(card.imageUrl);
      if (previewSrc) {
        const imgWrap = el.createDiv('visual-notes-bookmark-image-wrap');
        const img = imgWrap.createEl('img', { cls: 'visual-notes-bookmark-img' });
        img.src = previewSrc;
        img.addEventListener('error', () => imgWrap.remove());
      }
      const content = el.createDiv('visual-notes-bookmark-content');
      if (card.title) content.createDiv({ cls: 'visual-notes-bookmark-title', text: card.title });
      if (card.description) content.createDiv({ cls: 'visual-notes-bookmark-desc', text: card.description });

      const footer = el.createDiv('visual-notes-bookmark-footer');
      const faviconSrc = safeRemoteImageSrc(card.favicon);
      if (faviconSrc) {
        const fav = footer.createEl('img', { cls: 'visual-notes-bookmark-favicon' });
        fav.src = faviconSrc; fav.addEventListener('error', () => fav.remove());
      }
      try { footer.createDiv({ cls: 'visual-notes-bookmark-domain', text: new URL(card.url).hostname }); } catch { /* ignore */ }
    }

    this.appendResizeHandles(el);
  },

  renderMapContent(this: FreeformRenderer, el: HTMLElement, card: MapCard): void {
    el.addClass('visual-notes-freeform-map-card');

    const src = googleMapsEmbedSrc(card.resolvedUrl ?? card.url);

    if (!src) {
      // Short links carry no location in the URL — resolve once over HTTP.
      if (isGoogleMapsShortLink(card.url) && !card.resolveFailed) {
        const loading = el.createDiv('visual-notes-map-loading');
        const spinnerEl = loading.createDiv('visual-notes-bookmark-spinner');
        setIcon(spinnerEl, 'loader');
        loading.createDiv({ cls: 'visual-notes-bookmark-loading-text', text: 'Resolving map link…' });
        void this.resolveMapShortLink(card, el);
      } else {
        const fail = el.createDiv('visual-notes-map-fail');
        setIcon(fail.createDiv('visual-notes-map-fail-icon'), 'map-pin-off');
        fail.createDiv({ cls: 'visual-notes-bookmark-fail-url', text: card.url });
        fail.createDiv({ cls: 'visual-notes-bookmark-loading-text', text: 'Couldn’t read a location from this link.' });
        const retry = fail.createEl('button', { cls: 'visual-notes-bookmark-retry', text: 'Retry' });
        retry.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          card.resolveFailed = false; card.resolvedUrl = undefined;
          this.renderCardContent(el, card);
        });
      }
      this.appendResizeHandles(el);
      return;
    }

    // The map is fully live — scroll to zoom, drag to pan, click markers —
    // with no punch-through step. That means the iframe (a separate
    // browsing context) swallows every pointer event over it, so unlike
    // every other card kind, the card itself can't be dragged by its body.
    // A permanent header strip above the map is the drag handle instead:
    // it's a plain sibling element, so its pointerdown bubbles up to the
    // card's own drag handler exactly like any other card's body would.
    const header = el.createDiv('visual-notes-map-header');
    setIcon(header.createDiv('visual-notes-map-header-icon'), 'map-pin');
    header.createDiv({ cls: 'visual-notes-map-header-title', text: 'Google Maps' });
    header.setAttribute('title', 'Drag here to move. The map below is fully interactive.');

    const body = el.createDiv('visual-notes-map-body');
    const iframe = body.createEl('iframe', { cls: 'visual-notes-map-iframe' });
    iframe.src = src;
    iframe.setAttribute('title', 'Google Maps');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');

    this.appendResizeHandles(el);
  },

  async resolveMapShortLink(this: FreeformRenderer, card: MapCard, el: HTMLElement): Promise<void> {
    let resolved: string | null = null;
    try {
      // Guarded because this fires on open, unprompted, against whatever URL
      // the file happens to hold — see fetchAndUpdateBookmark.
      if (!isValidURL(card.url)) throw new Error('not a web URL');
      const resp = await requestUrl({ url: card.url });
      const html = resp.text;
      const m = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/)
        ?? html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)
        ?? html.match(/https:\/\/www\.google\.com\/maps\/place\/[^"'\s<>\\]+/);
      if (m) resolved = (m[1] ?? m[0]).replace(/&amp;/g, '&');
    } catch { /* fall through to failed state */ }

    if (resolved && googleMapsEmbedSrc(resolved)) {
      card.resolvedUrl = resolved;
      card.resolveFailed = false;
    } else {
      card.resolveFailed = true;
    }
    if (el.isConnected) {
      this.renderCardContent(el, card);
      await this.saveNow();
    }
  },

  createMapCard(this: FreeformRenderer, x: number, y: number, url: string): void {
    const card: MapCard = { id: crypto.randomUUID(), kind: 'map', x, y, w: MAP_DEFAULT_W, h: MAP_DEFAULT_H, z: this.nextZ(), url };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  async runWithConcurrency<T>(this: FreeformRenderer, items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  },

  async fetchAndUpdateBookmark(this: FreeformRenderer, card: BookmarkCard, el: HTMLElement): Promise<void> {
    if (parseYouTubeId(card.url)) {
      // YouTube gets a clean thumbnail-and-play-button card (matching native
      // Canvas's own embed look) derived straight from the video ID — no
      // metadata fetch needed, so there's nothing to do here at all.
      card.fetchedAt = Date.now(); card.fetchFailed = false;
      if (el.isConnected) { this.renderCardContent(el, card); await this.saveNow(); }
      return;
    }
    // Opening a board fires this automatically for every stale bookmark on
    // it, so the URL being fetched is one the *file* chose, not one the user
    // just typed. Restricting it to http(s) keeps a shared board from
    // pointing the fetch at some other scheme and having the response read
    // back into the card's title and description.
    if (!isValidURL(card.url)) {
      card.fetchFailed = true; card.fetchedAt = Date.now();
      if (el.isConnected) { this.renderCardContent(el, card); await this.saveNow(); }
      return;
    }
    try {
      const resp = await requestUrl({ url: card.url });
      const doc = new DOMParser().parseFromString(resp.text, 'text/html');
      const getMeta = (sel: string) => doc.querySelector(sel)?.getAttribute('content') ?? undefined;

      card.title = getMeta('meta[property="og:title"]') || getMeta('meta[name="twitter:title"]') || doc.title || undefined;
      card.description = getMeta('meta[property="og:description"]') || getMeta('meta[name="description"]') || undefined;

      const ogImg = getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]');
      if (ogImg) { try { card.imageUrl = new URL(ogImg, card.url).href; } catch { card.imageUrl = ogImg; } }

      const origin = new URL(card.url).origin;
      const favEl = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      const favHref = favEl?.getAttribute('href');
      if (favHref) { try { card.favicon = new URL(favHref, card.url).href; } catch { card.favicon = `${origin}/favicon.ico`; } }
      else { card.favicon = `${origin}/favicon.ico`; }

      card.fetchedAt = Date.now(); card.fetchFailed = false;
    } catch {
      card.fetchFailed = true; card.fetchedAt = Date.now();
    }

    if (el.isConnected) {
      this.renderCardContent(el, card);
      await this.saveNow();
    }
  },

  openImageSource(this: FreeformRenderer, card: ImageCard): void {
    if (card.source.type === 'vault') {
      const file = this.app.vault.getAbstractFileByPath(card.source.path);
      if (file instanceof TFile) {
        const leaf = this.app.workspace.getLeaf('tab');
        void leaf.openFile(file); void this.app.workspace.revealLeaf(leaf);
      }
    } else {
      openExternalUrl(card.source.url);
    }
  },

  addImage(this: FreeformRenderer): void { const p = this.centerPos(IMAGE_DEFAULT_W, IMAGE_DEFAULT_H); this.addImageAt(p.x, p.y); },

  addImageAt(this: FreeformRenderer, x: number, y: number): void {
    const createCard = (source: ImageCard['source'], h: number) => {
      const card: ImageCard = { id: crypto.randomUUID(), kind: 'image', x, y, w: IMAGE_DEFAULT_W, h, z: this.nextZ(), source, captionHidden: true };
      this.pushUndo(); this.board.cards.push(card); void this.saveNow();
      this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
    };
    const fromVault = () => new VaultImagePickerModal(this.app, (f) => { void (async () => {
      const newPath = await sortAssetFile(this.app, f);
      const newFile = this.app.vault.getAbstractFileByPath(newPath);
      if (!(newFile instanceof TFile)) return;
      const h = await this.measureImageH(this.app.vault.getResourcePath(newFile));
      createCard({ type: 'vault', path: newPath }, h);
    })(); }).open();
    const fromUpload = () => {
      const input = createEl('input');
      input.type = 'file'; input.accept = IMAGE_EXTS.map(e => `.${e}`).join(',');
      input.addEventListener('change', () => { void (async () => {
        const file = input.files?.[0]; if (!file) return;
        const ext = file.type.includes('png') ? 'png' : file.type.includes('gif') ? 'gif' : file.type.includes('webp') ? 'webp' : 'jpg';
        const base = file.name.replace(/\.[^.]+$/, '');
        let path: string;
        try { path = await saveNewAsset(this.app, await file.arrayBuffer(), `${base}.${ext}`); }
        catch { new Notice(`Failed to save ${file.name}.`); return; }
        const h = await this.measureImageH(file);
        createCard({ type: 'vault', path }, h);
      })(); });
      input.click();
    };
    const fromUrl = () => new KanbanItemUrlModal(this.app, '', (url) => { void (async () => {
      if (!url) return;
      if (!isValidURL(url)) { new Notice('Please enter a valid https:// URL.'); return; }
      // The card is hot-linked: nothing is downloaded into the vault, the
      // image loads from the web each time the board renders (same as
      // pasting an image URL, or the external images in the templates).
      const h = await this.measureImageH(url);
      createCard({ type: 'external', url }, h);
    })(); }, 'Image URL').open();
    new MediaSourceModal(this.app, 'Add image', fromVault, fromUpload, fromUrl).open();
  },

  addAudio(this: FreeformRenderer): void { const p = this.centerPos(AUDIO_DEFAULT_W, AUDIO_DEFAULT_H); this.addAudioAt(p.x, p.y); },

  addAudioAt(this: FreeformRenderer, x: number, y: number): void {
    const createCard = (path: string) => {
      const card: AudioCard = { id: crypto.randomUUID(), kind: 'audio', x, y, w: AUDIO_DEFAULT_W, h: AUDIO_DEFAULT_H, z: this.nextZ(), source: { type: 'vault', path } };
      this.pushUndo(); this.board.cards.push(card); void this.saveNow();
      this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
    };
    const fromVault = () => new VaultAudioPickerModal(this.app, (f) => { void (async () => {
      const newPath = await sortAssetFile(this.app, f);
      createCard(newPath);
    })(); }).open();
    const fromUpload = () => {
      const input = createEl('input');
      input.type = 'file'; input.accept = AUDIO_EXTS.map(e => `.${e}`).join(',');
      input.addEventListener('change', () => { void (async () => {
        const file = input.files?.[0]; if (!file) return;
        const ext = file.name.toLowerCase().endsWith('.mp3') ? 'mp3' : file.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'wav';
        const base = file.name.replace(/\.[^.]+$/, '');
        let path: string;
        try { path = await saveNewAsset(this.app, await file.arrayBuffer(), `${base}.${ext}`); }
        catch { new Notice(`Failed to save ${file.name}.`); return; }
        createCard(path);
      })(); });
      input.click();
    };
    new MediaSourceModal(this.app, 'Add audio', fromVault, fromUpload).open();
  },

  addVideo(this: FreeformRenderer): void { const p = this.centerPos(VIDEO_DEFAULT_W, VIDEO_DEFAULT_H); this.addVideoAt(p.x, p.y); },

  addVideoAt(this: FreeformRenderer, x: number, y: number): void {
    const createCard = (path: string) => {
      const card: VideoCard = { id: crypto.randomUUID(), kind: 'video', x, y, w: VIDEO_DEFAULT_W, h: VIDEO_DEFAULT_H, z: this.nextZ(), source: { type: 'vault', path } };
      this.pushUndo(); this.board.cards.push(card); void this.saveNow();
      this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
    };
    const fromVault = () => new VaultVideoPickerModal(this.app, (f) => { void (async () => {
      const newPath = await sortAssetFile(this.app, f);
      createCard(newPath);
    })(); }).open();
    const fromUpload = () => {
      const input = createEl('input');
      input.type = 'file'; input.accept = VIDEO_EXTS.map(e => `.${e}`).join(',');
      input.addEventListener('change', () => { void (async () => {
        const file = input.files?.[0]; if (!file) return;
        let path: string;
        try { path = await saveNewAsset(this.app, await file.arrayBuffer(), safeVideoFilename(file.name)); }
        catch { new Notice(`Failed to save ${file.name}.`); return; }
        createCard(path);
      })(); });
      input.click();
    };
    new MediaSourceModal(this.app, 'Add video', fromVault, fromUpload).open();
  },

  async handleDroppedVideo(this: FreeformRenderer, file: File, x: number, y: number): Promise<void> {
    let path: string;
    try { path = await saveNewAsset(this.app, await file.arrayBuffer(), safeVideoFilename(file.name)); }
    catch { new Notice(`Failed to save ${file.name}.`); return; }
    const card: VideoCard = { id: crypto.randomUUID(), kind: 'video', x, y, w: VIDEO_DEFAULT_W, h: VIDEO_DEFAULT_H, z: this.nextZ(), source: { type: 'vault', path } };
    this.pushUndo(); this.board.cards.push(card); await this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  addBookmark(this: FreeformRenderer): void { const p = this.centerPos(BOOKMARK_DEFAULT_W, BOOKMARK_DEFAULT_H); this.addBookmarkAt(p.x, p.y); },

  addBookmarkAt(this: FreeformRenderer, x: number, y: number, url?: string): void {
    if (url) { this.createBookmarkCard(x, y, url); return; }
    new BookmarkInputModal(this.app, (u) => this.createBookmarkCard(x, y, u)).open();
  },

  addMapAt(this: FreeformRenderer, x: number, y: number, url?: string): void {
    if (url) { this.createMapCard(x, y, url); return; }
    new BookmarkInputModal(this.app, (u) => {
      if (!isGoogleMapsUrl(u)) { new Notice('That doesn’t look like a Google Maps link.'); return; }
      this.createMapCard(x, y, u);
    }, 'Add map — paste a Google Maps link').open();
  },

  createBookmarkCard(this: FreeformRenderer, x: number, y: number, url: string): void {
    // YouTube embeds open as a bare 16:9 video at watchable size (960×540)
    // rather than the small link-preview footprint other bookmarks get.
    const isYouTube = !!parseYouTubeId(url);
    const w = isYouTube ? 960 : BOOKMARK_DEFAULT_W;
    const h = isYouTube ? Math.round(w * 9 / 16) : BOOKMARK_DEFAULT_H;
    const card: BookmarkCard = { id: crypto.randomUUID(), kind: 'bookmark', x, y, w, h, z: this.nextZ(), url };
    this.pushUndo(); this.board.cards.push(card); void this.saveNow();
    const el = this.createCardEl(card);
    this.selection.select(card.id); this.refreshSelectionVisuals();
    void this.fetchAndUpdateBookmark(card, el);
  },

  measureImageH(this: FreeformRenderer, fileOrSrc: File | string): Promise<number> {
    let src: string;
    let revoke = false;
    if (typeof fileOrSrc !== 'string') {
      src = URL.createObjectURL(fileOrSrc); revoke = true;
    } else { src = fileOrSrc; }
    return new Promise<number>((resolve) => {
      const img = new Image();
      const done = (ok: boolean) => {
        if (revoke) URL.revokeObjectURL(src);
        resolve(ok && img.naturalWidth > 0
          ? Math.max(IMAGE_MIN_H, snap(IMAGE_DEFAULT_W * img.naturalHeight / img.naturalWidth))
          : IMAGE_DEFAULT_H);
      };
      img.onload  = () => done(true);
      img.onerror = () => done(false);
      img.src = src;
    });
  },

  async ensureFolder(this: FreeformRenderer, path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try { await this.app.vault.createFolder(path); } catch { /* ignore */ }
    }
  },

  async handlePastedImage(this: FreeformRenderer, file: File): Promise<void> {
    const ext = file.type.includes('png') ? 'png' : file.type.includes('gif') ? 'gif' : 'jpg';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `Pasted Image ${ts}.${ext}`;
    let path: string;
    try { path = await saveNewAsset(this.app, await file.arrayBuffer(), filename); }
    catch { new Notice('Failed to save pasted image.'); return; }
    const pastedFile = this.app.vault.getAbstractFileByPath(path);
    if (!(pastedFile instanceof TFile)) return;
    const h = await this.measureImageH(this.app.vault.getResourcePath(pastedFile));
    const { x, y } = this.centerPos(IMAGE_DEFAULT_W, h);
    const card: ImageCard = { id: crypto.randomUUID(), kind: 'image', x, y, w: IMAGE_DEFAULT_W, h, z: this.nextZ(), source: { type: 'vault', path }, captionHidden: true };
    this.pushUndo(); this.board.cards.push(card); await this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  async handleDroppedImage(this: FreeformRenderer, file: File, x: number, y: number): Promise<void> {
    const ext = file.type.includes('png') ? 'png' : file.type.includes('gif') ? 'gif' : file.type.includes('webp') ? 'webp' : 'jpg';
    const base = file.name.replace(/\.[^.]+$/, '');
    let path: string;
    try { path = await saveNewAsset(this.app, await file.arrayBuffer(), `${base}.${ext}`); }
    catch { new Notice(`Failed to save ${file.name}.`); return; }
    const h = await this.measureImageH(file);
    const card: ImageCard = { id: crypto.randomUUID(), kind: 'image', x, y, w: IMAGE_DEFAULT_W, h, z: this.nextZ(), source: { type: 'vault', path }, captionHidden: true };
    this.pushUndo(); this.board.cards.push(card); await this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },

  isDropAccepted(this: FreeformRenderer, e: DragEvent): boolean {
    if (e.dataTransfer?.types.includes('Files')) return true;
    if (e.dataTransfer?.types.includes(TILE_DRAG_MIME)) return true;
    const dragMgr = (this.app as AppWithPrivateAPIs).dragManager;
    const draggable = dragMgr?.draggable;
    if (draggable?.type === 'folder' && draggable.file instanceof TFolder) return true;
    if (draggable?.type !== 'file' || !(draggable.file instanceof TFile)) return false;
    const ext = draggable.file.extension.toLowerCase();
    // Every extension the drop handler can actually build a card from has to
    // be listed here too. This gate runs on dragover, and returning false
    // means preventDefault is never called — at which point the browser
    // refuses the drag outright and no drop event is fired at all, so the
    // matching branch in the drop handler is unreachable rather than merely
    // unused. Video was added to the drop handler in 1.1.27 and missed here,
    // which is why a video dragged from the sidebar did nothing while the
    // same file dropped from the OS worked: an OS drag matches the 'Files'
    // check above and never reaches this list.
    return IMAGE_EXTS.includes(ext) || AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)
      || ext === 'canvas' || ext === 'md';
  },

  async handleDroppedAudio(this: FreeformRenderer, file: File, x: number, y: number): Promise<void> {
    const ext = file.name.toLowerCase().endsWith('.mp3') ? 'mp3' : file.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'wav';
    const base = file.name.replace(/\.[^.]+$/, '');
    let path: string;
    try { path = await saveNewAsset(this.app, await file.arrayBuffer(), `${base}.${ext}`); }
    catch { new Notice(`Failed to save ${file.name}.`); return; }
    const card: AudioCard = { id: crypto.randomUUID(), kind: 'audio', x, y, w: AUDIO_DEFAULT_W, h: AUDIO_DEFAULT_H, z: this.nextZ(), source: { type: 'vault', path } };
    this.pushUndo(); this.board.cards.push(card); await this.saveNow();
    this.createCardEl(card); this.selection.select(card.id); this.refreshSelectionVisuals();
  },
};

// ── YouTube embed playback ───────────────────────────────────────────────
//
// The overlay sits on the iframe permanently (see renderBookmarkContent), so
// a click on it can't reach the player directly — it drives playback through
// YouTube's postMessage API instead. To know whether a click means "play" or
// "pause" we track the player's state: `enablejsapi=1` plus a `listening`
// handshake makes the player post its own state changes back to us.
//
// Everything degrades gracefully if that channel never opens (blocked, API
// changed, offline): the optimistic flip in toggleYouTubePlayback still
// alternates play and pause, it just can't self-correct if the two fall out
// of step.

// 1 = playing, 3 = buffering (treated as playing — a click should pause it).
const YT_PLAYING_STATES = new Set([1, 3]);

// The origins a real embedded player posts from. Both are in use: youtube.com
// for the standard embed, youtube-nocookie.com if the URL is ever switched to
// the privacy-preserving host.
const YT_MESSAGE_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
]);

// Keyed by the iframe's contentWindow, which is exactly what arrives as
// `event.source` on the messages coming back. A WeakMap so a removed card's
// entry is collected with its window — no teardown to forget.
const ytPlaybackStates = new WeakMap<Window, { playing: boolean }>();
const ytListenerBoundWindows = new WeakSet<Window>();

function ytStateFor(iframe: HTMLIFrameElement): { playing: boolean } | null {
  const win = iframe.contentWindow;
  if (!win) return null;
  let state = ytPlaybackStates.get(win);
  if (!state) { state = { playing: false }; ytPlaybackStates.set(win, state); }
  return state;
}

/** Subscribes to a YouTube iframe's player-state messages. */
function watchYouTubeState(iframe: HTMLIFrameElement): void {
  // The window hosting the iframe, not the top-level one — a board opened in
  // a popout window receives its own players' messages there.
  const hostWin = iframe.ownerDocument.defaultView;
  if (!hostWin) return;

  if (!ytListenerBoundWindows.has(hostWin)) {
    ytListenerBoundWindows.add(hostWin);
    hostWin.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      // Two independent checks, because either alone has a gap. The origin
      // check alone would accept messages from any YouTube frame on the page;
      // the source check alone would keep trusting a player window that had
      // navigated somewhere else, since the Window object survives that.
      if (!YT_MESSAGE_ORIGINS.has(e.origin)) return;
      const source = e.source as Window | null;
      if (!source) return;
      const state = ytPlaybackStates.get(source);
      if (!state) return; // not one of ours
      let payload: { event?: unknown; info?: unknown };
      try { payload = JSON.parse(e.data) as typeof payload; } catch { return; }
      // The player reports state under two shapes depending on which
      // message it is: onStateChange carries the code directly, while the
      // periodic infoDelivery nests it. Both are worth reading — relying on
      // onStateChange alone misses the state a player was already in.
      const raw = payload.info;
      let playerState: number | null = null;
      if (payload.event === 'onStateChange' && typeof raw === 'number') {
        playerState = raw;
      } else if (raw && typeof raw === 'object' && typeof (raw as { playerState?: unknown }).playerState === 'number') {
        playerState = (raw as { playerState: number }).playerState;
      }
      if (playerState === null) return;
      state.playing = YT_PLAYING_STATES.has(playerState);
    });
  }

  const handshake = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    if (!ytPlaybackStates.has(win)) ytPlaybackStates.set(win, { playing: false });
    win.postMessage(JSON.stringify({ event: 'listening' }), '*');
  };
  // Once now for an iframe that's already up, and again on load — whichever
  // lands second is harmless, and between them the player is always reached.
  iframe.addEventListener('load', handshake);
  handshake();
}

function ytCommand(iframe: HTMLIFrameElement, func: 'playVideo' | 'pauseVideo'): void {
  iframe.contentWindow?.postMessage(
    JSON.stringify({ event: 'command', func, args: [] }), '*'
  );
}

/**
 * Plays or pauses a YouTube card, depending on what the player is currently
 * doing. Called from the card's pointerup handler — see renderBookmarkContent
 * for why this can't be a listener on the overlay itself.
 */
export function toggleYouTubePlayback(el: HTMLElement): void {
  const iframe = el.querySelector<HTMLIFrameElement>('.visual-notes-bookmark-youtube-iframe');
  if (!iframe) return;
  // While the player's own UI is exposed, its controls own play/pause — a
  // click there is going to the player directly, not through us.
  if (el.hasClass('is-embed-interactive')) return;
  const state = ytStateFor(iframe);
  const playing = state?.playing ?? false;
  ytCommand(iframe, playing ? 'pauseVideo' : 'playVideo');
  // Flip immediately rather than waiting for the player to report back, so
  // two quick clicks don't both read the same stale state and send the same
  // command twice. The real state message corrects this if they disagree.
  if (state) state.playing = !playing;
}

/**
 * Hands the card over to YouTube's own UI (seek bar, volume, fullscreen) by
 * making the drag overlay click-through. Clicking anywhere outside the card
 * puts the overlay back, which restores body-dragging and canvas zoom over
 * the video; playback carries on either way.
 */
export function activateYouTubeEmbed(el: HTMLElement): void {
  if (el.hasClass('is-embed-interactive')) return;
  el.addClass('is-embed-interactive');
  const onOutside = (ev: PointerEvent) => {
    if (el.contains(ev.target as Node)) return;
    el.removeClass('is-embed-interactive');
    activeDocument.removeEventListener('pointerdown', onOutside, true);
  };
  // Deferred a tick so the click that triggered this doesn't immediately
  // register as the "outside" press that tears it back down.
  window.setTimeout(() => activeDocument.addEventListener('pointerdown', onOutside, true), 0);
}
