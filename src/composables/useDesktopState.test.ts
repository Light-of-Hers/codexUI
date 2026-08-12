import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  applyModelContextWindowToThreadTokenUsage,
  excludeLiveMessagesAlreadyPersisted,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  inferProviderFromModel,
  isThreadUnreadByLastRead,
  normalizeProviderId,
  parseGoalSlashCommand,
  removeThreadFromGroups,
  useDesktopState,
  readSelectedProvider,
  readSelectedModelForThreadContext,
  writeSelectedProviderForContext,
} from './useDesktopState'
import type { UiProjectGroup } from '../types/codex'
import type { RpcNotification, WorkspaceRootsState } from '../api/codexGateway'

const gatewayMocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  clearThreadGoal: vi.fn(),
  forkThread: vi.fn(),
  forkThreadThroughTurn: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAvailableCollaborationModes: vi.fn(),
  getAvailableModelIds: vi.fn(),
  getArkModelIds: vi.fn(),
  getArkModelMetadata: vi.fn(),
  getCurrentModelConfig: vi.fn(),
  getThreadGoal: vi.fn(),
  getMoonBridgeModelIds: vi.fn(),
  getMoonBridgeModelMetadata: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getSkillsList: vi.fn(),
  getThreadDetail: vi.fn(),
  getThreadSummary: vi.fn(),
  getThreadGroupsPage: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getThreadUserMessageCount: vi.fn(),
  getThreadUserMessageIndex: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
  generateThreadTitle: vi.fn(),
  interruptThreadTurn: vi.fn(),
  persistThreadTitle: vi.fn(),
  renameThread: vi.fn(),
  replyToServerRequest: vi.fn(),
  resumeThread: vi.fn(),
  revertThreadFileChanges: vi.fn(),
  rollbackThread: vi.fn(),
  setCodexSpeedMode: vi.fn(),
  setThreadGoal: vi.fn(),
  setThreadQueueState: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  startThread: vi.fn(),
  startThreadTurn: vi.fn(),
  steerThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))

function thread(id: string, cwd: string, options: { hasWorktree?: boolean } = {}) {
  return {
    id,
    title: id,
    projectName: cwd ? cwd.split('/').at(-1) || cwd : 'Projectless',
    cwd,
    hasWorktree: options.hasWorktree ?? false,
    createdAtIso: '2026-04-28T00:00:00.000Z',
    updatedAtIso: '2026-04-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
  }
}

function installTestWindow(initialStorage: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialStorage))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  gatewayMocks.getThreadDetail.mockReset()
  gatewayMocks.getThreadDetail.mockResolvedValue({
    messages: [],
    inProgress: false,
    activeTurnId: '',
    hasMoreOlder: false,
    turnIndexByTurnId: {},
  })
  gatewayMocks.getThreadSummary.mockResolvedValue(thread('thread-a', '/tmp/project'))
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getThreadUserMessageCount.mockResolvedValue(0)
  gatewayMocks.getThreadUserMessageIndex.mockResolvedValue([])
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
  gatewayMocks.getArkModelIds.mockResolvedValue([])
  gatewayMocks.getArkModelMetadata.mockResolvedValue([])
  gatewayMocks.getMoonBridgeModelIds.mockResolvedValue([])
  gatewayMocks.getMoonBridgeModelMetadata.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function flushMicrotasks(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
  }
}

async function waitForCalls(mock: { mock: { calls: unknown[] } }, minCalls: number): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (mock.mock.calls.length >= minCalls) return
    await Promise.resolve()
  }
  throw new Error(`Timed out waiting for ${minCalls} mock invocation(s)`)
}

describe('excludeLiveMessagesAlreadyPersisted', () => {
  it('keeps only live cards that are not already represented by persisted item ids', () => {
    const persisted = [
      { id: 'command-1', role: 'system' as const, text: 'pwd', messageType: 'commandExecution' },
      { id: 'agent-1', role: 'assistant' as const, text: 'Done.', messageType: 'agentMessage' },
    ]
    const live = [
      { id: 'command-1', role: 'system' as const, text: 'pwd', messageType: 'commandExecution' },
      { id: 'command-2', role: 'system' as const, text: 'git status', messageType: 'commandExecution' },
      { id: 'agent-1', role: 'assistant' as const, text: 'Done.', messageType: 'agentMessage.live' },
    ]

    expect(excludeLiveMessagesAlreadyPersisted(persisted, live).map((message) => message.id)).toEqual(['command-2'])
  })
})

describe('filterGroupsByWorkspaceRoots', () => {
  it('keeps projectless chats visible when workspace roots are configured', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'Projectless',
        threads: [thread('projectless-chat', '')],
      },
      {
        projectName: 'allowed-project',
        threads: [thread('allowed-chat', '/tmp/allowed-project')],
      },
      {
        projectName: 'other-project',
        threads: [thread('other-chat', '/tmp/other-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/allowed-project'],
      labels: {},
      active: ['/tmp/allowed-project'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'Projectless',
      'allowed-project',
    ])
  })

  it('keeps workspace roots with the same folder name as separate projects', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'api',
        threads: [
          thread('first-api-chat', '/tmp/first/api'),
          thread('second-api-chat', '/tmp/second/api'),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {},
      active: ['/tmp/first/api', '/tmp/second/api'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      '/tmp/first/api',
      '/tmp/second/api',
    ])
  })

  it('uses Codex project-order when workspace roots are hydrated', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('alpha-chat', '/tmp/alpha')],
      },
      {
        projectName: 'beta',
        threads: [thread('beta-chat', '/tmp/beta')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/alpha', '/tmp/beta'],
      labels: {},
      active: ['/tmp/alpha'],
      projectOrder: ['/tmp/beta', '/tmp/alpha'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'beta',
      'alpha',
    ])
  })

  it('keeps empty duplicate workspace roots visible in Codex project order', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'TestChat',
        threads: [thread('testchat-chat', '/Users/igor/temp/TestChat')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      labels: {},
      active: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      projectOrder: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['/Users/igor/Documents/New project 2/TestChat', 0],
      ['/Users/igor/temp/TestChat', 1],
    ])
  })

  it('keeps remote projects from Codex project order visible as empty project rows', () => {
    const groups: UiProjectGroup[] = []
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['remote-project-id', 0],
      ['local-project', 0],
    ])
  })

  it('keeps managed worktree threads under the matching workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['codex-web-local', ['main-chat', 'worktree-chat']],
    ])
  })

  it('keeps unregistered managed worktrees under the main root when another managed worktree root is registered', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('registered-worktree-chat', '/Users/igor/.codex/worktrees/a77f/codex-web-local', { hasWorktree: true }),
          thread('unregistered-worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: [
        '/Users/igor/Git-projects/codex-web-local',
        '/Users/igor/.codex/worktrees/a77f/codex-web-local',
      ],
      labels: {
        '/Users/igor/.codex/worktrees/a77f/codex-web-local': 'codex-web-local2',
      },
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat', 'unregistered-worktree-chat']],
      ['/Users/igor/.codex/worktrees/a77f/codex-web-local', ['registered-worktree-chat']],
    ])
  })

  it('does not group unrelated git worktrees under a same-leaf workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('other-git-worktree-chat', '/tmp/other/.git/worktrees/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat']],
    ])
  })
})

describe('removeThreadFromGroups', () => {
  it('removes an archived thread and drops the now-empty project group', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
      {
        projectName: 'archived-project',
        threads: [thread('archive-me', '/tmp/archived-project')],
      },
      {
        projectName: 'beta',
        threads: [thread('keep-beta', '/tmp/beta')],
      },
      {
        projectName: 'empty-workspace-root',
        threads: [],
      },
    ]

    expect(removeThreadFromGroups(groups, 'archive-me').map((group) => [
      group.projectName,
      group.threads.map((row) => row.id),
    ])).toEqual([
      ['alpha', ['keep-alpha']],
      ['beta', ['keep-beta']],
      ['empty-workspace-root', []],
    ])
  })

  it('preserves referential identity when the thread is absent', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
    ]

    expect(removeThreadFromGroups(groups, 'missing-thread')).toBe(groups)
  })
})

describe('workspace roots project persistence helpers', () => {
  it('collects duplicate-path project roots by full path when removing a project', () => {
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {
        '/tmp/first/api': 'First API',
        '/tmp/second/api': 'Second API',
      },
      active: ['/tmp/first/api'],
      projectOrder: ['/tmp/first/api', '/tmp/second/api'],
    }

    expect([...collectWorkspaceRootPathsForProjectRemoval(rootsState, '/tmp/first/api')]).toEqual([
      '/tmp/first/api',
    ])
  })

  it('preserves remote project ids in explicit project order when persisting workspace roots', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'local-project',
        threads: [thread('local-chat', '/tmp/local-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(buildWorkspaceRootsProjectOrderState(rootsState, ['remote-project-id', 'local-project'], groups)).toEqual({
      order: ['/tmp/local-project'],
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
    })
  })
})

