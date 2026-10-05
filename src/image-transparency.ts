/** Detect visible transparency without allocating a full-size copy of a large PNG. */
export function hasTransparentPixels(img: HTMLImageElement): boolean {
  if (!img.naturalWidth || !img.naturalHeight) return false;
  const canvas = createEl('canvas');
  canvas.width = Math.min(img.naturalWidth, 256);
  canvas.height = Math.min(img.naturalHeight, 256);
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 255) return true;
    }
  } catch {
    // Cross-origin images may load but prohibit pixel reads. Keep their frame.
  }
  return false;
}
