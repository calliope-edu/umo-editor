# Calliope Campus integration

This fork of [`@umoteam/editor`](https://github.com/umodoc/editor) carries the
Calliope translations **and** the campus deployment app, so the campus "Text
Editor" ships from a single repo with no separate wrapper package.

## What was changed vs. upstream

- **`src/app.vue`** — the upstream demo entry was replaced with the campus
  wrapper. It mounts `<umo-editor>` (registered by `src/main.js` from this repo's
  own source) and speaks the campus `postMessage` protocol. The original demo is
  recoverable from git history.
- **`package.json`** — added `dev:campus` and `build:campus` scripts.
- **`index.html`** — neutral lang/title for the campus deployment.
- **Yjs collaboration** — a `collaboration` editor option plus the campus-side
  Hocuspocus wiring (see below).

Everything else (the editor source, `locales/`, build tooling) is upstream +
the translation commits.

## Local dev

Use **npm** (hoisted `node_modules`). This fork is an npm project and its source
imports a transitive `dayjs` (`dayjs/locale/de`); pnpm's strict layout doesn't
expose it to the site build, so `pnpm build` fails to resolve it.

```bash
npm install
npm run dev:campus   # http://127.0.0.1:4174  (strictPort)
```

In the `calliope-dev` monorepo this is the `umo` component
(`calliope-dev run umo`, or part of `run all`), and campus points at it via
`PUBLIC_UMO_BASE_URL=http://127.0.0.1:4174`.

## Deploy (Cloudflare Pages)

```bash
npm run build:campus   # → dist/ (base '/')
```

- **Build command:** `npm run build:campus`
- **Build output directory:** `dist`
- **Package manager:** npm (Cloudflare's default here — no lockfile is committed)

`build:campus` is the upstream `--mode site` build (base `/`), so `index.html`
lands at the site root. Set the resulting URL as the `umo` entry in the campus
`src/lib/stores/editorUrls.ts` (or per-environment `PUBLIC_UMO_BASE_URL`).

## Campus ⇄ iframe protocol

Scoped by an `?instance=` query param the campus appends to the iframe `src`;
the campus validates the frame origin (derived from the configured URL).

| direction | source | messages |
| --- | --- | --- |
| campus → iframe | `calliope-campus` | `umo:init` · `umo:update-content` · `umo:update-props` |
| iframe → campus | `calliope-campus-umo` | `umo:ready` · `umo:changed` · `umo:saved` · `umo:collab-status` |

`content` is `{ html, json, text, version }`. See `src/app.vue`.

## Collaborative editing (Yjs)

The editor itself never opens a connection. It takes a ready-made `Y.Doc` — and,
for remote carets, a provider — through the `collaboration` option, so any
y-provider works:

```js
{
  collaboration: {
    enabled: true,
    document: ydoc,      // Y.Doc — required; without it collaboration stays off
    provider,            // any y-provider with `.awareness` (carets, presence)
    field: 'default',    // Y.XmlFragment name, so one Y.Doc can hold several editors
    showCarets: true,
    autoSeed: true,      // write `document.content` into the room while it is empty
    user: { id, name, color },  // falls back to the `user` option
  }
}
```

What changes when it is on:

- The Y.Doc is the source of truth, so `document.content` is **not** passed to
  Tiptap at construction. It is applied after the first sync, and only if no
  other client has ever written to the room — otherwise every joining client
  would append the document again. "Has anyone written here" is read off the
  Y.Doc's state vector, not off the fragment: binding the editor to an empty
  Y.Doc immediately writes a trailing paragraph, so the fragment is never empty
  by the time sync completes.
- Tiptap's `UndoRedo` extension is swapped for `Collaboration`'s Yjs
  `UndoManager` (running both would corrupt the shared history). The toolbar's
  undo/redo keeps working: `src/utils/collaboration.js` translates the
  UndoManager's stacks into the shape the custom history recorder expects.
- The status bar shows who else is in the room
  (`src/components/statusbar/collaborators.vue`).

The Y.Doc and provider are `markRaw`'d. This matters: `options` is a deep `ref`,
so without it Vue would wrap the CRDT in a reactive proxy and every deep watcher
would walk the whole document on each keystroke.

### Campus side

`umo:init` may carry a `collaboration` block; the frame then opens its own
Hocuspocus connection (`@hocuspocus/provider`, lazily imported):

```js
postToFrame('umo:init', {
  key: programKey,
  content,
  collaboration: {
    url: 'wss://campus-ws.calliope.cc',  // PUBLIC_HP_URL
    room: documentName,                  // same name the campus uses elsewhere
    token,                               // JWT from src/lib/server/hocuspocusToken.ts
    user: { id, name },
  },
})
```

While a room is connected:

- `umo:update-content` is **ignored** — replaying the host's copy into a live
  CRDT would overwrite what the other participants just typed. Send a
  `collaboration` block on `umo:update-props` to switch rooms instead.
- `umo:changed` keeps firing (so the campus can still snapshot to PocketBase)
  but now also fires for other people's edits, and is coalesced to one message
  per 1.5 s idle (6 s ceiling during continuous typing) — otherwise the host's
  snapshot writes would multiply by the number of people in the room. The
  payload carries `collaborative: true` and `room`. Pending changes are flushed
  on `pagehide`, `visibilitychange` and before `umo:saved`.
- `umo:collab-status` reports `{ room, status }` with `status` one of
  `connecting` · `connected` · `disconnected` · `synced` · `error` ·
  `auth-failed`.
