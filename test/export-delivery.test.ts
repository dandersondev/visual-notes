// @vitest-environment jsdom
//
// Every export was delivered by clicking a hidden `<a download>`. Electron
// honours that; the iPad's WKWebView does not — so on iPad an export ran to
// completion, said it had worked, and produced no file anywhere. Nothing
// failed loudly because nothing failed at all: the file had nowhere to go.
//
// On mobile the bytes now go into the vault, which is somewhere reachable
// through Obsidian, the Files app, or whatever syncs the vault.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeVault } from './fake-vault';

// vi.hoisted, because vi.mock's factory is lifted above every top-level
// declaration: `Platform: platform` is read the moment the factory runs, so a
// plain const would not exist yet.
const { platform, notices } = vi.hoisted(() => ({
  platform: { isMobile: false },
  notices: [] as string[],
}));

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./obsidian-stub');
  return {
    ...actual,
    Platform: platform,
    Notice: class { constructor(message: string) { notices.push(message); } },
  };
});

const { deliverExport, EXPORT_DIR } = await import('../src/asset-manager');

function app() {
  const vault = new FakeVault();
  return { app: vault.toApp(), vault };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('export delivery', () => {
  beforeEach(() => { platform.isMobile = false; notices.length = 0; });

  describe('on mobile, where a browser download does nothing', () => {
    beforeEach(() => { platform.isMobile = true; });

    it('writes the file into the vault and returns its path', async () => {
      const { app: a } = app();

      const path = await deliverExport(a, BYTES, 'Board.png', 'image/png');

      expect(path).toBe(`${EXPORT_DIR}/Board.png`);
    });

    it('says where it went, because an unnamed file is barely better than none', async () => {
      const { app: a } = app();

      await deliverExport(a, BYTES, 'Board.png', 'image/png');

      expect(notices).toContain(`Saved to ${EXPORT_DIR}/Board.png`);
    });

    it('never overwrites an earlier export of the same board', async () => {
      const { app: a } = app();

      const first = await deliverExport(a, BYTES, 'Board.png', 'image/png');
      const second = await deliverExport(a, BYTES, 'Board.png', 'image/png');

      expect(first).toBe(`${EXPORT_DIR}/Board.png`);
      expect(second).toBe(`${EXPORT_DIR}/Board-1.png`);
    });

    it('writes exactly the bytes it was given', async () => {
      // A Uint8Array can be a view onto a larger buffer; handing that straight
      // to createBinary would write whatever else shares it.
      const { app: a, vault } = app();
      const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
      const view = backing.subarray(2, 6);

      const path = await deliverExport(a, view, 'Board.png', 'image/png');

      const written = new Uint8Array(vault.binaryAt(path!));
      expect(Array.from(written)).toEqual([1, 2, 3, 4]);
    });

    it('handles a name with no extension', async () => {
      const { app: a } = app();
      expect(await deliverExport(a, BYTES, 'Board', 'image/png')).toBe(`${EXPORT_DIR}/Board.bin`);
    });
  });

  describe('on desktop, where the download works', () => {
    it('does not write to the vault, and reports no path', async () => {
      const { app: a, vault } = app();

      const path = await deliverExport(a, BYTES, 'Board.png', 'image/png');

      expect(path).toBeNull();
      expect(vault.has(`${EXPORT_DIR}/Board.png`)).toBe(false);
    });

    it('stays silent, leaving the browser to show its own download', async () => {
      const { app: a } = app();

      await deliverExport(a, BYTES, 'Board.png', 'image/png');

      expect(notices).toEqual([]);
    });
  });
});
