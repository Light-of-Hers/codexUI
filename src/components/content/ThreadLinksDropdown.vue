<template>
  <div ref="rootRef" class="thread-links-dropdown">
    <button
      class="thread-links-trigger"
      type="button"
      :disabled="disabled"
      :title="triggerTitle"
      :aria-label="triggerTitle"
      @click="toggleOpen"
    >
      <IconTablerLink class="thread-links-trigger-icon" />
      <span class="thread-links-count">{{ isLoading ? '…' : links.length }}</span>
      <IconTablerChevronDown class="thread-links-trigger-chevron" />
    </button>

    <div v-if="isOpen" class="thread-links-menu-wrap">
      <div class="thread-links-menu">
        <div class="thread-links-search-wrap">
          <IconTablerSearch class="thread-links-search-icon" />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            class="thread-links-search"
            type="text"
            :placeholder="t('Search links')"
            @keydown.esc.prevent="onEscapeSearch"
          />
        </div>

        <div class="thread-links-body">
          <div v-if="isLoading" class="thread-links-loading">{{ t('Loading all messages…') }}</div>
          <template v-else>
          <div v-if="filteredWebLinks.length" class="thread-links-section">
            <div class="thread-links-section-header">{{ t('Links') }}</div>
            <a
              v-for="link in filteredWebLinks"
              :key="link.id"
              class="thread-links-row thread-links-web-row"
              :href="link.href"
              target="_blank"
              rel="noopener noreferrer"
              :title="link.value"
            >
              <IconTablerLink class="thread-links-row-icon" />
              <span class="thread-links-row-label">{{ link.label }}</span>
              <span class="thread-links-row-role">{{ link.role === 'user' ? 'user' : 'agent' }}</span>
              <button
                class="thread-links-copy"
                type="button"
                :title="copiedId === link.id ? t('Copied') : t('Copy')"
                :aria-label="t('Copy')"
                @click.stop="copyLink(link)"
              >
                <IconTablerCopy class="thread-links-copy-icon" />
              </button>
            </a>
          </div>

          <div v-if="fileRows.length" class="thread-links-section">
            <div class="thread-links-section-header">{{ t('Files') }}</div>
            <div
              v-for="row in fileRows"
              :key="row.node.path"
              class="thread-links-row thread-links-file-row"
              :style="{ paddingLeft: `${0.5 + row.depth * 0.9}rem` }"
            >
              <button
                v-if="isDir(row.node)"
                class="thread-links-dir-toggle"
                type="button"
                :title="row.node.path"
                @click="toggleDir(row.node.path)"
              >
                <IconTablerChevronRight class="thread-links-chevron" :class="{ 'is-expanded': isExpanded(row.node.path) }" />
                <IconTablerFolder class="thread-links-row-icon" />
                <span class="thread-links-row-label">{{ row.node.name }}</span>
              </button>
              <template v-else>
                <a
                  class="thread-links-file-link"
                  :href="row.node.link?.href || '#'"
                  :title="row.node.link?.value"
                  @click="onFileClick(row.node.link, $event)"
                >
                  <IconTablerFilePencil class="thread-links-row-icon" />
                  <span class="thread-links-row-label">{{ row.node.name }}</span>
                  <span v-if="row.node.link" class="thread-links-row-role">{{ row.node.link.role === 'user' ? 'user' : 'agent' }}</span>
                </a>
                <button
                  v-if="row.node.link"
                  class="thread-links-copy"
                  type="button"
                  :title="copiedId === row.node.link.id ? t('Copied') : t('Copy')"
                  :aria-label="t('Copy')"
                  @click.stop="copyLink(row.node.link)"
                >
                  <IconTablerCopy class="thread-links-copy-icon" />
                </button>
              </template>
            </div>
          </div>

          <div v-if="!filteredWebLinks.length && !fileRows.length" class="thread-links-empty">{{ t('No links found') }}</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ThreadLink } from '../../utils/threadLinks'
import { buildLinkTree, flattenLinkTree, isLinkDir, type LinkTreeNode } from '../../utils/threadLinks'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerCopy from '../icons/IconTablerCopy.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerLink from '../icons/IconTablerLink.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'

const props = defineProps<{
  links: ThreadLink[]
  isLoading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  ensureLoaded: []
}>()

const { t } = useUiLanguage()

const rootRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const isOpen = ref(false)
const searchQuery = ref('')
const expanded = ref<Set<string>>(new Set())
const copiedId = ref<string | null>(null)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

const triggerTitle = computed(() => t('Links'))
const isLoading = computed(() => props.isLoading === true)
const disabled = computed(() => props.disabled === true || (!isLoading.value && false))

const webLinks = computed(() => props.links.filter((link) => link.kind === 'web'))
const fileLinks = computed(() => props.links.filter((link) => link.kind === 'file'))
const fileTree = computed(() => buildLinkTree(fileLinks.value))

const queryText = computed(() => searchQuery.value.trim().toLowerCase())
const filteredWebLinks = computed(() => {
  const query = queryText.value
  if (!query) return webLinks.value
  return webLinks.value.filter((link) => (
    link.value.toLowerCase().includes(query)
    || link.label.toLowerCase().includes(query)
    || link.role.toLowerCase().includes(query)
  ))
})

function linkMatches(link: ThreadLink, query: string): boolean {
  return link.value.toLowerCase().includes(query)
    || link.label.toLowerCase().includes(query)
    || link.role.toLowerCase().includes(query)
}

