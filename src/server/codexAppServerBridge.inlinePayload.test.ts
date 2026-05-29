import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendQueueProcessor,
  buildAppServerConfigForState,
  buildSessionModelState,
  createCodexBridgeMiddleware,
  mergeExplicitModelStateIntoThreadResult,
  mergeRecoveredTurnItemsIntoThreadResult,
  mergeSessionModelStateIntoThreadResult,
  mergeSessionSkillInputsIntoTurns,
  parseAutomationToml,
  persistTurnStartModelProviderInCollaborationMode,
  rewriteOpenAiThreadModelProvider,
  sanitizeThreadTurnsInlinePayloads,
  shouldAutoContinueInterruptedThreadFromThreadRead,
  toAutomationApiRecord,
} from './codexAppServerBridge'

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const pngDataUrl = `data:image/png;base64,${pngBase64}`
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
const webpBase64 = 'UklGRiIAAABXRUJQVlA4IC4AAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA='

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function writeMockCommand(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo mock; exit 0; fi\nexit 0\n', 'utf8')
  await chmod(path, 0o755)
}

async function writeJsonRpcCommand(path: string, provider: string, logPath: string, logMethods = false): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log(${JSON.stringify(`${provider} mock`)})
  process.exit(0)
}
const logMethods = ${JSON.stringify(logMethods)}
if (!logMethods) {
  fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(provider)} + '\\n')
}
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      const message = JSON.parse(line)
      if (logMethods) {
        fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(provider)} + ':' + message.method + '\\n')
      }
      const result = message.method === 'turn/start'
        ? { turn: { id: ${JSON.stringify(provider)} + '-turn' } }
        : message.method === 'config/read'
          ? { config: { model_provider: ${JSON.stringify(provider)} } }
          : {}
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
    }
    index = buffer.indexOf('\\n')
  }
})
`, 'utf8')
  await chmod(path, 0o755)
}

function localImagePathFromProxyUrl(value: string): string {
  const parsed = new URL(value, 'http://localhost')
  expect(parsed.pathname).toBe('/codex-local-image')
  const imagePath = parsed.searchParams.get('path')
  expect(imagePath).toBeTruthy()
  return imagePath ?? ''
}

describe('session model state recovery', () => {
  it('rewrites explicit OpenAI thread provider to the configured Codex provider', async () => {
    const rpcCalls: Array<{ method: string; params: unknown }> = []
    const rewritten = await rewriteOpenAiThreadModelProvider({
      async rpc(method: string, params: unknown): Promise<unknown> {
        rpcCalls.push({ method, params })
        return {
          config: {
            model_provider: 'rustcat',
          },
        }
      },
    }, 'thread/resume', {
      threadId: 'thread-1',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })

    expect(rewritten).toEqual({
      threadId: 'thread-1',
      model: 'gpt-5.5',
      modelProvider: 'rustcat',
    })
    expect(rpcCalls).toEqual([{ method: 'config/read', params: {} }])
  })

  it('rewrites explicit OpenAI turn provider to the configured Codex provider', async () => {
    const rewritten = await rewriteOpenAiThreadModelProvider({
      async rpc(): Promise<unknown> {
        return {
          config: {
            model_provider: 'rustcat',
          },
        }
      },
    }, 'turn/start', {
      threadId: 'thread-1',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      input: [{ type: 'text', text: 'continue' }],
    })

    expect(rewritten).toEqual({
      threadId: 'thread-1',
      model: 'gpt-5.5',
      modelProvider: 'rustcat',
      input: [{ type: 'text', text: 'continue' }],
    })
  })

  it('overrides stale thread snapshot model metadata from persisted turn context', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-session-model-'))
    const sessionPath = join(tempDir, 'session.jsonl')

    try {
      await writeFile(sessionPath, [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            model_provider: 'moon',
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: {
            turn_id: 'turn-1',
            model: 'glm-5.1',
            effort: 'xhigh',
            collaboration_mode: {
              mode: 'default',
              settings: {
                model: 'glm-5.1',
                reasoning_effort: 'xhigh',
              },
            },
          },
        }),
      ].join('\n'), 'utf8')

      const result = await mergeSessionModelStateIntoThreadResult({
        model: 'gpt-5.5',
        modelProvider: 'openai',
        reasoningEffort: 'none',
        thread: {
          id: 'thread-1',
          path: sessionPath,
          modelProvider: 'openai',
          reasoningEffort: 'none',
          turns: [],
        },
      }) as {
        model: string
        modelProvider: string
        reasoningEffort: string
        thread: {
          model: string
          modelProvider: string
          reasoningEffort: string
        }
      }

      expect(result.model).toBe('glm-5.1')
      expect(result.modelProvider).toBe('moon')
      expect(result.reasoningEffort).toBe('xhigh')
      expect(result.thread.model).toBe('glm-5.1')
      expect(result.thread.modelProvider).toBe('moon')
      expect(result.thread.reasoningEffort).toBe('xhigh')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('lets turn context provider override stale session metadata', () => {
    const state = buildSessionModelState([
      JSON.stringify({
        type: 'session_meta',
        payload: {
          model_provider: 'rustcat',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          model: 'gpt-5.5-medium',
          collaboration_mode: {
            mode: 'default',
            settings: {
              model: 'gpt-5.5-medium',
              model_provider: 'cursor',
              reasoning_effort: 'xhigh',
            },
          },
        },
      }),
    ].join('\n'))

    expect(state).toEqual({
      model: 'gpt-5.5-medium',
      modelProvider: 'cursor',
      reasoningEffort: 'xhigh',
    })
  })

  it('keeps explicit lifecycle model state ahead of recovered session metadata', () => {
    const result = mergeExplicitModelStateIntoThreadResult({
      model: 'ark-code-latest',
      modelProvider: 'moon',
      thread: {
        id: 'thread-1',
        path: '/tmp/session.jsonl',
        model: 'ark-code-latest',
        modelProvider: 'moon',
        turns: [],
      },
    }, {
      model: 'gpt-5.5',
      modelProvider: 'openai',
    }) as {
      model: string
      modelProvider: string
      thread: {
        model: string
        modelProvider: string
      }
    }

    expect(result.model).toBe('gpt-5.5')
    expect(result.modelProvider).toBe('openai')
    expect(result.thread.model).toBe('gpt-5.5')
    expect(result.thread.modelProvider).toBe('openai')
  })

  it('persists explicit turn provider in collaboration mode settings', () => {
    expect(persistTurnStartModelProviderInCollaborationMode('turn/start', {
      threadId: 'thread-1',
      model: 'gpt-5.5-medium',
      modelProvider: 'cursor',
      input: [{ type: 'text', text: 'continue' }],
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5.5-medium',
          reasoning_effort: 'xhigh',
          developer_instructions: null,
        },
      },
    })).toEqual({
      threadId: 'thread-1',
      model: 'gpt-5.5-medium',
      modelProvider: 'cursor',
      input: [{ type: 'text', text: 'continue' }],
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5.5-medium',
          reasoning_effort: 'xhigh',
          developer_instructions: null,
          model_provider: 'cursor',
        },
      },
    })
  })
})

describe('thread inline media sanitization', () => {
  it('externalizes inline image data from common thread payload fields', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'image', url: pngDataUrl }],
                images: [pngDataUrl],
              },
              {
                id: 'generated-1',
                type: 'imageGeneration',
                result: pngBase64,
              },
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: pngBase64,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<Record<string, unknown>>
        }>
      }
    }

    const [userMessage, generatedImage, toolOutput] = result.thread.turns[0].items
    const content = userMessage.content as Array<Record<string, unknown>>
    const images = userMessage.images as string[]

    expect(content[0].url).toMatch(/^\/codex-local-image\?path=/)
    expect(images[0]).toMatch(/^\/codex-local-image\?path=/)
    expect(generatedImage.type).toBe('imageView')
    expect(generatedImage.path).toEqual(expect.any(String))
    expect(toolOutput.result).toMatch(/^\/codex-local-image\?path=/)

    expect(existsSync(localImagePathFromProxyUrl(content[0].url as string))).toBe(true)
    expect(existsSync(localImagePathFromProxyUrl(images[0]))).toBe(true)
    expect(existsSync(generatedImage.path as string)).toBe(true)
    expect(existsSync(localImagePathFromProxyUrl(toolOutput.result as string))).toBe(true)
  })

  it('leaves non-image result strings untouched', async () => {
    const textResult = 'a'.repeat(128)
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: textResult,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ result: string }>
        }>
      }
    }

    expect(result.thread.turns[0].items[0].result).toBe(textResult)
  })

  it('leaves non-image data URLs untouched in image-like fields', async () => {
    const dataUrl = 'data:text/plain;base64,aGVsbG8='
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: dataUrl,
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ result: string }>
        }>
      }
    }

    expect(result.thread.turns[0].items[0].result).toBe(dataUrl)
  })

  it('externalizes supported bare base64 image signatures with matching extensions', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                images: [jpegBase64, webpBase64, gifBase64],
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{ images: string[] }>
        }>
      }
    }

    const images = result.thread.turns[0].items[0].images
    expect(images).toHaveLength(3)
    expect(images.every((image) => image.startsWith('/codex-local-image?path='))).toBe(true)

    const [jpegPath, webpPath, gifPath] = images.map(localImagePathFromProxyUrl)
    expect(jpegPath.endsWith('.jpg')).toBe(true)
    expect(webpPath.endsWith('.webp')).toBe(true)
    expect(gifPath.endsWith('.gif')).toBe(true)
    expect(existsSync(jpegPath)).toBe(true)
    expect(existsSync(webpPath)).toBe(true)
    expect(existsSync(gifPath)).toBe(true)
  })

  it('inlines valid Cursor tool payload references from the Codex payload directory', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    vi.stubEnv('CODEX_HOME', codexHome)
    const payloadPath = join(codexHome, 'cursor-tool-payloads', 'thread-1', 'tool_1.json')
    await mkdir(join(codexHome, 'cursor-tool-payloads', 'thread-1'), { recursive: true })
    await writeFile(payloadPath, JSON.stringify({
      type: 'cursor_tool_call',
      subtype: 'completed',
      call_id: 'tool_1',
      tool: 'shell',
      arguments: { command: 'pwd' },
      output: { success: { exitCode: 0, stdout: '/tmp\n' } },
    }), 'utf8')

    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [{
          id: 'turn-1',
          items: [{
            id: 'message-1',
            type: 'agentMessage',
            text: `Ran \`pwd\`\n  └ payload: ${payloadPath}`,
          }],
        }],
      },
    }) as { thread: { turns: Array<{ items: Array<{ text: string }> }> } }

    expect(result.thread.turns[0].items[0].text).toContain('<codex-ui-data>')
    expect(result.thread.turns[0].items[0].text).toContain('"type":"cursor_tool_call"')
  })

  it('does not inline non-Cursor JSON files that happen to match the payload line shape', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    vi.stubEnv('CODEX_HOME', codexHome)
    const payloadPath = join(codexHome, 'cursor-tool-payloads', 'thread-1', 'note.json')
    await mkdir(join(codexHome, 'cursor-tool-payloads', 'thread-1'), { recursive: true })
    await writeFile(payloadPath, JSON.stringify({ type: 'note', text: 'not a tool call' }), 'utf8')

    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [{
          id: 'turn-1',
          items: [{
            id: 'message-1',
            type: 'agentMessage',
            text: `Please inspect this file:\n  └ payload: ${payloadPath}`,
          }],
        }],
      },
    }) as { thread: { turns: Array<{ items: Array<{ text: string }> }> } }

    expect(result.thread.turns[0].items[0].text).not.toContain('<codex-ui-data>')
  })

  it('externalizes nested replacement history image URLs', async () => {
    const result = await sanitizeThreadTurnsInlinePayloads('thread/read', {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'message-1',
                type: 'message',
                replacement_history: [
                  {
                    content: [
                      {
                        type: 'image',
                        image_url: pngDataUrl,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }) as {
      thread: {
        turns: Array<{
          items: Array<{
            replacement_history: Array<{
              content: Array<{ image_url: string }>
            }>
          }>
        }>
      }
    }

    const imageUrl = result.thread.turns[0].items[0].replacement_history[0].content[0].image_url
    expect(imageUrl).toMatch(/^\/codex-local-image\?path=/)
    expect(existsSync(localImagePathFromProxyUrl(imageUrl))).toBe(true)
  })

  it('does not sanitize inline images for methods without thread turns', async () => {
    const payload = {
      thread: {
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'tool-output-1',
                type: 'functionCallOutput',
                result: pngBase64,
              },
            ],
          },
        ],
      },
    }

    const result = await sanitizeThreadTurnsInlinePayloads('thread/list', payload)

    expect(result).toBe(payload)
  })
})