describe('provider session helpers', () => {
  it('defaults provider selections to Codex', () => {
    expect(normalizeProviderId('')).toBe('codex')
    expect(normalizeProviderId('openai')).toBe('codex')
    expect(normalizeProviderId('rustcat')).toBe('rustcat')
    expect(normalizeProviderId('openrouter-free')).toBe('openrouter-free')
    expect(normalizeProviderId('custom-endpoint')).toBe('custom-endpoint')
    expect(normalizeProviderId('ark')).toBe('ark')
    expect(normalizeProviderId('cursor')).toBe('cursor')
    expect(readSelectedProvider({}, '')).toBe('codex')
  })

  it('stores provider selections by session context', () => {
    const next = writeSelectedProviderForContext({}, 'thread-a', 'moon')

    expect(readSelectedProvider(next, 'thread-a')).toBe('moon')
    expect(readSelectedProvider(next, 'thread-b')).toBe('codex')
  })

  it('stores dynamic provider selections by session context', () => {
    const next = writeSelectedProviderForContext({}, 'thread-a', 'rustcat')

    expect(readSelectedProvider(next, 'thread-a')).toBe('rustcat')
  })

  it('persists explicit Codex provider selections for existing sessions', () => {
    const next = writeSelectedProviderForContext({}, 'thread-a', 'codex')

    expect(next).toEqual({ 'thread-a': 'codex' })
    expect(readSelectedProvider(next, 'thread-a')).toBe('codex')
  })

  it('maps the new-thread model context to the new-thread provider context', () => {
    const next = writeSelectedProviderForContext({}, '__new-thread__', 'moon')

    expect(readSelectedProvider(next, '')).toBe('moon')
    expect(readSelectedProvider(next, '__new-thread__')).toBe('moon')
  })

  it('preserves the new-session provider while opening the composer', () => {
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        '__new-thread-provider__': 'moon',
      }),
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::moon': 'glm-5.1',
      }),
    })

    const state = useDesktopState()

    expect(state.selectedProvider.value).toBe('moon')

    state.primeSelectedThread('')

    expect(state.selectedProvider.value).toBe('moon')
    expect(window.localStorage.getItem('codex-web-local.provider-by-context.v1')).toBe(JSON.stringify({
      '__new-thread-provider__': 'moon',
    }))
  })

  it('stores composer provider changes in the new-session context', () => {
    installTestWindow()

    const state = useDesktopState()

    state.primeSelectedThread('existing-thread')
    state.setSelectedProviderForComposerContext('__new-thread__', 'moon')

    expect(state.selectedProvider.value).toBe('moon')
    expect(readSelectedProvider(
      JSON.parse(window.localStorage.getItem('codex-web-local.provider-by-context.v1') ?? '{}'),
      '',
    )).toBe('moon')
  })

  it('infers Moon Bridge provider from session model catalog entries', () => {
    expect(inferProviderFromModel('glm-5.1', ['glm-5.1', 'kimi-k2.6'])).toBe('moon')
    expect(inferProviderFromModel('gpt-5.4-mini', ['glm-5.1', 'kimi-k2.6'])).toBeNull()
  })

  it('infers Ark provider from Ark catalog entries', () => {
    expect(inferProviderFromModel('doubao-seed-2-0-code-preview-260215', [], ['doubao-seed-2-0-code-preview-260215'])).toBe('ark')
  })

  it('keeps the new-thread model selection scoped to the active session provider', () => {
    const state = {
      '__new-thread__': 'gpt-5.4-mini',
      '__new-thread-provider__::codex': 'gpt-5.4-mini',
      '__new-thread-provider__::moon': 'glm-5.1',
    }

    expect(readSelectedModelForThreadContext(state, '__new-thread__', 'moon')).toBe('glm-5.1')
    expect(readSelectedModelForThreadContext(state, '', 'codex')).toBe('gpt-5.4-mini')
  })

  it('updates the current model ref when selecting a model for the new-thread composer', () => {
    const state = useDesktopState()

    state.setSelectedModelIdForThread('__new-thread__', 'gpt-5.4-mini')

    expect(state.selectedModelId.value).toBe('gpt-5.4-mini')
  })

  it('recomputes token usage from the selected model context window', () => {
    const usage = applyModelContextWindowToThreadTokenUsage({
      total: {
        totalTokens: 15000,
        inputTokens: 9000,
        cachedInputTokens: 0,
        outputTokens: 6000,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 15000,
        inputTokens: 9000,
        cachedInputTokens: 0,
        outputTokens: 6000,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 12000,
      currentContextTokens: 15000,
      remainingContextTokens: 0,
      remainingContextPercent: 0,
    }, 200000)

    expect(usage).toMatchObject({
      modelContextWindow: 200000,
      currentContextTokens: 15000,
      remainingContextTokens: 185000,
      remainingContextPercent: 93,
    })
  })
})

describe('thread unread state helpers', () => {
  const cutoffIso = '2026-05-01T12:00:00.000Z'

  it('uses the initialization cutoff when a thread has no read state', () => {
    expect(isThreadUnreadByLastRead('2026-05-01T11:59:59.000Z', undefined, cutoffIso)).toBe(false)
    expect(isThreadUnreadByLastRead('2026-05-01T12:00:01.000Z', undefined, cutoffIso)).toBe(true)
  })

  it('uses per-thread read state instead of the global cutoff after a thread is read', () => {
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:30:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(false)
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:50:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(true)
  })
})

describe('collaboration mode selection', () => {
  it('does not carry plan mode from new chats into existing threads', () => {
    installTestWindow({
      'codex-web-local.collaboration-mode.v1': 'plan',
    })

    const state = useDesktopState()

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')

    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(window.localStorage.getItem('codex-web-local.collaboration-mode-by-context.v1')).toBe(null)

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')
    state.primeSelectedThread('thread-b')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('plan')
  })
})

describe('Codex CLI availability', () => {
  it('surfaces a chat runtime error when the app-server bridge cannot find Codex CLI', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockRejectedValue(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })

    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
  })

  it('clears a previous Codex CLI missing banner when a later refresh fails for another reason', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockRejectedValueOnce(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))
      .mockRejectedValueOnce(new Error('Connection lost'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.error.value).toBe('Connection lost')
    expect(state.codexCliMissingError.value).toBe('')
  })
})

describe('thread selection persistence', () => {
  it('replaces a stored missing selected thread after the complete thread list loads', async () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'missing-thread',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    expect(state.selectedThreadId.value).toBe('thread-a')
    expect(window.localStorage.getItem('codex-web-local.selected-thread-id.v1')).toBe('thread-a')
  })

  it('keeps a stored missing selected thread while thread pagination is incomplete', async () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'older-thread',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: 'next-page',
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    expect(state.selectedThreadId.value).toBe('older-thread')
    expect(window.localStorage.getItem('codex-web-local.selected-thread-id.v1')).toBe('older-thread')
  })
})

describe('session fork', () => {
  it('inherits source-session settings instead of sending cached runtime overrides', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'project',
          threads: [thread('thread-a', '/tmp/project'), thread('thread-forked', '/tmp/project')],
        }],
        nextCursor: null,
      })
    gatewayMocks.forkThread.mockResolvedValue({
      threadId: 'thread-forked',
      cwd: '/tmp/project',
      model: 'gpt-5.5-extra-high',
      modelProvider: 'cursor',
      reasoningEffort: 'high',
      messages: [],
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    await expect(state.forkThreadById('thread-a')).resolves.toBe('thread-forked')
    expect(gatewayMocks.forkThread).toHaveBeenCalledWith('thread-a')
    expect(state.selectedThreadId.value).toBe('thread-forked')
  })

  it('forks from a response through lastTurnId without rolling back the fork', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'project',
          threads: [thread('thread-a', '/tmp/project'), thread('thread-forked', '/tmp/project')],
        }],
        nextCursor: null,
      })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{
        id: 'agent-1',
        role: 'assistant',
        text: 'Done.',
        messageType: 'agentMessage',
        turnId: 'turn-1',
        turnIndex: 0,
      }],
      inProgress: true,
      activeTurnId: 'turn-active',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0, 'turn-active': 1 },
    })
    gatewayMocks.forkThreadThroughTurn.mockResolvedValue({
      threadId: 'thread-forked',
      cwd: '/tmp/project',
      model: 'gpt-5.5-extra-high',
      modelProvider: 'cursor',
      reasoningEffort: 'high',
      messages: [{
        id: 'agent-1',
        role: 'assistant',
        text: 'Done.',
        messageType: 'agentMessage',
        turnId: 'turn-1',
        turnIndex: 0,
      }],
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })
    await state.loadMessages('thread-a')

    await expect(state.forkThreadFromTurn('thread-a', 'turn-1', 0)).resolves.toBe('thread-forked')

    expect(gatewayMocks.forkThreadThroughTurn).toHaveBeenCalledWith('thread-a', 'turn-1')
    expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('thread-forked')
  })
})

describe('thread cache keep-warm', () => {
  const RECENT_LRU_KEY = 'codex-web-local.recently-visited-thread-ids.v1'

  function messagePayload(id: string) {
    return {
      id,
      turnId: 'turn-1',
      turnIndex: 0,
      role: 'assistant' as const,
      kind: 'agent-message' as const,
      contentBlocks: [{ type: 'text' as const, text: 'hi' }],
    }
  }

  it('records visited threads in an LRU list with a cap and dedupes repeats', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'project',
        threads: [
          thread('thread-a', '/tmp/project'),
          thread('thread-b', '/tmp/project'),
        ],
      }],
      nextCursor: null,
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    await state.selectThread('thread-a')
    await state.selectThread('thread-b')
    await state.selectThread('thread-a')

    const stored = window.localStorage.getItem(RECENT_LRU_KEY)
    expect(stored && JSON.parse(stored)).toEqual(['thread-a', 'thread-b'])
  })

  it('preserves persisted messages for LRU threads that fall off the sidebar', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'project',
          threads: [
            thread('thread-a', '/tmp/project'),
            thread('thread-b', '/tmp/project'),
          ],
        }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'project',
          threads: [thread('thread-b', '/tmp/project')],
        }],
        nextCursor: null,
      })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [messagePayload('m-a')],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: '',
      modelProvider: '',
      reasoningEffort: '',
      messages: [messagePayload('m-a')],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    await state.selectThread('thread-a')
    await flushMicrotasks()
    await state.selectThread('thread-b')
    await flushMicrotasks()

    // Sidebar reload drops thread-a; without keep-warm this would purge caches.
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    // Switch back to thread-a with preferCached; since caches survived, the
    // messages should be visible synchronously.
    const initialResumeCalls = gatewayMocks.resumeThread.mock.calls.length
    await state.selectThread('thread-a')
    expect(state.messages.value).toHaveLength(1)
    expect(state.messages.value[0]?.id).toBe('m-a')
    // The synchronous select does not itself await resume.
    await flushMicrotasks()
    expect(gatewayMocks.resumeThread.mock.calls.length).toBeGreaterThanOrEqual(initialResumeCalls)
  })
})

