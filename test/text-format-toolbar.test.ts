// @vitest-environment jsdom
//
// Mobile UX overhaul, phase 1: TextFormatToolbar (the rich-text selection
// popover) has no phone-specific sizing/positioning/keyboard-awareness and
// was the leading suspect for a report of editing taking over the whole
// iPhone screen with a white popup. It's now gated off entirely on
// Platform.isPhone (checked in scheduleCheck(), before the popover is ever
// created) — these tests lock in that the gate actually prevents the
// popover on phone, and doesn't regress it on desktop/iPad.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Platform } from 'obsidian';
import { TextFormatToolbar } from '../src/text-format-toolbar';

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.textContent = 'hello world';
  container.appendChild(editor);
  return { container, editor };
}

// jsdom doesn't fire 'selectionchange' automatically when a Range is added
// to a Selection (a real browser does) — dispatching it manually simulates
// what the browser would do after the user actually selects some text.
function selectAllTextIn(editor: HTMLElement): void {
  const textNode = editor.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, (textNode.textContent ?? '').length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('TextFormatToolbar: gated off on phone (mobile UX phase 1)', () => {
  // jsdom has no real layout engine — Range.prototype.getClientRects isn't
  // implemented at all, which position() (run via a queued rAF once the
  // popover shows) calls unconditionally. Stubbed to an empty list so
  // position() takes its no-rects fallback path instead of throwing; the
  // actual pixel position isn't what these gating tests care about.
  let originalGetClientRects: (() => DOMRectList) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });
  afterEach(() => {
    vi.useRealTimers();
    Platform.isPhone = false;
    document.body.innerHTML = '';
    if (originalGetClientRects) Range.prototype.getClientRects = originalGetClientRects;
  });

  it('never creates the popover when Platform.isPhone is true', async () => {
    Platform.isPhone = true;
    const { container, editor } = setup();
    new TextFormatToolbar(editor, container, container);

    selectAllTextIn(editor);
    await vi.advanceTimersByTimeAsync(150); // past the 100ms debounce

    expect(container.querySelector('.visual-notes-text-fmt-toolbar')).toBeNull();
  });

  it('still shows the popover when Platform.isPhone is false (desktop/iPad unaffected)', async () => {
    Platform.isPhone = false;
    const { container, editor } = setup();
    new TextFormatToolbar(editor, container, container);

    selectAllTextIn(editor);
    await vi.advanceTimersByTimeAsync(150);

    expect(container.querySelector('.visual-notes-text-fmt-toolbar')).not.toBeNull();
  });
});

