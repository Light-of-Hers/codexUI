import { describe, expect, it } from 'vitest'
import type { UiMessage, UiToolCallKind } from '../../types/codex'
import { groupConsecutiveRunnableItemsByLatestId } from './threadConversationGrouping'

function commandMessage(id: string): UiMessage {
  return {
    id,
    role: 'system',
    text: id,
    messageType: 'commandExecution',
    commandExecution: {
      command: id,
      cwd: null,
      status: 'completed',
      aggregatedOutput: '',
      exitCode: 0,
    },
  }
}

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

describe('groupConsecutiveRunnableItemsByLatestId', () => {
  it('groups consecutive tool calls across tool kinds under the latest call id', () => {
    const first = toolCallMessage('mcp-1', 'mcp')
    const second = toolCallMessage('web-1', 'webSearch')
    const latest = toolCallMessage('collab-1', 'collab')

    expect(groupConsecutiveRunnableItemsByLatestId([first, second, latest])).toEqual({
      'collab-1': [first, second],
    })
  })

  it('groups adjacent commands and tool calls under their latest item id', () => {
    const command = commandMessage('command-1')
    const tool = toolCallMessage('mcp-1', 'mcp')
    const latest = commandMessage('command-2')

    expect(groupConsecutiveRunnableItemsByLatestId([command, tool, latest])).toEqual({
      'command-2': [command, tool],
    })
  })

  it('keeps runnable blocks split by assistant text', () => {
    const first = commandMessage('command-1')
    const second = toolCallMessage('mcp-1', 'mcp')
    const third = commandMessage('command-2')
    const latest = toolCallMessage('web-1', 'webSearch')

    expect(groupConsecutiveRunnableItemsByLatestId([
      first,
      second,
      assistantMessage('assistant-1'),
      third,
      latest,
    ])).toEqual({
      'mcp-1': [first],
      'web-1': [third],
    })
  })

  it('does not group a single runnable item', () => {
    expect(groupConsecutiveRunnableItemsByLatestId([
      toolCallMessage('mcp-1', 'mcp'),
      assistantMessage('assistant-1'),
    ])).toEqual({})
  })
})
