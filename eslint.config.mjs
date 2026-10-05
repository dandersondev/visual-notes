// Type-aware linting, matching what Obsidian's plugin health check reports.
//
// Having this in the repo is the point: without it, a checker supplies its own
// config, and if it builds the TypeScript program without `obsidian`'s type
// definitions available, every value from the API becomes error-typed and
// every call on one trips no-unsafe-call. That produced thousands of warnings
// against code `tsc` compiles cleanly, and rated the plugin risky. `project`
// below pins the program to this repo's tsconfig so the types resolve.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Scoped to src/, which is what tsconfig.json's program covers and what
    // the health check reports on. Tests aren't in that program, so linting
    // them type-aware would need a second tsconfig; not worth it here.
    ignores: [
      'main.js',                  // build output
      'src/starter-templates.ts', // generated — see scripts/generate-starter-templates.mjs
      'types/**',                 // vendored Obsidian API typings, not ours to lint
      'test/**',
      'scripts/**',
      'benchmarks/**',
      'templates-src/**',
      'esbuild.config.mjs',
      'eslint.config.mjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService would also work, but an explicit project keeps the
        // program identical to what `npm run typecheck` compiles.
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Obsidian's prefer-create-el review rule flags native DOM factories in
      // plugin source. Keep this small guard in the existing lint gate rather
      // than pulling the whole review plugin into the release dependency tree.
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='createElement']",
          message: 'Use Obsidian createEl/createDiv/createSpan helpers instead of createElement.',
        },
        {
          selector: "CallExpression[callee.property.name='createElementNS']",
          message: 'Use Obsidian createSvg instead of createElementNS for SVG nodes.',
        },
        {
          selector: "CallExpression[callee.property.name='createDocumentFragment']",
          message: 'Use Obsidian createFragment instead of createDocumentFragment.',
        },
      ],
      // A leading underscore marks a binding that exists only to be skipped —
      // a positional parameter the callee doesn't need, or a field discarded
      // out of an object rest. The codebase already uses that convention
      // throughout; this is what makes the linter agree with it.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
);