const fileRows = computed(() => {
  const query = queryText.value
  if (query) {
    return fileLinks.value
      .filter((link) => linkMatches(link, query))
      .map((link) => ({
        node: { name: link.label, path: link.value, link, children: [] } as LinkTreeNode,
        depth: 0,
      }))
  }
  return flattenLinkTree(fileTree.value, expanded.value)
})

function isDir(node: LinkTreeNode): boolean {
  return isLinkDir(node)
}

function isExpanded(path: string): boolean {
  return expanded.value.has(path)
}

function toggleDir(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

function toggleOpen(): void {
  if (disabled.value) return
  isOpen.value = !isOpen.value
  if (isOpen.value) emit('ensureLoaded')
}

function onEscapeSearch(): void {
  if (searchQuery.value) {
    searchQuery.value = ''
    return
  }
  isOpen.value = false
}

function onFileClick(link: ThreadLink | null, event: MouseEvent): void {
  if (!link) {
    event.preventDefault()
    return
  }
  if (!link.href || link.href === '#') {
    event.preventDefault()
    void copyLink(link)
  }
}

async function copyLink(link: ThreadLink): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
  try {
    await navigator.clipboard.writeText(link.value)
    copiedId.value = link.id
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => {
      copiedId.value = null
    }, 1500)
  } catch {
    // Ignore clipboard errors; the row link still works as a fallback.
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return
  const root = rootRef.value
  const target = event.target
  if (!root || !(target instanceof Node) || root.contains(target)) return
  isOpen.value = false
  searchQuery.value = ''
}

watch(fileTree, (tree) => {
  expanded.value = new Set(tree.filter((node) => isLinkDir(node)).map((node) => node.path))
}, { immediate: true })

watch(isOpen, (open) => {
  if (open) {
    void nextTick(() => searchInputRef.value?.focus())
  } else {
    searchQuery.value = ''
  }
})

onMounted(() => window.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocumentPointerDown)
  if (copyResetTimer) clearTimeout(copyResetTimer)
})
</script>

<style scoped>
@reference "tailwindcss";

.thread-links-dropdown {
  @apply relative inline-flex min-w-0;
}

.thread-links-trigger {
  @apply inline-flex min-h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60;
}

.thread-links-trigger-icon,
.thread-links-trigger-chevron {
  @apply h-4 w-4 shrink-0;
}

.thread-links-count {
  @apply min-w-0 tabular-nums;
}

.thread-links-menu-wrap {
  @apply absolute right-0 top-[calc(100%+8px)] z-50;
}

.thread-links-menu {
  @apply w-96 max-w-[calc(100vw-1.5rem)] rounded-xl border border-zinc-200 bg-white p-1 shadow-lg;
}

.thread-links-search-wrap {
  @apply relative flex items-center px-1 py-1;
}

.thread-links-search-icon {
  @apply pointer-events-none absolute left-2.5 h-4 w-4 text-zinc-400;
}

.thread-links-search {
  @apply w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-2 text-xs text-zinc-800 outline-none transition focus:border-zinc-400;
}

.thread-links-body {
  @apply max-h-[22rem] overflow-y-auto;
}

.thread-links-loading {
  @apply px-2 py-3 text-center text-xs text-zinc-500;
}

.thread-links-section {
  @apply mt-1 first:mt-0;
}

.thread-links-section-header {
  @apply px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-400;
}

.thread-links-row {
  @apply flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100;
}

.thread-links-web-row {
  @apply text-zinc-700;
}

.thread-links-file-row {
  @apply py-1;
}

.thread-links-dir-toggle {
  @apply flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-0 py-0 text-left text-sm text-zinc-700;
}

.thread-links-file-link {
  @apply flex min-w-0 flex-1 items-center gap-1.5 text-sm text-zinc-700;
}

.thread-links-chevron {
  @apply h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform;
}

.thread-links-chevron.is-expanded {
  @apply rotate-90;
}

.thread-links-row-icon {
  @apply h-4 w-4 shrink-0 text-zinc-500;
}

.thread-links-row-label {
  @apply min-w-0 flex-1 truncate font-mono text-xs;
}

.thread-links-row-role {
  @apply shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[0.6rem] uppercase text-zinc-500;
}

.thread-links-copy {
  @apply flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-600;
}

.thread-links-copy-icon {
  @apply h-3.5 w-3.5;
}

.thread-links-empty {
  @apply px-2 py-3 text-center text-xs text-zinc-500;
}

:global(:root.dark .thread-links-trigger) {
  @apply border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800;
}

:global(:root.dark .thread-links-menu) {
  @apply border-zinc-700 bg-zinc-900;
}

:global(:root.dark .thread-links-search) {
  @apply border-zinc-700 bg-zinc-800 text-zinc-100;
}

:global(:root.dark .thread-links-search-icon) {
  @apply text-zinc-500;
}

:global(:root.dark .thread-links-loading) {
  @apply text-zinc-400;
}

:global(:root.dark .thread-links-section-header) {
  @apply text-zinc-500;
}

:global(:root.dark .thread-links-row) {
  @apply text-zinc-200 hover:bg-zinc-800;
}

:global(:root.dark .thread-links-dir-toggle) {
  @apply text-zinc-200;
}

:global(:root.dark .thread-links-file-link) {
  @apply text-zinc-200;
}

:global(:root.dark .thread-links-chevron) {
  @apply text-zinc-500;
}

:global(:root.dark .thread-links-row-icon) {
  @apply text-zinc-400;
}

:global(:root.dark .thread-links-row-role) {
  @apply bg-zinc-800 text-zinc-400;
}

:global(:root.dark .thread-links-copy) {
  @apply text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200;
}

:global(:root.dark .thread-links-empty) {
  @apply text-zinc-400;
}
</style>
