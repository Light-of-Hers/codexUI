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

  it('renders MCP tool calls as timeline tool-call cards', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'filesystem',
      tool: 'read_file',
      status: 'completed',
      arguments: { path: 'README.md' },
      result: { content: [{ type: 'text', text: 'ok' }], structuredContent: null },
      error: null,
      durationMs: 42,
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'mcp-1',
      role: 'system',
      messageType: 'toolCall',
      toolCall: {
        kind: 'mcp',
        title: 'filesystem.read_file',
        status: 'completed',
        server: 'filesystem',
        input: JSON.stringify({ path: 'README.md' }, null, 2),
        output: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], structuredContent: null }, null, 2),
        meta: ['Server: filesystem', '42 ms'],
      },
    })
  })

  it('renders collaboration agent tool calls as timeline tool-call cards', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'thread-parent',
      receiverThreadIds: ['thread-child'],
      prompt: 'Inspect the parser.',
      agentsStates: {
        'thread-child': { status: 'running', message: 'Reading files' },
      },
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'collab-1',
      role: 'system',
      messageType: 'toolCall',
      toolCall: {
        kind: 'collab',
        title: 'Agent tool: spawnAgent',
        status: 'inProgress',
        input: 'Inspect the parser.',
        output: JSON.stringify({ 'thread-child': { status: 'running', message: 'Reading files' } }, null, 2),
        meta: ['From: thread-parent', 'Targets: thread-child'],
      },
    })
  })

  it('renders web search items as timeline tool-call cards', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'webSearch',
      id: 'web-1',
      query: 'OpenAI Codex docs',
      action: { type: 'search', query: 'OpenAI Codex docs', queries: null },
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'web-1',
      role: 'system',
      messageType: 'toolCall',
      toolCall: {
        kind: 'webSearch',
        title: 'Web search',
        status: 'completed',
        input: JSON.stringify({ type: 'search', query: 'OpenAI Codex docs', queries: null }, null, 2),
        meta: ['Query: OpenAI Codex docs'],
      },
    })
  })

  it('renders Cursor shell tool-call commentary as command execution', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-1',
      text: [
        'Cursor shell completed',
        'call_id: call_1_fc_2',
        'args: {"command":"ls -la","workingDirectory":"/tmp/project"}',
        'command: ls -la',
        'cwd: /tmp/project',
        'output: {"success":{"command":"ls -la","exitCode":0,"stdout":"total 1\\n-rw-r--r-- file\\n","stderr":"","interleavedOutput":"total 1\\n-rw-r--r-- file\\n","workingDirectory":"/tmp/project"}}',
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

  it('renders Cursor shell tool-call commentary from hidden full payload', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-hidden',
      text: [
        'Ran `ls -la`',
        '  └ total 1',
        '    -rw-r--r-- file',
        '  └ payload: /tmp/cursor-tool-payloads/thread/call_hidden_1.json',
        '<codex-ui-data>{"type":"cursor_tool_call","subtype":"completed","call_id":"call_hidden_1","tool":"shell","arguments":{"command":"ls -la","workingDirectory":"/tmp/project"},"status":null,"output":{"success":{"command":"ls -la","exitCode":0,"stdout":"total 1\\n-rw-r--r-- file\\n","stderr":"","interleavedOutput":"total 1\\n-rw-r--r-- file\\n","workingDirectory":"/tmp/project"}}}</codex-ui-data>',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-command-call_hidden_1',
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

  it('does not render payload-path-only Cursor commentary as a fake tool card', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-path-only',
      text: [
        'Ran `ls -la`',
        '  └ total 1',
        '  └ payload: /tmp/cursor-tool-payloads/thread/call_path_only.json',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-tool-path-only',
      role: 'assistant',
      messageType: 'agentMessage',
    })
  })

  it('hides incomplete Cursor shell tool-call commentary from persisted history', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-started',
      text: [
        'Cursor shell running',
        'call_id: call_1_fc_2',
        'args: {"command":"ls -la","workingDirectory":"/tmp/project"}',
        'command: ls -la',
      ].join('\n'),
    }]))

    expect(messages).toEqual([])
  })

  it('renders non-shell Cursor tool-call commentary without raw protocol text', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-read-tool',
      text: [
        'Cursor tool `read` completed',
        'call_id: call_read_1',
        'args: {"path":"src/index.ts"}',
        'output: {"content":"export const ok = true\\n"}',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-tool-call_read_1',
      role: 'system',
      messageType: 'toolCall',
      toolCall: {
        kind: 'cursor',
        title: 'Cursor tool: read',
        name: 'read',
        status: 'completed',
        server: 'cursor-cli',
        input: '{\n  "path": "src/index.ts"\n}',
        output: '{\n  "content": "export const ok = true\\n"\n}',
        error: '',
        progress: '',
        meta: ['Cursor CLI'],
      },
    })
    expect(messages[0]?.text).toContain('Cursor tool: read (completed)')
    expect(messages[0]?.text).toContain('"path": "src/index.ts"')
    expect(messages[0]?.text).not.toContain('[cursor tool_call')
  })

  it('renders proxy Cursor tool-call commentary from Called format', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'msg_cursor_tool_completed_call_read_proxy',
      text: [
        'Called Cursor tool `read`',
        '  └ args: {"path":"src/index.ts"}',
        '  └ output: {"content":"export const ok = true\\n"}',
        '  └ payload: /tmp/cursor-tool-payloads/thread/call_read_proxy.json',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-tool-call_read_proxy',
      role: 'system',
      messageType: 'toolCall',
      toolCall: {
        kind: 'cursor',
        name: 'read',
        status: 'completed',
        input: '{\n  "path": "src/index.ts"\n}',
        output: '{\n  "content": "export const ok = true\\n"\n}',
      },
    })
  })

  it('hides incomplete proxy Cursor tool-call commentary from persisted history', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'msg_cursor_tool_started_call_glob_proxy',
      text: [
        'Calling Cursor tool `glob`',
        '  └ args: {"globPattern":"**/*.ts","targetDirectory":"/tmp/project"}',
        '  └ payload: /tmp/cursor-tool-payloads/thread/call_glob_proxy.json',
      ].join('\n'),
    }]))

    expect(messages).toEqual([])
  })

  it('marks Cursor shell tool-call errors as failed command executions', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-error',
      text: [
        'Cursor shell completed (exit 1)',
        'call_id: call_error_fc_2',
        'args: {"command":"false","workingDirectory":"/tmp/project"}',
        'command: false',
        'cwd: /tmp/project',
        'output: {"error":{"message":"command failed"}}',
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

  it('preserves stdout from Cursor shell tool-call failure payloads', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'cursor-tool-failure',
      text: [
        'Cursor shell completed (exit 1)',
        'call_id: call_failure_fc_2',
        'args: {"command":"printf \\"recursive_files_excluding_git \\"; false","workingDirectory":"/tmp/project"}',
        'command: printf "recursive_files_excluding_git "; false',
        'cwd: /tmp/project',
        'output: {"failure":{"command":"printf \\"recursive_files_excluding_git \\"; false","exitCode":1,"stdout":"recursive_files_excluding_git 185664\\ntop_level_regular_files 14\\n","stderr":"","interleavedOutput":"recursive_files_excluding_git 185664\\ntop_level_regular_files 14\\n","workingDirectory":"/tmp/project"},"isBackground":false}',
      ].join('\n'),
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'cursor-command-call_failure_fc_2',
      messageType: 'commandExecution',
      commandExecution: {
        status: 'failed',
        aggregatedOutput: 'recursive_files_excluding_git 185664\ntop_level_regular_files 14\n',
        exitCode: 1,
      },
    })
  })
})
