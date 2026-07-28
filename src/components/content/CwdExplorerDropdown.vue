<template>
  <div ref="rootRef" class="cwd-explorer-dropdown">
    <button
      class="cwd-explorer-trigger"
      type="button"
      :disabled="!cwd"
      :title="triggerTitle"
      :aria-label="triggerTitle"
      @click="toggleOpen"
    >
      <IconTablerFolder class="cwd-explorer-trigger-icon" />
      <IconTablerChevronDown class="cwd-explorer-trigger-chevron" />
    </button>

    <div v-if="isOpen" class="cwd-explorer-menu-wrap">
      <div class="cwd-explorer-menu">
        <div class="cwd-explorer-cwd">
          <span class="cwd-explorer-cwd-text" :title="cwd">{{ cwd }}</span>
          <button
            class="cwd-explorer-hidden-toggle"
            type="button"
            :class="{ 'is-active': showHidden }"
            :title="showHidden ? t('Hide hidden files') : t('Show hidden files')"
            :aria-pressed="showHidden"
            @click="toggleShowHidden"
          >
            <IconTablerEye class="cwd-explorer-hidden-icon" />
          </button>
        </div>
        <div class="cwd-explorer-body">
          <div v-if="rootLoading && !rootEntries.length" class="cwd-explorer-loading">{{ t('Loading…') }}</div>
          <div v-else-if="rootError" class="cwd-explorer-error">{{ rootError }}</div>
          <template v-else>
            <div
              v-for="row in flatRows"
              :key="row.entry.path"
              class="cwd-explorer-row"
              :style="{ paddingLeft: `${0.5 + row.depth * 0.9}rem` }"
            >
              <template v-if="row.entry.isDirectory">
                <button
                  class="cwd-explorer-chevron-btn"
                  type="button"
                  :title="isExpanded(row.entry.path) ? t('Collapse') : t('Expand')"
                  :aria-label="isExpanded(row.entry.path) ? t('Collapse') : t('Expand')"
                  @click="toggleDir(row.entry.path)"
                >
                  <IconTablerChevronRight class="cwd-explorer-chevron" :class="{ 'is-expanded': isExpanded(row.entry.path) }" />
                </button>
                <a
                  class="cwd-explorer-dir-link"
                  :href="toBrowseHref(row.entry.path)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="row.entry.path"
                >
                  <IconTablerFolder class="cwd-explorer-row-icon" />
                  <span class="cwd-explorer-row-label">{{ row.entry.name }}</span>
                </a>
              </template>
              <a
                v-else
                class="cwd-explorer-file-link"
                :href="toBrowseHref(row.entry.path)"
                target="_blank"
                rel="noopener noreferrer"
                :title="row.entry.path"
              >
                <IconTablerFilePencil class="cwd-explorer-row-icon" />
                <span class="cwd-explorer-row-label">{{ row.entry.name }}</span>
              </a>
            </div>
            <div v-if="rootLoading && rootEntries.length" class="cwd-explorer-loading">{{ t('Loading…') }}</div>
            <div v-if="!rootLoading && !rootEntries.length" class="cwd-explorer-empty">{{ t('Empty folder') }}</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { listLocalEntries, type LocalEntry } from '../../api/codexGateway'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerEye from '../icons/IconTablerEye.vue'

const props = defineProps<{
  cwd: string
}>()

const { t } = useUiLanguage()

const rootRef = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const entriesByPath = ref<Record<string, LocalEntry[]>>({})
const loadingPaths = ref<Set<string>>(new Set())
const errorByPath = ref<Record<string, string>>({})
const expanded = ref<Set<string>>(new Set())
const showHidden = ref(false)

const triggerTitle = computed(() => props.cwd ? `Browse ${props.cwd}` : 'Browse cwd')
const rootEntries = computed(() => entriesByPath.value[props.cwd] ?? [])
const rootLoading = computed(() => loadingPaths.value.has(props.cwd))
const rootError = computed(() => errorByPath.value[props.cwd] ?? '')

type FlatRow = { entry: LocalEntry; depth: number }

function flatten(entries: LocalEntry[], depth: number): FlatRow[] {
  const rows: FlatRow[] = []
  for (const entry of entries) {
    rows.push({ entry, depth })
    if (entry.isDirectory && expanded.value.has(entry.path)) {
      const children = entriesByPath.value[entry.path]
      if (children) {
        rows.push(...flatten(children, depth + 1))
      }
    }
  }
  return rows
}

const flatRows = computed(() => {
  if (!rootEntries.value.length) return []
  return flatten(rootEntries.value, 0)
})

function toBrowseHref(path: string): string {
  return `/codex-local-browse${encodeURI(path)}`
}

function isExpanded(path: string): boolean {
  return expanded.value.has(path)
}

async function loadEntries(path: string): Promise<void> {
  if (entriesByPath.value[path] || loadingPaths.value.has(path)) return
  const nextLoading = new Set(loadingPaths.value)
  nextLoading.add(path)
  loadingPaths.value = nextLoading
  try {
    const listing = await listLocalEntries(path, { showHidden: showHidden.value })
    entriesByPath.value = { ...entriesByPath.value, [path]: listing.entries }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load directory'
    errorByPath.value = { ...errorByPath.value, [path]: message }
  } finally {
    const after = new Set(loadingPaths.value)
    after.delete(path)
    loadingPaths.value = after
  }
}

