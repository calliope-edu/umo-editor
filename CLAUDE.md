# CLAUDE.md

Calliope's fork of the [Umo Editor](https://github.com/umodoc/editor) (Vue 3,
Tiptap). It is the "Text" editor of Calliope Campus and runs only there,
framed at `/editors/umo/` on Campus's own origin; it has no site of its own.
`CAMPUS.md` describes the Campus wrapper (`src/app.vue`) and its postMessage
protocol.

## Branches

- Work on `calliope-main`: branch off it and merge back into it. `main` is
  history.
- A tag `calliope-vX.Y.Z` on `calliope-main` goes live: the `calliope-build`
  workflow builds it onto `build-live`, which Campus pins as its submodule
  `editors/umo`. Every push to `calliope-main` builds onto `build-dev`
  (umo-dev.calliope.cc, which campus-dev can proxy).
- Never commit to `build-live` or `build-dev` by hand; only the workflow
  writes them, and they only ever grow (Campus release tags pin old commits).
- Upstream (`umodoc/editor`) is merged into `calliope-main` like any other
  change, on a branch of its own.

## Same origin

- Campus serves the build on its own origin, so the editor runs with
  Campus's rights. Load nothing executable from another host: the editor's
  libraries (KaTeX, Mermaid, ECharts, …) come from the pinned
  `@umoteam/editor-external` that `bin/copy-external.js` copies into the build
  (`external/`), not from unpkg.
- localStorage keys stay under `umo-editor:`; Campus checks its own keys
  against them (calliope-campus `docs/editors.md`, "Same origin").

## Version

- `BUILD.json` (at the build branch root and in `editors/umo/`) follows
  `docs/build-info.md`, the format of calliope-mini-python-editor. The build
  compiles the same values in and logs them once to the console; there is no
  version line, as UMO has no menu of its own for one.

## Running it

- npm, not pnpm (`CAMPUS.md`): `npm ci --ignore-scripts`, then
  `npm run dev:campus` (http://127.0.0.1:4174) and point Campus at it.
- The Campus build: `UMO_BASE=/editors/umo/ npm run build:campus` → `dist/`.
- `npm run lint` (oxlint), `npm run format` (oxfmt).
