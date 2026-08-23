// A guest used to see shared pictures only while connected: the bytes lived in
// an in-memory blob URL and were never written, so they vanished once the host
// went away and the board was left full of holes.
import { describe, it, expect } from 'vitest';
import { sharedAssetVaultPath, saveSharedAsset } from '../src/asset-manager';
import { FakeVault } from './fake-vault';

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('sharedAssetVaultPath', () => {
  it('files an image by type, tagged with the content hash', () => {
    expect(sharedAssetVaultPath('holiday.png', HASH)).toBe('_Assets/Images/holiday-a1b2c3d4.png');
  });

  it('is deterministic, so every peer computes the same path', () => {
    expect(sharedAssetVaultPath('holiday.png', HASH)).toBe(sharedAssetVaultPath('holiday.png', HASH));
  });

  it('separates two different files that share a name', () => {
    const other = 'ffffffff' + HASH.slice(8);
    expect(sharedAssetVaultPath('photo.png', HASH)).not.toBe(sharedAssetVaultPath('photo.png', other));
  });

  it('falls back when the asset carries no name', () => {
    expect(sharedAssetVaultPath(undefined, HASH)).toBe('_Assets/Other/shared-a1b2c3d4.bin');
  });

  // The name comes off the wire, so it is untrusted input on a filesystem path.
  it('refuses to let a crafted name climb out of _Assets', () => {
    for (const nasty of ['../../evil.png', '..\..\evil.png', '/etc/passwd.png', 'a/b/c.png']) {
      const path = sharedAssetVaultPath(nasty, HASH);
      expect(path.startsWith('_Assets/')).toBe(true);
      expect(path).not.toContain('..');
      expect(path.split('/')).toHaveLength(3);
    }
  });

  // Asserting the security properties rather than one exact mangled string:
  // what matters is that nothing escapes _Assets, not how it gets tidied.
  it('does not take a crafted extension into the path', () => {
    for (const nasty of ['x.p/../ng', 'a.<script>', 'b.' + 'z'.repeat(40)]) {
      const path = sharedAssetVaultPath(nasty, HASH);
      expect(path.split('/')).toHaveLength(3);
      expect(path.endsWith('.bin')).toBe(true);
    }
  });
});

describe('saveSharedAsset', () => {
  it('writes the bytes into this vault so they outlive the room', async () => {
    const vault = new FakeVault();
    const path = await saveSharedAsset(vault.toApp(), 'holiday.png', HASH, bytes('picture'));

    expect(path).toBe('_Assets/Images/holiday-a1b2c3d4.png');
    expect(vault.has(path!)).toBe(true);
    expect(new TextDecoder().decode(vault.binaryAt(path!))).toBe('picture');
  });

  it('keeps the copy it already has rather than writing a second', async () => {
    const vault = new FakeVault();
    await saveSharedAsset(vault.toApp(), 'holiday.png', HASH, bytes('first'));
    const path = await saveSharedAsset(vault.toApp(), 'holiday.png', HASH, bytes('second'));

    expect(path).toBe('_Assets/Images/holiday-a1b2c3d4.png');
    expect(new TextDecoder().decode(vault.binaryAt(path!))).toBe('first');
  });

  it('reports failure without throwing, so the picture still shows from memory', async () => {
    const vault = new FakeVault();
    const app = vault.toApp();
    app.vault.createBinary = () => Promise.reject(new Error('disk full'));

    await expect(saveSharedAsset(app, 'holiday.png', HASH, bytes('x'))).resolves.toBeUndefined();
  });
});