function toggleDir(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
    if (!entriesByPath.value[path]) void loadEntries(path)
  }
  expanded.value = next
}

function toggleShowHidden(): void {
  showHidden.value = !showHidden.value
  entriesByPath.value = {}
  loadingPaths.value = new Set()
  errorByPath.value = {}
  if (!isOpen.value || !props.cwd) return
  const paths = new Set(expanded.value)
  paths.add(props.cwd)
  for (const target of paths) void loadEntries(target)
}

function toggleOpen(): void {
  if (!props.cwd) return
  isOpen.value = !isOpen.value
  if (isOpen.value && !entriesByPath.value[props.cwd]) {
    void loadEntries(props.cwd)
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return
  const root = rootRef.value
  const target = event.target
  if (!root || !(target instanceof Node) || root.contains(target)) return
  isOpen.value = false
}

watch(() => props.cwd, () => {
  entriesByPath.value = {}
  loadingPaths.value = new Set()
  errorByPath.value = {}
  expanded.value = new Set()
  if (isOpen.value && props.cwd) void loadEntries(props.cwd)
})

watch(isOpen, (open) => {
  if (!open) return
  void nextTick(() => {})
})

onMounted(() => window.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocumentPointerDown))
</script>

<style scoped>
@reference "tailwindcss";

.cwd-explorer-dropdown {
  @apply relative inline-flex min-w-0;
}

.cwd-explorer-trigger {
  @apply inline-flex min-h-7 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60;
}

.cwd-explorer-trigger-icon,
.cwd-explorer-trigger-chevron {
  @apply h-4 w-4 shrink-0;
}

.cwd-explorer-menu-wrap {
  @apply absolute right-0 top-[calc(100%+8px)] z-50;
}

.cwd-explorer-menu {
  @apply w-96 max-w-[calc(100vw-1.5rem)] rounded-xl border border-zinc-200 bg-white p-1 shadow-lg;
}


.cwd-explorer-cwd {
  @apply mx-1 mb-1 flex items-center gap-1 rounded-md bg-zinc-50 px-2 py-1 font-mono text-[0.68rem] text-zinc-500;
}
.cwd-explorer-cwd-text {
  @apply min-w-0 flex-1 truncate;
}
.cwd-explorer-hidden-toggle {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200;
}
.cwd-explorer-hidden-toggle.is-active {
  @apply text-zinc-700;
}
.cwd-explorer-hidden-icon {
  @apply h-3.5 w-3.5;
}

.cwd-explorer-body {
  @apply max-h-[24rem] overflow-y-auto;
}

.cwd-explorer-row {
  @apply flex min-w-0 items-center gap-1.5 rounded-lg py-1 pr-2 text-sm text-zinc-700 hover:bg-zinc-100;
}

.cwd-explorer-chevron-btn {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200;
}

.cwd-explorer-dir-link {
  @apply flex min-w-0 flex-1 items-center gap-1.5 text-sm text-zinc-700;
}

.cwd-explorer-file-link {
  @apply flex min-w-0 flex-1 items-center gap-1.5 text-sm text-zinc-700;
}

.cwd-explorer-chevron {
  @apply h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform;
}

.cwd-explorer-chevron.is-expanded {
  @apply rotate-90;
}

.cwd-explorer-row-icon {
  @apply h-4 w-4 shrink-0 text-zinc-500;
}

.cwd-explorer-row-label {
  @apply min-w-0 flex-1 truncate text-xs;
}

.cwd-explorer-loading,
.cwd-explorer-empty {
  @apply px-2 py-2 text-center text-xs text-zinc-500;
}

.cwd-explorer-error {
  @apply px-2 py-2 text-center text-xs text-red-600;
}

:global(:root.dark .cwd-explorer-trigger) {
  @apply border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800;
}

:global(:root.dark .cwd-explorer-menu) {
  @apply border-zinc-700 bg-zinc-900;
}

:global(:root.dark .cwd-explorer-cwd) {
  @apply bg-zinc-800 text-zinc-400;
}

:global(:root.dark .cwd-explorer-hidden-toggle) {
  @apply text-zinc-500 hover:bg-zinc-700;
}

:global(:root.dark .cwd-explorer-hidden-toggle.is-active) {
  @apply text-zinc-200;
}

:global(:root.dark .cwd-explorer-row) {
  @apply text-zinc-200 hover:bg-zinc-800;
}

:global(:root.dark .cwd-explorer-chevron-btn) {
  @apply text-zinc-500 hover:bg-zinc-700;
}

:global(:root.dark .cwd-explorer-dir-link) {
  @apply text-zinc-200;
}

:global(:root.dark .cwd-explorer-file-link) {
  @apply text-zinc-200;
}

:global(:root.dark .cwd-explorer-chevron) {
  @apply text-zinc-500;
}

:global(:root.dark .cwd-explorer-row-icon) {
  @apply text-zinc-400;
}

:global(:root.dark .cwd-explorer-loading),
:global(:root.dark .cwd-explorer-empty) {
  @apply text-zinc-400;
}
</style>
