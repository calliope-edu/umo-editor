<!--
  Calliope Campus deployment entry.

  This replaces the upstream Umo Editor demo (recoverable from git history) with
  the thin wrapper the campus embeds as an iframe. It speaks the campus
  postMessage protocol and mounts <umo-editor> from THIS repo's source (the
  plugin is registered in src/main.js via ./components), so the campus editor
  ships with this fork's translations and needs no separate package.

  Built for hosting via `pnpm build:campus` (→ dist/, base '/') on Cloudflare
  Pages, and served locally on :4174 via `pnpm dev:campus`.

  Protocol (campus ⇄ iframe), scoped by the `?instance=` query param:
    campus → iframe (source 'calliope-campus'):    umo:init | umo:update-content | umo:update-props
    iframe → campus (source 'calliope-campus-umo'): umo:ready | umo:changed | umo:saved
                                                   | umo:collab-status
  content is { html, json, text, version }.

  Collaborative mode: when `umo:init` carries a `collaboration` block
  ({ url, room, token, parameters, user }) the frame opens its own Hocuspocus
  connection and the Y.Doc becomes the source of truth. `payload.content` then
  only seeds the room if nobody has ever written to it, and `umo:update-content`
  is ignored — pushing host content into a live CRDT would clobber other
  people's edits. `umo:changed` keeps firing so the campus can still snapshot.
-->
<template>
  <div class="umo-shell">
    <umo-editor
      v-if="hasReceivedInit"
      ref="editorRef"
      :key="editorRenderKey"
      v-bind="options"
      @created="handleCreated"
      @changed="handleChanged"
      @saved="handleSaved"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import { createHocuspocusSession } from '@/utils/collaboration'

const editorRef = ref(null)
const instanceId =
  new URLSearchParams(window.location.search).get('instance') || 'default'
const hasReceivedInit = ref(false)

const options = ref(createDefaultOptions())

// Hocuspocus session state. Kept outside `options` on purpose — only the
// resolved Y.Doc/provider go in there (already markRaw'd), never this bookkeeping.
const collabRoom = ref('')
let collabSession = null
let collabConfig = null

const editorRenderKey = computed(() => {
  const disabled = Array.isArray(options.value.disableExtensions)
    ? [...options.value.disableExtensions].sort().join(',')
    : ''

  return [
    options.value.editorKey || 'calliope-campus-umo',
    options.value.locale || 'en-US',
    disabled,
    // A new room means a new Y.Doc, and the editor binds its Y.Doc once at
    // construction — so a room switch has to remount the editor.
    collabRoom.value || '',
  ].join('::')
})

function createDefaultOptions() {
  return {
    editorKey: 'calliope-campus-umo',
    locale: 'en-US',
    height: '100%',
    fullscreenZIndex: 30,
    toolbar: {
      showSaveLabel: false,
    },
    disableExtensions: [],
    page: {
      layouts: ['page', 'web'],
      showBreakMarks: false,
      showToc: false,
    },
    document: {
      title: 'Untitled',
      content: '<p></p>',
      readOnly: false,
      autofocus: false,
      enableMarkdown: true,
      enableBubbleMenu: true,
      enableBlockMenu: true,
      autoSave: {
        enabled: false,
      },
    },
    // editor-external assets (fonts, templates, page backgrounds). Pinned to the
    // @umoteam/editor-external version this fork depends on (see package.json).
    cdnUrl: 'https://unpkg.com/@umoteam/editor-external@10.1.0',
    shareUrl: window.location.origin,
    user: {
      id: 'calliope-campus',
      label: 'Calliope Campus',
    },
    collaboration: {
      enabled: false,
      document: null,
      provider: null,
    },
    async onSave() {
      postToParent('umo:saved', { content: serializeContent() })
      return true
    },
    async onFileUpload(file) {
      if (!file) {
        throw new Error('No file found to upload')
      }

      return {
        id: crypto.randomUUID(),
        url: file.url || URL.createObjectURL(file),
        name: file.name,
        type: file.type,
        size: file.size,
      }
    },
    onFileDelete(id, url) {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        URL.revokeObjectURL(url)
      }
      console.debug('Deleted file from Umo editor', id, url)
    },
  }
}

function normalizeCollaborationPayload(value) {
  if (!value || typeof value !== 'object' || !value.url || !value.room) {
    return null
  }

  return {
    url: String(value.url),
    room: String(value.room),
    token: value.token ? String(value.token) : '',
    parameters:
      value.parameters && typeof value.parameters === 'object'
        ? value.parameters
        : undefined,
    field:
      typeof value.field === 'string' && value.field ? value.field : 'default',
    showCarets: value.showCarets !== false,
    user:
      value.user && typeof value.user === 'object'
        ? value.user
        : { id: options.value.user?.id, name: options.value.user?.label },
  }
}

