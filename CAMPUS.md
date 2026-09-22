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

Implements P7 of the campus design record
(`calliope-campus/docs/design/2026-teilen-modi.md` §7) — the `live-write`
("Live gemeinsam") share mode.

The editor core never opens a connection. It takes a ready-made `Y.Doc` — and,
for remote carets, a provider — through a `collaboration` option, so any
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

`src/app.vue` is the layer above it: it turns the campus's
`{ wsUrl, docName, token, field, canWrite, user }` into that option by opening a
Hocuspocus connection itself (`@hocuspocus/provider`, lazily imported — it lands
in its own ~31 kB chunk, so non-collaborative builds do not pay for it).

What changes when a document is shared:

- The Y.Doc is the source of truth, so `document.content` is **not** passed to
  Tiptap at construction. It is applied after the first sync, and only if no
  other client has ever written to the document — otherwise every joining client
  would append it again. "Has anyone written here" is read off the Y.Doc's state
  vector, not off the fragment: binding the editor to an empty Y.Doc immediately
  writes a trailing paragraph, so the fragment is never empty by the time sync
  completes.
- Tiptap's `UndoRedo` extension is swapped for `Collaboration`'s Yjs
  `UndoManager` (running both would corrupt the shared history). The toolbar's
  undo/redo keeps working: `src/utils/collaboration.js` translates the
  UndoManager's stacks into the shape the custom history recorder expects.
- `canWrite: false` (a `live-read` recipient) forces `document.readOnly`. The
  sync server enforces it too; this only stops the caret from blinking.
- The status bar shows who else is in the document
  (`src/components/statusbar/collaborators.vue`).

The Y.Doc and provider are `markRaw`'d. This matters: `options` is a deep `ref`,
so without it Vue would wrap the CRDT in a reactive proxy and every deep watcher
would walk the whole document on each keystroke. They also live outside the
`<umo-editor>` component, so the remount a locale change triggers does not tear
the session down.

### Campus side

```js
postToFrame('umo:coop-init', {
  key: programKey,
  wsUrl: PUBLIC_HP_URL,                  // wss://campus-ws.calliope.cc
  docName: `${roomId}/share:${shareId}`, // makeShareDocName()
  token,                                 // /api/hocuspocus-token, scoped to share:<id>
  field: 'prose',                        // top-level fragment (P7, Entscheidung 2)
  canWrite: true,
  user: { id, name, color },
})
```

- `umo:update-content` is **ignored** while a document is connected — replaying
  the host's copy into a live CRDT would insert it a second time.
- `umo:changed` keeps firing, but it is now the *derived snapshot*, not the
  truth. It also fires for other people's edits, so it is coalesced to one
  message per 1.5 s idle (6 s ceiling during continuous typing); otherwise the
  host's snapshot writes would multiply by the number of people in the document.
  Flushed on `pagehide`, `visibilitychange` and before `umo:saved`. The payload
  carries `collaborative: true` and `docName`.
- Tokens expire after an hour (`HOCO_TOKEN_TTL_MS`). The frame hands Hocuspocus
  a token *getter*, so before any (re)connect with a token older than 45 minutes
  it emits `umo:coop-token-needed` and waits up to 5 s for a `umo:coop-token`
  reply (falling back to the stale token, which surfaces as `auth-failed`).
- `umo:coop-state` reports `{ docName, state }` with `state` one of
  `connecting` · `connected` · `synced` · `disconnected` · `auth-failed` ·
  `error`.
- `umo:coop-stop` leaves the document and returns the frame to single-player.

Everything the frame sends after the first inbound campus message goes to that
message's origin rather than `'*'` — awareness carries pupils' real names, and
tokens travel the other way. `event.origin` is what gets pinned, not a payload
field, because the browser sets it and a page cannot forge it.

### Deviations from the P7 spec

- **The version history is kept, not disabled.** The spec proposed switching it
  off under collaboration because `editor.state.history$` no longer exists.
  Translating the Yjs `UndoManager`'s stacks into the same shape turned out to
  be a few lines and leaves undo/redo genuinely working, which is better than
  removing the button.
- **Seeding is decided by the state vector, not by "is the fragment empty".**
  The spec's condition cannot work as written: binding the editor to an empty
  Y.Doc writes a trailing paragraph before sync completes, so the fragment is
  never empty at the moment it would be tested.
- **`UndoRedo` was not moved into the named `extensions` map.** It is selected
  between inline instead, so it stays un-disableable through `disableExtensions`
  for non-collaborative users — the spec's route would have made it possible to
  switch undo off by accident.
