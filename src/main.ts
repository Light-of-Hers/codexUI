import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { t } from './composables/useUiLanguage'
import { installFeedbackDiagnostics } from './composables/useFeedbackDiagnostics'

console.log('Welcome to codexui. github: https://github.com/friuns2/codexUI')

installFeedbackDiagnostics()

createApp(App).use(router).mount('#app')

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((error) => {
        console.error(t('Service worker registration failed.'), error)
      })
    })
  } else {
    window.addEventListener('load', () => {
      const reloadFlag = 'codexui-dev-service-worker-cleared'

      navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        if (registrations.length === 0) {
          sessionStorage.removeItem(reloadFlag)
          return
        }

        await Promise.all(registrations.map((registration) => registration.unregister()))

        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(
            keys
              .filter((key) => key.startsWith('codexweb-') || key.startsWith('codexui-'))
              .map((key) => caches.delete(key)),
          )
        }

        if (navigator.serviceWorker.controller && sessionStorage.getItem(reloadFlag) !== '1') {
          sessionStorage.setItem(reloadFlag, '1')
          window.location.reload()
        } else {
          sessionStorage.removeItem(reloadFlag)
        }
      }).catch((error) => {
        console.warn('Failed to clear development service worker cache.', error)
      })
    })
  }
}
