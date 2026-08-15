// @vitest-environment jsdom
//
// Issue #31: "I can export a canvas/tile to pdf or to png with many features
// but as soon as I add a link I cant export", with a console error naming
// `img.visual-notes-bookmark-img`.
//
// A bookmark's preview picture, its favicon, a note-link cover and an external
// image card are all remote addresses. html-to-image re-fetches every image
// from inside the renderer to inline it, and a cross-origin one fails on CORS.
// Its failure path is what turns that into a dead export: the fetch error is
// swallowed, `imagePlaceholder || ''` is assigned to the cloned <img>, and an
// empty src fires `error` — at which point `onerror` *is* `reject`, so one
// unreachable picture rejects the entire render with a raw Event.
//
// Obsidian's requestUrl runs outside the renderer where CORS does not apply,
// so the bytes are genuinely reachable and the export can contain the previews
// rather than merely survive them.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestUrl = vi.fn();
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./obsidian-stub');
  return {
    ...actual,
    requestUrl: (...args: unknown[]) => requestUrl(...args),
    arrayBufferToBase64: (buf: ArrayBuffer) =>
      Buffer.from(new Uint8Array(buf)).toString('base64'),
  };
});

const { inlineRemoteImages, EXPORT_IMAGE_TOLERANCE, TRANSPARENT_PX } =
  await import('../src/freeform-view-shared');

function host(...srcs: string[]): HTMLElement {
  const el = document.createElement('div');
  for (const src of srcs) {
    const img = document.createElement('img');
    img.src = src;
    el.appendChild(img);
  }
  document.body.appendChild(el);
  return el;
}

const srcs = (el: HTMLElement) => Array.from(el.querySelectorAll('img')).map(i => i.getAttribute('src') ?? '');

describe('export: remote images cannot break a render', () => {
  beforeEach(() => { requestUrl.mockReset(); document.body.empty(); });

  it('inlines a reachable remote image, so the export actually contains it', async () => {
    requestUrl.mockResolvedValue({
      headers: { 'content-type': 'image/jpeg' },
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
    });
    const el = host('https://example.com/preview.jpg');

    await inlineRemoteImages(el);

    expect(srcs(el)[0]).toBe('data:image/jpeg;base64,AQID');
  });

  it('falls back to a transparent pixel when the fetch fails', async () => {
    // The reported case. A pixel *loads*, and loading is the only thing that
    // decides whether the render survives.
    requestUrl.mockRejectedValue(new Error('CORS'));
    const el = host('https://example.com/blocked.png');

    await inlineRemoteImages(el);

    expect(srcs(el)[0]).toBe(TRANSPARENT_PX);
  });

  it('never leaves an empty src, which is what fired the error', async () => {
    requestUrl.mockRejectedValue(new Error('nope'));
    const el = host('https://a.test/1.png', 'https://b.test/2.png');

    await inlineRemoteImages(el);

    for (const src of srcs(el)) expect(src).not.toBe('');
  });

  it('leaves vault and data images alone', async () => {
    // Only http(s) needs this; app:// resources already load in the renderer,
    // and re-fetching them would be pure cost.
    const el = host('app://local/vault/pic.png', 'data:image/png;base64,AQID');

    await inlineRemoteImages(el);

    expect(requestUrl).not.toHaveBeenCalled();
    expect(srcs(el)).toEqual(['app://local/vault/pic.png', 'data:image/png;base64,AQID']);
  });

  it('restores the original addresses, since it mutates the live board', async () => {
    // html-to-image clones the tree itself, so the swap has to happen on the
    // real element — which means putting it back is not optional.
    requestUrl.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      arrayBuffer: new Uint8Array([9]).buffer,
    });
    const el = host('https://example.com/preview.jpg');

    const restore = await inlineRemoteImages(el);
    expect(srcs(el)[0]).toContain('data:image/png');
    restore();

    expect(srcs(el)[0]).toBe('https://example.com/preview.jpg');
  });

  it('restores even when the fetch failed', async () => {
    requestUrl.mockRejectedValue(new Error('CORS'));
    const el = host('https://example.com/blocked.png');

    (await inlineRemoteImages(el))();

    expect(srcs(el)[0]).toBe('https://example.com/blocked.png');
  });

  it('carries the options that stop html-to-image rejecting on a bad image', async () => {
    // imagePlaceholder replaces the empty src that fires `error`;
    // onImageErrorHandler stops the library using `reject` as its `onerror`.
    // Both, because the first prevents the failure and the second survives it.
    expect(EXPORT_IMAGE_TOLERANCE.imagePlaceholder).toBe(TRANSPARENT_PX);
    expect(typeof EXPORT_IMAGE_TOLERANCE.onImageErrorHandler).toBe('function');
    expect(() => EXPORT_IMAGE_TOLERANCE.onImageErrorHandler()).not.toThrow();
  });
});
