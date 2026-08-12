import { describe, it, expect } from 'vitest';
import { sortAssetFile, saveNewAsset } from '../src/asset-manager';
import { FakeVault } from './fake-vault';

describe('sortAssetFile', () => {
  it('moves a file into _Assets/<Type>/ based on its extension', async () => {
    const vault = new FakeVault();
    const file = vault.putText('Random/Folder/cat.png', 'fake image bytes');

    const newPath = await sortAssetFile(vault.toApp(), file);

    expect(newPath).toBe('_Assets/Images/cat.png');
  });

  it('sorts audio, video, and document extensions into their own subfolders', async () => {
    const vault = new FakeVault();
    const audio = vault.putText('a.mp3', 'x');
    const video = vault.putText('b.mp4', 'x');
    const doc = vault.putText('c.pdf', 'x');
    const other = vault.putText('d.zip', 'x');

    expect(await sortAssetFile(vault.toApp(), audio)).toBe('_Assets/Audio/a.mp3');
    expect(await sortAssetFile(vault.toApp(), video)).toBe('_Assets/Video/b.mp4');
    expect(await sortAssetFile(vault.toApp(), doc)).toBe('_Assets/Documents/c.pdf');
    expect(await sortAssetFile(vault.toApp(), other)).toBe('_Assets/Other/d.zip');
  });

  it('files .webm as video, since that is what it usually is', async () => {
    // webm is a container for both, and it appears in both extension lists.
    // A dropped .webm renders as a video card, so filing it under Audio would
    // put the file somewhere its own card contradicts. Asserted rather than
    // left to list order, because the fix here *was* list order.
    const vault = new FakeVault();
    const clip = vault.putText('clip.webm', 'x');
    expect(await sortAssetFile(vault.toApp(), clip)).toBe('_Assets/Video/clip.webm');
  });

  it('returns the path unchanged when the file is already correctly sorted', async () => {
    const vault = new FakeVault();
    const file = vault.putText('_Assets/Images/cat.png', 'x');
    const newPath = await sortAssetFile(vault.toApp(), file);
    expect(newPath).toBe('_Assets/Images/cat.png');
  });

  it('appends a numeric suffix on a filename collision', async () => {
    const vault = new FakeVault();
    vault.putText('_Assets/Images/cat.png', 'already here');
    const incoming = vault.putText('Somewhere/cat.png', 'new file, same name');

    const newPath = await sortAssetFile(vault.toApp(), incoming);

    expect(newPath).toBe('_Assets/Images/cat-1.png');
  });
});

describe('saveNewAsset', () => {
  it('writes a new binary file into the correct subfolder by extension', async () => {
    const vault = new FakeVault();
    const data = new ArrayBuffer(8);

    const path = await saveNewAsset(vault.toApp(), data, 'photo.jpg');

    expect(path).toBe('_Assets/Images/photo.jpg');
  });

  it('resolves a filename collision the same way sortAssetFile does', async () => {
    const vault = new FakeVault();
    vault.putText('_Assets/Audio/clip.mp3', 'existing');

    const path = await saveNewAsset(vault.toApp(), new ArrayBuffer(4), 'clip.mp3');

    expect(path).toBe('_Assets/Audio/clip-1.mp3');
  });

  it('falls back to a generic subfolder for an unrecognized extension', async () => {
    const vault = new FakeVault();
    const path = await saveNewAsset(vault.toApp(), new ArrayBuffer(1), 'data.xyz');
    expect(path).toBe('_Assets/Other/data.xyz');
  });
});