describe('thread session skill recovery', () => {
  it('merges command executions recovered from session JSONL into thread/read turns', () => {
    const result = {
      thread: {
        id: 'thread-1',
        path: '/tmp/session.jsonl',
        turns: [{
          id: 'turn-1',
          items: [
            {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: 'list files', text_elements: [] }],
            },
            {
              id: 'agent-1',
              type: 'agentMessage',
              text: 'done',
            },
          ],
        }],
      },
    }
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: 'ls -la' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: [
            'Chunk ID: abc',
            'Process exited with code 0',
            'Wall time: 0.123 seconds',
            'Output:',
            'total 1',
          ].join('\n'),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      }),
    ].join('\n')

    const merged = mergeRecoveredTurnItemsIntoThreadResult(
      result,
      (_threadId, turns) => turns,
      sessionLog,
    ) as typeof result
    const items = merged.thread.turns[0].items

    expect(items.map((item) => item.type)).toEqual(['userMessage', 'commandExecution', 'agentMessage'])
    expect(items[1]).toMatchObject({
      id: 'session-cmd-call-1',
      type: 'commandExecution',
      command: 'ls -la',
      status: 'completed',
      aggregatedOutput: 'total 1',
      exitCode: 0,
      durationMs: 123,
    })
  })

  it('recovers Cursor shell payload references from session JSONL as command executions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    vi.stubEnv('CODEX_HOME', codexHome)
    const payloadDir = join(codexHome, 'cursor-tool-payloads', 'thread-1')
    const payloadPath = join(payloadDir, 'call_cursor_1.json')
    await mkdir(payloadDir, { recursive: true })
    await writeFile(payloadPath, JSON.stringify({
      type: 'cursor_tool_call',
      subtype: 'completed',
      call_id: 'call_cursor_1',
      tool: 'shell',
      arguments: {
        command: 'pwd',
        workingDirectory: '/tmp/project',
      },
      output: {
        success: {
          command: 'pwd',
          executionTime: 17,
          exitCode: 0,
          stdout: '/tmp/project\n',
          stderr: '',
          interleavedOutput: '/tmp/project\n',
          workingDirectory: '/tmp/project',
        },
      },
      status: null,
    }), 'utf8')

    try {
      const result = {
        thread: {
          id: 'thread-1',
          path: '/tmp/session.jsonl',
          turns: [{
            id: 'turn-1',
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'show cwd', text_elements: [] }],
              },
              {
                id: 'agent-running',
                type: 'agentMessage',
                text: `Running \`pwd\`\n  └ payload: ${payloadPath}`,
              },
              {
                id: 'agent-ran',
                type: 'agentMessage',
                text: `Ran \`pwd\`\n  └ /tmp/project\n  └ payload: ${payloadPath}`,
              },
              {
                id: 'agent-1',
                type: 'agentMessage',
                text: 'done',
              },
            ],
          }],
        },
      }
      const sessionLog = [
        JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `Running \`pwd\`\n  └ payload: ${payloadPath}` }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `Ran \`pwd\`\n  └ /tmp/project\n  └ payload: ${payloadPath}` }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        }),
      ].join('\n')

      const merged = mergeRecoveredTurnItemsIntoThreadResult(
        result,
        (_threadId, turns) => turns,
        sessionLog,
      ) as typeof result
      const items = merged.thread.turns[0].items

      expect(items.map((item) => item.type)).toEqual(['userMessage', 'commandExecution', 'agentMessage'])
      expect(items[1]).toMatchObject({
        id: 'cursor-command-call_cursor_1',
        type: 'commandExecution',
        command: 'pwd',
        cwd: '/tmp/project',
        status: 'completed',
        aggregatedOutput: '/tmp/project\n',
        exitCode: 0,
        durationMs: 17,
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('splits a merged assistant message so recovered commands keep their session order', () => {
    const result = {
      thread: {
        id: 'thread-1',
        path: '/tmp/session.jsonl',
        turns: [{
          id: 'turn-1',
          items: [
            {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: 'inspect project', text_elements: [] }],
            },
            {
              id: 'agent-merged',
              type: 'agentMessage',
              text: [
                'I will inspect the files.',
                'The listing shows package files.',
                'The config confirms the setup.',
              ].join('\n'),
            },
          ],
        }],
      },
    }
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect the files.' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-list',
          arguments: JSON.stringify({ cmd: 'ls' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-list',
          output: 'Process exited with code 0\nOutput:\npackage.json',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The listing shows package files.' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-config',
          arguments: JSON.stringify({ cmd: 'cat package.json' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-config',
          output: 'Process exited with code 0\nOutput:\n{"name":"codex-ui"}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The config confirms the setup.' }],
        },
      }),
    ].join('\n')

    const merged = mergeRecoveredTurnItemsIntoThreadResult(
      result,
      (_threadId, turns) => turns,
      sessionLog,
    ) as typeof result
    const items = merged.thread.turns[0].items

    expect(items.map((item) => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'commandExecution',
      'agentMessage',
      'commandExecution',
      'agentMessage',
    ])
    expect(items.map((item) => {
      const record = item as Record<string, unknown>
      return record.type === 'agentMessage' ? record.text : record.command
    })).toEqual([
      undefined,
      'I will inspect the files.',
      'ls',
      '\nThe listing shows package files.',
      'cat package.json',
      '\nThe config confirms the setup.',
    ])
  })

  it('reorders existing recovered commands instead of leaving them grouped before assistant text', () => {
    const result = {
      thread: {
        id: 'thread-1',
        path: '/tmp/session.jsonl',
        turns: [{
          id: 'turn-1',
          items: [
            {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: 'inspect project', text_elements: [] }],
            },
            {
              id: 'session-cmd-call-list',
              type: 'commandExecution',
              command: 'ls',
              status: 'completed',
              aggregatedOutput: 'package.json',
            },
            {
              id: 'session-cmd-call-config',
              type: 'commandExecution',
              command: 'cat package.json',
              status: 'completed',
              aggregatedOutput: '{"name":"codex-ui"}',
            },
            {
              id: 'agent-merged',
              type: 'agentMessage',
              text: [
                'I will inspect the files.',
                'The listing shows package files.',
                'The config confirms the setup.',
              ].join('\n'),
            },
          ],
        }],
      },
    }
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect the files.' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-list',
          arguments: JSON.stringify({ cmd: 'ls' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The listing shows package files.' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-config',
          arguments: JSON.stringify({ cmd: 'cat package.json' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The config confirms the setup.' }],
        },
      }),
    ].join('\n')

    const merged = mergeRecoveredTurnItemsIntoThreadResult(
      result,
      (_threadId, turns) => turns,
      sessionLog,
    ) as typeof result
    const items = merged.thread.turns[0].items

    expect(items.map((item) => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'commandExecution',
      'agentMessage',
      'commandExecution',
      'agentMessage',
    ])
    expect(items[2]).toBe(result.thread.turns[0].items[1])
    expect(items[4]).toBe(result.thread.turns[0].items[2])
  })

  it('assigns commands after task completion to the matching rollout turn', () => {
    const result = {
      thread: {
        id: 'thread-1',
        path: '/tmp/session.jsonl',
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'continue', text_elements: [] }],
              },
              {
                id: 'agent-1',
                type: 'agentMessage',
                text: 'Initial answer.',
              },
            ],
          },
          {
            id: 'rollout-4',
            items: [{
              id: 'agent-rollout',
              type: 'agentMessage',
              text: 'I will inspect the repo.\nThe repo is clean.',
            }],
          },
        ],
      },
    }
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Initial answer.' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect the repo.' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-status',
          arguments: JSON.stringify({ cmd: 'git status --short' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The repo is clean.' }],
        },
      }),
    ].join('\n')

    const merged = mergeRecoveredTurnItemsIntoThreadResult(
      result,
      (_threadId, turns) => turns,
      sessionLog,
    ) as typeof result
    const firstTurnItems = merged.thread.turns[0].items
    const rolloutItems = merged.thread.turns[1].items

    expect(firstTurnItems.map((item) => item.type)).toEqual(['userMessage', 'agentMessage'])
    expect(rolloutItems.map((item) => item.type)).toEqual([
      'agentMessage',
      'commandExecution',
      'agentMessage',
    ])
    expect(rolloutItems.map((item) => {
      const record = item as Record<string, unknown>
      return record.type === 'agentMessage' ? record.text : record.command
    })).toEqual([
      'I will inspect the repo.',
      'git status --short',
      '\nThe repo is clean.',
    ])
  })

  it('adds selected skill inputs from session JSONL to matching user messages', () => {
    const turns = [{
      id: 'turn-1',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'use a skill', text_elements: [] }],
      }],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'use a skill' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n---\n# Browser\n</skill>',
          }],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns
    expect(merged[0].items[0].content).toEqual([
      { type: 'text', text: 'use a skill', text_elements: [] },
      { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
    ])
  })

  it('does not duplicate skill inputs that are already present', () => {
    const turns = [{
      id: 'turn-1',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [
          { type: 'text', text: 'use a skill', text_elements: [] },
          { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
        ],
      }],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n</skill>',
          }],
        },
      }),
    ].join('\n')

    expect(mergeSessionSkillInputsIntoTurns(turns, sessionLog)).toBe(turns)
  })

  it('adds selected skill inputs to the last user message in a multi-message turn', () => {
    const turns = [{
      id: 'turn-1',
      items: [
        {
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'first message', text_elements: [] }],
        },
        {
          id: 'item-2',
          type: 'agentMessage',
          content: [{ type: 'text', text: 'assistant reply', text_elements: [] }],
        },
        {
          id: 'item-3',
          type: 'userMessage',
          content: [{ type: 'text', text: 'second message', text_elements: [] }],
        },
      ],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>browser-use:browser</name>\n<path>/Users/igor/.codex/plugins/browser/SKILL.md</path>\n</skill>',
          }],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns
    expect(merged[0].items[0].content).toEqual([{ type: 'text', text: 'first message', text_elements: [] }])
    expect(merged[0].items[2].content).toEqual([
      { type: 'text', text: 'second message', text_elements: [] },
      { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/plugins/browser/SKILL.md' },
    ])
  })
})

