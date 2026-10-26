# Obsidian review checklist

Use this before merging plugin changes and before publishing a version. Obsidian's [directory review](https://docs.obsidian.md/community-directory/manage-entry) checks source, the manifest, release assets, and whether the build matches the source. Its rules can change, so this checklist records the cases Visual Notes has encountered; the [official ESLint rule list](https://github.com/obsidianmd/eslint-plugin#rules) is the current reference for additional source warnings.

## Source changes

| Check | Avoid | Use or verify | Local gate |
| --- | --- | --- | --- |
| Obsidian DOM helpers (`prefer-create-el`) | `document.createElement('canvas')`, `document.createElementNS(...)`, `document.createDocumentFragment()` | `createEl('canvas')`, `createSvg(...)`, `createFragment()`; use `container.createEl(...)` when appending to a parent | `npm run lint` rejects native DOM factories in `src/` |
| Popout window support | Reaching for global `document`, `globalThis`, or bare timers when an operation belongs to a window | Use `activeDocument` / `activeWindow` and window-owned timers where appropriate | Review the changed code; `test/release-health.test.ts` covers known bridge cases |
| Mobile compatibility | Top-level imports of Node or Electron modules in a plugin marked `isDesktopOnly: false` | Check `Platform.isDesktop` and load desktop-only code only when needed | `npm run build` and release-health tests |
| API availability | Calling an API added after `manifest.json`'s `minAppVersion` without a guard | Check the API's introduction version; raise the minimum or gate the feature | Typechecks and review scan |
| UI styling (`no-static-styles-assignment`) | Fixed assignments such as `el.style.backgroundPosition = 'center'`, forbidden elements, or hard-coded theme colours | Put fixed styling in CSS classes; use Obsidian theme variables and `setCssProps` / `setCssStyles` for computed styles where appropriate | Stylesheet tests, quoted-helper-key lint guard, and source review; local lint does not enforce the full external styling rule |
| Type safety | `any`, unsafe calls, or changing vendored declarations to silence a warning | Keep source types explicit; keep vendored types matched to upstream and run all three typechecks | `npm run build` and `npm test` |
| Lint suppressions | A bare `eslint-disable` comment | Prefer fixing the code; if suppression is necessary, put its reason on the directive itself | `test/lint-directives.test.ts` |

For an unattached canvas, create it with Obsidian's helper:

```ts
// Flagged by obsidianmd/prefer-create-el
const canvas = document.createElement('canvas');

// Accepted by the same review rule
const canvas = createEl('canvas'); // unattached helper element
```

For an SVG node attached to a parent:

```ts
// Flagged
const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
svg.appendChild(path);

// Obsidian helper
const path = svg.createSvg('path');
```

Obsidian documents the [`createEl` UI pattern](https://docs.obsidian.md/Plugins/User%20interface/HTML%20elements). Its [official ESLint plugin](https://github.com/obsidianmd/eslint-plugin) describes the broader rules. The repository uses a small built-in lint guard for native DOM factories because adding that plugin to the release dependency tree introduced hundreds of packages and new audit findings; the Obsidian branch preview scan remains the broader check.

## Static style assignment error on 1.4.15

Obsidian's automated review rejected `el.style.backgroundPosition = 'center'` at `src/freeform-view-cards-basic.ts:1179` with `obsidianmd/no-static-styles-assignment`. The full local build, lint, tests, and GitHub workflows had all passed, so those checks did not cover this rule.

Release 1.4.16 removed that TypeScript assignment and moved the fixed value into the existing stylesheet class:

```css
.visual-notes-freeform-group-card {
  background-position: center;
}
```

For future changes, put fixed visual styling in CSS classes. Use `setCssProps` or `setCssStyles` where computed styles are necessary. Inspect new `.style` assignments before publishing rather than relying solely on local lint.

## Quoted CSS helper keys rejected on 1.4.17

The 1.4.17 review rejected `setCssProps({ 'text-align': value })` in the sticky editor and selection toolbar. A helper call alone does not guarantee acceptance: the official rule rejects quoted, non-custom property keys in both `setCssProps` and `setCssStyles`, even when their values are dynamic.

- Use `el.setCssStyles({ textAlign: value })` for dynamic ordinary styles, with unquoted camelCase keys.
- Use `el.setCssProps({ '--custom-property': value })` for CSS custom properties.
- Keep fixed styling in CSS classes. Do not introduce direct literal `.style` assignments, `style.setProperty` calls, or literal `setAttribute('style', ...)` values.
- Before pushing or tagging a release, run `npm run lint`; its `no-restricted-syntax` guard now rejects quoted ordinary keys in either helper. Review the source diff for all new style writes as well: this guard covers the known helper-key failure, not every external review rule.
- When correcting an existing release at the user's request, rebuild from the corrected commit, update its tag and all three release files together, verify asset checksums against the clean build, and request a fresh Obsidian review. Existing installations may require a reinstall because the version number has not changed.

Reference: [official rule implementation](https://github.com/obsidianmd/eslint-plugin/blob/master/lib/rules/noStaticStylesAssignment.ts).

## CSS and release files

- Run `npm run build` and `npm test` after `npm ci`. The build includes normal, upstream, and dependency-free typechecks plus lint. CI repeats these checks.
- Check `styles.css` against `test/stylesheet-compat.test.ts`. Earlier reviews flagged `text-indent` and `break-inside`; the test prevents them and `!important` from returning.
- Keep `manifest.json`, `package.json`, `package-lock.json`, `versions.json`, the Git tag, and the `main.js` build version aligned. Release assets must include `main.js`, `manifest.json`, and `styles.css`.
- Keep generated `src/starter-templates.ts` committed in sync with `templates-src/`.
- Before publishing, use **Review branch → Run preview scan** in the [Community directory](https://docs.obsidian.md/community-directory/manage-entry). After publishing, use **Request review** to recheck a corrected release. A source fix in `main` alone does not change an already published tag's score.

## Attestation errors on 1.4.11

The `1.4.11` review reports that `main.js` and `styles.css` have attestations whose signatures fail. The [release workflow](../.github/workflows/release.yml) has **no attestation step**, and [the release-health test](../test/release-health.test.ts) rejects adding one. The published assets' SHA-256 digests match the files built locally from `1.4.11`:

| Asset | SHA-256 |
| --- | --- |
| `main.js` | `7c1b7812903a1523982984960e73cdbec62ea93be9c0134fbe8dee4340d59880` |
| `styles.css` | `04e560daf64615677d6d19c00fe745a07597b69cbf201ac60d708a1ad6b8018f` |

On 2026-10-02, GitHub's public [attestation lookup](https://docs.github.com/en/rest/repos/attestations#list-attestations) returned 404 for both of those digests, while the same endpoint returned four attestations for an older asset known to have them (`1.0.17` `main.js`). This points to an Obsidian review false positive or stale result; it does **not** establish that a signature is actually invalid. Another [Obsidian forum report](https://forum.obsidian.md/t/scorecard-false-positive-release-asset-attestations-reported-as-failing-cryptographic-verification/116203) describes the same two-asset message, though that report involved existing attestations and later cleared.

Request a fresh directory review. If it still reports these errors, send Obsidian the `1.4.11` tag, the two digests, the release workflow link, and the public attestation lookup results. Do not add an attestation step or replace release assets to silence this message without first finding an actual mismatched artifact.
