// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

const storedValues = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
    clear: () => storedValues.clear(),
  },
})

const { default: ThreadLinksDropdown } = await import('./ThreadLinksDropdown.vue')

describe('ThreadLinksDropdown', () => {
  it('defers full-history loading until the menu is opened', async () => {
    const wrapper = mount(ThreadLinksDropdown, {
      props: {
        links: [],
        isLoading: true,
      },
    })

    expect(wrapper.emitted('ensureLoaded')).toBeUndefined()

    await wrapper.get('button.thread-links-trigger').trigger('click')

    expect(wrapper.emitted('ensureLoaded')).toHaveLength(1)
  })
})