describe('backend queue scheduling', () => {
  it('reschedules a pending drain when a run-now request needs an earlier drain', async () => {
    vi.useFakeTimers()
    const processor = new BackendQueueProcessor({
      onNotification: () => () => undefined,
    } as never)
    const processThreadQueue = vi
      .spyOn(processor as unknown as { processThreadQueue: (threadId: string) => Promise<void> }, 'processThreadQueue')
      .mockResolvedValue(undefined)

    processor.scheduleThreadQueueDrain('thread-1', 5000)
    processor.scheduleThreadQueueDrain('thread-1', 0)

    await vi.advanceTimersByTimeAsync(0)
    expect(processThreadQueue).toHaveBeenCalledTimes(1)
    expect(processThreadQueue).toHaveBeenCalledWith('thread-1')

    await vi.advanceTimersByTimeAsync(5000)
    expect(processThreadQueue).toHaveBeenCalledTimes(1)

    processor.dispose()
  })

  it('detects interrupted idle turns that were not intentionally stopped', () => {
    const snapshot = shouldAutoContinueInterruptedThreadFromThreadRead({
      thread: {
        id: 'thread-1',
        status: { type: 'idle' },
        turns: [
          { id: 'turn-1', status: 'completed' },
          { id: 'turn-2', status: 'interrupted' },
        ],
      },
    }, new Set(['turn-1']))

    expect(snapshot).toEqual({ threadId: 'thread-1', turnId: 'turn-2' })
  })

  it('skips interrupted turns that came from a user stop', () => {
    const snapshot = shouldAutoContinueInterruptedThreadFromThreadRead({
      thread: {
        id: 'thread-1',
        status: { type: 'idle' },
        turns: [{ id: 'turn-1', status: 'interrupted' }],
      },
    }, new Set(['turn-1']))

    expect(snapshot).toBeNull()
  })

  it('routes queued turns through the explicit wrapper provider runtime', async () => {
    const moonCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const cursorCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const moonAppServer = {
      onNotification: () => () => undefined,
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        moonCalls.push({ method, params })
        return {}
      },
    }
    const cursorAppServer = {
      onNotification: () => () => undefined,
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        cursorCalls.push({ method, params })
        return {}
      },
    }
    const processor = new BackendQueueProcessor(moonAppServer as never, (_method, params) => {
      const record = params as Record<string, unknown>
      return record.modelProvider === 'cursor'
        ? cursorAppServer as never
        : moonAppServer as never
    })

    try {
      await (processor as unknown as {
        startQueuedTurn: (turn: {
          threadId: string
          message: {
            id: string
            text: string
            imageUrls: string[]
            skills: Array<{ name: string; path: string }>
            fileAttachments: Array<{ label: string; path: string; fsPath: string }>
            collaborationMode: 'default'
            model: string
            modelProvider: string
            reasoningEffort: 'xhigh'
          }
        }) => Promise<void>
      }).startQueuedTurn({
        threadId: 'thread-1',
        message: {
          id: 'queued-1',
          text: 'use cursor next',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
          model: 'gpt-5.5-medium',
          modelProvider: 'cursor',
          reasoningEffort: 'xhigh',
        },
      })

      expect(moonCalls).toEqual([])
      expect(cursorCalls).toEqual([
        {
          method: 'thread/resume',
          params: {
            threadId: 'thread-1',
            persistExtendedHistory: true,
            model: 'gpt-5.5-medium',
            modelProvider: 'cursor',
          },
        },
        {
          method: 'turn/start',
          params: {
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'use cursor next' }],
            model: 'gpt-5.5-medium',
            modelProvider: 'cursor',
            effort: 'xhigh',
            collaborationMode: {
              mode: 'default',
              settings: {
                model: 'gpt-5.5-medium',
                reasoning_effort: 'xhigh',
                developer_instructions: null,
                model_provider: 'cursor',
              },
            },
          },
        },
      ])
    } finally {
      processor.dispose()
    }
  })

  it('auto-continues unexpected interrupted turn completions', async () => {
    vi.useFakeTimers()
    vi.stubEnv('CODEX_HOME', `/tmp/codexui-auto-continue-${String(Date.now())}`)
    const listeners: Array<(value: { method: string; params: unknown }) => void> = []
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const processor = new BackendQueueProcessor({
      onNotification(listener: (value: { method: string; params: unknown }) => void) {
        listeners.push(listener)
        return () => undefined
      },
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              status: { type: 'idle' },
              turns: [{ id: 'turn-1', status: 'interrupted' }],
            },
          }
        }
        if (method === 'thread/resume') {
          return { model: 'deepseek-v4-pro' }
        }
        return {}
      },
    } as never)

    listeners[0]?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      },
    })

    await vi.advanceTimersByTimeAsync(250)

    expect(calls).toEqual([
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
      { method: 'thread/resume', params: { threadId: 'thread-1', persistExtendedHistory: true } },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'Please continue.' }],
          model: 'deepseek-v4-pro',
        },
      },
    ])

    processor.dispose()
  })

  it('auto-continues interrupted turns with persisted Moon Bridge model state', async () => {
    vi.useFakeTimers()
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-auto-continue-model-'))
    const sessionPath = join(tempDir, 'session.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          model_provider: 'moon',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          model: 'ark-code-latest',
          effort: 'xhigh',
        },
      }),
    ].join('\n'), 'utf8')
    vi.stubEnv('CODEX_HOME', tempDir)
    const listeners: Array<(value: { method: string; params: unknown }) => void> = []
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const processor = new BackendQueueProcessor({
      onNotification(listener: (value: { method: string; params: unknown }) => void) {
        listeners.push(listener)
        return () => undefined
      },
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/read') {
          return {
            model: 'gpt-5.5',
            modelProvider: 'openai',
            reasoningEffort: 'none',
            thread: {
              id: 'thread-1',
              path: sessionPath,
              status: { type: 'idle' },
              turns: [{ id: 'turn-1', status: 'interrupted' }],
            },
          }
        }
        if (method === 'thread/resume') {
          return {
            model: 'gpt-5.5',
            modelProvider: 'openai',
            reasoningEffort: 'none',
            thread: {
              id: 'thread-1',
              path: sessionPath,
              turns: [],
            },
          }
        }
        return {}
      },
    } as never)

    try {
      listeners[0]?.({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'interrupted' },
        },
      })

      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => {
        expect(calls).toHaveLength(3)
      })

      expect(calls).toEqual([
        { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
        {
          method: 'thread/resume',
          params: {
            threadId: 'thread-1',
            persistExtendedHistory: true,
            model: 'ark-code-latest',
            modelProvider: 'moon',
          },
        },
        {
          method: 'turn/start',
          params: {
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'Please continue.' }],
            model: 'ark-code-latest',
            modelProvider: 'moon',
            effort: 'xhigh',
            collaborationMode: {
              mode: 'default',
              settings: {
                model: 'ark-code-latest',
                reasoning_effort: 'xhigh',
                developer_instructions: null,
                model_provider: 'moon',
              },
            },
          },
        },
      ])
    } finally {
      processor.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('does not auto-continue when a stop arrives before the delayed interrupted-turn check', async () => {
    vi.useFakeTimers()
    vi.stubEnv('CODEX_HOME', `/tmp/codexui-auto-continue-stop-${String(Date.now())}`)
    const listeners: Array<(value: { method: string; params: unknown }) => void> = []
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const processor = new BackendQueueProcessor({
      onNotification(listener: (value: { method: string; params: unknown }) => void) {
        listeners.push(listener)
        return () => undefined
      },
      async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              status: { type: 'idle' },
              turns: [{ id: 'turn-1', status: 'interrupted' }],
            },
          }
        }
        if (method === 'thread/resume') {
          return { model: 'deepseek-v4-pro' }
        }
        return {}
      },
    } as never)

    listeners[0]?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      },
    })

    processor.recordIntentionalInterrupt('thread-1', 'turn-1')
    await vi.advanceTimersByTimeAsync(250)

    expect(calls).toEqual([
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
    ])

    processor.dispose()
  })
})

