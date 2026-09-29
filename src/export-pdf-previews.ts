import { App, TFile, loadPdfJs } from 'obsidian';
import type { Card } from './file-types';

// Only the public PDF.js surface needed to render a static first page.
interface PdfPage {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void>; cancel(): void };
}
interface PdfLoadingTask {
  promise: Promise<{ getPage(page: number): Promise<PdfPage> }>;
  destroy(): Promise<void>;
}
interface PdfJs {
  getDocument(options: { data: Uint8Array; isEvalSupported: boolean }): PdfLoadingTask;
}

/** Render PDF file cards for capture; the live Chromium viewers stay attached. */
export async function preparePdfExport(
  root: HTMLElement, app: App, cards: Card[], pixelRatio: number, only?: Set<string>,
): Promise<{ restore: () => void; failed: string[] }> {
  const files = new Map<string, string>();
  const visit = (card: Card) => {
    if (card.kind === 'file' && /\.pdf$/i.test(card.path)) files.set(card.id, card.path);
    if (card.kind === 'column') card.children.forEach(visit);
  };
  cards.filter(card => !only || only.has(card.id)).forEach(visit);
  const previews: HTMLElement[] = [];
  const failed: string[] = [];
  let library: Promise<PdfJs> | undefined;
  // Render sequentially to bound memory when a board contains many PDFs.
  for (const el of root.querySelectorAll<HTMLElement>('[data-id], [data-child-id]')) {
    const path = files.get(el.dataset.id ?? el.dataset.childId ?? '');
    const body = el.querySelector<HTMLElement>('.visual-notes-file-body');
    if (!path || !body?.querySelector('.visual-notes-file-iframe')) continue;
    let loading: PdfLoadingTask | undefined;
    let rendering: ReturnType<PdfPage['render']> | undefined;
    let timeout: number | undefined;
    let expired = false;
    const canvas = body.createEl('canvas');
    canvas.setCssStyles({ display: 'none' });
    try {
      const render = async () => {
        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('PDF not found');
        const data = await app.vault.readBinary(file);
        const pdfJs = await (library ??= loadPdfJs() as Promise<PdfJs>);
        if (expired) return;
        loading = pdfJs.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
        const pdf = await loading.promise;
        if (expired) return;
        const page = await pdf.getPage(1);
        if (expired) return;
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(
          Math.max(1, body.clientWidth) * pixelRatio / natural.width,
          Math.max(1, body.clientHeight) * pixelRatio / natural.height,
          4096 / Math.max(natural.width, natural.height),
        );
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        rendering = page.render({ canvasContext: ctx, viewport });
        await rendering.promise;
      };
      await Promise.race([
        render(),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => { expired = true; reject(new Error('PDF preview timed out')); }, 15000);
        }),
      ]);
      const img = body.createEl('img', { cls: 'visual-notes-export-pdf-preview', attr: { alt: `First page of ${path}` } });
      previews.push(img);
      img.src = canvas.toDataURL('image/png');
      img.setCssStyles({ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', background: '#fff' });
    } catch {
      failed.push(path);
      const fallback = body.createDiv({ cls: 'visual-notes-export-pdf-preview', text: `PDF preview unavailable: ${path}` });
      previews.push(fallback);
      fallback.setCssStyles({ position: 'absolute', inset: '0', padding: '12px', background: '#fff', color: '#333' });
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      rendering?.cancel();
      if (loading) await loading.destroy().catch(() => {});
      canvas.remove();
    }
  }
  return { restore: () => { for (const preview of previews) preview.remove(); }, failed };
}
