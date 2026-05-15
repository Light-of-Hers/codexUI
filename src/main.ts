import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'

const DARK_MODE_KEY = 'codex-web-local.dark-mode.v1'

function bootstrapTheme(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  const stored = window.localStorage.getItem(DARK_MODE_KEY)
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  const isDark = stored === 'dark' || (stored !== 'light' && prefersDark)
  document.documentElement.classList.toggle('dark', isDark)
}

bootstrapTheme()

console.log('Welcome to codexui. github: https://github.com/friuns2/codexUI')

createApp(App).use(router).mount('#app')

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed.', error)
    })
  })
}
