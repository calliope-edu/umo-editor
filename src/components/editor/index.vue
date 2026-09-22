<template>
  <editor-content
    class="umo-editor-content"
    :class="{
      'show-bookmark': page.showBookmark,
      'show-line-number': page.showLineNumber,
      'format-painter': editor?.view?.painter?.enabled,
      'is-empty': editor?.isEmpty && editor?.state.doc.childCount <= 1,
      'is-readonly': !editor?.isEditable,
    }"
    :editor="editor"
    :style="{
      lineHeight: defaultLineHeight,
    }"
    :spellcheck="
      options.document?.enableSpellcheck && $document.enableSpellcheck
    "
  />
  <template v-if="editor && !destroyed">
    <menus-block
      v-if="options.document?.enableBlockMenu"
      v-show="
        page.zoomLevel === 100 && !page.preview?.enabled && editor.isEditable
      "
    />
    <menus-bubble
      v-if="options.document?.enableBubbleMenu"
      v-show="!editor?.view?.painter?.enabled"
    >
      <template #bubble_menu="props">
        <slot name="bubble_menu" v-bind="props" />
      </template>
    </menus-bubble>
  </template>
</template>

<script setup>
import { migrateMathStrings } from '@tiptap/extension-mathematics'
import { Editor, EditorContent } from '@tiptap/vue-3'

import { getDefaultExtensions, inputAndPasteRules } from '@/extensions'
import {
  getCollaborationConfig,
  getEditorHistoryState,
  isCollaborationRoomPristine,
  onCollaborationSynced,
} from '@/utils/collaboration'
import { contentTransform } from '@/utils/content-transform'
import { addHistory } from '@/utils/history-record'
import { loadResource } from '@/utils/load-resource'

const destroyed = inject('destroyed')
const page = inject('page')
const options = inject('options')
const uploadFileMap = inject('uploadFileMap')
const historyRecords = inject('historyRecords')

const $document = useState('document', options)

const defaultLineHeight = $computed(
  () => options.value.dicts?.lineHeights?.find((item) => item.default)?.value,
)

const container = inject('container')
// Resolved once: the Y.Doc and provider are owned by the embedder and must not
// change under a live editor instance (`editorKey` remounts the whole editor).
const collaboration = getCollaborationConfig(options)
const extensions = getDefaultExtensions({
  container,
  options,
  uploadFileMap,
})

// 同步文档内容
let syncContentTimer = null
const syncDocumentContent = (targetEditor = editorInstance) => {
  if (!$document.value || !targetEditor) {
    return
  }
  $document.value.content = targetEditor.getHTML()
}
const scheduleSyncDocumentContent = () => {
  if (syncContentTimer !== null) {
    clearTimeout(syncContentTimer)
  }
  syncContentTimer = setTimeout(() => {
    syncContentTimer = null
    syncDocumentContent(editorInstance)
  }, 800)
}
const flushSyncDocumentContent = () => {
  if (syncContentTimer !== null) {
    clearTimeout(syncContentTimer)
    syncContentTimer = null
  }
  syncDocumentContent(editorInstance)
}

// 处理列表项的键盘事件
const getActiveListItemType = (selection) => {
  const { $from } = selection
  const { depth: maxDepth } = $from
  for (let depth = maxDepth; depth > 0; depth -= 1) {
    const currentNode = $from.node(depth)
    const nodeName = currentNode?.type?.name
    if (nodeName === 'listItem' || nodeName === 'taskItem') {
      return nodeName
    }
  }
  return null
}
const handleEditorKeyDown = (view, event) => {
  const customHandleKeyDown = options.value.document?.editorProps?.handleKeyDown
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  ) {
    const itemType = getActiveListItemType(view.state.selection)
    if (itemType && editorInstance.commands.splitListItem(itemType)) {
      event.preventDefault()
      return true
    }
  }
  return customHandleKeyDown?.(view, event) || false
}

const editorInstance = new Editor({
  editable: !options.value.document?.readOnly,
  autofocus: options.value.document?.autofocus,
  // When collaborating, the Y.Doc is the source of truth. Passing `content`
  // here would race the initial sync and duplicate the document for everyone
  // already in the room — initial content is seeded after sync instead.
  ...(collaboration.enabled
    ? {}
    : { content: contentTransform(options.value.document?.content) }),
  enableInputRules: inputAndPasteRules(options),
  enablePasteRules: inputAndPasteRules(options),
  editorProps: {
    attributes: {
      class: 'umo-editor',
    },
    ...options.value.document?.editorProps,
    handleKeyDown: handleEditorKeyDown,
  },
  // enableContentCheck: true,
  parseOptions: options.value.document?.parseOptions,
  extensions: [...extensions, ...options.value.extensions],
  onCreate({ editor }) {
    if (options.value.disableExtensions.includes('math')) {
      migrateMathStrings(editor)
    }
  },
  onUpdate({ editor }) {
    addHistory(
      historyRecords,
      'editor',
      getEditorHistoryState(editor, collaboration.enabled),
    )
    scheduleSyncDocumentContent()
  },
  onBlur() {
    flushSyncDocumentContent()
  },
})
const editor = inject('editor')
editor.value = editorInstance
editor.value.storage.container = container
watch(
  () => options.value,
  () => {
    editor.value.storage.options = options.value
  },
  { immediate: true, deep: true },
)

// Only the first client into a brand-new room writes the initial content —
// otherwise every joining client would append the document again. The second
// guard covers the case where the room is new to Yjs but the user already
// typed something before the connection came up.
let stopCollaborationSeed = null
const seedCollaborationContent = () => {
  if (!isCollaborationRoomPristine(collaboration.document)) {
    return
  }
  if (!editorInstance.isEmpty) {
    return
  }
  const content = contentTransform(options.value.document?.content)
  if (!content) {
    return
  }
  editorInstance.commands.setContent(content, {
    parseOptions: options.value.document?.parseOptions,
  })
}

onMounted(() => {
  const { disableExtensions, cdnUrl } = options.value
  const has = (name) => !disableExtensions.includes(name)
  const libUrl = `${cdnUrl}/libs`
  if (has('math')) {
    loadResource(`${libUrl}/katex/katex.min.css`, 'css', 'katex-style')
  }
  if (has('mermaid')) {
    loadResource(`${libUrl}/mermaid/mermaid.min.js`, 'script', 'mermaid-script')
  }
  window.addEventListener('beforeunload', flushSyncDocumentContent)
  window.addEventListener('pagehide', flushSyncDocumentContent)
  document.addEventListener('visibilitychange', flushSyncDocumentContent)
  if (collaboration.enabled && collaboration.autoSeed) {
    stopCollaborationSeed = onCollaborationSynced(
      collaboration.provider,
      () => {
        seedCollaborationContent()
      },
    )
  }
})

// 销毁编辑器实例
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', flushSyncDocumentContent)
  window.removeEventListener('pagehide', flushSyncDocumentContent)
  document.removeEventListener('visibilitychange', flushSyncDocumentContent)
  stopCollaborationSeed?.()
  flushSyncDocumentContent()
  // The Y.Doc and provider belong to the embedder, so they are deliberately
  // left alive here — only the editor binding goes away.
  editorInstance.unmount()
})
</script>

<style lang="less">
@import '@/assets/styles/editor.less';
@import '@/assets/styles/drager.less';
</style>
