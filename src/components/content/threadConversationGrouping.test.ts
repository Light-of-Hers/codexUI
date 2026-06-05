import { describe, expect, it } from 'vitest'
import type { UiMessage, UiToolCallKind } from '../../types/codex'
import { groupConsecutiveToolCallsByLatestId } from './threadConversationGrouping'

function toolCallMessage(id: string, kind: UiToolCallKind): UiMessage {
  return {
    id,
    role: 'system',
    text: '',
    messageType: 'toolCall',
    toolCall: {
      kind,
      title: `${kind} tool`,
      name: `${kind}-tool`,
      status: 'completed',
      server: null,
      input: '',
      output: '',
      error: '',
      progress: '',
      durationMs: null,
      meta: [],
    },
  }
}

function assistantMessage(id: string): UiMessage {
  return {
    id,
    role: 'assistant',
    text: 'Done.',
    messageType: 'agentMessage',
  }
}

describe('groupConsecutiveToolCallsByLatestId', () => {
  it('groups consecutive tool calls across tool kinds under the latest call id', () => {
    const first = toolCallMessage('mcp-1', 'mcp')
    const second = toolCallMessage('web-1', 'webSearch')
    const latest = toolCallMessage('collab-1', 'collab')

    expect(groupConsecutiveToolCallsByLatestId([first, second, latest])).toEqual({
      'collab-1': [first, second],
    })
  })

  it('keeps separate tool call blocks split by assistant text', () => {
    const first = toolCallMessage('mcp-1', 'mcp')
    const second = toolCallMessage('mcp-2', 'mcp')
    const third = toolCallMessage('cursor-1', 'cursor')
    const latest = toolCallMessage('web-1', 'webSearch')

    expect(groupConsecutiveToolCallsByLatestId([
      first,
      second,
      assistantMessage('assistant-1'),
      third,
      latest,
    ])).toEqual({
      'mcp-2': [first],
      'web-1': [third],
    })
  })

  it('does not group a single tool call', () => {
    expect(groupConsecutiveToolCallsByLatestId([
      toolCallMessage('mcp-1', 'mcp'),
      assistantMessage('assistant-1'),
    ])).toEqual({})
  })
})
