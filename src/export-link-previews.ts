import { parseYouTubeId } from './thumbnail-utils';
import type { PdfLink } from './pdf-export';
import type { Card } from './file-types';

/** Add capture-only posters without detaching or restarting the live players. */
export function prepareYouTubeExport(root: HTMLElement): () => void {
  const posters: HTMLImageElement[] = [];
  for (const iframe of root.querySelectorAll<HTMLIFrameElement>('.visual-notes-bookmark-youtube-iframe')) {
    const id = parseYouTubeId(iframe.src);
    const parent = iframe.parentElement;
    if (!id || !parent) continue;
    const img = parent.createEl('img', { cls: 'visual-notes-export-youtube-thumbnail' });
    img.src = `https://img.youtube.com/vi/${encodeURIComponent(id)}/maxresdefault.jpg`;
    img.alt = 'YouTube video';
    img.setCssStyles({
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      objectFit: 'contain', background: '#000',
    });
    posters.push(img);
  }
  return () => { for (const poster of posters) poster.remove(); };
}

/** Some videos lack the larger posters; try progressively smaller sources. */
export function exportImageSources(img: HTMLImageElement): string[] {
  if (!img.classList.contains('visual-notes-export-youtube-thumbnail')) return [img.src];
  return ['maxresdefault', 'hq720', 'sddefault', 'hqdefault', 'mqdefault']
    .map(size => img.src.replace(/maxresdefault\.jpg$/, `${size}.jpg`));
}

export function measureExportScale(root: HTMLElement, zoom: number) {
  const bounds = root.getBoundingClientRect();
  // The board's stored zoom excludes ancestor CSS zoom/transforms (for
  // example display scaling). Measure the actual screen-to-board scale.
  const probe = root.createDiv();
  probe.setCssStyles({ position: 'absolute', left: '0', top: '0', width: '100px', height: '100px', visibility: 'hidden', pointerEvents: 'none' });
  const probeRect = probe.getBoundingClientRect();
  probe.remove();
  const scaleX = probeRect.width / 100 || zoom;
  const scaleY = probeRect.height / 100 || zoom;
  return { bounds, scaleX, scaleY };
}

/** Measure rendered cards so nested bookmarks and the current zoom line up. */
export function collectExportLinks(
  root: HTMLElement, cards: Card[], zoom: number,
  originX: number, originY: number, pixelRatio: number, only?: Set<string>,
): PdfLink[] {
  const urls = new Map<string, string>();
  const visit = (card: Card) => {
    if (card.kind === 'bookmark') urls.set(card.id, card.url);
    if (card.kind === 'column') card.children.forEach(visit);
  };
  cards.filter(card => !only || only.has(card.id)).forEach(visit);
  const { bounds, scaleX, scaleY } = measureExportScale(root, zoom);
  const links: PdfLink[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-id], [data-child-id]')) {
    const url = urls.get(el.dataset.id ?? el.dataset.childId ?? '');
    if (!url) continue;
    const rect = el.getBoundingClientRect();
    let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    // A bookmark scrolled out of a column must not leave a clickable area
    // on whichever card happens to be underneath it in the exported board.
    for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const style = parent.ownerDocument.defaultView!.getComputedStyle(parent);
      const clip = parent.getBoundingClientRect();
      if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {
        left = Math.max(left, clip.left + parent.clientLeft * scaleX);
        right = Math.min(right, clip.left + (parent.clientLeft + parent.clientWidth) * scaleX);
      }
      if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {
        top = Math.max(top, clip.top + parent.clientTop * scaleY);
        bottom = Math.min(bottom, clip.top + (parent.clientTop + parent.clientHeight) * scaleY);
      }
    }
    if (right <= left || bottom <= top) continue;
    links.push({
      url,
      x: ((left - bounds.left) / scaleX + originX) * pixelRatio,
      y: ((top - bounds.top) / scaleY + originY) * pixelRatio,
      width: (right - left) / scaleX * pixelRatio,
      height: (bottom - top) / scaleY * pixelRatio,
    });
  }
  return links;
}