function sameCollaborationTarget(a, b) {
  if (!a || !b) {
    return a === b
  }
  return a.url === b.url && a.room === b.room && a.token === b.token
}

function destroyCollaborationSession() {
  const session = collabSession
  collabSession = null
  collabConfig = null
  collabRoom.value = ''
  options.value = {
    ...options.value,
    collaboration: { enabled: false, document: null, provider: null },
  }
  // Drop the connection only once the editor has re-rendered without it —
  // tearing down the Y.Doc under a live ySyncPlugin throws on unbind.
  if (session) {
    nextTick(() => session.destroy())
  }
}

async function startCollaborationSession(config) {
  if (collabSession) {
    destroyCollaborationSession()
  }

  try {
    collabSession = await createHocuspocusSession({
      url: config.url,
      name: config.room,
      token: config.token,
      parameters: config.parameters,
      onStatus: (status) =>
        postToParent('umo:collab-status', { room: config.room, status }),
      onSynced: () =>
        postToParent('umo:collab-status', {
          room: config.room,
          status: 'synced',
        }),
      onAuthenticationFailed: () =>
        postToParent('umo:collab-status', {
          room: config.room,
          status: 'auth-failed',
        }),
    })
  } catch (error) {
    // A failed connection must not leave the user staring at nothing: fall back
    // to the single-player editor and let the campus decide how to surface it.
    console.error('[umo] collaboration setup failed', error)
    postToParent('umo:collab-status', {
      room: config.room,
      status: 'error',
      message: String(error?.message || error),
    })
    return false
  }

  collabConfig = config
  collabRoom.value = config.room
  options.value = {
    ...options.value,
    collaboration: {
      enabled: true,
      document: collabSession.document,
      provider: collabSession.provider,
      field: config.field,
      showCarets: config.showCarets,
      user: config.user,
    },
  }
  return true
}

function isCollaborating() {
  return Boolean(collabSession)
}

function postToParent(type, payload = {}) {
  window.parent.postMessage(
    {
      source: 'calliope-campus-umo',
      type,
      instanceId,
      payload,
    },
    '*',
  )
}

function isTiptapDocument(value) {
  return !!value && typeof value === 'object' && value.type === 'doc'
}

function normalizeIncomingContent(value) {
  if (!value || typeof value !== 'object') {
    return '<p></p>'
  }

  if (isTiptapDocument(value.json)) {
    return value.json
  }

  if (typeof value.html === 'string' && value.html.trim()) {
    return value.html
  }

  if (typeof value.text === 'string' && value.text.trim()) {
    return `<p>${value.text}</p>`
  }

  return '<p></p>'
}

function serializeContent() {
  const content = {
    html: editorRef.value?.getHTML?.() || '',
    json: editorRef.value?.getJSON?.() || null,
    text: editorRef.value?.getText?.() || '',
    version: 1,
  }

  return JSON.parse(JSON.stringify(content))
}

function toPlainObject(value) {
  if (value == null) {
    return value
  }

  return JSON.parse(JSON.stringify(value))
}

function getSafeDocumentTitle(value, fallback) {
  const title = String(value || '').trim()
  return title || fallback
}

function serializeFrameContent(value) {
  return {
    key: options.value.editorKey,
    content: toPlainObject(value),
    // In a shared room `changed` also fires for other people's edits, so the
    // host can tell an autosave-worthy local change from an incoming one.
    collaborative: isCollaborating(),
    room: collabRoom.value || null,
  }
}

function syncStoredLocale(locale) {
  if (typeof locale !== 'string' || !locale.trim()) {
    return
  }

  window.localStorage.setItem('umo-editor:locale', locale)
}

