import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release health gates', () => {
  it('keeps direct filesystem modules out of the shipped plugin bundle', () => {
    const bundle = readFileSync('main.js', 'utf8');
    expect(bundle).not.toContain('node:fs');
    expect(bundle).not.toContain('node:fs/promises');
  });

  // Obsidian asks for `window`/`activeWindow` over globalThis, for popout
  // window compatibility. The bridges the plugin hands the embedded server are
  // the tempting place to reach for globalThis, so pin them here. The
  // standalone server's Node loader is supplied as a generated esbuild shim
  // rather than a source file precisely so this rule can hold everywhere.
  it('reaches for window rather than globalThis', () => {
    for (const path of [
      'src/collaboration-host-runtime.ts',
      'collaboration-server/src/desktop-node.ts',
      'collaboration-server/src/persistence-obsidian.ts',
    ]) {
      const source = readFileSync(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, path).not.toContain('globalThis');
    }
  });

  it('keeps collaboration server Node APIs guarded and avoids direct fetch', () => {
    for (const path of [
      'collaboration-server/src/persistence.ts',
      'collaboration-server/src/server.ts',
      'collaboration-server/src/service-auth.ts',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/^import\s.+from\s+['"]node:/m);
      expect(source, path).not.toMatch(/\bfetch\s*\(/);
    }
  });

  // Inverted deliberately. Attestation is NOT wanted: 1.0.13, 1.0.16 and
  // 1.0.17 each failed Obsidian's review with "attestation exists but
  // signature is invalid or does not match this repository", across
  // attest-build-provenance v1/v2 and actions/attest v4. The bundles were
  // well-formed; the verifier is not fixable from here. A present-but-
  // unverifiable attestation is a review Error, while a missing one is only
  // a Recommendation -- so adding it back makes a release strictly worse.
  // Attestations are also permanent and keyed by file digest. See commit
  // 45c51c8, and the note in the workflow itself.
  it('does not attest release assets, which fails Obsidian review', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    // Matches the step invocation and the permission, not any mention: the
    // comment above deliberately names the action so the next reader knows
    // exactly which one was tried and rejected.
    expect(workflow).not.toMatch(/^\s*uses:\s*actions\/attest/m);
    expect(workflow).not.toMatch(/^\s*attestations:\s*write/m);
    expect(workflow).not.toMatch(/^\s*id-token:\s*write/m);
  });
});
