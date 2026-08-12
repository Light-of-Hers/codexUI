import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearThreadGoal, forkThread, forkThreadThroughTurn, getAvailableModelIds, getCurrentModelConfig, getThreadGoal, getThreadQueueState, getThreadUserMessageIndex, listDirectoryComposioConnectors, resumeThread, searchComposerFiles, searchFileLinkPaths, searchThreadMessages, setThreadGoal, setThreadQueueState, startThread, startThreadTurn, steerThreadTurn } from './codexGateway'

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: {
        turn: {
          id: `turn-${requests.length}`,
        },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

function mockRpcFetchWithResponder(
  responder: (request: { method: string, params: Record<string, unknown> }, index: number) => unknown,
): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: responder(body, requests.length - 1),
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

function emptyThreadResult(threadId: string): Record<string, unknown> {
  return {
    model: 'gpt-5.4',
    thread: {
      id: threadId,
      cwd: '/tmp/project',
      preview: '',
      turns: [],
      createdAt: 0,
      updatedAt: 0,
    },
  }
}

describe('startThreadTurn collaboration mode payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('turn/start')
    expect(requests[1].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })

  it('sends explicit model provider overrides on turn start', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'use cursor now', [], 'gpt-5.5', 'xhigh', undefined, [], 'default', 'cursor')

    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.modelProvider).toBe('cursor')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: 'xhigh',
        developer_instructions: null,
        model_provider: 'cursor',
      },
    })
  })
})

describe('steerThreadTurn payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses turn/steer with the active turn id precondition', async () => {
    const { requests } = mockRpcFetchWithResponder(() => ({ turnId: 'turn-active' }))

    const turnId = await steerThreadTurn(
      'thread-1',
      'turn-active',
      'continue with this context',
      [],
      [{ name: 'brainstorming', path: '/skills/brainstorming' }],
      [{ label: 'plan.md', path: 'docs/plan.md', fsPath: '/repo/docs/plan.md' }],
    )

    expect(turnId).toBe('turn-active')
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('turn/steer')
    expect(requests[0].params).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-active',
      input: [
        {
          type: 'text',
          text: '# Files mentioned by the user:\n\n## plan.md: docs/plan.md\n\n## My request for Codex:\n\ncontinue with this context\n',
        },
        { type: 'skill', name: 'brainstorming', path: '/skills/brainstorming' },
      ],
    })
  })
})

describe('thread goal payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses app-server goal RPC methods', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/goal/get') {
        return {
          goal: null,
        }
      }
      if (request.method === 'thread/goal/set') {
        return {
          goal: {
            threadId: request.params.threadId,
            objective: request.params.objective ?? 'Existing goal',
            status: request.params.status ?? 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        }
      }
      if (request.method === 'thread/goal/clear') {
        return {
          cleared: true,
        }
      }
      return {}
    })

    await expect(getThreadGoal('thread-1')).resolves.toBeNull()
    await expect(setThreadGoal('thread-1', { objective: 'Ship goal support', status: 'active' })).resolves.toMatchObject({
      threadId: 'thread-1',
      objective: 'Ship goal support',
      status: 'active',
    })
    await expect(setThreadGoal('thread-1', { status: 'paused' })).resolves.toMatchObject({
      status: 'paused',
    })
    await expect(clearThreadGoal('thread-1')).resolves.toBe(true)

    expect(requests).toEqual([
      {
        method: 'thread/goal/get',
        params: { threadId: 'thread-1' },
      },
      {
        method: 'thread/goal/set',
        params: { threadId: 'thread-1', objective: 'Ship goal support', status: 'active' },
      },
      {
        method: 'thread/goal/set',
        params: { threadId: 'thread-1', status: 'paused' },
      },
      {
        method: 'thread/goal/clear',
        params: { threadId: 'thread-1' },
      },
    ])
  })
})

