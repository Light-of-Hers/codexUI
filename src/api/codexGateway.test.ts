import { afterEach, describe, expect, it, vi } from 'vitest'
import { forkThread, listDirectoryComposioConnectors, resumeThread, searchComposerFiles, searchFileLinkPaths, startThread, startThreadTurn, steerThreadTurn } from './codexGateway'

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

describe('thread history persistence payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opts thread start, resume, and fork into extended history persistence', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/start') return emptyThreadResult('thread-started')
      if (request.method === 'thread/resume') return emptyThreadResult('thread-1')
      if (request.method === 'thread/fork') return emptyThreadResult('thread-forked')
      return {}
    })

    await startThread('/tmp/project', 'gpt-5.4')
    await resumeThread('thread-1')
    await forkThread('thread-1')

    expect(requests.map((request) => request.method)).toEqual([
      'thread/start',
      'thread/resume',
      'thread/fork',
    ])
    expect(requests.every((request) => request.params.persistExtendedHistory === true)).toBe(true)
  })

  it('passes explicit model provider overrides to thread lifecycle RPCs', async () => {
    const { requests } = mockRpcFetchWithResponder((request) => {
      if (request.method === 'thread/start') return { ...emptyThreadResult('thread-started'), modelProvider: 'moon', reasoningEffort: 'high' }
      if (request.method === 'thread/resume') return { ...emptyThreadResult('thread-1'), modelProvider: 'moon', reasoningEffort: 'low' }
      if (request.method === 'thread/fork') return { ...emptyThreadResult('thread-forked'), modelProvider: 'moon', reasoningEffort: 'xhigh' }
      return {}
    })

    const startedThread = await startThread('/tmp/project', 'glm-5.1', 'moon')
    const resumedThread = await resumeThread('thread-1', 'glm-5.1', 'moon')
    const forkedThread = await forkThread('thread-1', '/tmp/project', 'glm-5.1', 'moon')

    expect(requests.map((request) => request.params.modelProvider)).toEqual(['moon', 'moon', 'moon'])
    expect(requests.map((request) => request.params.model)).toEqual(['glm-5.1', 'glm-5.1', 'glm-5.1'])
    expect([startedThread.reasoningEffort, resumedThread.reasoningEffort, forkedThread.reasoningEffort]).toEqual([
      'high',
      'low',
      'xhigh',
    ])
  })

  it('reads lifecycle model metadata from nested thread snapshots', async () => {
    mockRpcFetchWithResponder((request) => {
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