function applyFrameState(payload, { syncContent = false } = {}) {
  const title = getSafeDocumentTitle(
    payload.title,
    options.value.document.title,
  )
  const disableExtensions = Array.isArray(payload.disableExtensions)
    ? Array.from(
        new Set(
          payload.disableExtensions
            .filter((value) => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      )
    : Array.isArray(options.value.disableExtensions)
      ? options.value.disableExtensions
      : []
  const nextOptions = {
    ...options.value,
    editorKey: payload.key || options.value.editorKey,
    locale: payload.locale || options.value.locale,
    disableExtensions,
    document: {
      ...options.value.document,
      title,
      readOnly: Boolean(payload.readonly),
      content: syncContent
        ? normalizeIncomingContent(payload.content)
        : options.value.document.content,
    },
  }

  syncStoredLocale(nextOptions.locale)
  options.value = nextOptions

  if (!hasReceivedInit.value) {
    hasReceivedInit.value = true
    return
  }

  if (!editorRef.value) {
    return
  }

  editorRef.value.setReadOnly?.(nextOptions.document.readOnly)
  editorRef.value.setDocument?.({
    title,
    markdown: true,
    spellcheck: true,
    bubbleMenu: true,
    blockMenu: true,
  })

  // In a shared room the Y.Doc is authoritative. Replaying the host's copy of
  // the content here would overwrite whatever the other participants just typed.
  if (syncContent && !isCollaborating()) {
    editorRef.value.setContent?.(normalizeIncomingContent(payload.content), {
      emitUpdate: false,
      focusPosition: false,
    })
  }
}

// Reconciles the room requested by the host with the one we are connected to.
// Returns false when a connection was requested but could not be established,
// so the caller can still bring up the editor in single-player mode.
async function syncCollaborationTarget(payload) {
  const requested = normalizeCollaborationPayload(payload.collaboration)

  if (!requested) {
    if (collabSession) {
      destroyCollaborationSession()
    }
    return true
  }

  if (sameCollaborationTarget(requested, collabConfig)) {
    return true
  }

  return await startCollaborationSession(requested)
}

async function handleFrameMessage(data) {
  if (data.type === 'umo:init') {
    await syncCollaborationTarget(data.payload || {})
    applyFrameState(data.payload || {}, { syncContent: true })
    return
  }

  if (data.type === 'umo:update-content') {
    applyFrameState(data.payload || {}, { syncContent: true })
    return
  }

  if (data.type === 'umo:update-props') {
    // A room switch arrives here when the host moves the user to another
    // document without tearing the iframe down.
    if (data.payload && 'collaboration' in data.payload) {
      await syncCollaborationTarget(data.payload || {})
    }
    applyFrameState(data.payload || {}, { syncContent: false })
  }
}

function handleMessage(event) {
  const data = event.data
  if (
    !data ||
    data.source !== 'calliope-campus' ||
    data.instanceId !== instanceId
  ) {
    return
  }

  void handleFrameMessage(data)
}

function handleCreated() {
  postToParent('umo:ready')
}

// In a shared room every participant's keystroke reaches every frame, so
// forwarding each one would multiply the host's snapshot writes by the number of
// people in the document. Coalesce them instead, with a ceiling so a long stretch
// of continuous typing still checkpoints on the way through.
const COLLAB_CHANGE_IDLE_MS = 1500
const COLLAB_CHANGE_MAX_WAIT_MS = 6000
let pendingChangeTimer = null
let pendingChangeSince = 0

function flushPendingChange() {
  if (pendingChangeTimer !== null) {
    clearTimeout(pendingChangeTimer)
    pendingChangeTimer = null
  }
  if (!pendingChangeSince) {
    return
  }
  pendingChangeSince = 0
  postToParent('umo:changed', serializeFrameContent(serializeContent()))
}

function handleChanged() {
  if (!isCollaborating()) {
    postToParent('umo:changed', serializeFrameContent(serializeContent()))
    return
  }

  const now = Date.now()
  if (!pendingChangeSince) {
    pendingChangeSince = now
  }
  if (now - pendingChangeSince >= COLLAB_CHANGE_MAX_WAIT_MS) {
    flushPendingChange()
    return
  }
  if (pendingChangeTimer !== null) {
    clearTimeout(pendingChangeTimer)
  }
  pendingChangeTimer = setTimeout(flushPendingChange, COLLAB_CHANGE_IDLE_MS)
}

function handleSaved() {
  if (pendingChangeTimer !== null) {
    clearTimeout(pendingChangeTimer)
    pendingChangeTimer = null
  }
  pendingChangeSince = 0
  postToParent('umo:saved', serializeFrameContent(serializeContent()))
}

onMounted(() => {
  window.addEventListener('message', handleMessage)
  // Never let a coalesced change die with the tab.
  window.addEventListener('pagehide', flushPendingChange)
  document.addEventListener('visibilitychange', flushPendingChange)
  postToParent('umo:ready')
})

onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage)
  window.removeEventListener('pagehide', flushPendingChange)
  document.removeEventListener('visibilitychange', flushPendingChange)
  flushPendingChange()
  destroyCollaborationSession()
})
</script>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}

body {
  overflow: hidden;
  background: #fff;
}

.umo-shell {
  height: 100%;
}
</style>