describe('thread history persistence payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts paginated history and pages fork responses instead of copying turns', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/start') return emptyThreadResult('thread-started')
      if (request.method === 'thread/resume') return emptyThreadResult('thread-1')
      if (request.method === 'thread/read') return emptyThreadResult('thread-1')
      if (request.method === 'thread/fork') return emptyThreadResult('thread-forked')
      return {}
    })

    await startThread('/tmp/project', 'gpt-5.4')
    await resumeThread('thread-1', 'gpt-5.4')
    await forkThread('thread-1')

    expect(requests.map((request) => request.method)).toEqual([
      'thread/start',
      'thread/resume',
      'thread/read',
      'thread/fork',
    ])
    expect(requests.filter((request) => (
      request.method === 'thread/start' || request.method === 'thread/resume' || request.method === 'thread/fork'
    )).every((request) => request.params.persistExtendedHistory === true)).toBe(true)
    expect(requests[0]?.params.historyMode).toBe('paginated')
    expect(requests[3]?.params.excludeTurns).toBe(true)
    expect(requests[2]).toEqual({
      method: 'thread/read',
      params: { threadId: 'thread-1', includeTurns: true },
    })
  })

  it('forks a thread through a specific turn without rollback', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/fork') return emptyThreadResult('thread-forked')
      return {}
    })

    const forkedThread = await forkThreadThroughTurn('thread-1', 'turn-2')

    expect(forkedThread.threadId).toBe('thread-forked')
    expect(requests).toEqual([{
      method: 'thread/fork',
      params: {
        threadId: 'thread-1',
        lastTurnId: 'turn-2',
        persistExtendedHistory: true,
        excludeTurns: true,
      },
    }])
  })

  it('recovers missing resume model settings from the persisted thread before resuming', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/read') {
        return {
          ...emptyThreadResult('thread-1'),
          model: 'gpt-5.6-sol-xhigh',
          modelProvider: 'cursor',
        }
      }
      if (request.method === 'thread/resume') return emptyThreadResult('thread-1')
      return {}
    })

    await resumeThread('thread-1')

    expect(requests).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: false },
      },
      {
        method: 'thread/resume',
        params: {
          threadId: 'thread-1',
          persistExtendedHistory: true,
          model: 'gpt-5.6-sol-xhigh',
          modelProvider: 'cursor',
        },
      },
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
    ])
  })

  it('uses the canonical read snapshot after resume to preserve recovered command placement', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/resume') {
        return {
          ...emptyThreadResult('thread-1'),
          thread: {
            ...emptyThreadResult('thread-1').thread as Record<string, unknown>,
            turns: [{
              id: 'turn-1',
              items: [
                { id: 'agent-before', type: 'agentMessage', text: 'Before.' },
                { id: 'exec-tail', type: 'commandExecution', command: '/bin/bash -lc pwd', status: 'completed' },
                { id: 'agent-after', type: 'agentMessage', text: 'After.' },
              ],
            }],
          },
        }
      }
      if (request.method === 'thread/read') {
        return {
          ...emptyThreadResult('thread-1'),
          thread: {
            ...emptyThreadResult('thread-1').thread as Record<string, unknown>,
            turns: [{
              id: 'turn-1',
              items: [
                { id: 'agent-before', type: 'agentMessage', text: 'Before.' },
                { id: 'session-cmd-1', type: 'commandExecution', command: 'pwd', status: 'completed' },
                { id: 'agent-after', type: 'agentMessage', text: 'After.' },
              ],
            }],
          },
        }
      }
      return {}
    })

    const resumedThread = await resumeThread('thread-1', 'gpt-5.4')

    expect(requests.map((request) => request.method)).toEqual(['thread/resume', 'thread/read'])
    expect(resumedThread.messages.map((message) => message.id)).toEqual([
      'agent-before',
      'session-cmd-1',
      'agent-after',
    ])
  })

  it('passes explicit model provider overrides to thread lifecycle RPCs', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/start') return { ...emptyThreadResult('thread-started'), modelProvider: 'moon', reasoningEffort: 'high' }
      if (request.method === 'thread/resume') return { ...emptyThreadResult('thread-1'), modelProvider: 'moon', reasoningEffort: 'low' }
      if (request.method === 'thread/read') return emptyThreadResult('thread-1')
      if (request.method === 'thread/fork') return { ...emptyThreadResult('thread-forked'), modelProvider: 'moon', reasoningEffort: 'xhigh' }
      return {}
    })

    const startedThread = await startThread('/tmp/project', 'glm-5.1', 'moon')
    const resumedThread = await resumeThread('thread-1', 'glm-5.1', 'moon')
    const forkedThread = await forkThread('thread-1', '/tmp/project', 'glm-5.1', 'moon')

    const lifecycleRequests = requests.filter((request) => request.method !== 'thread/read')
    expect(lifecycleRequests.map((request) => request.params.modelProvider)).toEqual(['moon', 'moon', 'moon'])
    expect(lifecycleRequests.map((request) => request.params.model)).toEqual(['glm-5.1', 'glm-5.1', 'glm-5.1'])
    expect([startedThread.reasoningEffort, resumedThread.reasoningEffort, forkedThread.reasoningEffort]).toEqual([
      'high',
      'low',
      'xhigh',
    ])
  })

  it('reads lifecycle model metadata from nested thread snapshots', async () => {
    mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/read') return emptyThreadResult('thread-1')
      if (request.method === 'thread/resume') {
        return {
          thread: {
            id: 'thread-1',
            cwd: '/tmp/project',
            preview: '',
            turns: [],
            createdAt: 0,
            updatedAt: 0,
            model: 'ark-code-latest',
            modelProvider: 'moon',
            reasoningEffort: 'xhigh',
          },
        }
      }
      return {}
    })

    const resumedThread = await resumeThread('thread-1')

    expect(resumedThread.model).toBe('ark-code-latest')
    expect(resumedThread.modelProvider).toBe('moon')
    expect(resumedThread.reasoningEffort).toBe('xhigh')
  })

  it('treats extra-high model variants as xhigh reasoning', async () => {
    mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/read') return emptyThreadResult('thread-1')
      if (request.method === 'thread/resume') {
        return {
          model: 'gpt-5.5-extra-high',
          reasoningEffort: 'high',
          thread: {
            id: 'thread-1',
            cwd: '/tmp/project',
            preview: '',
            turns: [],
            createdAt: 0,
            updatedAt: 0,
          },
        }
      }
      if (request.method === 'config/read') {
        return {
          config: {
            model: 'gpt-5.5-extra-high',
            model_provider: 'rustcat',
            model_reasoning_effort: 'high',
            service_tier: null,
          },
        }
      }
      return {}
    })

    const resumedThread = await resumeThread('thread-1')
    const currentConfig = await getCurrentModelConfig()

    expect(resumedThread.reasoningEffort).toBe('xhigh')
    expect(currentConfig.reasoningEffort).toBe('xhigh')
  })

  it('treats max model variants as max reasoning', async () => {
    mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/read') return emptyThreadResult('thread-1')
      if (request.method === 'thread/resume') {
        return {
          model: 'gpt-5.6-terra-max',
          reasoningEffort: 'high',
          thread: {
            id: 'thread-1',
            cwd: '/tmp/project',
            preview: '',
            turns: [],
            createdAt: 0,
            updatedAt: 0,
          },
        }
      }
      if (request.method === 'config/read') {
        return {
          config: {
            model: 'gpt-5.6-terra-max',
            model_provider: 'rustcat',
            model_reasoning_effort: 'high',
            service_tier: null,
          },
        }
      }
      return {}
    })

    const resumedThread = await resumeThread('thread-1')
    const currentConfig = await getCurrentModelConfig()

    expect(resumedThread.reasoningEffort).toBe('max')
    expect(currentConfig.reasoningEffort).toBe('max')
  })
})