describe('TextFormatToolbar: per-selection text size', () => {
  let originalGetClientRects: (() => DOMRectList) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });
  afterEach(() => {
    vi.useRealTimers();
    Platform.isPhone = false;
    document.body.innerHTML = '';
    if (originalGetClientRects) Range.prototype.getClientRects = originalGetClientRects;
  });

  async function openToolbarOver(html: string) {
    Platform.isPhone = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.innerHTML = html;
    container.appendChild(editor);
    new TextFormatToolbar(editor, container, container);

    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection()!;
    sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(150);
    return { container, editor };
  }

  const sizeBtn = (container: HTMLElement, label: string) =>
    Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-text-fmt-size-btn'))
      .find(b => b.textContent === label)!;

  it('wraps the selection in an em-based font-size, so it scales with the card', async () => {
    const { container, editor } = await openToolbarOver('hello');

    sizeBtn(container, '2X').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const span = editor.querySelector('span')!;
    // em, not px — an inline size has to multiply the card/global scale
    // rather than pin the text to an absolute size that ignores both.
    expect(span.style.fontSize).toBe('2em');
    expect(span.textContent).toBe('hello');
  });

  it('the reset step strips the size instead of writing 1em', async () => {
    const { container, editor } = await openToolbarOver('<span style="font-size:2em">hello</span>');

    sizeBtn(container, 'M').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.querySelector('span')).toBeNull();
    expect(editor.textContent).toBe('hello');
  });

  it('setting a size keeps an existing text colour (both live on <span>)', async () => {
    // Regression guard: wrapRange flattens every same-tag element in range,
    // so routing size through it would have silently dropped the colour.
    const { container, editor } = await openToolbarOver('<span style="color:#EF4444">hello</span>');

    sizeBtn(container, 'XL').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.textContent).toBe('hello');
    const styles = Array.from(editor.querySelectorAll('span')).map(s => s.getAttribute('style') ?? '');
    expect(styles.join(' ')).toContain('font-size: 1.5em');
    expect(styles.join(' ')).toContain('color:');
  });

  it('hoists a whole-item size onto the <li> so the bullet marker grows too', async () => {
    // A marker is sized by its <li>, never by a span nested inside it, so
    // leaving the size on the span gives big text beside a tiny bullet.
    const { container, editor } = await openToolbarOver('<ul><li>milk</li></ul>');

    sizeBtn(container, '3X').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const li = editor.querySelector('li')!;
    expect(li.style.fontSize).toBe('2.5em');
    expect(li.querySelector('span[style*="font-size"]')).toBeNull();
  });

  it('hoists when several spans cover the item at one size, not just a lone span', async () => {
    const { container, editor } = await openToolbarOver(
      '<ul><li><span style="color:#EF4444">buy</span> milk</li></ul>');

    sizeBtn(container, 'XL').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const li = editor.querySelector('li')!;
    expect(li.style.fontSize).toBe('1.5em');
    expect(li.querySelector('[style*="font-size"]')).toBeNull();
    expect(li.textContent).toBe('buy milk');
  });

  it('leaves the marker alone when only part of the item is resized', async () => {
    const { editor } = await openToolbarOver('<ul><li>buy milk today</li></ul>');
    const li = editor.querySelector('li')!;
    // Select just "milk" — the line itself hasn't changed size, so the
    // bullet should stay put rather than jumping to the biggest word.
    const textNode = li.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 8);
    const sel = window.getSelection()!;
    sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(150);

    sizeBtn(document.body, '4X').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(li.style.fontSize).toBe('');
    expect(li.querySelector('span')!.style.fontSize).toBe('3em');
  });

  function swatch(container: HTMLElement, label: string, index: number): HTMLElement {
    const section = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-text-fmt-section'))
      .find(el => el.querySelector('.visual-notes-text-fmt-label')?.textContent === label)!;
    return section.querySelectorAll<HTMLElement>('.visual-notes-text-fmt-swatch')[index];
  }

  it('colours every line without wrapping paragraphs in inline elements and fires input', async () => {
    const { container, editor } = await openToolbarOver('<p>first</p><div><span style="color:blue">second</span></div><div>third</div>');
    const input = vi.fn();
    editor.addEventListener('input', input);
    swatch(container, 'Color', 2).click();
    expect(editor.querySelector('span > p, span > div')).toBeNull();
    for (const block of Array.from(editor.children)) {
      expect(block.querySelector('span')!.style.color).toBe('rgb(239, 68, 68)');
    }
    expect(editor.textContent).toBe('firstsecondthird');
    expect(input).toHaveBeenCalledOnce();
  });

  it('replaces highlight across Enter-created lines, preserving text colour', async () => {
    const { container, editor } = await openToolbarOver('first<div><mark style="background:blue"><span style="color:red">second</span></mark></div>');
    swatch(container, 'Highlight', 4).click();
    expect(editor.querySelector('mark > div')).toBeNull();
    expect(Array.from(editor.querySelectorAll('mark')).every(el => el.style.backgroundColor === 'rgb(190, 242, 100)')).toBe(true);
    expect(editor.querySelector('span')!.style.color).toBe('red');
    expect(editor.textContent).toBe('firstsecond');
  });

  it.each(['Color', 'Highlight'])('resets only the selected part of inherited %s', async label => {
    const { container, editor } = await openToolbarOver(label === 'Color'
      ? '<span style="color:red">hello world</span>' : '<mark style="background:yellow">hello world</mark>');
    const text = editor.firstChild!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(150);
    swatch(container, label, 1).click();
    expect(editor.firstChild!.textContent).toBe('hello');
    expect(editor.querySelector(label === 'Color' ? 'span' : 'mark')!.textContent).toBe(' world');
    expect(editor.textContent).toBe('hello world');
  });

  it.each(['left', 'centre', 'right'])('aligns all selected lines %s and stores alignment in the HTML', async label => {
    const { container, editor } = await openToolbarOver('first<div>second</div><p style="text-align:left">third</p>');
    container.querySelector<HTMLElement>(`[aria-label="Align ${label}"]`)!.click();
    expect(editor.children.length).toBe(3);
    for (const block of Array.from(editor.children) as HTMLElement[]) {
      expect(block.style.textAlign).toBe(label === 'centre' ? 'center' : label);
    }
    expect(editor.textContent).toBe('firstsecondthird');
  });

  it('aligns a selected list item without changing its neighbours', async () => {
    const { container, editor } = await openToolbarOver('<ul><li>first</li><li>second</li></ul>');
    const range = document.createRange();
    range.selectNodeContents(editor.querySelectorAll('li')[1]);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(150);
    container.querySelector<HTMLElement>('[aria-label="Align right"]')!.click();
    expect(editor.querySelectorAll('li')[0].style.textAlign).toBe('');
    expect(editor.querySelectorAll('li')[1].style.textAlign).toBe('right');
  });

  it('offers a wide spread of steps, biggest well past the default', async () => {
    const { container } = await openToolbarOver('hello');
    const labels = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-text-fmt-size-btn'))
      .map(b => b.textContent);
    expect(labels).toEqual(['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X']);
  });
});
