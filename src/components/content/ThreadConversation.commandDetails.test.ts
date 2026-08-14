// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UiMessage } from '../../types/codex'

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
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
})

const { default: ThreadConversation } = await import('./ThreadConversation.vue')

function deferredCommandMessage(): UiMessage {
  return {
    id: 'command-1',
    role: 'system',
    text: '',
    messageType: 'commandExecution',
    turnId: 'turn-1',
    turnIndex: 0,
    commandExecution: {
      command: 'pnpm run ci...',
      cwd: null,
      status: 'completed',
      aggregatedOutput: '',
      exitCode: 0,
      detailsDeferred: true,
    },
  }
}

function mountConversation(message: UiMessage) {
  return mount(ThreadConversation, {
    props: {
      messages: [message],
      pendingRequests: [],
      liveOverlay: null,
      isLoading: false,
      activeThreadId: 'thread-1',
      cwd: '/tmp/project',
    },
  })
}

describe('ThreadConversation deferred command details', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads command and output once, only after the command is expanded', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: {
        command: 'pnpm run ci',
        cwd: '/tmp/project',
        aggregatedOutput: 'all tests passed',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountConversation(deferredCommandMessage())

    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.get('.cmd-label').text()).toBe('pnpm run ci...')

    await wrapper.get('button.cmd-row').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/codex-api/thread-command-details?threadId=thread-1&turnId=turn-1&itemId=command-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(wrapper.text()).toContain('pnpm run ci')
    expect(wrapper.text()).toContain('all tests passed')

    await wrapper.get('button.cmd-row').trigger('click')
    await wrapper.get('button.cmd-row').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not repeat streamed output already covered by a cold detail response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        command: 'pnpm run ci',
        cwd: '/tmp/project',
        aggregatedOutput: 'base\nstreamed\n',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const message = deferredCommandMessage()
    message.commandExecution = {
      ...message.commandExecution!,
      aggregatedOutput: 'streamed\nnew\n',
      deferredOutputLength: 'base\n'.length,
    }
    const wrapper = mountConversation(message)

    await wrapper.get('button.cmd-row').trigger('click')
    await flushPromises()

    const output = wrapper.get('.cmd-output-section:last-child').text()
    expect(output.match(/streamed/g)).toHaveLength(1)
    expect(output).toContain('base')
    expect(output).toContain('new')
    wrapper.unmount()
  })
})