describe('thread queue state', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves queued model state through the queue state API', async () => {
    const requests: Array<{ method: string, body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      requests.push({ method, body })

      return new Response(JSON.stringify({
        data: {
          'thread-1': [{
            id: 'q-1',
            text: 'follow up',
            imageUrls: [],
            skills: [],
            fileAttachments: [],
            collaborationMode: 'default',
            model: 'ark-code-latest',
            model_provider: 'moon',
            reasoning_effort: 'xhigh',
            model_selection_override: true,
          }],
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    const state = await getThreadQueueState()
    await setThreadQueueState(state)

    expect(state['thread-1']?.[0]).toMatchObject({
      model: 'ark-code-latest',
      modelProvider: 'moon',
      reasoningEffort: 'xhigh',
      modelSelectionOverride: true,
    })
    expect(requests[1]).toEqual({
      method: 'PUT',
      body: {
        'thread-1': [{
          id: 'q-1',
          text: 'follow up',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
          model: 'ark-code-latest',
          modelProvider: 'moon',
          reasoningEffort: 'xhigh',
          modelSelectionOverride: true,
        }],
      },
    })
  })
})

describe('provider model discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses exclusive provider models without waiting for model/list when provider models are required', async () => {
    const requests: Array<{ url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      requests.push({ url, body })

      if (url.endsWith('/codex-api/provider-models')) {
        return new Response(JSON.stringify({
          data: ['ark-code-latest', 'deepseek-v4-pro'],
          exclusive: true,
          source: 'moon',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`unexpected request: ${url}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
    })).resolves.toEqual(['ark-code-latest', 'deepseek-v4-pro'])
    expect(requests).toEqual([{ url: '/codex-api/provider-models', body: undefined }])
  })

  it('falls back to model/list when a required provider has no exclusive model list', async () => {
    const requests: Array<{ url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      requests.push({ url, body })

      if (url.endsWith('/codex-api/provider-models')) {
        return new Response(JSON.stringify({
          data: [],
          exclusive: false,
          source: 'codex-ui-default',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.endsWith('/codex-api/rpc')) {
        return new Response(JSON.stringify({
          result: {
            data: [
              { id: 'gpt-5.5' },
              { id: 'gpt-5.5-high' },
            ],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`unexpected request: ${url}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
    })).resolves.toEqual(['gpt-5.5', 'gpt-5.5-high'])
    expect(requests).toEqual([
      { url: '/codex-api/provider-models', body: undefined },
      { url: '/codex-api/rpc', body: { method: 'model/list', params: {} } },
    ])
  })
})

describe('listDirectoryComposioConnectors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends search queries as query params expected by the server', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        data: [],
        nextCursor: null,
        total: 0,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    await listDirectoryComposioConnectors('instagram', '50', 25)

    expect(requests).toEqual(['/codex-api/composio/connectors?query=instagram&cursor=50&limit=25'])
  })
})

