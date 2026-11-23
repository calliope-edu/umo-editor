<!--
  Calliope Campus deployment entry.

  This replaces the upstream Umo Editor demo (recoverable from git history) with
  the thin wrapper the campus embeds as an iframe. It speaks the campus
  postMessage protocol and mounts <umo-editor> from THIS repo's source (the
  plugin is registered in src/main.js via ./components), so the campus editor
  ships with this fork's translations and needs no separate package.

  Built for hosting via `pnpm build:campus` (→ dist/, base '/') on Cloudflare
  Pages, and served locally on :4174 via `pnpm dev:campus`.

  Protocol (campus ⇄ iframe), scoped by the `?instance=` query param. Message
  names follow docs/design/2026-teilen-modi.md §7 (P7) in the campus repo:

    campus → iframe   (source 'calliope-campus')
      umo:init            single-player start, carries the content
      umo:update-content  new content from the host (ignored while collaborating)
      umo:update-props    locale / readonly / disabled extensions
      umo:coop-init       join a shared document
      umo:coop-token      a fresh token, in reply to umo:coop-token-needed
      umo:coop-stop       leave the shared document

    iframe → campus   (source 'calliope-campus-umo')
      umo:ready              the editor is up
      umo:changed           derived snapshot { html, json, text, version }
      umo:saved             the same, on explicit save
      umo:coop-state        connecting · synced · disconnected · auth-failed · error
      umo:coop-token-needed the current token is about to expire

  Collaborative mode: on `umo:coop-init` the frame opens its OWN Hocuspocus
  connection (P7, Entscheidung 1) and the Y.Doc becomes the truth. The campus
  sends no content, and `umo:update-content` is ignored — a setContent would
  insert the document a second time. `umo:changed` keeps flowing, but it is now
  the derived snapshot rather than the source of truth.

  Everything after the first inbound campus message is posted to that message's
  origin, not '*': awareness carries pupils' real names, and the token travels
  the other way.
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

// The editor's lazily loaded libraries (KaTeX, Mermaid, ECharts, …). A build
// carries its own copy of the pinned @umoteam/editor-external under
// `external/` (bin/copy-external.js): Campus serves the build on its own
// origin, where a script from a CDN would run with Campus's rights. The dev
// server has no such copy and takes the same version from unpkg.
const EXTERNAL_URL = import.meta.env.PROD
  ? `${import.meta.env.BASE_URL}external`
  : 'https://unpkg.com/@umoteam/editor-external@11.0.0'

const options = ref(createDefaultOptions())

// Shared-document (coop) state. Deliberately outside `options`: only the
// resolved Y.Doc/provider go in there, and those are markRaw'd so Vue never
// proxies the CRDT. Keeping this here also means the session survives the
// `editorRenderKey` remounts a locale change triggers (P7, Wrapper note 2).
const coopDocName = ref('')
let coopSession = null
let coopConfig = null
let coopToken = ''
let coopTokenIssuedAt = 0
let coopTokenWaiters = []

const editorRenderKey = computed(() => {
  const disabled = Array.isArray(options.value.disableExtensions)
    ? [...options.value.disableExtensions].sort().join(',')
    : ''

  return [
    options.value.editorKey || 'calliope-campus-umo',
    options.value.locale || 'en-US',
    disabled,
    // A new shared document means a new Y.Doc, and the editor binds its Y.Doc
    // once at construction, so a document switch has to remount the editor.
    coopDocName.value || '',
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
    cdnUrl: EXTERNAL_URL,
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
    // The editor emits `saved` once this resolves; handleSaved posts it.
    async onSave() {
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

// The token route mints one-hour tokens (HOCO_TOKEN_TTL_MS). Ask for a new one
// well before that so a reconnect never races the expiry.
const COOP_TOKEN_REFRESH_AFTER_MS = 45 * 60 * 1000
const COOP_TOKEN_WAIT_MS = 5000

function normalizeCoopPayload(value) {
  if (!value || typeof value !== 'object') {
    return null
  }
  const wsUrl = String(value.wsUrl || '')
  const docName = String(value.docName || '')
  if (!wsUrl || !docName) {
    return null
  }
  return {
    wsUrl,
    docName,
    // Top-level fragment name. `prose` is the campus default (P7,
    // Entscheidung 2) — nested fragments race two clients into two fragments.
    field:
      typeof value.field === 'string' && value.field ? value.field : 'prose',
    canWrite: value.canWrite !== false,
    // Only the client the host nominates may seed, and only if it actually sent
    // something to seed WITH. Without this every recipient would also consider
    // itself a seeder and race an empty paragraph into a pristine document
    // against the real content.
    autoSeed: value.autoSeed === true && value.content !== undefined,
    user:
      value.user && typeof value.user === 'object'
        ? value.user
        : { id: options.value.user?.id, name: options.value.user?.label },
  }
}

function sameCoopTarget(a, b) {
  return Boolean(a && b && a.wsUrl === b.wsUrl && a.docName === b.docName)
}

function setCoopToken(token) {
  const next = String(token || '')
  if (!next) {
    return
  }
  coopToken = next
  coopTokenIssuedAt = Date.now()
  const waiters = coopTokenWaiters
  coopTokenWaiters = []
  for (const waiter of waiters) {
    clearTimeout(waiter.timer)
    waiter.resolve(coopToken)
  }
}

// Handed to the provider as a *function*, which Hocuspocus awaits on every
// (re)connect — that is the hook the refresh hangs off.
async function resolveCoopToken() {
  const isFresh = Date.now() - coopTokenIssuedAt < COOP_TOKEN_REFRESH_AFTER_MS
  if (coopToken && isFresh) {
    return coopToken
  }

  postToParent('umo:coop-token-needed', { docName: coopConfig?.docName || '' })

  return await new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        coopTokenWaiters = coopTokenWaiters.filter((item) => item !== waiter)
        // Better a stale token the server will reject (surfacing as
        // `auth-failed`) than a connection that never gets attempted.
        resolve(coopToken)
      }, COOP_TOKEN_WAIT_MS),
    }
    coopTokenWaiters.push(waiter)
  })
}

