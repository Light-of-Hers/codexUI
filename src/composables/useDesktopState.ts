import { computed, ref, watch } from 'vue'
import {
  archiveThread,
  clearThreadGoal,
  forkThread,
  getAvailableCollaborationModes,
  getAccountRateLimits,
  renameThread,
  getAvailableModelIds,
  getCurrentModelConfig,
  getArkModelIds,
  getArkModelMetadata,
  getPendingServerRequests,
  getMoonBridgeModelMetadata,
  getSkillsList,
  getThreadDetail,
  getFullThreadMessages,
  getThreadUserMessageCount,
  getThreadUserMessageIndex,
  type ThreadUserMessageIndexEntry,
  getOlderThreadMessages,
  getThreadTurnWindow,
  getBackgroundThreadListLimit,
  getThreadGoal,
  interruptThreadTurn,
  pickCodexRateLimitSnapshot,
  replyToServerRequest,
  revertThreadFileChanges,
  rollbackThread,
  getThreadGroupsPage,
  getThreadQueueState,
  getMoonBridgeModelIds,
  getWorkspaceRootsState,
  setCodexSpeedMode,
  setThreadQueueState,
  setWorkspaceRootsState,
  getThreadTitleCache,
  persistThreadTitle,
  generateThreadTitle,
  resumeThread,
  setThreadGoal,
  startThread,
  subscribeCodexNotifications,
  startThreadTurn,
  steerThreadTurn,
  type ThreadGoal,
  type ThreadGoalStatus,
  type RpcNotification,
  type SkillInfo,
  type MoonBridgeModelMetadata,
  type ThreadQueueState,
  type WorkspaceRootsState,
} from '../api/codexGateway'
import {
  cursorToolCallDisplayIdFromText,
  isCursorToolCallText,
  isIncompleteCursorToolCallText,
  parseCursorToolMessage,
} from '../api/normalizers/cursorToolCalls'
import { normalizeFileChangeStatus, toUiFileChanges, toUiToolCallMessage } from '../api/normalizers/v2'
import type {
  CollaborationModeKind,
  CollaborationModeOption,
  CommandExecutionData,
  UiPendingRequestState,
  ReasoningEffort,
  SpeedMode,
  UiFileChange,
  UiLiveOverlay,
  UiMessage,
  UiPlanData,
  UiPlanStep,
  UiProjectGroup,
  UiRateLimitSnapshot,
  UiServerRequest,
  UiServerRequestReply,
  UiThreadTokenUsage,
  UiTokenUsageBreakdown,
  UiThread,
  UiToolCallData,
} from '../types/codex'
import { getPathParent, isProjectlessChatPath, normalizePathForUi, toProjectName } from '../pathUtils.js'

function flattenThreads(groups: UiProjectGroup[]): UiThread[] {
  return groups.flatMap((group) => group.threads)
}

export function findAdjacentThreadId(threads: UiThread[], threadId: string): string {
  const targetIndex = threads.findIndex((thread) => thread.id === threadId)
  if (targetIndex < 0) return ''
  return threads[targetIndex + 1]?.id ?? threads[targetIndex - 1]?.id ?? ''
}

const READ_STATE_STORAGE_KEY = 'codex-web-local.thread-read-state.v1'
const UNREAD_CUTOFF_STORAGE_KEY = 'codex-web-local.thread-unread-cutoff.v1'
const THREAD_TOKEN_USAGE_STORAGE_KEY = 'codex-web-local.thread-token-usage.v1'
const THREAD_TERMINAL_OPEN_STORAGE_KEY = 'codex-web-local.thread-terminal-open.v1'
const SELECTED_THREAD_STORAGE_KEY = 'codex-web-local.selected-thread-id.v1'
const RECENT_THREAD_LRU_STORAGE_KEY = 'codex-web-local.recently-visited-thread-ids.v1'
const SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.selected-model-by-context.v1'
const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'codex-web-local.selected-model-id.v1'
const SELECTED_REASONING_EFFORT_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.reasoning-effort-by-context.v1'
const PROJECT_ORDER_STORAGE_KEY = 'codex-web-local.project-order.v1'
const PROJECT_DISPLAY_NAME_STORAGE_KEY = 'codex-web-local.project-display-name.v1'
const COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode-by-context.v1'
const LEGACY_COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode.v1'
const SELECTED_PROVIDER_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.provider-by-context.v1'
const NEW_THREAD_COLLABORATION_MODE_CONTEXT = '__new-thread__'
const NEW_THREAD_PROVIDER_CONTEXT = '__new-thread-provider__'
const NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX = '__new-thread-provider__::'
const EVENT_SYNC_DEBOUNCE_MS = 220
const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 10_000
const RATE_LIMIT_REFRESH_DEBOUNCE_MS = 500
const MODEL_CONFIG_FETCH_TIMEOUT_MS = 2_000
const ANCILLARY_REFRESH_TIMEOUT_MS = 6_000
const TURN_START_FOLLOW_UP_SYNC_DELAY_MS = 3000
const RECENT_THREAD_MESSAGE_LOAD_REUSE_MS = 2000
// Keep in-memory caches for at least this many recently-visited threads
// even if they scroll out of the sidebar's paged thread list.
const RECENT_THREAD_LRU_LIMIT = 30
const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const GLOBAL_SERVER_REQUEST_SCOPE = '__global__'
const MODEL_FALLBACK_ID = 'gpt-5.4-mini'
const CODEX_CLI_MISSING_MESSAGE = 'Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'
type CurrentModelConfigSnapshot = Awaited<ReturnType<typeof getCurrentModelConfig>>

function isCodexCliMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Codex CLI is not available')
}

export type ProviderId = string
type StoredProviderId = string

function loadReadStateMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(READ_STATE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function saveReadStateMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(READ_STATE_STORAGE_KEY, JSON.stringify(state))
}

function loadUnreadCutoffIso(): string {
  if (typeof window === 'undefined') return ''

  const existing = window.localStorage.getItem(UNREAD_CUTOFF_STORAGE_KEY)
  if (existing) return existing

  const initialCutoff = new Date().toISOString()
  window.localStorage.setItem(UNREAD_CUTOFF_STORAGE_KEY, initialCutoff)
  return initialCutoff
}

function saveUnreadCutoffIso(cutoffIso: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(UNREAD_CUTOFF_STORAGE_KEY, cutoffIso)
}

function isThreadUpdatedAfterCutoff(updatedAtIso: string, cutoffIso: string): boolean {
  if (!updatedAtIso || !cutoffIso) return false
  const updatedAtMs = new Date(updatedAtIso).getTime()
  const cutoffMs = new Date(cutoffIso).getTime()
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(cutoffMs)) return false
  return updatedAtMs > cutoffMs
}

export function isThreadUnreadByLastRead(
  updatedAtIso: string,
  threadReadStateIso: string | undefined,
  unreadCutoffIso: string,
): boolean {
  const effectiveLastReadIso = threadReadStateIso ?? unreadCutoffIso
  return isThreadUpdatedAfterCutoff(updatedAtIso, effectiveLastReadIso)
}

function normalizeCollaborationMode(value: unknown): CollaborationModeKind {
  return value === 'plan' ? 'plan' : 'default'
}

function normalizeStoredModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeProviderId(value: unknown): ProviderId {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'openai') {
    return 'codex'
  }
  if (normalized === 'moon') {
    return 'moon'
  }
  if (normalized === 'ark') {
    return 'ark'
  }
  if (normalized === 'cursor') {
    return 'cursor'
  }
  return normalized || 'codex'
}

function normalizeStoredProviderId(value: unknown): StoredProviderId {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  const normalized = raw.toLowerCase()
  if (normalized === 'codex') return 'codex'
  if (normalized === 'openai') return 'openai'
  if (normalized === 'moon') return 'moon'
  if (normalized === 'ark') return 'ark'
  if (normalized === 'cursor') return 'cursor'
  return raw
}

function normalizeCodexRpcProviderId(value: unknown, fallbackProviderId = ''): string {
  const providerId = normalizeStoredProviderId(value)
  if (!providerId || providerId.toLowerCase() === 'codex') {
    return normalizeStoredProviderId(fallbackProviderId) || 'openai'
  }
  return providerId
}

function createStringKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function cloneStringKeyedRecord<T>(record: Record<string, T>): Record<string, T> {
  const next = createStringKeyedRecord<T>()
  for (const [key, value] of Object.entries(record)) {
    next[key] = value
  }
  return next
}

function omitStringKeyedRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = createStringKeyedRecord<T>()
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) {
      next[entryKey] = value
    }
  }
  return next
}

function pruneThreadContextStateMap<T>(
  stateMap: Record<string, T>,
  threadIds: Set<string>,
): Record<string, T> {
  let changed = false
  const next = createStringKeyedRecord<T>()
  for (const [contextId, value] of Object.entries(stateMap)) {
    if (
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
      || contextId === NEW_THREAD_PROVIDER_CONTEXT
      || contextId.startsWith(NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX)
      || threadIds.has(contextId)
    ) {
      next[contextId] = value
      continue
    }
    changed = true
  }
  return changed ? next : stateMap
}

function normalizeProviderContextId(providerId: string): string {
  return normalizeProviderId(providerId)
}

export function inferProviderFromModel(modelId: string, moonBridgeModels: string[], arkModels: string[] = []): ProviderId | null {
  const normalizedModelId = normalizeStoredModelId(modelId)
  if (!normalizedModelId) return null
  if (arkModels.includes(normalizedModelId)) return 'ark'
  return moonBridgeModels.includes(normalizedModelId) ? 'moon' : null
}

function toRpcModelProviderId(providerId: ProviderId): string {
  if (providerId === 'codex') return ''
  return providerId
}

function toStoredRpcModelProviderId(providerId: unknown, fallbackCodexProviderId = ''): string {
  const storedProvider = normalizeStoredProviderId(providerId)
  const normalizedProvider = normalizeProviderId(storedProvider)
  if (normalizedProvider === 'codex') return normalizeCodexRpcProviderId(storedProvider, fallbackCodexProviderId)
  return toRpcModelProviderId(normalizedProvider) || storedProvider
}

function isNewThreadContextId(contextId: string): boolean {
  return contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function toProviderModelContextId(providerId: string): string {
  const normalizedProviderId = normalizeProviderContextId(providerId)
  if (!normalizedProviderId) return ''
  return `${NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX}${normalizedProviderId}`
}

function toThreadContextId(threadId: string): string {
  const normalizedThreadId = threadId.trim()
  return normalizedThreadId || NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function toProviderSelectionContextId(threadId: string): string {
  const normalizedThreadId = threadId.trim()
  if (normalizedThreadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
    return NEW_THREAD_PROVIDER_CONTEXT
  }
  return normalizedThreadId || NEW_THREAD_PROVIDER_CONTEXT
}

function loadSelectedModelMap(): Record<string, string> {
  if (typeof window === 'undefined') return createStringKeyedRecord<string>()

  try {
    const raw = window.localStorage.getItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createStringKeyedRecord<string>()

      const next = createStringKeyedRecord<string>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedModelId = normalizeStoredModelId(value)
        if (normalizedModelId) {
          next[contextId] = normalizedModelId
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  const legacyModelId = normalizeStoredModelId(window.localStorage.getItem(LEGACY_SELECTED_MODEL_STORAGE_KEY))
  const next = createStringKeyedRecord<string>()
  if (legacyModelId) {
    next[NEW_THREAD_COLLABORATION_MODE_CONTEXT] = legacyModelId
  }
  return next
}

function readSelectedModel(
  state: Record<string, string>,
  threadId: string,
): string {
  const contextId = toThreadContextId(threadId)
  const contextModelId = normalizeStoredModelId(state[contextId])
  if (contextModelId) return contextModelId
  if (contextId !== NEW_THREAD_COLLABORATION_MODE_CONTEXT) return ''
  return normalizeStoredModelId(state[NEW_THREAD_COLLABORATION_MODE_CONTEXT])
}

export function readSelectedModelForThreadContext(
  state: Record<string, string>,
  threadId: string,
  providerId: unknown,
): string {
  const contextId = toThreadContextId(threadId)
  if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
    const providerContextId = toProviderModelContextId(normalizeProviderId(providerId))
    const providerModelId = providerContextId
      ? normalizeStoredModelId(state[providerContextId])
      : ''
    if (providerModelId) return providerModelId
  }
  return readSelectedModel(state, threadId).trim()
}

function saveSelectedModelMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_SELECTED_MODEL_STORAGE_KEY)
  } catch {
    // Keep in-memory selection working even if localStorage writes fail.
  }
}

function normalizeStoredReasoningEffort(value: unknown): ReasoningEffort | '' {
  return typeof value === 'string' && REASONING_EFFORT_OPTIONS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : ''
}

function loadSelectedReasoningEffortMap(): Record<string, ReasoningEffort> {
  if (typeof window === 'undefined') return createStringKeyedRecord<ReasoningEffort>()

  try {
    const raw = window.localStorage.getItem(SELECTED_REASONING_EFFORT_BY_CONTEXT_STORAGE_KEY)
    if (!raw) return createStringKeyedRecord<ReasoningEffort>()

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createStringKeyedRecord<ReasoningEffort>()
    }

    const next = createStringKeyedRecord<ReasoningEffort>()
    for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof contextId !== 'string' || contextId.length === 0) continue
      const normalizedEffort = normalizeStoredReasoningEffort(value)
      if (normalizedEffort) {
        next[contextId] = normalizedEffort
      }
    }
    return next
  } catch {
    return createStringKeyedRecord<ReasoningEffort>()
  }
}

function readSelectedReasoningEffort(
  state: Record<string, ReasoningEffort>,
  threadId: string,
): ReasoningEffort | '' {
  const contextId = toThreadContextId(threadId)
  return normalizeStoredReasoningEffort(state[contextId])
}

function writeSelectedReasoningEffortForContext(
  state: Record<string, ReasoningEffort>,
  threadId: string,
  effort: ReasoningEffort | '',
): Record<string, ReasoningEffort> {
  const contextId = toThreadContextId(threadId)
  const normalizedEffort = normalizeStoredReasoningEffort(effort)
  if (!normalizedEffort) {
    return omitStringKeyedRecordKey(state, contextId)
  }

  const next = cloneStringKeyedRecord(state)
  next[contextId] = normalizedEffort
  return next
}

function saveSelectedReasoningEffortMap(state: Record<string, ReasoningEffort>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_REASONING_EFFORT_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_REASONING_EFFORT_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // Keep in-memory selection working even if localStorage writes fail.
  }
}

function loadSelectedProviderMap(): Record<string, StoredProviderId> {
  if (typeof window === 'undefined') return createStringKeyedRecord<StoredProviderId>()

  try {
    const raw = window.localStorage.getItem(SELECTED_PROVIDER_BY_CONTEXT_STORAGE_KEY)
    if (!raw) return createStringKeyedRecord<StoredProviderId>()

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createStringKeyedRecord<StoredProviderId>()
    }

    const next = createStringKeyedRecord<StoredProviderId>()
    for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof contextId !== 'string' || contextId.length === 0) continue
      const storedProvider = normalizeStoredProviderId(value)
      if (storedProvider) next[contextId] = storedProvider
    }
    return next
  } catch {
    return createStringKeyedRecord<StoredProviderId>()
  }
}

export function readSelectedProvider(
  state: Record<string, unknown>,
  threadId: string,
): ProviderId {
  const contextId = toProviderSelectionContextId(threadId)
  return normalizeProviderId(state[contextId])
}

export function writeSelectedProviderForContext(
  state: Record<string, StoredProviderId>,
  threadId: string,
  provider: unknown,
): Record<string, StoredProviderId> {
  const contextId = toProviderSelectionContextId(threadId)
  const storedProvider = normalizeStoredProviderId(provider)
  const normalizedProvider = normalizeProviderId(storedProvider)
  if (normalizedProvider === 'codex' && contextId === NEW_THREAD_PROVIDER_CONTEXT) {
    return omitStringKeyedRecordKey(state, contextId)
  }

  const nextProvider = normalizedProvider === 'codex' ? 'codex' : storedProvider
  const next = cloneStringKeyedRecord(state)
  next[contextId] = nextProvider
  return next
}

function saveSelectedProviderMap(state: Record<string, StoredProviderId>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_PROVIDER_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_PROVIDER_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // Keep in-memory provider selection working even if localStorage writes fail.
  }
}

function loadSelectedCollaborationModeMap(): Record<string, CollaborationModeKind> {
  if (typeof window === 'undefined') return createStringKeyedRecord<CollaborationModeKind>()

  try {
    const raw = window.localStorage.getItem(COLLABORATION_MODE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return createStringKeyedRecord<CollaborationModeKind>()
      }

      const next = createStringKeyedRecord<CollaborationModeKind>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedMode = normalizeCollaborationMode(value)
        if (normalizedMode === 'plan') {
          next[contextId] = normalizedMode
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  return createStringKeyedRecord<CollaborationModeKind>()
}

function readSelectedCollaborationMode(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
): CollaborationModeKind {
  const contextId = toThreadContextId(threadId)
  return normalizeCollaborationMode(state[contextId])
}

function writeSelectedCollaborationModeForContext(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
  mode: CollaborationModeKind,
): Record<string, CollaborationModeKind> {
  const contextId = toThreadContextId(threadId)
  if (isNewThreadContextId(contextId)) {
    return omitStringKeyedRecordKey(state, contextId)
  }
  if (mode === 'plan') {
    const next = cloneStringKeyedRecord(state)
    next[contextId] = 'plan'
    return next
  }
  return omitStringKeyedRecordKey(state, contextId)
}

function saveSelectedCollaborationModeMap(state: Record<string, CollaborationModeKind>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(COLLABORATION_MODE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(COLLABORATION_MODE_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_COLLABORATION_MODE_STORAGE_KEY)
  } catch {
    // Keep in-memory mode selection working even if localStorage writes fail.
  }
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function normalizeStoredTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed))
    }
  }

  return null
}

function normalizeTokenUsageBreakdown(value: unknown): UiThreadTokenUsage['last'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  return {
    totalTokens: normalizeStoredTokenCount(record.totalTokens) ?? 0,
    inputTokens: normalizeStoredTokenCount(record.inputTokens) ?? 0,
    cachedInputTokens: normalizeStoredTokenCount(record.cachedInputTokens) ?? 0,
    outputTokens: normalizeStoredTokenCount(record.outputTokens) ?? 0,
    reasoningOutputTokens: normalizeStoredTokenCount(record.reasoningOutputTokens) ?? 0,
  }
}

function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const total = normalizeTokenUsageBreakdown(record.total)
  const last = normalizeTokenUsageBreakdown(record.last)
  if (!total || !last) return null

  const modelContextWindow = normalizeStoredTokenCount(record.modelContextWindow)
  const currentContextTokens = last.totalTokens
  const remainingContextTokens = typeof modelContextWindow === 'number'
    ? Math.max(modelContextWindow - currentContextTokens, 0)
    : null
  const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
    ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
    : null

  return {
    total,
    last,
    modelContextWindow,
    currentContextTokens,
    remainingContextTokens,
    remainingContextPercent,
  }
}

export function applyModelContextWindowToThreadTokenUsage(
  usage: UiThreadTokenUsage,
  modelContextWindow: number | null,
): UiThreadTokenUsage {
  const normalizedContextWindow = normalizeStoredTokenCount(modelContextWindow)
  if (typeof normalizedContextWindow !== 'number' || normalizedContextWindow <= 0) {
    return usage
  }

  const currentContextTokens = usage.last.totalTokens
  const remainingContextTokens = Math.max(normalizedContextWindow - currentContextTokens, 0)
  const remainingContextPercent = clamp(
    Math.round((remainingContextTokens / normalizedContextWindow) * 100),
    0,
    100,
  )

  if (
    usage.modelContextWindow === normalizedContextWindow
    && usage.currentContextTokens === currentContextTokens
    && usage.remainingContextTokens === remainingContextTokens
    && usage.remainingContextPercent === remainingContextPercent
  ) {
    return usage
  }

  return {
    ...usage,
    modelContextWindow: normalizedContextWindow,
    currentContextTokens,
    remainingContextTokens,
    remainingContextPercent,
  }
}

function loadThreadTokenUsageMap(): Record<string, UiThreadTokenUsage> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, UiThreadTokenUsage> = {}
    for (const [threadId, usage] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId) continue
      const normalizedUsage = normalizeThreadTokenUsage(usage)
      if (normalizedUsage) {
        normalizedMap[threadId] = normalizedUsage
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTokenUsageMap(state: Record<string, UiThreadTokenUsage>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(state))
}

function loadThreadTerminalOpenMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TERMINAL_OPEN_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, boolean> = {}
    for (const [threadId, isOpen] of Object.entries(parsed as Record<string, unknown>)) {
      if (threadId && typeof isOpen === 'boolean') {
        normalizedMap[threadId] = isOpen
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTerminalOpenMap(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TERMINAL_OPEN_STORAGE_KEY, JSON.stringify(state))
}

function loadSelectedThreadId(): string {
  if (typeof window === 'undefined') return ''
  const raw = window.localStorage.getItem(SELECTED_THREAD_STORAGE_KEY)
  return raw ?? ''
}

function saveSelectedThreadId(threadId: string): void {
  if (typeof window === 'undefined') return
  if (!threadId) {
    window.localStorage.removeItem(SELECTED_THREAD_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(SELECTED_THREAD_STORAGE_KEY, threadId)
}

function loadRecentlyVisitedThreadIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_THREAD_LRU_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue
      const normalized = entry.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
      if (result.length >= RECENT_THREAD_LRU_LIMIT) break
    }
    return result
  } catch {
    return []
  }
}

function saveRecentlyVisitedThreadIds(ids: string[]): void {
  if (typeof window === 'undefined') return
  try {
    if (ids.length === 0) {
      window.localStorage.removeItem(RECENT_THREAD_LRU_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(RECENT_THREAD_LRU_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Best-effort persistence: dropping the LRU list only means keep-warm
    // is skipped after a reload; runtime behavior is unaffected.
  }
}


function loadProjectOrder(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item.length === 0) continue
      const normalizedItem = toProjectName(item)
      if (normalizedItem.length > 0 && !order.includes(normalizedItem)) {
        order.push(normalizedItem)
      }
    }
    return order
  } catch {
    return []
  }
}

function saveProjectOrder(order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order))
}

function loadProjectDisplayNames(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(PROJECT_DISPLAY_NAME_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const displayNames: Record<string, string> = {}
    for (const [projectName, displayName] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedProjectName = typeof projectName === 'string' ? toProjectName(projectName) : ''
      if (normalizedProjectName.length > 0 && typeof displayName === 'string') {
        displayNames[normalizedProjectName] = displayName
      }
    }
    return displayNames
  } catch {
    return {}
  }
}

function saveProjectDisplayNames(displayNames: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_DISPLAY_NAME_STORAGE_KEY, JSON.stringify(displayNames))
}

function mergeProjectOrder(previousOrder: string[], incomingGroups: UiProjectGroup[]): string[] {
  const nextOrder: string[] = []

  for (const projectName of previousOrder) {
    if (!nextOrder.includes(projectName)) {
      nextOrder.push(projectName)
    }
  }

  for (const group of incomingGroups) {
    if (!nextOrder.includes(group.projectName)) {
      nextOrder.push(group.projectName)
    }
  }

  return areStringArraysEqual(previousOrder, nextOrder) ? previousOrder : nextOrder
}

function orderGroupsByProjectOrder(incoming: UiProjectGroup[], projectOrder: string[]): UiProjectGroup[] {
  const incomingByName = new Map(incoming.map((group) => [group.projectName, group]))
  const ordered: UiProjectGroup[] = projectOrder
    .map((projectName) => incomingByName.get(projectName) ?? null)
    .filter((group): group is UiProjectGroup => group !== null)

  for (const group of incoming) {
    if (!projectOrder.includes(group.projectName)) {
      ordered.push(group)
    }
  }

  return ordered
}

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function reorderStringArray(items: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return items
  }

  if (fromIndex === toIndex) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function areCommandExecutionsEqual(first?: CommandExecutionData, second?: CommandExecutionData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.aggregatedOutput === second.aggregatedOutput && first.exitCode === second.exitCode
}

function areToolCallsEqual(first?: UiToolCallData, second?: UiToolCallData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.kind === second.kind &&
    first.title === second.title &&
    first.name === second.name &&
    first.status === second.status &&
    first.server === second.server &&
    first.input === second.input &&
    first.output === second.output &&
    first.error === second.error &&
    first.progress === second.progress &&
    first.durationMs === second.durationMs &&
    areStringArraysEqual(first.meta, second.meta)
  )
}

function arePlanStepsEqual(first: UiPlanStep[] = [], second: UiPlanStep[] = []): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index]?.step !== second[index]?.step || first[index]?.status !== second[index]?.status) {
      return false
    }
  }
  return true
}

function arePlanDataEqual(first?: UiPlanData, second?: UiPlanData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.explanation === second.explanation &&
    first.isStreaming === second.isStreaming &&
    arePlanStepsEqual(first.steps, second.steps)
  )
}

function isUnsupportedChatGptModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('not supported when using codex with a chatgpt account') ||
    message.includes('model is not supported') ||
    message.includes('requires a newer version of codex')
  )
}

function isNoActiveTurnToSteerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.toLowerCase().includes('no active turn to steer')
}

function isNoActiveTurnToInterruptError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.toLowerCase().includes('no active turn to interrupt')
}

function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  return (
    first.id === second.id &&
    first.role === second.role &&
    first.text === second.text &&
    areStringArraysEqual(first.images, second.images) &&
    areUiFileChangesEqual(first.fileChanges, second.fileChanges) &&
    first.fileChangeStatus === second.fileChangeStatus &&
    first.messageType === second.messageType &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled &&
    areCommandExecutionsEqual(first.commandExecution, second.commandExecution) &&
    areToolCallsEqual(first.toolCall, second.toolCall) &&
    arePlanDataEqual(first.plan, second.plan) &&
    first.turnId === second.turnId &&
    first.turnIndex === second.turnIndex &&
    first.isAutomationRun === second.isAutomationRun &&
    first.automationDisplayName === second.automationDisplayName
  )
}

function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function mergeMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: { preserveMissing?: boolean } = {},
): UiMessage[] {
  const previousById = new Map(previous.map((message) => [message.id, message]))
  const incomingById = new Map(incoming.map((message) => [message.id, message]))

  const mergedIncoming = incoming.map((incomingMessage) => {
    const previousMessage = previousById.get(incomingMessage.id)
    if (previousMessage && areMessageFieldsEqual(previousMessage, incomingMessage)) {
      return previousMessage
    }
    return incomingMessage
  })

  if (options.preserveMissing !== true) {
    return areMessageArraysEqual(previous, mergedIncoming) ? previous : mergedIncoming
  }

  const mergedFromPrevious = previous.map((previousMessage) => {
    const nextMessage = incomingById.get(previousMessage.id)
    if (!nextMessage) {
      return previousMessage
    }
    if (areMessageFieldsEqual(previousMessage, nextMessage)) {
      return previousMessage
    }
    return nextMessage
  })

  const previousIdSet = new Set(previous.map((message) => message.id))
  const appended = mergedIncoming.filter((message) => !previousIdSet.has(message.id))
  const merged = [...mergedFromPrevious, ...appended]

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

function sortMessagesByThreadPosition(messages: UiMessage[]): UiMessage[] {
  const indexed = messages.map((message, index) => ({ message, index }))
  indexed.sort((left, right) => {
    const leftTurn = typeof left.message.turnIndex === 'number' && Number.isFinite(left.message.turnIndex)
      ? left.message.turnIndex
      : Number.POSITIVE_INFINITY
    const rightTurn = typeof right.message.turnIndex === 'number' && Number.isFinite(right.message.turnIndex)
      ? right.message.turnIndex
      : Number.POSITIVE_INFINITY
    if (leftTurn !== rightTurn) return leftTurn - rightTurn
    return left.index - right.index
  })
  const sorted = indexed.map((entry) => entry.message)
  return areMessageArraysEqual(messages, sorted) ? messages : sorted
}

function areUiFileChangesEqual(first?: UiFileChange[], second?: UiFileChange[]): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    const firstChange = first[index]
    const secondChange = second[index]
    if (
      firstChange.path !== secondChange.path ||
      firstChange.operation !== secondChange.operation ||
      firstChange.movedToPath !== secondChange.movedToPath ||
      firstChange.diff !== secondChange.diff ||
      firstChange.addedLineCount !== secondChange.addedLineCount ||
      firstChange.removedLineCount !== secondChange.removedLineCount
    ) {
      return false
    }
  }
  return true
}

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingMessageIds = new Set(incoming.map((message) => message.id))
  const incomingAssistantTexts = new Set(
    incoming
      .filter((message) => message.role === 'assistant')
      .map((message) => normalizeMessageText(message.text))
      .filter((text) => text.length > 0),
  )

  if (incomingAssistantTexts.size === 0) {
    return previous
  }

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live') return true
    if (incomingMessageIds.has(message.id)) return false
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return false
    return !incomingAssistantTexts.has(normalized)
  })

  return next.length === previous.length ? previous : next
}

function removePersistedLiveMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingIds = new Set(incoming.map((message) => message.id))
  const next = previous.filter((message) => !incomingIds.has(message.id))
  return next.length === previous.length ? previous : next
}

function removeLiveAgentMessagesByIds(previous: UiMessage[], ids: Set<string>): UiMessage[] {
  if (ids.size === 0) return previous
  const next = previous.filter((message) => !ids.has(message.id))
  return next.length === previous.length ? previous : next
}

