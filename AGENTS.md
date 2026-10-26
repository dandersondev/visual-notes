# Visual Notes development guidance

Read [the Obsidian review checklist](docs/obsidian-review-checklist.md) when changing plugin UI or preparing a release.

## Avoid static style assignments

- Obsidian's automated review rejects fixed style assignments under `obsidianmd/no-static-styles-assignment`.
- Put fixed styling in `styles.css` and apply CSS classes. For styles computed from card data or measurements, use Obsidian's `setCssProps` or `setCssStyles` helpers where appropriate.
- Do not introduce code such as `el.style.backgroundPosition = 'center'`. This caused release 1.4.15 to fail review at `src/freeform-view-cards-basic.ts:1179`.
- Release 1.4.16 fixed it by declaring `background-position: center` in `.visual-notes-freeform-group-card` in `styles.css`.
- Local lint, tests, and builds passed despite that review error. Do not treat those checks as proof that Obsidian's external review rules all pass; inspect new style assignments before releasing.

## Before pushing or tagging a release

- Run `npm run lint`, `npm run build`, and `npm test`, and inspect new style writes in the source diff.
- Dynamic ordinary styles must use unquoted camelCase keys, for example `el.setCssStyles({ textAlign: value })`. Obsidian rejected `setCssProps({ 'text-align': value })` on 1.4.17 even though it used a helper. Quoted keys in either helper must be CSS custom properties beginning with `--`.
- A correction to an existing release must keep its tag, source, and uploaded assets synchronized, with a fresh review requested afterward. Keep the version unchanged only when the user explicitly requests it.