describe('thread cache preferCached', () => {
  function messagePayload(id: string, turnId = 'turn-1') {
    return {
      id,
      turnId,
      turnIndex: 0,
      role: 'assistant' as const,
      kind: 'agent-message' as const,
      contentBlocks: [{ type: 'text' as const, text: 'hi' }],
    }
  }

  it('returns instantly from cache and refreshes in the background when preferCached is set', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [messagePayload('m-1')],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: '',
      modelProvider: '',
      reasoningEffort: '',
      messages: [messagePayload('m-1')],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    await state.loadMessages('thread-a')
    expect(gatewayMocks.resumeThread).toHaveBeenCalledTimes(1)
    expect(state.messages.value).toHaveLength(1)

    // Simulate a stale resume state (e.g. provider switch) so a fresh call
    // would otherwise be issued for this thread.
    state.invalidateAppServerRuntimeState()

    // Point the next resume at a promise that never resolves; if
    // loadMessages awaited the network it would deadlock.
    let neverResolve: () => void = () => {}
    const pendingResume = new Promise((resolve) => {
      neverResolve = () => resolve({
        model: '',
        modelProvider: '',
        reasoningEffort: '',
        messages: [messagePayload('m-1')],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: { 'turn-1': 0 },
      })
    })
    gatewayMocks.resumeThread.mockReturnValueOnce(pendingResume)

    const callsBefore = gatewayMocks.resumeThread.mock.calls.length
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('loadMessages did not return promptly')), 200)
    })
    try {
      await Promise.race([
        state.loadMessages('thread-a', { preferCached: true }),
        timeoutPromise,
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
    // Silence unhandled rejection from the losing race entry.
    timeoutPromise.catch(() => {})
    // Cache stayed visible immediately.
    expect(state.messages.value).toHaveLength(1)
    // The background refresh call fired but has not yet completed.
    expect(gatewayMocks.resumeThread.mock.calls.length).toBe(callsBefore + 1)
    neverResolve()
  })
})

describe('goal slash commands', () => {
  const activeGoal = {
    threadId: 'thread-a',
    objective: 'Ship goal support',
    status: 'active' as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  }

  it('parses goal slash command variants', () => {
    expect(parseGoalSlashCommand('/goal')).toEqual({ kind: 'show' })
    expect(parseGoalSlashCommand('/goal clear')).toEqual({ kind: 'clear' })
    expect(parseGoalSlashCommand('/goal pause')).toEqual({ kind: 'status', status: 'paused' })
    expect(parseGoalSlashCommand('/goal unpause')).toEqual({ kind: 'status', status: 'active' })
    expect(parseGoalSlashCommand('/goal resume')).toEqual({ kind: 'status', status: 'active' })
    expect(parseGoalSlashCommand('/goal Ship goal support')).toEqual({ kind: 'set', objective: 'Ship goal support' })
    expect(parseGoalSlashCommand('/goals Ship goal support')).toBeNull()
  })

  it('routes selected-thread /goal objectives to goal RPCs instead of turn/start', async () => {
    installTestWindow()
    gatewayMocks.setThreadGoal.mockResolvedValue(activeGoal)

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.sendMessageToSelectedThread('/goal Ship goal support')

    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-a', {
      objective: 'Ship goal support',
      status: 'active',
    })
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.steerThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Goal active')
    expect(state.selectedLiveOverlay.value?.reasoningText).toContain('Ship goal support')
  })

  it('routes selected-thread /goal objectives with skills to goal RPCs instead of turn/start', async () => {
    installTestWindow()
    gatewayMocks.setThreadGoal.mockResolvedValue(activeGoal)

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.sendMessageToSelectedThread(
      '/goal $planning-with-files Ship goal support',
      [],
      [{ name: 'planning-with-files', path: '/skills/planning-with-files/SKILL.md' }],
    )

    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-a', {
      objective: '$planning-with-files Ship goal support',
      status: 'active',
    })
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.steerThreadTurn).not.toHaveBeenCalled()
  })

  it('routes selected-thread /goal objectives with file mentions to goal RPCs instead of turn/start', async () => {
    installTestWindow()
    gatewayMocks.setThreadGoal.mockResolvedValue(activeGoal)

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    const objective = '你在 ./.worktrees 里新建一个 worktree & branch 来实现 ./.superpowers/specs/2026-06-02-official-flydsl-swa-aiter-design.md 吧，可以用 $planning-with-files 来记录进展'

    await state.sendMessageToSelectedThread(
      `/goal ${objective}`,
      [],
      [{ name: 'planning-with-files', path: '/skills/planning-with-files/SKILL.md' }],
      'steer',
      [
        { label: '.worktrees', path: '.worktrees', fsPath: '/tmp/project/.worktrees' },
        {
          label: '2026-06-02-official-flydsl-swa-aiter-design.md',
          path: '.superpowers/specs/2026-06-02-official-flydsl-swa-aiter-design.md',
          fsPath: '/tmp/project/.superpowers/specs/2026-06-02-official-flydsl-swa-aiter-design.md',
        },
      ],
    )

    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-a', {
      objective,
      status: 'active',
    })
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.steerThreadTurn).not.toHaveBeenCalled()
  })

  it('supports selected-thread goal status, show, and clear commands', async () => {
    installTestWindow()
    gatewayMocks.getThreadGoal.mockResolvedValue(activeGoal)
    gatewayMocks.setThreadGoal.mockResolvedValue({ ...activeGoal, status: 'paused' })
    gatewayMocks.clearThreadGoal.mockResolvedValue(true)

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.sendMessageToSelectedThread('/goal')
    expect(gatewayMocks.getThreadGoal).toHaveBeenCalledWith('thread-a')
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Goal active')

    await state.sendMessageToSelectedThread('/goal pause')
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-a', { status: 'paused' })
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Goal paused')

    await state.sendMessageToSelectedThread('/goal clear')
    expect(gatewayMocks.clearThreadGoal).toHaveBeenCalledWith('thread-a')
    expect(state.selectedLiveOverlay.value).toBeNull()
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
  })

  it('creates a new thread for new-thread /goal objectives without sending a normal turn', async () => {
    installTestWindow()
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'thread-new',
      model: 'gpt-5.4',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    })
    gatewayMocks.setThreadGoal.mockResolvedValue({
      ...activeGoal,
      threadId: 'thread-new',
    })

    const state = useDesktopState()
    const threadId = await state.sendMessageToNewThread('/goal Ship goal support', '/tmp/project')

    expect(threadId).toBe('thread-new')
    expect(gatewayMocks.startThread).toHaveBeenCalledWith('/tmp/project', undefined, undefined)
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-new', {
      objective: 'Ship goal support',
      status: 'active',
    })
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.isSelectedThreadInterruptPending.value).toBe(false)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Goal active')
  })

  it('creates a new thread for new-thread /goal objectives with skills without sending a normal turn', async () => {
    installTestWindow()
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'thread-new',
      model: 'gpt-5.4',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    })
    gatewayMocks.setThreadGoal.mockResolvedValue({
      ...activeGoal,
      threadId: 'thread-new',
    })

    const state = useDesktopState()
    const threadId = await state.sendMessageToNewThread(
      '/goal $planning-with-files Ship goal support',
      '/tmp/project',
      [],
      [{ name: 'planning-with-files', path: '/skills/planning-with-files/SKILL.md' }],
    )

    expect(threadId).toBe('thread-new')
    expect(gatewayMocks.startThread).toHaveBeenCalledWith('/tmp/project', undefined, undefined)
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-new', {
      objective: '$planning-with-files Ship goal support',
      status: 'active',
    })
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.isSelectedThreadInterruptPending.value).toBe(false)
  })

  it('creates a new thread for new-thread /goal objectives with file mentions without sending a normal turn', async () => {
    installTestWindow()
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'thread-new',
      model: 'gpt-5.4',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    })
    gatewayMocks.setThreadGoal.mockResolvedValue({
      ...activeGoal,
      threadId: 'thread-new',
    })

    const state = useDesktopState()
    const objective = '你在 ./.worktrees 里新建一个 worktree & branch 来实现 ./.superpowers/specs/2026-06-02-official-flydsl-swa-aiter-design.md 吧，可以用 $planning-with-files 来记录进展'
    const threadId = await state.sendMessageToNewThread(
      `/goal ${objective}`,
      '/tmp/project',
      [],
      [{ name: 'planning-with-files', path: '/skills/planning-with-files/SKILL.md' }],
      [
        { label: '.worktrees', path: '.worktrees', fsPath: '/tmp/project/.worktrees' },
        {
          label: '2026-06-02-official-flydsl-swa-aiter-design.md',
          path: '.superpowers/specs/2026-06-02-official-flydsl-swa-aiter-design.md',
          fsPath: '/tmp/project/.superpowers/specs/2026-06-02-official-flydsl-swa-aiter-design.md',
        },
      ],
    )

    expect(threadId).toBe('thread-new')
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-new', {
      objective,
      status: 'active',
    })
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.isSelectedThreadInterruptPending.value).toBe(false)
  })
})

