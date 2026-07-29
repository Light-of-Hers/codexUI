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
            <div v-if="fuzzyWebLinks.length" class="thread-links-section">
              <div class="thread-links-section-header">{{ t('Links') }}</div>
              <a
                v-for="entry in fuzzyWebLinks"
                :key="entry.link.id"
                class="thread-links-row thread-links-web-row"
                :href="entry.link.href"
                target="_blank"
                rel="noopener noreferrer"
                :title="entry.link.value"
              >
                <IconTablerLink class="thread-links-row-icon" />
                <span class="thread-links-row-label" v-html="highlightHtml(entry.link.value, entry.indices)"></span>
                <span class="thread-links-row-role">{{ entry.link.role === 'user' ? 'user' : 'agent' }}</span>
                <button
                  class="thread-links-copy"
                  type="button"
                  :title="copiedId === entry.link.id ? t('Copied') : t('Copy')"
                  :aria-label="t('Copy')"
                  @click.stop="copyLink(entry.link)"
                >
                  <IconTablerCopy class="thread-links-copy-icon" />
                </button>
              </a>
            </div>

            <div v-if="fuzzyFileLinks.length" class="thread-links-section">
              <div class="thread-links-section-header">{{ t('Files') }}</div>
              <a
                v-for="entry in fuzzyFileLinks"
                :key="entry.link.id"
                class="thread-links-row thread-links-file-row"
                :href="entry.link.href || '#'"
                :title="entry.link.value"
                @click="onFileClick(entry.link, $event)"
              >
                <IconTablerFilePencil class="thread-links-row-icon" />
                <span class="thread-links-row-label" v-html="highlightHtml(entry.link.value, entry.indices)"></span>
                <span class="thread-links-row-role">{{ entry.link.role === 'user' ? 'user' : 'agent' }}</span>
                <button
                  class="thread-links-copy"
                  type="button"
                  :title="copiedId === entry.link.id ? t('Copied') : t('Copy')"
                  :aria-label="t('Copy')"
                  @click.stop="copyLink(entry.link)"
                >
                  <IconTablerCopy class="thread-links-copy-icon" />
                </button>
              </a>
            </div>

            <div v-if="!fuzzyWebLinks.length && !fuzzyFileLinks.length" class="thread-links-empty">{{ t('No links found') }}</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ThreadLink } from '../../utils/threadLinks'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerCopy from '../icons/IconTablerCopy.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerLink from '../icons/IconTablerLink.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'

type FuzzyEntry = { link: ThreadLink; indices: number[] | null }

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
const copiedId = ref<string | null>(null)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

const triggerTitle = computed(() => t('Links'))
const isLoading = computed(() => props.isLoading === true)
const disabled = computed(() => props.disabled === true)

const sortCompare = (a: ThreadLink, b: ThreadLink): number => (
  a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: 'base' })
)

const webLinks = computed(() => props.links.filter((link) => link.kind === 'web').slice().sort(sortCompare))
const fileLinks = computed(() => props.links.filter((link) => link.kind === 'file').slice().sort(sortCompare))

const queryText = computed(() => searchQuery.value.trim())

function fuzzyMatch(query: string, target: string): number[] | null {
  if (!query) return []
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices: number[] = []
  let ti = 0
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]
    let found = false
    while (ti < t.length) {
      if (t[ti] === ch) {
        indices.push(ti)
        ti += 1
        found = true
        break
      }
      ti += 1
    }
    if (!found) return null
  }
  return indices
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

function highlightHtml(target: string, indices: number[] | null): string {
  if (!indices || indices.length === 0) return escapeHtml(target)
  const matchSet = new Set(indices)
  let out = ''
  for (let i = 0; i < target.length; i += 1) {
    const escaped = escapeHtml(target[i])
    out += matchSet.has(i) ? `<mark>${escaped}</mark>` : escaped
  }
  return out
}

const fuzzyWebLinks = computed<FuzzyEntry[]>(() => {
  const query = queryText.value
  return webLinks.value.map((link) => ({ link, indices: fuzzyMatch(query, link.value) }))
    .filter((entry) => entry.indices !== null)
})

const fuzzyFileLinks = computed<FuzzyEntry[]>(() => {
  const query = queryText.value
  return fileLinks.value.map((link) => ({ link, indices: fuzzyMatch(query, link.value) }))
    .filter((entry) => entry.indices !== null)
})

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

function onFileClick(link: ThreadLink, event: MouseEvent): void {
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

.thread-links-row-icon {
  @apply h-4 w-4 shrink-0 text-zinc-500;
}

.thread-links-row-label {
  @apply min-w-0 flex-1 truncate font-mono text-xs;
}

.thread-links-row-label :global(mark) {
  @apply rounded-sm bg-amber-200 px-0.5 text-zinc-900;
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

:global(:root.dark .thread-links-row-icon) {
  @apply text-zinc-400;
}

:global(:root.dark .thread-links-row-role) {
  @apply bg-zinc-800 text-zinc-400;
}

:global(:root.dark .thread-links-row-label mark) {
  @apply bg-amber-500/40 text-zinc-100;
}

:global(:root.dark .thread-links-copy) {
  @apply text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200;
}

:global(:root.dark .thread-links-empty) {
  @apply text-zinc-400;
}
</style>
