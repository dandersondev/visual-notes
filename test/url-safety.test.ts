// @vitest-environment jsdom
//
// URLs on a card can arrive two ways: typed by the person using the plugin,
// or read out of a board file someone else authored and shared. The creation
// paths check what gets typed, but the deserializer builds cards straight
// from the JSON without re-checking (see canvas-format's bookmark case), so
// the check has to exist at the point of use too. These cover that second
// path — the one where the string was never validated by anybody.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isValidURL, openExternalUrl, safeRemoteImageSrc } from '../src/freeform-view-shared';

afterEach(() => { vi.restoreAllMocks(); });

describe('isValidURL', () => {
  it('accepts http and https', () => {
    expect(isValidURL('http://example.com')).toBe(true);
    expect(isValidURL('https://example.com/a?b=c#d')).toBe(true);
  });

  it('rejects the schemes that make an open dangerous', () => {
    expect(isValidURL('javascript:alert(1)')).toBe(false);
    expect(isValidURL('file:///etc/passwd')).toBe(false);
    expect(isValidURL('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isValidURL('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects anything that is not a URL at all', () => {
    expect(isValidURL('')).toBe(false);
    expect(isValidURL('just some text')).toBe(false);
    expect(isValidURL('//example.com')).toBe(false); // protocol-relative: no scheme to check
  });
});

describe('openExternalUrl', () => {
  it('opens an ordinary web link', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalUrl('https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank');
  });

  it('refuses a javascript: URL', () => {
    // The one that matters most: window.open runs a javascript: URL in the
    // document it opens, so an unchecked call turns clicking a card on a
    // shared board into executing its author's script.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalUrl('javascript:alert(document.cookie)');
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses file: and data: URLs', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternalUrl('file:///C:/Users/someone/.ssh/id_rsa');
    openExternalUrl('data:text/html,<script>alert(1)</script>');
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses an absent URL without throwing', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => { openExternalUrl(undefined); openExternalUrl(null); openExternalUrl(''); }).not.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('safeRemoteImageSrc', () => {
  it('passes a remote image URL through unchanged', () => {
    expect(safeRemoteImageSrc('https://example.com/og.png')).toBe('https://example.com/og.png');
  });

  it('rejects non-web schemes scraped from a remote page', () => {
    expect(safeRemoteImageSrc('javascript:alert(1)')).toBe(null);
    expect(safeRemoteImageSrc('file:///C:/Windows/system.ini')).toBe(null);
  });

  it('rejects nothing-at-all rather than returning it', () => {
    expect(safeRemoteImageSrc(undefined)).toBe(null);
    expect(safeRemoteImageSrc('')).toBe(null);
  });

  it('rejects a vault resource path, which must not come through here', () => {
    // getResourcePath() returns an app:// URL. It is legitimate, but it
    // belongs on img.src directly — routing it through this helper would
    // silently blank the image, so the test pins the boundary.
    expect(safeRemoteImageSrc('app://local/C:/vault/pic.png')).toBe(null);
  });
});