describe('provider model selection', () => {
  it('does not reuse the new-thread model for an existing thread without a session model', () => {
    expect(readSelectedModelForThreadContext({
      '__new-thread__': 'gpt-5.5',
    }, 'thread-a', 'codex')).toBe('')

    expect(readSelectedModelForThreadContext({
      '__new-thread__': 'gpt-5.5',
    }, '', 'codex')).toBe('gpt-5.5')
  })

  it('ignores global selected-model localStorage when OpenCode Zen is the active provider', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread__': 'gpt-5.5',
      }),
      'codex-web-local.selected-model-id.v1': 'gpt-5.5',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('').trim()).toBe('big-pickle')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::codex': 'big-pickle',
      '__new-thread-provider__::opencode-zen': 'big-pickle',
      '__new-thread__': 'big-pickle',
    })
    expect(window.localStorage.getItem('codex-web-local.selected-model-id.v1')).toBe(null)
  })

  it('restores a valid provider-scoped OpenCode Zen selected model from localStorage', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('ring-2.6-1t-free')
    expect(state.readModelIdForThread('').trim()).toBe('ring-2.6-1t-free')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::codex': 'ring-2.6-1t-free',
      '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
      '__new-thread__': 'ring-2.6-1t-free',
    })
  })

  it('uses the explicit new-session Moon Bridge provider when config still reports Codex', async () => {
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        '__new-thread-provider__': 'moon',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'codex',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ])
    gatewayMocks.getMoonBridgeModelMetadata.mockResolvedValue([
      { id: 'deepseek-v4-pro', contextWindow: 128000 },
      { id: 'deepseek-v4-flash', contextWindow: 64000 },
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
    })
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.availableModelIds.value).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ])
    expect(state.selectedModelId.value).toBe('deepseek-v4-pro')
    expect(state.readModelIdForThread('').trim()).toBe('deepseek-v4-pro')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::moon': 'deepseek-v4-pro',
    })
  })

  it('uses the explicit new-session Ark provider when config still reports Codex', async () => {
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        '__new-thread-provider__': 'ark',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'codex',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'doubao-seed-2-0-code-preview-260215',
      'deepseek-v4-pro-260425',
    ])
    gatewayMocks.getArkModelMetadata.mockResolvedValue([
      { id: 'doubao-seed-2-0-code-preview-260215', contextWindow: 262144 },
      { id: 'deepseek-v4-pro-260425', contextWindow: 1048576 },
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
    })
    expect(state.selectedProvider.value).toBe('ark')
    expect(state.availableModelIds.value).toEqual([
      'doubao-seed-2-0-code-preview-260215',
      'deepseek-v4-pro-260425',
    ])
    expect(state.selectedModelId.value).toBe('doubao-seed-2-0-code-preview-260215')
    expect(state.readModelIdForThread('').trim()).toBe('doubao-seed-2-0-code-preview-260215')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::ark': 'doubao-seed-2-0-code-preview-260215',
    })
  })

  it('updates an existing session model list after an explicit Moon Bridge provider change', async () => {
    const threadId = '019e6342-76cd-7e41-aece-413a748935ae'
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        [threadId]: 'moon',
      }),
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        [threadId]: 'gpt-5.5',
      }),
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'codex',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])
    gatewayMocks.getMoonBridgeModelMetadata.mockResolvedValue([
      { id: 'ark-code-latest', contextWindow: 256000 },
      { id: 'deepseek-v4-pro', contextWindow: 128000 },
    ])

    const state = useDesktopState()
    state.primeSelectedThread(threadId)

    await state.refreshAncillaryState({
      providerChanged: true,
      includeProviderModels: true,
      explicitProviderChange: true,
    })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
    })
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.availableModelIds.value).toEqual([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.readModelIdForThread(threadId)).toBe('ark-code-latest')
  })

  it('repairs an existing Moon Bridge session that still has a stale Codex model after reload', async () => {
    const threadId = '019e6342-76cd-7e41-aece-413a748935ae'
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        [threadId]: 'moon',
      }),
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        [threadId]: 'gpt-5.5',
      }),
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'codex',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])
    gatewayMocks.getMoonBridgeModelMetadata.mockResolvedValue([
      { id: 'ark-code-latest', contextWindow: 256000 },
      { id: 'deepseek-v4-pro', contextWindow: 128000 },
    ])

    const state = useDesktopState()
    state.primeSelectedThread(threadId)

    await state.refreshAncillaryState({
      providerChanged: false,
      includeProviderModels: false,
    })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
    })
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.availableModelIds.value).toEqual([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.readModelIdForThread(threadId)).toBe('ark-code-latest')
  })

  it('refreshes Moon Bridge models even when config/read does not return', async () => {
    vi.useFakeTimers()
    const threadId = '019e6342-76cd-7e41-aece-413a748935ae'
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        [threadId]: 'moon',
      }),
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        [threadId]: 'gpt-5.5',
      }),
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockReturnValue(new Promise(() => {}))
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])
    gatewayMocks.getMoonBridgeModelMetadata.mockResolvedValue([
      { id: 'ark-code-latest', contextWindow: 256000 },
      { id: 'deepseek-v4-pro', contextWindow: 128000 },
    ])

    const state = useDesktopState()
    state.primeSelectedThread(threadId)
    const refreshPromise = state.refreshAncillaryState({
      providerChanged: true,
      includeProviderModels: true,
      explicitProviderChange: true,
    })

    await vi.advanceTimersByTimeAsync(2100)
    await refreshPromise

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
    })
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.availableModelIds.value).toEqual([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.readModelIdForThread(threadId)).toBe('ark-code-latest')
  })

  it('keeps Codex model picks scoped to Codex even when the model also exists in Moon Bridge', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-4.1',
      providerId: 'codex',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-4.1',
      'gpt-5.5',
    ])
    gatewayMocks.getMoonBridgeModelIds.mockResolvedValue(['gpt-5.5'])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedProvider.value).toBe('codex')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-4.1')

    state.setSelectedModelIdForThread('__new-thread__', 'gpt-5.5')

    expect(state.selectedProvider.value).toBe('codex')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.provider-by-context.v1') ?? '{}')).toEqual({})
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread__': 'gpt-5.5',
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('keeps an explicit Moon Bridge provider when its model catalog is incomplete', async () => {
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        'thread-a': 'moon',
        '__new-thread-provider__': 'moon',
      }),
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        'thread-a': 'ark-code-latest',
        '__new-thread-provider__::moon': 'ark-code-latest',
      }),
    })
    gatewayMocks.getMoonBridgeModelIds.mockResolvedValue([])

    const state = useDesktopState()

    state.primeSelectedThread('thread-a')
    state.setSelectedModelIdForThread('thread-a', 'ark-code-latest')

    expect(state.selectedProvider.value).toBe('moon')
    expect(state.readModelIdForThread('thread-a')).toBe('ark-code-latest')

    state.primeSelectedThread('')
    state.setSelectedModelIdForThread('__new-thread__', 'ark-code-latest')

    expect(state.selectedProvider.value).toBe('moon')
    expect(state.readModelIdForThread('')).toBe('ark-code-latest')
  })

  it('keeps a Moon Bridge new-thread model when provider refresh only reports global config', async () => {
    installTestWindow({
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        '__new-thread-provider__': 'moon',
      }),
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::moon': 'ark-code-latest',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'moon',
      reasoningEffort: 'none',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

    const state = useDesktopState()
    state.primeSelectedThread('')

    await state.refreshAncillaryState({ providerChanged: true, includeProviderModels: true })

    expect(state.selectedProvider.value).toBe('moon')
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.readModelIdForThread('')).toBe('ark-code-latest')
    expect(state.availableModelIds.value).toContain('ark-code-latest')
  })
})