function postCoopState(state, extra = {}) {
  postToParent('umo:coop-state', {
    docName: coopConfig?.docName || coopDocName.value || '',
    state,
    ...extra,
  })
}

function stopCoopSession() {
  const session = coopSession
  coopSession = null
  coopConfig = null
  coopToken = ''
  coopTokenIssuedAt = 0
  for (const waiter of coopTokenWaiters) {
    clearTimeout(waiter.timer)
    waiter.resolve('')
  }
  coopTokenWaiters = []
  coopDocName.value = ''
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

async function startCoopSession(config, token) {
  if (coopSession) {
    stopCoopSession()
  }

  coopConfig = config
  setCoopToken(token)
  postCoopState('connecting')

  try {
    coopSession = await createHocuspocusSession({
      url: config.wsUrl,
      name: config.docName,
      token: resolveCoopToken,
      onStatus: (status) =>
        postCoopState(status === 'connected' ? 'connected' : status),
      onSynced: () => postCoopState('synced'),
      onAuthenticationFailed: () => postCoopState('auth-failed'),
    })
  } catch (error) {
    // A failed connection must not leave the user staring at nothing: fall back
    // to the single-player editor and let the campus decide how to surface it.
    console.error('[umo] coop setup failed', error)
    coopConfig = null
    postCoopState('error', { message: String(error?.message || error) })
    return false
  }

  coopDocName.value = config.docName
  options.value = {
    ...options.value,
    document: {
      ...options.value.document,
      // A recipient of a read-only live share still joins the document; the
      // sync server enforces it too, this just stops the caret from blinking.
      readOnly: !config.canWrite,
    },
    collaboration: {
      enabled: true,
      document: coopSession.document,
      provider: coopSession.provider,
      field: config.field,
      showCarets: true,
      autoSeed: config.autoSeed,
      user: config.user,
    },
  }
  return true
}

function isCollaborating() {
  return Boolean(coopSession)
}

// Pinned to the origin of the first campus message we accept. Until then the
// only thing we send is `umo:ready`, which carries nothing — everything with
// content in it (awareness names, snapshots, token requests) waits for the pin.
let parentOrigin = ''

function postToParent(type, payload = {}) {
  if (!parentOrigin && type !== 'umo:ready') {
    console.warn(`[umo] dropped ${type}: parent origin not pinned yet`)
    return
  }

  window.parent.postMessage(
    {
      source: 'calliope-campus-umo',
      type,
      instanceId,
      payload,
    },
    parentOrigin || '*',
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
    // While collaborating this is the DERIVED snapshot, not the truth, and it
    // also fires for other people's edits — so say which document it came from.
    collaborative: isCollaborating(),
    docName: coopDocName.value || null,
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
      // A read-only participant of a shared document stays read-only even if
      // the host forgets to repeat it on a later `umo:update-props`.
      readOnly: Boolean(payload.readonly) || coopConfig?.canWrite === false,
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

async function handleFrameMessage(data) {
  const payload = data.payload || {}

  if (data.type === 'umo:init') {
    applyFrameState(payload, { syncContent: true })
    return
  }

  if (data.type === 'umo:update-content') {
    applyFrameState(payload, { syncContent: true })
    return
  }

  if (data.type === 'umo:update-props') {
    applyFrameState(payload, { syncContent: false })
    return
  }

  if (data.type === 'umo:coop-init') {
    const requested = normalizeCoopPayload(payload)
    if (!requested) {
      postCoopState('error', {
        message: 'umo:coop-init needs wsUrl and docName',
      })
      return
    }
    // Re-sending the same target (a reconnect nudge, or a prop update that
    // happens to carry it) must not tear a working session down.
    if (!sameCoopTarget(requested, coopConfig)) {
      await startCoopSession(requested, payload.token)
    } else {
      setCoopToken(payload.token)
    }
    // coop-init doubles as an init when the campus skips `umo:init` entirely.
    // `syncContent` is safe here even though we are collaborating: it only
    // parks the payload as `document.content` — the seed candidate the editor
    // applies if and only if the document turns out to be pristine — while the
    // `setContent` call inside is already gated on `isCollaborating()`.
    applyFrameState(payload, { syncContent: true })
    return
  }

  if (data.type === 'umo:coop-token') {
    setCoopToken(payload.token)
    return
  }

  if (data.type === 'umo:coop-stop') {
    stopCoopSession()
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

  // `event.origin` is set by the browser and cannot be forged, so it — not a
  // field in the payload — is what we pin to. A later message from a different
  // origin is a different window claiming to be the campus: drop it.
  if (!parentOrigin) {
    parentOrigin = event.origin
  } else if (event.origin !== parentOrigin) {
    console.warn(`[umo] ignored campus message from ${event.origin}`)
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
  // UMO runs only inside Campus and has no menu of its own for a version
  // line; its version is BUILD.json next to the build and this one line
  // (docs/build-info.md).
  const build = __BUILD_INFO__
  console.info(
    `[umo] ${build.channel} ${build.version} · ${build.commit.slice(0, 7)} (built ${build.builtAt})`,
  )
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
  stopCoopSession()
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
