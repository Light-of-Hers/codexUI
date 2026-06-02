import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  applyModelContextWindowToThreadTokenUsage,
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
  getThreadGroupsPage: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadTitleCache: vi.fn(),
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
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
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
    expect(normalizeProviderId('rustcat')).toBe('codex')
    expect(normalizeProviderId('openrouter-free')).toBe('openrouter')
    expect(normalizeProviderId('custom-endpoint')).toBe('custom')
    expect(normalizeProviderId('ark')).toBe('ark')
    expect(normalizeProviderId('cursor')).toBe('cursor')
    expect(readSelectedProvider({}, '')).toBe('codex')
  })

  it('stores provider selections by session context', () => {
    const next = writeSelectedProviderForContext({}, 'thread-a', 'moon')

    expect(readSelectedProvider(next, 'thread-a')).toBe('moon')
    expect(readSelectedProvider(next, 'thread-b')).toBe('codex')
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

    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-a', undefined, undefined)
    expect(state.readModelIdForThread('thread-a')).toBe('ark-code-latest')
    expect(state.selectedModelId.value).toBe('ark-code-latest')
    expect(state.selectedProvider.value).toBe('moon')
    expect(state.readReasoningEffortForThread('thread-a')).toBe('high')
    expect(state.selectedReasoningEffort.value).toBe('high')
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
        model: 'ark-code-latest',
        modelProvider: 'moon',
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

    expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(1, 'thread-a', 'ark-code-latest', 'moon')
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

    expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(3, 'thread-a', 'gpt-5.5', 'rustcat')
    expect(state.selectedProvider.value).toBe('codex')
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
        modelProvider: String(provider ?? ''),
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

      expect(gatewayMocks.resumeThread).toHaveBeenNthCalledWith(
        1,
        'thread-a',
        scenario.initialModel,
        scenario.initialRpcProvider,
      )
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(threadDetail('turn-current'))
    gatewayMocks.interruptThreadTurn.mockResolvedValueOnce(undefined)

    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-a')
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-a', 'turn-current')
  })

  it('retries interrupt once when the active turn changes during stop', async () => {
    const { state } = createInterruptHarness()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce(threadDetail('turn-stale'))
      .mockResolvedValueOnce(threadDetail('turn-current'))
    gatewayMocks.interruptThreadTurn
      .mockRejectedValueOnce(new Error('RPC turn/interrupt failed with HTTP 502: expected active turn id turn-current but found turn-stale'))
      .mockResolvedValueOnce(undefined)

    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenNthCalledWith(1, 'thread-a', 'turn-stale')
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenNthCalledWith(2, 'thread-a', 'turn-current')
    expect(state.error.value).toBe('')
  })
})

describe('live turn rendering', () => {
  function createLiveStateHarness(): {
    state: ReturnType<typeof useDesktopState>
    notify: (notification: RpcNotification) => void
  } {
    installTestWindow()
    let notify: ((notification: RpcNotification) => void) | null = null
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler: (notification: RpcNotification) => void) => {
      notify = handler
      return vi.fn()
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-a')
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

  it('keeps live command output visible after turn completion until persisted messages refresh', () => {
    const { state, notify } = createLiveStateHarness()

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
  })

  it('keeps accumulated live reasoning when assistant text starts streaming', () => {
    const { state, notify } = createLiveStateHarness()

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
