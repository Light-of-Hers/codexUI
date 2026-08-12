import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPaginatedForkUserMessageIndex,
  buildSessionTurnsFromRollout,
  invalidatePaginatedForkThreadListRecoveryCache,
  mergePaginatedForkHistoryIntoThreadResult,
} from './codexAppServerBridge'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  invalidatePaginatedForkThreadListRecoveryCache()
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

type RolloutTurn = {
  id: string
  startOrdinal: number
  endOrdinal: number
  userText: string
}

async function writeRollout(
  codexHome: string,
  threadId: string,
  turns: RolloutTurn[],
  options: {
    parentThreadId?: string
    historyBaseThreadId?: string
    historyBaseOrdinal?: number
    historyBaseByteOffset?: number
  } = {},
): Promise<void> {
  const directory = join(codexHome, 'sessions', '2026', '08', '12')
  await mkdir(directory, { recursive: true })
  const payload: Record<string, unknown> = {
    session_id: threadId,
    cwd: '/tmp/project',
  }
  if (options.parentThreadId) payload.forked_from_id = options.parentThreadId
  if (options.historyBaseThreadId) {
    payload.history_mode = 'paginated'
    payload.history_base = {
      thread_id: options.historyBaseThreadId,
      end_ordinal_exclusive: options.historyBaseOrdinal ?? 0,
      end_byte_offset: options.historyBaseByteOffset ?? 0,
    }
  }

  const rows: Array<Record<string, unknown>> = [{ type: 'session_meta', payload }]
  for (const turn of turns) {
    rows.push(
      { ordinal: turn.startOrdinal, type: 'turn_context', payload: { turn_id: turn.id } },
      {
        ordinal: turn.startOrdinal + 1,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: turn.userText }],
        },
      },
      { ordinal: turn.endOrdinal, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } },
    )
  }
  await writeFile(
    rolloutPath(codexHome, threadId),
    rows.map((row) => JSON.stringify(row)).join('\n'),
    'utf8',
  )
}

function rolloutPath(codexHome: string, threadId: string): string {
  return join(codexHome, 'sessions', '2026', '08', '12', `rollout-2026-08-12T00-00-00-${threadId}.jsonl`)
}

function threadResult(threadId: string, turnIds: string[], sessionPath = ''): unknown {
  return {
    thread: {
      id: threadId,
      ...(sessionPath ? { path: sessionPath } : {}),
      turns: turnIds.map((id) => ({
        id,
        status: 'completed',
        items: [{ id: `user-${id}`, type: 'userMessage', content: [] }],
      })),
    },
  }
}

function turnIds(result: unknown): string[] {
  const record = result as { thread?: { turns?: Array<{ id?: string }> } }
  return record.thread?.turns?.map((turn) => turn.id ?? '') ?? []
}

