import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const standaloneObsidianShim = {
  name: 'standalone-obsidian-shim',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'standalone-obsidian' }));
    build.onLoad({ filter: /.*/, namespace: 'standalone-obsidian' }, () => ({
      contents: `
        export const Platform = { isDesktopApp: true };
        export async function requestUrl(options) {
          const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body });
          const text = await response.text();
          let json;
          try { json = JSON.parse(text); } catch {}
          if (options.throw !== false && !response.ok) throw new Error('Request failed with status ' + response.status);
          return { status: response.status, text, json, arrayBuffer: await new Blob([text]).arrayBuffer(), headers: {} };
        }
      `,
      loader: 'js',
    }));
  },
};
// The standalone server runs in plain Node, where there is no `window` to read
// Electron's loader from. Rather than have desktop-node.ts reach for globalThis
// -- which Obsidian's review flags, and which is meaningless in a popout window
// -- the standalone build swaps the module for a createRequire version. Shipped
// as generated contents, not a checked-in .ts file, so the source tree keeps
// exactly one desktop-node module and it is the Obsidian one.
const standaloneDesktopNodeShim = {
  name: 'standalone-desktop-node-shim',
  setup(build) {
    build.onResolve({ filter: /^\.\/desktop-node$/ }, () => ({
      path: 'desktop-node', namespace: 'standalone-desktop-node',
    }));
    build.onLoad({ filter: /.*/, namespace: 'standalone-desktop-node' }, () => ({
      contents: `
        import { createRequire } from 'node:module';
        const nodeRequire = createRequire(import.meta.url);
        export function requireDesktopNodeModule(id) { return nodeRequire(id); }
      `,
      loader: 'js',
    }));
  },
};
const embeddedObsidianShim = {
  name: 'embedded-obsidian-shim',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'embedded-obsidian' }));
    build.onLoad({ filter: /.*/, namespace: 'embedded-obsidian' }, () => ({
      contents: `
        export const Platform = { isDesktopApp: true };
        export function requestUrl(options) {
          const bridge = globalThis.__visualNotesCollaborationRequest;
          if (!bridge) throw new Error('The Obsidian request bridge is unavailable.');
          return bridge(options);
        }
      `,
      loader: 'js',
    }));
  },
};
const options = {
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // `require` is still needed for the CommonJS dependencies esbuild leaves as
  // require() calls in an ESM bundle; the shims above cover our own modules.
  banner: { js: "import { createRequire as __visualNotesCreateRequire } from 'node:module'; const require = __visualNotesCreateRequire(import.meta.url);" },
  outfile: 'dist/server.mjs',
  sourcemap: true,
  // Standalone by design: the desktop plugin embeds this artifact as text and
  // launches it without assuming a release installation contains node_modules.
  logLevel: 'info',
  plugins: [standaloneObsidianShim, standaloneDesktopNodeShim],
};

const embeddedOptions = {
  ...options,
  format: 'cjs',
  outfile: 'dist/server.cjs',
  // No banner: the embedded build keeps the real desktop-node.ts, which reads
  // Electron's loader off window.
  banner: undefined,
  sourcemap: false,
  plugins: [embeddedObsidianShim, {
    name: 'obsidian-persistence',
    setup(build) {
      build.onResolve({ filter: /^\.\/persistence-selected$/ }, args => ({
        path: fileURLToPath(new URL('./src/persistence-obsidian.ts', import.meta.url)),
      }));
    },
  }],
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(embeddedOptions)]);
}