function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areMessageFieldsEqual(existing, nextMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, nextMessage)
  return next
}

type TurnSummaryState = {
  turnId: string
  durationMs: number
}

type TurnActivityState = {
  label: string
  details: string[]
}

type TurnErrorState = {
  message: string
  transient: boolean
}

type ThreadNoticeState = {
  label: string
  text: string
}

type GoalSlashCommand =
  | { kind: 'show' }
  | { kind: 'clear' }
  | { kind: 'status'; status: Extract<ThreadGoalStatus, 'active' | 'paused'> }
  | { kind: 'set'; objective: string }

type TurnStartedInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

type TurnCompletedInfo = {
  threadId: string
  turnId: string
  completedAtMs: number
  startedAtMs?: number
}

const WORKED_MESSAGE_TYPE = 'worked'

export function parseGoalSlashCommand(value: string): GoalSlashCommand | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\/goal(?:\s|$)/u.test(trimmed)) return null

  const args = trimmed.slice('/goal'.length).trim()
  if (!args) return { kind: 'show' }

  switch (args.toLowerCase()) {
    case 'clear':
      return { kind: 'clear' }
    case 'pause':
      return { kind: 'status', status: 'paused' }
    case 'resume':
    case 'unpause':
      return { kind: 'status', status: 'active' }
    default:
      return { kind: 'set', objective: args }
  }
}

function goalStatusLabel(status: ThreadGoalStatus): string {
  switch (status) {
    case 'active':
      return 'active'
    case 'paused':
      return 'paused'
    case 'budgetLimited':
      return 'budget limited'
    case 'complete':
      return 'complete'
  }
}

function goalNoticeForGoal(goal: ThreadGoal): ThreadNoticeState {
  return {
    label: `Goal ${goalStatusLabel(goal.status)}`,
    text: goal.objective,
  }
}

function parseIsoTimestamp(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function formatTurnDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '<1s'
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }

  const displaySeconds = seconds > 0 || parts.length === 0 ? seconds : 0
  parts.push(`${displaySeconds}s`)
  return parts.join(' ')
}

function areTurnSummariesEqual(first?: TurnSummaryState, second?: TurnSummaryState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.turnId === second.turnId && first.durationMs === second.durationMs
}

function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function buildTurnSummaryMessage(summary: TurnSummaryState): UiMessage {
  return {
    id: `turn-summary:${summary.turnId}`,
    role: 'system',
    text: `Worked for ${formatTurnDuration(summary.durationMs)}`,
    messageType: WORKED_MESSAGE_TYPE,
    turnId: summary.turnId,
  }
}

function findLastAssistantMessageIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      return index
    }
  }
  return -1
}

function insertTurnSummaryMessage(messages: UiMessage[], summary: TurnSummaryState): UiMessage[] {
  const summaryMessage = buildTurnSummaryMessage(summary)
  const sanitizedMessages = messages.filter((message) => message.messageType !== WORKED_MESSAGE_TYPE)
  const insertIndex = findLastAssistantMessageIndex(sanitizedMessages)
  if (insertIndex < 0) {
    return [...sanitizedMessages, summaryMessage]
  }
  const next = [...sanitizedMessages]
  next.splice(insertIndex, 0, summaryMessage)
  return next
}

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function omitKeys<TValue>(record: Record<string, TValue>, keys: Set<string>): Record<string, TValue> {
  if (keys.size === 0) return record
  let changed = false
  const next: Record<string, TValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return changed ? next : record
}

function areThreadFieldsEqual(first: UiThread, second: UiThread): boolean {
  return (
    first.id === second.id &&
    first.title === second.title &&
    first.projectName === second.projectName &&
    first.cwd === second.cwd &&
    first.modelProvider === second.modelProvider &&
    first.createdAtIso === second.createdAtIso &&
    first.updatedAtIso === second.updatedAtIso &&
    first.preview === second.preview &&
    first.unread === second.unread &&
    first.inProgress === second.inProgress &&
    first.pendingRequestState === second.pendingRequestState
  )
}

function areThreadArraysEqual(first: UiThread[], second: UiThread[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function areGroupArraysEqual(first: UiProjectGroup[], second: UiProjectGroup[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function pruneThreadStateMap<T>(stateMap: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const nextEntries = Object.entries(stateMap).filter(([threadId]) => threadIds.has(threadId))
  if (nextEntries.length === Object.keys(stateMap).length) {
    return stateMap
  }
  return Object.fromEntries(nextEntries) as Record<string, T>
}

export function removeThreadFromGroups(groups: UiProjectGroup[], threadId: string): UiProjectGroup[] {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return groups

  let changed = false
  const nextGroups: UiProjectGroup[] = []

  for (const group of groups) {
    const nextThreads = group.threads.filter((thread) => thread.id !== normalizedThreadId)
    const removedFromGroup = nextThreads.length !== group.threads.length
    if (removedFromGroup) {
      changed = true
    }
    if (nextThreads.length > 0) {
      nextGroups.push(removedFromGroup ? { ...group, threads: nextThreads } : group)
    } else if (group.threads.length === 0) {
      nextGroups.push(group)
    }
  }

  return changed ? nextGroups : groups
}

function mergeThreadGroups(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
): UiProjectGroup[] {
  const previousGroupsByName = new Map(previous.map((group) => [group.projectName, group]))
  const mergedGroups: UiProjectGroup[] = incoming.map((incomingGroup) => {
    const previousGroup = previousGroupsByName.get(incomingGroup.projectName)
    const previousThreadsById = new Map(previousGroup?.threads.map((thread) => [thread.id, thread]) ?? [])

    const mergedThreads = incomingGroup.threads.map((incomingThread) => {
      const previousThread = previousThreadsById.get(incomingThread.id)
      if (previousThread && areThreadFieldsEqual(previousThread, incomingThread)) {
        return previousThread
      }
      return incomingThread
    })

    if (
      previousGroup &&
      previousGroup.projectName === incomingGroup.projectName &&
      areThreadArraysEqual(previousGroup.threads, mergedThreads)
    ) {
      return previousGroup
    }

    return {
      projectName: incomingGroup.projectName,
      threads: mergedThreads,
    }
  })

  return areGroupArraysEqual(previous, mergedGroups) ? previous : mergedGroups
}

function mergeIncomingWithLocalInProgressThreads(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
  inProgressById: Record<string, boolean>,
): UiProjectGroup[] {
  const incomingThreadIds = new Set(flattenThreads(incoming).map((thread) => thread.id))
  const localInProgressThreads = flattenThreads(previous).filter(
    (thread) => inProgressById[thread.id] === true && !incomingThreadIds.has(thread.id),
  )

  if (localInProgressThreads.length === 0) {
    return incoming
  }

  const incomingByProjectName = new Map(incoming.map((group) => [group.projectName, group]))
  const merged: UiProjectGroup[] = incoming.map((group) => ({
    projectName: group.projectName,
    threads: [...group.threads],
  }))

  for (const thread of localInProgressThreads) {
    const existingGroup = incomingByProjectName.get(thread.projectName)
    if (existingGroup) {
      const mergedGroupIndex = merged.findIndex((group) => group.projectName === thread.projectName)
      if (mergedGroupIndex >= 0) {
        merged[mergedGroupIndex] = {
          projectName: merged[mergedGroupIndex].projectName,
          threads: [thread, ...merged[mergedGroupIndex].threads],
        }
      }
      continue
    }

    merged.push({
      projectName: thread.projectName,
      threads: [thread],
    })
  }

  return merged
}

function toProjectNameFromWorkspaceRoot(value: string): string {
  return toProjectName(value)
}

function getRemoteProjectHostLabel(hostId: string): string {
  const normalized = hostId.trim()
  if (!normalized) return ''
  const separatorIndex = normalized.lastIndexOf(':')
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized
}

function getRemoteProjectDisplayName(remoteProject: NonNullable<WorkspaceRootsState['remoteProjects']>[number]): string {
  const label = remoteProject.label || toProjectName(remoteProject.remotePath) || remoteProject.id
  const hostLabel = getRemoteProjectHostLabel(remoteProject.hostId)
  return hostLabel ? `${label} ${hostLabel}` : label
}

function getRemoteProjectById(rootsState: WorkspaceRootsState | null): Map<string, NonNullable<WorkspaceRootsState['remoteProjects']>[number]> {
  const remoteProjects = rootsState?.remoteProjects ?? []
  return new Map(remoteProjects.map((project) => [project.id, project]))
}

function getWorkspaceProjectOrderPaths(rootsState: WorkspaceRootsState | null): string[] {
  if (!rootsState) return []
  const savedRoots = new Set(rootsState.order)
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const orderedRoots = rootsState.projectOrder.filter((item) => savedRoots.has(item) || remoteProjectIds.has(item))
  for (const rootPath of rootsState.order) {
    if (!orderedRoots.includes(rootPath)) orderedRoots.push(rootPath)
  }
  for (const remoteProjectId of remoteProjectIds) {
    if (!orderedRoots.includes(remoteProjectId)) orderedRoots.push(remoteProjectId)
  }
  return orderedRoots
}

function getWorkspaceProjectOrderNames(
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): string[] {
  const remoteProjectsById = getRemoteProjectById(rootsState)
  return getWorkspaceProjectOrderPaths(rootsState).map((rootPath) => {
    if (remoteProjectsById.has(rootPath)) return rootPath
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    return duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
  })
}

function matchesWorkspaceRootProject(rootPath: string, projectName: string): boolean {
  const normalizedRootPath = normalizePathForUi(rootPath).trim()
  return normalizedRootPath === projectName || toProjectNameFromWorkspaceRoot(rootPath) === projectName
}

export function collectWorkspaceRootPathsForProjectRemoval(
  rootsState: WorkspaceRootsState,
  projectName: string,
): Set<string> {
  const removedRootPaths = new Set<string>()
  for (const rootPath of rootsState.order) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of rootsState.active) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of Object.keys(rootsState.labels)) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  return removedRootPaths
}

export function buildWorkspaceRootsProjectOrderState(
  rootsState: WorkspaceRootsState,
  orderedProjectNames: string[],
  groups: UiProjectGroup[],
): Pick<WorkspaceRootsState, 'order' | 'active' | 'projectOrder'> {
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const rootByProjectName = new Map<string, string>()
  for (const rootPath of rootsState.order) {
    const projectName = toProjectNameFromWorkspaceRoot(rootPath)
    if (!rootByProjectName.has(projectName)) {
      rootByProjectName.set(projectName, rootPath)
    }
  }
  for (const group of groups) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd) continue
    rootByProjectName.set(group.projectName, cwd)
  }

  const nextProjectOrder: string[] = []
  const pushProjectOrderItem = (item: string): void => {
    if (item && !nextProjectOrder.includes(item)) {
      nextProjectOrder.push(item)
    }
  }

  for (const projectName of orderedProjectNames) {
    if (remoteProjectIds.has(projectName)) {
      pushProjectOrderItem(projectName)
      continue
    }
    const rootPath = rootByProjectName.get(projectName)
    if (rootPath) {
      pushProjectOrderItem(rootPath)
    }
  }
  for (const item of getWorkspaceProjectOrderPaths(rootsState)) {
    pushProjectOrderItem(item)
  }

  const nextOrder = nextProjectOrder.filter((item) => rootsState.order.includes(item))
  for (const rootPath of rootsState.order) {
    if (!nextOrder.includes(rootPath)) {
      nextOrder.push(rootPath)
    }
  }

  const nextActive = rootsState.active.filter((rootPath) => nextOrder.includes(rootPath))
  if (nextActive.length === 0 && nextOrder.length > 0) {
    nextActive.push(nextOrder[0])
  }

  return {
    order: nextOrder,
    active: nextActive,
    projectOrder: nextProjectOrder,
  }
}

function orderGroupsByWorkspaceProjectOrder(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  const order = getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)
  if (order.length === 0) return groups
  const orderIndexByName = new Map(order.map((name, index) => [name, index]))
  return [...groups].sort((first, second) => {
    if (isProjectlessGroup(first) || isProjectlessGroup(second)) return 0
    const firstIndex = orderIndexByName.get(first.projectName) ?? Number.POSITIVE_INFINITY
    const secondIndex = orderIndexByName.get(second.projectName) ?? Number.POSITIVE_INFINITY
    if (firstIndex === secondIndex) return 0
    return firstIndex - secondIndex
  })
}

function collectDuplicateProjectLeafNames(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): Set<string> {
  const rootByLeafName = new Map<string, Set<string>>()
  const canonicalWorkspaceRootCountsByLeafName = new Map<string, number>()
  const addPath = (value: string): void => {
    const normalizedPath = normalizePathForUi(value).trim()
    if (!normalizedPath) return
    const leafName = toProjectName(normalizedPath)
    const existing = rootByLeafName.get(leafName) ?? new Set<string>()
    existing.add(normalizedPath)
    rootByLeafName.set(leafName, existing)
  }

  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectName(normalizedRootPath)
    if (!isManagedCodexWorktreePath(normalizedRootPath)) {
      canonicalWorkspaceRootCountsByLeafName.set(leafName, (canonicalWorkspaceRootCountsByLeafName.get(leafName) ?? 0) + 1)
    }
    addPath(rootPath)
  }
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = rootsState?.order.some((rootPath) => normalizePathForUi(rootPath).trim() === normalizedCwd) === true
      if (isManagedCodexWorktreePath(normalizedCwd) && !isRegisteredRoot && canonicalWorkspaceRootCountsByLeafName.get(leafName) === 1) continue
      addPath(thread.cwd)
    }
  }

  const duplicateLeafNames = new Set<string>()
  for (const [leafName, paths] of rootByLeafName.entries()) {
    if (paths.size > 1) duplicateLeafNames.add(leafName)
  }
  return duplicateLeafNames
}

function isManagedCodexWorktreePath(value: string): boolean {
  return value.includes('/.codex/worktrees/')
}

function disambiguateProjectGroupsByCwd(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  if (duplicateLeafNames.size === 0) return groups

  const uniqueCanonicalWorkspaceRootLeafNames = new Set<string>()
  const duplicateCanonicalWorkspaceRootLeafNames = new Set<string>()
  const canonicalWorkspaceRootByLeafName = new Map<string, string>()
  const registeredWorkspaceRoots = new Set<string>()
  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    registeredWorkspaceRoots.add(normalizedRootPath)
    if (isManagedCodexWorktreePath(normalizedRootPath)) continue
    const leafName = toProjectName(normalizedRootPath)
    if (uniqueCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.delete(leafName)
      duplicateCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.delete(leafName)
    } else if (!duplicateCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.set(leafName, normalizedRootPath)
    }
  }

  const disambiguatedGroups: UiProjectGroup[] = []
  const groupsByProjectName = new Map<string, UiProjectGroup>()
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = registeredWorkspaceRoots.has(normalizedCwd)
      const isCanonicalWorktreeThread = isManagedCodexWorktreePath(normalizedCwd)
        && !isRegisteredRoot
        && uniqueCanonicalWorkspaceRootLeafNames.has(leafName)
      let projectName = group.projectName
      if (isCanonicalWorktreeThread && duplicateLeafNames.has(leafName)) {
        projectName = canonicalWorkspaceRootByLeafName.get(leafName) ?? group.projectName
      } else if (normalizedCwd && duplicateLeafNames.has(leafName)) {
        projectName = normalizedCwd
      }
      const nextThread = thread.projectName === projectName ? thread : { ...thread, projectName }
      const existingGroup = groupsByProjectName.get(projectName)
      if (existingGroup) {
        existingGroup.threads.push(nextThread)
      } else {
        const nextGroup = { projectName, threads: [nextThread] }
        groupsByProjectName.set(projectName, nextGroup)
        disambiguatedGroups.push(nextGroup)
      }
    }
  }

  return disambiguatedGroups
}

function addWorkspaceRootPlaceholderGroups(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groups
  const existingProjectNames = new Set(groups.map((group) => group.projectName))
  const nextGroups = [...groups]
  const remoteProjectsById = getRemoteProjectById(rootsState)

  for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
    if (remoteProjectsById.has(rootPath)) {
      if (existingProjectNames.has(rootPath)) continue
      nextGroups.push({ projectName: rootPath, threads: [] })
      existingProjectNames.add(rootPath)
      continue
    }
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    const projectName = duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
    if (existingProjectNames.has(projectName)) continue
    nextGroups.push({ projectName, threads: [] })
    existingProjectNames.add(projectName)
  }

  return nextGroups
}

function toOptimisticThreadTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled thread'
  return firstLine.slice(0, 80)
}

function toForkedThreadTitle(title: string): string {
  const normalizedTitle = title.trim() || 'Untitled thread'
  return /^fork:\s+/iu.test(normalizedTitle) ? normalizedTitle : `Fork: ${normalizedTitle}`
}

function isProjectlessGroup(group: UiProjectGroup): boolean {
  return group.threads.some((thread) => thread.cwd.trim().length === 0 || isProjectlessChatPath(thread.cwd))
}

export function filterGroupsByWorkspaceRoots(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
  const groupsWithWorkspaceRoots = addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames)
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
  const allowedProjectNames = new Set<string>()
  for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
    allowedProjectNames.add(projectName)
  }
  const filteredGroups = groupsWithWorkspaceRoots.filter((group) => allowedProjectNames.has(group.projectName) || isProjectlessGroup(group))
  return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
}