describe('paginated fork history reconstruction', () => {
  it('recovers the local user and assistant messages when an older app-server lacks turns/list', () => {
    const turns = buildSessionTurnsFromRollout([
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-one' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-one',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue from here' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'assistant-one',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Recovered reply' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-one' } }),
    ].join('\n'))

    expect(turns).toEqual([{
      id: 'turn-one',
      status: 'completed',
      items: [
        { id: 'user-one', type: 'userMessage', content: [{ type: 'text', text: 'Continue from here' }] },
        { id: 'assistant-one', type: 'agentMessage', text: 'Recovered reply' },
      ],
    }])
  })

  it('reconstructs the inherited prefix through its exact history base and adds a fork boundary', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-paginated-history-'))
    process.env.CODEX_HOME = codexHome
    await writeRollout(codexHome, 'parent', [
      { id: 'parent-one', startOrdinal: 10, endOrdinal: 12, userText: 'first parent prompt' },
      { id: 'parent-two', startOrdinal: 20, endOrdinal: 22, userText: 'second parent prompt' },
    ])
    await writeRollout(codexHome, 'child', [
      { id: 'child-one', startOrdinal: 30, endOrdinal: 32, userText: 'child prompt' },
    ], {
      parentThreadId: 'parent',
      historyBaseThreadId: 'parent',
      historyBaseOrdinal: 20,
    })

    try {
      const calls: string[] = []
      const merged = await mergePaginatedForkHistoryIntoThreadResult(
        threadResult('child', ['child-one']),
        async (threadId) => {
          calls.push(threadId)
          return threadResult('parent', ['parent-one', 'parent-two'])
        },
      )

      expect(turnIds(merged)).toEqual([
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
      expect(calls).toEqual(['parent'])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('retains nested inherited prefixes and produces matching user-message navigation markers', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-paginated-history-'))
    process.env.CODEX_HOME = codexHome
    await writeRollout(codexHome, 'root', [
      { id: 'root-one', startOrdinal: 10, endOrdinal: 12, userText: 'root prompt' },
    ])
    await writeRollout(codexHome, 'child', [
      { id: 'child-one', startOrdinal: 30, endOrdinal: 32, userText: 'child prompt' },
    ], {
      parentThreadId: 'root',
      historyBaseThreadId: 'root',
      historyBaseOrdinal: 20,
    })
    await writeRollout(codexHome, 'grandchild', [
      { id: 'grandchild-one', startOrdinal: 50, endOrdinal: 52, userText: 'grandchild prompt' },
    ], {
      parentThreadId: 'child',
      historyBaseThreadId: 'child',
      historyBaseOrdinal: 40,
    })

    try {
      const resultByThreadId = new Map<string, unknown>([
        ['root', threadResult('root', ['root-one'])],
        ['child', threadResult('child', ['child-one'])],
      ])
      const merged = await mergePaginatedForkHistoryIntoThreadResult(
        threadResult('grandchild', ['grandchild-one']),
        async (threadId) => resultByThreadId.get(threadId) ?? threadResult(threadId, []),
      )
      const navigation = await buildPaginatedForkUserMessageIndex('grandchild')

      expect(turnIds(merged)).toEqual([
        'root-one',
        'codexui-fork-boundary:child:root',
        'child-one',
        'codexui-fork-boundary:grandchild:child',
        'grandchild-one',
      ])
      expect(navigation.map((entry) => [entry.turnId, entry.ordinal, entry.kind])).toEqual([
        ['root-one', 1, undefined],
        ['codexui-fork-boundary:child:root', 1, 'forkBoundary'],
        ['child-one', 2, undefined],
        ['codexui-fork-boundary:grandchild:child', 2, 'forkBoundary'],
        ['grandchild-one', 3, undefined],
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('only inserts the marker when app-server already returned the inherited prefix', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-paginated-history-'))
    process.env.CODEX_HOME = codexHome
    await writeRollout(codexHome, 'parent', [
      { id: 'parent-one', startOrdinal: 10, endOrdinal: 12, userText: 'parent prompt' },
    ])
    await writeRollout(codexHome, 'child', [
      { id: 'child-one', startOrdinal: 30, endOrdinal: 32, userText: 'child prompt' },
    ], {
      parentThreadId: 'parent',
      historyBaseThreadId: 'parent',
      historyBaseOrdinal: 20,
    })

    try {
      const readThread = async (): Promise<unknown> => {
        throw new Error('the inherited prefix should not require an ancestor read')
      }
      const merged = await mergePaginatedForkHistoryIntoThreadResult(
        threadResult('child', ['parent-one', 'child-one']),
        readThread,
      )

      expect(turnIds(merged)).toEqual([
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('marks the copied prefix of a legacy fork in both message and user-message history', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-legacy-fork-history-'))
    process.env.CODEX_HOME = codexHome
    await writeRollout(codexHome, 'parent', [
      { id: 'parent-one', startOrdinal: 10, endOrdinal: 12, userText: 'first parent prompt' },
      { id: 'parent-two', startOrdinal: 20, endOrdinal: 22, userText: 'second parent prompt' },
    ])
    await writeRollout(codexHome, 'child', [
      { id: 'parent-one', startOrdinal: 10, endOrdinal: 12, userText: 'first parent prompt' },
      { id: 'child-one', startOrdinal: 30, endOrdinal: 32, userText: 'child prompt' },
    ], { parentThreadId: 'parent' })

    try {
      const merged = await mergePaginatedForkHistoryIntoThreadResult(
        threadResult('child', ['parent-one', 'child-one']),
        async () => threadResult('parent', ['parent-one', 'parent-two']),
      )
      const navigation = await buildPaginatedForkUserMessageIndex('child')

      expect(turnIds(merged)).toEqual([
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
      expect(navigation.map((entry) => [entry.turnId, entry.ordinal, entry.kind])).toEqual([
        ['parent-one', 1, undefined],
        ['codexui-fork-boundary:child:parent', 1, 'forkBoundary'],
        ['child-one', 2, undefined],
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('keeps inherited legacy markers ahead of a nested child fork point', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-legacy-fork-history-'))
    process.env.CODEX_HOME = codexHome
    await writeRollout(codexHome, 'root', [
      { id: 'root-one', startOrdinal: 10, endOrdinal: 12, userText: 'root prompt' },
      { id: 'root-two', startOrdinal: 20, endOrdinal: 22, userText: 'later root prompt' },
    ])
    await writeRollout(codexHome, 'parent', [
      { id: 'root-one', startOrdinal: 10, endOrdinal: 12, userText: 'root prompt' },
      { id: 'parent-one', startOrdinal: 30, endOrdinal: 32, userText: 'parent prompt' },
    ], { parentThreadId: 'root' })
    await writeRollout(codexHome, 'child', [
      { id: 'root-one', startOrdinal: 10, endOrdinal: 12, userText: 'root prompt' },
      { id: 'parent-one', startOrdinal: 30, endOrdinal: 32, userText: 'parent prompt' },
      { id: 'child-one', startOrdinal: 40, endOrdinal: 42, userText: 'child prompt' },
    ], { parentThreadId: 'parent' })

    try {
      const results = new Map<string, unknown>([
        ['root', threadResult('root', ['root-one', 'root-two'])],
        ['parent', threadResult('parent', ['root-one', 'parent-one'])],
      ])
      const merged = await mergePaginatedForkHistoryIntoThreadResult(
        threadResult('child', ['root-one', 'parent-one', 'child-one']),
        async (threadId) => results.get(threadId) ?? threadResult(threadId, []),
      )
      const navigation = await buildPaginatedForkUserMessageIndex('child')

      expect(turnIds(merged)).toEqual([
        'root-one',
        'codexui-fork-boundary:parent:root',
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
      expect(navigation.map((entry) => entry.turnId)).toEqual([
        'root-one',
        'codexui-fork-boundary:parent:root',
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('uses current thread metadata when the lineage scan cache predates a newly forked session', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-paginated-history-'))
    process.env.CODEX_HOME = codexHome
    await writeRollout(codexHome, 'parent', [
      { id: 'parent-one', startOrdinal: 10, endOrdinal: 12, userText: 'parent prompt' },
    ])

    try {
      // Populate the global scan before the child session exists.
      await buildPaginatedForkUserMessageIndex('parent')
      await writeRollout(codexHome, 'child', [
        { id: 'child-one', startOrdinal: 30, endOrdinal: 32, userText: 'child prompt' },
      ], {
        parentThreadId: 'parent',
        historyBaseThreadId: 'parent',
        historyBaseOrdinal: 20,
      })

      const childSessionPath = rolloutPath(codexHome, 'child')
      const merged = await mergePaginatedForkHistoryIntoThreadResult(
        threadResult('child', ['parent-one', 'child-one'], childSessionPath),
        async () => {
          throw new Error('the inherited prefix is already materialized')
        },
      )
      const navigation = await buildPaginatedForkUserMessageIndex('child', childSessionPath)

      expect(turnIds(merged)).toEqual([
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
      expect(navigation.map((entry) => entry.turnId)).toEqual([
        'parent-one',
        'codexui-fork-boundary:child:parent',
        'child-one',
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