describe('searchComposerFiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves directory and symlink metadata from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { path: 'src', kind: 'directory', isSymlink: false },
        { path: 'link.txt', kind: 'file', isSymlink: true },
      ],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })))

    const results = await searchComposerFiles('/tmp/project', 'src', 10)

    expect(results).toEqual([
      { path: 'src', kind: 'directory', isSymlink: false },
      { path: 'link.txt', kind: 'file', isSymlink: true },
    ])
  })
})

describe('searchFileLinkPaths', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves absolute path and root metadata from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          path: 'src/App.vue',
          absolutePath: '/tmp/project/src/App.vue',
          root: '/tmp/project',
          kind: 'file',
          isSymlink: false,
        },
      ],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })))

    const results = await searchFileLinkPaths('/tmp/project', 'src/App.vue', 10)

    expect(results).toEqual([
      {
        path: 'src/App.vue',
        absolutePath: '/tmp/project/src/App.vue',
        root: '/tmp/project',
        kind: 'file',
        isSymlink: false,
      },
    ])
  })
})

describe('getThreadUserMessageIndex', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps fork boundary entries with ordinal zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entries: [
        { turnId: 'turn-parent', ordinal: 1, preview: 'Parent prompt', title: 'Parent prompt' },
        {
          turnId: 'codexui-fork-boundary:child:parent',
          ordinal: 0,
          preview: 'Fork point',
          title: 'Fork point',
          kind: 'forkBoundary',
          sourceThreadId: 'parent',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadUserMessageIndex('child')).resolves.toEqual([
      { turnId: 'turn-parent', ordinal: 1, preview: 'Parent prompt', title: 'Parent prompt', kind: undefined, sourceThreadId: undefined },
      {
        turnId: 'codexui-fork-boundary:child:parent',
        ordinal: 0,
        preview: 'Fork point',
        title: 'Fork point',
        kind: 'forkBoundary',
        sourceThreadId: 'parent',
      },
    ])
  })
})

describe('searchThreadMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an empty result without a request for empty input', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchThreadMessages('thread-1', '   ')).resolves.toEqual({
      threadId: 'thread-1',
      query: '',
      totalMatches: 0,
      truncated: false,
      results: [],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to the thread message search endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        threadId: 'thread-1',
        query: 'alpha',
        totalMatches: 1,
        truncated: false,
        results: [
          {
            id: 'result-1',
            turnId: 'turn-1',
            turnIndex: 0,
            messageId: 'message-1',
            role: 'assistant',
            messageType: 'agentMessage',
            occurrenceIndex: 0,
            snippet: 'alpha',
            snippetMatchStart: 0,
            snippetMatchEnd: 5,
          },
        ],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await searchThreadMessages('thread-1', ' alpha ', 25)

    expect(fetchMock).toHaveBeenCalledWith('/codex-api/thread-message-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', query: 'alpha', limit: 25 }),
    })
    expect(result.totalMatches).toBe(1)
    expect(result.results[0]?.messageId).toBe('message-1')
  })

  it('throws a user-facing error when the endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Search unavailable',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(searchThreadMessages('thread-1', 'alpha')).rejects.toThrow('Search unavailable')
  })
})
