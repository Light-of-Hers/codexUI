<template>
  <Suspense>
    <template #default>
      <AsyncAppMain />
    </template>
    <template #fallback>
      <main
        class="app-bootstrap-shell"
        :class="{ 'is-dark': bootstrapDarkMode }"
        aria-busy="true"
        aria-label="Loading Codex UI"
      >
        <div class="app-bootstrap-layout">
          <aside class="app-bootstrap-sidebar" aria-hidden="true">
            <div class="app-bootstrap-block app-bootstrap-block--toolbar" />
            <div class="app-bootstrap-block app-bootstrap-block--project" />
            <div class="app-bootstrap-block" />
            <div class="app-bootstrap-block" />
          </aside>
          <section class="app-bootstrap-main" aria-hidden="true">
            <div class="app-bootstrap-header" />
            <p class="app-bootstrap-label">Loading Codex UI…</p>
            <div class="app-bootstrap-content">
              <div class="app-bootstrap-line app-bootstrap-line--wide" />
              <div class="app-bootstrap-line" />
              <div class="app-bootstrap-line" />
              <div class="app-bootstrap-line app-bootstrap-line--short" />
            </div>
            <div class="app-bootstrap-composer" />
          </section>
        </div>
      </main>
    </template>
  </Suspense>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

const AsyncAppMain = defineAsyncComponent(() => import('./AppMain.vue'))

const DARK_MODE_KEY = 'codex-web-local.dark-mode.v1'

function detectBootstrapDarkMode(): boolean {
  if (typeof window === 'undefined') return false

  const stored = window.localStorage.getItem(DARK_MODE_KEY)
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  return stored === 'dark' || (stored !== 'light' && prefersDark)
}

const bootstrapDarkMode = detectBootstrapDarkMode()
</script>

<style scoped>
@reference "tailwindcss";

.app-bootstrap-shell {
  @apply min-h-screen bg-zinc-50 text-zinc-900;
}

.app-bootstrap-shell.is-dark {
  @apply bg-zinc-950 text-zinc-100;
}

.app-bootstrap-layout {
  @apply grid min-h-screen grid-cols-[18rem_minmax(0,1fr)];
}

.app-bootstrap-sidebar {
  @apply flex flex-col gap-3 border-r border-zinc-200 bg-white p-4;
}

.app-bootstrap-shell.is-dark .app-bootstrap-sidebar {
  @apply border-zinc-800 bg-zinc-900;
}

.app-bootstrap-main {
  @apply flex min-w-0 flex-col gap-4 p-4;
}

.app-bootstrap-header,
.app-bootstrap-block,
.app-bootstrap-line,
.app-bootstrap-composer {
  @apply rounded-xl bg-zinc-200/80;
}

.app-bootstrap-shell.is-dark .app-bootstrap-header,
.app-bootstrap-shell.is-dark .app-bootstrap-line,
.app-bootstrap-shell.is-dark .app-bootstrap-composer {
  @apply bg-zinc-800/80;
}

.app-bootstrap-header {
  @apply h-12 w-full;
}

.app-bootstrap-block {
  @apply h-16 border border-zinc-200 bg-zinc-100;
}

.app-bootstrap-shell.is-dark .app-bootstrap-block {
  @apply border-zinc-700 bg-zinc-800;
}

.app-bootstrap-block--toolbar {
  @apply h-11;
}

.app-bootstrap-block--project {
  @apply h-24;
}

.app-bootstrap-content {
  @apply flex flex-1 flex-col gap-3 pt-8;
}

.app-bootstrap-label {
  @apply text-sm font-medium text-zinc-500;
}

.app-bootstrap-shell.is-dark .app-bootstrap-label {
  @apply text-zinc-400;
}

.app-bootstrap-line {
  @apply h-4 max-w-2xl;
}

.app-bootstrap-line--wide {
  @apply max-w-4xl;
}

.app-bootstrap-line--short {
  @apply max-w-xl;
}

.app-bootstrap-composer {
  @apply h-28 w-full max-w-4xl self-center;
}

@media (max-width: 768px) {
  .app-bootstrap-layout {
    @apply grid-cols-1;
  }

  .app-bootstrap-sidebar {
    @apply hidden;
  }
}
</style>