describe('session composer model state', () => {
  it('keeps reasoning effort scoped to the composer thread context', () => {
    installTestWindow()

    const state = useDesktopState()

    state.setSelectedReasoningEffortForThread('__new-thread__', 'high')
    expect(state.readReasoningEffortForThread('__new-thread__')).toBe('high')
    expect(state.selectedReasoningEffort.value).toBe('high')

    state.primeSelectedThread('thread-a')
    expect(state.readReasoningEffortForThread('thread-a')).toBe('')
    expect(state.selectedReasoningEffort.value).toBe('')

    state.setSelectedReasoningEffortForThread('thread-a', 'none')
    expect(state.readReasoningEffortForThread('thread-a')).toBe('none')
    expect(state.selectedReasoningEffort.value).toBe('none')

    state.primeSelectedThread('')
    expect(state.readReasoningEffortForThread('__new-thread__')).toBe('high')
    expect(state.selectedReasoningEffort.value).toBe('high')
  })

  it('persists max reasoning effort for the composer thread context', () => {
    installTestWindow()

    const state = useDesktopState()
    state.setSelectedReasoningEffortForThread('__new-thread__', 'max')

    expect(state.readReasoningEffortForThread('__new-thread__')).toBe('max')
    expect(state.selectedReasoningEffort.value).toBe('max')
  })

  it('preserves direct thread selection and reasoning effort when the thread is not listed', async () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-a',
      'codex-web-local.reasoning-effort-by-context.v1': JSON.stringify({
        'thread-a': 'xhigh',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-b', '/tmp/project')] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    expect(state.selectedThreadId.value).toBe('thread-a')
    expect(state.selectedThread.value).toBeNull()
    expect(state.readReasoningEffortForThread('thread-a')).toBe('xhigh')
    expect(state.selectedReasoningEffort.value).toBe('xhigh')
  })

  it('hydrates model, provider, and reasoning effort from resumed thread metadata', async () => {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'ark-code-latest',
      modelProvider: 'moon',
      reasoningEffort: 'high',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.loadMessages('thread-a')

    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-a')
    expect(state.readModelIdForThread('thread-a')).toBe('ark-code-latest')
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.readReasoningEffortForThread('thread-a')).toBe('high')
    expect(state.selectedReasoningEffort.value).toBe('high')
  })

  it('restores persisted provider state instead of replaying stale Ark browser cache on navigation', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        'thread-a': 'ark-code-latest',
      }),
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        'thread-a': 'ark',
      }),
      'codex-web-local.reasoning-effort-by-context.v1': JSON.stringify({
        'thread-a': 'xhigh',
      }),
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.6-terra',
      modelProvider: 'rustcat',
      reasoningEffort: 'xhigh',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.loadMessages('thread-a')

    // Navigation must let resumeThread recover the rollout state instead of
    // sending the stale local Ark selection back to the server.
    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-a')
    expect(state.readModelIdForThread('thread-a')).toBe('gpt-5.6-terra')
    expect(state.selectedProvider.value).toBe('rustcat')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.provider-by-context.v1') ?? '{}')).toEqual({
      'thread-a': 'rustcat',
    })
  })

  it('does not let provider refresh overwrite an existing valid provider model or reasoning effort', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        'thread-a': 'ark-code-latest',
      }),
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        'thread-a': 'moon',
      }),
      'codex-web-local.reasoning-effort-by-context.v1': JSON.stringify({
        'thread-a': 'high',
      }),
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'moon',
      reasoningEffort: 'none',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'ark-code-latest',
      'deepseek-v4-pro',
    ])

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')

    await state.refreshAncillaryState({ providerChanged: true, includeProviderModels: true })

    expect(state.readModelIdForThread('thread-a')).toBe('ark-code-latest')
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.readReasoningEffortForThread('thread-a')).toBe('high')
    expect(state.selectedReasoningEffort.value).toBe('high')
    expect(state.availableModelIds.value).toContain('ark-code-latest')
  })

  it('keeps an explicit Codex switch on an existing Moon Bridge session when sending', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        'thread-a': 'ark-code-latest',
      }),
      'codex-web-local.provider-by-context.v1': JSON.stringify({
        'thread-a': 'moon',
      }),
      'codex-web-local.reasoning-effort-by-context.v1': JSON.stringify({
        'thread-a': 'xhigh',
      }),
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'rustcat',
      reasoningEffort: 'xhigh',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    gatewayMocks.resumeThread
      .mockResolvedValueOnce({
        model: 'ark-code-latest',
        modelProvider: 'moon',
        reasoningEffort: 'xhigh',
        messages: [],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
      .mockResolvedValueOnce({
        model: 'gpt-5.5',
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
        messages: [],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
      .mockResolvedValueOnce({
        model: 'gpt-5.5',
        modelProvider: 'rustcat',
        reasoningEffort: 'xhigh',
        messages: [],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.loadMessages('thread-a')

    state.setSelectedProvider('codex')
    state.setSelectedModelIdForThread('thread-a', 'gpt-5.5')
    await state.refreshAncillaryState({ providerChanged: true, includeProviderModels: true })
    await state.sendMessageToSelectedThread('use codex now')

    expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(1, 'thread-a')
    expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(2, 'thread-a', 'gpt-5.5', 'rustcat')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'use codex now',
      [],
      'gpt-5.5',
      'xhigh',
      undefined,
      [],
      'default',
      'rustcat',
    )
    expect(state.selectedProvider.value).toBe('codex')
    expect(state.readModelIdForThread('thread-a')).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.provider-by-context.v1') ?? '{}')).toEqual({
      'thread-a': 'codex',
    })

    await state.loadMessages('thread-a', { force: true })

    expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(3, 'thread-a')
    expect(state.selectedProvider.value).toBe('rustcat')
    expect(state.readModelIdForThread('thread-a')).toBe('gpt-5.5')
  })

  it('passes an explicit Cursor provider override when sending on an existing session', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        'thread-a': 'gpt-5.5',
      }),
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'cursor',
      reasoningEffort: 'xhigh',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.setSelectedProvider('cursor')
    state.setSelectedModelIdForThread('thread-a', 'gpt-5.5')
    await state.sendMessageToSelectedThread('use cursor now')

    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-a', 'gpt-5.5', 'cursor')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'use cursor now',
      [],
      'gpt-5.5',
      undefined,
      undefined,
      [],
      'default',
      'cursor',
    )
    expect(state.selectedProvider.value).toBe('cursor')
  })

  it('re-resumes an already loaded session after provider switches before sending', async () => {
    const scenarios = [
      {
        initialProvider: 'codex',
        initialModel: 'gpt-5.5',
        initialRpcProvider: 'rustcat',
        targetProvider: 'cursor',
        targetModel: 'gpt-5.5-medium',
        targetRpcProvider: 'cursor',
      },
      {
        initialProvider: 'moon',
        initialModel: 'ark-code-latest',
        initialRpcProvider: 'moon',
        targetProvider: 'cursor',
        targetModel: 'gpt-5.5-medium',
        targetRpcProvider: 'cursor',
      },
      {
        initialProvider: 'cursor',
        initialModel: 'gpt-5.5-medium',
        initialRpcProvider: 'cursor',
        targetProvider: 'moon',
        targetModel: 'ark-code-latest',
        targetRpcProvider: 'moon',
      },
      {
        initialProvider: 'cursor',
        initialModel: 'gpt-5.5-medium',
        initialRpcProvider: 'cursor',
        targetProvider: 'codex',
        targetModel: 'gpt-5.5',
        targetRpcProvider: 'rustcat',
      },
    ] as const

    for (const scenario of scenarios) {
      vi.clearAllMocks()
      installTestWindow({
        'codex-web-local.selected-model-by-context.v1': JSON.stringify({
          'thread-a': scenario.initialModel,
        }),
        'codex-web-local.provider-by-context.v1': JSON.stringify({
          'thread-a': scenario.initialProvider,
        }),
        'codex-web-local.reasoning-effort-by-context.v1': JSON.stringify({
          'thread-a': 'xhigh',
        }),
      })
      gatewayMocks.getThreadQueueState.mockResolvedValue({})
      gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
      gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
      gatewayMocks.getArkModelIds.mockResolvedValue([])
      gatewayMocks.getArkModelMetadata.mockResolvedValue([])
      gatewayMocks.getMoonBridgeModelIds.mockResolvedValue([])
      gatewayMocks.getMoonBridgeModelMetadata.mockResolvedValue([])
      gatewayMocks.getThreadDetail.mockResolvedValue({
        messages: [],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
      gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
      gatewayMocks.getSkillsList.mockResolvedValue([])
      gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
      gatewayMocks.getCurrentModelConfig.mockResolvedValue({
        model: 'gpt-5.5',
        providerId: 'rustcat',
        reasoningEffort: 'xhigh',
        speedMode: 'standard',
      })
      gatewayMocks.getAvailableModelIds.mockResolvedValue([
        'gpt-5.5',
        'gpt-5.5-medium',
        'ark-code-latest',
      ])
      gatewayMocks.resumeThread.mockImplementation(async (_threadId: unknown, model: unknown, provider: unknown) => ({
        model: String(model ?? scenario.initialModel),
        modelProvider: String(provider ?? scenario.initialRpcProvider),
        reasoningEffort: 'xhigh',
        messages: [],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      }))
      gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')

      const state = useDesktopState()
      state.primeSelectedThread('thread-a')
      await state.refreshAncillaryState({ providerChanged: true, includeProviderModels: true })
      await state.loadMessages('thread-a')

      state.setSelectedProvider(scenario.targetProvider)
      state.setSelectedModelIdForThread('thread-a', scenario.targetModel)
      if (scenario.targetProvider === 'codex') {
        await state.refreshAncillaryState({ providerChanged: true, includeProviderModels: true })
      }
      await state.sendMessageToSelectedThread(`use ${scenario.targetProvider} now`)

      expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(1, 'thread-a')
      expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(
        2,
        'thread-a',
        scenario.targetModel,
        scenario.targetRpcProvider,
      )
      expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
        'thread-a',
        `use ${scenario.targetProvider} now`,
        [],
        scenario.targetModel,
        'xhigh',
        undefined,
        [],
        'default',
        scenario.targetRpcProvider,
      )
    }
  })
})

describe('queued messages', () => {
  function queuedMessage(text: string) {
    return {
      id: 'q-1',
      text,
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'gpt-5.5-extra-high',
      modelProvider: 'rustcat',
      reasoningEffort: 'xhigh' as const,
    }
  }

  it('refreshes persisted queue state when switching back to a thread', async () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-a',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'project',
        threads: [
          thread('thread-a', '/tmp/project'),
          thread('thread-b', '/tmp/project'),
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.getThreadQueueState
      .mockResolvedValueOnce({ 'thread-a': [queuedMessage('queued while running')] })
      .mockResolvedValueOnce({ 'thread-a': [queuedMessage('queued while running')] })
      .mockResolvedValueOnce({})

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(1)

    await state.selectThread('thread-b')
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(0)

    await state.selectThread('thread-a')
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(0)
  })
})

