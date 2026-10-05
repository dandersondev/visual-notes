// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTransparentPixels } from '../src/image-transparency';

function imageWithAlpha(alpha: number[], width = alpha.length, height = 1) {
  const pixels = new Uint8ClampedArray(alpha.flatMap(a => [0, 0, 0, a]));
  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels })),
  };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
  const img = {
    naturalWidth: width,
    naturalHeight: height,
  } as unknown as HTMLImageElement;
  vi.stubGlobal('createEl', vi.fn(() => canvas));
  return { img, canvas, ctx };
}

describe('transparent image detection', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('detects alpha pixels and leaves opaque images framed', () => {
    const transparent = imageWithAlpha([255, 100, 255]);
    expect(hasTransparentPixels(transparent.img)).toBe(true);
    const opaque = imageWithAlpha([255, 255]);
    expect(hasTransparentPixels(opaque.img)).toBe(false);
  });

  it('bounds the canvas size for large images', () => {
    const { img, canvas } = imageWithAlpha([255], 4000, 3000);
    hasTransparentPixels(img);
    expect([canvas.width, canvas.height]).toEqual([256, 256]);
  });

  it('keeps a frame when cross-origin pixels cannot be read', () => {
    const { img, ctx } = imageWithAlpha([0]);
    ctx.getImageData.mockImplementation(() => { throw new Error('SecurityError'); });
    expect(hasTransparentPixels(img)).toBe(false);
  });
});
