<template>
  <tooltip v-if="collaboration.enabled" :content="tooltipContent">
    <div class="umo-collaborators" :class="`is-${status}`">
      <icon name="collaborators" />
      <span class="umo-collaborators-dots">
        <span
          v-for="user in visibleUsers"
          :key="user.clientId"
          class="umo-collaborators-dot"
          :style="{ backgroundColor: user.color }"
        >
          {{ user.initial }}
        </span>
        <span v-if="overflowCount > 0" class="umo-collaborators-dot is-more">
          +{{ overflowCount }}
        </span>
      </span>
    </div>
  </tooltip>
</template>

<script setup>
import {
  collaborationCaretColor,
  getCollaborationConfig,
} from '@/utils/collaboration'

const MAX_VISIBLE = 4

const options = inject('options')
const editor = inject('editor')

const collaboration = $computed(() => getCollaborationConfig(options))

let status = $ref('connecting')
let peers = $ref([])

const initialOf = (name) => {
  const label = String(name || '').trim()
  return label ? label.slice(0, 1).toUpperCase() : '?'
}

// `awareness` is the single source of truth for who is in the room.
// `editor.storage.collaborationCaret.users` mirrors it, but it is a plain
// object the extension mutates, so it would never trigger a re-render.
const readPeers = () => {
  const { awareness } = collaboration.provider ?? {}
  if (!awareness) {
    peers = []
    return
  }
  const localClientId = awareness.clientID
  const seen = new Map()
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === localClientId) {
      continue
    }
    const user = state?.user
    if (!user) {
      continue
    }
    const key = user.id || `client-${clientId}`
    if (seen.has(key)) {
      continue
    }
    const name = user.name || user.label || ''
    seen.set(key, {
      clientId,
      name,
      initial: initialOf(name),
      color: user.color || collaborationCaretColor(user.id || name),
    })
  }
  peers = [...seen.values()]
}

const visibleUsers = $computed(() => peers.slice(0, MAX_VISIBLE))
const overflowCount = $computed(() => Math.max(0, peers.length - MAX_VISIBLE))

const tooltipContent = $computed(() => {
  if (status !== 'connected') {
    return t(`collaboration.status.${status}`)
  }
  if (peers.length === 0) {
    return t('collaboration.alone')
  }
  return `${t('collaboration.others')}: ${peers
    .map((user) => user.name || t('collaboration.anonymous'))
    .join(', ')}`
})

const onStatus = (payload) => {
  const next = typeof payload === 'string' ? payload : payload?.status
  status = next || 'connecting'
}

onMounted(() => {
  const { provider } = collaboration
  if (!provider) {
    return
  }
  // Hocuspocus only emits `status` on transitions, so seed from the provider
  // in case it connected before this component mounted.
  if (provider.isSynced || provider.synced) {
    status = 'connected'
  }
  provider.on?.('status', onStatus)
  provider.awareness?.on('change', readPeers)
  readPeers()
})

onBeforeUnmount(() => {
  const { provider } = collaboration
  provider?.off?.('status', onStatus)
  provider?.awareness?.off('change', readPeers)
})

watch(
  () => editor.value,
  () => readPeers(),
)
</script>

<style lang="less" scoped>
.umo-collaborators {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  height: 24px;
  color: var(--umo-text-color-light);
  cursor: default;

  &.is-connected {
    color: var(--umo-text-color);
  }

  &.is-disconnected,
  &.is-error,
  &.is-auth-failed {
    color: var(--umo-error-color);
  }
}

.umo-collaborators-dots {
  display: flex;
  align-items: center;
}

.umo-collaborators-dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: -4px;
  border: 1px solid var(--umo-color-white);
  border-radius: 50%;
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;

  &:first-child {
    margin-left: 0;
  }

  &.is-more {
    background-color: var(--umo-text-color-light);
  }
}
</style>
