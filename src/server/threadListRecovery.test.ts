import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decorateThreadListWithForkLineage,
  invalidatePaginatedForkThreadListRecoveryCache,
  recoverUnlistedPaginatedForksInThreadList,
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

function thread(id: string, preview: string, updatedAt: number) {
  return {
    id,
    preview,
    modelProvider: 'rustcat',
    createdAt: updatedAt - 1,
    updatedAt,
    path: `/tmp/${id}.jsonl`,
    cwd: '/tmp/project',
    cliVersion: '0.147.0',
    source: 'vscode',
    gitInfo: null,
    turns: [],
  }
}

async function writePaginatedForkRollout(
  codexHome: string,
  threadId: string,
  parentThreadId: string,
  options: {
    cwd?: string
    historyBaseThreadId?: string
    historyMode?: 'legacy' | 'paginated'
    forkPointOrdinal?: number
    forkPointByteOffset?: number
    storageDirectory?: 'sessions' | 'archived_sessions'
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? '/tmp/project'
  const historyMode = options.historyMode ?? 'paginated'
  const rolloutDirectory = join(codexHome, options.storageDirectory ?? 'sessions', '2026', '08', '12')
  await mkdir(rolloutDirectory, { recursive: true })
  await writeFile(
    join(rolloutDirectory, `rollout-2026-08-12T00-00-00-${threadId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: threadId,
          forked_from_id: parentThreadId,
          cwd,
          history_mode: historyMode,
          history_base: historyMode === 'paginated'
            ? {
                thread_id: options.historyBaseThreadId ?? parentThreadId,
                end_ordinal_exclusive: options.forkPointOrdinal ?? 0,
                end_byte_offset: options.forkPointByteOffset ?? 0,
              }
            : undefined,
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
    ].join('\n'),
    'utf8',
  )
}

describe('recoverUnlistedPaginatedForksInThreadList', () => {
  it('restores a persistent paginated fork that Codex omits before its first local turn', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-child', 'thread-parent')
    const appServer = {
      rpc: vi.fn(async (method: string, params: unknown) => {
        expect(method).toBe('thread/read')
        expect(params).toEqual({ threadId: 'thread-child', includeTurns: false })
        return { thread: thread('thread-child', '', 200) }
      }),
    }

    try {
      const result = await recoverUnlistedPaginatedForksInThreadList(
        { data: [thread('thread-parent', 'Original context', 100)], nextCursor: 'next-page' },
        { archived: false, cursor: null, cwd: '/tmp/project' },
        appServer,
      ) as { data: Array<{ id: string; preview: string }>; nextCursor: string | null }

      expect(result.nextCursor).toBe('next-page')
      expect(result.data).toEqual([
        expect.objectContaining({ id: 'thread-child', preview: 'Fork: Original context' }),
        expect.objectContaining({ id: 'thread-parent' }),
      ])
      expect(appServer.rpc).toHaveBeenCalledTimes(1)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('leaves later pages to the upstream cursor and avoids duplicate recovery reads', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-child', 'thread-parent')
    const appServer = { rpc: vi.fn() }
    const result = { data: [thread('thread-parent', 'Original context', 100)], nextCursor: null }

    try {
      await expect(recoverUnlistedPaginatedForksInThreadList(
        result,
        { archived: false, cursor: 'upstream-page-two' },
        appServer,
      )).resolves.toBe(result)
      expect(appServer.rpc).not.toHaveBeenCalled()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('skips paginated forks outside the requested working directories before reading them', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-other-project', 'thread-parent', { cwd: '/tmp/other-project' })
    const appServer = { rpc: vi.fn() }
    const result = { data: [thread('thread-parent', 'Original context', 100)], nextCursor: null }

    try {
      await expect(recoverUnlistedPaginatedForksInThreadList(
        result,
        { archived: false, cursor: null, cwd: ['/tmp/project', '/tmp/another-project'] },
        appServer,
      )).resolves.toBe(result)
      expect(appServer.rpc).not.toHaveBeenCalled()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('rejects a recovered thread when its canonical cwd disagrees with rollout metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-child', 'thread-parent')
    const appServer = {
      rpc: vi.fn(async () => ({ thread: { ...thread('thread-child', '', 200), cwd: '/tmp/other-project' } })),
    }
    const result = { data: [thread('thread-parent', 'Original context', 100)], nextCursor: null }

    try {
      await expect(recoverUnlistedPaginatedForksInThreadList(
        result,
        { archived: false, cursor: null, cwd: '/tmp/project' },
        appServer,
      )).resolves.toBe(result)
      expect(appServer.rpc).toHaveBeenCalledTimes(1)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('attaches direct parent lineage and only exposes a fork point in that parent', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-child', 'thread-parent', {
      forkPointOrdinal: 41,
      forkPointByteOffset: 2048,
    })
    await writePaginatedForkRollout(codexHome, 'thread-grandchild', 'thread-child', {
      historyBaseThreadId: 'thread-parent',
      forkPointOrdinal: 41,
      forkPointByteOffset: 2048,
    })
    await writePaginatedForkRollout(codexHome, 'thread-legacy-child', 'thread-parent', {
      historyMode: 'legacy',
    })

    try {
      const result = await decorateThreadListWithForkLineage({
        data: [
          thread('thread-parent', 'Parent', 100),
          thread('thread-child', 'Child', 90),
          thread('thread-grandchild', 'Grandchild', 80),
          thread('thread-legacy-child', 'Legacy child', 70),
        ],
        nextCursor: null,
      }) as { data: Array<Record<string, unknown>> }

      expect(result.data[1]).toMatchObject({
        id: 'thread-child',
        forkedFromId: 'thread-parent',
        forkPointOrdinal: 41,
        forkPointByteOffset: 2048,
      })
      expect(result.data[2]).toMatchObject({
        id: 'thread-grandchild',
        forkedFromId: 'thread-child',
        forkPointOrdinal: null,
        forkPointByteOffset: null,
      })
      expect(result.data[3]).toMatchObject({
        id: 'thread-legacy-child',
        forkedFromId: 'thread-parent',
        forkPointOrdinal: null,
        forkPointByteOffset: null,
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('reparents a child through an archived parent and uses the archived branch point', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-archived-child', 'thread-parent', {
      forkPointOrdinal: 41,
      forkPointByteOffset: 2048,
      storageDirectory: 'archived_sessions',
    })
    await writePaginatedForkRollout(codexHome, 'thread-grandchild', 'thread-archived-child', {
      forkPointOrdinal: 9,
      forkPointByteOffset: 512,
    })

    try {
      const result = await decorateThreadListWithForkLineage({
        data: [
          thread('thread-parent', 'Parent', 100),
          thread('thread-grandchild', 'Grandchild', 80),
        ],
        nextCursor: null,
      }) as { data: Array<Record<string, unknown>> }

      expect(result.data[1]).toMatchObject({
        id: 'thread-grandchild',
        forkedFromId: 'thread-parent',
        forkPointOrdinal: 41,
        forkPointByteOffset: 2048,
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('uses an inherited history base when a deleted parent rollout is unavailable', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-grandchild', 'thread-deleted-child', {
      historyBaseThreadId: 'thread-parent',
      forkPointOrdinal: 41,
      forkPointByteOffset: 2048,
    })

    try {
      const result = await decorateThreadListWithForkLineage({
        data: [
          thread('thread-parent', 'Parent', 100),
          thread('thread-grandchild', 'Grandchild', 80),
        ],
        nextCursor: null,
      }) as { data: Array<Record<string, unknown>> }

      expect(result.data[1]).toMatchObject({
        id: 'thread-grandchild',
        forkedFromId: 'thread-parent',
        forkPointOrdinal: 41,
        forkPointByteOffset: 2048,
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not reparent through an active parent that is merely absent from this page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-thread-list-recovery-'))
    process.env.CODEX_HOME = codexHome
    await writePaginatedForkRollout(codexHome, 'thread-active-child', 'thread-parent', {
      forkPointOrdinal: 41,
    })
    await writePaginatedForkRollout(codexHome, 'thread-grandchild', 'thread-active-child', {
      historyBaseThreadId: 'thread-parent',
      forkPointOrdinal: 41,
    })

    try {
      const result = await decorateThreadListWithForkLineage({
        data: [
          thread('thread-parent', 'Parent', 100),
          thread('thread-grandchild', 'Grandchild', 80),
        ],
        nextCursor: null,
      }) as { data: Array<Record<string, unknown>> }

      expect(result.data[1]).not.toHaveProperty('forkedFromId')
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
