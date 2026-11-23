# Build info: `BUILD.json`

Every Calliope editor build says which version it is, in the same shape, so
Calliope Campus' version overview (`/admin/versions`) can compare every target
against its channel. The format is defined in calliope-mini-python-editor
`docs/build-info.md`; this file only says how UMO fills it. The plan behind it
is calliope-campus `docs/design/2026-editor-channels.md` ("Version display").

## Channels

| Channel | Built from                         | Build branch | Served at                                      |
| ------- | ---------------------------------- | ------------ | ---------------------------------------------- |
| `live`  | a tag `calliope-vX.Y.Z`            | `build-live` | Campus pins it, `/editors/umo/`                |
| `dev`   | a push to calliope-main            | `build-dev`  | `umo-dev.calliope.cc/editors/umo/`, campus-dev |
| `local` | `npm run dev:campus`, a local build | none         | your machine                                   |

UMO has only the Campus variant; there is no site at the root.

## `BUILD.json`

At the build branch root (`/BUILD.json`) and next to the build
(`/editors/umo/BUILD.json`), with the same values:

```json
{
  "channel": "live",
  "version": "calliope-v1.0.0",
  "commit": "…",
  "builtAt": "2026-11-24T10:00:00Z",
  "ui": null,
  "widget": null,
  "libs": {}
}
```

UMO carries neither calliope-ui nor the connection widget and pins no library
fork, so `ui` and `widget` are `null` and `libs` is empty.

## Where the values come from

[`bin/build-info.js`](../bin/build-info.js), a copy of the Python editor's,
turns `BUILD_CHANNEL`, `BUILD_VERSION`, `BUILD_COMMIT` and `BUILD_AT` into
the object; without them the channel is `local` and version and commit come
from git. `vite.config.js` compiles it in as `__BUILD_INFO__`, and the
`calliope-build` workflow writes `node bin/build-info.js` to both
`BUILD.json`, so the file and the code always agree.

## Where it shows

UMO has no menu of its own for a version line. `src/app.vue` logs it once to
the console when the frame starts:

```
[umo] live calliope-v1.0.0 · 1a2b3c4 (built 2026-11-24T10:00:00Z)
```

Campus shows it in `/admin/versions`.
