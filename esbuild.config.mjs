import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { readFileSync } from "fs";

const prod = process.argv[2] === "production";
const manifest = JSON.parse(readFileSync("./manifest.json", "utf8"));

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Not tsconfig.json: that maps sortablejs / perfect-freehand / html-to-image
  // to the vendored .d.ts copies under types/ (so Obsidian's health check can
  // resolve types without installing anything), and esbuild honours ,
  // so it would bundle type declarations instead of the real modules.
  tsconfig: "tsconfig.build.json",
  banner: {
    js: `/* Visual Notes v${manifest.version} — bundled file, do not edit. Source: https://github.com/dandersondev/visual-notes */`,
  },
  // Bakes the version being built into the bundle itself, so the running
  // code can report which main.js it actually is. That's a different fact
  // from plugin.manifest.version (which Obsidian reads out of
  // manifest.json), and the settings tab compares the two to catch a
  // half-applied update — the failure where manifest.json is replaced but
  // main.js isn't, making new features look silently missing.
  define: {
    __BUILD_VERSION__: JSON.stringify(manifest.version),
  },
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map(module => `node:${module}`),
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // Bundled UI images live in assets/ and get imported directly in source
  // (e.g. `import icon from '../assets/icon.png'`) — esbuild inlines them as
  // base64 data URIs right into main.js, so they ship with the plugin
  // regardless of install method (community browser, manual 3-file copy,
  // etc.) rather than needing a separate assets folder to be present.
  loader: {
    ".png": "dataurl",
    ".jpg": "dataurl",
    ".jpeg": "dataurl",
    ".gif": "dataurl",
    ".svg": "dataurl",
    ".webp": "dataurl",
  },
  plugins: [{
    name: "embedded-collaboration-server",
    setup(build) {
      build.onResolve({ filter: /^visual-notes-collaboration-server-source$/ }, () => ({
        path: "collaboration-server/dist/server.cjs",
        namespace: "collaboration-server-source",
      }));
      build.onLoad({ filter: /.*/, namespace: "collaboration-server-source" }, () => ({
        contents: `export default ${JSON.stringify(readFileSync("collaboration-server/dist/server.cjs", "utf8"))};`,
        loader: "js",
      }));
    },
  }],
});

if (prod) {
  await context.rebuild();
  const releaseBundle = readFileSync("main.js", "utf8");
  const forbiddenModules = ["node:fs", "node:fs/promises"].filter(module => releaseBundle.includes(module));
  if (forbiddenModules.length) {
    throw new Error(`Release bundle contains forbidden direct-filesystem modules: ${forbiddenModules.join(", ")}`);
  }
  console.log("Release bundle check passed: no direct Node filesystem modules.");
  process.exit(0);
} else {
  await context.watch();
}