describe('active turn state reconciliation', () => {
  async function flushAsyncTasks(times = 6): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await Promise.resolve()
    }
  }

  async function waitForAsyncCondition(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 30; index += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('Timed out waiting for async state reconciliation')
  }

  function activeTurnDetail(activeTurnId: string, inProgress = true) {
    return {
      messages: [],
      inProgress,
      activeTurnId,
      hasMoreOlder: false,
      turnIndexByTurnId: activeTurnId ? { [activeTurnId]: 0 } : {},
    }
  }

  function staleThreadDetail() {
    return {
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    }
  }

  function persistedUserTurnDetail(turnId: string) {
    return {
      messages: [{
        id: 'user-1',
        role: 'user' as const,
        text: 'start a slow task',
        messageType: 'userMessage',
        turnId,
        turnIndex: 0,
      }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: { [turnId]: 0 },
    }
  }

  function persistedCommandTurnDetail(turnId: string) {
    return {
      messages: [{
        id: 'command-1',
        role: 'assistant' as const,
        text: 'pnpm test',
        messageType: 'commandExecution',
        turnId,
        turnIndex: 0,
        itemIndex: 1,
      }],
      inProgress: false,
      activeTurnId: '',
      terminalTurnIds: [],
      hasMoreOlder: false,
      turnIndexByTurnId: { [turnId]: 0 },
    }
  }

  async function createThreadHarness() {
    installTestWindow()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: '',
      modelProvider: '',
      reasoningEffort: '',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })
    expect(state.selectedThreadId.value).toBe('thread-a')
    return state
  }

  it('keeps a session marked running by thread/list active while switching to it', async () => {
    installTestWindow()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'project',
        threads: [
          thread('thread-a', '/tmp/project'),
          { ...thread('thread-b', '/tmp/project'), inProgress: true, activeTurnId: 'turn-b' },
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockImplementation(
      () => new Promise(() => {}),
    )

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    expect(state.projectGroups.value[0]?.threads.find((item) => item.id === 'thread-b')?.inProgress).toBe(true)

    void state.selectThread('thread-b')

    expect(state.selectedThreadInProgress.value).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('clears a list-reported active turn when detail marks that same turn terminal', async () => {
    installTestWindow()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'project',
        threads: [
          thread('thread-a', '/tmp/project'),
          { ...thread('thread-b', '/tmp/project'), inProgress: true, activeTurnId: 'turn-b' },
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: '',
      modelProvider: '',
      reasoningEffort: '',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      terminalTurnIds: ['turn-b'],
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-b': 0 },
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })
    expect(state.projectGroups.value[0]?.threads.find((item) => item.id === 'thread-b')?.inProgress).toBe(true)

    await state.loadMessages('thread-b', { force: true, silent: true })

    expect(state.projectGroups.value[0]?.threads.find((item) => item.id === 'thread-b')?.inProgress).toBe(false)
  })

  it('restores running UI state when the send recheck finds an active turn', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadSummary.mockResolvedValue({
      ...thread('thread-a', '/tmp/project'),
      inProgress: true,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue(activeTurnDetail('turn-active'))
    gatewayMocks.steerThreadTurn.mockResolvedValue('turn-active')

    await state.sendMessageToSelectedThread('steer the current work')
    await waitForAsyncCondition(() =>
      gatewayMocks.steerThreadTurn.mock.calls.length > 0 &&
      gatewayMocks.resumeThread.mock.calls.length >= 2,
    )
    await flushAsyncTasks()

    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    expect(gatewayMocks.steerThreadTurn).toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
  })

  it('uses the provider recovered by resume when steering a thread with an empty UI cache', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadSummary.mockResolvedValue({
      ...thread('thread-a', '/tmp/project'),
      inProgress: true,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue(activeTurnDetail('turn-active'))
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.6-sol-xhigh',
      modelProvider: 'cursor',
      reasoningEffort: 'xhigh',
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-active',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-active': 0 },
    })
    gatewayMocks.steerThreadTurn.mockResolvedValue('turn-active')

    await state.sendMessageToSelectedThread('continue on the existing runtime')
    await waitForAsyncCondition(() => gatewayMocks.steerThreadTurn.mock.calls.length > 0)

    expect(gatewayMocks.steerThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'turn-active',
      'continue on the existing runtime',
      [],
      undefined,
      [],
      'cursor',
    )
  })

  it('starts a new turn when stale running state steers into an idle backend', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadSummary.mockResolvedValue({
      ...thread('thread-a', '/tmp/project'),
      inProgress: true,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue(activeTurnDetail('turn-stale'))
    gatewayMocks.steerThreadTurn.mockRejectedValueOnce(new Error('RPC turn/steer failed with HTTP 502: no active turn to steer'))
    gatewayMocks.startThreadTurn.mockResolvedValueOnce('turn-new')

    await state.sendMessageToSelectedThread('continue after stale active state')
    await waitForAsyncCondition(() => gatewayMocks.startThreadTurn.mock.calls.length > 0)
    await flushAsyncTasks()

    expect(gatewayMocks.steerThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.steerThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'turn-stale',
      'continue after stale active state',
      [],
      undefined,
      [],
      undefined,
    )
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'continue after stale active state',
      [],
      undefined,
      undefined,
      undefined,
      [],
      'default',
      undefined,
    )
    expect(state.error.value).toBe('')
    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('keeps a just-started turn running when the first thread read has not caught up', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(staleThreadDetail())
      .mockResolvedValueOnce(staleThreadDetail())
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')

    await state.sendMessageToSelectedThread('start a slow task')

    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'start a slow task',
      [],
      undefined,
      undefined,
      undefined,
      [],
      'default',
      undefined,
    )
    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('starts an idle paginated thread without reading its complete turn history', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadSummary.mockResolvedValue({
      ...thread('thread-a', '/tmp/project'),
      inProgress: false,
    })
    gatewayMocks.getThreadDetail.mockRejectedValue(
      new Error('paginated threads do not support thread/read(includeTurns=true)'),
    )
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')

    await state.sendMessageToSelectedThread('continue the paginated thread')

    expect(gatewayMocks.getThreadSummary).toHaveBeenCalledWith('thread-a')
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'continue the paginated thread',
      [],
      undefined,
      undefined,
      undefined,
      [],
      'default',
      undefined,
    )
  })

  it('keeps a just-started turn running when thread read only contains the user turn', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(staleThreadDetail())
      .mockResolvedValueOnce(persistedUserTurnDetail('turn-new'))
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')

    await state.sendMessageToSelectedThread('start a slow task')

    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('keeps a turn running when a refresh has persisted its completed command', async () => {
    const state = await createThreadHarness()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(staleThreadDetail())
      .mockResolvedValueOnce(persistedCommandTurnDetail('turn-new'))
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')

    await state.sendMessageToSelectedThread('start a task with several commands')

    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('can start a turn for an explicit thread even when another thread is selected', async () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-b',
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'project',
        threads: [
          thread('thread-b', '/tmp/project'),
          thread('thread-a', '/tmp/project'),
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: '',
      modelProvider: '',
      reasoningEffort: '',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(staleThreadDetail())
      .mockResolvedValueOnce(staleThreadDetail())
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })
    expect(state.selectedThreadId.value).toBe('thread-b')

    await state.sendMessageToThread('thread-a', 'start the route thread')

    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'start the route thread',
      [],
      undefined,
      undefined,
      undefined,
      [],
      'default',
      undefined,
    )
    expect(state.selectedThreadId.value).toBe('thread-b')
    expect(state.projectGroups.value[0]?.threads.find((item) => item.id === 'thread-a')?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads.find((item) => item.id === 'thread-b')?.inProgress).toBe(false)
  })
})

describe('turn interruption', () => {
  function notification(method: string, params: unknown): RpcNotification {
    return {
      method,
      params,
      atIso: '2026-05-23T00:00:00.000Z',
    }
  }

  function threadDetail(activeTurnId: string, inProgress = true) {
    return {
      messages: [],
      inProgress,
      activeTurnId,
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    }
  }

  function createInterruptHarness(): {
    state: ReturnType<typeof useDesktopState>
  } {
    installTestWindow()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    const notificationHandlers: Array<(notification: RpcNotification) => void> = []
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler: (notification: RpcNotification) => void) => {
      notificationHandlers.push(handler)
      return vi.fn()
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    const emitNotification = notificationHandlers[0]
    if (!emitNotification) {
      throw new Error('Notification subscription was not installed')
    }

    emitNotification(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-stale', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))

    return { state }
  }

  it('refreshes the active turn id before interrupting', async () => {
    const { state } = createInterruptHarness()
    gatewayMocks.interruptThreadTurn.mockResolvedValueOnce(undefined)

    await state.interruptSelectedThreadTurn()
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)
    await flushMicrotasks()

    // Cached activeTurnId from the notification is used directly, so
    // getThreadDetail is not required on the fast path anymore.
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-stale')
    expect(state.selectedThreadInProgress.value).toBe(false)
  })

  it('retries interrupt once when the active turn changes during stop', async () => {
    const { state } = createInterruptHarness()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(threadDetail('turn-current'))
    gatewayMocks.interruptThreadTurn
      .mockRejectedValueOnce(new Error('RPC turn/interrupt failed with HTTP 502: expected active turn id turn-current but found turn-stale'))
      .mockResolvedValueOnce(undefined)

    await state.interruptSelectedThreadTurn()
    await waitForCalls(gatewayMocks.interruptThreadTurn, 2)
    await flushMicrotasks()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenNthCalledWith(1, 'thread-a', 'turn-stale')
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenNthCalledWith(2, 'thread-a', 'turn-current')
    expect(state.error.value).toBe('')
  })

  it('treats no active turn during stop as already settled', async () => {
    const { state } = createInterruptHarness()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(threadDetail('', false))
    gatewayMocks.interruptThreadTurn
      .mockRejectedValueOnce(new Error('RPC turn/interrupt failed with HTTP 502: no active turn to interrupt'))

    expect(state.selectedThreadInProgress.value).toBe(true)

    await state.interruptSelectedThreadTurn()
    // inProgress stays true until the RPC confirms there is no active turn.
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)
    await flushMicrotasks()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-stale')
    expect(state.selectedThreadInProgress.value).toBe(false)
    expect(state.error.value).toBe('')
    expect(state.isInterruptingTurn.value).toBe(false)
  })

  it('keeps showing running with a spinner until the interrupt RPC confirms', async () => {
    const { state } = createInterruptHarness()
    let releaseInterrupt: () => void = () => undefined
    gatewayMocks.interruptThreadTurn.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseInterrupt = resolve
      }),
    )

    expect(state.selectedThreadInProgress.value).toBe(true)

    const interruptCall = state.interruptSelectedThreadTurn()

    // While the interrupt is in flight the UI truthfully keeps showing
    // "running" and the stop button shows its spinner.
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)
    expect(state.selectedThreadInProgress.value).toBe(true)
    expect(state.isInterruptingTurn.value).toBe(true)

    releaseInterrupt()
    await interruptCall
    await flushMicrotasks()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-stale')
    expect(state.selectedThreadInProgress.value).toBe(false)
    expect(state.isInterruptingTurn.value).toBe(false)
  })

  it('pauses an active goal before interrupting so codex cannot auto-continue', async () => {
    const { state } = createInterruptHarness()
    const activeGoal = {
      threadId: 'thread-a',
      objective: 'Ship goal support',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    gatewayMocks.getThreadGoal.mockResolvedValueOnce(activeGoal)
    gatewayMocks.setThreadGoal.mockResolvedValueOnce({ ...activeGoal, status: 'paused' })
    gatewayMocks.interruptThreadTurn.mockResolvedValueOnce(undefined)

    await state.interruptSelectedThreadTurn()
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadGoal).toHaveBeenCalledWith('thread-a')
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('thread-a', { status: 'paused' })
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-stale')
  })

  it('skips goal pause when no active goal is set', async () => {
    const { state } = createInterruptHarness()
    gatewayMocks.getThreadGoal.mockResolvedValueOnce(null)
    gatewayMocks.interruptThreadTurn.mockResolvedValueOnce(undefined)

    await state.interruptSelectedThreadTurn()
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)
    await flushMicrotasks()

    expect(gatewayMocks.setThreadGoal).not.toHaveBeenCalled()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-stale')
  })
})

