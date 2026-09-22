import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { markRaw } from 'vue'
import * as Y from 'yjs'

// Awareness carets need a stable, readable colour per user. Picking from a
// fixed palette by hashing the user id keeps the same person the same colour
// across reloads and across clients without any server coordination.
export const collaborationCaretColors = [
  '#f5222d',
  '#fa8c16',
  '#faad14',
  '#52c41a',
  '#13c2c2',
  '#1677ff',
  '#2f54eb',
  '#722ed1',
  '#eb2f96',
]

const hashString = (value) => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash)
}

export const collaborationCaretColor = (seed) => {
  const key = String(seed ?? '')
  if (key === '') {
    return collaborationCaretColors[0]
  }
  return collaborationCaretColors[
    hashString(key) % collaborationCaretColors.length
  ]
}

/**
 * Normalised view of `options.collaboration`.
 *
 * `enabled` is only true once a Y.Doc is actually available — the option alone
 * is not enough, because the embedder may still be creating the provider.
 */
export const getCollaborationConfig = (editorOptions) => {
  const options = editorOptions?.value ?? editorOptions ?? {}
  const collaboration = options.collaboration ?? {}
  const document = collaboration.document ?? null

  return {
    ...collaboration,
    enabled: Boolean(collaboration.enabled && document),
    document,
    provider: collaboration.provider ?? null,
    field: collaboration.field || 'default',
    showCarets: collaboration.showCarets !== false,
    autoSeed: collaboration.autoSeed !== false,
    user: resolveCollaborationUser(options),
  }
}

export const isCollaborationEnabled = (editorOptions) =>
  getCollaborationConfig(editorOptions).enabled

/**
 * The identity published through awareness. Falls back to `options.user` so an
 * embedder that already configures the mention/user option gets carets for free.
 */
export const resolveCollaborationUser = (editorOptions) => {
  const options = editorOptions?.value ?? editorOptions ?? {}
  const collaboration = options.collaboration ?? {}
  const user = collaboration.user ?? options.user ?? {}
  const id = user.id ?? user.clientId ?? ''
  const name = user.name ?? user.label ?? user.nickname ?? ''

  return {
    ...user,
    id,
    name,
    color: user.color || collaborationCaretColor(id || name),
  }
}

/**
 * Creates the Y.Doc the editor will bind to.
 *
 * `markRaw` is not cosmetic here: `options` is a deep `ref`, so without it Vue
 * would wrap the Y.Doc in a reactive proxy (breaking Yjs' internal identity
 * checks) and every deep watcher would walk the whole CRDT on each change.
 */
export const createCollaborationDocument = () => markRaw(new Y.Doc())

/**
 * True when nobody other than us has ever written to this room.
 *
 * Checking whether the fragment is empty would not work: binding the editor to
 * an empty Y.Doc immediately writes a trailing paragraph into it, so by the
 * time sync completes the fragment is never empty. The state vector answers the
 * question directly — it lists every client that has ever contributed an update,
 * so a room nobody has touched contains only our own clientID (or nothing yet).
 */
export const isCollaborationRoomPristine = (document) => {
  if (!document) {
    return false
  }
  const contributors = Y.decodeStateVector(Y.encodeStateVector(document))
  for (const clientId of contributors.keys()) {
    if (clientId !== document.clientID) {
      return false
    }
  }
  return true
}

/**
 * The editor's undo/redo toolbar is driven by a custom history stack that reads
 * `editor.state.history$` (the prosemirror-history plugin state). Yjs replaces
 * that plugin with its own UndoManager, so translate the UndoManager's stacks
 * into the same `{ done, undone }` shape the history recorder expects.
 */
export const getEditorHistoryState = (editor, collaborationEnabled = false) => {
  if (!editor?.state) {
    return null
  }
  if (!collaborationEnabled) {
    return editor.state.history$
  }

  const { undoManager } = yUndoPluginKey.getState(editor.state) ?? {}
  if (!undoManager) {
    return null
  }

  return {
    done: { eventCount: undoManager.undoStack.length },
    undone: { eventCount: undoManager.redoStack.length },
  }
}

const providerOnce = (provider, events, handler) => {
  if (!provider?.on) {
    return () => {}
  }
  const wrapped = (...args) => handler(...args)
  for (const event of events) {
    provider.on(event, wrapped)
  }
  return () => {
    for (const event of events) {
      provider.off?.(event, wrapped)
    }
  }
}

/**
 * Runs `handler` as soon as the provider has applied the server's state.
 * Supports both Hocuspocus (`synced`) and y-websocket (`sync`); if the provider
 * is already synced the handler runs immediately.
 */
export const onCollaborationSynced = (provider, handler) => {
  if (!provider) {
    handler()
    return () => {}
  }
  if (provider.isSynced || provider.synced) {
    handler()
    return () => {}
  }
  return providerOnce(provider, ['synced', 'sync'], (payload) => {
    // y-websocket emits `sync` with a boolean, Hocuspocus emits an object.
    if (payload === false) {
      return
    }
    handler()
  })
}

/**
 * Builds a Hocuspocus session for embedders that just want to point the editor
 * at a room. Imported lazily so builds without collaboration never pull the
 * provider (and its websocket/auth machinery) into the main chunk.
 */
export const createHocuspocusSession = async ({
  url,
  name,
  token,
  parameters,
  document = createCollaborationDocument(),
  onStatus,
  onSynced,
  onAuthenticationFailed,
}) => {
  if (!url || !name) {
    throw new Error(
      '[umo-editor] collaboration: both "url" and "name" are required.',
    )
  }

  const { HocuspocusProvider } = await import('@hocuspocus/provider')
  const provider = markRaw(
    new HocuspocusProvider({
      url,
      name,
      document,
      ...(token ? { token } : {}),
      ...(parameters ? { parameters } : {}),
      onStatus: ({ status }) => onStatus?.(status),
      onSynced: () => onSynced?.(),
      onAuthenticationFailed: (payload) => onAuthenticationFailed?.(payload),
    }),
  )

  return {
    document,
    provider,
    destroy() {
      provider.destroy()
      document.destroy()
    },
  }
}