export function useDesktopState() {
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const selectedThreadId = ref(loadSelectedThreadId())
  const recentlyVisitedThreadIds = ref<string[]>(loadRecentlyVisitedThreadIds())
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const fullHistoryMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const loadedFullHistoryByThreadId = ref<Record<string, boolean>>({})
  const loadingFullHistoryByThreadId = ref<Record<string, boolean>>({})
  const loadingMessagesByThreadId = ref<Record<string, boolean>>({})
  const userMessageCountByThreadId = ref<Record<string, number>>({})
  const loadingUserMessageCountByThreadId = ref<Record<string, boolean>>({})
  const userMessageIndexByThreadId = ref<Record<string, ThreadUserMessageIndexEntry[]>>({})
  const loadingUserMessageIndexByThreadId = ref<Record<string, boolean>>({})
  const livePlanMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveAgentMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveReasoningTextByThreadId = ref<Record<string, string>>({})
  const liveCommandsByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveFileChangeMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveToolCallMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const inProgressById = ref<Record<string, boolean>>({})
  type FileAttachment = { label: string; path: string; fsPath: string }
  type QueuedMessage = {
    id: string
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    fileAttachments: FileAttachment[]
    collaborationMode: CollaborationModeKind
    model: string
    modelProvider: StoredProviderId
    reasoningEffort: ReasoningEffort | ''
  }
  type PendingTurnRequest = {
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    fileAttachments: FileAttachment[]
    effort: ReasoningEffort | ''
    collaborationMode: CollaborationModeKind
    fallbackRetried: boolean
  }
  const queuedMessagesByThreadId = ref<Record<string, QueuedMessage[]>>({})
  const queueProcessingByThreadId = ref<Record<string, boolean>>({})
  let hasLoadedPersistedQueueState = false
  const eventUnreadByThreadId = ref<Record<string, boolean>>({})
  const availableModelIds = ref<string[]>([])
  const moonBridgeModelIds = ref<string[]>([])
  const moonBridgeModelContextWindowById = ref<Record<string, number>>(createStringKeyedRecord<number>())
  const arkModelIds = ref<string[]>([])
  const arkModelContextWindowById = ref<Record<string, number>>(createStringKeyedRecord<number>())
  const availableCollaborationModes = ref<CollaborationModeOption[]>([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ])
  const selectedCollaborationModeByContext = ref<Record<string, CollaborationModeKind>>(
    loadSelectedCollaborationModeMap(),
  )
  const selectedModelIdByContext = ref<Record<string, string>>(loadSelectedModelMap())
  const selectedReasoningEffortByContext = ref<Record<string, ReasoningEffort>>(loadSelectedReasoningEffortMap())
  const selectedProviderByContext = ref<Record<string, StoredProviderId>>(loadSelectedProviderMap())
  const selectedCollaborationMode = ref<CollaborationModeKind>(
    readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value),
  )
  const selectedModelId = ref(readSelectedModel(selectedModelIdByContext.value, selectedThreadId.value))
  const selectedProvider = ref<ProviderId>(readSelectedProvider(selectedProviderByContext.value, selectedThreadId.value))
  const selectedReasoningEffort = ref<ReasoningEffort | ''>(
    readSelectedReasoningEffort(selectedReasoningEffortByContext.value, selectedThreadId.value),
  )
  const selectedSpeedMode = ref<SpeedMode>('standard')
  const activeProviderId = ref('')
  const activeCodexProviderId = ref('')
  const codexCliMissingError = ref('')
  const readStateByThreadId = ref<Record<string, string>>(loadReadStateMap())
  const unreadCutoffIso = ref(loadUnreadCutoffIso())
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const hasMoreOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const loadingOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const resumedThreadProviderIdByThreadId = ref<Record<string, string>>({})
  const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
  const turnSummaryByThreadId = ref<Record<string, TurnSummaryState>>({})
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const threadNoticeByThreadId = ref<Record<string, ThreadNoticeState>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>({})
  const activeTurnProviderIdByThreadId = ref<Record<string, string>>({})
  const interruptBlockedUntilPersistedByThreadId = ref<Record<string, boolean>>({})
  const threadListedByServerById = ref<Record<string, boolean>>({})
  const persistedUserMessageByThreadId = ref<Record<string, boolean>>({})
  const pendingServerRequestsByThreadId = ref<Record<string, UiServerRequest[]>>({})
  const pendingTurnRequestByThreadId = ref<Record<string, PendingTurnRequest>>({})
  const codexRateLimit = ref<UiRateLimitSnapshot | null>(null)
  const threadTokenUsageByThreadId = ref<Record<string, UiThreadTokenUsage>>(loadThreadTokenUsageMap())
  const terminalOpenByThreadId = ref<Record<string, boolean>>(loadThreadTerminalOpenMap())

  const threadTitleById = ref<Record<string, string>>({})

  const installedSkills = ref<SkillInfo[]>([])
  const accountRateLimitSnapshots = ref<UiRateLimitSnapshot[]>([])

  const isLoadingThreads = ref(false)
  const isThreadListFullyLoaded = ref(false)
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const isUpdatingSpeedMode = ref(false)
  const isRollingBack = ref(false)

  const error = ref('')
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)

  function extractLocalImagePathFromUrl(value: string): string {
    try {
      const parsed = new URL(value, 'http://localhost')
      if (parsed.pathname !== '/codex-local-image') return ''
      return parsed.searchParams.get('path')?.trim() ?? ''
    } catch {
      return ''
    }
  }

  function shouldReuseAttachedImageFromPrompt(promptText: string): boolean {
    const normalized = promptText.trim().toLowerCase()
    if (!normalized) return false
    return /\b(attached image|attached screenshot|save the attached|copy (the )?screenshot|save screenshot)\b/i.test(normalized)
  }

  function findLatestUserLocalImageUrl(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (let index = persisted.length - 1; index >= 0; index -= 1) {
      const message = persisted[index]
      if (message.role !== 'user' || !Array.isArray(message.images) || message.images.length === 0) continue
      for (let imageIndex = message.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
        const imageUrl = message.images[imageIndex]?.trim() ?? ''
        if (!imageUrl) continue
        if (extractLocalImagePathFromUrl(imageUrl)) return imageUrl
      }
    }
    return ''
  }
  let stopNotificationStream: (() => void) | null = null
  let eventSyncTimer: number | null = null
  let rateLimitRefreshTimer: number | null = null
  const delayedTurnSyncTimerByThreadId = new Map<string, number>()
  let loadThreadsPromise: Promise<void> | null = null
  const loadMessagePromiseByThreadId = new Map<string, Promise<void>>()
  const loadFullHistoryPromiseByThreadId = new Map<string, Promise<void>>()
  const loadUserMessageCountPromiseByThreadId = new Map<string, Promise<void>>()
  const loadUserMessageIndexPromiseByThreadId = new Map<string, Promise<void>>()
  let refreshSkillsPromise: Promise<void> | null = null
  let rateLimitRefreshPromise: Promise<void> | null = null
  let pendingThreadsRefresh = false
  const pendingThreadMessageRefresh = new Set<string>()
  const lastMessageLoadAtByThreadId = new Map<string, number>()
  let threadListNextCursor: string | null = null
  let threadListBackgroundTimer: number | null = null
  let isLoadingRemainingThreadPages = false
  let hasLoadedAllThreadPages = false
  let loadedThreadListGroups: UiProjectGroup[] = []
  let loadedThreadListRootsState: WorkspaceRootsState | null = null
  let hasHydratedWorkspaceRootsState = false
  let activeReasoningItemId = ''
  let shouldAutoScrollOnNextAgentEvent = false
  const pendingTurnStartsById = new Map<string, TurnStartedInfo>()
  const fallbackRetryInFlightThreadIds = new Set<string>()
  let preserveUnlistedSelectedThread = false


  const allThreads = computed(() => flattenThreads(projectGroups.value))
  const selectedThread = computed(() =>
    allThreads.value.find((thread) => thread.id === selectedThreadId.value) ?? null,
  )
  const selectedThreadInProgress = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && inProgressById.value[threadId] === true)
  })
  const selectedThreadTerminalOpen = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && terminalOpenByThreadId.value[threadId] === true)
  })
  const isSelectedThreadInterruptPending = computed(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return false
    return interruptBlockedUntilPersistedByThreadId.value[threadId] === true
  })
  const selectedThreadServerRequests = computed<UiServerRequest[]>(() => {
    const rows: UiServerRequest[] = []
    const selected = selectedThreadId.value
    if (selected && Array.isArray(pendingServerRequestsByThreadId.value[selected])) {
      rows.push(...pendingServerRequestsByThreadId.value[selected])
    }
    if (Array.isArray(pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])) {
      rows.push(...pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])
    }
    return rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
  })
  const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null

    const isInProgress = inProgressById.value[threadId] === true
    const activity = isInProgress ? turnActivityByThreadId.value[threadId] : undefined
    const reasoningText = isInProgress
      ? (liveReasoningTextByThreadId.value[threadId] ?? '').trim()
      : ''
    const errorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()
    const notice = threadNoticeByThreadId.value[threadId]

    if (!activity && !reasoningText && !errorText && notice) {
      return {
        activityLabel: notice.label,
        activityDetails: [],
        reasoningText: notice.text,
        errorText: '',
      }
    }

    if (!activity && !reasoningText && !errorText) return null
    return {
      activityLabel: activity?.label || 'Thinking',
      activityDetails: activity?.details ?? [],
      reasoningText,
      errorText,
    }
  })
  const codexQuota = computed<UiRateLimitSnapshot | null>(() => codexRateLimit.value)
  const selectedThreadTokenUsage = computed<UiThreadTokenUsage | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    const usage = threadTokenUsageByThreadId.value[threadId] ?? null
    if (!usage) return null

    // Track model and context-window map changes for reactive recalculation.
    const ctxMap = selectedProvider.value === 'ark'
      ? arkModelContextWindowById.value
      : moonBridgeModelContextWindowById.value
    const modelId = selectedModelId.value
    // Only apply wrapper catalog context windows for their active provider.
    // Codex models can share names with wrapper route aliases.
    const modelContextWindow = (selectedProvider.value === 'moon' || selectedProvider.value === 'ark') && modelId
      ? (ctxMap[modelId] ?? null)
      : null
    return applyModelContextWindowToThreadTokenUsage(usage, modelContextWindow)
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const livePlan = livePlanMessagesByThreadId.value[threadId] ?? []
    const liveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    const liveCommands = liveCommandsByThreadId.value[threadId] ?? []
    const liveFileChanges = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const liveToolCalls = liveToolCallMessagesByThreadId.value[threadId] ?? []
    const combined = [...persisted, ...livePlan, ...liveCommands, ...liveFileChanges, ...liveToolCalls, ...liveAgent]

    const summary = turnSummaryByThreadId.value[threadId]
    if (!summary) return combined
    return insertTurnSummaryMessage(combined, summary)
  })
  const messageNavigationMessages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const fullHistory = fullHistoryMessagesByThreadId.value[threadId]
    if (loadedFullHistoryByThreadId.value[threadId] === true && Array.isArray(fullHistory)) {
      return fullHistory
    }

    // Full history is still loading. Fall back to whatever is already loaded
    // in the main view so the dropdown can render immediately, and rely on
    // isLoadingMessageNavigation to convey that more messages are still coming.
    // Once the full history arrives, this computed swaps to the complete list.
    return messages.value
  })
  const hasMoreOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? hasMoreOlderMessagesByThreadId.value[threadId] === true : false
  })
  const isLoadingMessageNavigation = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingFullHistoryByThreadId.value[threadId] === true : false
  })
  const userMessageNavigationTotal = computed<number | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    const value = userMessageCountByThreadId.value[threadId]
    return typeof value === 'number' ? value : null
  })
  const userMessageNavigationIndex = computed<ThreadUserMessageIndexEntry[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []
    return userMessageIndexByThreadId.value[threadId] ?? []
  })
  const isLoadingUserMessageNavigationIndex = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingUserMessageIndexByThreadId.value[threadId] === true : false
  })

  // Keep the user-message index + count in sync as new user turns arrive.
  // We track the set of user turnIds we have already indexed; whenever a new
  // one shows up (a fresh prompt was sent), force-refresh both the index and
  // the total so the dropdown reflects it without a page reload.
  const knownUserTurnIdsByThreadId = new Map<string, Set<string>>()
  watch(
    () => {
      const threadId = selectedThreadId.value
      if (!threadId) return { threadId: '', count: 0 }
      const userMessages = messages.value.filter((message) => message.role === 'user')
      return { threadId, count: userMessages.length }
    },
    ({ threadId }) => {
      if (!threadId) {
        knownUserTurnIdsByThreadId.clear()
        return
      }
      const known = knownUserTurnIdsByThreadId.get(threadId)
      const userTurnIds = new Set<string>()
      for (const message of messages.value) {
        if (message.role !== 'user') continue
        const turnId = message.turnId?.trim() ?? ''
        if (turnId) userTurnIds.add(turnId)
      }
      knownUserTurnIdsByThreadId.set(threadId, userTurnIds)
      if (!known) {
        // First time we observe this thread; the initial ensure already ran.
        return
      }
      const hasNew = Array.from(userTurnIds).some((id) => !known.has(id))
      if (!hasNew) return
      void loadUserMessageIndex(threadId, { force: true }).catch(() => {})
      void loadUserMessageCount(threadId, { force: true }).catch(() => {})
    },
  )
  const isLoadingMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingMessagesByThreadId.value[threadId] === true : false
  })
  const isLoadingOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingOlderMessagesByThreadId.value[threadId] === true : false
  })

  function getFirstPersistedTurnId(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (const message of persisted) {
      const turnId = message.turnId?.trim() ?? ''
      if (turnId) return turnId
    }
    return ''
  }

  function readModelIdForThread(threadId: string): string {
    const contextId = toThreadContextId(threadId)
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      const selectedNewThreadProvider = readSelectedProvider(selectedProviderByContext.value, '')
      if (selectedNewThreadProvider !== 'codex') {
        const providerContextId = toProviderModelContextId(selectedNewThreadProvider)
        const providerModelId = providerContextId
          ? normalizeStoredModelId(selectedModelIdByContext.value[providerContextId])
          : ''
        if (providerModelId) return providerModelId
      }

      return readSelectedModelForThreadContext(
        selectedModelIdByContext.value,
        threadId,
        selectedNewThreadProvider,
      )
    }

    return readSelectedModelForThreadContext(
      selectedModelIdByContext.value,
      threadId,
      readSelectedProvider(selectedProviderByContext.value, threadId),
    )
  }

  function readReasoningEffortForThread(threadId: string): ReasoningEffort | '' {
    return readSelectedReasoningEffort(selectedReasoningEffortByContext.value, threadId)
  }

  function syncThreadProviderFromModel(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (normalizedThreadId) {
      return
    }

    const currentNewThreadProvider = readSelectedProvider(selectedProviderByContext.value, '')
    if (currentNewThreadProvider !== 'moon' && currentNewThreadProvider !== 'ark') return

    const inferredProvider = inferProviderFromModel(modelId, moonBridgeModelIds.value, arkModelIds.value)
    if (inferredProvider && currentNewThreadProvider === inferredProvider) {
      setSelectedProviderForThread('', inferredProvider)
    }
  }

  function setSelectedReasoningEffortForThread(threadId: string, effort: ReasoningEffort | ''): void {
    const normalizedEffort = normalizeStoredReasoningEffort(effort)
    if (effort && !normalizedEffort) return

    selectedReasoningEffortByContext.value = writeSelectedReasoningEffortForContext(
      selectedReasoningEffortByContext.value,
      threadId,
      normalizedEffort,
    )

    if (toThreadContextId(threadId) === toThreadContextId(selectedThreadId.value)) {
      selectedReasoningEffort.value = readReasoningEffortForThread(selectedThreadId.value)
    }

    saveSelectedReasoningEffortMap(selectedReasoningEffortByContext.value)
  }

  function applyThreadModelStateWithProviderPriority(
    threadId: string,
    modelId: string,
    providerId?: unknown,
    reasoningEffort?: unknown,
  ): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const rawProvider = typeof providerId === 'string' ? providerId.trim() : ''
    const incomingProvider = rawProvider ? normalizeProviderId(rawProvider) : ''
    const providerContextId = toProviderSelectionContextId(normalizedThreadId)
    const explicitProvider = Object.prototype.hasOwnProperty.call(selectedProviderByContext.value, providerContextId)
      ? normalizeProviderId(selectedProviderByContext.value[providerContextId])
      : ''
    if (explicitProvider && (!incomingProvider || explicitProvider !== incomingProvider)) return

    setThreadModelId(normalizedThreadId, modelId)

    const normalizedReasoningEffort = normalizeStoredReasoningEffort(reasoningEffort)
    if (normalizedReasoningEffort) {
      setSelectedReasoningEffortForThread(normalizedThreadId, normalizedReasoningEffort)
    }

    // When the thread has an explicit modelProvider (non-empty), use it directly.
    // Empty providerId means codex thread (default), so skip inference entirely.
    if (rawProvider.length === 0) return

    setThreadProviderId(normalizedThreadId, incomingProvider)
  }

  function readThreadRpcProviderId(threadId: string): string {
    const contextId = toProviderSelectionContextId(threadId)
    const hasExplicitProvider = Object.prototype.hasOwnProperty.call(selectedProviderByContext.value, contextId)
    const storedProvider = hasExplicitProvider ? selectedProviderByContext.value[contextId] : ''
    if (storedProvider) return toStoredRpcModelProviderId(storedProvider, activeCodexProviderId.value)

    return ''
  }

  function invalidateThreadResumeState(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || normalizedThreadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) return
    resumedThreadById.value = omitKey(resumedThreadById.value, normalizedThreadId)
    resumedThreadProviderIdByThreadId.value = omitKey(resumedThreadProviderIdByThreadId.value, normalizedThreadId)
  }

  function markThreadResumed(threadId: string, providerId = readThreadRpcProviderId(threadId)): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || normalizedThreadId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) return
    resumedThreadById.value = {
      ...resumedThreadById.value,
      [normalizedThreadId]: true,
    }
    const normalizedProviderId = providerId.trim()
    if (normalizedProviderId) {
      resumedThreadProviderIdByThreadId.value = {
        ...resumedThreadProviderIdByThreadId.value,
        [normalizedThreadId]: normalizedProviderId,
      }
    } else if (resumedThreadProviderIdByThreadId.value[normalizedThreadId]) {
      resumedThreadProviderIdByThreadId.value = omitKey(resumedThreadProviderIdByThreadId.value, normalizedThreadId)
    }
  }

  // Eager: how many recent turns are pulled synchronously as part of the
  // main thread/read RPC (kept in sync with THREAD_RESPONSE_TURN_LIMIT on
  // the server). Lazy: the target window size after the background
  // backfill. -3..+3 around the latest turn = 7 turns.
  const EAGER_TURN_LIMIT = 3
  const LAZY_TURN_LIMIT = 7
  const backgroundOlderBackfillByThreadId = new Map<string, Promise<void>>()

  async function backfillOlderTurnsInBackground(threadId: string): Promise<void> {
    if (!threadId) return
    if (backgroundOlderBackfillByThreadId.has(threadId)) return
    if (hasMoreOlderMessagesByThreadId.value[threadId] !== true) return
    if (loadingOlderMessagesByThreadId.value[threadId] === true) return

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const distinctTurnIds = new Set<string>()
    for (const message of persisted) {
      const turnId = message.turnId?.trim() ?? ''
      if (turnId) distinctTurnIds.add(turnId)
    }
    const missing = LAZY_TURN_LIMIT - distinctTurnIds.size
    if (missing <= 0) return

    const beforeTurnId = getFirstPersistedTurnId(threadId)
    if (!beforeTurnId) return

    const backfillPromise = (async () => {
      try {
        const page = await getOlderThreadMessages(threadId, beforeTurnId, missing)
        const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
        const mergedMessages = mergeMessages(page.messages, previousPersisted, { preserveMissing: true })
        setPersistedMessagesForThread(threadId, mergedMessages)
        replaceTurnIndexLookupForThread(threadId, {
          ...(turnIndexByTurnIdByThreadId.value[threadId] ?? {}),
          ...page.turnIndexByTurnId,
        })
        rebindLiveFileChangeTurnIndices(threadId)
        hasMoreOlderMessagesByThreadId.value = {
          ...hasMoreOlderMessagesByThreadId.value,
          [threadId]: page.hasMoreOlder,
        }
        if (page.hasMoreOlder === false) {
          setFullHistoryMessagesForThread(threadId, mergedMessages)
        }
      } catch {
        // Background prefetch is best-effort; the user can still trigger
        // loadOlderMessages by scrolling up.
      }
    })().finally(() => {
      backgroundOlderBackfillByThreadId.delete(threadId)
    })
    backgroundOlderBackfillByThreadId.set(threadId, backfillPromise)
  }

  function shouldResumeThread(threadId: string, forceReload = false): boolean {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return false
    const expectedProviderId = readThreadRpcProviderId(normalizedThreadId).trim()
    const resumedProviderId = resumedThreadProviderIdByThreadId.value[normalizedThreadId]?.trim() ?? ''
    return forceReload
      || resumedThreadById.value[normalizedThreadId] !== true
      || readModelIdForThread(normalizedThreadId).trim().length === 0
      || expectedProviderId !== resumedProviderId
  }

  function ensureAvailableModelIds(...modelIds: string[]): void {
    const nextModelIds = [...availableModelIds.value]
    for (const modelId of modelIds) {
      const normalizedModelId = modelId.trim()
      if (normalizedModelId && !nextModelIds.includes(normalizedModelId)) {
        nextModelIds.push(normalizedModelId)
      }
    }
    if (!areStringArraysEqual(availableModelIds.value, nextModelIds)) {
      availableModelIds.value = nextModelIds
    }
  }

  function recordRecentlyVisitedThreadId(threadId: string): void {
    const normalized = threadId.trim()
    if (!normalized) return
    const current = recentlyVisitedThreadIds.value
    if (current[0] === normalized) return
    const filtered = current.filter((id) => id !== normalized)
    filtered.unshift(normalized)
    if (filtered.length > RECENT_THREAD_LRU_LIMIT) {
      filtered.length = RECENT_THREAD_LRU_LIMIT
    }
    recentlyVisitedThreadIds.value = filtered
    saveRecentlyVisitedThreadIds(filtered)
  }

  function setSelectedThreadId(nextThreadId: string): void {
    const sameThread = selectedThreadId.value === nextThreadId
    if (!sameThread) {
      selectedThreadId.value = nextThreadId
      saveSelectedThreadId(nextThreadId)
    }
    recordRecentlyVisitedThreadId(nextThreadId)
    selectedModelId.value = readModelIdForThread(nextThreadId)
    ensureAvailableModelIds(selectedModelId.value)
    selectedReasoningEffort.value = readReasoningEffortForThread(nextThreadId)
    selectedCollaborationMode.value = readSelectedCollaborationMode(
      selectedCollaborationModeByContext.value,
      nextThreadId,
    )
    selectedProvider.value = readSelectedProvider(selectedProviderByContext.value, nextThreadId)
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
  }

  function setSelectedModelIdForThread(threadId: string, modelId: string): void {
    const normalizedModelId = modelId.trim()
    const contextId = toThreadContextId(threadId)
    const currentContextId = toThreadContextId(selectedThreadId.value)
    const normalizedProviderId = contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
      ? readSelectedProvider(selectedProviderByContext.value, '')
      : normalizeProviderContextId(activeProviderId.value)
    const providerContextId =
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT && normalizedProviderId !== 'codex'
        ? toProviderModelContextId(normalizedProviderId)
        : ''
    const selectedContextId = providerContextId || contextId
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[selectedContextId] = normalizedModelId
      if (providerContextId) {
        delete nextModelMap[contextId]
      }
      selectedModelIdByContext.value = nextModelMap
    } else {
      let nextModelMap = omitStringKeyedRecordKey(selectedModelIdByContext.value, selectedContextId)
      if (providerContextId) {
        nextModelMap = omitStringKeyedRecordKey(nextModelMap, contextId)
      }
      selectedModelIdByContext.value = nextModelMap
    }
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      const selectedNewThreadProvider = readSelectedProvider(selectedProviderByContext.value, '')
      const inferredProvider = selectedNewThreadProvider === 'moon' || selectedNewThreadProvider === 'ark'
        ? inferProviderFromModel(normalizedModelId, moonBridgeModelIds.value, arkModelIds.value)
        : null
      const effectiveNewThreadProvider = inferredProvider === selectedNewThreadProvider
        ? inferredProvider
        : selectedNewThreadProvider
      const newThreadProviderContextId = effectiveNewThreadProvider
        ? toProviderModelContextId(effectiveNewThreadProvider)
        : ''
      if (newThreadProviderContextId) {
        if (normalizedModelId) {
          const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
          nextModelMap[newThreadProviderContextId] = normalizedModelId
          selectedModelIdByContext.value = nextModelMap
        } else {
          selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, newThreadProviderContextId)
        }
      }
    }
    syncThreadProviderFromModel(threadId, normalizedModelId)
    if (contextId === currentContextId) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
      ensureAvailableModelIds(selectedModelId.value)
    } else {
      ensureAvailableModelIds(normalizedModelId)
    }
    if (contextId !== NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      invalidateThreadResumeState(threadId)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setSelectedModelId(modelId: string): void {
    setSelectedModelIdForThread(selectedThreadId.value, modelId)
  }

  function setSelectedProviderForThread(threadId: string, providerId: unknown): void {
    const normalizedProvider = normalizeProviderId(providerId)
    const contextId = toProviderSelectionContextId(threadId)
    selectedProviderByContext.value = writeSelectedProviderForContext(
      selectedProviderByContext.value,
      threadId,
      providerId,
    )

    if (contextId === toProviderSelectionContextId(selectedThreadId.value)) {
      selectedProvider.value = normalizedProvider
    }
    if (toThreadContextId(threadId) !== NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      invalidateThreadResumeState(threadId)
    }
    saveSelectedProviderMap(selectedProviderByContext.value)
  }

  function setSelectedProviderForComposerContext(threadId: string, providerId: ProviderId): void {
    const normalizedProvider = normalizeProviderId(providerId)
    setSelectedProviderForThread(threadId, normalizedProvider)
    if (toThreadContextId(threadId) === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      selectedProvider.value = normalizedProvider
    }
  }

  function setSelectedProvider(providerId: ProviderId): void {
    setSelectedProviderForThread(selectedThreadId.value, providerId)
  }

  function setThreadModelId(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[normalizedThreadId] = normalizedModelId
      selectedModelIdByContext.value = nextModelMap
    } else {
      selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, normalizedThreadId)
    }
    ensureAvailableModelIds(normalizedModelId)
    if (selectedThreadId.value === normalizedThreadId) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setThreadProviderId(threadId: string, providerId: unknown): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    setSelectedProviderForThread(normalizedThreadId, providerId)
  }

  function syncThreadProvidersFromGroups(groups: UiProjectGroup[]): void {
    const syncEntries = Object.entries(selectedProviderByContext.value).filter(([, v]) => v && v !== 'codex')
    let nextProviderMap = selectedProviderByContext.value
    let changed = false
    const selectedContextId = toProviderSelectionContextId(selectedThreadId.value)

    for (const thread of flattenThreads(groups)) {
      const normalizedThreadId = thread.id.trim()
      if (!normalizedThreadId) continue

      const rawProvider = typeof thread.modelProvider === 'string' ? thread.modelProvider.trim() : ''
      const normalizedProvider = normalizeProviderId(rawProvider)
      const contextId = toProviderSelectionContextId(normalizedThreadId)
      const currentProvider = normalizeProviderId(nextProviderMap[contextId])
      if (currentProvider === normalizedProvider) continue

      // Never overwrite any thread whose provider was explicitly set by the user
      // (currentProvider is non-empty and non-codex).  The backend's modelProvider
      // reflects the last turn's provider, not the user's current preference.
      if (currentProvider.length > 0) continue

      // Skip overwriting the currently selected thread's provider if the thread has
      // an explicit provider — the user may have changed it in this session.
      // But still clean up stale entries (empty modelProvider → codex).
      if (contextId === selectedContextId && rawProvider.length > 0) continue

      if (!changed) {
        nextProviderMap = cloneStringKeyedRecord(nextProviderMap)
        changed = true
      }

      // Only clean up stale entries — never write back the backend's modelProvider
      // (it reflects the last turn's provider, not the user's current preference).
      if (normalizedProvider === 'codex' || !rawProvider) {
        delete nextProviderMap[contextId]
     }
    }

    if (!changed) return

    const afterEntries = Object.entries(nextProviderMap).filter(([, v]) => v && v !== 'codex')
    const removed = syncEntries.filter(([k]) => !afterEntries.some(([k2]) => k2 === k)).map(([k, v]) => k + '=' + v)
    if (removed.length > 0) {
      console.warn('[DEBUG:syncThreadProvidersFromGroups] cleaned user-set providers: %s', removed.join(', '))
    }
    selectedProviderByContext.value = nextProviderMap
    selectedProvider.value = readSelectedProvider(nextProviderMap, selectedThreadId.value)
    saveSelectedProviderMap(nextProviderMap)
  }

  function setThreadTokenUsage(threadId: string, usage: UiThreadTokenUsage | null): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    if (!usage) {
      if (!(normalizedThreadId in threadTokenUsageByThreadId.value)) return
      threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, normalizedThreadId)
      saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
      return
    }

    const current = threadTokenUsageByThreadId.value[normalizedThreadId]
    if (current && JSON.stringify(current) === JSON.stringify(usage)) return

    threadTokenUsageByThreadId.value = {
      ...threadTokenUsageByThreadId.value,
      [normalizedThreadId]: usage,
    }
    saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
  }

  function setSelectedCollaborationMode(mode: CollaborationModeKind): void {
    const nextMode: CollaborationModeKind = mode === 'plan' ? 'plan' : 'default'
    const contextId = toThreadContextId(selectedThreadId.value)
    const currentMode = readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value)
    if (currentMode === nextMode && selectedCollaborationMode.value === nextMode) return
    selectedCollaborationMode.value = nextMode
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      contextId,
      nextMode,
    )
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setSelectedCollaborationModeForThread(threadId: string, mode: CollaborationModeKind): void {
    const nextMode = mode === 'plan' ? 'plan' : 'default'
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      threadId,
      nextMode,
    )
    if (threadId.trim() === selectedThreadId.value) {
      selectedCollaborationMode.value = nextMode
    }
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setCodexRateLimit(nextSnapshot: UiRateLimitSnapshot | null): void {
    codexRateLimit.value = nextSnapshot
  }

  async function applyFallbackModelSelection(threadId: string = selectedThreadId.value): Promise<void> {
    if (threadId.trim()) {
      setThreadModelId(threadId, MODEL_FALLBACK_ID)
    } else {
      setSelectedModelId(MODEL_FALLBACK_ID)
    }
    ensureAvailableModelIds(MODEL_FALLBACK_ID)
  }

  function setPendingTurnRequest(threadId: string, request: PendingTurnRequest): void {
    pendingTurnRequestByThreadId.value = {
      ...pendingTurnRequestByThreadId.value,
      [threadId]: request,
    }
  }

  function clearPendingTurnRequest(threadId: string): void {
    if (!pendingTurnRequestByThreadId.value[threadId]) return
    pendingTurnRequestByThreadId.value = omitKey(pendingTurnRequestByThreadId.value, threadId)
  }



  async function retryPendingTurnWithFallback(threadId: string): Promise<void> {
    if (fallbackRetryInFlightThreadIds.has(threadId)) return
    const pending = pendingTurnRequestByThreadId.value[threadId]
    if (!pending || pending.fallbackRetried) return

    fallbackRetryInFlightThreadIds.add(threadId)
    setPendingTurnRequest(threadId, {
      ...pending,
      fallbackRetried: true,
    })

    try {
      await applyFallbackModelSelection(threadId)
      // Remove the failed user turn before replaying on fallback model to avoid duplicated user messages.
      try {
        const rolledBackMessages = await rollbackThread(threadId, 1)
        invalidateFullHistoryForThread(threadId)
        setPersistedMessagesForThread(threadId, rolledBackMessages)
        clearLivePlansForThread(threadId)
        setLiveAgentMessagesForThread(threadId, [])
        clearLiveReasoningForThread(threadId)
        if (liveCommandsByThreadId.value[threadId]) {
          liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
        }
        clearLiveToolCallsForThread(threadId)
      } catch {
        // If rollback fails, continue with retry rather than dropping the turn.
      }
      setTurnErrorForThread(threadId, null)
      error.value = ''
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, {
        label: 'Thinking',
        details: buildPendingTurnDetails(MODEL_FALLBACK_ID, pending.effort, pending.collaborationMode),
      })
      setThreadInProgress(threadId, true)

      if (shouldResumeThread(threadId)) {
        const resumedThread = await resumeThread(
          threadId,
          MODEL_FALLBACK_ID,
          readThreadRpcProviderId(threadId) || undefined,
        )
      }

      await startThreadTurn(
        threadId,
        pending.text,
        pending.imageUrls,
        MODEL_FALLBACK_ID,
        pending.effort || undefined,
        pending.skills.length > 0 ? pending.skills : undefined,
        pending.fileAttachments,
        pending.collaborationMode,
        readThreadRpcProviderId(threadId) || undefined,
      )

      markThreadResumed(threadId)

      scheduleRateLimitRefresh()
      pendingThreadMessageRefresh.add(threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
    } finally {
      fallbackRetryInFlightThreadIds.delete(threadId)
    }
  }

  function setSelectedReasoningEffort(effort: ReasoningEffort | ''): void {
    setSelectedReasoningEffortForThread(selectedThreadId.value, effort)
  }

  async function updateSelectedSpeedMode(mode: SpeedMode): Promise<void> {
    const nextMode: SpeedMode = mode === 'fast' ? 'fast' : 'standard'
    if (isUpdatingSpeedMode.value || selectedSpeedMode.value === nextMode) {
      return
    }

    const previousMode = selectedSpeedMode.value
    selectedSpeedMode.value = nextMode
    isUpdatingSpeedMode.value = true
    error.value = ''

    try {
      await setCodexSpeedMode(nextMode)
    } catch (unknownError) {
      selectedSpeedMode.value = previousMode
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to update Fast mode'
    } finally {
      isUpdatingSpeedMode.value = false
    }
  }

  async function refreshCollaborationModes(): Promise<void> {
    try {
      const modes = await getAvailableCollaborationModes()
      availableCollaborationModes.value = modes
      if (!modes.some((mode) => mode.value === selectedCollaborationMode.value)) {
        setSelectedCollaborationMode('default')
      }
    } catch {
      // Keep the last known collaboration mode choices on transient failures.
    }
  }

  function buildPendingTurnDetails(
    modelId: string,
    effort: ReasoningEffort | '',
    collaborationMode: CollaborationModeKind = selectedCollaborationMode.value,
  ): string[] {
    const modelLabel = modelId.trim() || 'default'
    const effortLabel = effort || 'default'
    const modeLabel = collaborationMode === 'plan' ? 'Plan' : 'Default'
    const speedLabel = selectedSpeedMode.value === 'fast' ? 'Fast' : 'Standard'
    return [`Mode: ${modeLabel}`, `Model: ${modelLabel}`, `Thinking: ${effortLabel}`, `Speed: ${speedLabel}`]
  }

  function applyMoonBridgeModelMetadata(models: MoonBridgeModelMetadata[]): string[] {
    const ids: string[] = []
    const contextWindowById = createStringKeyedRecord<number>()

    for (const model of models) {
      const modelId = model.id.trim()
      if (!modelId || ids.includes(modelId)) continue
      ids.push(modelId)
      if (typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
        contextWindowById[modelId] = Math.trunc(model.contextWindow)
      }
    }

    moonBridgeModelIds.value = ids
    moonBridgeModelContextWindowById.value = contextWindowById
    return ids
  }

  function applyArkModelMetadata(models: MoonBridgeModelMetadata[]): string[] {
    const ids: string[] = []
    const contextWindowById = createStringKeyedRecord<number>()

    for (const model of models) {
      const modelId = model.id.trim()
      if (!modelId || ids.includes(modelId)) continue
      ids.push(modelId)
      if (typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
        contextWindowById[modelId] = Math.trunc(model.contextWindow)
      }
    }

    arkModelIds.value = ids
    arkModelContextWindowById.value = contextWindowById
    return ids
  }

  async function loadMoonBridgeModelIds(): Promise<string[]> {
    const metadata = await getMoonBridgeModelMetadata()
    if (metadata.length > 0) {
      return applyMoonBridgeModelMetadata(metadata)
    }

    const ids = await getMoonBridgeModelIds()
    moonBridgeModelIds.value = ids
    moonBridgeModelContextWindowById.value = createStringKeyedRecord<number>()
    return ids
  }

  async function loadArkModelIds(): Promise<string[]> {
    const metadata = await getArkModelMetadata()
    if (metadata.length > 0) {
      return applyArkModelMetadata(metadata)
    }

    const ids = await getArkModelIds()
    arkModelIds.value = ids
    arkModelContextWindowById.value = createStringKeyedRecord<number>()
    return ids
  }

  async function refreshMoonBridgeModelIds(): Promise<void> {
    await loadMoonBridgeModelIds()
    await loadArkModelIds()
    if (selectedThreadId.value.trim()) {
      syncThreadProviderFromModel(selectedThreadId.value, readModelIdForThread(selectedThreadId.value))
    }
  }

  function invalidateAppServerRuntimeState(): void {
    resumedThreadById.value = {}
    resumedThreadProviderIdByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
    activeTurnProviderIdByThreadId.value = {}
  }

  function readFallbackCurrentModelConfig(providerId: ProviderId): CurrentModelConfigSnapshot {
    return {
      model: readModelIdForThread(selectedThreadId.value),
      providerId: toStoredRpcModelProviderId(providerId, activeCodexProviderId.value),
      reasoningEffort: readReasoningEffortForThread(selectedThreadId.value),
      speedMode: selectedSpeedMode.value,
    }
  }

  async function getCurrentModelConfigSnapshot(providerId: ProviderId): Promise<CurrentModelConfigSnapshot> {
    return await new Promise<CurrentModelConfigSnapshot>((resolve) => {
      let settled = false
      const timeoutId = setTimeout(() => {
        settled = true
        resolve(readFallbackCurrentModelConfig(providerId))
      }, MODEL_CONFIG_FETCH_TIMEOUT_MS)

      getCurrentModelConfig().then((config) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve(config)
      }).catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve(readFallbackCurrentModelConfig(providerId))
      })
    })
  }

  async function refreshModelPreferences(
    options?: { providerChanged?: boolean; includeProviderModels?: boolean; explicitProviderChange?: boolean },
  ): Promise<void> {
    codexCliMissingError.value = ''
    try {
      const selectedProviderContextId = toProviderSelectionContextId(selectedThreadId.value)
      const hasExplicitSelectedProvider = Object.prototype.hasOwnProperty.call(
        selectedProviderByContext.value,
        selectedProviderContextId,
      )
      const providerHint = hasExplicitSelectedProvider
        ? readSelectedProvider(selectedProviderByContext.value, selectedThreadId.value)
        : selectedProvider.value
      const [currentConfig, moonModels, arkModels] = await Promise.all([
        getCurrentModelConfigSnapshot(providerHint),
        moonBridgeModelIds.value.length > 0 && Object.keys(moonBridgeModelContextWindowById.value).length > 0
          ? Promise.resolve(moonBridgeModelIds.value)
          : loadMoonBridgeModelIds(),
        arkModelIds.value.length > 0 && Object.keys(arkModelContextWindowById.value).length > 0
          ? Promise.resolve(arkModelIds.value)
          : loadArkModelIds(),
      ])
      moonBridgeModelIds.value = moonModels
      arkModelIds.value = arkModels

      const normalizedConfiguredModelId = currentConfig.model.trim()
      const rawConfiguredProviderId = currentConfig.providerId.trim()
      const configuredProviderId = normalizeProviderContextId(currentConfig.providerId)
      const normalizedProviderId = hasExplicitSelectedProvider
        ? readSelectedProvider(selectedProviderByContext.value, selectedThreadId.value)
        : configuredProviderId
      const isProviderBacked = normalizedProviderId !== 'codex'
      activeProviderId.value = normalizedProviderId
      activeCodexProviderId.value = isProviderBacked ? '' : normalizeCodexRpcProviderId(rawConfiguredProviderId)
      const selectedContextId = toThreadContextId(selectedThreadId.value)
      const selectedContextIsNewThread = selectedContextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
      const normalizedSelectedModelId = readModelIdForThread(selectedThreadId.value)
      const modelIds = await getAvailableModelIds({
        includeProviderModels: options?.includeProviderModels !== false || isProviderBacked,
        requireProviderModels: isProviderBacked,
      })
      const providerModelContextId = toProviderModelContextId(normalizedProviderId)
      const providerScopedModelId = providerModelContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerModelContextId])
        : ''
      const nextModelIds = [...modelIds]
      if (!options?.providerChanged) {
        const extraModelIds = isProviderBacked
          ? (configuredProviderId === normalizedProviderId ? [normalizedConfiguredModelId] : [])
          : [normalizedSelectedModelId, normalizedConfiguredModelId]
        for (const modelId of extraModelIds) {
          if (modelId && !nextModelIds.includes(modelId)) {
            nextModelIds.push(modelId)
          }
        }
      }
      availableModelIds.value = nextModelIds
      const selectedModelProvider = inferProviderFromModel(normalizedSelectedModelId, moonBridgeModelIds.value, arkModelIds.value)
      const selectedModelMatchesActiveProvider =
        (normalizedProviderId === 'moon' || normalizedProviderId === 'ark') && selectedModelProvider === normalizedProviderId
      const canTrustActiveProviderCatalog =
        (normalizedProviderId !== 'moon' && normalizedProviderId !== 'ark')
        || (normalizedProviderId === 'moon' ? moonBridgeModelIds.value.length > 0 : arkModelIds.value.length > 0)
      const shouldReplaceExistingThreadModel =
        !selectedContextIsNewThread
        && isProviderBacked
        && modelIds.length > 0
        && (
          options?.explicitProviderChange === true
          || (!selectedModelMatchesActiveProvider && (options?.providerChanged !== true || canTrustActiveProviderCatalog))
        )
        && (!normalizedSelectedModelId || !modelIds.includes(normalizedSelectedModelId))
      let replacedExistingThreadModel = false
      if (shouldReplaceExistingThreadModel) {
        const replacementModelId = (
          configuredProviderId === normalizedProviderId
          && normalizedConfiguredModelId
          && modelIds.includes(normalizedConfiguredModelId)
        )
          ? normalizedConfiguredModelId
          : modelIds[0]
        setThreadModelId(selectedThreadId.value, replacementModelId ?? '')
        replacedExistingThreadModel = true
      } else if (!selectedContextIsNewThread) {
        ensureAvailableModelIds(normalizedSelectedModelId)
      }

      const currentModelInNewList = normalizedSelectedModelId && modelIds.includes(normalizedSelectedModelId)
      const shouldKeepProviderScopedNewThreadModel =
        selectedContextIsNewThread
        && isProviderBacked
        && normalizedSelectedModelId.length > 0
        && !currentModelInNewList
        && providerScopedModelId === normalizedSelectedModelId
      if (shouldKeepProviderScopedNewThreadModel) {
        ensureAvailableModelIds(normalizedSelectedModelId)
      }
      if (selectedContextIsNewThread && (!normalizedSelectedModelId || !currentModelInNewList || options?.providerChanged)) {
        if (shouldKeepProviderScopedNewThreadModel) {
          selectedModelId.value = normalizedSelectedModelId
        } else if (options?.providerChanged && nextModelIds.length > 0) {
          if (providerScopedModelId && modelIds.includes(providerScopedModelId)) {
            setSelectedModelId(providerScopedModelId)
          } else if (normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
            setSelectedModelId(normalizedConfiguredModelId)
          } else {
            setSelectedModelId(nextModelIds[0])
          }
        } else if (providerScopedModelId && nextModelIds.includes(providerScopedModelId)) {
          setSelectedModelId(providerScopedModelId)
        } else if (normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
          setSelectedModelId(currentConfig.model)
        } else if (nextModelIds.length > 0) {
          setSelectedModelId(nextModelIds[0])
        } else {
          setSelectedModelId('')
        }
      } else if (!replacedExistingThreadModel && selectedModelId.value.trim() !== normalizedSelectedModelId) {
        selectedModelId.value = normalizedSelectedModelId
        ensureAvailableModelIds(normalizedSelectedModelId)
      }
      const nextSelectedModelId = readModelIdForThread(selectedThreadId.value).trim()
      if (selectedModelId.value !== nextSelectedModelId) {
        selectedModelId.value = nextSelectedModelId
        ensureAvailableModelIds(nextSelectedModelId)
      }
      if (selectedContextIsNewThread && providerModelContextId && nextSelectedModelId.length > 0) {
        const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
        nextModelMap[providerModelContextId] = nextSelectedModelId
        selectedModelIdByContext.value = nextModelMap
        saveSelectedModelMap(selectedModelIdByContext.value)
      }
      if (selectedContextIsNewThread && isProviderBacked && !Object.prototype.hasOwnProperty.call(selectedProviderByContext.value, NEW_THREAD_PROVIDER_CONTEXT)) {
        selectedProviderByContext.value = writeSelectedProviderForContext(
          selectedProviderByContext.value,
          NEW_THREAD_COLLABORATION_MODE_CONTEXT,
          normalizedProviderId,
        )
        selectedProvider.value = readSelectedProvider(selectedProviderByContext.value, selectedThreadId.value)
        saveSelectedProviderMap(selectedProviderByContext.value)
      }

      const normalizedConfigReasoningEffort = normalizeStoredReasoningEffort(currentConfig.reasoningEffort)
      if (selectedContextIsNewThread) {
        if (
          normalizedConfigReasoningEffort &&
          !readReasoningEffortForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT)
        ) {
          setSelectedReasoningEffortForThread(
            NEW_THREAD_COLLABORATION_MODE_CONTEXT,
            normalizedConfigReasoningEffort,
          )
        } else {
          selectedReasoningEffort.value = readReasoningEffortForThread(selectedThreadId.value)
        }
      } else {
        selectedReasoningEffort.value = readReasoningEffortForThread(selectedThreadId.value)
      }
      selectedSpeedMode.value = currentConfig.speedMode
    } catch (unknownError) {
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
      // Keep chat UI usable even if model metadata is temporarily unavailable.
    }
  }

  async function refreshRateLimits(): Promise<void> {
    if (rateLimitRefreshPromise) {
      await rateLimitRefreshPromise
      return
    }

    rateLimitRefreshPromise = (async () => {
      try {
        const snapshot = await getAccountRateLimits()
        setCodexRateLimit(snapshot)
        accountRateLimitSnapshots.value = snapshot ? [snapshot] : []
      } catch {
        // Keep the last known rate-limit state if the endpoint is temporarily unavailable.
      } finally {
        rateLimitRefreshPromise = null
      }
    })()

    await rateLimitRefreshPromise
  }

  function scheduleRateLimitRefresh(): void {
    if (typeof window === 'undefined') {
      void refreshRateLimits()
      return
    }

    if (rateLimitRefreshTimer !== null) {
      window.clearTimeout(rateLimitRefreshTimer)
    }

    rateLimitRefreshTimer = window.setTimeout(() => {
      rateLimitRefreshTimer = null
      void refreshRateLimits()
    }, RATE_LIMIT_REFRESH_DEBOUNCE_MS)
  }

  function clearDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    const timerId = delayedTurnSyncTimerByThreadId.get(threadId)
    if (timerId === undefined) return
    window.clearTimeout(timerId)
    delayedTurnSyncTimerByThreadId.delete(threadId)
  }

  function scheduleDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    clearDelayedTurnSync(threadId)
    const timerId = window.setTimeout(() => {
      delayedTurnSyncTimerByThreadId.delete(threadId)
      pendingThreadMessageRefresh.add(threadId)
      void syncFromNotifications()
    }, TURN_START_FOLLOW_UP_SYNC_DELAY_MS)
    delayedTurnSyncTimerByThreadId.set(threadId, timerId)
  }

  function applyCachedTitlesToGroups(groups: UiProjectGroup[]): UiProjectGroup[] {
    const titles = threadTitleById.value
    if (Object.keys(titles).length === 0) return groups
    return groups.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const cached = titles[thread.id]
        return cached ? { ...thread, title: cached } : thread
      }),
    }))
  }

  function getThreadPendingRequests(threadId: string): UiServerRequest[] {
    if (!threadId) return []
    return Array.isArray(pendingServerRequestsByThreadId.value[threadId])
      ? pendingServerRequestsByThreadId.value[threadId]
      : []
  }

  function isApprovalRequestMethod(method: string): boolean {
    return (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    )
  }

  function readPendingRequestState(requests: UiServerRequest[]): UiPendingRequestState | null {
    if (requests.some((request) => isApprovalRequestMethod(request.method))) {
      return 'approval'
    }
    return requests.length > 0 ? 'response' : null
  }

  function applyThreadFlags(): void {
    const withTitles = applyCachedTitlesToGroups(sourceGroups.value)
    const flaggedGroups: UiProjectGroup[] = withTitles.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const inProgress = inProgressById.value[thread.id] === true
        const pendingRequestState = readPendingRequestState(getThreadPendingRequests(thread.id))
        const isSelected = selectedThreadId.value === thread.id
        const unreadByEvent = eventUnreadByThreadId.value[thread.id] === true
        const unreadByTime = isThreadUnreadByLastRead(
          thread.updatedAtIso,
          readStateByThreadId.value[thread.id],
          unreadCutoffIso.value,
        )
        const unread = !isSelected && !inProgress && (unreadByEvent || unreadByTime)

        return {
          ...thread,
          inProgress,
          unread,
          pendingRequestState,
        }
      }),
    }))
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  function insertOptimisticThread(threadId: string, cwd: string, firstMessageText: string): void {
    const nowIso = new Date().toISOString()
    const normalizedCwd = normalizePathForUi(cwd)
    const projectName = toProjectName(normalizedCwd)
    const nextThread: UiThread = {
      id: threadId,
      title: toOptimisticThreadTitle(firstMessageText),
      projectName,
      cwd: normalizedCwd,
      modelProvider: selectedProvider.value,
      hasWorktree: normalizedCwd.includes('/.codex/worktrees/') || normalizedCwd.includes('/.git/worktrees/'),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      preview: firstMessageText,
      unread: false,
      inProgress: false,
    }

    const existingGroupIndex = sourceGroups.value.findIndex((group) => group.projectName === projectName)
    if (existingGroupIndex >= 0) {
      const existingGroup = sourceGroups.value[existingGroupIndex]
      const remainingThreads = existingGroup.threads.filter((thread) => thread.id !== threadId)
      const nextGroup: UiProjectGroup = {
        projectName,
        threads: [nextThread, ...remainingThreads],
      }
      const nextGroups = [...sourceGroups.value]
      nextGroups.splice(existingGroupIndex, 1, nextGroup)
      sourceGroups.value = nextGroups
    } else {
      sourceGroups.value = [{ projectName, threads: [nextThread] }, ...sourceGroups.value]
    }

    const nextProjectOrder = mergeProjectOrder(projectOrder.value, sourceGroups.value)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }
    applyThreadFlags()
  }

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    const currentThreadId = selectedThreadId.value.trim()
    if (currentThreadId) {
      activeThreadIds.add(currentThreadId)
    }
    // Preserve caches for recently-visited threads even if the sidebar
    // paged them out; this is the LRU keep-warm that avoids re-fetching
    // messages when the user hops back to a hot thread.
    for (const recentThreadId of recentlyVisitedThreadIds.value) {
      const normalized = recentThreadId.trim()
      if (normalized) activeThreadIds.add(normalized)
    }
    const nextSelectedModelMap = pruneThreadContextStateMap(selectedModelIdByContext.value, activeThreadIds)
    if (nextSelectedModelMap !== selectedModelIdByContext.value) {
      selectedModelIdByContext.value = nextSelectedModelMap
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
      ensureAvailableModelIds(selectedModelId.value)
      saveSelectedModelMap(nextSelectedModelMap)
    }
    const nextSelectedReasoningEffortMap = pruneThreadContextStateMap(
      selectedReasoningEffortByContext.value,
      activeThreadIds,
    )
    if (nextSelectedReasoningEffortMap !== selectedReasoningEffortByContext.value) {
      selectedReasoningEffortByContext.value = nextSelectedReasoningEffortMap
      selectedReasoningEffort.value = readReasoningEffortForThread(selectedThreadId.value)
      saveSelectedReasoningEffortMap(nextSelectedReasoningEffortMap)
    }
    const nextSelectedProviderMap = pruneThreadContextStateMap(
      selectedProviderByContext.value,
      activeThreadIds,
    )
    if (nextSelectedProviderMap !== selectedProviderByContext.value) {
      selectedProviderByContext.value = nextSelectedProviderMap
      selectedProvider.value = readSelectedProvider(nextSelectedProviderMap, selectedThreadId.value)
      saveSelectedProviderMap(nextSelectedProviderMap)
    }
    const nextSelectedCollaborationModeMap = pruneThreadContextStateMap(
      selectedCollaborationModeByContext.value,
      activeThreadIds,
    )
    if (nextSelectedCollaborationModeMap !== selectedCollaborationModeByContext.value) {
      selectedCollaborationModeByContext.value = nextSelectedCollaborationModeMap
      selectedCollaborationMode.value = readSelectedCollaborationMode(
        nextSelectedCollaborationModeMap,
        selectedThreadId.value,
      )
      saveSelectedCollaborationModeMap(nextSelectedCollaborationModeMap)
    }
    const nextReadState = pruneThreadStateMap(readStateByThreadId.value, activeThreadIds)
    if (nextReadState !== readStateByThreadId.value) {
      readStateByThreadId.value = nextReadState
      saveReadStateMap(nextReadState)
    }
    loadedMessagesByThreadId.value = pruneThreadStateMap(loadedMessagesByThreadId.value, activeThreadIds)
    loadingMessagesByThreadId.value = pruneThreadStateMap(loadingMessagesByThreadId.value, activeThreadIds)
    loadedVersionByThreadId.value = pruneThreadStateMap(loadedVersionByThreadId.value, activeThreadIds)
    resumedThreadById.value = pruneThreadStateMap(resumedThreadById.value, activeThreadIds)
    resumedThreadProviderIdByThreadId.value = pruneThreadStateMap(resumedThreadProviderIdByThreadId.value, activeThreadIds)
    turnIndexByTurnIdByThreadId.value = pruneThreadStateMap(turnIndexByTurnIdByThreadId.value, activeThreadIds)
    persistedMessagesByThreadId.value = pruneThreadStateMap(persistedMessagesByThreadId.value, activeThreadIds)
    fullHistoryMessagesByThreadId.value = pruneThreadStateMap(fullHistoryMessagesByThreadId.value, activeThreadIds)
    loadedFullHistoryByThreadId.value = pruneThreadStateMap(loadedFullHistoryByThreadId.value, activeThreadIds)
    loadingFullHistoryByThreadId.value = pruneThreadStateMap(loadingFullHistoryByThreadId.value, activeThreadIds)
    userMessageCountByThreadId.value = pruneThreadStateMap(userMessageCountByThreadId.value, activeThreadIds)
    loadingUserMessageCountByThreadId.value = pruneThreadStateMap(loadingUserMessageCountByThreadId.value, activeThreadIds)
    userMessageIndexByThreadId.value = pruneThreadStateMap(userMessageIndexByThreadId.value, activeThreadIds)
    loadingUserMessageIndexByThreadId.value = pruneThreadStateMap(loadingUserMessageIndexByThreadId.value, activeThreadIds)
    liveAgentMessagesByThreadId.value = pruneThreadStateMap(liveAgentMessagesByThreadId.value, activeThreadIds)
    liveReasoningTextByThreadId.value = pruneThreadStateMap(liveReasoningTextByThreadId.value, activeThreadIds)
    liveCommandsByThreadId.value = pruneThreadStateMap(liveCommandsByThreadId.value, activeThreadIds)
    liveFileChangeMessagesByThreadId.value = pruneThreadStateMap(liveFileChangeMessagesByThreadId.value, activeThreadIds)
    liveToolCallMessagesByThreadId.value = pruneThreadStateMap(liveToolCallMessagesByThreadId.value, activeThreadIds)
    turnSummaryByThreadId.value = pruneThreadStateMap(turnSummaryByThreadId.value, activeThreadIds)
    turnActivityByThreadId.value = pruneThreadStateMap(turnActivityByThreadId.value, activeThreadIds)
    turnErrorByThreadId.value = pruneThreadStateMap(turnErrorByThreadId.value, activeThreadIds)
    threadNoticeByThreadId.value = pruneThreadStateMap(threadNoticeByThreadId.value, activeThreadIds)
    activeTurnIdByThreadId.value = pruneThreadStateMap(activeTurnIdByThreadId.value, activeThreadIds)
    activeTurnProviderIdByThreadId.value = pruneThreadStateMap(activeTurnProviderIdByThreadId.value, activeThreadIds)
    interruptBlockedUntilPersistedByThreadId.value = pruneThreadStateMap(
      interruptBlockedUntilPersistedByThreadId.value,
      activeThreadIds,
    )
    threadListedByServerById.value = pruneThreadStateMap(threadListedByServerById.value, activeThreadIds)
    persistedUserMessageByThreadId.value = pruneThreadStateMap(persistedUserMessageByThreadId.value, activeThreadIds)
    const nextQueuedMessages = pruneThreadStateMap(queuedMessagesByThreadId.value, activeThreadIds)
    if (nextQueuedMessages !== queuedMessagesByThreadId.value) {
      queuedMessagesByThreadId.value = nextQueuedMessages
      persistQueueState()
    }
    threadTokenUsageByThreadId.value = pruneThreadStateMap(threadTokenUsageByThreadId.value, activeThreadIds)
    eventUnreadByThreadId.value = pruneThreadStateMap(eventUnreadByThreadId.value, activeThreadIds)
    inProgressById.value = pruneThreadStateMap(inProgressById.value, activeThreadIds)
    const nextPending: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (threadId === GLOBAL_SERVER_REQUEST_SCOPE || activeThreadIds.has(threadId)) {
        nextPending[threadId] = requests
      }
    }
    pendingServerRequestsByThreadId.value = nextPending
  }

  function markThreadAsRead(threadId: string): void {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    if (!thread) return

    readStateByThreadId.value = {
      ...readStateByThreadId.value,
      [threadId]: thread.updatedAtIso,
    }
    saveReadStateMap(readStateByThreadId.value)
    if (eventUnreadByThreadId.value[threadId]) {
      eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
    }
    applyThreadFlags()
  }

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState | null): void {
    if (!threadId) return

    const previous = turnSummaryByThreadId.value[threadId]
    if (summary) {
      if (areTurnSummariesEqual(previous, summary)) return
      turnSummaryByThreadId.value = {
        ...turnSummaryByThreadId.value,
        [threadId]: summary,
      }
    } else {
      if (previous) {
        turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
      }
    }
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    if (!threadId) return
    const currentValue = inProgressById.value[threadId] === true
    if (currentValue === nextInProgress) return
    if (nextInProgress) {
      inProgressById.value = {
        ...inProgressById.value,
        [threadId]: true,
      }
    } else {
      inProgressById.value = omitKey(inProgressById.value, threadId)
      clearInterruptPersistenceGate(threadId)
    }
    applyThreadFlags()
    if (!nextInProgress && !hasActiveInProgressThreads() && threadListNextCursor) {
      scheduleRemainingThreadPages()
    }
  }

  function clearInterruptPersistenceGate(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId]) {
      interruptBlockedUntilPersistedByThreadId.value = omitKey(interruptBlockedUntilPersistedByThreadId.value, threadId)
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function blockInterruptUntilThreadIsPersisted(threadId: string): void {
    if (!threadId) return
    interruptBlockedUntilPersistedByThreadId.value = {
      ...interruptBlockedUntilPersistedByThreadId.value,
      [threadId]: true,
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function maybeUnblockInterruptForPersistedThread(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (threadListedByServerById.value[threadId] !== true) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function maybeUnblockInterruptForActiveTurn(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function ensureActiveTurnActivity(threadId: string): void {
    if (!threadId) return
    if (turnActivityByThreadId.value[threadId]) return
    setTurnActivityForThread(threadId, {
      label: 'Thinking',
      details: [],
    })
  }

  function setActiveTurnForThread(threadId: string, turnId: string): void {
    const normalizedTurnId = turnId.trim()
    if (!threadId || !normalizedTurnId) return
    if (activeTurnIdByThreadId.value[threadId] !== normalizedTurnId) {
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [threadId]: normalizedTurnId,
      }
    }
    maybeUnblockInterruptForActiveTurn(threadId, normalizedTurnId)
    ensureActiveTurnActivity(threadId)
    setThreadInProgress(threadId, true)
  }

  function clearActiveTurnForThread(threadId: string): void {
    if (!threadId) return
    if (activeTurnIdByThreadId.value[threadId]) {
      activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
    }
    if (activeTurnProviderIdByThreadId.value[threadId]) {
      activeTurnProviderIdByThreadId.value = omitKey(activeTurnProviderIdByThreadId.value, threadId)
    }
    setThreadInProgress(threadId, false)
  }

  function hasPersistedAssistantResultForTurn(messages: UiMessage[] | undefined, turnId: string): boolean {
    if (!turnId || !messages) return false
    return messages.some((message) => message.turnId === turnId && message.role === 'assistant')
  }

  function applyThreadDetailActiveTurnState(
    threadId: string,
    detail: { messages?: UiMessage[]; inProgress: boolean; activeTurnId: string; turnIndexByTurnId: Record<string, number> },
  ): { activeTurnId: string; inProgress: boolean } {
    if (!threadId) return { activeTurnId: '', inProgress: false }

    const activeTurnId = detail.activeTurnId.trim()
    if (activeTurnId) {
      setActiveTurnForThread(threadId, activeTurnId)
      return { activeTurnId, inProgress: true }
    }

    if (detail.inProgress) {
      const cachedTurnId = activeTurnIdByThreadId.value[threadId]?.trim() ?? ''
      if (cachedTurnId) {
        setActiveTurnForThread(threadId, cachedTurnId)
        return { activeTurnId: cachedTurnId, inProgress: true }
      }
      ensureActiveTurnActivity(threadId)
      setThreadInProgress(threadId, true)
      return { activeTurnId: '', inProgress: true }
    }

    const cachedTurnId = activeTurnIdByThreadId.value[threadId]?.trim() ?? ''
    const detailHasCachedTurn = Boolean(cachedTurnId && detail.turnIndexByTurnId[cachedTurnId] !== undefined)
    if (cachedTurnId && !detailHasCachedTurn) {
      // thread/read can briefly lag behind turn/start. Preserve the local active
      // turn until a later read includes that turn as completed or interrupted.
      setActiveTurnForThread(threadId, cachedTurnId)
      return { activeTurnId: cachedTurnId, inProgress: true }
    }
    if (cachedTurnId && detailHasCachedTurn && !hasPersistedAssistantResultForTurn(detail.messages, cachedTurnId)) {
      // thread/read may include the freshly submitted user turn before the app-server
      // reports activeTurnId/inProgress. A user-only persisted turn is not terminal.
      setActiveTurnForThread(threadId, cachedTurnId)
      return { activeTurnId: cachedTurnId, inProgress: true }
    }

    clearActiveTurnForThread(threadId)
    return { activeTurnId: '', inProgress: false }
  }

  function markServerListedThreads(serverThreadIds: Set<string>): void {
    const pendingThreadIds = Object.keys(interruptBlockedUntilPersistedByThreadId.value)
    if (pendingThreadIds.length === 0) return

    let nextListedState = threadListedByServerById.value
    let changed = false
    for (const threadId of pendingThreadIds) {
      if (!serverThreadIds.has(threadId) || nextListedState[threadId] === true) continue
      nextListedState = {
        ...nextListedState,
        [threadId]: true,
      }
      changed = true
    }

    if (!changed) return
    threadListedByServerById.value = nextListedState
    for (const threadId of pendingThreadIds) {
      maybeUnblockInterruptForPersistedThread(threadId)
    }
  }

  function markThreadMessagesPersisted(threadId: string, messages: UiMessage[]): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (!messages.some((message) => message.role === 'user')) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) {
      persistedUserMessageByThreadId.value = {
        ...persistedUserMessageByThreadId.value,
        [threadId]: true,
      }
    }
    maybeUnblockInterruptForPersistedThread(threadId)
  }

  function markThreadUnreadByEvent(threadId: string): void {
    if (!threadId) return
    if (threadId === selectedThreadId.value) return
    if (eventUnreadByThreadId.value[threadId] === true) return
    eventUnreadByThreadId.value = {
      ...eventUnreadByThreadId.value,
      [threadId]: true,
    }
    applyThreadFlags()
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    if (!threadId) return

    const previous = turnActivityByThreadId.value[threadId]
    if (!activity) {
      if (previous) {
        turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, threadId)
      }
      return
    }

    const normalizedLabel = sanitizeDisplayText(activity.label) || 'Thinking'
    const incomingDetails = activity.details
      .map((line) => sanitizeDisplayText(line))
      .filter((line) => line.length > 0 && line !== normalizedLabel)
    const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)
    const nextActivity: TurnActivityState = {
      label: normalizedLabel,
      details: mergedDetails,
    }

    if (areTurnActivitiesEqual(previous, nextActivity)) return
    turnActivityByThreadId.value = {
      ...turnActivityByThreadId.value,
      [threadId]: nextActivity,
    }
  }

  function setTurnErrorForThread(
    threadId: string,
    message: string | null,
    options: { transient?: boolean } = {},
  ): void {
    if (!threadId) return

    const previous = turnErrorByThreadId.value[threadId]
    const normalizedMessage = message ? normalizeMessageText(message) : ''
    if (!normalizedMessage) {
      if (previous) {
        turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, threadId)
      }
      return
    }

    const transient = options.transient === true
    if (previous?.message === normalizedMessage && previous.transient === transient) return

    turnErrorByThreadId.value = {
      ...turnErrorByThreadId.value,
      [threadId]: { message: normalizedMessage, transient },
    }
  }

  function setThreadNoticeForThread(threadId: string, notice: ThreadNoticeState | null): void {
    if (!threadId) return

    const previous = threadNoticeByThreadId.value[threadId]
    if (!notice) {
      if (previous) {
        threadNoticeByThreadId.value = omitKey(threadNoticeByThreadId.value, threadId)
      }
      return
    }

    const nextNotice = {
      label: sanitizeDisplayText(notice.label) || 'Notice',
      text: notice.text.trim(),
    }
    if (previous?.label === nextNotice.label && previous.text === nextNotice.text) return
    threadNoticeByThreadId.value = {
      ...threadNoticeByThreadId.value,
      [threadId]: nextNotice,
    }
  }

  function clearTransientTurnErrorForThread(threadId: string): void {
    if (!threadId) return
    if (!turnErrorByThreadId.value[threadId]?.transient) return
    setTurnErrorForThread(threadId, null)
  }

  function clearAllTransientTurnErrors(): void {
    const transientThreadIds = Object.entries(turnErrorByThreadId.value)
      .filter(([, state]) => state?.transient)
      .map(([threadId]) => threadId)
    if (transientThreadIds.length === 0) return

    let nextState = turnErrorByThreadId.value
    for (const threadId of transientThreadIds) {
      nextState = omitKey(nextState, threadId)
    }
    turnErrorByThreadId.value = nextState
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function setThreadTerminalOpen(threadId: string, isOpen: boolean): void {
    if (!threadId) return
    const next = { ...terminalOpenByThreadId.value }
    if (isOpen) {
      next[threadId] = true
    } else {
      delete next[threadId]
    }
    terminalOpenByThreadId.value = next
    saveThreadTerminalOpenMap(next)
  }

  function toggleSelectedThreadTerminal(): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    setThreadTerminalOpen(threadId, !selectedThreadTerminalOpen.value)
  }

  function setFullHistoryMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    if (!threadId) return
    const previous = fullHistoryMessagesByThreadId.value[threadId] ?? []
    if (loadedFullHistoryByThreadId.value[threadId] === true && areMessageArraysEqual(previous, nextMessages)) return
    fullHistoryMessagesByThreadId.value = {
      ...fullHistoryMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
    loadedFullHistoryByThreadId.value = {
      ...loadedFullHistoryByThreadId.value,
      [threadId]: true,
    }
  }

  function mergePersistedMessagesIntoFullHistory(threadId: string, persistedMessages: UiMessage[]): void {
    if (!threadId || loadedFullHistoryByThreadId.value[threadId] !== true) return
    const previousFullHistory = fullHistoryMessagesByThreadId.value[threadId] ?? []
    const mergedFullHistory = mergeMessages(previousFullHistory, persistedMessages, { preserveMissing: true })
    setFullHistoryMessagesForThread(threadId, mergedFullHistory)
  }

  function invalidateFullHistoryForThread(threadId: string): void {
    if (!threadId) return
    if (
      !(threadId in fullHistoryMessagesByThreadId.value) &&
      !(threadId in loadedFullHistoryByThreadId.value) &&
      !(threadId in loadingFullHistoryByThreadId.value)
    ) {
      return
    }
    fullHistoryMessagesByThreadId.value = omitKey(fullHistoryMessagesByThreadId.value, threadId)
    loadedFullHistoryByThreadId.value = omitKey(loadedFullHistoryByThreadId.value, threadId)
    loadingFullHistoryByThreadId.value = omitKey(loadingFullHistoryByThreadId.value, threadId)
  }

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    persistedMessagesByThreadId.value = {
      ...persistedMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
    mergePersistedMessagesIntoFullHistory(threadId, nextMessages)
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveAgentMessagesByThreadId.value = {
      ...liveAgentMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function clearLiveAgentMessagesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveAgentMessagesByThreadId.value)) return
    liveAgentMessagesByThreadId.value = omitKey(liveAgentMessagesByThreadId.value, threadId)
  }

  function setLiveFileChangeMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setLiveToolCallMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveToolCallMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveToolCallMessagesByThreadId.value = {
      ...liveToolCallMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setLivePlanMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    livePlanMessagesByThreadId.value = {
      ...livePlanMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function upsertLivePlanMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLivePlanMessagesForThread(threadId, next)
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveAgentMessagesForThread(threadId, next)
  }

  function upsertLiveFileChangeMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveFileChangeMessagesForThread(threadId, next)
  }

  function upsertLiveToolCallMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveToolCallMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveToolCallMessagesForThread(threadId, next)
  }

  function setLiveReasoningText(threadId: string, text: string): void {
    if (!threadId) return
    const normalized = text.trim()
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    if (normalized.length === 0) {
      if (!previous) return
      liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
      return
    }
    if (previous === normalized) return
    liveReasoningTextByThreadId.value = {
      ...liveReasoningTextByThreadId.value,
      [threadId]: normalized,
    }
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    if (!threadId) return
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    setLiveReasoningText(threadId, `${previous}${delta}`)
  }

  function clearLiveReasoningForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveReasoningTextByThreadId.value)) return
    liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
  }

  function clearLivePlansForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in livePlanMessagesByThreadId.value)) return
    livePlanMessagesByThreadId.value = omitKey(livePlanMessagesByThreadId.value, threadId)
  }

  function clearLiveFileChangesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveFileChangeMessagesByThreadId.value)) return
    liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
  }

  function clearLiveToolCallsForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveToolCallMessagesByThreadId.value)) return
    liveToolCallMessagesByThreadId.value = omitKey(liveToolCallMessagesByThreadId.value, threadId)
  }

  function clearCompletedTurnLiveState(threadId: string): void {
    if (!threadId) return
    clearLivePlansForThread(threadId)
    clearLiveReasoningForThread(threadId)
    clearLiveToolCallsForThread(threadId)
    setTurnActivityForThread(threadId, null)
    if (threadId === selectedThreadId.value) {
      activeReasoningItemId = ''
    }
    if (liveCommandsByThreadId.value[threadId]) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    }
    if (activeTurnIdByThreadId.value[threadId]) {
      activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
    }
    if (activeTurnProviderIdByThreadId.value[threadId]) {
      activeTurnProviderIdByThreadId.value = omitKey(activeTurnProviderIdByThreadId.value, threadId)
    }
    clearPendingTurnRequest(threadId)
  }

  function normalizePlanStepStatus(value: unknown): UiPlanStep['status'] {
    if (value === 'completed') return 'completed'
    if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
    return 'pending'
  }

  function buildPlanMessageText(plan: UiPlanData): string {
    const lines: string[] = []
    if (plan.explanation?.trim()) {
      lines.push(plan.explanation.trim())
    }
    for (const step of plan.steps) {
      const marker = step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '
      lines.push(`- [${marker}] ${step.step}`)
    }
    return lines.join('\n').trim()
  }

  function readPlanUpdate(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'turn/plan/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const rawSteps = Array.isArray(params?.plan) ? params?.plan : []
    const steps: UiPlanStep[] = rawSteps
      .map((row) => asRecord(row))
      .map((row) => ({
        step: readString(row?.step),
        status: normalizePlanStepStatus(row?.status),
      }))
      .filter((row) => row.step.length > 0)

    if (!threadId || !turnId) return null

    const explanation = readString(params?.explanation).trim()
    const plan: UiPlanData = {
      explanation: explanation || undefined,
      steps,
      isStreaming: true,
    }

    return {
      threadId,
      message: {
        id: `${turnId}:plan`,
        role: 'assistant',
        text: buildPlanMessageText(plan),
        messageType: 'plan.live',
        plan,
      },
    }
  }

  function readPlanDelta(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'item/plan/delta') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const delta = readString(params?.delta)
    if (!threadId || !turnId || !delta) return null

    const messageId = `${turnId}:plan`
    const existing = (livePlanMessagesByThreadId.value[threadId] ?? []).find((message) => message.id === messageId)
    const nextText = `${existing?.text ?? ''}${delta}`
    const nextPlan: UiPlanData | undefined = existing?.plan
      ? { ...existing.plan, isStreaming: true }
      : undefined

    return {
      threadId,
      message: {
        id: messageId,
        role: 'assistant',
        text: nextText,
        messageType: 'plan.live',
        plan: nextPlan,
      },
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  function readString(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  function normalizeThreadGoal(value: unknown): ThreadGoal | null {
    const record = asRecord(value)
    if (!record) return null
    const threadId = readString(record.threadId ?? record.thread_id)
    const objective = readString(record.objective)
    const status = readString(record.status) as ThreadGoalStatus
    const tokensUsed = readNumber(record.tokensUsed ?? record.tokens_used)
    const timeUsedSeconds = readNumber(record.timeUsedSeconds ?? record.time_used_seconds)
    const createdAt = readNumber(record.createdAt ?? record.created_at)
    const updatedAt = readNumber(record.updatedAt ?? record.updated_at)
    if (
      !threadId ||
      !objective ||
      !['active', 'paused', 'budgetLimited', 'complete'].includes(status) ||
      tokensUsed === null ||
      timeUsedSeconds === null ||
      createdAt === null ||
      updatedAt === null
    ) {
      return null
    }
    return {
      threadId,
      objective,
      status,
      tokenBudget: readNumber(record.tokenBudget ?? record.token_budget),
      tokensUsed,
      timeUsedSeconds,
      createdAt,
      updatedAt,
    }
  }

  function getRateLimitSnapshotKey(snapshot: UiRateLimitSnapshot): string {
    return snapshot.limitId?.trim() || snapshot.limitName?.trim() || '__default__'
  }

  function normalizeRateLimitWindow(value: unknown): UiRateLimitSnapshot['primary'] {
    const record = asRecord(value)
    if (!record) return null

    const windowValue = readNumber(record.windowDurationMins)
    return {
      usedPercent: clamp(readNumber(record.usedPercent) ?? 0, 0, 100),
      windowDurationMins: windowValue,
      windowMinutes: windowValue,
      resetsAt: readNumber(record.resetsAt),
    }
  }

  function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
    const record = asRecord(value)
    if (!record) return null

    const credits = asRecord(record.credits)
    return {
      limitId: readString(record.limitId) || null,
      limitName: readString(record.limitName) || null,
      primary: normalizeRateLimitWindow(record.primary),
      secondary: normalizeRateLimitWindow(record.secondary),
      credits: credits
        ? {
            hasCredits: credits.hasCredits === true,
            unlimited: credits.unlimited === true,
            balance: readString(credits.balance) || null,
          }
        : null,
      planType: readString(record.planType) || null,
    }
  }

  function normalizeRateLimitSnapshotsPayload(value: unknown): UiRateLimitSnapshot[] {
    const record = asRecord(value)
    if (!record) return []

    const next: UiRateLimitSnapshot[] = []
    const seen = new Set<string>()
    const pushSnapshot = (snapshot: UiRateLimitSnapshot | null): void => {
      if (!snapshot) return
      const key = getRateLimitSnapshotKey(snapshot)
      if (seen.has(key)) return
      seen.add(key)
      next.push(snapshot)
    }

    pushSnapshot(normalizeRateLimitSnapshot(record.rateLimits))

    const byLimitId = asRecord(record.rateLimitsByLimitId)
    if (byLimitId) {
      for (const snapshot of Object.values(byLimitId)) {
        pushSnapshot(normalizeRateLimitSnapshot(snapshot))
      }
    }

    return next
  }

  function normalizeTokenUsageBreakdown(value: unknown): UiTokenUsageBreakdown | null {
    const record = asRecord(value)
    if (!record) return null

    const totalTokens = readNumber(record.totalTokens ?? record.total_tokens)
    const inputTokens = readNumber(record.inputTokens ?? record.input_tokens)
    const cachedInputTokens = readNumber(record.cachedInputTokens ?? record.cached_input_tokens)
    const outputTokens = readNumber(record.outputTokens ?? record.output_tokens)
    const reasoningOutputTokens = readNumber(record.reasoningOutputTokens ?? record.reasoning_output_tokens)
    if (
      totalTokens === null ||
      inputTokens === null ||
      cachedInputTokens === null ||
      outputTokens === null ||
      reasoningOutputTokens === null
    ) {
      return null
    }

    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    }
  }

  function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
    const record = asRecord(value)
    if (!record) return null

    const total = normalizeTokenUsageBreakdown(record.total)
    const last = normalizeTokenUsageBreakdown(record.last)
    if (!total || !last) return null

    const modelContextWindow = readNumber(record.modelContextWindow ?? record.model_context_window)
    const currentContextTokens = last.totalTokens
    const remainingContextTokens = typeof modelContextWindow === 'number'
      ? Math.max(modelContextWindow - currentContextTokens, 0)
      : null
    const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
      ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
      : null

    return {
      total,
      last,
      modelContextWindow,
      currentContextTokens,
      remainingContextTokens,
      remainingContextPercent,
    }
  }

  function readThreadTokenUsageUpdate(notification: RpcNotification): { threadId: string; usage: UiThreadTokenUsage } | null {
    if (notification.method !== 'thread/tokenUsage/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const usage = normalizeThreadTokenUsage(params?.tokenUsage ?? params?.token_usage)
    if (!threadId || !usage) return null
    return { threadId, usage }
  }

  function extractThreadIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directThreadId = readString(params.threadId)
    if (directThreadId) return directThreadId
    const snakeThreadId = readString(params.thread_id)
    if (snakeThreadId) return snakeThreadId

    const conversationId = readString(params.conversationId)
    if (conversationId) return conversationId
    const snakeConversationId = readString(params.conversation_id)
    if (snakeConversationId) return snakeConversationId

    const thread = asRecord(params.thread)
    const nestedThreadId = readString(thread?.id)
    if (nestedThreadId) return nestedThreadId

    const turn = asRecord(params.turn)
    const turnThreadId = readString(turn?.threadId)
    if (turnThreadId) return turnThreadId
    const turnSnakeThreadId = readString(turn?.thread_id)
    if (turnSnakeThreadId) return turnSnakeThreadId

    return ''
  }

  function readTurnErrorMessage(notification: RpcNotification): string {
    if (notification.method !== 'turn/completed') return ''
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    if (!turn || turn.status !== 'failed') return ''
    const errorPayload = asRecord(turn.error)
    return readString(errorPayload?.message)
  }

  function readNotificationErrorState(notification: RpcNotification): { message: string; transient: boolean } | null {
    if (notification.method !== 'error') return null
    const params = asRecord(notification.params)
    const message = (
      readString(params?.message) ||
      readString(asRecord(params?.error)?.message)
    )
    if (!message) return null

    return {
      message,
      transient: params?.willRetry === true,
    }
  }

  function normalizeServerRequest(params: unknown): UiServerRequest | null {
    const row = asRecord(params)
    if (!row) return null

    const id = row.id
    const rawMethod = readString(row.method)
    const requestParams = row.params
    if (typeof id !== 'number' || !Number.isInteger(id) || !rawMethod) {
      return null
    }

    const requestParamRecord = asRecord(requestParams)
    const method = normalizePendingServerRequestMethod(rawMethod, requestParamRecord)
    const threadId = (
      readString(requestParamRecord?.threadId) ||
      readString(requestParamRecord?.thread_id) ||
      readString(requestParamRecord?.conversationId) ||
      readString(requestParamRecord?.conversation_id) ||
      GLOBAL_SERVER_REQUEST_SCOPE
    )
    const turnId = readString(requestParamRecord?.turnId) || readString(requestParamRecord?.turn_id)
    const itemId = (
      readString(requestParamRecord?.itemId) ||
      readString(requestParamRecord?.item_id) ||
      readString(requestParamRecord?.callId) ||
      readString(requestParamRecord?.call_id)
    )
    const receivedAtIso = readString(row.receivedAtIso) || new Date().toISOString()

    return {
      id,
      method,
      threadId,
      turnId,
      itemId,
      receivedAtIso,
      params: requestParams ?? null,
    }
  }

  function normalizePendingServerRequestMethod(
    method: string,
    params: Record<string, unknown> | null,
  ): string {
    const normalized = method.trim()
    if (!normalized) return normalized

    if (
      normalized === 'item/commandExecution/requestApproval' ||
      normalized === 'execCommandApproval' ||
      normalized === 'exec_approval_request' ||
      looksLikeExecApprovalRequest(params)
    ) {
      return 'item/commandExecution/requestApproval'
    }

    if (
      normalized === 'item/fileChange/requestApproval' ||
      normalized === 'applyPatchApproval' ||
      normalized === 'apply_patch_approval_request' ||
      looksLikePatchApprovalRequest(params)
    ) {
      return 'item/fileChange/requestApproval'
    }

    if (
      normalized === 'item/tool/requestUserInput' ||
      normalized === 'request_user_input' ||
      looksLikeToolUserInputRequest(params)
    ) {
      return 'item/tool/requestUserInput'
    }

    if (
      normalized === 'mcpServer/elicitation/request' ||
      normalized === 'elicitation_request' ||
      looksLikeMcpServerElicitationRequest(params)
    ) {
      return 'mcpServer/elicitation/request'
    }

    if (normalized === 'item/permissions/requestApproval' || looksLikePermissionsApprovalRequest(params)) {
      return 'item/permissions/requestApproval'
    }

    if (
      normalized === 'item/tool/call' ||
      normalized === 'dynamic_tool_call_request' ||
      looksLikeToolCallRequest(params)
    ) {
      return 'item/tool/call'
    }

    return normalized
  }

  function looksLikeExecApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const command = params.command
    if (Array.isArray(command) && command.some((part) => typeof part === 'string' && part.trim().length > 0)) {
      return true
    }
    if (typeof command === 'string' && command.trim().length > 0) {
      return true
    }
    return Array.isArray(params.commandActions)
  }

  function looksLikePatchApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    if (typeof params.grantRoot === 'string' && params.grantRoot.trim().length > 0) return true
    if (typeof params.grant_root === 'string' && params.grant_root.trim().length > 0) return true
    if (asRecord(params.fileChanges)) return true
    return asRecord(params.changes) !== null
  }

  function looksLikeToolUserInputRequest(params: Record<string, unknown> | null): boolean {
    return Boolean(params && Array.isArray(params.questions))
  }

  function looksLikeToolCallRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.toolName === 'string' ||
      typeof params.tool_name === 'string' ||
      typeof params.name === 'string' ||
      Array.isArray(params.arguments)
    )
  }

  function looksLikeMcpServerElicitationRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const mode = readString(params.mode)
    return (
      typeof params.serverName === 'string' &&
      typeof params.threadId === 'string' &&
      typeof params.message === 'string' &&
      (mode === 'form' || mode === 'url')
    )
  }

  function looksLikePermissionsApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.itemId === 'string' &&
      asRecord(params.permissions) !== null
    )
  }

  function readToolRequestUserInputQuestionIds(request: UiServerRequest): string[] {
    if (request.method !== 'item/tool/requestUserInput') return []
    const params = asRecord(request.params)
    const questions = Array.isArray(params?.questions) ? params.questions : []
    const questionIds: string[] = []

    for (const row of questions) {
      const question = asRecord(row)
      const id = readString(question?.id).trim()
      if (id) {
        questionIds.push(id)
      }
    }

    return questionIds
  }

  function upsertPendingServerRequest(request: UiServerRequest): void {
    const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
    const current = pendingServerRequestsByThreadId.value[threadId] ?? []
    const index = current.findIndex((row) => row.id === request.id)
    const nextRows = [...current]
    if (index >= 0) {
      nextRows.splice(index, 1, request)
    } else {
      nextRows.push(request)
    }

    pendingServerRequestsByThreadId.value = {
      ...pendingServerRequestsByThreadId.value,
      [threadId]: nextRows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso)),
    }
    applyThreadFlags()
  }

  function removePendingServerRequestById(requestId: number): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      const filtered = requests.filter((request) => request.id !== requestId)
      if (filtered.length > 0) {
        next[threadId] = filtered
      }
    }
    pendingServerRequestsByThreadId.value = next
    applyThreadFlags()
  }

  function replacePendingServerRequests(requests: UiServerRequest[]): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const request of requests) {
      const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
      const current = next[threadId] ?? []
      current.push(request)
      next[threadId] = current
    }

    for (const rows of Object.values(next)) {
      rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
    }

    pendingServerRequestsByThreadId.value = next
  }

  function handleServerRequestNotification(notification: RpcNotification): boolean {
    if (notification.method === 'server/request') {
      const request = normalizeServerRequest(notification.params)
      if (!request) return true
      upsertPendingServerRequest(request)
      return true
    }

    if (notification.method === 'server/request/resolved') {
      const row = asRecord(notification.params)
      const id = row?.id
      if (typeof id === 'number' && Number.isInteger(id)) {
        removePendingServerRequestById(id)
      }
      return true
    }

    return false
  }

  function sanitizeDisplayText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim()
  }

  function readTurnActivity(notification: RpcNotification): { threadId: string; activity: TurnActivityState } | null {
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    if (notification.method === 'turn/started') {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/started') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const itemType = readString(item?.type).toLowerCase()
      if (itemType === 'reasoning') {
        return {
          threadId,
          activity: {
            label: 'Thinking',
            details: [],
          },
        }
      }
      if (itemType === 'agentmessage') {
        return {
          threadId,
          activity: {
            label: 'Writing response',
            details: [],
          },
        }
      }
      if (itemType === 'commandexecution') {
        const cmd = readString(item?.command)
        return {
          threadId,
          activity: {
            label: 'Running command',
            details: cmd ? [cmd] : [],
          },
        }
      }
      if (itemType === 'filechange') {
        const changes = Array.isArray(item?.changes) ? item.changes : []
        const firstChange = changes[0] as Record<string, unknown> | undefined
        const path = readString(firstChange?.path)
        return {
          threadId,
          activity: {
            label: 'Applying changes',
            details: path ? [path] : [],
          },
        }
      }
      if (itemType === 'mcptoolcall') {
        const server = readString(item?.server)
        const tool = readString(item?.tool)
        return {
          threadId,
          activity: {
            label: 'Running tool',
            details: [server, tool].filter((value) => value.length > 0),
          },
        }
      }
      if (itemType === 'collabagenttoolcall') {
        const tool = readString(item?.tool)
        return {
          threadId,
          activity: {
            label: 'Running agent tool',
            details: tool ? [tool] : [],
          },
        }
      }
      if (itemType === 'websearch') {
        const query = readString(item?.query)
        return {
          threadId,
          activity: {
            label: 'Searching web',
            details: query ? [query] : [],
          },
        }
      }
    }

    if (notification.method === 'item/mcpToolCall/progress') {
      const params = asRecord(notification.params)
      const message = readString(params?.message)
      return {
        threadId,
        activity: {
          label: 'Running tool',
          details: message ? [message] : [],
        },
      }
    }

    if (notification.method === 'item/commandExecution/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Running command',
          details: [],
        },
      }
    }

    if (notification.method === 'item/fileChange/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Applying changes',
          details: [],
        },
      }
    }

    if (
      notification.method === 'item/reasoning/summaryTextDelta' ||
      notification.method === 'item/reasoning/summaryPartAdded' ||
      notification.method === 'item/reasoning/textDelta'
    ) {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/agentMessage/delta') {
      return {
        threadId,
        activity: {
          label: 'Writing response',
          details: [],
        },
      }
    }

    return null
  }

  function readStatusType(value: unknown): string {
    if (typeof value === 'string') return value.trim().toLowerCase()
    const record = asRecord(value)
    return readString(record?.type).trim().toLowerCase()
  }

  function isRunningStatusType(value: string): boolean {
    return value === 'inprogress' || value === 'in_progress' || value === 'running' || value === 'active'
  }

  function isIdleStatusType(value: string): boolean {
    return value === 'idle' || value === 'completed' || value === 'interrupted' || value === 'failed'
  }

  function readStatusChangeTurnId(params: Record<string, unknown>): string {
    const status = asRecord(params.status)
    const thread = asRecord(params.thread)
    const threadStatus = asRecord(thread?.status)
    return (
      readString(params.turnId) ||
      readString(params.turn_id) ||
      readString(params.activeTurnId) ||
      readString(params.active_turn_id) ||
      readString(params.currentTurnId) ||
      readString(params.current_turn_id) ||
      readString(status?.turnId) ||
      readString(status?.turn_id) ||
      readString(status?.activeTurnId) ||
      readString(status?.active_turn_id) ||
      readString(status?.currentTurnId) ||
      readString(status?.current_turn_id) ||
      readString(threadStatus?.turnId) ||
      readString(threadStatus?.turn_id) ||
      readString(threadStatus?.activeTurnId) ||
      readString(threadStatus?.active_turn_id) ||
      readString(threadStatus?.currentTurnId) ||
      readString(threadStatus?.current_turn_id)
    ).trim()
  }

  function readNotificationTurnId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''
    const turn = asRecord(params.turn)
    const item = asRecord(params.item)
    return (
      readString(params.turnId) ||
      readString(params.turn_id) ||
      readString(params.activeTurnId) ||
      readString(params.active_turn_id) ||
      readString(turn?.id) ||
      readString(turn?.turnId) ||
      readString(turn?.turn_id) ||
      readString(item?.turnId) ||
      readString(item?.turn_id)
    ).trim()
  }

  function readStatusChangeThreadId(notification: RpcNotification, params: Record<string, unknown>): string {
    const threadId = extractThreadIdFromNotification(notification)
    if (threadId) return threadId

    const status = asRecord(params.status)
    const threadStatus = asRecord(params.threadStatus) ?? asRecord(params.thread_status)
    return (
      readString(status?.threadId) ||
      readString(status?.thread_id) ||
      readString(threadStatus?.threadId) ||
      readString(threadStatus?.thread_id)
    ).trim()
  }

  function readThreadStatusChange(notification: RpcNotification): { threadId: string; statusType: string; turnId: string } | null {
    if (notification.method !== 'thread/status/changed') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = readStatusChangeThreadId(notification, params)
    if (!threadId) return null

    const thread = asRecord(params.thread)
    const statusType = (
      readStatusType(params.status) ||
      readStatusType(params.threadStatus) ||
      readStatusType(params.thread_status) ||
      readStatusType(thread?.status) ||
      (params.inProgress === true ? 'inprogress' : '')
    )
    if (!statusType) return null

    return {
      threadId,
      statusType,
      turnId: readStatusChangeTurnId(params),
    }
  }

  function readTurnStartedInfo(notification: RpcNotification): TurnStartedInfo | null {
    if (notification.method !== 'turn/started') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    return {
      threadId,
      turnId,
      startedAtMs,
    }
  }

  function readTurnCompletedInfo(notification: RpcNotification): TurnCompletedInfo | null {
    if (notification.method !== 'turn/completed') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const completedAtMs =
      parseIsoTimestamp(readString(turnPayload?.completedAt)) ??
      parseIsoTimestamp(readString(params.completedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      undefined

    return {
      threadId,
      turnId,
      completedAtMs,
      startedAtMs,
    }
  }

  function liveReasoningMessageId(reasoningItemId: string): string {
    return `${reasoningItemId}:live-reasoning`
  }

  function inferNextTurnIndex(threadId: string): number {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    let maxTurnIndex = -1
    for (const message of persisted) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        maxTurnIndex = Math.max(maxTurnIndex, message.turnIndex)
      }
    }
    return maxTurnIndex + 1
  }

  function setTurnIndexForThread(threadId: string, turnId: string, turnIndex: number): void {
    if (!threadId || !turnId || !Number.isInteger(turnIndex) || turnIndex < 0) return
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    if (previous[turnId] === turnIndex) return
    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: {
        ...previous,
        [turnId]: turnIndex,
      },
    }
  }

  function replaceTurnIndexLookupForThread(threadId: string, nextLookup: Record<string, number>): void {
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    const previousEntries = Object.entries(previous)
    const nextEntries = Object.entries(nextLookup)
    if (
      previousEntries.length === nextEntries.length
      && previousEntries.every(([turnId, turnIndex]) => nextLookup[turnId] === turnIndex)
    ) {
      return
    }

    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: { ...nextLookup },
    }
  }

  function rebindLiveFileChangeTurnIndices(threadId: string): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return

    const turnIndexByTurnId = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    let changed = false
    const next = current.map((message) => {
      if (typeof message.turnIndex === 'number' || !message.turnId) {
        return message
      }
      const turnIndex = turnIndexByTurnId[message.turnId]
      if (typeof turnIndex !== 'number') return message
      changed = true
      return { ...message, turnIndex }
    })

    if (!changed) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: next,
    }
  }

  function readReasoningStartedItemId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return readString(item.id)
    }

    return ''
  }

  function readReasoningDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический источник дельт для UI — уже нормализованный item/*.
    if (notification.method === 'item/reasoning/summaryTextDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    // codex also emits the full reasoning-chain stream as item/reasoning/textDelta
    // (alongside the summary stream). Without handling it, reasoning text the
    // model streams via this channel is dropped and the UI shows only the
    // summary, making long thinking phases look like a stall.
    if (notification.method === 'item/reasoning/textDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    return null
  }

  function readReasoningSectionBreakMessageId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    // Канонический source для section break — item/*
    if (notification.method === 'item/reasoning/summaryPartAdded') {
      const itemId = readString(params.itemId)
      if (!itemId) return ''
      return liveReasoningMessageId(itemId)
    }

    return ''
  }

  function readReasoningCompletedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return liveReasoningMessageId(readString(item.id))
    }

    return ''
  }

  function readAgentMessageStartedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return ''
      return readString(item.id)
    }

    return ''
  }

  function readAgentMessageDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический live-канал агентского текста.
    if (notification.method === 'item/agentMessage/delta') {
      const messageId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!messageId || !delta) return null
      return { messageId, delta }
    }

    return null
  }

  function readAgentMessageCompleted(notification: RpcNotification): { message: UiMessage; sourceItemId: string; sourceText: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return null
      const id = readString(item.id)
      const text = readString(item.text)
      if (!id || !text) return null
      const cursorToolMessage = parseCursorToolMessage(id, text, { includeInProgress: true })
      if (cursorToolMessage) {
        return { message: cursorToolMessage, sourceItemId: id, sourceText: text }
      }
      if (isIncompleteCursorToolCallText(text)) return null
      return {
        message: {
          id,
          role: 'assistant',
          text,
          messageType: 'agentMessage.live',
        },
        sourceItemId: id,
        sourceText: text,
      }
    }

    return null
  }

  function toLocalImageUrl(path: string): string {
    return `/codex-local-image?path=${encodeURIComponent(path)}`
  }

  function toImageGenerationUrl(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (
      trimmed.startsWith('data:') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/codex-local-image?')
    ) {
      return trimmed
    }
    const compact = trimmed.replace(/\s+/gu, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return ''
    return `data:image/png;base64,${compact}`
  }

  function readCompletedImageView(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return null
    const id = readString(item.id)
    if (!id) return null
    if (item.type === 'imageView') {
      const path = readString(item.path)
      if (!path) return null
      return {
        id,
        role: 'assistant',
        text: '',
        images: [toLocalImageUrl(path)],
        messageType: 'imageView',
      }
    }
    if (item.type !== 'imageGeneration' && item.type !== 'image_generation') return null
    const result = readString(item.result)
    const imageUrl = result ? toImageGenerationUrl(result) : ''
    if (!imageUrl) return null
    return {
      id,
      role: 'assistant',
      text: '',
      images: [imageUrl],
      messageType: 'imageView',

    }
  }

  function readCommandExecutionStarted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCommandOutputDelta(notification: RpcNotification): { itemId: string; delta: string } | null {
    if (notification.method !== 'item/commandExecution/outputDelta') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const itemId = readString(params.itemId)
    const delta = readString(params.delta)
    if (!itemId || !delta) return null
    return { itemId, delta }
  }

  function readCommandExecutionCompleted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const statusRaw = readString(item.status)
    const status: CommandExecutionData['status'] =
      statusRaw === 'failed' ? 'failed' : statusRaw === 'declined' ? 'declined' : statusRaw === 'interrupted' ? 'interrupted' : 'completed'
    const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: { command, cwd, status, aggregatedOutput, exitCode },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCompletedFileChange(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'fileChange') return null
    const id = readString(item.id)
    if (!id) return null
    const threadId = readString(params?.threadId)
    const turnId = readString(params?.turnId)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined

    const fileChanges = toUiFileChanges(item.changes)
    const fileChangeStatus = normalizeFileChangeStatus(item.status)
    if (fileChanges.length === 0 || fileChangeStatus !== 'completed') return null

    return {
      id,
      role: 'system',
      text: '',
      messageType: 'fileChange',
      fileChangeStatus,
      fileChanges,
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readToolCallItemMessage(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    const message = toUiToolCallMessage(item)
    if (!message) return null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    const normalizedMessage = notification.method === 'item/started' && message.toolCall?.status === 'completed'
      ? createToolCallMessage(message.id, { ...message.toolCall, status: 'inProgress' })
      : message
    return {
      ...normalizedMessage,
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readMcpToolCallProgress(notification: RpcNotification): { itemId: string; message: string } | null {
    if (notification.method !== 'item/mcpToolCall/progress') return null
    const params = asRecord(notification.params)
    const itemId = readString(params?.itemId) || readString(params?.item_id)
    const message = readString(params?.message)
    if (!itemId || !message) return null
    return { itemId, message }
  }

  function createProgressOnlyToolCallMessage(itemId: string, progress: string): UiMessage {
    const toolCall: UiToolCallData = {
      kind: 'mcp',
      title: 'MCP tool call',
      name: 'mcpToolCall',
      status: 'inProgress',
      server: null,
      input: '',
      output: '',
      error: '',
      progress,
      durationMs: null,
      meta: [],
    }
    return createToolCallMessage(itemId, toolCall)
  }

  function createToolCallMessage(itemId: string, toolCall: UiToolCallData): UiMessage {
    const lines = [`${toolCall.title} (${toolCall.status})`]
    if (toolCall.meta.length > 0) lines.push(toolCall.meta.join(' | '))
    if (toolCall.progress) lines.push('', 'Progress:', toolCall.progress)
    if (toolCall.input) lines.push('', 'Input:', toolCall.input)
    if (toolCall.output) lines.push('', 'Output:', toolCall.output)
    if (toolCall.error) lines.push('', 'Error:', toolCall.error)
    return {
      id: itemId,
      role: 'system',
      text: lines.join('\n'),
      messageType: 'toolCall',
      toolCall,
    }
  }

  function upsertLiveCommand(threadId: string, msg: UiMessage): void {
    const previous = liveCommandsByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, msg)
    if (next === previous) return
    liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
  }

  function removeLiveCommandsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveCommandsByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((m) => m.id))
    const next = current.filter((m) => !persistedIds.has(m.id))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    } else {
      liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
    }
  }

  function removeLiveFileChangesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((message) => message.id))
    const persistedTurnIds = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnId === 'string' && message.turnId.length > 0)
        .map((message) => message.turnId as string),
    )
    const persistedTurnIndices = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnIndex === 'number')
        .map((message) => message.turnIndex as number),
    )
    const next = current.filter((message) => (
      !persistedIds.has(message.id)
      && !(message.turnId && persistedTurnIds.has(message.turnId))
      && !(typeof message.turnIndex === 'number' && persistedTurnIndices.has(message.turnIndex))
    ))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
    } else {
      liveFileChangeMessagesByThreadId.value = { ...liveFileChangeMessagesByThreadId.value, [threadId]: next }
    }
  }

  function removeLiveToolCallsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveToolCallMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((message) => message.id))
    const next = current.filter((message) => !persistedIds.has(message.id))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveToolCallMessagesByThreadId.value = omitKey(liveToolCallMessagesByThreadId.value, threadId)
    } else {
      liveToolCallMessagesByThreadId.value = { ...liveToolCallMessagesByThreadId.value, [threadId]: next }
    }
  }

  function isAgentContentEvent(notification: RpcNotification): boolean {
    if (notification.method === 'item/agentMessage/delta') {
      return true
    }

    const params = asRecord(notification.params)
    if (!params) return false

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      return item?.type === 'agentMessage'
    }

    return false
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
    if (handleServerRequestNotification(notification)) {
      return
    }

    if (notification.method === 'account/rateLimits/updated') {
      scheduleRateLimitRefresh()
    }

    if (notification.method === 'thread/name/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const threadName = readString(params?.threadName)
      if (threadId && threadName) {
        threadTitleById.value = { ...threadTitleById.value, [threadId]: threadName }
        applyThreadFlags()
        void persistThreadTitle(threadId, threadName)
      }
    }

    if (notification.method === 'thread/goal/updated') {
      const params = asRecord(notification.params)
      const threadId = extractThreadIdFromNotification(notification)
      const goal = normalizeThreadGoal(params?.goal)
      if (threadId && goal) {
        setThreadNoticeForThread(threadId, goalNoticeForGoal(goal))
      }
    }

    if (notification.method === 'thread/goal/cleared') {
      const threadId = extractThreadIdFromNotification(notification)
      if (threadId) {
        setThreadNoticeForThread(threadId, null)
      }
    }

    if (notification.method === 'account/rateLimits/updated') {
      setCodexRateLimit(pickCodexRateLimitSnapshot(notification.params))
      return
    }

    const statusChange = readThreadStatusChange(notification)
    if (statusChange) {
      if (isRunningStatusType(statusChange.statusType)) {
        if (statusChange.turnId) {
          setActiveTurnForThread(statusChange.threadId, statusChange.turnId)
        } else {
          ensureActiveTurnActivity(statusChange.threadId)
          setThreadInProgress(statusChange.threadId, true)
        }
        if (eventUnreadByThreadId.value[statusChange.threadId]) {
          eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, statusChange.threadId)
        }
      } else if (isIdleStatusType(statusChange.statusType)) {
        clearActiveTurnForThread(statusChange.threadId)
        setTurnActivityForThread(statusChange.threadId, null)
        setTurnErrorForThread(statusChange.threadId, null)
        pendingThreadMessageRefresh.add(statusChange.threadId)
        pendingThreadsRefresh = true
      }
    }

    const tokenUsageUpdate = readThreadTokenUsageUpdate(notification)
    if (tokenUsageUpdate) {
      setThreadTokenUsage(tokenUsageUpdate.threadId, tokenUsageUpdate.usage)
      return
    }

    const turnActivity = readTurnActivity(notification)
    if (turnActivity) {
      setTurnActivityForThread(turnActivity.threadId, turnActivity.activity)
      const turnId = readNotificationTurnId(notification)
      if (turnId) {
        setActiveTurnForThread(turnActivity.threadId, turnId)
      } else {
        setThreadInProgress(turnActivity.threadId, true)
      }
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    const notificationErrorState = readNotificationErrorState(notification)
    if (!notificationErrorState && notificationThreadId) {
      clearTransientTurnErrorForThread(notificationThreadId)
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn) {
      pendingTurnStartsById.set(startedTurn.turnId, startedTurn)
      setTurnIndexForThread(startedTurn.threadId, startedTurn.turnId, inferNextTurnIndex(startedTurn.threadId))
      setActiveTurnForThread(startedTurn.threadId, startedTurn.turnId)
      clearLivePlansForThread(startedTurn.threadId)
      clearLiveFileChangesForThread(startedTurn.threadId)
      setTurnSummaryForThread(startedTurn.threadId, null)
      setTurnErrorForThread(startedTurn.threadId, null)
      scheduleQueueStateRefresh(startedTurn.threadId)
      if (eventUnreadByThreadId.value[startedTurn.threadId]) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, startedTurn.threadId)
      }
    }

    const completedTurn = readTurnCompletedInfo(notification)
    const turnErrorMessage = readTurnErrorMessage(notification)
    const completedThreadId = completedTurn?.threadId ?? extractThreadIdFromNotification(notification)
    const completedThreadModelId = completedThreadId ? readModelIdForThread(completedThreadId) : ''
    const shouldRetryWithFallback =
      Boolean(completedThreadId) &&
      Boolean(turnErrorMessage) &&
      completedThreadModelId !== MODEL_FALLBACK_ID &&
      isUnsupportedChatGptModelError(new Error(turnErrorMessage))
    if (completedTurn) {
      const pendingTurnRequest = pendingTurnRequestByThreadId.value[completedTurn.threadId]
      const startedTurnState = pendingTurnStartsById.get(completedTurn.turnId)
      if (startedTurnState) {
        pendingTurnStartsById.delete(completedTurn.turnId)
      }

      const rawDurationMs =
        readNumber(asRecord(notification.params)?.durationMs) ??
        readNumber(asRecord(asRecord(notification.params)?.turn)?.durationMs) ??
        (typeof completedTurn.startedAtMs === 'number'
          ? completedTurn.completedAtMs - completedTurn.startedAtMs
          : null) ??
        (startedTurnState ? completedTurn.completedAtMs - startedTurnState.startedAtMs : null)

      const durationMs = typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : 0
      setTurnSummaryForThread(completedTurn.threadId, {
        turnId: completedTurn.turnId,
        durationMs,
      })
      if (activeTurnIdByThreadId.value[completedTurn.threadId]) {
        activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, completedTurn.threadId)
      }
      if (activeTurnProviderIdByThreadId.value[completedTurn.threadId]) {
        activeTurnProviderIdByThreadId.value = omitKey(activeTurnProviderIdByThreadId.value, completedTurn.threadId)
      }
      setThreadInProgress(completedTurn.threadId, false)
      setTurnActivityForThread(completedTurn.threadId, null)
      markThreadUnreadByEvent(completedTurn.threadId)
      if (!shouldRetryWithFallback) {
        clearPendingTurnRequest(completedTurn.threadId)
        scheduleQueueStateRefresh(completedTurn.threadId)
      }
    }

    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (failedThreadId) {
        setTurnErrorForThread(failedThreadId, turnErrorMessage)
      }
      error.value = turnErrorMessage
      if (failedThreadId && shouldRetryWithFallback) {
        void retryPendingTurnWithFallback(failedThreadId)
      }
    } else if (completedTurn) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    if (notificationErrorState) {
      const errorThreadId = notificationThreadId
      const errorThreadModelId = errorThreadId ? readModelIdForThread(errorThreadId) : selectedModelId.value.trim()
      if (errorThreadId) {
        setTurnErrorForThread(errorThreadId, notificationErrorState.message, {
          transient: notificationErrorState.transient,
        })
      }
      error.value = notificationErrorState.message
      if (errorThreadModelId !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(new Error(notificationErrorState.message))) {
        if (errorThreadId) {
          void retryPendingTurnWithFallback(errorThreadId)
        } else {
          void applyFallbackModelSelection()
        }
      }
    }

    const planUpdate = readPlanUpdate(notification)
    if (planUpdate) {
      upsertLivePlanMessage(planUpdate.threadId, planUpdate.message)
      setTurnActivityForThread(planUpdate.threadId, {
        label: 'Planning',
        details: planUpdate.message.plan?.steps.map((step) => step.step).slice(0, 2) ?? [],
      })
    }

    const planDelta = readPlanDelta(notification)
    if (planDelta) {
      upsertLivePlanMessage(planDelta.threadId, planDelta.message)
      setTurnActivityForThread(planDelta.threadId, {
        label: 'Planning',
        details: [],
      })
    }

    if (!notificationThreadId || notificationThreadId !== selectedThreadId.value) return

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemId = ''
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta) {
      const existing = (liveAgentMessagesByThreadId.value[notificationThreadId] ?? [])
        .find((message) => message.id === liveAgentMessageDelta.messageId)
      const nextText = `${existing?.text ?? ''}${liveAgentMessageDelta.delta}`
      if (isCursorToolCallText(nextText)) {
        const next = removeLiveAgentMessagesByIds(
          liveAgentMessagesByThreadId.value[notificationThreadId] ?? [],
          new Set([liveAgentMessageDelta.messageId]),
        )
        setLiveAgentMessagesForThread(notificationThreadId, next)
      } else {
        upsertLiveAgentMessage(notificationThreadId, {
          id: liveAgentMessageDelta.messageId,
          role: 'assistant',
          text: nextText,
          messageType: 'agentMessage.live',
        })
      }
    }

    const completedAgentMessageResult = readAgentMessageCompleted(notification)
    if (completedAgentMessageResult) {
      const { message: completedAgentMessage, sourceItemId, sourceText } = completedAgentMessageResult
      const rawCursorToolId = cursorToolCallDisplayIdFromText(sourceText)
      const idsToRemove = new Set([sourceItemId, completedAgentMessage.id])
      if (rawCursorToolId) idsToRemove.add(rawCursorToolId)
      const nextLiveAgent = removeLiveAgentMessagesByIds(
        liveAgentMessagesByThreadId.value[notificationThreadId] ?? [],
        idsToRemove,
      )
      setLiveAgentMessagesForThread(notificationThreadId, nextLiveAgent)

      if (completedAgentMessage.messageType === 'commandExecution') {
        upsertLiveCommand(notificationThreadId, completedAgentMessage)
        if (completedAgentMessage.commandExecution?.status === 'inProgress') {
          setTurnActivityForThread(notificationThreadId, { label: 'Running command', details: [completedAgentMessage.commandExecution.command] })
        }
      } else if (completedAgentMessage.messageType === 'cursorToolCall') {
        upsertLiveAgentMessage(notificationThreadId, completedAgentMessage)
      } else {
        upsertLiveAgentMessage(notificationThreadId, completedAgentMessage)
      }
    }

    const completedImageView = readCompletedImageView(notification)
    if (completedImageView) {
      upsertLiveAgentMessage(notificationThreadId, completedImageView)

    }

    const startedReasoningItemId = readReasoningStartedItemId(notification)
    if (startedReasoningItemId) {
      activeReasoningItemId = startedReasoningItemId
    }

    const liveReasoningDelta = readReasoningDelta(notification)
    if (liveReasoningDelta) {
      appendLiveReasoningText(notificationThreadId, liveReasoningDelta.delta)
    }

    const sectionBreakMessageId = readReasoningSectionBreakMessageId(notification)
    if (sectionBreakMessageId) {
      const current = liveReasoningTextByThreadId.value[notificationThreadId] ?? ''
      if (current.trim().length > 0 && !current.endsWith('\n\n')) {
        setLiveReasoningText(notificationThreadId, `${current}\n\n`)
      }
    }

    const completedReasoningMessageId = readReasoningCompletedId(notification)
    if (completedReasoningMessageId) {
      if (completedReasoningMessageId === liveReasoningMessageId(activeReasoningItemId)) {
        activeReasoningItemId = ''
      }
    }

    const commandStarted = readCommandExecutionStarted(notification)
    if (commandStarted) {
      upsertLiveCommand(notificationThreadId, commandStarted)
      setTurnActivityForThread(notificationThreadId, { label: 'Running command', details: [commandStarted.commandExecution?.command ?? ''] })
    }

    const commandDelta = readCommandOutputDelta(notification)
    if (commandDelta) {
      const current = (liveCommandsByThreadId.value[notificationThreadId] ?? []).find((m) => m.id === commandDelta.itemId)
      if (current?.commandExecution) {
        upsertLiveCommand(notificationThreadId, {
          ...current,
          commandExecution: { ...current.commandExecution, aggregatedOutput: `${current.commandExecution.aggregatedOutput}${commandDelta.delta}` },
        })
      }
    }

    const commandCompleted = readCommandExecutionCompleted(notification)
    if (commandCompleted) {
      upsertLiveCommand(notificationThreadId, commandCompleted)
    }

    const completedFileChange = readCompletedFileChange(notification)
    if (completedFileChange) {
      upsertLiveFileChangeMessage(notificationThreadId, completedFileChange)
    }

    const toolCallItem = readToolCallItemMessage(notification)
    if (toolCallItem) {
      upsertLiveToolCallMessage(notificationThreadId, toolCallItem)
    }

    const mcpToolCallProgress = readMcpToolCallProgress(notification)
    if (mcpToolCallProgress) {
      const current = (liveToolCallMessagesByThreadId.value[notificationThreadId] ?? [])
        .find((message) => message.id === mcpToolCallProgress.itemId)
      const fallback = createProgressOnlyToolCallMessage(mcpToolCallProgress.itemId, mcpToolCallProgress.message)
      const previousToolCall = current?.toolCall ?? (fallback.toolCall as UiToolCallData)
      const nextToolCall: UiToolCallData = {
        ...previousToolCall,
        status: previousToolCall.status === 'completed' || previousToolCall.status === 'failed'
          ? previousToolCall.status
          : 'inProgress',
        progress: mcpToolCallProgress.message,
      }
      const nextMessage = createToolCallMessage(mcpToolCallProgress.itemId, nextToolCall)
      upsertLiveToolCallMessage(notificationThreadId, {
        ...(current ?? fallback),
        text: nextMessage.text,
        toolCall: nextToolCall,
      })
    }

    if (isAgentContentEvent(notification)) {
      activeReasoningItemId = ''
    }

    if (notification.method === 'turn/completed') {
      activeReasoningItemId = ''
      shouldAutoScrollOnNextAgentEvent = false
      const completedThreadId = extractThreadIdFromNotification(notification)
      if (completedThreadId) {
        setThreadInProgress(completedThreadId, false)
        setTurnActivityForThread(completedThreadId, null)
        markThreadUnreadByEvent(completedThreadId)
        if (!shouldRetryWithFallback) {
          clearPendingTurnRequest(completedThreadId)
          scheduleQueueStateRefresh(completedThreadId)
        }
      }
    }

  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    if (notification.method === 'thread/tokenUsage/updated') return

    const method = notification.method
    const shouldRefreshMessages =
      method === 'turn/started' ||
      method === 'turn/completed' ||
      method === 'error'
    const shouldRefreshThreads =
      method.startsWith('thread/') ||
      method === 'turn/completed'

    if (!shouldRefreshMessages && !shouldRefreshThreads) return

    const threadId = extractThreadIdFromNotification(notification)
    if (threadId && shouldRefreshMessages) {
      pendingThreadMessageRefresh.add(threadId)
    }

    if (shouldRefreshThreads) {
      pendingThreadsRefresh = true
    }

    if (eventSyncTimer !== null || typeof window === 'undefined') return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      void syncFromNotifications()
    }, EVENT_SYNC_DEBOUNCE_MS)
  }

  async function hydrateWorkspaceRootsStateIfNeeded(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): Promise<void> {
    if (hasHydratedWorkspaceRootsState) return
    hasHydratedWorkspaceRootsState = true

    try {
      if (!rootsState) return
      const hydratedOrder: string[] = []
      for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
        const projectName = toProjectNameFromWorkspaceRoot(rootPath)
        if (hydratedOrder.includes(projectName)) continue
        hydratedOrder.push(projectName)
      }

      if (hydratedOrder.length > 0) {
        const mergedOrder = rootsState.projectOrder.length > 0
          ? mergeProjectOrder(hydratedOrder, groups)
          : mergeProjectOrder(projectOrder.value, groups)
        if (!areStringArraysEqual(projectOrder.value, mergedOrder)) {
          projectOrder.value = mergedOrder
        }
      }

      if (Object.keys(rootsState.labels).length > 0 || (rootsState.remoteProjects ?? []).length > 0) {
        const nextLabels = { ...projectDisplayNameById.value }
        let changed = false
        for (const [rootPath, label] of Object.entries(rootsState.labels)) {
          const normalizedRootPath = normalizePathForUi(rootPath).trim()
          const projectNames = [toProjectNameFromWorkspaceRoot(rootPath)]
          if (normalizedRootPath) projectNames.push(normalizedRootPath)
          for (const projectName of projectNames) {
            if (nextLabels[projectName] === label) continue
            nextLabels[projectName] = label
            changed = true
          }
        }
        for (const rootPath of rootsState.order) {
          const leafName = toProjectNameFromWorkspaceRoot(rootPath)
          const parentLeafName = toProjectName(getPathParent(rootPath))
          if (!parentLeafName.startsWith('.') || parentLeafName === leafName) continue
          const displayName = `${leafName} ${parentLeafName}`
          if (nextLabels[leafName] !== undefined || nextLabels[leafName] === displayName) continue
          nextLabels[leafName] = displayName
          changed = true
        }
        for (const remoteProject of rootsState.remoteProjects ?? []) {
          const label = getRemoteProjectDisplayName(remoteProject)
          if (nextLabels[remoteProject.id] === label) continue
          nextLabels[remoteProject.id] = label
          changed = true
        }
        if (changed) {
          projectDisplayNameById.value = nextLabels
        }
      }
    } catch {
      // Keep local storage fallback when global state is unavailable.
    }
  }

  async function loadThreadTitleCacheIfNeeded(): Promise<void> {
    if (Object.keys(threadTitleById.value).length > 0) return
    try {
      const cache = await getThreadTitleCache()
      if (Object.keys(cache.titles).length > 0) {
        threadTitleById.value = cache.titles
      }
    } catch {
      // Title cache is optional; keep UI functional.
    }
  }

  async function loadWorkspaceRootsStateForThreadList(): Promise<WorkspaceRootsState | null> {
    try {
      return await getWorkspaceRootsState()
    } catch {
      return null
    }
  }

  async function requestThreadTitleGeneration(threadId: string, prompt: string, cwd: string | null): Promise<void> {
    if (threadTitleById.value[threadId]) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    const truncated = trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed
    try {
      const title = await generateThreadTitle(truncated, cwd)
      if (!title || threadTitleById.value[threadId]) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
      applyThreadFlags()
      void persistThreadTitle(threadId, title)
    } catch {
      // Title generation is best-effort.
    }
  }

  function filterGroupsByWorkspaceRoots(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): UiProjectGroup[] {
    const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
    const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
    const groupsWithWorkspaceRoots = addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames)
    if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
    const allowedProjectNames = new Set<string>()
    for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
      allowedProjectNames.add(projectName)
    }
    const filteredGroups = groupsWithWorkspaceRoots.filter((group) => {
      if (allowedProjectNames.has(group.projectName)) return true
      return isProjectlessGroup(group)
    })
    return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
  }

  function applyThreadGroups(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): void {
    const visibleGroups = filterGroupsByWorkspaceRoots(groups, rootsState)
    const hasWorkspaceRootsState = Boolean(
      rootsState && (rootsState.order.length > 0 || rootsState.projectOrder.length > 0 || (rootsState.remoteProjects ?? []).length > 0),
    )

    const nextProjectOrder = rootsState?.projectOrder.length
      ? mergeProjectOrder(
        getWorkspaceProjectOrderNames(rootsState, collectDuplicateProjectLeafNames(groups, rootsState)),
        visibleGroups,
      )
      : mergeProjectOrder(projectOrder.value, visibleGroups)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      if (!hasWorkspaceRootsState) {
        saveProjectOrder(projectOrder.value)
      }
    }

    const orderedGroups = orderGroupsByProjectOrder(visibleGroups, projectOrder.value)
    markServerListedThreads(new Set(flattenThreads(orderedGroups).map((thread) => thread.id)))
    const mergedWithInProgress = mergeIncomingWithLocalInProgressThreads(
      sourceGroups.value,
      orderedGroups,
      inProgressById.value,
    )
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, mergedWithInProgress)
    syncThreadProvidersFromGroups(sourceGroups.value)
    inProgressById.value = pruneThreadStateMap(
      inProgressById.value,
      new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id)),
    )
    applyThreadFlags()
  }

  function normalizeQueueStateForPersistence(state: Record<string, QueuedMessage[]>): ThreadQueueState {
    const next: ThreadQueueState = {}
    for (const [threadId, queue] of Object.entries(state)) {
      const normalizedThreadId = threadId.trim()
      if (!normalizedThreadId || queue.length === 0) continue
      next[normalizedThreadId] = queue.map((message) => ({
        id: message.id,
        text: message.text,
        imageUrls: [...message.imageUrls],
        skills: message.skills.map((skill) => ({ name: skill.name, path: skill.path })),
        fileAttachments: message.fileAttachments.map((attachment) => ({
          label: attachment.label,
          path: attachment.path,
          fsPath: attachment.fsPath,
        })),
        collaborationMode: message.collaborationMode,
        model: message.model,
        modelProvider: toStoredRpcModelProviderId(message.modelProvider, activeCodexProviderId.value),
        reasoningEffort: message.reasoningEffort,
      }))
    }
    return next
  }

  function normalizeQueueStateFromPersistence(state: ThreadQueueState): Record<string, QueuedMessage[]> {
    const next: Record<string, QueuedMessage[]> = {}
    for (const [threadId, queue] of Object.entries(state)) {
      const normalizedThreadId = threadId.trim()
      if (!normalizedThreadId || queue.length === 0) continue
      next[normalizedThreadId] = queue.map((message) => ({
        ...message,
        model: typeof message.model === 'string' ? message.model.trim() : readModelIdForThread(normalizedThreadId),
        modelProvider: normalizeStoredProviderId(message.modelProvider),
        reasoningEffort: normalizeStoredReasoningEffort(message.reasoningEffort),
      }))
    }
    return next
  }

  function persistQueueState(): void {
    void setThreadQueueState(normalizeQueueStateForPersistence(queuedMessagesByThreadId.value)).catch(() => {
      // Queue persistence is best-effort; keep the current in-memory queue usable.
    })
  }

  async function loadPersistedQueueStateIfNeeded(): Promise<void> {
    if (hasLoadedPersistedQueueState) return
    hasLoadedPersistedQueueState = true
    try {
      queuedMessagesByThreadId.value = normalizeQueueStateFromPersistence(await getThreadQueueState())
    } catch {
      // Backend queue state is optional during startup.
    }
  }

  function removeArchivedThreadFromLoadedLists(threadId: string): void {
    loadedThreadListGroups = removeThreadFromGroups(loadedThreadListGroups, threadId)
    sourceGroups.value = removeThreadFromGroups(sourceGroups.value, threadId)
    inProgressById.value = omitKey(inProgressById.value, threadId)
    applyThreadFlags()
  }

  function mergeThreadGroupPages(previous: UiProjectGroup[], incoming: UiProjectGroup[]): UiProjectGroup[] {
    if (previous.length === 0) return incoming
    if (incoming.length === 0) return previous

    const threadById = new Map<string, UiThread>()
    for (const thread of flattenThreads(previous)) {
      threadById.set(thread.id, thread)
    }
    for (const thread of flattenThreads(incoming)) {
      threadById.set(thread.id, thread)
    }
    const groupsByProject = new Map<string, UiThread[]>()
    for (const thread of threadById.values()) {
      const existing = groupsByProject.get(thread.projectName)
      if (existing) existing.push(thread)
      else groupsByProject.set(thread.projectName, [thread])
    }

    return Array.from(groupsByProject.entries())
      .map(([projectName, threads]) => ({
        projectName,
        threads: threads.sort(
          (first, second) => new Date(second.updatedAtIso).getTime() - new Date(first.updatedAtIso).getTime(),
        ),
      }))
      .sort((first, second) => {
        const firstUpdated = new Date(first.threads[0]?.updatedAtIso ?? 0).getTime()
        const secondUpdated = new Date(second.threads[0]?.updatedAtIso ?? 0).getTime()
        return secondUpdated - firstUpdated
      })
  }

  function hasActiveInProgressThreads(): boolean {
    return Object.values(inProgressById.value).some((value) => value === true)
  }

  function scheduleRemainingThreadPages(rootsState: WorkspaceRootsState | null = loadedThreadListRootsState): void {
    if (!threadListNextCursor || isLoadingRemainingThreadPages || hasActiveInProgressThreads()) return

    loadedThreadListRootsState = rootsState

    if (typeof window === 'undefined') {
      void loadRemainingThreadPages(rootsState)
      return
    }

    if (threadListBackgroundTimer !== null) {
      window.clearTimeout(threadListBackgroundTimer)
    }

    threadListBackgroundTimer = window.setTimeout(() => {
      threadListBackgroundTimer = null
      if (!threadListNextCursor || hasActiveInProgressThreads()) return
      void loadRemainingThreadPages(loadedThreadListRootsState)
    }, BACKGROUND_THREAD_PAGINATION_DELAY_MS)
  }

  async function loadRemainingThreadPages(rootsState: WorkspaceRootsState | null): Promise<void> {
    if (isLoadingRemainingThreadPages || !threadListNextCursor || hasActiveInProgressThreads()) return
    isLoadingRemainingThreadPages = true

    try {
      const page = await getThreadGroupsPage(threadListNextCursor, getBackgroundThreadListLimit())
      threadListNextCursor = page.nextCursor
      hasLoadedAllThreadPages = page.nextCursor === null
      isThreadListFullyLoaded.value = hasLoadedAllThreadPages
      loadedThreadListGroups = mergeThreadGroupPages(loadedThreadListGroups, page.groups)
      applyThreadGroups(loadedThreadListGroups, rootsState)
    } catch {
      // Keep the first page usable; a later refresh can retry remaining pages.
    } finally {
      isLoadingRemainingThreadPages = false
      if (threadListNextCursor && !hasActiveInProgressThreads()) {
        scheduleRemainingThreadPages(rootsState)
      }
    }
  }

  async function loadThreads() {
    if (loadThreadsPromise) {
      await loadThreadsPromise
      return
    }

    loadThreadsPromise = (async () => {
    if (!hasLoadedThreads.value) {
      isLoadingThreads.value = true
    }

    try {
      const [page, rootsState] = await Promise.all([
        getThreadGroupsPage(),
        loadWorkspaceRootsStateForThreadList(),
        loadThreadTitleCacheIfNeeded(),
      ])
      loadedThreadListRootsState = rootsState
      const groups = page.groups
      loadedThreadListGroups = hasLoadedThreads.value
        ? mergeThreadGroupPages(loadedThreadListGroups, groups)
        : groups
      threadListNextCursor = hasLoadedThreads.value && !hasLoadedAllThreadPages
        ? threadListNextCursor
        : page.nextCursor
      hasLoadedAllThreadPages = page.nextCursor === null
      isThreadListFullyLoaded.value = hasLoadedAllThreadPages
      await hydrateWorkspaceRootsStateIfNeeded(groups, rootsState)

      applyThreadGroups(loadedThreadListGroups, rootsState)
      hasLoadedThreads.value = true
      if (!hasLoadedAllThreadPages) {
        scheduleRemainingThreadPages(rootsState)
      }

      const flatThreads = flattenThreads(projectGroups.value)
      pruneThreadScopedState(flatThreads)

      const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)

      if (!currentExists && selectedThreadId.value && hasLoadedAllThreadPages && !preserveUnlistedSelectedThread) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
      if (!currentExists && !selectedThreadId.value) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
    } finally {
      isLoadingThreads.value = false
    }
    })().finally(() => {
      loadThreadsPromise = null
    })

    await loadThreadsPromise
  }

  async function loadFullHistoryMessages(threadId: string, options: { force?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (options.force !== true && loadedFullHistoryByThreadId.value[threadId] === true) return

    const existingLoad = loadFullHistoryPromiseByThreadId.get(threadId)
    if (existingLoad) {
      await existingLoad
      return
    }

    loadingFullHistoryByThreadId.value = {
      ...loadingFullHistoryByThreadId.value,
      [threadId]: true,
    }

    const loadPromise = (async () => {
      try {
        const page = await getFullThreadMessages(threadId)
        setFullHistoryMessagesForThread(threadId, page.messages)
        replaceTurnIndexLookupForThread(threadId, {
          ...(turnIndexByTurnIdByThreadId.value[threadId] ?? {}),
          ...page.turnIndexByTurnId,
        })
        rebindLiveFileChangeTurnIndices(threadId)
      } finally {
        loadingFullHistoryByThreadId.value = {
          ...loadingFullHistoryByThreadId.value,
          [threadId]: false,
        }
      }
    })().finally(() => {
      loadFullHistoryPromiseByThreadId.delete(threadId)
    })

    loadFullHistoryPromiseByThreadId.set(threadId, loadPromise)
    await loadPromise
  }

  async function loadUserMessageCount(threadId: string, options: { force?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (options.force !== true && typeof userMessageCountByThreadId.value[threadId] === 'number') return

    const existing = loadUserMessageCountPromiseByThreadId.get(threadId)
    if (existing) {
      await existing
      return
    }

    loadingUserMessageCountByThreadId.value = {
      ...loadingUserMessageCountByThreadId.value,
      [threadId]: true,
    }

    const loadPromise = (async () => {
      try {
        const count = await getThreadUserMessageCount(threadId)
        userMessageCountByThreadId.value = {
          ...userMessageCountByThreadId.value,
          [threadId]: count,
        }
      } catch {
        // Best-effort; leave any previously known count in place.
      } finally {
        loadingUserMessageCountByThreadId.value = {
          ...loadingUserMessageCountByThreadId.value,
          [threadId]: false,
        }
      }
    })().finally(() => {
      loadUserMessageCountPromiseByThreadId.delete(threadId)
    })

    loadUserMessageCountPromiseByThreadId.set(threadId, loadPromise)
    await loadPromise
  }

  function ensureUserMessageCountLoaded(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    void loadUserMessageCount(normalizedThreadId).catch(() => {})
  }

  async function loadUserMessageIndex(threadId: string, options: { force?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (options.force !== true && Array.isArray(userMessageIndexByThreadId.value[threadId])) return

    const existing = loadUserMessageIndexPromiseByThreadId.get(threadId)
    if (existing) {
      await existing
      return
    }

    loadingUserMessageIndexByThreadId.value = {
      ...loadingUserMessageIndexByThreadId.value,
      [threadId]: true,
    }

    const loadPromise = (async () => {
      try {
        const entries = await getThreadUserMessageIndex(threadId)
        userMessageIndexByThreadId.value = {
          ...userMessageIndexByThreadId.value,
          [threadId]: entries,
        }
      } catch {
        // Best-effort; leave any previously known entries in place.
      } finally {
        loadingUserMessageIndexByThreadId.value = {
          ...loadingUserMessageIndexByThreadId.value,
          [threadId]: false,
        }
      }
    })().finally(() => {
      loadUserMessageIndexPromiseByThreadId.delete(threadId)
    })

    loadUserMessageIndexPromiseByThreadId.set(threadId, loadPromise)
    await loadPromise
  }

  function ensureUserMessageIndexLoaded(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    void loadUserMessageIndex(normalizedThreadId).catch(() => {})
  }


  async function loadMessages(
    threadId: string,
    options: { silent?: boolean; force?: boolean; preferCached?: boolean } = {},
  ) {
    if (!threadId) {
      return
    }

    const existingLoad = loadMessagePromiseByThreadId.get(threadId)
    if (existingLoad) {
      await existingLoad
      return
    }

    const alreadyLoaded = loadedMessagesByThreadId.value[threadId] === true
    const forceReload = options.force === true
    const preferCached = options.preferCached === true
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const hasCachedMessages = alreadyLoaded && persisted.length > 0
    const canServeFromCache =
      preferCached &&
      !forceReload &&
      hasCachedMessages &&
      inProgressById.value[threadId] !== true

    // Cached-first render: hand the caller the persisted messages
    // immediately and refresh in the background so provider/model
    // switches, page reloads, or LRU-restored threads never block the
    // UI on a network round-trip.
    if (canServeFromCache) {
      markThreadAsRead(threadId)
      void loadMessages(threadId, { silent: true }).catch(() => {})
      return
    }

    const shouldShowLoading = options.silent !== true && !alreadyLoaded
    if (shouldShowLoading) {
      loadingMessagesByThreadId.value = {
        ...loadingMessagesByThreadId.value,
        [threadId]: true,
      }
    }

    const loadPromise = (async () => {
      try {
        const version = currentThreadVersion(threadId)
        const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
        const loadedRecently =
          Date.now() - (lastMessageLoadAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
        const needsResume = shouldResumeThread(threadId, forceReload)
        const canReuseLoadedMessages =
          !forceReload &&
          alreadyLoaded &&
          (
            loadedRecently ||
            (
              (version.length === 0 || loadedVersion === version) &&
              inProgressById.value[threadId] !== true
            )
          )

        if (canReuseLoadedMessages && !needsResume) {
          markThreadAsRead(threadId)
          return
        }

        const resumedThread = needsResume
          ? await resumeThread(
              threadId,
              readModelIdForThread(threadId) || undefined,
              readThreadRpcProviderId(threadId) || undefined,
            )
          : null
        const detail = resumedThread ?? await getThreadDetail(threadId)

        if (resumedThread) {
          applyThreadModelStateWithProviderPriority(
            threadId,
            resumedThread.model,
            resumedThread.modelProvider,
            resumedThread.reasoningEffort,
          )
          markThreadResumed(threadId)
        }

        const { messages: nextMessages, inProgress, activeTurnId, turnIndexByTurnId } = detail
        markThreadMessagesPersisted(threadId, nextMessages)
        replaceTurnIndexLookupForThread(threadId, turnIndexByTurnId)
        rebindLiveFileChangeTurnIndices(threadId)
        const appliedTurnState = applyThreadDetailActiveTurnState(threadId, {
          messages: nextMessages,
          inProgress,
          activeTurnId,
          turnIndexByTurnId,
        })
        const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
        const mergedMessages = mergeMessages(previousPersisted, nextMessages, {
          preserveMissing: options.silent === true,
        })
        setPersistedMessagesForThread(threadId, mergedMessages)

        const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
        if (appliedTurnState.inProgress) {
          const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
          setLiveAgentMessagesForThread(threadId, nextLiveAgent)
        } else {
          clearLiveAgentMessagesForThread(threadId)
        }
        removeLiveCommandsPersistedIn(threadId, nextMessages)
        removeLiveFileChangesPersistedIn(threadId, nextMessages)
        removeLiveToolCallsPersistedIn(threadId, nextMessages)

        loadedMessagesByThreadId.value = {
          ...loadedMessagesByThreadId.value,
          [threadId]: true,
        }
        lastMessageLoadAtByThreadId.set(threadId, Date.now())
        if (version) {
          loadedVersionByThreadId.value = {
            ...loadedVersionByThreadId.value,
            [threadId]: version,
          }
        }
        hasMoreOlderMessagesByThreadId.value = {
          ...hasMoreOlderMessagesByThreadId.value,
          [threadId]: detail.hasMoreOlder === true,
        }
        if (detail.hasMoreOlder !== true) {
          setFullHistoryMessagesForThread(threadId, mergedMessages)
        } else {
          void backfillOlderTurnsInBackground(threadId)
        }
        if (!appliedTurnState.inProgress) {
          clearCompletedTurnLiveState(threadId)
        }
        markThreadAsRead(threadId)
      } finally {
        if (shouldShowLoading) {
          loadingMessagesByThreadId.value = {
            ...loadingMessagesByThreadId.value,
            [threadId]: false,
          }
        }
      }
    })().finally(() => {
      loadMessagePromiseByThreadId.delete(threadId)
    })

    loadMessagePromiseByThreadId.set(threadId, loadPromise)
    await loadPromise
  }

  async function loadOlderMessages(threadId: string = selectedThreadId.value): Promise<void> {
    if (!threadId) return
    if (loadingOlderMessagesByThreadId.value[threadId] === true) return
    if (hasMoreOlderMessagesByThreadId.value[threadId] !== true) return

    const beforeTurnId = getFirstPersistedTurnId(threadId)
    if (!beforeTurnId) {
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: false,
      }
      return
    }

    loadingOlderMessagesByThreadId.value = {
      ...loadingOlderMessagesByThreadId.value,
      [threadId]: true,
    }

    try {
      const page = await getOlderThreadMessages(threadId, beforeTurnId)
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(page.messages, previousPersisted, { preserveMissing: true })
      setPersistedMessagesForThread(threadId, mergedMessages)
      replaceTurnIndexLookupForThread(threadId, {
        ...(turnIndexByTurnIdByThreadId.value[threadId] ?? {}),
        ...page.turnIndexByTurnId,
      })
      rebindLiveFileChangeTurnIndices(threadId)
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [threadId]: page.hasMoreOlder,
      }
      if (page.hasMoreOlder === false) {
        setFullHistoryMessagesForThread(threadId, mergedMessages)
      }
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load earlier messages'
      throw loadError
    } finally {
      loadingOlderMessagesByThreadId.value = {
        ...loadingOlderMessagesByThreadId.value,
        [threadId]: false,
      }
    }
  }

  async function loadThreadMessageWindow(threadId: string, centerTurnId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedCenterTurnId = centerTurnId.trim()
    if (!normalizedThreadId || !normalizedCenterTurnId) return

    try {
      const page = await getThreadTurnWindow(normalizedThreadId, normalizedCenterTurnId, 3, 3)
      const previousPersisted = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
      const mergedMessages = sortMessagesByThreadPosition(
        mergeMessages(previousPersisted, page.messages, { preserveMissing: true }),
      )
      setPersistedMessagesForThread(normalizedThreadId, mergedMessages)
      replaceTurnIndexLookupForThread(normalizedThreadId, {
        ...(turnIndexByTurnIdByThreadId.value[normalizedThreadId] ?? {}),
        ...page.turnIndexByTurnId,
      })
      rebindLiveFileChangeTurnIndices(normalizedThreadId)
      hasMoreOlderMessagesByThreadId.value = {
        ...hasMoreOlderMessagesByThreadId.value,
        [normalizedThreadId]: page.hasMoreOlder,
      }
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load message window'
      throw loadError
    }
  }

  async function ensureMessageLoaded(threadId: string, messageId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedMessageId = messageId.trim()
    if (!normalizedThreadId || !normalizedMessageId) return

    const persisted = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
    if (persisted.some((message) => message.id === normalizedMessageId)) return

    await loadFullHistoryMessages(normalizedThreadId)
    const fullHistory = fullHistoryMessagesByThreadId.value[normalizedThreadId] ?? []
    if (!fullHistory.some((message) => message.id === normalizedMessageId)) return

    const latestPersisted = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
    const mergedMessages = mergeMessages(fullHistory, latestPersisted, { preserveMissing: true })
    setPersistedMessagesForThread(normalizedThreadId, mergedMessages)
    hasMoreOlderMessagesByThreadId.value = {
      ...hasMoreOlderMessagesByThreadId.value,
      [normalizedThreadId]: false,
    }
  }

  async function ensureThreadMessagesLoaded(threadId: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (loadedMessagesByThreadId.value[threadId] === true) return
    await loadMessages(threadId, options)
  }

  async function refreshSkills(): Promise<void> {
    if (refreshSkillsPromise) {
      await refreshSkillsPromise
      return
    }

    refreshSkillsPromise = (async () => {
      try {
        const selectedCwd = selectedThread.value?.cwd?.trim() ?? ''
        installedSkills.value = await getSkillsList(selectedCwd ? [selectedCwd] : undefined)
      } catch {
        // keep previous skills on failure
      } finally {
        refreshSkillsPromise = null
      }
    })()

    await refreshSkillsPromise
  }

  async function settleAncillaryRefresh(promise: Promise<unknown>): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const timeoutId = setTimeout(() => {
        settled = true
        resolve()
      }, ANCILLARY_REFRESH_TIMEOUT_MS)

      promise.then(() => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve()
      }).catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve()
      })
    })
  }

  async function refreshAncillaryState(
    options: { providerChanged?: boolean; includeProviderModels?: boolean; explicitProviderChange?: boolean } = {},
  ): Promise<void> {
    await Promise.all([
      settleAncillaryRefresh(refreshModelPreferences({
        providerChanged: options.providerChanged,
        includeProviderModels: options.includeProviderModels,
        explicitProviderChange: options.explicitProviderChange,
      })),
      settleAncillaryRefresh(refreshRateLimits()),
      settleAncillaryRefresh(refreshCollaborationModes()),
      settleAncillaryRefresh(refreshSkills()),
    ])
  }

  function scheduleAncillaryStateRefresh(
    options: { providerChanged?: boolean; includeProviderModels?: boolean; explicitProviderChange?: boolean } = {},
  ): void {
    const run = () => {
      void refreshAncillaryState(options)
    }

    if (typeof window === 'undefined') {
      run()
      return
    }

    window.setTimeout(run, 0)
  }

  async function refreshAll(
    options: {
      includeSelectedThreadMessages?: boolean
      awaitAncillaryRefreshes?: boolean
      providerChanged?: boolean
      refreshAncillary?: boolean
    } = {},
  ) {
    error.value = ''
    codexCliMissingError.value = ''
    const includeSelectedThreadMessages = options.includeSelectedThreadMessages !== false
    const awaitAncillaryRefreshes = options.awaitAncillaryRefreshes === true
    const refreshAncillary = options.refreshAncillary !== false

    try {
      await loadPersistedQueueStateIfNeeded()
      await loadThreads()
      if (includeSelectedThreadMessages) {
        await loadMessages(selectedThreadId.value)
      }
      if (!refreshAncillary) {
        return
      }
      if (awaitAncillaryRefreshes) {
        await refreshAncillaryState({
          providerChanged: options.providerChanged,
          includeProviderModels: options.providerChanged === true || awaitAncillaryRefreshes,
        })
      } else {
        scheduleAncillaryStateRefresh({
          providerChanged: options.providerChanged,
          includeProviderModels: false,
        })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
    }
  }

  async function selectThread(threadId: string) {
    setSelectedThreadId(threadId)

    // Fire the message + queue fetches in the background so quickly
    // clicking another thread is not blocked on the previous thread's
    // pending network work. Per-thread loading/caching maps guarantee that
    // late-arriving payloads only mutate the correct thread's state.
    // preferCached lets the switch return instantly if we already have
    // this thread's messages in memory; a silent refresh is scheduled
    // internally so the view converges to the latest server state.
    void loadMessages(threadId, { preferCached: true }).catch((unknownError) => {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    })
    if (threadId) {
      void processQueuedMessages(threadId).catch(() => {})
    }
    void refreshSkills()
  }

  async function archiveThreadById(threadId: string) {
    const wasSelectedThread = selectedThreadId.value === threadId
    const nextSelectedThreadId = wasSelectedThread
      ? findAdjacentThreadId(flattenThreads(projectGroups.value), threadId)
      : ''

    if (wasSelectedThread) {
      setSelectedThreadId(nextSelectedThreadId)
      if (nextSelectedThreadId) {
        void loadMessages(nextSelectedThreadId, { silent: true })
      }
    }

    try {
      await archiveThread(threadId)
      removeArchivedThreadFromLoadedLists(threadId)
      await loadThreads()

      if (wasSelectedThread && nextSelectedThreadId && selectedThreadId.value === nextSelectedThreadId) {
        await ensureThreadMessagesLoaded(nextSelectedThreadId, { silent: true })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function renameThreadById(threadId: string, threadName: string) {
    const normalizedName = threadName.trim()
    if (!threadId || !normalizedName) return

    try {
      await renameThread(threadId, normalizedName)
      threadTitleById.value = { ...threadTitleById.value, [threadId]: normalizedName }
      applyThreadFlags()
      void persistThreadTitle(threadId, normalizedName)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function forkThreadById(threadId: string): Promise<string> {
    const sourceThreadId = threadId.trim()
    if (!sourceThreadId) return ''

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === sourceThreadId)
    const sourceCwd = sourceThread?.cwd?.trim() ?? ''
    const sourceTitle = sourceThread?.title?.trim() ?? 'Forked chat'
    const selectedModel = readModelIdForThread(sourceThreadId)
    const sourceProvider = readSelectedProvider(selectedProviderByContext.value, sourceThreadId)
    error.value = ''

    try {
      const forkedThread = await forkThread(
        sourceThreadId,
        sourceCwd || undefined,
        selectedModel || undefined,
        readThreadRpcProviderId(sourceThreadId) || undefined,
      )
      const nextThreadId = forkedThread.threadId.trim()
      if (!nextThreadId) return ''

      insertOptimisticThread(nextThreadId, sourceCwd, sourceTitle)
      applyThreadModelStateWithProviderPriority(
        nextThreadId,
        forkedThread.model,
        forkedThread.modelProvider || sourceProvider,
        forkedThread.reasoningEffort,
      )
      markThreadResumed(nextThreadId)
      setSelectedThreadId(nextThreadId)
      await loadThreads()
      await loadMessages(nextThreadId)
      return nextThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function forkThreadFromTurn(threadId: string, turnIndex: number): Promise<string> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || !Number.isInteger(turnIndex) || turnIndex < 0) return ''

    if (inProgressById.value[normalizedThreadId] === true) {
      error.value = 'Finish the current turn before forking from a response.'
      return ''
    }

    if (loadedMessagesByThreadId.value[normalizedThreadId] !== true) {
      try {
        await loadMessages(normalizedThreadId)
      } catch (unknownError) {
        error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        return ''
      }
    }

    const sourceMessages = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
    let lastTurnIndex = -1
    for (const message of sourceMessages) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        lastTurnIndex = Math.max(lastTurnIndex, message.turnIndex)
      }
    }

    if (lastTurnIndex >= 0 && turnIndex > lastTurnIndex) return ''

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === normalizedThreadId) ?? null
    const sourceProvider = readSelectedProvider(selectedProviderByContext.value, normalizedThreadId)

    try {
      error.value = ''
      const forked = await forkThread(normalizedThreadId)
      const forkedThreadId = forked.threadId.trim()
      if (!forkedThreadId) return ''

      const forkedCwd = forked.cwd.trim() || sourceThread?.cwd?.trim() || ''
      const forkedThreadTitle = toForkedThreadTitle(sourceThread?.title || sourceThread?.preview || 'Untitled thread')
      insertOptimisticThread(forkedThreadId, forkedCwd, forkedThreadTitle)
      applyThreadModelStateWithProviderPriority(
        forkedThreadId,
        forked.model,
        forked.modelProvider || sourceProvider,
        forked.reasoningEffort,
      )
      setPersistedMessagesForThread(forkedThreadId, forked.messages)
      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [forkedThreadId]: true,
      }
      markThreadResumed(forkedThreadId)
      clearLivePlansForThread(forkedThreadId)
      setLiveAgentMessagesForThread(forkedThreadId, [])
      clearLiveReasoningForThread(forkedThreadId)
      if (liveCommandsByThreadId.value[forkedThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, forkedThreadId)
      }
      clearLiveToolCallsForThread(forkedThreadId)
      setTurnSummaryForThread(forkedThreadId, null)
      setTurnActivityForThread(forkedThreadId, null)
      setTurnErrorForThread(forkedThreadId, null)
      setThreadInProgress(forkedThreadId, false)

      const turnsToRollback = lastTurnIndex - turnIndex
      if (turnsToRollback > 0) {
        const rolledBackMessages = await rollbackThread(forkedThreadId, turnsToRollback)
        setPersistedMessagesForThread(forkedThreadId, rolledBackMessages)
      }

      await renameThreadById(forkedThreadId, forkedThreadTitle)
      setSelectedThreadId(forkedThreadId)
      void loadThreads().catch(() => {})
      return forkedThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function maybeReplyToPendingUserInputRequest(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<boolean> {
    if (!threadId || !text.trim()) return false
    if (imageUrls.length > 0 || skills.length > 0 || fileAttachments.length > 0) return false

    const requests = pendingServerRequestsByThreadId.value[threadId] ?? []
    const userInputRequests = requests.filter((request) => request.method === 'item/tool/requestUserInput')
    if (userInputRequests.length !== 1) return false

    const [request] = userInputRequests
    const questionIds = readToolRequestUserInputQuestionIds(request)
    if (questionIds.length !== 1) return false

    return respondToPendingServerRequest({
      id: request.id,
      result: {
        answers: {
          [questionIds[0]]: {
            answers: [text.trim()],
          },
        },
      },
    })
  }

  async function sendMessageToThread(
    targetThreadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    mode: 'steer' | 'queue' = 'steer',
    fileAttachments: FileAttachment[] = [],
    queueInsertIndex?: number,
    collaborationModeOverride?: CollaborationModeKind,
  ): Promise<void> {
    if (isUpdatingSpeedMode.value) return

    const threadId = targetThreadId.trim()
    const nextText = text.trim()
    if (!threadId || (!nextText && imageUrls.length === 0 && fileAttachments.length === 0)) return

    const goalSlashCommandSubmission = imageUrls.length === 0
    if (goalSlashCommandSubmission && await runGoalSlashCommandForThread(threadId, nextText)) {
      return
    }

    if (await maybeReplyToPendingUserInputRequest(threadId, nextText, imageUrls, skills, fileAttachments)) {
      return
    }

    setThreadNoticeForThread(threadId, null)

    let isInProgress = inProgressById.value[threadId] === true

    if (isInProgress && mode === 'queue') {
      const queue = queuedMessagesByThreadId.value[threadId] ?? []
      const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const nextQueue = [...queue]
      const insertIndex = typeof queueInsertIndex === 'number'
        ? Math.max(0, Math.min(queueInsertIndex, nextQueue.length))
        : nextQueue.length
      nextQueue.splice(insertIndex, 0, {
        id,
        text: nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationMode: collaborationModeOverride === 'plan'
          ? 'plan'
          : collaborationModeOverride === 'default'
            ? 'default'
            : selectedCollaborationMode.value,
        model: readModelIdForThread(threadId),
        modelProvider: readThreadRpcProviderId(threadId),
        reasoningEffort: readReasoningEffortForThread(threadId),
      })
      queuedMessagesByThreadId.value = {
        ...queuedMessagesByThreadId.value,
        [threadId]: nextQueue,
      }
      persistQueueState()
      return
    }

    // Before steering (isInProgress true) or starting a new turn (isInProgress false),
    // double-check with the CLI that there's really no active turn.  This protects
    // against the race where the local inProgressById is stale because the turn/started
    // notification hasn't arrived yet or the event-sync debounce hasn't run.
    const recheckedTurnId = await resolveActiveTurnIdForThread(threadId)
    if (recheckedTurnId && !isInProgress) {
      console.warn('[DEBUG:sendMessageToSelectedThread] stale inProgress=false, CLI says active turn=%s — switching to steer', recheckedTurnId)
      fetch('/codex-api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'send-stale-inprogress-fixup', message: 'CLI says turn active but inProgress was false', extra: { threadId, turnId: recheckedTurnId, mode } }) }).catch(() => {})
      isInProgress = true
    }

    if (isInProgress) {
      console.warn('[DEBUG:sendMessageToSelectedThread] steer during in-progress — threadId=%s mode=%s', threadId, mode)
      fetch('/codex-api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'send-steer-inprogress', message: 'steer during in-progress', extra: { threadId, mode } }) }).catch(() => {})
      shouldAutoScrollOnNextAgentEvent = true
      error.value = ''
      setTurnErrorForThread(threadId, null)
      void steerActiveTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
      ).catch(async (unknownError) => {
        if (isNoActiveTurnToSteerError(unknownError)) {
          try {
            await startTurnAfterStaleSteer(
              threadId,
              nextText,
              imageUrls,
              skills,
              fileAttachments,
              collaborationModeOverride,
            )
            error.value = ''
            return
          } catch (fallbackError) {
            shouldAutoScrollOnNextAgentEvent = false
            setThreadInProgress(threadId, false)
            setTurnActivityForThread(threadId, null)
            const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : 'Unknown application error'
            setTurnErrorForThread(threadId, fallbackErrorMessage)
            error.value = fallbackErrorMessage
            return
          }
        }
        const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        setTurnErrorForThread(threadId, errorMessage)
        error.value = errorMessage
      })
      return
    }

    error.value = ''
    shouldAutoScrollOnNextAgentEvent = true
    setTurnSummaryForThread(threadId, null)
    const selectedReasoningEffortForThread = readReasoningEffortForThread(threadId)
    setTurnActivityForThread(
      threadId,
      {
        label: 'Thinking',
        details: buildPendingTurnDetails(
          readModelIdForThread(threadId),
          selectedReasoningEffortForThread,
          collaborationModeOverride === 'plan'
            ? 'plan'
            : collaborationModeOverride === 'default'
              ? 'default'
              : selectedCollaborationMode.value,
        ),
      },
    )
    setTurnErrorForThread(threadId, null)
    setThreadInProgress(threadId, true)

    try {
      await startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
      )
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw unknownError
    }
  }

  async function sendMessageToSelectedThread(
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    mode: 'steer' | 'queue' = 'steer',
    fileAttachments: FileAttachment[] = [],
    queueInsertIndex?: number,
    collaborationModeOverride?: CollaborationModeKind,
  ): Promise<void> {
    await sendMessageToThread(
      selectedThreadId.value,
      text,
      imageUrls,
      skills,
      mode,
      fileAttachments,
      queueInsertIndex,
      collaborationModeOverride,
    )
  }

  async function sendMessageToNewThread(
    text: string,
    cwd: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<string> {
    if (isUpdatingSpeedMode.value) return ''

    const nextText = text.trim()
    const targetCwd = cwd.trim()
    const selectedModel = readModelIdForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT).trim()
    const selectedReasoningEffortForNewThread = readReasoningEffortForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT)
    const selectedMode = readSelectedCollaborationMode(
      selectedCollaborationModeByContext.value,
      NEW_THREAD_COLLABORATION_MODE_CONTEXT,
    )
    const selectedProviderForNewThread = selectedProvider.value
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) return ''

    const goalSlashCommandSubmission = imageUrls.length === 0
    const goalSlashCommand = goalSlashCommandSubmission ? parseGoalSlashCommand(nextText) : null
    if (goalSlashCommand && goalSlashCommand.kind !== 'set') {
      error.value = 'Open an existing thread before using this /goal command.'
      return ''
    }

    isSendingMessage.value = true
    error.value = ''
    let threadId = ''

    try {
      try {
        const startedThread = await startThread(
          targetCwd || undefined,
          selectedModel || undefined,
          readThreadRpcProviderId('') || undefined,
        )
        threadId = startedThread.threadId
        applyThreadModelStateWithProviderPriority(
          threadId,
          startedThread.model,
          startedThread.modelProvider || selectedProviderForNewThread,
          selectedReasoningEffortForNewThread || startedThread.reasoningEffort,
        )
        setSelectedCollaborationModeForThread(threadId, selectedMode)
      } catch (unknownError) {
        if (selectedModel && selectedModel !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          await applyFallbackModelSelection()
          const fallbackThread = await startThread(
            targetCwd || undefined,
            MODEL_FALLBACK_ID,
            readThreadRpcProviderId('') || undefined,
          )
          threadId = fallbackThread.threadId
          applyThreadModelStateWithProviderPriority(
            threadId,
            fallbackThread.model,
            fallbackThread.modelProvider || selectedProviderForNewThread,
            selectedReasoningEffortForNewThread || fallbackThread.reasoningEffort,
          )
          setSelectedCollaborationModeForThread(threadId, selectedMode)
        } else {
          throw unknownError
        }
      }
      if (!threadId) return ''

      insertOptimisticThread(threadId, targetCwd, goalSlashCommand?.objective || nextText || '[Image]')
      markThreadResumed(threadId)
      setSelectedThreadId(threadId)
      const capturedThreadId = threadId
      const capturedCwd = targetCwd || null
      const capturedPrompt = goalSlashCommand?.objective || nextText
      if (goalSlashCommand) {
        setTurnSummaryForThread(threadId, null)
        setTurnActivityForThread(threadId, null)
        setTurnErrorForThread(threadId, null)
        setThreadInProgress(threadId, false)
        const goal = await setThreadGoal(threadId, {
          objective: goalSlashCommand.objective,
          status: 'active',
        })
        setThreadNoticeForThread(threadId, goalNoticeForGoal(goal))
        isSendingMessage.value = false
        void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd)
        return threadId
      }

      blockInterruptUntilThreadIsPersisted(threadId)
      shouldAutoScrollOnNextAgentEvent = true
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(
        threadId,
        {
          label: 'Thinking',
          details: buildPendingTurnDetails(
            readModelIdForThread(threadId),
            readReasoningEffortForThread(threadId),
            selectedMode,
          ),
        },
      )
      setTurnErrorForThread(threadId, null)
      setThreadInProgress(threadId, true)
      void startTurnForThread(threadId, nextText, imageUrls, skills, fileAttachments, selectedMode)
        .catch((unknownError) => {
          shouldAutoScrollOnNextAgentEvent = false
          setThreadInProgress(threadId, false)
          setTurnActivityForThread(threadId, null)
          const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
          setTurnErrorForThread(threadId, errorMessage)
          error.value = errorMessage
        })
        .finally(() => {
          isSendingMessage.value = false
        })
      void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd)
      return threadId
    } catch (unknownError) {
      shouldAutoScrollOnNextAgentEvent = false
      if (threadId) {
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (threadId) {
        setTurnErrorForThread(threadId, errorMessage)
      }
      error.value = errorMessage
      isSendingMessage.value = false
      throw unknownError
    }
  }

  async function resolveActiveTurnIdForThread(threadId: string): Promise<string> {
    const cachedTurnId = activeTurnIdByThreadId.value[threadId]
    if (cachedTurnId && inProgressById.value[threadId] === true) {
      ensureActiveTurnActivity(threadId)
      return cachedTurnId
    }

    const detail = await getThreadDetail(threadId)
    return applyThreadDetailActiveTurnState(threadId, detail).activeTurnId
  }

  async function refreshActiveTurnStateForThread(threadId: string): Promise<{ activeTurnId: string; inProgress: boolean; refreshed: boolean }> {
    try {
      const detail = await getThreadDetail(threadId)
      const appliedTurnState = applyThreadDetailActiveTurnState(threadId, detail)
      return { ...appliedTurnState, refreshed: true }
    } catch {
      return {
        activeTurnId: activeTurnIdByThreadId.value[threadId] ?? '',
        inProgress: inProgressById.value[threadId] === true,
        refreshed: false,
      }
    }
  }

  function readConflictingActiveTurnId(errorMessage: string, attemptedTurnId: string): string {
    const match = errorMessage.match(/expected active turn id\s+([0-9a-z-]+)\s+but found\s+([0-9a-z-]+)/i)
    if (!match) return ''
    const first = match[1]?.trim() ?? ''
    const second = match[2]?.trim() ?? ''
    if (first && first !== attemptedTurnId) return first
    if (second && second !== attemptedTurnId) return second
    return ''
  }

  async function interruptActiveTurnWithRefresh(threadId: string, turnId: string, modelProvider?: string): Promise<void> {
    try {
      if (modelProvider) {
        await interruptThreadTurn(threadId, turnId, modelProvider)
      } else {
        await interruptThreadTurn(threadId, turnId)
      }
      return
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : ''
      const refreshed = await refreshActiveTurnStateForThread(threadId)
      const retryTurnId = refreshed.activeTurnId && refreshed.activeTurnId !== turnId
        ? refreshed.activeTurnId
        : readConflictingActiveTurnId(errorMessage, turnId)
      if (retryTurnId && retryTurnId !== turnId) {
        setActiveTurnForThread(threadId, retryTurnId)
        if (modelProvider) {
          await interruptThreadTurn(threadId, retryTurnId, modelProvider)
        } else {
          await interruptThreadTurn(threadId, retryTurnId)
        }
        return
      }
      throw unknownError
    }
  }

  async function steerActiveTurnForThread(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<void> {
    const normalizedText = nextText.trim()
    const normalizedImageUrls = [...imageUrls]
    if (
      normalizedImageUrls.length === 0
      && shouldReuseAttachedImageFromPrompt(normalizedText)
    ) {
      const latestAttachedImageUrl = findLatestUserLocalImageUrl(threadId)
      if (latestAttachedImageUrl) {
        normalizedImageUrls.push(latestAttachedImageUrl)
      }
    }
    const normalizedSkills = skills.map((skill) => ({ name: skill.name, path: skill.path }))
    const normalizedFileAttachments = fileAttachments.map((file) => ({ ...file }))
    const expectedTurnId = await resolveActiveTurnIdForThread(threadId)
    if (!expectedTurnId) {
      throw new Error('Could not determine active turn id for steering')
    }
    const activeTurnProviderId = activeTurnProviderIdByThreadId.value[threadId]
      || readThreadRpcProviderId(threadId)

    if (shouldResumeThread(threadId)) {
      const resumedThread = await resumeThread(
        threadId,
        readModelIdForThread(threadId) || undefined,
        readThreadRpcProviderId(threadId) || undefined,
      )
      applyThreadModelStateWithProviderPriority(
        threadId,
        resumedThread.model,
        resumedThread.modelProvider,
      )
    }

    const steeredTurnId = await steerThreadTurn(
      threadId,
      expectedTurnId,
      normalizedText,
      normalizedImageUrls,
      normalizedSkills.length > 0 ? normalizedSkills : undefined,
      normalizedFileAttachments,
      activeTurnProviderId || undefined,
    )

    if (steeredTurnId) {
      setActiveTurnForThread(threadId, steeredTurnId)
      if (activeTurnProviderId) {
        activeTurnProviderIdByThreadId.value = {
          ...activeTurnProviderIdByThreadId.value,
          [threadId]: activeTurnProviderId,
        }
      }
    }

    markThreadResumed(threadId, activeTurnProviderId)

    pendingThreadMessageRefresh.add(threadId)
    await syncFromNotifications()
    scheduleDelayedTurnSync(threadId)
  }

  async function startTurnForThread(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    collaborationModeOverride?: CollaborationModeKind,
  ): Promise<void> {
    const reasoningEffort = readReasoningEffortForThread(threadId)
    const collaborationMode = collaborationModeOverride === 'plan' ? 'plan' : collaborationModeOverride === 'default'
      ? 'default'
      : selectedCollaborationMode.value
    const normalizedText = nextText.trim()
    const normalizedImageUrls = [...imageUrls]
    if (
      normalizedImageUrls.length === 0
      && shouldReuseAttachedImageFromPrompt(normalizedText)
    ) {
      const latestAttachedImageUrl = findLatestUserLocalImageUrl(threadId)
      if (latestAttachedImageUrl) {
        normalizedImageUrls.push(latestAttachedImageUrl)
      }
    }
    const normalizedSkills = skills.map((skill) => ({ name: skill.name, path: skill.path }))
    const normalizedFileAttachments = fileAttachments.map((file) => ({ ...file }))

    setPendingTurnRequest(threadId, {
      text: normalizedText,
      imageUrls: [...normalizedImageUrls],
      skills: normalizedSkills,
      fileAttachments: normalizedFileAttachments,
      effort: reasoningEffort,
      collaborationMode,
      fallbackRetried: false,
    })

    try {
      if (shouldResumeThread(threadId)) {
        const resumedThread = await resumeThread(
          threadId,
          readModelIdForThread(threadId) || undefined,
          readThreadRpcProviderId(threadId) || undefined,
        )
        applyThreadModelStateWithProviderPriority(
          threadId,
          resumedThread.model,
          resumedThread.modelProvider,
        )
      }
      const modelId = readModelIdForThread(threadId)
      const modelProviderId = readThreadRpcProviderId(threadId)

      let startedTurnId = ''
      try {
        startedTurnId = await startThreadTurn(
          threadId,
          nextText,
          normalizedImageUrls,
          modelId || undefined,
          reasoningEffort || undefined,
          skills.length > 0 ? skills : undefined,
          fileAttachments,
          collaborationMode,
          modelProviderId || undefined,
        )
      } catch (unknownError) {
        if (modelId && modelId !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          await applyFallbackModelSelection(threadId)
          setPendingTurnRequest(threadId, {
            text: normalizedText,
            imageUrls: [...normalizedImageUrls],
            skills: normalizedSkills,
            fileAttachments: normalizedFileAttachments,
            effort: reasoningEffort,
            collaborationMode,
            fallbackRetried: true,
          })
          startedTurnId = await startThreadTurn(
            threadId,
            nextText,
            normalizedImageUrls,
            MODEL_FALLBACK_ID,
            reasoningEffort || undefined,
            skills.length > 0 ? skills : undefined,
            fileAttachments,
            collaborationMode,
            modelProviderId || undefined,
          )
        } else {
          throw unknownError
        }
      }

      if (startedTurnId) {
        setActiveTurnForThread(threadId, startedTurnId)
        if (modelProviderId) {
          activeTurnProviderIdByThreadId.value = {
            ...activeTurnProviderIdByThreadId.value,
            [threadId]: modelProviderId,
          }
        }
      }

      markThreadResumed(threadId, modelProviderId)

      pendingThreadMessageRefresh.add(threadId)
      await syncFromNotifications()
      scheduleDelayedTurnSync(threadId)
    } catch (unknownError) {
      throw unknownError
    }
  }

  async function startTurnAfterStaleSteer(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    collaborationModeOverride?: CollaborationModeKind,
  ): Promise<void> {
    console.warn('[DEBUG:sendMessageToSelectedThread] steer found no active turn — starting a new turn instead; threadId=%s', threadId)
    fetch('/codex-api/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag: 'send-steer-no-active-fallback',
        message: 'turn/steer found no active turn; starting a new turn',
        extra: { threadId },
      }),
    }).catch(() => {})

    clearActiveTurnForThread(threadId)
    setTurnSummaryForThread(threadId, null)
    setTurnErrorForThread(threadId, null)
    const selectedReasoningEffortForThread = readReasoningEffortForThread(threadId)
    setTurnActivityForThread(threadId, {
      label: 'Thinking',
      details: buildPendingTurnDetails(
        readModelIdForThread(threadId),
        selectedReasoningEffortForThread,
        collaborationModeOverride === 'plan'
          ? 'plan'
          : collaborationModeOverride === 'default'
            ? 'default'
            : selectedCollaborationMode.value,
      ),
    })
    setThreadInProgress(threadId, true)

    await startTurnForThread(
      threadId,
      nextText,
      imageUrls,
      skills,
      fileAttachments,
      collaborationModeOverride,
    )
  }

  async function processQueuedMessages(threadId: string): Promise<void> {
    if (queueProcessingByThreadId.value[threadId] === true) return
    queueProcessingByThreadId.value = {
      ...queueProcessingByThreadId.value,
      [threadId]: true,
    }
    try {
      queuedMessagesByThreadId.value = normalizeQueueStateFromPersistence(await getThreadQueueState())
    } catch {
      // Backend queue state is optional during transient bridge failures.
    } finally {
      queueProcessingByThreadId.value = omitKey(queueProcessingByThreadId.value, threadId)
    }
  }

  function scheduleQueueStateRefresh(threadId: string): void {
    void processQueuedMessages(threadId)
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      void processQueuedMessages(threadId)
    }, 650)
  }

  async function settleInterruptedTurnUiState(threadId: string): Promise<void> {
    clearActiveTurnForThread(threadId)
    setTurnActivityForThread(threadId, null)
    setTurnErrorForThread(threadId, null)
    pendingThreadMessageRefresh.add(threadId)
    pendingThreadsRefresh = true
    await syncFromNotifications()
  }

  // Synchronous counterpart of settleInterruptedTurnUiState: clears the
  // running-turn UI state once codex has confirmed the interrupt (RPC
  // success or "no active turn"). Called only after the backend agrees the
  // turn is stopped, so the sidebar never reports "done" prematurely.
  function settleStoppedTurnUiState(threadId: string): void {
    setThreadInProgress(threadId, false)
    clearActiveTurnForThread(threadId)
    setTurnActivityForThread(threadId, null)
    setTurnErrorForThread(threadId, null)
    error.value = ''
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    const threadId = selectedThreadId.value
    console.warn('[DEBUG:interruptSelectedThreadTurn] called — threadId=%s timestamp=%s stack=%s', threadId, new Date().toISOString(), new Error().stack?.split('\n').slice(2, 6).join('\n') || '(no stack)')
    const stackSummary = new Error().stack?.split('\n').slice(2, 5).join('\n') || '(no stack)'
    fetch('/codex-api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'interrupt-called', message: 'interruptSelectedThreadTurn', extra: { threadId, stack: stackSummary } }) }).catch(() => {})
    if (!threadId) return
    if (inProgressById.value[threadId] !== true) { console.warn('[DEBUG:interruptSelectedThreadTurn] skipped — thread not in progress'); return }
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] === true) { console.warn('[DEBUG:interruptSelectedThreadTurn] skipped — interrupt blocked (persistence gate)'); return }

    // Keep the UI showing "running" until codex confirms the turn actually
    // stopped. Clearing inProgress here would make the sidebar report
    // "done" while the backend can still be burning tokens. The stop button
    // shows a spinner via isInterruptingTurn while we wait for confirmation.
    const cachedTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
    const activeTurnProviderId = activeTurnProviderIdByThreadId.value[threadId]
      || readThreadRpcProviderId(threadId)

    isInterruptingTurn.value = true
    void (async () => {
      try {
        // Pause an active goal first so codex does not auto-continue the
        // turn after we interrupt it. The objective is preserved; resume
        // later with `/goal status active`.
        try {
          const goal = await getThreadGoal(threadId)
          if (goal && goal.status === 'active') {
            const paused = await setThreadGoal(threadId, { status: 'paused' })
            setThreadNoticeForThread(threadId, goalNoticeForGoal(paused))
          }
        } catch {
          // best-effort; do not block the interrupt on goal pause failure
        }

        let turnId = cachedTurnId
        if (!turnId) {
          const refreshed = await refreshActiveTurnStateForThread(threadId)
          turnId = refreshed.activeTurnId
        }
        if (turnId) {
          try {
            await interruptActiveTurnWithRefresh(threadId, turnId, activeTurnProviderId || undefined)
            settleStoppedTurnUiState(threadId)
          } catch (rpcError) {
            if (isNoActiveTurnToInterruptError(rpcError)) {
              settleStoppedTurnUiState(threadId)
            } else {
              const message = rpcError instanceof Error ? rpcError.message : 'Failed to interrupt active turn'
              console.warn('[DEBUG:interruptSelectedThreadTurn] soft interrupt RPC failed - threadId=%s error=%s', threadId, message)
              fetch('/codex-api/debug-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tag: 'interrupt-soft-rpc-failed',
                  message,
                  extra: { threadId, turnId },
                }),
              }).catch(() => {})
            }
          }
        } else {
          settleStoppedTurnUiState(threadId)
        }
        pendingThreadMessageRefresh.add(threadId)
        pendingThreadsRefresh = true
        await syncFromNotifications()
      } finally {
        // If the interrupt never confirmed, inProgress is left alone so the
        // sidebar keeps truthfully showing "running" instead of "done".
        isInterruptingTurn.value = false
      }
    })()
  }

  async function rollbackSelectedThread(turnId: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (isRollingBack.value) return
    if (!turnId.trim()) return

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const matchedMessage = persisted.find((message) => message.turnId === turnId)
    const turnIndex = typeof matchedMessage?.turnIndex === 'number' ? matchedMessage.turnIndex : -1
    if (turnIndex < 0) return
    const maxTurnIndex = persisted.reduce((max, m) => (typeof m.turnIndex === 'number' && m.turnIndex > max ? m.turnIndex : max), -1)
    if (maxTurnIndex < 0 || turnIndex > maxTurnIndex) return
    const numTurns = maxTurnIndex - turnIndex + 1
    if (numTurns < 1) return

    isRollingBack.value = true
    error.value = ''
    try {
      const threadCwd = selectedThread.value?.cwd?.trim() ?? ''
      if (threadCwd) {
        await revertThreadFileChanges(threadId, turnId, threadCwd)
      }
      const nextMessages = await rollbackThread(threadId, numTurns)
      invalidateFullHistoryForThread(threadId)
      setPersistedMessagesForThread(threadId, nextMessages)
      setLiveAgentMessagesForThread(threadId, [])
      clearLiveReasoningForThread(threadId)
      if (liveCommandsByThreadId.value[threadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
      }
      clearLiveToolCallsForThread(threadId)
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rollback thread'
    } finally {
      isRollingBack.value = false
    }
  }

  let renameProjectTimer: ReturnType<typeof setTimeout> | null = null

  async function persistProjectLabelToGlobalState(projectName: string, displayName: string): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextLabels = { ...rootsState.labels }
      let changed = false
      for (const rootPath of rootsState.order) {
        if (!matchesWorkspaceRootProject(rootPath, projectName)) continue
        const trimmed = displayName.trim()
        if (trimmed.length === 0) {
          if (nextLabels[rootPath] !== undefined) {
            delete nextLabels[rootPath]
            changed = true
          }
        } else if (nextLabels[rootPath] !== trimmed) {
          nextLabels[rootPath] = trimmed
          changed = true
        }
      }
      if (changed) {
        await setWorkspaceRootsState({
          order: rootsState.order,
          labels: nextLabels,
          active: rootsState.active,
          projectOrder: rootsState.projectOrder,
        })
      }
    } catch {
      // Keep localStorage-only rename when global state is unavailable.
    }
  }

  function renameProject(projectName: string, displayName: string): void {
    if (projectName.length === 0) return

    const currentValue = projectDisplayNameById.value[projectName] ?? ''
    if (currentValue === displayName) return

    projectDisplayNameById.value = {
      ...projectDisplayNameById.value,
      [projectName]: displayName,
    }
    saveProjectDisplayNames(projectDisplayNameById.value)

    if (renameProjectTimer !== null) clearTimeout(renameProjectTimer)
    renameProjectTimer = setTimeout(() => {
      renameProjectTimer = null
      void persistProjectLabelToGlobalState(projectName, displayName)
    }, 500)
  }

  async function removeProject(projectName: string): Promise<void> {
    if (projectName.length === 0) return

    const nextProjectOrder = projectOrder.value.filter((name) => name !== projectName)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }

    sourceGroups.value = sourceGroups.value.filter((group) => group.projectName !== projectName)

    if (projectDisplayNameById.value[projectName] !== undefined) {
      const nextDisplayNames = { ...projectDisplayNameById.value }
      delete nextDisplayNames[projectName]
      projectDisplayNameById.value = nextDisplayNames
      saveProjectDisplayNames(nextDisplayNames)
    }

    applyThreadFlags()

    const flatThreads = flattenThreads(projectGroups.value)
    pruneThreadScopedState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)
    if (!currentExists) {
      setSelectedThreadId(flatThreads[0]?.id ?? '')
    }

    const removedRootPaths = new Set<string>()
    try {
      const rootsState = await getWorkspaceRootsState()
      collectWorkspaceRootPathsForProjectRemoval(rootsState, projectName).forEach((rootPath) => {
        removedRootPaths.add(rootPath)
      })
    } catch {
      // Keep local-only removal when global state is unavailable.
    }

    if (removedRootPaths.size > 0) {
      try {
        const rootsState = await getWorkspaceRootsState()
        const nextOrder = rootsState.order.filter((rootPath) => !removedRootPaths.has(rootPath))
        const nextActive = rootsState.active.filter((rootPath) => !removedRootPaths.has(rootPath))
        const fallbackActive = nextActive.length === 0 && nextOrder.length > 0
          ? [nextOrder[0]]
          : nextActive
        await setWorkspaceRootsState({
          order: nextOrder,
          labels: omitKeys(rootsState.labels, removedRootPaths),
          active: fallbackActive,
          projectOrder: rootsState.projectOrder.filter((item) => item !== projectName && !removedRootPaths.has(item)),
        })
        return
      } catch {
        // Fall back to order-only persistence if direct removal fails.
      }
    }

    await persistProjectOrderToWorkspaceRoots()
  }

  function reorderProject(projectName: string, toIndex: number): void {
    if (projectName.length === 0) return
    if (sourceGroups.value.length === 0) return

    const visibleOrder = sourceGroups.value.map((group) => group.projectName)
    const fromIndex = visibleOrder.indexOf(projectName)
    if (fromIndex === -1) return

    const clampedToIndex = Math.max(0, Math.min(toIndex, visibleOrder.length - 1))
    const reorderedVisibleOrder = reorderStringArray(visibleOrder, fromIndex, clampedToIndex)
    if (reorderedVisibleOrder === visibleOrder) return

    const normalizedProjectOrder = mergeProjectOrder(reorderedVisibleOrder, sourceGroups.value)
    projectOrder.value = normalizedProjectOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  function pinProjectToTop(projectName: string): void {
    const normalizedName = projectName.trim()
    if (!normalizedName) return
    const nextOrder = [normalizedName, ...projectOrder.value.filter((name) => name !== normalizedName)]
    if (areStringArraysEqual(projectOrder.value, nextOrder)) return
    projectOrder.value = nextOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  async function persistProjectOrderToWorkspaceRoots(): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextState = buildWorkspaceRootsProjectOrderState(rootsState, projectOrder.value, sourceGroups.value)

      await setWorkspaceRootsState({
        order: nextState.order,
        labels: rootsState.labels,
        active: nextState.active,
        projectOrder: nextState.projectOrder,
      })
    } catch {
      // Keep local project order when global state persistence is unavailable.
    }
  }

  async function syncThreadStatus(): Promise<void> {
    if (isPolling.value) return
    isPolling.value = true

    try {
      await loadThreads()

      if (!selectedThreadId.value) return

      const threadId = selectedThreadId.value
      const currentVersion = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
      const isInProgress = inProgressById.value[threadId] === true

      if (isInProgress || hasVersionChange) {
        await loadMessages(threadId, { silent: true })
      }
    } catch {
      // ignore poll failures and keep last known state
    } finally {
      isPolling.value = false
    }
  }

  async function syncFromNotifications(): Promise<void> {
    if (isPolling.value) {
      if (typeof window !== 'undefined' && eventSyncTimer === null) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
      return
    }

    isPolling.value = true

    const shouldRefreshThreads = pendingThreadsRefresh
    const threadIdsToRefresh = new Set(pendingThreadMessageRefresh)
    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()

    try {
      if (shouldRefreshThreads) {
        await loadThreads()
      }

      const activeThreadId = selectedThreadId.value
      if (!activeThreadId) return

      const isActiveDirty = threadIdsToRefresh.has(activeThreadId)
      const isInProgress = inProgressById.value[activeThreadId] === true
      const currentVersion = currentThreadVersion(activeThreadId)
      const loadedVersion = loadedVersionByThreadId.value[activeThreadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

      const shouldRefreshActiveThread =
        hasVersionChange ||
        (isActiveDirty && isInProgress) ||
        (isInProgress && loadedMessagesByThreadId.value[activeThreadId] !== true) ||
        (isActiveDirty && loadedMessagesByThreadId.value[activeThreadId] !== true) ||
        (shouldRefreshThreads && loadedMessagesByThreadId.value[activeThreadId] !== true)

      if (shouldRefreshActiveThread) {
        await loadMessages(activeThreadId, { silent: true })
      }
    } catch {
      // Keep UI stable on transient event sync failures.
    } finally {
      isPolling.value = false

      if (
        (pendingThreadsRefresh || pendingThreadMessageRefresh.size > 0) &&
        typeof window !== 'undefined' &&
        eventSyncTimer === null
      ) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
    }
  }

  async function recoverBridgeState(): Promise<void> {
    await loadPendingServerRequestsFromBridge()
    pendingThreadsRefresh = !hasLoadedThreads.value
    if (
      selectedThreadId.value &&
      loadedMessagesByThreadId.value[selectedThreadId.value] !== true
    ) {
      pendingThreadMessageRefresh.add(selectedThreadId.value)
    }
    await syncFromNotifications()
  }

  function startPolling(): void {
    if (typeof window === 'undefined') return

    if (stopNotificationStream) return
    void loadPendingServerRequestsFromBridge()
    stopNotificationStream = subscribeCodexNotifications((notification) => {
      if (notification.method === 'ready') {
        clearAllTransientTurnErrors()
        void recoverBridgeState()
        return
      }
      applyRealtimeUpdates(notification)
      queueEventDrivenSync(notification)
    })
  }

  async function loadPendingServerRequestsFromBridge(): Promise<void> {
    try {
      const rows = await getPendingServerRequests()
      const normalizedRequests = rows
        .map((row) => normalizeServerRequest(row))
        .filter((request): request is UiServerRequest => request !== null)
      replacePendingServerRequests(normalizedRequests)
    } catch {
      // Keep UI usable when pending request endpoint is temporarily unavailable.
    }
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<boolean> {
    try {
      await replyToServerRequest(reply.id, {
        result: reply.result,
        error: reply.error,
      })
      removePendingServerRequestById(reply.id)
      return true
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to reply to server request'
      return false
    }
  }

  function stopPolling(): void {
    if (stopNotificationStream) {
      stopNotificationStream()
      stopNotificationStream = null
    }

    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()
    pendingTurnStartsById.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    if (rateLimitRefreshTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(rateLimitRefreshTimer)
      rateLimitRefreshTimer = null
    }
    if (threadListBackgroundTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(threadListBackgroundTimer)
      threadListBackgroundTimer = null
    }
    if (typeof window !== 'undefined') {
      for (const timerId of delayedTurnSyncTimerByThreadId.values()) {
        window.clearTimeout(timerId)
      }
    }
    delayedTurnSyncTimerByThreadId.clear()
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
    persistedMessagesByThreadId.value = {}
    fullHistoryMessagesByThreadId.value = {}
    loadedFullHistoryByThreadId.value = {}
    loadingFullHistoryByThreadId.value = {}
    loadFullHistoryPromiseByThreadId.clear()
    livePlanMessagesByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveReasoningTextByThreadId.value = {}
    liveCommandsByThreadId.value = {}
    liveFileChangeMessagesByThreadId.value = {}
    liveToolCallMessagesByThreadId.value = {}
    turnIndexByTurnIdByThreadId.value = {}
    turnActivityByThreadId.value = {}
    turnSummaryByThreadId.value = {}
    turnErrorByThreadId.value = {}
    threadNoticeByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
    activeTurnProviderIdByThreadId.value = {}
    interruptBlockedUntilPersistedByThreadId.value = {}
    threadListedByServerById.value = {}
    persistedUserMessageByThreadId.value = {}
    queuedMessagesByThreadId.value = {}
    queueProcessingByThreadId.value = {}
    persistQueueState()
    codexRateLimit.value = null
    threadTokenUsageByThreadId.value = {}
  }

  const selectedThreadQueuedMessages = computed<QueuedMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []
    return queuedMessagesByThreadId.value[threadId] ?? []
  })

  function removeQueuedMessage(messageId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const next = queue.filter((m) => m.id !== messageId)
    queuedMessagesByThreadId.value = next.length > 0
      ? { ...queuedMessagesByThreadId.value, [threadId]: next }
      : omitKey(queuedMessagesByThreadId.value, threadId)
    persistQueueState()
  }

  function reorderQueuedMessage(draggedId: string, targetId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return

    const fromIndex = queue.findIndex((m) => m.id === draggedId)
    const toIndex = queue.findIndex((m) => m.id === targetId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return

    const next = [...queue]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    queuedMessagesByThreadId.value = {
      ...queuedMessagesByThreadId.value,
      [threadId]: next,
    }
    persistQueueState()
  }

  function steerQueuedMessage(messageId: string): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const msg = queue.find((m) => m.id === messageId)
    if (!msg) return
    removeQueuedMessage(messageId)
    setSelectedCollaborationMode(msg.collaborationMode)
    void sendMessageToSelectedThread(msg.text, msg.imageUrls, msg.skills, 'steer', msg.fileAttachments)
  }

  async function runGoalSlashCommandForThread(threadId: string, text: string): Promise<boolean> {
    const command = parseGoalSlashCommand(text)
    if (!command) return false

    error.value = ''
    setTurnErrorForThread(threadId, null)

    try {
      if (command.kind === 'show') {
        const goal = await getThreadGoal(threadId)
        setThreadNoticeForThread(threadId, goal
          ? goalNoticeForGoal(goal)
          : {
              label: 'No goal set',
              text: 'Use /goal <objective> to start one.',
            })
        return true
      }

      if (command.kind === 'clear') {
        const cleared = await clearThreadGoal(threadId)
        setThreadNoticeForThread(threadId, cleared
          ? null
          : {
              label: 'No goal to clear',
              text: 'This thread does not currently have a goal.',
            })
        return true
      }

      const goal = command.kind === 'status'
        ? await setThreadGoal(threadId, { status: command.status })
        : await setThreadGoal(threadId, {
            objective: command.objective,
            status: 'active',
          })
      setThreadNoticeForThread(threadId, goalNoticeForGoal(goal))
      return true
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setThreadNoticeForThread(threadId, null)
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw unknownError
    }
  }

  function primeSelectedThread(threadId: string): void {
    preserveUnlistedSelectedThread = threadId.trim().length > 0
    setSelectedThreadId(threadId)
  }

  return {
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadInProgress,
    selectedThreadTokenUsage,
    selectedThreadTerminalOpen,
    isSelectedThreadInterruptPending,
    selectedThreadServerRequests,
    selectedLiveOverlay,
    codexQuota,
    selectedThreadId,
    availableCollaborationModes,
    availableModelIds,
    selectedCollaborationMode,
    selectedModelId,
    selectedProvider,
    selectedReasoningEffort,
    selectedSpeedMode,
    codexCliMissingError,
    installedSkills,
    accountRateLimitSnapshots,
    messages,
    messageNavigationMessages,
    hasMoreOlderMessages,
    isLoadingThreads,
    isThreadListFullyLoaded,
    isLoadingMessages,
    isLoadingMessageNavigation,
    userMessageNavigationTotal,
    userMessageNavigationIndex,
    isLoadingUserMessageNavigationIndex,
    isLoadingOlderMessages,
    isSendingMessage,
    isInterruptingTurn,
    isUpdatingSpeedMode,
    isRollingBack,

    error,
    refreshAll,
    refreshSkills,
    refreshMoonBridgeModelIds,
    refreshAncillaryState,
    invalidateAppServerRuntimeState,
    selectThread,
    loadMessages,
    loadOlderMessages,
    loadThreadMessageWindow,
    ensureThreadMessagesLoaded,
    ensureMessageLoaded,
    loadFullHistoryMessages,
    loadUserMessageCount,
    ensureUserMessageCountLoaded,
    loadUserMessageIndex,
    ensureUserMessageIndexLoaded,
    setThreadTerminalOpen,
    toggleSelectedThreadTerminal,
    archiveThreadById,
    renameThreadById,
    forkThreadById,
    forkThreadFromTurn,
    rollbackSelectedThread,

    sendMessageToSelectedThread,
    sendMessageToThread,
    sendMessageToNewThread,
    interruptSelectedThreadTurn,
    selectedThreadQueuedMessages,
    removeQueuedMessage,
    reorderQueuedMessage,
    steerQueuedMessage,
    setSelectedCollaborationMode,
    readModelIdForThread,
    readReasoningEffortForThread,
    setSelectedModelIdForThread,
    setSelectedModelId,
    setSelectedProviderForComposerContext,
    setSelectedProvider,

    setSelectedReasoningEffortForThread,
    setSelectedReasoningEffort,
    updateSelectedSpeedMode,
    respondToPendingServerRequest,
    renameProject,
    removeProject,
    reorderProject,
    pinProjectToTop,
    startPolling,
    stopPolling,
    primeSelectedThread,
  }
}
