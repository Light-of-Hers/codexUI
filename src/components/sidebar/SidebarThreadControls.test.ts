// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

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

const { setUiLanguage } = await import('../../composables/useUiLanguage')
const { default: SidebarThreadControls } = await import('./SidebarThreadControls.vue')

afterEach(() => setUiLanguage('en'))

describe('SidebarThreadControls', () => {
  it('exposes stable labels and events for expanded controls', async () => {
    const wrapper = mount(SidebarThreadControls, {
      props: {
        isSidebarCollapsed: false,
        showNewThreadButton: true,
      },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.attributes('aria-label'))).toEqual([
      'Collapse sidebar',
      'Start new thread',
    ])

    await buttons[0]?.trigger('click')
    await buttons[1]?.trigger('click')
    expect(wrapper.emitted('toggle-sidebar')).toHaveLength(1)
    expect(wrapper.emitted('start-new-thread')).toHaveLength(1)
  })

  it('updates the collapse control without shifting the button footprint', () => {
    const wrapper = mount(SidebarThreadControls, {
      props: {
        isSidebarCollapsed: true,
        showNewThreadButton: false,
      },
    })

    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Expand sidebar')
    expect(button.classes()).toContain('sidebar-thread-controls-button')
    expect(wrapper.findAll('button')).toHaveLength(1)
  })
})