describe('app-server runtime configuration', () => {
  it('bypasses requests that do not need app-server without resolving the command', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-non-api-bypass-'))
    const commandPath = join(tempDir, 'codex')
    const markerPath = join(tempDir, 'called')
    await writeFile(commandPath, `#!/bin/sh\necho called >> ${JSON.stringify(markerPath)}\necho mock\n`, 'utf8')
    await chmod(commandPath, 0o755)
    vi.stubEnv('CODEX_HOME', tempDir)
    vi.stubEnv('CODEXUI_CODEX_COMMAND', commandPath)

    const middleware = createCodexBridgeMiddleware()
    let nextCalls = 0
    const responseChunks: string[] = []
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      write: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
        return true
      },
      end: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
      },
      once: () => response,
    }

    try {
      await middleware(
        { url: '/src/App.vue', method: 'GET', headers: {} } as never,
        {} as never,
        () => { nextCalls += 1 },
      )

      expect(nextCalls).toBe(1)
      expect(existsSync(markerPath)).toBe(false)

      await middleware(
        { url: '/codex-api/prompts', method: 'GET', headers: {} } as never,
        response as never,
        () => { nextCalls += 1 },
      )

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(responseChunks.join(''))).toEqual({ data: [] })
      expect(nextCalls).toBe(1)
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      middleware.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns directory and symlink metadata from composer file search route', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-route-'))
    const realDir = join(tempDir, 'real')
    const nestedDir = join(realDir, 'nested')
    const middleware = createCodexBridgeMiddleware()
    try {
      await mkdir(nestedDir, { recursive: true })
      await writeFile(join(realDir, 'alpha.txt'), 'alpha')
      await writeFile(join(nestedDir, 'beta.txt'), 'beta')
      await symlink(join(realDir, 'alpha.txt'), join(tempDir, 'file-link.txt'))
      await symlink(nestedDir, join(tempDir, 'dir-link'))

      const responseChunks: string[] = []
      const response = {
        statusCode: 0,
        setHeader: () => undefined,
        write: (chunk?: unknown) => {
          if (chunk) responseChunks.push(String(chunk))
          return true
        },
        end: (chunk?: unknown) => {
          if (chunk) responseChunks.push(String(chunk))
        },
        once: () => response,
      }
      const body = JSON.stringify({ cwd: tempDir, query: 'link', limit: 20 })
      const request = Readable.from([body]) as Readable & {
        url: string
        method: string
        headers: Record<string, string>
      }
      request.url = '/codex-api/composer-file-search'
      request.method = 'POST'
      request.headers = { 'content-type': 'application/json' }

      await middleware(
        request as never,
        response as never,
        () => { throw new Error('composer file search route should handle the request') },
      )

      expect(response.statusCode).toBe(200)
      const payload = JSON.parse(responseChunks.join('')) as {
        data: Array<{ path: string; kind?: string; isSymlink?: boolean }>
      }
      const byPath = new Map(payload.data.map((entry) => [entry.path, entry]))
      expect(byPath.get('file-link.txt')).toMatchObject({ kind: 'file', isSymlink: true })
      expect(byPath.get('dir-link')).toMatchObject({ kind: 'directory', isSymlink: true })
    } finally {
      middleware.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('routes explicit Cursor provider RPCs to the Cursor runtime even when Moon is active', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-provider-runtime-route-'))
    const commandLogPath = join(tempDir, 'commands.log')
    const codexCommand = join(tempDir, 'codex')
    const cursorCommand = join(tempDir, 'codex-cursor')
    await writeJsonRpcCommand(codexCommand, 'codex', commandLogPath, true)
    await writeJsonRpcCommand(cursorCommand, 'cursor', commandLogPath, true)
    await writeFile(join(tempDir, 'webui-free-mode.json'), JSON.stringify({
      enabled: true,
      apiKey: null,
      model: 'ark-code-latest',
      provider: 'moon',
    }), 'utf8')
    vi.stubEnv('CODEX_HOME', tempDir)
    vi.stubEnv('CODEXUI_CODEX_COMMAND', codexCommand)
    vi.stubEnv('CODEXUI_CODEX_CURSOR_COMMAND', cursorCommand)

    const middleware = createCodexBridgeMiddleware()
    const responseChunks: string[] = []
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      write: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
        return true
      },
      end: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
      },
      once: () => response,
    }
    const body = JSON.stringify({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'use cursor now' }],
        model: 'gpt-5.5-medium',
        modelProvider: 'cursor',
      },
    })
    const request = Readable.from([body]) as Readable & {
      url: string
      method: string
      headers: Record<string, string>
    }
    request.url = '/codex-api/rpc'
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json' }

    try {
      await middleware(
        request as never,
        response as never,
        () => { throw new Error('rpc route should handle the request') },
      )

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(responseChunks.join(''))).toEqual({
        result: {
          turn: {
            id: 'cursor-turn',
          },
        },
      })
      expect(await readFile(commandLogPath, 'utf8')).toContain('cursor:thread/resume\ncursor:turn/start\n')
    } finally {
      middleware.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('routes explicit Moon provider RPCs to the Moon runtime even when Cursor is active', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-provider-runtime-route-'))
    const commandLogPath = join(tempDir, 'commands.log')
    const codexCommand = join(tempDir, 'codex')
    const moonCommand = join(tempDir, 'codex-moon')
    const cursorCommand = join(tempDir, 'codex-cursor')
    await writeJsonRpcCommand(codexCommand, 'codex', commandLogPath, true)
    await writeJsonRpcCommand(moonCommand, 'moon', commandLogPath, true)
    await writeJsonRpcCommand(cursorCommand, 'cursor', commandLogPath, true)
    await writeFile(join(tempDir, 'webui-free-mode.json'), JSON.stringify({
      enabled: true,
      apiKey: null,
      model: 'gpt-5.5-medium',
      provider: 'cursor',
    }), 'utf8')
    vi.stubEnv('CODEX_HOME', tempDir)
    vi.stubEnv('CODEXUI_CODEX_COMMAND', codexCommand)
    vi.stubEnv('CODEXUI_CODEX_MOON_COMMAND', moonCommand)
    vi.stubEnv('CODEXUI_CODEX_CURSOR_COMMAND', cursorCommand)

    const middleware = createCodexBridgeMiddleware()
    const responseChunks: string[] = []
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      write: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
        return true
      },
      end: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
      },
      once: () => response,
    }
    const body = JSON.stringify({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'use moon now' }],
        model: 'ark-code-latest',
        modelProvider: 'moon',
      },
    })
    const request = Readable.from([body]) as Readable & {
      url: string
      method: string
      headers: Record<string, string>
    }
    request.url = '/codex-api/rpc'
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json' }

    try {
      await middleware(
        request as never,
        response as never,
        () => { throw new Error('rpc route should handle the request') },
      )

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(responseChunks.join(''))).toEqual({
        result: {
          turn: {
            id: 'moon-turn',
          },
        },
      })
      expect(await readFile(commandLogPath, 'utf8')).toContain('moon:thread/resume\nmoon:turn/start\n')
    } finally {
      middleware.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('records explicit Cursor interrupts on the Cursor runtime even when Moon is active', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-provider-interrupt-route-'))
    const commandLogPath = join(tempDir, 'commands.log')
    const codexCommand = join(tempDir, 'codex')
    const cursorCommand = join(tempDir, 'codex-cursor')
    await writeJsonRpcCommand(codexCommand, 'codex', commandLogPath, true)
    await writeJsonRpcCommand(cursorCommand, 'cursor', commandLogPath, true)
    await writeFile(join(tempDir, 'webui-free-mode.json'), JSON.stringify({
      enabled: true,
      apiKey: null,
      model: 'ark-code-latest',
      provider: 'moon',
    }), 'utf8')
    vi.stubEnv('CODEX_HOME', tempDir)
    vi.stubEnv('CODEXUI_CODEX_COMMAND', codexCommand)
    vi.stubEnv('CODEXUI_CODEX_CURSOR_COMMAND', cursorCommand)

    const middleware = createCodexBridgeMiddleware()
    const responseChunks: string[] = []
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      write: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
        return true
      },
      end: (chunk?: unknown) => {
        if (chunk) responseChunks.push(String(chunk))
      },
      once: () => response,
    }
    const body = JSON.stringify({
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelProvider: 'cursor',
      },
    })
    const request = Readable.from([body]) as Readable & {
      url: string
      method: string
      headers: Record<string, string>
    }
    request.url = '/codex-api/rpc'
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json' }

    try {
      await middleware(
        request as never,
        response as never,
        () => { throw new Error('rpc route should handle the request') },
      )

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(responseChunks.join(''))).toEqual({ result: {} })
      expect(await readFile(commandLogPath, 'utf8')).toContain('cursor:turn/interrupt\n')
    } finally {
      middleware.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('uses the Moon Bridge command for moon provider runtimes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-runtime-config-'))
    try {
      const codexCommand = join(tempDir, 'codex')
      const moonCommand = join(tempDir, 'codex-moon')
      await writeMockCommand(codexCommand)
      await writeMockCommand(moonCommand)
      vi.stubEnv('CODEXUI_CODEX_COMMAND', codexCommand)
      vi.stubEnv('CODEXUI_CODEX_MOON_COMMAND', moonCommand)

      const defaultConfig = buildAppServerConfigForState({
        enabled: false,
        apiKey: null,
        model: 'openrouter/free',
      })
      const moonConfig = buildAppServerConfigForState({
        enabled: true,
        apiKey: null,
        model: 'deepseek-v4-pro',
        provider: 'moon',
      })

      expect(defaultConfig.command).toBe(codexCommand)
      expect(defaultConfig.args[0]).toBe('app-server')
      expect(moonConfig.command).toBe(moonCommand)
      expect(moonConfig.args[0]).toBe('app-server')
      expect(moonConfig.args.some((arg) => arg.includes('model_provider'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('uses the Codex Cursor command for cursor provider runtimes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-runtime-config-'))
    try {
      const codexCommand = join(tempDir, 'codex')
      const cursorCommand = join(tempDir, 'codex-cursor')
      await writeMockCommand(codexCommand)
      await writeMockCommand(cursorCommand)
      vi.stubEnv('CODEXUI_CODEX_COMMAND', codexCommand)
      vi.stubEnv('CODEXUI_CODEX_CURSOR_COMMAND', cursorCommand)

      const cursorConfig = buildAppServerConfigForState({
        enabled: true,
        apiKey: null,
        model: 'gpt-5.5-medium',
        provider: 'cursor',
      })

      expect(cursorConfig.command).toBe(cursorCommand)
      expect(cursorConfig.args[0]).toBe('app-server')
      expect(cursorConfig.args.some((arg) => arg.includes('model_provider'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('automation TOML handling', () => {
  it('parses TOML string arrays without requiring JSON-only syntax', () => {
    const automation = parseAutomationToml([
      'version = 1',
      'id = "cron-smoke"',
      'kind = "cron"',
      'name = "Cron Smoke"',
      'prompt = "run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY"',
      "cwds = ['/tmp/project-one', '/tmp/project,two']",
      'created_at = 111',
      'updated_at = 222',
      '[scheduler]',
      'execution_environment = "local"',
    ].join('\n'))

    expect(automation?.cwds).toEqual(['/tmp/project-one', '/tmp/project,two'])
    expect(automation?.createdAtMs).toBe(111)
    expect(automation?.extraTomlLines).toContain('[scheduler]')
  })

  it('omits preserved TOML internals from automation API records', () => {
    const automation = parseAutomationToml([
      'version = 1',
      'id = "cron-smoke"',
      'kind = "cron"',
      'name = "Cron Smoke"',
      'prompt = "run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY"',
      'cwds = ["/tmp/project-one"]',
      '[scheduler]',
      'execution_environment = "local"',
    ].join('\n'))

    expect(automation).toBeTruthy()
    expect(toAutomationApiRecord(automation as NonNullable<typeof automation>)).not.toHaveProperty('extraTomlLines')
  })
})
