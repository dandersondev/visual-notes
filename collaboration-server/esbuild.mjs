import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire as __visualNotesCreateRequire } from 'node:module'; const require = __visualNotesCreateRequire(import.meta.url);" },
  outfile: 'dist/server.mjs',
  sourcemap: true,
  // Standalone by design: the desktop plugin embeds this artifact as text and
  // launches it without assuming a release installation contains node_modules.
  logLevel: 'info',
};

const embeddedOptions = {
  ...options,
  format: 'cjs',
  outfile: 'dist/server.cjs',
  banner: undefined,
  sourcemap: false,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(embeddedOptions)]);
}