describe('live turn rendering', () => {
  async function createLiveStateHarness(): Promise<{
    state: ReturnType<typeof useDesktopState>
    notify: (notification: RpcNotification) => void
  }> {
    installTestWindow()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    let notify: ((notification: RpcNotification) => void) | null = null
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler: (notification: RpcNotification) => void) => {
      notify = handler
      return vi.fn()
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })
    state.startPolling()

    if (!notify) {
      throw new Error('Notification subscription was not installed')
    }

    return { state, notify }
  }

  function notification(method: string, params: unknown): RpcNotification {
    return {
      method,
      params,
      atIso: '2026-05-23T00:00:00.000Z',
    }
  }

  it('settles a live command when its turn completes without an item completion event', async () => {
    const { state, notify } = await createLiveStateHarness()

    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-1', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))
    notify(notification('item/started', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test', cwd: '/tmp/project' },
    }))
    notify(notification('item/commandExecution/outputDelta', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      delta: 'running\n',
    }))

    expect(state.messages.value).toHaveLength(1)
    expect(state.messages.value[0].messageType).toBe('commandExecution')
    expect(state.messages.value[0].commandExecution?.aggregatedOutput).toBe('running\n')

    notify(notification('turn/completed', {
      threadId: 'thread-a',
      turn: { id: 'turn-1', threadId: 'thread-a', status: 'completed', completedAt: '2026-05-23T00:00:01.000Z' },
    }))

    const commandMessages = state.messages.value.filter((message) => message.messageType === 'commandExecution')
    expect(commandMessages).toHaveLength(1)
    expect(commandMessages[0].commandExecution?.aggregatedOutput).toBe('running\n')
    expect(commandMessages[0].commandExecution?.status).toBe('completed')
  })

  it('clears a cached active turn when a detail refresh explicitly marks that turn terminal', async () => {
    const { state, notify } = await createLiveStateHarness()
    gatewayMocks.resumeThread.mockResolvedValue({
      model: '',
      modelProvider: '',
      reasoningEffort: '',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      terminalTurnIds: ['turn-1'],
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })

    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-1', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))
    expect(state.selectedThreadInProgress.value).toBe(true)

    await state.loadMessages('thread-a', { force: true, silent: true })

    expect(state.selectedThreadInProgress.value).toBe(false)
  })

  it('preserves live text and command event order within one turn', async () => {
    const { state, notify } = await createLiveStateHarness()

    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-1', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))
    notify(notification('item/agentMessage/delta', {
      threadId: 'thread-a', turnId: 'turn-1', itemId: 'text-0', delta: 'T0',
    }))
    notify(notification('item/started', {
      threadId: 'thread-a', turnId: 'turn-1',
      item: { id: 'command-0', type: 'commandExecution', command: 'C0', cwd: '/tmp/project' },
    }))
    notify(notification('item/agentMessage/delta', {
      threadId: 'thread-a', turnId: 'turn-1', itemId: 'text-1', delta: 'T1',
    }))
    notify(notification('item/started', {
      threadId: 'thread-a', turnId: 'turn-1',
      item: { id: 'command-10', type: 'commandExecution', command: 'C10', cwd: '/tmp/project' },
    }))
    notify(notification('item/started', {
      threadId: 'thread-a', turnId: 'turn-1',
      item: { id: 'command-11', type: 'commandExecution', command: 'C11', cwd: '/tmp/project' },
    }))
    notify(notification('item/agentMessage/delta', {
      threadId: 'thread-a', turnId: 'turn-1', itemId: 'text-2', delta: 'T2',
    }))
    notify(notification('item/started', {
      threadId: 'thread-a', turnId: 'turn-1',
      item: { id: 'command-2', type: 'commandExecution', command: 'C2', cwd: '/tmp/project' },
    }))

    expect(state.messages.value.map((message) => message.id)).toEqual([
      'text-0', 'command-0', 'text-1', 'command-10', 'command-11', 'text-2', 'command-2',
    ])
  })

  it('reorders an incremental persisted snapshot by item position without a page refresh', async () => {
    installTestWindow()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })) as never)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'project', threads: [thread('thread-a', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.resumeThread.mockResolvedValue(null)
    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.refreshAll({ includeSelectedThreadMessages: false, refreshAncillary: false })

    gatewayMocks.getThreadDetail.mockResolvedValueOnce({
      messages: [
        {
          id: 'agent-1',
          role: 'assistant',
          text: 'I found the project.',
          messageType: 'agentMessage',
          turnId: 'turn-1',
          turnIndex: 0,
          itemIndex: 2,
        },
      ],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })
    await state.loadMessages('thread-a')
    expect(state.selectedThreadId.value).toBe('thread-a')
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(state.messages.value.map((message) => message.id)).toEqual(['agent-1'])

    gatewayMocks.getThreadDetail.mockResolvedValueOnce({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Inspect the project.',
          messageType: 'userMessage',
          turnId: 'turn-1',
          turnIndex: 0,
          itemIndex: 0,
        },
        {
          id: 'tool-1',
          role: 'system',
          text: 'filesystem.read_file',
          messageType: 'toolCall',
          turnId: 'turn-1',
          turnIndex: 0,
          itemIndex: 1,
        },
        {
          id: 'agent-1',
          role: 'assistant',
          text: 'I found the project.',
          messageType: 'agentMessage',
          turnId: 'turn-1',
          turnIndex: 0,
          itemIndex: 2,
        },
      ],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: { 'turn-1': 0 },
    })
    await state.loadMessages('thread-a', { force: true, silent: true })

    expect(state.messages.value.map((message) => message.id)).toEqual([
      'user-1', 'tool-1', 'agent-1',
    ])
  })

  it('keeps accumulated live reasoning when assistant text starts streaming', async () => {
    const { state, notify } = await createLiveStateHarness()

    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-1', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))
    notify(notification('item/started', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      item: { id: 'reason-1', type: 'reasoning' },
    }))
    notify(notification('item/reasoning/textDelta', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'reason-1',
      delta: 'checking context',
    }))

    expect(state.selectedLiveOverlay.value?.reasoningText).toBe('checking context')

    notify(notification('item/agentMessage/delta', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'agent-1',
      delta: 'I found the issue.',
    }))

    expect(state.selectedLiveOverlay.value?.reasoningText).toBe('checking context')
    expect(state.messages.value.map((message) => message.text)).toEqual(['I found the issue.'])
  })

  it('marks a thread running from live agent output even without a turn-start event', async () => {
    const { state, notify } = await createLiveStateHarness()
    gatewayMocks.interruptThreadTurn.mockResolvedValueOnce(undefined)

    notify(notification('item/agentMessage/delta', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'agent-1',
      delta: 'Still working.',
    }))

    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Writing response')

    await state.interruptSelectedThreadTurn()
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-1')
  })

  it('marks a thread running from status-change notifications without a turn-start event', async () => {
    const { state, notify } = await createLiveStateHarness()
    gatewayMocks.interruptThreadTurn.mockResolvedValueOnce(undefined)

    notify(notification('thread/status/changed', {
      threadId: 'thread-a',
      status: { type: 'running', turnId: 'turn-1' },
    }))

    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')

    await state.interruptSelectedThreadTurn()
    await waitForCalls(gatewayMocks.interruptThreadTurn, 1)
    await flushMicrotasks()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-1')
    expect(state.selectedThread.value?.inProgress).toBe(false)
  })

  it('clears running state from terminal status-change notifications', async () => {
    const { state, notify } = await createLiveStateHarness()

    notify(notification('thread/status/changed', {
      status: { type: 'running', threadId: 'thread-a', turnId: 'turn-1' },
    }))
    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')

    notify(notification('thread/status/changed', {
      status: { type: 'interrupted', threadId: 'thread-a', turnId: 'turn-1' },
    }))

    expect(state.selectedThread.value?.inProgress).toBe(false)
    expect(state.selectedLiveOverlay.value).toBeNull()
  })

  it('ignores stale terminal notifications after a newer turn has started', async () => {
    const { state, notify } = await createLiveStateHarness()

    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-stale', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))
    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-current', threadId: 'thread-a', startedAt: '2026-05-23T00:00:01.000Z' },
    }))
    notify(notification('item/started', {
      threadId: 'thread-a',
      turnId: 'turn-current',
      item: { id: 'cmd-current', type: 'commandExecution', command: 'pnpm test', cwd: '/tmp/project' },
    }))

    notify(notification('thread/status/changed', {
      threadId: 'thread-a',
      status: { type: 'idle', turnId: 'turn-stale' },
    }))
    notify(notification('turn/completed', {
      threadId: 'thread-a',
      turn: { id: 'turn-stale', threadId: 'thread-a', status: 'completed' },
    }))
    notify(notification('error', {
      threadId: 'thread-a',
      turnId: 'turn-stale',
      willRetry: false,
      error: { message: 'stale turn failed' },
    }))

    expect(state.selectedThreadInProgress.value).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Running command')
    expect(state.messages.value.find((message) => message.id === 'cmd-current')?.commandExecution?.status).toBe('inProgress')
  })

  it('clears running state when codex gives up retrying (error willRetry=false)', async () => {
    const { state, notify } = await createLiveStateHarness()

    notify(notification('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-1', threadId: 'thread-a', startedAt: '2026-05-23T00:00:00.000Z' },
    }))
    expect(state.selectedThreadInProgress.value).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')

    // A retryable error must NOT clear the running state.
    notify(notification('error', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'Reconnecting... 1/5' },
    }))
    expect(state.selectedThreadInProgress.value).toBe(true)

    notify(notification('thread/status/changed', {
      threadId: 'thread-a',
      status: { type: 'idle', turnId: 'turn-1' },
    }))
    expect(state.selectedThreadInProgress.value).toBe(false)

    notify(notification('error', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'Reconnecting... 2/5' },
    }))
    expect(state.selectedThreadInProgress.value).toBe(true)

    // A terminal error (willRetry=false) without a turn/completed must clear it.
    notify(notification('error', {
      threadId: 'thread-a',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'agent process exited with status exit status: 1' },
    }))

    expect(state.selectedThreadInProgress.value).toBe(false)
  })

  it('exposes selected running state even before the thread is listed', () => {
    installTestWindow()
    const notificationHandlers: Array<(notification: RpcNotification) => void> = []
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler: (notification: RpcNotification) => void) => {
      notificationHandlers.push(handler)
      return vi.fn()
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    state.startPolling()

    const emitNotification = notificationHandlers[0]
    if (!emitNotification) {
      throw new Error('Notification subscription was not installed')
    }

    emitNotification(notification('thread/status/changed', {
      threadId: 'thread-a',
      status: { type: 'running', turnId: 'turn-1' },
    }))

    expect(state.selectedThread.value).toBeNull()
    expect(state.selectedThreadInProgress.value).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })
})

