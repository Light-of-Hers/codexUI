import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import {
  buildLiveThreadSearchResults,
  buildUiMessageSearchText,
  compareThreadSearchResultEntriesByRecency,
  isLiveOnlySearchCandidate,
  type ThreadSearchUiResult,
  type ThreadSearchUiResultEntry,
} from './threadMessageSearch'

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

  it('sorts search results with the most recent conversation match first', () => {
    const baseResult: ThreadSearchUiResult = {
      id: 'base',
      turnId: 'turn-1',
      turnIndex: 1,
      messageId: 'message-1',
      role: 'assistant',
      messageType: 'agentMessage',
      occurrenceIndex: 0,
      snippet: 'alpha',
      snippetMatchStart: 0,
      snippetMatchEnd: 5,
      source: 'backend',
    }
    const entries: ThreadSearchUiResultEntry[] = [
      {
        result: { ...baseResult, id: 'old', turnId: 'turn-1', turnIndex: 1, messageId: 'old-message' },
        order: 0,
      },
      {
        result: { ...baseResult, id: 'new-first-hit', turnId: 'turn-3', turnIndex: 3, messageId: 'new-message', occurrenceIndex: 0 },
        order: 1,
      },
      {
        result: { ...baseResult, id: 'new-last-hit', turnId: 'turn-3', turnIndex: 3, messageId: 'new-message', occurrenceIndex: 1 },
        order: 2,
      },
      {
        result: { ...baseResult, id: 'live-unknown-turn', turnId: '', turnIndex: -1, messageId: 'live-message', source: 'live' },
        order: 3,
      },
    ]
    const results = entries.sort(compareThreadSearchResultEntriesByRecency)

    expect(results.map((entry) => entry.result.id)).toEqual([
      'live-unknown-turn',
      'new-last-hit',
      'new-first-hit',
      'old',
    ])
  })
})
