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
  const bounds = root.getBoundingClientRect();
  const links: PdfLink[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-id], [data-child-id]')) {
    const url = urls.get(el.dataset.id ?? el.dataset.childId ?? '');
    if (!url) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    links.push({
      url,
      x: ((rect.left - bounds.left) / zoom + originX) * pixelRatio,
      y: ((rect.top - bounds.top) / zoom + originY) * pixelRatio,
      width: rect.width / zoom * pixelRatio,
      height: rect.height / zoom * pixelRatio,
    });
  }
  return links;
}
