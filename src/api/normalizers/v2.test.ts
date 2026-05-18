import { describe, expect, it } from 'vitest'
import { normalizeThreadGroupsV2, normalizeThreadMessagesV2 } from './v2'
import type { ThreadListResponse, ThreadReadResponse } from '../appServerDtos'

function threadReadResponseWithContent(content: ThreadReadResponse['thread']['turns'][number]['items'][number][]): ThreadReadResponse {
  return {
    thread: {
      id: 'thread-1',
      preview: 'Use a skill',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 2,
      path: null,
      cwd: '/tmp/project',
      cliVersion: 'test',
      source: 'appServer',
      gitInfo: null,
      turns: [{
        id: 'turn-1',
        status: 'completed',
        error: null,
        items: content,
      }],
    },
  }
}

describe('normalizeThreadGroupsV2', () => {
  it('preserves thread model providers from thread list summaries', () => {
    const payload: ThreadListResponse = {
      data: [
        {
          id: 'thread-1',
          preview: 'Moon session',
          modelProvider: 'moon',
          createdAt: 1710000000,
          updatedAt: 1710000300,
          path: null,
          cwd: '/tmp/project',
          cliVersion: '0.130.0',
          source: 'appServer',
          gitInfo: null,
          turns: [],
        },
      ],
      nextCursor: null,
    }

    const groups = normalizeThreadGroupsV2(payload)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.threads[0]?.modelProvider).toBe('moon')
  })
})

describe('normalizeThreadMessagesV2', () => {
  it('preserves selected skill inputs on the rendered user message', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-1',
      content: [
        { type: 'text', text: 'Use the browser skill', text_elements: [] },
        { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/skills/browser/SKILL.md' },
      ],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      text: 'Use the browser skill',
      skills: [{ name: 'browser-use:browser', path: '/Users/igor/.codex/skills/browser/SKILL.md' }],
    })
  })

  it('renders skill-only user messages instead of dropping them as raw blocks', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-2',
      content: [
        { type: 'skill', name: 'composio-cli', path: '/Users/igor/.codex/skills/composio-cli/SKILL.md' },
      ],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-2',
      role: 'user',
      text: '',
      skills: [{ name: 'composio-cli', path: '/Users/igor/.codex/skills/composio-cli/SKILL.md' }],
    })
    expect(messages[0].isUnhandled).toBeUndefined()
  })

  it('decodes escaped heartbeat instructions without exposing raw XML', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'automation-user-1',
      content: [{
        type: 'text',
        text: `<heartbeat>
<automation_id>automation-1</automation_id>
<current_time_iso>2026-05-09T00:00:00.000Z</current_time_iso>
<instructions>
Reply with &lt;/instructions&gt; and A &amp; B
</instructions>
</heartbeat>`,
        text_elements: [],
      }],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'automation-user-1',
      role: 'user',
      text: 'Reply with </instructions> and A & B',
      isAutomationRun: true,
      automationDisplayName: 'automation-1',
    })
  })

  it('applies a base turn index for paged thread slices', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-3',
      content: [{ type: 'text', text: 'Paged message', text_elements: [] }],
    }]), 12)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-3',
      turnId: 'turn-1',
      turnIndex: 12,
    })
  })

  it('renders Cursor shell tool-call commentary as command execution', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-1',
      text: [
        '[cursor tool_call completed]',
        'call_id: call_1_fc_2',
        'tool: shell',
        'arguments: {"command":"ls -la","workingDirectory":"/tmp/project"}',
        'output:',
        '{"success":{"command":"ls -la","exitCode":0,"stdout":"total 1\\n-rw-r--r-- file\\n","stderr":"","interleavedOutput":"total 1\\n-rw-r--r-- file\\n","workingDirectory":"/tmp/project"}}',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-command-call_1_fc_2',
      role: 'system',
      text: 'ls -la',
      messageType: 'commandExecution',
      commandExecution: {
        command: 'ls -la',
        cwd: '/tmp/project',
        status: 'completed',
        aggregatedOutput: 'total 1\n-rw-r--r-- file\n',
        exitCode: 0,
      },
    })
  })

  it('hides incomplete Cursor shell tool-call commentary from persisted history', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-started',
      text: [
        '[cursor tool_call started]',
        'call_id: call_1_fc_2',
        'tool: shell',
        'arguments: {"command":"ls -la","workingDirectory":"/tmp/project"}',
      ].join('\n'),
    }]))

    expect(messages).toEqual([])
  })

  it('marks Cursor shell tool-call errors as failed command executions', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-error',
      text: [
        '[cursor tool_call completed]',
        'call_id: call_error_fc_2',
        'tool: shell',
        'arguments: {"command":"false","workingDirectory":"/tmp/project"}',
        'output:',
        '{"error":{"message":"command failed"}}',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-command-call_error_fc_2',
      messageType: 'commandExecution',
      commandExecution: {
        command: 'false',
        cwd: '/tmp/project',
        status: 'failed',
        aggregatedOutput: 'command failed',
        exitCode: null,
      },
    })
  })
})
