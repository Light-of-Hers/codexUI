import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import { buildLiveThreadSearchResults, buildUiMessageSearchText, isLiveOnlySearchCandidate } from './threadMessageSearch'

describe('thread message search frontend helpers', () => {
  it('builds searchable text from live command details', () => {
    const message: UiMessage = {
      id: 'cmd-live',
      role: 'system',
      text: 'rg alpha',
      messageType: 'commandExecution.live',
      commandExecution: {
        command: 'rg alpha',
        cwd: '/tmp/project',
        status: 'inProgress',
        aggregatedOutput: 'alpha from command output',
        exitCode: null,
      },
    }

    expect(buildUiMessageSearchText(message)).toContain('alpha from command output')
  })

  it('treats .live and unmapped messages as live-only candidates', () => {
    expect(isLiveOnlySearchCandidate({
      id: 'live',
      role: 'assistant',
      text: 'streaming',
      messageType: 'agentMessage.live',
      turnId: 'turn-1',
      turnIndex: 1,
    })).toBe(true)

    expect(isLiveOnlySearchCandidate({
      id: 'persisted',
      role: 'assistant',
      text: 'done',
      messageType: 'agentMessage',
      turnId: 'turn-1',
      turnIndex: 1,
    })).toBe(false)
  })

  it('matches live-only messages without duplicating backend results', () => {
    const messages: UiMessage[] = [
      {
        id: 'persisted-message',
        role: 'assistant',
        text: 'alpha persisted',
        messageType: 'agentMessage.live',
        turnId: 'turn-1',
        turnIndex: 1,
      },
      {
        id: 'live-message',
        role: 'assistant',
        text: 'alpha live',
        messageType: 'agentMessage.live',
        turnId: 'turn-2',
        turnIndex: 2,
      },
    ]

    const results = buildLiveThreadSearchResults('alpha', new Set(['persisted-message']), messages)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      messageId: 'live-message',
      source: 'live',
      turnId: 'turn-2',
      turnIndex: 2,
    })
  })
})