describe('findAdjacentThreadId', () => {
  it('selects the next thread after the archived thread', () => {
    const threads = [
      thread('first-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
      thread('next-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('next-thread')
  })

  it('falls back to the previous thread when the last thread is archived', () => {
    const threads = [
      thread('previous-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('previous-thread')
  })

  it('returns no fallback when there is no adjacent thread', () => {
    expect(findAdjacentThreadId([thread('selected-thread', '/tmp/project')], 'selected-thread')).toBe('')
  })
})

describe('optimistic user message', () => {
  function resumedDetail(messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; text: string; turnId?: string; turnIndex?: number }> = []) {
    return {
      model: 'gpt-5.5',
      modelProvider: 'codex',
      reasoningEffort: '',
      messages,
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {} as Record<string, number>,
    }
  }

  function detailWith(messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; text: string; turnId?: string; turnIndex?: number }>) {
    return {
      messages,
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {} as Record<string, number>,
    }
  }

  beforeEach(() => {
    gatewayMocks.resumeThread.mockReset()
    gatewayMocks.startThreadTurn.mockReset()
  })

  it('shows the sent prompt instantly before the app-server round-trip persists it', async () => {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue(resumedDetail())
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue(detailWith([]))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.loadMessages('thread-a')

    await state.sendMessageToSelectedThread('hello optimistic')

    const userMessages = state.messages.value.filter((message) => message.role === 'user' && message.text === 'hello optimistic')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]?.id.startsWith('optimistic-user-')).toBe(true)
  })

  it('clears the optimistic message once loadMessages sees the persisted user message', async () => {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue(resumedDetail())
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue(detailWith([]))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.loadMessages('thread-a')
    await flushMicrotasks()

    await state.sendMessageToSelectedThread('hello optimistic')
    expect(state.messages.value.some((message) => message.id.startsWith('optimistic-user-'))).toBe(true)

    gatewayMocks.resumeThread.mockResolvedValue(resumedDetail([
      { id: 'real-user-1', role: 'user', text: 'hello optimistic', turnId: 'turn-1', turnIndex: 0 },
    ]))
    await state.loadMessages('thread-a', { force: true })
    await waitForCalls(gatewayMocks.getThreadUserMessageIndex, 1)
    await waitForCalls(gatewayMocks.getThreadUserMessageCount, 1)

    expect(state.messages.value.some((message) => message.id.startsWith('optimistic-user-'))).toBe(false)
    expect(state.messages.value.filter((message) => message.role === 'user' && message.text === 'hello optimistic')).toHaveLength(1)
    expect(state.messages.value.find((message) => message.id === 'real-user-1')).toBeTruthy()
    expect(gatewayMocks.getThreadUserMessageIndex).toHaveBeenCalledWith('thread-a')
    expect(gatewayMocks.getThreadUserMessageCount).toHaveBeenCalledWith('thread-a')
  })

  it('keeps the optimistic message when startThreadTurn fails so the user can still see what they sent', async () => {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue(resumedDetail())
    gatewayMocks.startThreadTurn.mockRejectedValue(new Error('connection error'))
    gatewayMocks.getThreadDetail.mockResolvedValue(detailWith([]))

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
    await state.loadMessages('thread-a')

    await state.sendMessageToSelectedThread('hello after error').catch(() => {})

    const userMessages = state.messages.value.filter((message) => message.role === 'user' && message.text === 'hello after error')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]?.id.startsWith('optimistic-user-')).toBe(true)
  })
})

describe('skills list refresh', () => {
  function mockSkillsBaseline() {
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: 'codex',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    gatewayMocks.setThreadQueueState.mockResolvedValue(undefined)
  }

  it('reloads skills for an explicit cwd even when selected thread cwd differs', async () => {
    installTestWindow()
    mockSkillsBaseline()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'repo-a',
        threads: [
          thread('thread-a', '/tmp/repo-a'),
          thread('thread-b', '/tmp/repo-b'),
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.getSkillsList.mockResolvedValue([])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    state.primeSelectedThread('thread-a')

    gatewayMocks.getSkillsList.mockClear()
    gatewayMocks.getSkillsList.mockResolvedValue([
      {
        name: 'repo-b-skill',
        description: 'from repo b',
        path: '/tmp/repo-b/.agents/skills/repo-b-skill/SKILL.md',
        scope: 'repo',
        enabled: true,
      },
    ])

    await state.refreshSkills({ cwd: '/tmp/repo-b' })

    expect(gatewayMocks.getSkillsList).toHaveBeenCalledWith(['/tmp/repo-b'], expect.anything())
    expect(state.installedSkills.value.map((skill) => skill.name)).toEqual(['repo-b-skill'])
  })

  it('queues a second skills/list when cwd changes during an in-flight request', async () => {
    installTestWindow()
    mockSkillsBaseline()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'repo-a',
        threads: [
          thread('thread-a', '/tmp/repo-a'),
          thread('thread-b', '/tmp/repo-b'),
        ],
      }],
      nextCursor: null,
    })
    gatewayMocks.getSkillsList.mockResolvedValue([])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    let resolveFirst: ((value: unknown[]) => void) | null = null
    gatewayMocks.getSkillsList.mockReset()
    gatewayMocks.getSkillsList
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve as (value: unknown[]) => void
      }))
      .mockResolvedValueOnce([
        {
          name: 'repo-b-skill',
          description: 'from repo b',
          path: '/tmp/repo-b/.agents/skills/repo-b-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
      ])

    const first = state.refreshSkills({ cwd: '/tmp/repo-a' })
    const second = state.refreshSkills({ cwd: '/tmp/repo-b' })

    await vi.waitFor(() => {
      expect(resolveFirst).not.toBeNull()
    })
    if (!resolveFirst) throw new Error('Expected the first skills refresh to be pending')
    const resolvePendingRefresh = resolveFirst as (value: unknown[]) => void
    resolvePendingRefresh([
      {
        name: 'repo-a-skill',
        description: 'from repo a',
        path: '/tmp/repo-a/.agents/skills/repo-a-skill/SKILL.md',
        scope: 'repo',
        enabled: true,
      },
    ])
    await Promise.all([first, second])

    expect(gatewayMocks.getSkillsList.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(gatewayMocks.getSkillsList.mock.calls[0]?.[0]).toEqual(['/tmp/repo-a'])
    expect(gatewayMocks.getSkillsList.mock.calls.at(-1)?.[0]).toEqual(['/tmp/repo-b'])
    expect(state.installedSkills.value.map((skill) => skill.name)).toEqual(['repo-b-skill'])
  })

  it('force-reloads skills when skills/changed notification arrives', async () => {
    installTestWindow()
    mockSkillsBaseline()
    let notificationHandler: ((notification: RpcNotification) => void) | null = null
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler: (notification: RpcNotification) => void) => {
      notificationHandler = handler
      return () => {
        notificationHandler = null
      }
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getSkillsList.mockResolvedValue([])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    state.startPolling()
    expect(notificationHandler).not.toBeNull()

    gatewayMocks.getSkillsList.mockReset()
    gatewayMocks.getSkillsList.mockResolvedValue([
      {
        name: 'fresh-user-skill',
        description: 'installed into ~/.codex/skills',
        path: '/root/.codex/skills/fresh-user-skill/SKILL.md',
        scope: 'user',
        enabled: true,
      },
    ])

    if (!notificationHandler) throw new Error('Expected the notification subscription to be registered')
    const dispatchNotification = notificationHandler as (notification: RpcNotification) => void
    dispatchNotification({
      method: 'skills/changed',
      params: {},
      atIso: new Date().toISOString(),
    })
    await vi.waitFor(() => {
      expect(gatewayMocks.getSkillsList).toHaveBeenCalled()
    })

    const forceCalls = gatewayMocks.getSkillsList.mock.calls.filter((call) => call[1]?.forceReload === true)
    expect(forceCalls.length).toBeGreaterThan(0)
    expect(state.installedSkills.value.map((skill) => skill.name)).toContain('fresh-user-skill')
  })
})
