import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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

async function writePaginatedForkRollout(codexHome: string, threadId: string, parentThreadId: string): Promise<void> {
  const rolloutDirectory = join(codexHome, 'sessions', '2026', '08', '12')
  await mkdir(rolloutDirectory, { recursive: true })
  await writeFile(
    join(rolloutDirectory, `rollout-2026-08-12T00-00-00-${threadId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: threadId,
          forked_from_id: parentThreadId,
          history_mode: 'paginated',
          history_base: { thread_id: parentThreadId },
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
        { archived: false, cursor: null },
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
})
