import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, mkdir, stat, cp, lstat, readlink, symlink } from 'node:fs/promises'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { writeDebugLog } from './debugLog.js'
import { handleAccountRoutes } from './accountRoutes.js'
import { buildAppServerArgs } from './appServerRuntimeConfig.js'
import { callRpcWithRateLimitDecodeRecovery } from './rateLimitDecodeRecovery.js'
import { handleReviewRoutes } from './reviewGit.js'
import { handleSkillsRoutes, initializeSkillsSyncOnStartup } from './skillsRoutes.js'
import { TelegramThreadBridge } from './telegramThreadBridge.js'
import {
  getRandomFreeKey,
  getFreeKeyCount,
  ARK_PROVIDER_ID,
  getArkModelMetadata,
  getArkModelSelection,
  getArkModels,
  FREE_MODE_PROVIDER_ID,
  FREE_MODE_DEFAULT_MODEL,
  createDefaultFreeModeState,
  getCachedFreeModels,
  getCursorModelSelection,
  getFreeModels,
  refreshFreeModelsInBackground,
  FREE_MODE_STATE_FILE,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_PROVIDER_ID,
  createDefaultOpenCodeZenFreeModeState,
  CURSOR_PROVIDER_ID,
  MOONBRIDGE_PROVIDER_ID,
  getMoonBridgeModelMetadata,
  getMoonBridgeModels,
  getFreeModeConfigArgs,
  getFreeModeEnvVars,
  normalizeFreeModeState,
  shouldCreateDefaultFreeModeStateForMissingAuth,
  type FreeModeState,
} from './freeMode.js'
import { handleOpenRouterProxyRequest } from './openRouterProxy.js'
import { handleZenProxyRequest } from './zenProxy.js'
import { handleCustomEndpointProxyRequest } from './customEndpointProxy.js'
import {
  buildCodexUiProviderConfigArgs,
  type CodexUiProviderDescriptor,
  fetchCodexUiProviderModelIds,
  getCodexUiProviderCatalogSelection,
  readCodexUiProviderDescriptor,
  readCodexUiProviderDescriptors,
} from './codexUiProviders.js'
import { ThreadTerminalManager } from './terminalManager.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import {
  resolveExecutableCommand,
  resolveCodexCommand,
  resolveCodexArkCommand,
  resolveCodexCursorCommand,
  resolveCodexMoonCommand,
} from '../commandResolution.js'
import type { CollaborationModeKind, ReasoningEffort, UiFileChange, UiMessage, UiThread } from '../types/codex.js'
import { isAbsoluteLikePath, toProjectName } from '../pathUtils.js'
import { searchComposerPaths } from './composerFileSearch.js'
import { normalizeThreadMessagesV2 } from '../api/normalizers/v2.js'

type JsonRpcCall = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: unknown
}

type RpcProxyRequest = {
  method: string
  params?: unknown
}

type RpcExecutor = {
  rpc: (method: string, params: unknown) => Promise<unknown>
}

const THREAD_MODEL_PROVIDER_OVERRIDE_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/fork',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
])

function isInterruptedTurnAutoContinueEnabled(): boolean {
  return process.env.CODEXUI_AUTO_CONTINUE_INTERRUPTED_TURNS !== '0'
}

type ServerRequestReply = {
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
  projectOrder: string[]
  remoteProjects: Array<{
    id: string
    hostId: string
    remotePath: string
    label: string
  }>
}

type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

type ChatgptAuthTokensRefreshParams = {
  reason?: string
  previousAccountId?: string | null
}

type ChatgptAuthTokensRefreshResponse = {
  accessToken: string
  chatgptAccountId: string
  chatgptPlanType: string | null
}

type ThreadSearchDocument = {
  id: string
  title: string
  preview: string
  messageText: string
  searchableText: string
}

type ThreadSearchIndex = {
  docsById: Map<string, ThreadSearchDocument>
}

export type ThreadMessageSearchResult = {
  id: string
  turnId: string
  turnIndex: number
  messageId: string
  role: 'user' | 'assistant' | 'system'
  messageType: string
  occurrenceIndex: number
  snippet: string
  snippetMatchStart: number
  snippetMatchEnd: number
}

type RankedThreadMessageSearchResult = ThreadMessageSearchResult & {
  rowOrder: number
  matchStart: number
}

type ThreadMessageSearchResponse = {
  threadId: string
  query: string
  totalMatches: number
  truncated: boolean
  results: ThreadMessageSearchResult[]
}

type ThreadMessageSearchRow = {
  message: UiMessage
  text: string
}

type ProviderModelsResponse = {
  data: string[]
  providerId: string
  source: 'provider' | 'codex-ui-catalog' | 'codex-ui-provider' | 'codex-ui-default'
}

type ComposioUserData = {
  apiKey: string
  baseUrl: string
  webUrl: string
  orgId: string
  testUserId: string
}

type ComposioStatusResponse = {
  available: boolean
  authenticated: boolean
  cliVersion: string
  email: string
  defaultOrgName: string
  defaultOrgId: string
  webUrl: string
  baseUrl: string
  testUserId: string
}

type ComposioConnectionSummary = {
  id: string
  wordId: string
  alias: string
  status: string
  authScheme: string
  createdAt: string
  updatedAt: string
  isComposioManaged: boolean
  isDisabled: boolean
}

type ComposioConnectorSummary = {
  slug: string
  name: string
  description: string
  logoUrl: string
  latestVersion: string
  toolsCount: number
  triggersCount: number
  isNoAuth: boolean
  enabled: boolean
  authModes: string[]
  activeCount: number
  totalConnections: number
  connectionStatuses: string[]
}

type ComposioToolSummary = {
  slug: string
  name: string
  description: string
}

type ComposioConnectorDetail = {
  connector: ComposioConnectorSummary
  connections: ComposioConnectionSummary[]
  tools: ComposioToolSummary[]
  dashboardUrl: string
}

type ComposioLinkResult = {
  status: string
  message: string
  connectedAccountId: string
  redirectUrl: string
  toolkit: string
  projectType: string
}

type ComposioLoginResult = {
  status: string
  message: string
  loginUrl: string
  cliKey: string
  expiresAt: string
}

type ComposioInstallResult = {
  ok: boolean
  command: string
  output: string
}

type ComposioConnectorPage = {
  data: ComposioConnectorSummary[]
  nextCursor: string | null
  total: number
}

const COMPOSIO_CONNECTORS_PAGE_LIMIT_MAX = 1000

const PROVIDER_MODELS_FETCH_TIMEOUT_MS = 5_000

const THREAD_RESPONSE_TURN_LIMIT = 3
const THREAD_TURN_PAGE_READ_CACHE_TTL_MS = 30_000
const THREAD_TURNS_LIST_PAGE_LIMIT = 100
const THREAD_METHODS_WITH_TURNS = new Set(['thread/read', 'thread/resume', 'thread/fork', 'thread/rollback'])
const THREAD_METHODS_WITH_THREAD_SNAPSHOT = new Set([...THREAD_METHODS_WITH_TURNS, 'thread/start'])
const THREAD_SEARCH_FULL_TEXT_THREAD_LIMIT = 100
const THREAD_MESSAGE_SEARCH_DEFAULT_LIMIT = 100
const THREAD_MESSAGE_SEARCH_MAX_LIMIT = 500
const THREAD_MESSAGE_SEARCH_SNIPPET_CONTEXT = 72
const CURSOR_CONTEXT_AUTO_COMPACT_COOLDOWN_MS = 60_000
const PROJECTLESS_THREAD_DIRECTORY_MAX_ATTEMPTS = 100
const PROJECTLESS_THREAD_SLUG_MAX_LENGTH = 80
const API_PERF_LOGGING_ENV_KEY = 'CODEXUI_API_PERF_LOGGING'
const API_PERF_MS_THRESHOLD_ENV_KEY = 'CODEXUI_API_PERF_MS_THRESHOLD'
const API_PERF_BODY_MB_THRESHOLD_ENV_KEY = 'CODEXUI_API_PERF_BODY_MB_THRESHOLD'
const DEFAULT_API_PERF_MS_THRESHOLD = 300
const DEFAULT_API_PERF_BODY_MB_THRESHOLD = 1
const MB_DIVISOR = 1024 * 1024
const COMPOSIO_USER_DATA_PATH = join(homedir(), '.composio', 'user_data.json')

type SessionRecoveredFileChange = {
  path: string
  operation: 'add' | 'delete' | 'update'
  movedToPath: string | null
  diff: string
  addedLineCount: number
  removedLineCount: number
}

type SessionRecoveredTurnFileChanges = {
  turnId: string
  turnIndex: number
  fileChanges: SessionRecoveredFileChange[]
}

type SessionRecoveredSkillInput = {
  name: string
  path: string
}

type SessionRecoveredModelState = {
  model: string
  modelProvider: string
  reasoningEffort: ReasoningEffort | ''
  activeTurnId?: string
  rolloutTurnState?: 'active' | 'terminal'
}

type SessionRolloutRow = {
  row: Record<string, unknown>
  payload: Record<string, unknown> | null
  lineEndByteOffset: number
}

type SessionRolloutSnapshot = {
  size: number
  mtimeMs: number
  raw: string
  rows: SessionRolloutRow[]
  modelState: SessionRecoveredModelState
  userMessageIndex: SessionUserMessageIndexEntry[]
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>
  contextsByTurnId: Map<string, string[]>
  turnEnds: Map<string, SessionTurnEnd>
}

const SESSION_ROLLOUT_SNAPSHOT_CACHE_LIMIT = 64
const SESSION_ROLLOUT_SNAPSHOT_BYTE_LIMIT = 64 * 1024 * 1024
const sessionRolloutSnapshotCache = new Map<string, SessionRolloutSnapshot>()
const sessionRolloutSnapshotPromiseByPath = new Map<string, Promise<SessionRolloutSnapshot>>()
let sessionRolloutSnapshotBytes = 0

function parseSessionRolloutRows(sessionLogRaw: string): SessionRolloutRow[] {
  const rows: SessionRolloutRow[] = []
  let byteOffset = 0
  const lines = sessionLogRaw.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? ''
    byteOffset += Buffer.byteLength(rawLine, 'utf8') + (lineIndex < lines.length - 1 ? 1 : 0)
    if (!rawLine.trim()) continue
    try {
      const row = asRecord(JSON.parse(rawLine) as unknown)
      if (row) rows.push({ row, payload: asRecord(row.payload), lineEndByteOffset: byteOffset })
    } catch {
      // Ignore incomplete or legacy-invalid JSONL rows.
    }
  }
  return rows
}

function pruneSessionRolloutSnapshotCache(): void {
  while (
    sessionRolloutSnapshotCache.size > SESSION_ROLLOUT_SNAPSHOT_CACHE_LIMIT
    || sessionRolloutSnapshotBytes > SESSION_ROLLOUT_SNAPSHOT_BYTE_LIMIT
  ) {
    const oldestPath = sessionRolloutSnapshotCache.keys().next().value
    if (!oldestPath) break
    const oldest = sessionRolloutSnapshotCache.get(oldestPath)
    sessionRolloutSnapshotCache.delete(oldestPath)
    sessionRolloutSnapshotBytes = Math.max(0, sessionRolloutSnapshotBytes - (oldest?.size ?? 0))
  }
}

async function readSessionRolloutSnapshot(sessionPath: string): Promise<SessionRolloutSnapshot> {
  const pending = sessionRolloutSnapshotPromiseByPath.get(sessionPath)
  if (pending) return await pending

  const promise = (async () => {
    const sessionStat = await stat(sessionPath)
    const cached = sessionRolloutSnapshotCache.get(sessionPath)
    if (cached && cached.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      sessionRolloutSnapshotCache.delete(sessionPath)
      sessionRolloutSnapshotCache.set(sessionPath, cached)
      return cached
    }

    const raw = await readFile(sessionPath, 'utf8')
    const rows = parseSessionRolloutRows(raw)
    const snapshot: SessionRolloutSnapshot = {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      raw,
      rows,
      modelState: buildSessionModelStateFromRows(rows),
      userMessageIndex: buildSessionUserMessageIndexFromRows(rows),
      skillsByTurnId: buildSessionSkillInputsByTurnFromRows(rows),
      contextsByTurnId: buildSessionUserPromptAdditionalContextsByTurnFromRows(rows),
      turnEnds: buildSessionTurnEndsFromRows(rows),
    }
    if (cached) sessionRolloutSnapshotBytes = Math.max(0, sessionRolloutSnapshotBytes - cached.size)
    sessionRolloutSnapshotCache.delete(sessionPath)
    sessionRolloutSnapshotCache.set(sessionPath, snapshot)
    sessionRolloutSnapshotBytes += snapshot.size
    pruneSessionRolloutSnapshotCache()
    return snapshot
  })().finally(() => {
    sessionRolloutSnapshotPromiseByPath.delete(sessionPath)
  })

  sessionRolloutSnapshotPromiseByPath.set(sessionPath, promise)
  return await promise
}

function normalizeSessionReasoningEffort(value: unknown): ReasoningEffort | '' {
  const normalized = readNonEmptyString(value).trim().toLowerCase()
  if (
    normalized === 'none'
    || normalized === 'minimal'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'xhigh'
    || normalized === 'max'
  ) {
    return normalized
  }
  return ''
}

export function buildSessionModelState(sessionLogRaw: string): SessionRecoveredModelState {
  return buildSessionModelStateFromRows(parseSessionRolloutRows(sessionLogRaw))
}

function buildSessionModelStateFromRows(rows: SessionRolloutRow[]): SessionRecoveredModelState {
  const state: SessionRecoveredModelState = {
    model: '',
    modelProvider: '',
    reasoningEffort: '',
  }

  const applySettings = (settings: Record<string, unknown>): void => {
    const collaborationMode = asRecord(settings.collaboration_mode)
    const collaborationSettings = asRecord(collaborationMode?.settings)

    state.model = readNonEmptyString(settings.model)
      || readNonEmptyString(collaborationSettings?.model)
      || state.model
    state.modelProvider = readNonEmptyString(settings.model_provider_id)
      || readNonEmptyString(settings.model_provider)
      || readNonEmptyString(settings.modelProvider)
      || readNonEmptyString(collaborationSettings?.model_provider)
      || readNonEmptyString(collaborationSettings?.modelProvider)
      || state.modelProvider
    state.reasoningEffort = normalizeSessionReasoningEffort(settings.effort)
      || normalizeSessionReasoningEffort(settings.reasoning_effort)
      || normalizeSessionReasoningEffort(settings.reasoningEffort)
      || normalizeSessionReasoningEffort(collaborationSettings?.reasoning_effort)
      || normalizeSessionReasoningEffort(collaborationSettings?.reasoningEffort)
      || state.reasoningEffort
  }

  for (const { row, payload: payloadRecord } of rows) {
    if (!payloadRecord) continue

    if (row.type === 'session_meta') {
      state.modelProvider = readNonEmptyString(payloadRecord.model_provider)
        || readNonEmptyString(payloadRecord.modelProvider)
        || state.modelProvider
      continue
    }

    if (row.type === 'event_msg') {
      const eventType = readNonEmptyString(payloadRecord.type)
      const turnId = readNonEmptyString(payloadRecord.turn_id)
      if (eventType === 'task_started' && turnId) {
        state.activeTurnId = turnId
        state.rolloutTurnState = 'active'
      } else if ((eventType === 'task_complete' || eventType === 'task_aborted' || eventType === 'turn_aborted') && (!turnId || turnId === state.activeTurnId)) {
        delete state.activeTurnId
        if (state.rolloutTurnState === 'active') {
          state.rolloutTurnState = 'terminal'
        }
      }
      if (eventType === 'thread_settings_applied') {
        const threadSettings = asRecord(payloadRecord.thread_settings)
        if (threadSettings) applySettings(threadSettings)
      }
      continue
    }

    if (row.type !== 'turn_context') continue
    applySettings(payloadRecord)
  }

  return state
}

async function readCachedSessionModelState(sessionPath: string): Promise<SessionRecoveredModelState> {
  return (await readSessionRolloutSnapshot(sessionPath)).modelState
}

export function countSessionUserMessages(sessionLogRaw: string): number {
  return buildSessionUserMessageIndex(sessionLogRaw).length
}

type SessionUserMessageIndexEntry = {
  turnId: string
  ordinal: number
  preview: string
  title: string
  kind?: 'forkBoundary'
  sourceThreadId?: string
}

const USER_MESSAGE_PREVIEW_TITLE_MAX_LENGTH = 320
const USER_MESSAGE_PREVIEW_TEXT_MAX_LENGTH = 88

function normalizeSessionUserMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function truncateForPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return '…'
  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

const USER_MESSAGE_MARKER_REGEX = /(?:^|\n)\s{0,3}#{0,6}\s*my request for codex\s*:?\s*/giu

function extractSessionUserMessageBody(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  // Strip the same "# My request for Codex:" preamble the frontend removes
  // so the dropdown preview matches what the user actually typed.
  const matches = Array.from(trimmed.matchAll(USER_MESSAGE_MARKER_REGEX))
  if (matches.length === 0) return trimmed
  const lastMatch = matches[matches.length - 1]
  if (!lastMatch || typeof lastMatch.index !== 'number') return trimmed
  return trimmed.slice(lastMatch.index + lastMatch[0].length).trim()
}

function readSessionUserMessageText(payload: Record<string, unknown>): string {
  // Like readSessionMessageText, but also accepts input_text blocks, which
  // are what user response_item rows actually use in the rollout log.
  const content = payload.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    const blockRecord = asRecord(block)
    const text = typeof blockRecord?.text === 'string' ? blockRecord.text : ''
    if (!text) continue
    const type = typeof blockRecord?.type === 'string' ? blockRecord.type : ''
    if (type && type !== 'text' && type !== 'input_text' && type !== 'output_text') continue
    parts.push(text)
  }
  return parts.join('')
}

export function buildSessionUserMessageIndex(sessionLogRaw: string): SessionUserMessageIndexEntry[] {
  return buildSessionUserMessageIndexFromRows(parseSessionRolloutRows(sessionLogRaw))
}

function buildSessionUserMessageIndexFromRows(rows: SessionRolloutRow[]): SessionUserMessageIndexEntry[] {
  // Produce one entry per turn that contains at least one user message.
  // Preview text is drawn from the *last* user response_item in the turn,
  // which matches how codex app-server merges them: the final block is the
  // actual user prompt after AGENTS.md preambles / files-mentioned sections.
  let currentTurnId = ''
  let orphanTurnKey = 0
  const orderedTurns: string[] = []
  const textByTurn = new Map<string, string>()

  for (const { row, payload } of rows) {
    if (row.type === 'turn_context') {
      currentTurnId = readNonEmptyString(payload?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      if (payload?.type === 'task_started') {
        currentTurnId = readNonEmptyString(payload.turn_id) || currentTurnId
      } else if (payload?.type === 'task_complete') {
        currentTurnId = ''
      }
      continue
    }
    if (row.type !== 'response_item') continue
    if (payload?.type !== 'message' || payload.role !== 'user') continue

    let turnKey = currentTurnId
    if (!turnKey) {
      orphanTurnKey += 1
      turnKey = `__orphan-${orphanTurnKey}`
    }
    if (!textByTurn.has(turnKey)) orderedTurns.push(turnKey)
    const text = readSessionUserMessageText(payload)
    const body = extractSessionUserMessageBody(text)
    if (body) {
      textByTurn.set(turnKey, body)
    } else if (!textByTurn.get(turnKey)) {
      // Only fall back to the raw text if nothing better has been seen yet.
      textByTurn.set(turnKey, text.trim())
    }
  }

  return orderedTurns.map((turnKey, index) => {
    const rawTitle = textByTurn.get(turnKey) ?? ''
    const normalized = normalizeSessionUserMessageText(rawTitle) || '(empty message)'
    const title = truncateForPreview(normalized, USER_MESSAGE_PREVIEW_TITLE_MAX_LENGTH)
    const preview = truncateForPreview(normalized, USER_MESSAGE_PREVIEW_TEXT_MAX_LENGTH)
    return {
      turnId: turnKey,
      ordinal: index + 1,
      preview,
      title,
    }
  })
}

async function readCachedSessionUserMessageIndex(sessionPath: string): Promise<SessionUserMessageIndexEntry[]> {
  return (await readSessionRolloutSnapshot(sessionPath)).userMessageIndex
}

function makeForkBoundaryUserMessageIndexEntry(
  threadId: string,
  sourceThreadId: string,
): SessionUserMessageIndexEntry {
  return {
    turnId: `${FORK_BOUNDARY_TURN_ID_PREFIX}${threadId}:${sourceThreadId}`,
    ordinal: 0,
    preview: 'Fork point',
    title: 'Fork point',
    kind: 'forkBoundary',
    sourceThreadId,
  }
}

function resequenceUserMessageIndex(entries: SessionUserMessageIndexEntry[]): SessionUserMessageIndexEntry[] {
  let ordinal = 0
  return entries.map((entry) => {
    if (entry.kind === 'forkBoundary') return { ...entry, ordinal }
    ordinal += 1
    return { ...entry, ordinal }
  })
}

async function filterUserMessageIndexToHistoryBase(
  entries: SessionUserMessageIndexEntry[],
  sourceLineage: SessionForkLineage,
  endOrdinalExclusive: number | null,
  endByteOffset: number | null,
): Promise<SessionUserMessageIndexEntry[]> {
  if (endOrdinalExclusive === null && endByteOffset === null) return entries

  const localTurnEnds = await readCachedSessionTurnEnds(sourceLineage.sessionPath)
  if (localTurnEnds.size === 0) return entries

  return entries.filter((entry) => {
    if (entry.kind === 'forkBoundary') return true
    const end = localTurnEnds.get(entry.turnId)
    // A source can inherit an earlier prefix. Those entries have no local
    // JSONL row and remain part of every later inherited prefix.
    if (!end) return true
    if (endOrdinalExclusive !== null && end.ordinal !== null) {
      return end.ordinal < endOrdinalExclusive
    }
    return endByteOffset === null || end.byteOffset <= endByteOffset
  })
}

async function mergePaginatedForkUserMessageIndex(
  threadId: string,
  lineageByThreadId: Map<string, SessionForkLineage>,
  visitedThreadIds = new Set<string>(),
): Promise<SessionUserMessageIndexEntry[]> {
  const lineage = lineageByThreadId.get(threadId)
  if (!lineage) return []
  if (!lineage.forkedFromId || visitedThreadIds.has(threadId)) {
    return await readCachedSessionUserMessageIndex(lineage.sessionPath)
  }

  const sourceThreadId = lineage.isPaginated
    ? lineage.historyBaseThreadId
    : lineage.forkedFromId
  if (!sourceThreadId) return await readCachedSessionUserMessageIndex(lineage.sessionPath)

  const sourceLineage = lineageByThreadId.get(sourceThreadId)
  if (!sourceLineage) return await readCachedSessionUserMessageIndex(lineage.sessionPath)

  const nextVisitedThreadIds = new Set(visitedThreadIds)
  nextVisitedThreadIds.add(threadId)
  const sourceEntries = await mergePaginatedForkUserMessageIndex(
    sourceLineage.threadId,
    lineageByThreadId,
    nextVisitedThreadIds,
  )
  const localEntries = await readCachedSessionUserMessageIndex(lineage.sessionPath)
  const inheritedEntries = lineage.isPaginated
    ? await filterUserMessageIndexToHistoryBase(
        sourceEntries,
        sourceLineage,
        lineage.historyBaseOrdinal,
        lineage.historyBaseByteOffset,
      )
    : takeForkPrefixUserMessageEntries(
        sourceEntries,
        sharedUserMessageEntryPrefixLength(localEntries, sourceEntries),
      )
  const localSuffix = lineage.isPaginated
    ? localEntries
    : localEntries.slice(sharedUserMessageEntryPrefixLength(localEntries, sourceEntries))
  return resequenceUserMessageIndex([
    ...inheritedEntries,
    makeForkBoundaryUserMessageIndexEntry(threadId, sourceLineage.threadId),
    ...localSuffix,
  ])
}

export async function buildPaginatedForkUserMessageIndex(
  threadId: string,
  fallbackSessionPath = '',
): Promise<SessionUserMessageIndexEntry[]> {
  let currentLineage: SessionForkLineage | null = null
  if (fallbackSessionPath && isAbsolute(fallbackSessionPath)) {
    currentLineage = await readSessionForkLineage(
      fallbackSessionPath,
      isArchivedSessionPath(fallbackSessionPath),
    )
    if (!currentLineage?.forkedFromId) return await readCachedSessionUserMessageIndex(fallbackSessionPath)
  }
  const lineageByThreadId = new Map(
    (await getSessionForkLineage()).map((entry) => [entry.threadId, entry]),
  )
  // A fork may appear after the 30-second global scan cache was populated.
  // The `thread/read` path is the freshest authoritative metadata for itself.
  if (currentLineage) lineageByThreadId.set(currentLineage.threadId, currentLineage)
  if (lineageByThreadId.has(threadId)) {
    return await mergePaginatedForkUserMessageIndex(threadId, lineageByThreadId)
  }
  if (!fallbackSessionPath || !isAbsolute(fallbackSessionPath)) return []
  return await readCachedSessionUserMessageIndex(fallbackSessionPath)
}

type ThreadUserMessageNavigation = {
  entries: SessionUserMessageIndexEntry[]
  count: number
}

const threadUserMessageNavigationPromiseByThreadId = new Map<string, Promise<ThreadUserMessageNavigation>>()

async function readThreadUserMessageNavigation(
  appServer: RpcExecutor,
  threadId: string,
): Promise<ThreadUserMessageNavigation> {
  const pending = threadUserMessageNavigationPromiseByThreadId.get(threadId)
  if (pending) return await pending

  const promise = (async () => {
    const cachedLineage = (await getSessionForkLineage()).find((entry) => entry.threadId === threadId)
    let sessionPath = cachedLineage?.sessionPath ?? ''
    if (!sessionPath || !isAbsolute(sessionPath)) {
      const metaResult = await appServer.rpc('thread/read', { threadId, includeTurns: false })
      sessionPath = readNonEmptyString(asRecord(asRecord(metaResult)?.thread)?.path)
    }
    if (!sessionPath || !isAbsolute(sessionPath)) return { entries: [], count: 0 }

    const entries = await buildPaginatedForkUserMessageIndex(threadId, sessionPath)
    return {
      entries,
      count: entries.filter((entry) => entry.kind !== 'forkBoundary').length,
    }
  })().finally(() => {
    threadUserMessageNavigationPromiseByThreadId.delete(threadId)
  })

  threadUserMessageNavigationPromiseByThreadId.set(threadId, promise)
  return await promise
}


type RuntimeTurnStateReader = {
  hasActiveTurn(threadId: string, turnId: string): boolean
}

export async function mergeSessionModelStateIntoThreadResult(
  result: unknown,
  runtimeTurnState: RuntimeTurnStateReader | null = null,
): Promise<unknown> {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const sessionPath = readNonEmptyString(thread?.path)
  if (!record || !thread || !sessionPath || !isAbsolute(sessionPath)) return result

  let modelState: SessionRecoveredModelState
  try {
    modelState = await readCachedSessionModelState(sessionPath)
  } catch {
    return result
  }
  if (!modelState.model && !modelState.modelProvider && !modelState.reasoningEffort && !modelState.activeTurnId && !modelState.rolloutTurnState) return result

  const nextRecord: Record<string, unknown> = { ...record }
  const nextThread: Record<string, unknown> = { ...thread }

  if (modelState.model) {
    nextRecord.model = modelState.model
    nextThread.model = modelState.model
  }
  if (modelState.modelProvider) {
    nextRecord.modelProvider = modelState.modelProvider
    nextThread.modelProvider = modelState.modelProvider
  }
  if (modelState.reasoningEffort) {
    nextRecord.reasoningEffort = modelState.reasoningEffort
    nextThread.reasoningEffort = modelState.reasoningEffort
  }
  if (modelState.rolloutTurnState) {
    nextThread.codexUiRolloutTurnState = modelState.rolloutTurnState
  }

  const threadId = readNonEmptyString(nextThread.id)
  const trustedActiveTurnId = modelState.activeTurnId
    && runtimeTurnState?.hasActiveTurn?.(threadId, modelState.activeTurnId)
    ? modelState.activeTurnId
    : ''
  return reconcileStaleThreadStatusFromSession({
    ...nextRecord,
    thread: nextThread,
  }, trustedActiveTurnId)
}

/**
 * Prefer a live runtime turn when it proves an app-server interrupted-turn
 * snapshot is stale. A rollout alone is insufficient evidence because a
 * crashed process can leave its final task_started record unterminated.
 */
export function reconcileStaleThreadStatusFromSession(result: unknown, activeTurnId: string): unknown {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  if (!record || !thread || !activeTurnId) return result

  const threadStatus = asRecord(thread.status)

  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const activeTurn = turns.find((turn) => readNonEmptyString(asRecord(turn)?.id) === activeTurnId)
  const activeTurnStatus = readProtocolToken(asRecord(activeTurn)?.status)
  if (activeTurnStatus !== 'interrupted') return result
  const nextTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    if (!turnRecord || readNonEmptyString(turnRecord.id) !== activeTurnId) return turn
    return { ...turnRecord, status: 'inProgress' }
  })
  return {
    ...record,
    thread: {
      ...thread,
      status: { ...threadStatus, type: 'inProgress', turnId: activeTurnId },
      turns: nextTurns,
    },
  }
}

export function mergeExplicitModelStateIntoThreadResult(result: unknown, params: unknown): unknown {
  const paramsRecord = asRecord(params)
  const model = readNonEmptyString(paramsRecord?.model)
  const modelProvider = readNonEmptyString(paramsRecord?.modelProvider) || readNonEmptyString(paramsRecord?.model_provider)
  if (!model && !modelProvider) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  if (!record || !thread) return result

  const nextRecord: Record<string, unknown> = { ...record }
  const nextThread: Record<string, unknown> = { ...thread }
  if (model) {
    nextRecord.model = model
    nextThread.model = model
  }
  if (modelProvider) {
    nextRecord.modelProvider = modelProvider
    nextThread.modelProvider = modelProvider
  }

  return {
    ...nextRecord,
    thread: nextThread,
  }
}

function parseSessionSkillText(value: string): SessionRecoveredSkillInput | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('<skill>')) return null
  const name = trimmed.match(/<name>\s*([\s\S]*?)\s*<\/name>/u)?.[1]?.trim() ?? ''
  const path = trimmed.match(/<path>\s*([\s\S]*?)\s*<\/path>/u)?.[1]?.trim() ?? ''
  if (!name || !path) return null
  return { name, path }
}

function buildSessionSkillInputsByTurn(sessionLogRaw: string): Map<string, SessionRecoveredSkillInput[]> {
  return buildSessionSkillInputsByTurnFromRows(parseSessionRolloutRows(sessionLogRaw))
}

function buildSessionSkillInputsByTurnFromRows(rows: SessionRolloutRow[]): Map<string, SessionRecoveredSkillInput[]> {
  let currentTurnId = ''
  const skillsByTurnId = new Map<string, SessionRecoveredSkillInput[]>()

  for (const { row, payload: payloadRecord } of rows) {
    if (row.type === 'turn_context') {
      currentTurnId = readNonEmptyString(payloadRecord?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      if (payloadRecord?.type === 'task_started') {
        currentTurnId = readNonEmptyString(payloadRecord.turn_id) || currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId) continue
    if (payloadRecord?.type !== 'message' || payloadRecord.role !== 'user') continue
    const content = Array.isArray(payloadRecord.content) ? payloadRecord.content : []

    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem)
      if (contentRecord?.type !== 'input_text' || typeof contentRecord.text !== 'string') continue
      const skill = parseSessionSkillText(contentRecord.text)
      if (!skill) continue
      const existing = skillsByTurnId.get(currentTurnId) ?? []
      if (!existing.some((item) => item.path === skill.path)) {
        existing.push(skill)
        skillsByTurnId.set(currentTurnId, existing)
      }
    }
  }

  return skillsByTurnId
}

function mergeSessionSkillInputsIntoTurnsFromMap(
  turns: unknown[],
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>,
): unknown[] {
  const turnIds = new Set<string>()
  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) turnIds.add(turnId)
  }
  if (turnIds.size === 0) return turns

  if (skillsByTurnId.size === 0) return turns

  let changed = false
  const nextTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    const skills = turnId ? skillsByTurnId.get(turnId) : undefined
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !skills || skills.length === 0 || !items) return turn

    let targetUserMessageIndex = -1
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const itemRecord = asRecord(items[index])
      if (itemRecord?.type === 'userMessage' && Array.isArray(itemRecord.content)) {
        targetUserMessageIndex = index
        break
      }
    }
    if (targetUserMessageIndex < 0) return turn

    let addedToMessage = false
    const nextItems = items.map((item, index) => {
      const itemRecord = asRecord(item)
      const content = Array.isArray(itemRecord?.content) ? itemRecord.content : null
      if (index !== targetUserMessageIndex || itemRecord?.type !== 'userMessage' || !content) return item

      const existingSkillPaths = new Set(
        content.flatMap((contentItem) => {
          const contentRecord = asRecord(contentItem)
          const path = typeof contentRecord?.path === 'string' ? contentRecord.path.trim() : ''
          return contentRecord?.type === 'skill' && path ? [path] : []
        }),
      )
      const missingSkills = skills.filter((skill) => !existingSkillPaths.has(skill.path))
      if (missingSkills.length === 0) return item

      addedToMessage = true
      changed = true
      return {
        ...itemRecord,
        content: [
          ...content,
          ...missingSkills.map((skill) => ({ type: 'skill', name: skill.name, path: skill.path })),
        ],
      }
    })

    return addedToMessage ? { ...turnRecord, items: nextItems } : turn
  })

  return changed ? nextTurns : turns
}

export function mergeSessionSkillInputsIntoTurns(turns: unknown[], sessionLogRaw: string): unknown[] {
  return mergeSessionSkillInputsIntoTurnsFromMap(turns, buildSessionSkillInputsByTurn(sessionLogRaw))
}

function buildSessionUserPromptAdditionalContextsByTurn(sessionLogRaw: string): Map<string, string[]> {
  return buildSessionUserPromptAdditionalContextsByTurnFromRows(parseSessionRolloutRows(sessionLogRaw))
}

function buildSessionUserPromptAdditionalContextsByTurnFromRows(rows: SessionRolloutRow[]): Map<string, string[]> {
  let currentTurnId = ''
  let awaitingAdditionalContext = false
  const contextsByTurnId = new Map<string, string[]>()

  for (const { row, payload: payloadRecord } of rows) {
    if (row.type === 'turn_context') {
      currentTurnId = readNonEmptyString(payloadRecord?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      if (payloadRecord?.type === 'task_started') {
        currentTurnId = readNonEmptyString(payloadRecord.turn_id) || currentTurnId
      } else if (payloadRecord?.type === 'user_message') {
        awaitingAdditionalContext = Boolean(currentTurnId)
      } else if (payloadRecord?.type === 'task_complete') {
        awaitingAdditionalContext = false
        currentTurnId = ''
      }
      continue
    }

    if (row.type !== 'response_item' || !awaitingAdditionalContext || !currentTurnId) continue
    if (payloadRecord?.type !== 'message') continue
    if (payloadRecord.role === 'assistant') {
      awaitingAdditionalContext = false
      continue
    }
    if (payloadRecord.role !== 'developer') continue

    const context = readSessionUserMessageText(payloadRecord).trim()
    if (!context) continue
    const existing = contextsByTurnId.get(currentTurnId) ?? []
    if (!existing.includes(context)) {
      existing.push(context)
      contextsByTurnId.set(currentTurnId, existing)
    }
  }

  return contextsByTurnId
}

async function readCachedSessionUserInputEnrichment(sessionPath: string): Promise<{
  skillsByTurnId: Map<string, SessionRecoveredSkillInput[]>
  contextsByTurnId: Map<string, string[]>
}> {
  const snapshot = await readSessionRolloutSnapshot(sessionPath)
  return {
    skillsByTurnId: snapshot.skillsByTurnId,
    contextsByTurnId: snapshot.contextsByTurnId,
  }
}

function mergeSessionUserPromptAdditionalContextsIntoTurnsFromMap(
  turns: unknown[],
  contextsByTurnId: Map<string, string[]>,
): unknown[] {
  if (contextsByTurnId.size === 0) return turns

  let changed = false
  const mergedTurns = turns.map((turn) => {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    const contexts = turnId ? contextsByTurnId.get(turnId) : undefined
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !contexts || contexts.length === 0 || !items) return turn

    let targetUserMessageIndex = -1
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const itemRecord = asRecord(items[index])
      if (itemRecord?.type === 'userMessage' && Array.isArray(itemRecord.content)) {
        targetUserMessageIndex = index
        break
      }
    }
    if (targetUserMessageIndex < 0) return turn

    let addedToMessage = false
    const nextItems = items.map((item, index) => {
      const itemRecord = asRecord(item)
      const content = Array.isArray(itemRecord?.content) ? itemRecord.content : null
      if (index !== targetUserMessageIndex || itemRecord?.type !== 'userMessage' || !content) return item

      const existingContexts = new Set(
        content.flatMap((contentItem) => {
          const contentRecord = asRecord(contentItem)
          const text = typeof contentRecord?.text === 'string' ? contentRecord.text.trim() : ''
          return contentRecord?.type === 'additionalContext' && text ? [text] : []
        }),
      )
      const missingContexts = contexts.filter((context) => !existingContexts.has(context))
      if (missingContexts.length === 0) return item

      addedToMessage = true
      changed = true
      return {
        ...itemRecord,
        content: [
          ...content,
          ...missingContexts.map((text) => ({ type: 'additionalContext', text })),
        ],
      }
    })

    return addedToMessage ? { ...turnRecord, items: nextItems } : turn
  })

  return changed ? mergedTurns : turns
}

export function mergeSessionUserPromptAdditionalContextsIntoTurns(turns: unknown[], sessionLogRaw: string): unknown[] {
  return mergeSessionUserPromptAdditionalContextsIntoTurnsFromMap(turns, buildSessionUserPromptAdditionalContextsByTurn(sessionLogRaw))
}

async function mergeSessionSkillInputsIntoThreadResult(result: unknown): Promise<unknown> {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  const sessionPath = readNonEmptyString(thread?.path)
  if (!record || !thread || !turns || turns.length === 0 || !sessionPath || !isAbsolute(sessionPath)) {
    return result
  }

  try {
    const enrichment = await readCachedSessionUserInputEnrichment(sessionPath)
    const turnsWithSkills = mergeSessionSkillInputsIntoTurnsFromMap(turns, enrichment.skillsByTurnId)
    const mergedTurns = mergeSessionUserPromptAdditionalContextsIntoTurnsFromMap(turnsWithSkills, enrichment.contextsByTurnId)
    if (mergedTurns === turns) return result
    return {
      ...record,
      thread: {
        ...thread,
        turns: mergedTurns,
      },
    }
  } catch {
    return result
  }
}

function readEnvValueFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = content.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+)\\s*$`, 'm'))
    if (!match) return null
    const rawValue = match[1]?.trim() ?? ''
    if (!rawValue) return null
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      return rawValue.slice(1, -1).trim()
    }
    return rawValue
  } catch {
    return null
  }
}

function parseBooleanEnvFlag(value: string | null | undefined): boolean | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function resolveApiPerfLoggingEnabled(): boolean {
  const explicitValue = parseBooleanEnvFlag(process.env[API_PERF_LOGGING_ENV_KEY])
  if (explicitValue !== null) return explicitValue

  const fromEnvLocal = parseBooleanEnvFlag(readEnvValueFromFile('.env.local', API_PERF_LOGGING_ENV_KEY))
  if (fromEnvLocal !== null) return fromEnvLocal

  const fromEnv = parseBooleanEnvFlag(readEnvValueFromFile('.env', API_PERF_LOGGING_ENV_KEY))
  if (fromEnv !== null) return fromEnv

  return false
}

const API_PERF_LOGGING_ENABLED = resolveApiPerfLoggingEnabled()

function parseNumberEnvFlag(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.trim())
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function resolveNumericEnvConfig(envKey: string, fallback: number): number {
  const fromProcess = parseNumberEnvFlag(process.env[envKey])
  if (fromProcess !== null) return fromProcess

  const fromEnvLocal = parseNumberEnvFlag(readEnvValueFromFile('.env.local', envKey))
  if (fromEnvLocal !== null) return fromEnvLocal

  const fromEnv = parseNumberEnvFlag(readEnvValueFromFile('.env', envKey))
  if (fromEnv !== null) return fromEnv

  return fallback
}

const API_PERF_MS_THRESHOLD = resolveNumericEnvConfig(API_PERF_MS_THRESHOLD_ENV_KEY, DEFAULT_API_PERF_MS_THRESHOLD)
const API_PERF_BODY_MB_THRESHOLD = resolveNumericEnvConfig(API_PERF_BODY_MB_THRESHOLD_ENV_KEY, DEFAULT_API_PERF_BODY_MB_THRESHOLD)

function getChunkByteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, encoding)
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength
  }
  if (ArrayBuffer.isView(chunk)) {
    return chunk.byteLength
  }
  if (chunk instanceof ArrayBuffer) {
    return chunk.byteLength
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isInlineDataUrl(value: string): boolean {
  return /^data:/iu.test(value.trim())
}

function inferImageMimeTypeFromBytes(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  return null
}

function inferImageMimeTypeFromBase64(value: string): string | null {
  const compact = value.trim().replace(/\s+/gu, '')
  if (compact.length < 32 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return null
  try {
    return inferImageMimeTypeFromBytes(Buffer.from(compact.slice(0, 64), 'base64'))
  } catch {
    return null
  }
}

function normalizeBase64ImageDataUrl(value: string, mimeType: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isInlineDataUrl(trimmed)) {
    return /^data:image\//iu.test(trimmed) ? trimmed : null
  }
  const compact = trimmed.replace(/\s+/gu, '')
  const inferredMimeType = inferImageMimeTypeFromBase64(compact)
  if (!inferredMimeType) return null
  const normalizedMimeType = mimeType.trim().toLowerCase()
  const finalMimeType = normalizedMimeType.startsWith('image/') && normalizedMimeType !== 'image/*'
    ? normalizedMimeType
    : inferredMimeType
  return `data:${finalMimeType};base64,${compact}`
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase()
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'image/svg+xml') return '.svg'
  if (normalized === 'application/pdf') return '.pdf'
  return ''
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toAttachmentLinkTarget(block: Record<string, unknown>, fallback: string): string {
  const candidate = asNonEmptyString(block.path)
    ?? asNonEmptyString(block.file_path)
    ?? asNonEmptyString(block.filename)
    ?? asNonEmptyString(block.file_id)
    ?? fallback
  if (candidate.startsWith('file://')) return candidate
  if (candidate.startsWith('/')) return `file://${candidate}`
  return `attachment://${candidate}`
}

async function persistInlineDataUrlToLocalFile(dataUrl: string, baseName: string): Promise<string | null> {
  const trimmed = dataUrl.trim()
  const match = /^data:([^;,]*)(;base64)?,(.*)$/isu.exec(trimmed)
  if (!match) return null
  const mimeType = (match[1] ?? '').trim().toLowerCase()
  const encodedPayload = match[3] ?? ''
  let bytes: Buffer
  try {
    bytes = match[2]
      ? Buffer.from(encodedPayload, 'base64')
      : Buffer.from(decodeURIComponent(encodedPayload), 'utf8')
  } catch {
    return null
  }
  if (bytes.length === 0) return null

  const hash = createHash('sha1').update(bytes).digest('hex')
  const ext = extensionFromMimeType(mimeType)
  const mediaDir = join(tmpdir(), 'codex-web-inline-media')
  await mkdir(mediaDir, { recursive: true })
  const fileName = `${baseName}-${hash}${ext}`
  const filePath = join(mediaDir, fileName)
  try {
    await stat(filePath)
  } catch {
    await writeFile(filePath, bytes)
  }
  return filePath
}

function toLocalImageProxyUrl(path: string): string {
  return `/codex-local-image?path=${encodeURIComponent(path)}`
}

const CURSOR_TOOL_PAYLOAD_LINE = /^\s*(?:└\s*)?payload:\s*(.+\.json)\s*$/m
const CURSOR_TOOL_PAYLOAD_FILE = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json$/u
const CURSOR_TOOL_INLINE_DATA_BLOCK = /<codex-ui-data>([\s\S]*?)<\/codex-ui-data>/
const CURSOR_TOOL_COMPLETED_MESSAGE = /^(?:Ran `|Called Cursor tool `|Cursor shell completed\b|Cursor tool `?.+?`? completed\b)/

function isCursorToolPayloadRecord(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value)
  return Boolean(
    record
    && record.type === 'cursor_tool_call'
    && typeof record.subtype === 'string'
    && record.subtype.length > 0
    && typeof record.call_id === 'string'
    && record.call_id.length > 0
    && typeof record.tool === 'string'
    && record.tool.length > 0,
  )
}

async function inlineCursorToolPayloadReference(value: string): Promise<{ value: string; changed: boolean }> {
  if (readInlineCursorToolPayloadRecord(value)) return { value, changed: false }
  const resolvedPath = resolveCursorToolPayloadPath(cursorToolPayloadPathFromText(value))
  if (!resolvedPath) return { value, changed: false }

  try {
    const raw = await readFile(resolvedPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isCursorToolPayloadRecord(parsed)) return { value, changed: false }
    return {
      value: `${value}\n<codex-ui-data>${JSON.stringify(parsed)}</codex-ui-data>`,
      changed: true,
    }
  } catch {
    return { value, changed: false }
  }
}

function readInlineCursorToolPayloadRecord(value: string): Record<string, unknown> | null {
  const match = value.match(CURSOR_TOOL_INLINE_DATA_BLOCK)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(match[1]) as unknown
    return isCursorToolPayloadRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function inlineCursorToolPayloadReferenceSync(value: string): { value: string; changed: boolean } {
  if (readInlineCursorToolPayloadRecord(value)) return { value, changed: false }
  const payloadCache: CursorToolPayloadCache = new Map()
  const parsed = readCursorToolPayloadFromMessageText(value, payloadCache)
  if (!parsed) return { value, changed: false }
  return {
    value: `${value}\n<codex-ui-data>${JSON.stringify(parsed)}</codex-ui-data>`,
    changed: true,
  }
}

function sanitizeCursorToolPayloadReferencesInNotification(
  notification: { method: string; params: unknown },
): { method: string; params: unknown } {
  if (notification.method !== 'item/started' && notification.method !== 'item/completed') return notification

  const params = asRecord(notification.params)
  const item = asRecord(params?.item)
  const text = typeof item?.text === 'string' ? item.text : ''
  if (!params || !item || !text.includes('payload:')) return notification

  const inlinedText = inlineCursorToolPayloadReferenceSync(text)
  if (!inlinedText.changed) return notification

  return {
    ...notification,
    params: {
      ...params,
      item: {
        ...item,
        text: inlinedText.value,
      },
    },
  }
}

function cursorToolPayloadPathFromText(value: string): string {
  const match = value.match(CURSOR_TOOL_PAYLOAD_LINE)
  return match?.[1]?.trim() ?? ''
}

function resolveCursorToolPayloadPath(payloadPath: string): string | null {
  if (!payloadPath) return null

  const payloadRoot = resolve(getCursorToolPayloadsDir())
  const resolvedPath = isAbsolute(payloadPath)
    ? resolve(payloadPath)
    : resolve(payloadRoot, payloadPath)
  if (resolvedPath !== payloadRoot && !resolvedPath.startsWith(`${payloadRoot}/`)) {
    return null
  }
  const relativePath = resolvedPath.slice(payloadRoot.length + 1)
  if (!CURSOR_TOOL_PAYLOAD_FILE.test(relativePath)) {
    return null
  }
  return resolvedPath
}

const INLINE_IMAGE_FIELD_NAMES = new Set([
  'b64_json',
  'image',
  'image_url',
  'images',
  'result',
  'url',
])

type InlinePayloadSanitizeContext = {
  turnId: string
  itemId: string
  blockIndex: number
  fieldName?: string
}

function isPotentialInlineImageField(fieldName: string | undefined): boolean {
  return typeof fieldName === 'string' && INLINE_IMAGE_FIELD_NAMES.has(fieldName)
}

async function sanitizeInlineImageString(
  value: string,
  context: InlinePayloadSanitizeContext,
): Promise<{ value: string; changed: boolean }> {
  if (!isPotentialInlineImageField(context.fieldName)) {
    return { value, changed: false }
  }

  const dataUrl = normalizeBase64ImageDataUrl(value, 'image/*')
  if (!dataUrl) return { value, changed: false }

  const localUrl = await persistInlineDataUrlToLocalFile(
    dataUrl,
    `inline-image-${context.turnId}-${context.itemId}-${context.fieldName}-${String(context.blockIndex)}`,
  )
  if (!localUrl) return { value, changed: false }

  return { value: toLocalImageProxyUrl(localUrl), changed: true }
}

async function sanitizeInlineUserContentBlock(
  block: unknown,
  context: InlinePayloadSanitizeContext,
): Promise<unknown> {
  const record = asRecord(block)
  if (!record) return block

  const type = asNonEmptyString(record.type) ?? ''
  const imageUrl = asNonEmptyString(record.url) ?? asNonEmptyString(record.image_url)
  if (imageUrl && isInlineDataUrl(imageUrl)) {
    const localUrl = await persistInlineDataUrlToLocalFile(imageUrl, `inline-image-${context.turnId}-${context.itemId}-${String(context.blockIndex)}`)
    if (localUrl) {
      const nextRecord = { ...record }
      if (typeof record.url === 'string') {
        nextRecord.url = toLocalImageProxyUrl(localUrl)
      }
      if (typeof record.image_url === 'string') {
        nextRecord.image_url = toLocalImageProxyUrl(localUrl)
      }
      return {
        ...nextRecord,
        type: 'image',
      }
    }
    const target = toAttachmentLinkTarget(record, `inline-image/${context.turnId}/${context.itemId}/${String(context.blockIndex)}`)
    return {
      type: 'text',
      text: `Image attachment: ${target}`,
    }
  }

  if (type === 'imageGeneration' || type === 'image_generation') {
    const rawResult = asNonEmptyString(record.result)
      ?? asNonEmptyString(record.b64_json)
      ?? asNonEmptyString(record.image)
    const mimeType = asNonEmptyString(record.mime_type)
      ?? asNonEmptyString(record.mimeType)
      ?? 'image/png'
    const dataUrl = rawResult ? normalizeBase64ImageDataUrl(rawResult, mimeType) : null
    if (dataUrl) {
      const localUrl = await persistInlineDataUrlToLocalFile(dataUrl, `generated-image-${context.turnId}-${context.itemId}`)
      if (localUrl) {
        return {
          ...record,
          type: 'imageView',
          path: localUrl,
        }
      }
    }
  }

  const inlineFileData = asNonEmptyString(record.file_data)
    ?? asNonEmptyString(record.data)
    ?? asNonEmptyString(record.base64)
  if ((type.includes('file') || type === 'input_file' || type === 'file') && inlineFileData) {
    const mimeType = asNonEmptyString(record.mime_type) ?? 'application/octet-stream'
    const fileDataUrl = `data:${mimeType};base64,${inlineFileData}`
    const localUrl = await persistInlineDataUrlToLocalFile(fileDataUrl, `inline-file-${context.turnId}-${context.itemId}-${String(context.blockIndex)}`)
    if (localUrl) {
      return {
        type: 'text',
        text: `File attachment: ${localUrl}`,
      }
    }
    const target = toAttachmentLinkTarget(record, `inline-file/${context.turnId}/${context.itemId}/${String(context.blockIndex)}`)
    return {
      type: 'text',
      text: `File attachment: ${target}`,
    }
  }

  return block
}

async function sanitizeInlinePayloadDeep(
  value: unknown,
  context: InlinePayloadSanitizeContext,
): Promise<{ value: unknown; changed: boolean }> {
  const maybeBlock = await sanitizeInlineUserContentBlock(value, context)
  if (maybeBlock !== value) {
    return { value: maybeBlock, changed: true }
  }

  if (typeof value === 'string') {
    const cursorPayload = await inlineCursorToolPayloadReference(value)
    if (cursorPayload.changed) return cursorPayload
    return sanitizeInlineImageString(value, context)
  }

  if (Array.isArray(value)) {
    let changed = false
    const nextArray: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const nested = await sanitizeInlinePayloadDeep(value[index], {
        turnId: context.turnId,
        itemId: context.itemId,
        blockIndex: index,
        fieldName: context.fieldName,
      })
      if (nested.changed) changed = true
      nextArray.push(nested.value)
    }
    return changed ? { value: nextArray, changed: true } : { value, changed: false }
  }

  const record = asRecord(value)
  if (!record) return { value, changed: false }

  let changed = false
  const nextRecord: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(record)) {
    const nested = await sanitizeInlinePayloadDeep(nestedValue, {
      turnId: context.turnId,
      itemId: context.itemId,
      blockIndex: context.blockIndex,
      fieldName: key,
    })
    if (nested.changed) changed = true
    nextRecord[key] = nested.value
  }

  return changed ? { value: nextRecord, changed: true } : { value, changed: false }
}

export async function sanitizeThreadTurnsInlinePayloads(method: string, result: unknown): Promise<unknown> {
  if (!THREAD_METHODS_WITH_TURNS.has(method)) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length === 0) return result

  let changed = false
  const nextTurns: unknown[] = []
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]
    const turnRecord = asRecord(turn)
    const turnId = asNonEmptyString(turnRecord?.id) ?? 'turn'
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : null
    if (!turnRecord || !items) {
      nextTurns.push(turn)
      continue
    }

    let itemChanged = false
    const nextItems: unknown[] = []
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex]
      const itemRecord = asRecord(item)
      const itemId = asNonEmptyString(itemRecord?.id) ?? 'item'
      if (!itemRecord) {
        nextItems.push(item)
        continue
      }
      const sanitizedItem = await sanitizeInlinePayloadDeep(item, {
        turnId,
        itemId,
        blockIndex: itemIndex + turnIndex,
      })
      if (!sanitizedItem.changed) {
        nextItems.push(item)
        continue
      }
      itemChanged = true
      nextItems.push(sanitizedItem.value)
    }

    if (!itemChanged) {
      nextTurns.push(turn)
      continue
    }
    changed = true
    nextTurns.push({
      ...turnRecord,
      items: nextItems,
    })
  }

  if (!changed) return result
  return {
    ...record,
    thread: {
      ...thread,
      turns: nextTurns,
    },
  }
}

function trimThreadTurnsInRpcResult(method: string, result: unknown): unknown {
  if (!THREAD_METHODS_WITH_TURNS.has(method)) return result

  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length <= THREAD_RESPONSE_TURN_LIMIT) return result
  const startTurnIndex = Math.max(0, turns.length - THREAD_RESPONSE_TURN_LIMIT)

  return {
    ...record,
    threadTurnStartIndex: startTurnIndex,
    thread: {
      ...thread,
      turns: turns.slice(startTurnIndex),
    },
  }
}

export function mergeRecoveredTurnItemsIntoThreadResult(
  result: unknown,
  mergeItemsIntoTurns: (threadId: string, turns: unknown[]) => unknown[],
  sessionLogRaw?: string | null,
): unknown {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  if (!record || !thread || !turns || turns.length === 0) return result

  const threadId = readNonEmptyString(thread.id)
  if (!threadId) return result

  let mergedTurns = mergeItemsIntoTurns(threadId, turns)
  if (sessionLogRaw) {
    mergedTurns = mergeSessionCommandsIntoTurns(mergedTurns, sessionLogRaw)
  }
  if (
    mergedTurns === turns ||
    (mergedTurns.length === turns.length && mergedTurns.every((turn, index) => turn === turns[index]))
  ) {
    return result
  }

  return {
    ...record,
    thread: {
      ...thread,
      turns: mergedTurns,
    },
  }
}

async function readSessionLogRawFromThreadResult(result: unknown): Promise<string | null> {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const sessionPath = readNonEmptyString(thread?.path)
  if (!sessionPath || !isAbsolute(sessionPath)) return null

  try {
    return (await readSessionRolloutSnapshot(sessionPath)).raw
  } catch {
    return null
  }
}

async function mergeRecoveredTurnItemsIntoThreadResultFromSession(
  appServer: AppServerProcess,
  result: unknown,
): Promise<unknown> {
  const sessionLogRaw = await readSessionLogRawFromThreadResult(result)
  return mergeRecoveredTurnItemsIntoThreadResult(
    result,
    (threadId, turns) => appServer.mergeItemsIntoTurns(threadId, turns),
    sessionLogRaw,
  )
}

const FORK_BOUNDARY_ITEM_TYPE = 'forkBoundary'
const FORK_BOUNDARY_TURN_ID_PREFIX = 'codexui-fork-boundary:'
type SessionTurnEnd = {
  ordinal: number | null
  byteOffset: number
}

function isForkBoundaryTurn(turn: unknown): boolean {
  return readNonEmptyString(asRecord(turn)?.id).startsWith(FORK_BOUNDARY_TURN_ID_PREFIX)
}

function makeForkBoundaryTurn(threadId: string, sourceThreadId: string): Record<string, unknown> {
  const id = `${FORK_BOUNDARY_TURN_ID_PREFIX}${threadId}:${sourceThreadId}`
  return {
    id,
    status: 'completed',
    items: [{
      id,
      type: FORK_BOUNDARY_ITEM_TYPE,
      text: 'Fork point',
      sourceThreadId,
    }],
  }
}

function buildSessionTurnEnds(sessionLogRaw: string): Map<string, SessionTurnEnd> {
  return buildSessionTurnEndsFromRows(parseSessionRolloutRows(sessionLogRaw))
}

function buildSessionTurnEndsFromRows(rows: SessionRolloutRow[]): Map<string, SessionTurnEnd> {
  const endByTurnId = new Map<string, SessionTurnEnd>()
  let activeTurnId = ''

  for (const { row, payload, lineEndByteOffset } of rows) {
    const eventType = row.type === 'event_msg' ? readNonEmptyString(payload?.type) : ''
    const eventTurnId = readNonEmptyString(payload?.turn_id)
    if (row.type === 'turn_context') {
      activeTurnId = eventTurnId || activeTurnId
    } else if (eventType === 'task_started') {
      activeTurnId = eventTurnId || activeTurnId
    }

    const turnId = eventTurnId || activeTurnId
    if (turnId) {
      const ordinal = readNonNegativeSafeInteger(row.ordinal)
      const previous = endByTurnId.get(turnId)
      endByTurnId.set(turnId, {
        ordinal: ordinal ?? previous?.ordinal ?? null,
        byteOffset: lineEndByteOffset,
      })
    }

    if (eventType === 'task_complete') {
      if (!eventTurnId || eventTurnId === activeTurnId) activeTurnId = ''
    }
  }

  return endByTurnId
}

async function readCachedSessionTurnEnds(sessionPath: string): Promise<Map<string, SessionTurnEnd>> {
  return (await readSessionRolloutSnapshot(sessionPath)).turnEnds
}

async function filterTurnsToHistoryBase(
  turns: unknown[],
  sourceLineage: SessionForkLineage,
  endOrdinalExclusive: number | null,
  endByteOffset: number | null,
): Promise<unknown[]> {
  if (endOrdinalExclusive === null && endByteOffset === null) return turns

  const localTurnEnds = await readCachedSessionTurnEnds(sourceLineage.sessionPath)
  if (localTurnEnds.size === 0) return turns

  return turns.filter((turn) => {
    const turnId = readNonEmptyString(asRecord(turn)?.id)
    const end = turnId ? localTurnEnds.get(turnId) : undefined
    // A source thread can itself inherit history. Its inherited turns do not
    // have rows in this rollout, so they remain part of every later prefix.
    if (!end) return true
    if (endOrdinalExclusive !== null && end.ordinal !== null) {
      return end.ordinal < endOrdinalExclusive
    }
    return endByteOffset === null || end.byteOffset <= endByteOffset
  })
}

function hasTurnPrefix(turns: unknown[], prefix: unknown[]): boolean {
  const concretePrefix = prefix.filter((turn) => !isForkBoundaryTurn(turn))
  if (concretePrefix.length === 0) return false
  if (turns.length < concretePrefix.length) return false
  return concretePrefix.every((turn, index) => (
    readNonEmptyString(asRecord(turn)?.id) === readNonEmptyString(asRecord(turns[index])?.id)
  ))
}

function sharedConcreteTurnPrefixLength(childTurns: unknown[], sourceTurns: unknown[]): number {
  const childConcreteTurns = childTurns.filter((turn) => !isForkBoundaryTurn(turn))
  const sourceConcreteTurns = sourceTurns.filter((turn) => !isForkBoundaryTurn(turn))
  let prefixLength = 0
  const maxLength = Math.min(childConcreteTurns.length, sourceConcreteTurns.length)
  while (prefixLength < maxLength) {
    const childTurnId = readNonEmptyString(asRecord(childConcreteTurns[prefixLength])?.id)
    const sourceTurnId = readNonEmptyString(asRecord(sourceConcreteTurns[prefixLength])?.id)
    if (!childTurnId || childTurnId !== sourceTurnId) break
    prefixLength += 1
  }
  return prefixLength
}

function takeForkPrefixTurns(turns: unknown[], concreteTurnCount: number): unknown[] {
  const prefix: unknown[] = []
  let includedConcreteTurns = 0
  for (const turn of turns) {
    if (isForkBoundaryTurn(turn)) {
      if (includedConcreteTurns < concreteTurnCount) prefix.push(turn)
      continue
    }
    if (includedConcreteTurns >= concreteTurnCount) break
    prefix.push(turn)
    includedConcreteTurns += 1
  }
  return prefix
}

function sharedUserMessageEntryPrefixLength(
  childEntries: SessionUserMessageIndexEntry[],
  sourceEntries: SessionUserMessageIndexEntry[],
): number {
  const childConcreteEntries = childEntries.filter((entry) => entry.kind !== 'forkBoundary')
  const sourceConcreteEntries = sourceEntries.filter((entry) => entry.kind !== 'forkBoundary')
  let prefixLength = 0
  const maxLength = Math.min(childConcreteEntries.length, sourceConcreteEntries.length)
  while (prefixLength < maxLength) {
    if (childConcreteEntries[prefixLength]?.turnId !== sourceConcreteEntries[prefixLength]?.turnId) break
    prefixLength += 1
  }
  return prefixLength
}

function takeForkPrefixUserMessageEntries(
  entries: SessionUserMessageIndexEntry[],
  concreteEntryCount: number,
): SessionUserMessageIndexEntry[] {
  const prefix: SessionUserMessageIndexEntry[] = []
  let includedConcreteEntries = 0
  for (const entry of entries) {
    if (entry.kind === 'forkBoundary') {
      if (includedConcreteEntries < concreteEntryCount) prefix.push(entry)
      continue
    }
    if (includedConcreteEntries >= concreteEntryCount) break
    prefix.push(entry)
    includedConcreteEntries += 1
  }
  return prefix
}

/**
 * Reconstruct history for both paginated and legacy forks on the compatibility
 * `thread/read` surface, with a synthetic, non-persistent turn at the exact
 * fork boundary for UI rendering.
 */
export async function mergePaginatedForkHistoryIntoThreadResult(
  result: unknown,
  readThread: (threadId: string) => Promise<unknown>,
  lineageByThreadId?: Map<string, SessionForkLineage>,
  visitedThreadIds = new Set<string>(),
): Promise<unknown> {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : null
  const threadId = readNonEmptyString(thread?.id)
  if (!record || !thread || !turns || !threadId || visitedThreadIds.has(threadId)) return result

  let currentLineage: SessionForkLineage | null = null
  const currentSessionPath = readNonEmptyString(thread.path)
  if (currentSessionPath && isAbsolute(currentSessionPath)) {
    currentLineage = await readSessionForkLineage(
      currentSessionPath,
      isArchivedSessionPath(currentSessionPath),
    ).catch(() => null)
    if (!currentLineage?.forkedFromId) return result
  }

  const lineages = new Map(
    lineageByThreadId ?? (await getSessionForkLineage()).map((entry) => [entry.threadId, entry]),
  )
  // Do not let an older global scan hide the currently opened fork.
  if (currentLineage) lineages.set(currentLineage.threadId, currentLineage)
  const lineage = lineages.get(threadId)
  if (!lineage?.forkedFromId) return result
  const sourceThreadId = lineage.isPaginated
    ? lineage.historyBaseThreadId
    : lineage.forkedFromId
  if (!sourceThreadId) return result

  const sourceLineage = lineages.get(sourceThreadId)
  if (lineage.isPaginated && !sourceLineage) return result

  const boundaryTurn = makeForkBoundaryTurn(threadId, sourceThreadId)

  if (turns.some((turn) => readNonEmptyString(asRecord(turn)?.id) === boundaryTurn.id)) return result

  if (lineage.isPaginated) {
    const localTurnEnds = await readCachedSessionTurnEnds(lineage.sessionPath).catch(() => new Map<string, SessionTurnEnd>())
    const firstLocalTurnIndex = turns.findIndex((turn) => {
      const turnId = readNonEmptyString(asRecord(turn)?.id)
      return turnId.length > 0 && localTurnEnds.has(turnId)
    })

    // Newer app-server builds can materialize the inherited prefix themselves.
    // Recognize that shape from locally persisted turn ids so the common path
    // only inserts the visual separator and does not issue ancestor reads.
    if (firstLocalTurnIndex > 0) {
      return {
        ...record,
        thread: {
          ...thread,
          turns: [...turns.slice(0, firstLocalTurnIndex), boundaryTurn, ...turns.slice(firstLocalTurnIndex)],
        },
      }
    }
  }

  const nextVisitedThreadIds = new Set(visitedThreadIds)
  nextVisitedThreadIds.add(threadId)
  let sourceResult: unknown
  try {
    sourceResult = await readThread(sourceThreadId)
  } catch {
    return result
  }
  const mergedSourceResult = await mergePaginatedForkHistoryIntoThreadResult(
    sourceResult,
    readThread,
    lineages,
    nextVisitedThreadIds,
  )
  const sourceTurns = Array.isArray(asRecord(asRecord(mergedSourceResult)?.thread)?.turns)
    ? asRecord(asRecord(mergedSourceResult)?.thread)?.turns as unknown[]
    : []
  if (!lineage.isPaginated) {
    const rawSourceTurns = Array.isArray(asRecord(asRecord(sourceResult)?.thread)?.turns)
      ? asRecord(asRecord(sourceResult)?.thread)?.turns as unknown[]
      : []
    const sharedPrefixLength = sharedConcreteTurnPrefixLength(turns, rawSourceTurns)
    return {
      ...record,
      thread: {
        ...thread,
        turns: [
          ...takeForkPrefixTurns(sourceTurns, sharedPrefixLength),
          boundaryTurn,
          ...turns.filter((turn) => !isForkBoundaryTurn(turn)).slice(sharedPrefixLength),
        ],
      },
    }
  }
  if (!sourceLineage) return result
  const inheritedTurns = await filterTurnsToHistoryBase(
    sourceTurns,
    sourceLineage,
    lineage.historyBaseOrdinal,
    lineage.historyBaseByteOffset,
  )
  const localTurns = hasTurnPrefix(turns, inheritedTurns)
    ? turns.slice(inheritedTurns.filter((turn) => !isForkBoundaryTurn(turn)).length)
    : turns

  return {
    ...record,
    thread: {
      ...thread,
      turns: [...inheritedTurns, boundaryTurn, ...localTurns],
    },
  }
}

async function mergePaginatedForkHistoryIntoThreadResultFromSession(
  appServer: AppServerProcess,
  result: unknown,
): Promise<unknown> {
  return mergePaginatedForkHistoryIntoThreadResult(
    result,
    async (threadId) => await mergeRecoveredTurnItemsIntoThreadResultFromSession(
      appServer,
      await appServer.readThreadForTurnPage(threadId),
    ),
  )
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  const record = asRecord(payload)
  if (!record) return fallback

  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error

  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }

  return fallback
}

export function isUnauthenticatedRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('authentication required') && message.includes('rate limits')
}

export function isEmptyThreadReadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('failed to read thread') && message.includes('rollout') && message.includes('is empty')
}

export function isPaginatedThreadReadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('paginated threads')
    && message.includes('thread/read')
    && message.includes('includeturns')
}

function isNoRolloutFoundError(error: unknown): boolean {
  return getErrorMessage(error, '').toLowerCase().includes('no rollout found')
}

function isThreadNotFoundError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('thread not found') || message.includes('thread not found:')
}

function isNoActiveTurnToInterruptError(error: unknown): boolean {
  return getErrorMessage(error, '').toLowerCase().includes('no active turn to interrupt')
}

function isOwningRuntimeRetryMethod(method: string): boolean {
  return method === 'thread/fork' || method === 'turn/steer' || method === 'turn/interrupt'
}

const warnedCodexAuthReadFailures = new Set<string>()

function getErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

function getCodexAuthReadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error)
}

function warnCodexAuthReadFailure(authPath: string, error: unknown): void {
  const message = getCodexAuthReadErrorMessage(error)
  const warningKey = `${authPath}:${message}`
  if (warnedCodexAuthReadFailures.has(warningKey)) return
  warnedCodexAuthReadFailures.add(warningKey)
  console.warn('[codex-auth] Unable to read Codex auth state', { path: authPath, error: message })
}

export async function hasUsableCodexAuth(): Promise<boolean> {
  const authPath = getCodexAuthPath()
  try {
    const raw = await readFile(authPath, 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    return Boolean(auth.tokens?.access_token?.trim() || auth.tokens?.refresh_token?.trim())
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      warnCodexAuthReadFailure(authPath, error)
    }
    return false
  }
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function logProviderModelDiscoveryWarning(message: string, details: Record<string, unknown>): void {
  console.warn('[codex-provider-models]', message, details)
}

function isTimeoutError(payload: unknown): boolean {
  return payload instanceof Error && (payload.name === 'AbortError' || payload.name === 'TimeoutError')
}

function formatProjectlessDateSegment(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function buildProjectlessPromptSlug(prompt: string | null): string {
  const slug = prompt
    ?.toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 6)
    .join('-')
    .slice(0, PROJECTLESS_THREAD_SLUG_MAX_LENGTH)
  return slug && slug.length > 0 ? slug : 'new-chat'
}

async function ensureRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory`)
  }
}

async function createProjectlessThreadDirectory(prompt: string | null): Promise<{ cwd: string; outputDirectory: string; workspaceRoot: string }> {
  const workspaceRoot = join(homedir(), 'Documents', 'Codex')
  await mkdir(workspaceRoot, { recursive: true })
  await ensureRealDirectory(workspaceRoot, 'Projectless workspace root')

  const dateDir = join(workspaceRoot, formatProjectlessDateSegment())
  await mkdir(dateDir, { recursive: true })
  await ensureRealDirectory(dateDir, 'Projectless thread date directory')

  const slug = buildProjectlessPromptSlug(prompt)
  for (let index = 0; index < PROJECTLESS_THREAD_DIRECTORY_MAX_ATTEMPTS; index += 1) {
    const folderName = index === 0 ? slug : `${slug}-${index + 1}`
    const cwd = join(dateDir, folderName)
    try {
      await mkdir(cwd, { recursive: false })
      return { cwd, outputDirectory: cwd, workspaceRoot }
    } catch {
      try {
        await stat(cwd)
      } catch {
        throw new Error('Failed to create new chat folder')
      }
    }
  }

  throw new Error('Unable to create a unique new chat folder')
}

function normalizeGithubCloneUrl(rawUrl: string): { url: string; repoName: string } {
  const trimmedUrl = rawUrl.trim()
  if (!trimmedUrl) throw new Error('Missing GitHub repository URL')

  const sshMatch = trimmedUrl.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u)
  if (sshMatch) {
    const repoName = sshMatch[2]
    return { url: `git@github.com:${sshMatch[1]}/${repoName}.git`, repoName }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmedUrl)
  } catch {
    throw new Error('Enter a valid GitHub repository URL')
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only github.com repository URLs are supported')
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new Error('Enter a GitHub repository URL with owner and repository name')
  }
  const owner = segments[0]
  const repoName = segments[1].replace(/\.git$/iu, '')
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repoName)) {
    throw new Error('GitHub repository owner or name contains unsupported characters')
  }
  return { url: `https://github.com/${owner}/${repoName}.git`, repoName }
}

async function cloneGithubRepositoryIntoBase(rawUrl: string, rawBasePath: string): Promise<string> {
  const basePath = rawBasePath.trim()
  if (!basePath) throw new Error('Missing clone destination folder')
  const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
  await ensureRealDirectory(normalizedBasePath, 'Clone destination folder')

  const { url, repoName } = normalizeGithubCloneUrl(rawUrl)
  const targetPath = join(normalizedBasePath, repoName)
  try {
    await stat(targetPath)
    throw new Error(`Destination already exists: ${targetPath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }

  try {
    await runCommand('git', ['clone', url, targetPath], { cwd: normalizedBasePath, timeoutMs: 5 * 60_000 })
  } catch (error) {
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await persistWorkspaceRoot(targetPath, '')
  return targetPath
}

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function normalizeQueryParams(value: unknown): URLSearchParams {
  const params = new URLSearchParams()
  const record = asRecord(value)
  if (!record) return params

  for (const [key, rawValue] of Object.entries(record)) {
    const normalized = normalizeHeaderValue(rawValue)
    if (!normalized) continue
    params.set(key, normalized)
  }

  return params
}

function buildProviderModelsUrl(baseUrl: string, queryParams: unknown): URL {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}models` : `${url.pathname}/models`
  const extraParams = normalizeQueryParams(queryParams)
  for (const [key, value] of extraParams.entries()) {
    url.searchParams.set(key, value)
  }
  return url
}

function normalizeProviderModelsData(payload: unknown): string[] {
  const record = asRecord(payload)
  const rows = Array.isArray(record?.data) ? record.data : null
  if (!rows) {
    throw new Error('provider /models payload is missing a data array')
  }

  const ids: string[] = []
  for (const row of rows) {
    const entry = asRecord(row)
    const candidate = readNonEmptyString(entry?.id)
    if (!candidate || ids.includes(candidate)) continue
    ids.push(candidate)
  }
  return ids
}

async function fetchCustomEndpointDefaultModel(baseUrl: string, apiKey: string): Promise<string> {
  const normalizedBaseUrl = baseUrl.trim()
  if (!normalizedBaseUrl) return ''

  try {
    const modelsUrl = buildProviderModelsUrl(normalizedBaseUrl, null)
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS) })
    if (!response.ok) return ''
    const payload = await response.json() as unknown
    const modelIds = normalizeProviderModelsData(payload)
    return modelIds[0] ?? ''
  } catch {
    return ''
  }
}

async function fetchOpenCodeZenModelIds(apiKey: string | null | undefined): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (apiKey && apiKey !== 'dummy') {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const response = await fetch('https://opencode.ai/zen/v1/models', {
    headers,
    signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return []
  return normalizeProviderModelsData(await response.json() as unknown)
}

function sortOpenCodeZenModelIds(modelIds: string[]): string[] {
  const freeIds = modelIds.filter((id) => id.endsWith('-free') || id === OPENCODE_ZEN_DEFAULT_MODEL)
  const paidIds = modelIds.filter((id) => !id.endsWith('-free') && id !== OPENCODE_ZEN_DEFAULT_MODEL)
  return [...freeIds, ...paidIds]
}

const CODEX_UI_PROVIDER_MODELS_CACHE_TTL_MS = 60_000
const codexUiProviderModelsCache = new Map<string, { expiresAt: number; promise: Promise<ProviderModelsResponse> }>()

function orderProviderModels(modelIds: string[], preferredModel: string | null | undefined): string[] {
  const preferred = preferredModel?.trim()
  if (!preferred || !modelIds.includes(preferred)) return modelIds
  return [preferred, ...modelIds.filter((modelId) => modelId !== preferred)]
}

function providerModelsUseCodexDefaultList(models: ProviderModelsResponse): boolean {
  return models.source === 'codex-ui-default'
}

function codexUiProviderModelsCacheKey(
  descriptor: CodexUiProviderDescriptor,
  preferredModel: string | null | undefined,
): string {
  return JSON.stringify({
    id: descriptor.id,
    catalog: descriptor.modelCatalogJson,
    defaultModel: descriptor.defaultModel,
    providerInfo: descriptor.providerInfo,
    preferredModel: preferredModel?.trim() ?? '',
  })
}

async function loadCodexUiProviderModelIds(
  descriptor: CodexUiProviderDescriptor,
  preferredModel?: string | null,
): Promise<ProviderModelsResponse> {
  const catalogSelection = getCodexUiProviderCatalogSelection(descriptor, preferredModel)
  if (catalogSelection.models.length > 0 && catalogSelection.metadata.length > 0) {
    return {
      data: orderProviderModels(catalogSelection.models, catalogSelection.currentModel),
      providerId: descriptor.id,
      source: 'codex-ui-catalog',
    }
  }

  const providerModelIds = await fetchCodexUiProviderModelIds(descriptor)
  if (providerModelIds.length > 0) {
    const preferred = preferredModel?.trim()
    const defaultModel = descriptor.defaultModel?.trim()
    const currentModel = preferred && providerModelIds.includes(preferred)
      ? preferred
      : defaultModel && providerModelIds.includes(defaultModel)
        ? defaultModel
        : providerModelIds[0]
    return {
      data: orderProviderModels(providerModelIds, currentModel),
      providerId: descriptor.id,
      source: 'codex-ui-provider',
    }
  }

  const fallbackModel = descriptor.defaultModel?.trim() || catalogSelection.currentModel.trim()
  return {
    data: fallbackModel ? [fallbackModel] : [],
    providerId: descriptor.id,
    source: 'codex-ui-default',
  }
}

async function readCodexUiProviderModelIds(
  descriptor: CodexUiProviderDescriptor,
  preferredModel?: string | null,
): Promise<ProviderModelsResponse> {
  const key = codexUiProviderModelsCacheKey(descriptor, preferredModel)
  const now = Date.now()
  const cached = codexUiProviderModelsCache.get(key)
  if (cached && cached.expiresAt > now) {
    return await cached.promise
  }

  const promise = loadCodexUiProviderModelIds(descriptor, preferredModel)
    .catch((error) => {
      codexUiProviderModelsCache.delete(key)
      throw error
    })
  codexUiProviderModelsCache.set(key, {
    expiresAt: now + CODEX_UI_PROVIDER_MODELS_CACHE_TTL_MS,
    promise,
  })
  return await promise
}

async function readProviderBackedModelIds(appServer: AppServerProcess): Promise<ProviderModelsResponse> {
  const configPayload = asRecord(await appServer.rpc('config/read', {}))
  const config = asRecord(configPayload?.config)
  const providerId = readNonEmptyString(config?.model_provider)
  if (!providerId) {
    return { data: [], providerId: '', source: 'provider' }
  }

  const codexUiProvider = readCodexUiProviderDescriptor(providerId)
  if (codexUiProvider) {
    const dynamicModels = await readCodexUiProviderModelIds(codexUiProvider, readNonEmptyString(config?.model))
    if (providerModelsUseCodexDefaultList(dynamicModels)) {
      return { data: [], providerId: dynamicModels.providerId, source: dynamicModels.source }
    }
    if (dynamicModels.data.length > 0) {
      return dynamicModels
    }
  }

  const providers = asRecord(config?.model_providers)
  const provider = asRecord(providers?.[providerId])
  if (!provider) {
    logProviderModelDiscoveryWarning('configured provider is missing from model_providers', { providerId })
    return { data: [], providerId, source: 'provider' }
  }

  const wireApi = readNonEmptyString(provider.wire_api)
  if (wireApi !== 'responses') {
    return { data: [], providerId, source: 'provider' }
  }

  const baseUrl = readNonEmptyString(provider.base_url)
  if (!baseUrl) {
    logProviderModelDiscoveryWarning('responses provider is missing base_url', { providerId })
    return { data: [], providerId, source: 'provider' }
  }

  const headers = new Headers()
  const configuredHeaders = asRecord(provider.http_headers)
  if (configuredHeaders) {
    for (const [key, rawValue] of Object.entries(configuredHeaders)) {
      const normalized = normalizeHeaderValue(rawValue)
      if (!normalized) continue
      headers.set(key, normalized)
    }
  }

  const bearerToken = readNonEmptyString(provider.experimental_bearer_token)
  if (bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${bearerToken}`)
  }

  const envKey = readNonEmptyString(provider.env_key)
  const envHttpHeaders = asRecord(provider.env_http_headers)
  if (envKey || envHttpHeaders) {
    logProviderModelDiscoveryWarning('provider discovery skipped env-backed auth/header expansion', {
      providerId,
      hasEnvKey: Boolean(envKey),
      hasEnvHttpHeaders: Boolean(envHttpHeaders),
    })
  }

  let requestUrl: URL
  try {
    requestUrl = buildProviderModelsUrl(baseUrl, provider.query_params)
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models URL was invalid', {
      providerId,
      error: getErrorMessage(error, 'invalid url'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  let response: Response
  try {
    response = await fetch(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models request failed', {
      providerId,
      error: isTimeoutError(error) ? `request timed out after ${PROVIDER_MODELS_FETCH_TIMEOUT_MS}ms` : getErrorMessage(error, 'network error'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models response was not valid JSON', {
      providerId,
      status: response.status,
      error: getErrorMessage(error, 'invalid json'),
    })
    return { data: [], providerId, source: 'provider' }
  }

  if (!response.ok) {
    logProviderModelDiscoveryWarning('provider /models request returned non-2xx', {
      providerId,
      status: response.status,
      statusText: response.statusText,
    })
    return { data: [], providerId, source: 'provider' }
  }

  try {
    return {
      data: normalizeProviderModelsData(payload),
      providerId,
      source: 'provider',
    }
  } catch (error) {
    logProviderModelDiscoveryWarning('provider /models payload was invalid', {
      providerId,
      error: getErrorMessage(error, 'invalid payload'),
    })
    return { data: [], providerId, source: 'provider' }
  }
}

function readThreadTurnStartIndex(threadReadPayload: unknown): number {
  const payload = asRecord(threadReadPayload)
  const raw = payload?.threadTurnStartIndex
  return Math.max(0, Math.floor(typeof raw === 'number' && Number.isFinite(raw) ? raw : 0))
}

function appendUniqueSearchPart(parts: string[], seen: Set<string>, value: unknown): void {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || seen.has(text)) return
  seen.add(text)
  parts.push(text)
}

function fileChangeSearchText(change: UiFileChange): string {
  return [
    change.operation,
    change.path,
    change.movedToPath ?? '',
    change.diff ?? '',
    Number.isFinite(change.addedLineCount) ? `+${change.addedLineCount}` : '',
    Number.isFinite(change.removedLineCount) ? `-${change.removedLineCount}` : '',
  ].filter(Boolean).join('\n')
}

function messageSearchText(message: UiMessage): string {
  const parts: string[] = []
  const seen = new Set<string>()
  appendUniqueSearchPart(parts, seen, message.text)
  appendUniqueSearchPart(parts, seen, message.rawPayload)

  const command = message.commandExecution
  if (command) {
    appendUniqueSearchPart(parts, seen, command.command)
    appendUniqueSearchPart(parts, seen, command.cwd ?? '')
    appendUniqueSearchPart(parts, seen, command.aggregatedOutput)
    appendUniqueSearchPart(parts, seen, command.exitCode === null ? '' : `exit ${command.exitCode}`)
    appendUniqueSearchPart(parts, seen, command.status)
  }

  const toolCall = message.toolCall
  if (toolCall) {
    appendUniqueSearchPart(parts, seen, toolCall.title)
    appendUniqueSearchPart(parts, seen, toolCall.name)
    appendUniqueSearchPart(parts, seen, toolCall.status)
    appendUniqueSearchPart(parts, seen, toolCall.server ?? '')
    appendUniqueSearchPart(parts, seen, toolCall.meta.join('\n'))
    appendUniqueSearchPart(parts, seen, toolCall.progress)
    appendUniqueSearchPart(parts, seen, toolCall.input)
    appendUniqueSearchPart(parts, seen, toolCall.output)
    appendUniqueSearchPart(parts, seen, toolCall.error)
  }

  for (const attachment of message.fileAttachments ?? []) {
    appendUniqueSearchPart(parts, seen, `${attachment.label}\n${attachment.path}`)
  }
  for (const skill of message.skills ?? []) {
    appendUniqueSearchPart(parts, seen, `${skill.name}\n${skill.path}`)
  }
  for (const change of message.fileChanges ?? []) {
    appendUniqueSearchPart(parts, seen, fileChangeSearchText(change))
  }

  return parts.join('\n').trim()
}

export function extractThreadMessageSearchRows(threadReadPayload: unknown): ThreadMessageSearchRow[] {
  const messages = normalizeThreadMessagesV2(
    threadReadPayload as Parameters<typeof normalizeThreadMessagesV2>[0],
    readThreadTurnStartIndex(threadReadPayload),
  )
  return messages
    .map((message) => ({ message, text: messageSearchText(message) }))
    .filter((row) => row.text.length > 0)
}

function extractThreadMessageText(threadReadPayload: unknown): string {
  return extractThreadMessageSearchRows(threadReadPayload)
    .map((row) => row.text)
    .filter(Boolean)
    .join('\n')
    .trim()
}

function buildSearchSnippet(text: string, matchStart: number, matchEnd: number): {
  snippet: string
  snippetMatchStart: number
  snippetMatchEnd: number
} {
  const rawStart = Math.max(0, matchStart - THREAD_MESSAGE_SEARCH_SNIPPET_CONTEXT)
  const rawEnd = Math.min(text.length, matchEnd + THREAD_MESSAGE_SEARCH_SNIPPET_CONTEXT)
  const prefix = rawStart > 0 ? '...' : ''
  const suffix = rawEnd < text.length ? '...' : ''
  const rawSnippet = `${prefix}${text.slice(rawStart, rawEnd)}${suffix}`
  const snippet = rawSnippet.replace(/[\r\n\t]/gu, ' ')
  const snippetMatchStart = prefix.length + matchStart - rawStart
  const snippetMatchEnd = prefix.length + matchEnd - rawStart
  return { snippet, snippetMatchStart, snippetMatchEnd }
}

function normalizeBoundedInteger(value: number, fallback: number, min: number, max: number): number {
  const next = Math.floor(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

export function searchThreadMessagesInPayload(
  threadId: string,
  query: string,
  threadReadPayload: unknown,
  limit = THREAD_MESSAGE_SEARCH_DEFAULT_LIMIT,
): ThreadMessageSearchResponse {
  const normalizedThreadId = threadId.trim()
  const normalizedQuery = query.trim()
  const cappedLimit = normalizeBoundedInteger(limit, THREAD_MESSAGE_SEARCH_DEFAULT_LIMIT, 1, THREAD_MESSAGE_SEARCH_MAX_LIMIT)
  if (!normalizedThreadId || !normalizedQuery) {
    return {
      threadId: normalizedThreadId,
      query: normalizedQuery,
      totalMatches: 0,
      truncated: false,
      results: [],
    }
  }

  const lowerQuery = normalizedQuery.toLowerCase()
  const matches: RankedThreadMessageSearchResult[] = []
  let totalMatches = 0

  const rows = extractThreadMessageSearchRows(threadReadPayload)
  for (let rowOrder = 0; rowOrder < rows.length; rowOrder += 1) {
    const row = rows[rowOrder]
    const lowerText = row.text.toLowerCase()
    let occurrenceIndex = 0
    let offset = 0
    while (offset <= lowerText.length) {
      const matchStart = lowerText.indexOf(lowerQuery, offset)
      if (matchStart < 0) break
      const matchEnd = matchStart + lowerQuery.length
      const { snippet, snippetMatchStart, snippetMatchEnd } = buildSearchSnippet(row.text, matchStart, matchEnd)
      totalMatches += 1
      const turnIndex = typeof row.message.turnIndex === 'number' ? row.message.turnIndex : -1
      const turnId = row.message.turnId?.trim() ?? ''
      const messageType = row.message.messageType ?? ''
      matches.push({
        id: `${row.message.id}:${occurrenceIndex}:${matchStart}`,
        turnId,
        turnIndex,
        messageId: row.message.id,
        role: row.message.role,
        messageType,
        occurrenceIndex,
        snippet,
        snippetMatchStart,
        snippetMatchEnd,
        rowOrder,
        matchStart,
      })
      occurrenceIndex += 1
      offset = matchEnd > matchStart ? matchEnd : matchStart + 1
    }
  }

  const results = matches
    .sort((left, right) => {
      const leftTurn = left.turnIndex >= 0 ? left.turnIndex : Number.POSITIVE_INFINITY
      const rightTurn = right.turnIndex >= 0 ? right.turnIndex : Number.POSITIVE_INFINITY
      if (leftTurn !== rightTurn) return leftTurn > rightTurn ? -1 : 1
      if (left.rowOrder !== right.rowOrder) return right.rowOrder - left.rowOrder
      if (left.occurrenceIndex !== right.occurrenceIndex) return right.occurrenceIndex - left.occurrenceIndex
      return right.matchStart - left.matchStart
    })
    .slice(0, cappedLimit)
    .map(({ rowOrder: _rowOrder, matchStart: _matchStart, ...result }) => result)

  return {
    threadId: normalizedThreadId,
    query: normalizedQuery,
    totalMatches,
    truncated: totalMatches > results.length,
    results,
  }
}

export function getThreadTurnWindowBounds(
  turns: unknown[],
  centerTurnId: string,
  before: number,
  after: number,
): { centerIndex: number; startIndex: number; endIndex: number } | null {
  const normalizedCenterTurnId = centerTurnId.trim()
  if (!normalizedCenterTurnId) return null
  const centerIndex = turns.findIndex((turn) => asRecord(turn)?.id === normalizedCenterTurnId)
  if (centerIndex < 0) return null
  const safeBefore = normalizeBoundedInteger(before, 8, 0, 50)
  const safeAfter = normalizeBoundedInteger(after, 8, 0, 50)
  return {
    centerIndex,
    startIndex: Math.max(0, centerIndex - safeBefore),
    endIndex: Math.min(turns.length, centerIndex + safeAfter + 1),
  }
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : ''
}

async function resolveDefaultCodexModelProvider(appServer: RpcExecutor): Promise<string> {
  try {
    const payload = asRecord(await appServer.rpc('config/read', {}))
    const config = asRecord(payload?.config)
    const provider = readNonEmptyString(config?.model_provider).trim()
    return provider && provider !== 'openai' ? provider : ''
  } catch {
    return ''
  }
}

export async function rewriteOpenAiThreadModelProvider(
  appServer: RpcExecutor,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!THREAD_MODEL_PROVIDER_OVERRIDE_METHODS.has(method)) return params
  const paramsRecord = asRecord(params)
  if (!paramsRecord) return params

  const modelProvider = readNonEmptyString(paramsRecord.modelProvider)
    || readNonEmptyString(paramsRecord.model_provider)
  if (modelProvider.trim() !== 'openai') return params

  const defaultProvider = await resolveDefaultCodexModelProvider(appServer)
  if (!defaultProvider) return params

  return {
    ...paramsRecord,
    modelProvider: defaultProvider,
  }
}

function readProtocolToken(value: unknown): string {
  return readNonEmptyString(value).trim().toLowerCase()
}

function isRunningProtocolToken(value: string): boolean {
  return value === 'inprogress' || value === 'in_progress' || value === 'running' || value === 'active'
}

function isTerminalProtocolToken(value: string): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'canceled'
}

function turnHasAssistantResult(turn: Record<string, unknown> | null): boolean {
  const items = Array.isArray(turn?.items) ? turn.items : []
  return items.some((item) => {
    const itemRecord = asRecord(item)
    const type = readProtocolToken(itemRecord?.type)
    if (isRunningProtocolToken(readProtocolToken(itemRecord?.status))) return false
    return type.length > 0 && type !== 'usermessage' && type !== 'reasoning'
  })
}

type InterruptedTurnAutoContinueSnapshot = {
  threadId: string
  turnId: string
}

export function shouldAutoContinueInterruptedThreadFromThreadRead(
  response: unknown,
  intentionalInterruptTurnIds: ReadonlySet<string>,
): InterruptedTurnAutoContinueSnapshot | null {
  const record = asRecord(response)
  const thread = asRecord(record?.thread)
  if (!thread) return null

  const threadStatus = asRecord(thread.status)
  if (readProtocolToken(threadStatus?.type) !== 'idle') return null

  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const latestTurn = asRecord(turns.at(-1))
  const threadId = readNonEmptyString(thread.id).trim()
  const turnId = readNonEmptyString(latestTurn?.id).trim()
  if (!threadId || !turnId) return null
  if (intentionalInterruptTurnIds.has(turnId)) return null
  if (readProtocolToken(latestTurn?.status) !== 'interrupted') return null

  return { threadId, turnId }
}

function isPotentiallyAutoContinuedStatusChange(notification: { method: string; params: unknown }): boolean {
  if (notification.method !== 'thread/status/changed') return false
  const params = asRecord(notification.params)
  if (!params) return false

  const thread = asRecord(params.thread)
  const candidates = [params.status, params.threadStatus, params.thread_status, thread?.status]
  for (const candidate of candidates) {
    const status = asRecord(candidate)
    const type = readProtocolToken(status?.type || candidate)
    if (type === 'idle' || type === 'interrupted') return true
  }
  return false
}

function readThreadArchiveFallbackName(threadReadResult: unknown): string {
  const record = asRecord(threadReadResult)
  const thread = asRecord(record?.thread)
  return (
    readNonEmptyString(thread?.name)
    || readNonEmptyString(thread?.title)
    || readNonEmptyString(thread?.preview)
    || 'Untitled thread'
  )
}

function isArchivedThreadReadResult(threadReadResult: unknown): boolean {
  const record = asRecord(threadReadResult)
  const thread = asRecord(record?.thread)
  const sessionPath = readNonEmptyString(thread?.path)
  return sessionPath.split(/[\\/]+/u).includes('archived_sessions')
}

export async function callRpcWithArchiveRecovery(
  appServer: RpcExecutor,
  method: string,
  params: unknown,
): Promise<unknown> {
  try {
    return await callRpcWithRateLimitDecodeRecovery(appServer, method, params)
  } catch (error) {
    if (method !== 'thread/archive') {
      throw error
    }

    const paramsRecord = asRecord(params)
    const threadId = readNonEmptyString(paramsRecord?.threadId)
    const errorMessage = getErrorMessage(error, '')
    if (!threadId || !errorMessage.includes('no rollout found')) {
      throw error
    }

    let threadReadResult: unknown = null
    try {
      threadReadResult = await appServer.rpc('thread/read', {
        threadId,
        includeTurns: false,
      })
      if (isArchivedThreadReadResult(threadReadResult)) {
        return null
      }
    } catch {
      // If metadata cannot be read, still try materializing a title before retrying archive.
    }

    await appServer.rpc('thread/name/set', {
      threadId,
      name: readThreadArchiveFallbackName(threadReadResult),
    })
    return appServer.rpc(method, params ?? null)
  }
}

type TerminalQuickCommand = {
  label: string
  value: string
  source: 'package' | 'script' | 'make'
}

async function listTerminalQuickCommands(cwd: string): Promise<TerminalQuickCommand[]> {
  const normalizedCwd = isAbsolute(cwd) ? cwd : resolve(cwd)
  const info = await stat(normalizedCwd)
  if (!info.isDirectory()) {
    throw new Error('Terminal cwd is not a directory')
  }

  const commands: TerminalQuickCommand[] = []
  const seen = new Set<string>()
  const addCommand = (command: TerminalQuickCommand) => {
    if (!command.value || seen.has(command.value)) return
    seen.add(command.value)
    commands.push(command)
  }

  await addPackageJsonCommands(normalizedCwd, addCommand)
  await addMakefileCommands(normalizedCwd, addCommand)
  await addRootScriptCommands(normalizedCwd, addCommand)
  await addScriptsDirectoryCommands(normalizedCwd, addCommand)
  return commands
}

async function addPackageJsonCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    const scripts = asRecord(record?.scripts)
    if (!scripts) return
    const packageManager = resolvePackageManager(cwd)
    for (const scriptName of Object.keys(scripts)) {
      if (typeof scripts[scriptName] !== 'string') continue
      const value = formatPackageScriptCommand(packageManager, scriptName)
      addCommand({
        label: value,
        value,
        source: 'package',
      })
    }
  } catch {
    // A project without package.json simply has no package quick commands.
  }
}

async function addMakefileCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  const makefilePath = existsSync(join(cwd, 'Makefile'))
    ? join(cwd, 'Makefile')
    : existsSync(join(cwd, 'makefile'))
      ? join(cwd, 'makefile')
      : ''
  if (!makefilePath) return

  try {
    const raw = await readFile(makefilePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_.@%/+~-][A-Za-z0-9_.@%/+~-]*)\s*:(?![=])/.exec(line)
      if (!match) continue
      const target = match[1]
      if (!target || target.startsWith('.')) continue
      const value = `make ${quoteShellTokenIfNeeded(target)}`
      addCommand({
        label: value,
        value,
        source: 'make',
      })
    }
  } catch {
    // Ignore unreadable Makefiles for quick-command discovery.
  }
}

async function addRootScriptCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  await addScriptFileCommands(cwd, '.', addCommand)
}

async function addScriptsDirectoryCommands(
  cwd: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  await addScriptFileCommands(join(cwd, 'scripts'), './scripts', addCommand)
}

async function addScriptFileCommands(
  directory: string,
  commandPrefix: string,
  addCommand: (command: TerminalQuickCommand) => void,
): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.sh') && !entry.name.endsWith('.cmd')) continue
      const value = `${commandPrefix}/${quoteShellTokenIfNeeded(entry.name)}`
      addCommand({
        label: value,
        value,
        source: 'script',
      })
    }
  } catch {
    // A project without script files simply has no script-file quick commands.
  }
}

function resolvePackageManager(cwd: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function formatPackageScriptCommand(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', scriptName: string): string {
  const quoted = quoteShellTokenIfNeeded(scriptName)
  if (packageManager === 'npm') return `npm run ${quoted}`
  if (packageManager === 'pnpm') return `pnpm run ${quoted}`
  if (packageManager === 'bun') return `bun run ${quoted}`
  return `yarn ${quoted}`
}

function quoteShellTokenIfNeeded(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

type ComposioCliInvocation = { command: string; args: string[]; displayCommand: string }

function buildComposioInvocation(args: string[]): ComposioCliInvocation | null {
  const overrideCommand = process.env.CODEXUI_COMPOSIO_COMMAND?.trim()
  if (overrideCommand) {
    const invocation = getSpawnInvocation(overrideCommand, args)
    return {
      command: invocation.command,
      args: invocation.args,
      displayCommand: `${overrideCommand} ${args.map(quoteShellTokenIfNeeded).join(' ')}`.trim(),
    }
  }
  return buildInstalledComposioInvocation(args)
}

function buildInstalledComposioInvocation(args: string[]): ComposioCliInvocation | null {
  const candidates = [
    join(homedir(), '.composio', 'composio'),
    'composio',
  ]
  for (const candidate of candidates) {
    if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) continue
    const invocation = getSpawnInvocation(candidate, args)
    return {
      command: invocation.command,
      args: invocation.args,
      displayCommand: `${candidate} ${args.map(quoteShellTokenIfNeeded).join(' ')}`.trim(),
    }
  }
  return null
}

function probeComposioInvocation(invocation: ComposioCliInvocation): { available: boolean; cliVersion: string; output: string } {
  const probe = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  })
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
  return {
    available: !probe.error && probe.status === 0,
    cliVersion: probe.status === 0 ? (probe.stdout ?? '').trim() : '',
    output,
  }
}

function resolveComposioInvocation(args: string[]): ComposioCliInvocation | null {
  const invocation = buildComposioInvocation(args)
  const versionInvocation = buildComposioInvocation(['--version'])
  if (invocation && versionInvocation && probeComposioInvocation(versionInvocation).available) return invocation
  return null
}

function parseComposioJson<T>(stdout: string, fallback: string): T {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error(fallback)
  }
  return JSON.parse(trimmed) as T
}

async function runComposioJson<T>(args: string[], fallback: string): Promise<T> {
  const invocation = resolveComposioInvocation(args)
  if (!invocation) {
    throw new Error('Composio CLI is not installed')
  }
  const child = spawn(invocation.command, invocation.args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolveExit(code ?? 0))
  })

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || fallback)
  }

  try {
    return parseComposioJson<T>(stdout, fallback)
  } catch (error) {
    const details = stderr.trim() || stdout.trim()
    throw new Error(details || getErrorMessage(error, fallback))
  }
}

async function readComposioUserData(): Promise<ComposioUserData | null> {
  try {
    const raw = await readFile(COMPOSIO_USER_DATA_PATH, 'utf8')
    const payload = asRecord(JSON.parse(raw))
    if (!payload) return null
    return {
      apiKey: readNonEmptyString(payload.api_key),
      baseUrl: readNonEmptyString(payload.base_url),
      webUrl: readNonEmptyString(payload.web_url),
      orgId: readNonEmptyString(payload.org_id),
      testUserId: readNonEmptyString(payload.test_user_id),
    }
  } catch {
    return null
  }
}

function normalizeComposioConnection(value: unknown): ComposioConnectionSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const authConfig = asRecord(record.auth_config)
  return {
    id: readNonEmptyString(record.id),
    wordId: readNonEmptyString(record.word_id),
    alias: readNonEmptyString(record.alias),
    status: readNonEmptyString(record.status),
    authScheme: readNonEmptyString(record.authScheme || authConfig?.auth_scheme),
    createdAt: readNonEmptyString(record.created_at),
    updatedAt: readNonEmptyString(record.updated_at),
    isComposioManaged: readBoolean(authConfig?.is_composio_managed),
    isDisabled: readBoolean(record.is_disabled),
  }
}

function normalizeComposioToolkit(value: unknown, connectionsBySlug: Map<string, ComposioConnectionSummary[]>): ComposioConnectorSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const slug = readNonEmptyString(record.slug)
  if (!slug) return null
  const connectionRows = connectionsBySlug.get(slug) ?? []
  return {
    slug,
    name: readNonEmptyString(record.name),
    description: readNonEmptyString(record.description),
    logoUrl: readNonEmptyString(record.logo || record.meta && asRecord(record.meta)?.logo),
    latestVersion: readNonEmptyString(record.latest_version || record.latestVersion),
    toolsCount: readNumber(record.tools_count),
    triggersCount: readNumber(record.triggers_count),
    isNoAuth: readBoolean(record.is_no_auth),
    enabled: record.enabled !== false,
    authModes: Array.isArray(record.auth_modes) ? record.auth_modes.map(readNonEmptyString).filter(Boolean) : [],
    activeCount: connectionRows.filter((row) => row.status === 'ACTIVE' && !row.isDisabled).length,
    totalConnections: connectionRows.length,
    connectionStatuses: [...new Set(connectionRows.map((row) => row.status).filter(Boolean))],
  }
}

function normalizeComposioTool(value: unknown): ComposioToolSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const slug = readNonEmptyString(record.slug)
  if (!slug) return null
  return {
    slug,
    name: readNonEmptyString(record.name),
    description: readNonEmptyString(record.description),
  }
}

async function readComposioConnectionsBySlug(): Promise<Map<string, ComposioConnectionSummary[]>> {
  const payload = asRecord(await runComposioJson<Record<string, unknown>>(['connections', 'list'], 'Failed to list Composio connections'))
  const bySlug = new Map<string, ComposioConnectionSummary[]>()
  for (const [slug, rawRows] of Object.entries(payload ?? {})) {
    if (!Array.isArray(rawRows)) continue
    const rows = rawRows.map(normalizeComposioConnection).filter((row): row is ComposioConnectionSummary => row !== null)
    bySlug.set(slug, rows)
  }
  return bySlug
}

async function readComposioStatus(): Promise<ComposioStatusResponse> {
  const versionInvocation = buildComposioInvocation(['--version'])
  const probe = versionInvocation
    ? probeComposioInvocation(versionInvocation)
    : { available: false, cliVersion: '', output: '' }
  const available = probe.available
  const cliVersion = probe.cliVersion
  const userData = await readComposioUserData()
  if (!available) {
    return {
      available: false,
      authenticated: false,
      cliVersion,
      email: '',
      defaultOrgName: '',
      defaultOrgId: userData?.orgId ?? '',
      webUrl: userData?.webUrl ?? '',
      baseUrl: userData?.baseUrl ?? '',
      testUserId: userData?.testUserId ?? '',
    }
  }

  try {
    const payload = asRecord(await runComposioJson<Record<string, unknown>>(['whoami'], 'Failed to read Composio account status'))
    return {
      available: true,
      authenticated: true,
      cliVersion,
      email: readNonEmptyString(payload?.email),
      defaultOrgName: readNonEmptyString(payload?.default_org_name),
      defaultOrgId: readNonEmptyString(payload?.default_org_id) || userData?.orgId || '',
      webUrl: userData?.webUrl || 'https://dashboard.composio.dev/',
      baseUrl: userData?.baseUrl || 'https://backend.composio.dev',
      testUserId: readNonEmptyString(payload?.test_user_id) || userData?.testUserId || '',
    }
  } catch {
    return {
      available: true,
      authenticated: false,
      cliVersion,
      email: '',
      defaultOrgName: '',
      defaultOrgId: userData?.orgId ?? '',
      webUrl: userData?.webUrl || 'https://dashboard.composio.dev/',
      baseUrl: userData?.baseUrl || 'https://backend.composio.dev',
      testUserId: userData?.testUserId ?? '',
    }
  }
}

async function listComposioConnectors(query: string, cursor: string | null = null, limit = 50): Promise<ComposioConnectorPage> {
  const args = ['dev', 'toolkits', 'list', '--limit', String(COMPOSIO_CONNECTORS_PAGE_LIMIT_MAX)]
  const trimmedQuery = query.trim()
  if (trimmedQuery) {
    args.push('--query', trimmedQuery)
  }
  const [payload, connectionsBySlug] = await Promise.all([
    runComposioJson<unknown[]>(args, 'Failed to list Composio toolkits'),
    readComposioConnectionsBySlug(),
  ])
  const allRows = payload
    .map((item) => normalizeComposioToolkit(item, connectionsBySlug))
    .filter((row): row is ComposioConnectorSummary => row !== null)
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(COMPOSIO_CONNECTORS_PAGE_LIMIT_MAX, Math.floor(limit))) : 50
  const safeCursor = parseComposioCursor(cursor, allRows.length)
  return {
    data: allRows.slice(safeCursor, safeCursor + safeLimit),
    nextCursor: safeCursor + safeLimit < allRows.length ? String(safeCursor + safeLimit) : null,
    total: allRows.length,
  }
}

function parseComposioCursor(cursor: string | null | undefined, maxLength: number): number {
  const trimmed = cursor?.trim() ?? ''
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) return 0
  if (parsed >= maxLength) return maxLength
  return parsed
}

function parseComposioLimit(rawLimit: string | null): number {
  const parsed = Number.parseInt((rawLimit ?? '').trim(), 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) return 50
  return Math.max(1, Math.min(COMPOSIO_CONNECTORS_PAGE_LIMIT_MAX, parsed))
}

async function readComposioConnectorDetail(slug: string): Promise<ComposioConnectorDetail> {
  const normalizedSlug = slug.trim()
  if (!normalizedSlug) {
    throw new Error('Missing Composio connector slug')
  }

  const [infoPayload, toolsPayload, connectionsPayload, userData] = await Promise.all([
    runComposioJson<Record<string, unknown>>(['dev', 'toolkits', 'info', normalizedSlug], `Failed to load Composio toolkit ${normalizedSlug}`),
    runComposioJson<unknown[]>(['tools', 'list', normalizedSlug, '--limit', '10'], `Failed to list tools for ${normalizedSlug}`),
    runComposioJson<{ toolkit?: string; items?: unknown[] }>(['link', normalizedSlug, '--list'], `Failed to list connections for ${normalizedSlug}`),
    readComposioUserData(),
  ])

  const connections = Array.isArray(connectionsPayload.items)
    ? connectionsPayload.items.map(normalizeComposioConnection).filter((row): row is ComposioConnectionSummary => row !== null)
    : []
  const connector = normalizeComposioToolkit(infoPayload, new Map([[normalizedSlug, connections]]))
  if (!connector) {
    throw new Error(`Unknown Composio connector: ${normalizedSlug}`)
  }

  return {
    connector,
    connections,
    tools: Array.isArray(toolsPayload)
      ? toolsPayload.map(normalizeComposioTool).filter((row): row is ComposioToolSummary => row !== null)
      : [],
    dashboardUrl: userData?.webUrl || 'https://dashboard.composio.dev/',
  }
}

async function startComposioLink(slug: string): Promise<ComposioLinkResult> {
  const normalizedSlug = slug.trim()
  if (!normalizedSlug) {
    throw new Error('Missing Composio connector slug')
  }
  const payload = asRecord(await runComposioJson<Record<string, unknown>>(['link', normalizedSlug, '--no-wait'], `Failed to start Composio link for ${normalizedSlug}`))
  return {
    status: readNonEmptyString(payload?.status),
    message: readNonEmptyString(payload?.message),
    connectedAccountId: readNonEmptyString(payload?.connected_account_id),
    redirectUrl: readNonEmptyString(payload?.redirect_url),
    toolkit: readNonEmptyString(payload?.toolkit),
    projectType: readNonEmptyString(payload?.project_type),
  }
}

async function startComposioLogin(): Promise<ComposioLoginResult> {
  const invocation = resolveComposioInvocation(['login', '--no-browser', '-y'])
  if (!invocation) {
    throw new Error('Composio CLI is not installed')
  }
  const proc = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.unref()

  let stdout = ''
  let stderr = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => { stderr += chunk })

  const loginUrl = await new Promise<string>((resolveLoginUrl, reject) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(stderr.trim() || stdout.trim() || 'Timed out waiting for Composio CLI login URL'))
    }, 10_000)
    const finish = (url: string) => {
      clearTimeout(timeout)
      proc.stdout.destroy()
      proc.stderr.destroy()
      resolveLoginUrl(url)
    }
    proc.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    proc.once('close', (code) => {
      clearTimeout(timeout)
      reject(new Error(stderr.trim() || stdout.trim() || `Composio CLI login exited with code ${code ?? 0}`))
    })
    proc.stdout.on('data', (chunk) => {
      stdout += chunk
      const url = stdout.match(/https?:\/\/\S+/)?.[0] ?? ''
      if (url) finish(url)
    })
  })

  const cliKey = loginUrl ? (new URL(loginUrl).searchParams.get('cliKey') ?? '') : ''
  return {
    status: 'started',
    message: 'Composio CLI login URL created',
    loginUrl,
    cliKey,
    expiresAt: '',
  }
}

async function installComposioCli(): Promise<ComposioInstallResult> {
  const command = 'bash'
  const installScriptUrl = 'https://composio.dev/install'
  const args = ['-lc', `curl -fsSL ${installScriptUrl} | bash`]
  const invocation = getSpawnInvocation(command, args)
  const env = {
    ...process.env,
    COMPOSIO_INSTALL_DIR: process.env.COMPOSIO_INSTALL_DIR?.trim() || join(homedir(), '.composio'),
  }
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.error || result.status !== 0) {
    throw new Error(output || result.error?.message || 'Failed to install Composio CLI')
  }
  return {
    ok: true,
    command: `curl -fsSL ${installScriptUrl} | bash`,
    output,
  }
}

function countRecoveredContentLines(value: string): number {
  if (!value) return 0
  const normalized = value.replace(/\r\n/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (!trimmed) return 0
  return trimmed.split('\n').length
}

function countRecoveredPatchLines(value: string): { addedLineCount: number; removedLineCount: number } {
  let addedLineCount = 0
  let removedLineCount = 0

  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    if (!line) continue
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) {
      addedLineCount += 1
      continue
    }
    if (line.startsWith('-')) {
      removedLineCount += 1
    }
  }

  return { addedLineCount, removedLineCount }
}

function mergeRecoveredDiff(first: string, second: string): string {
  if (!first) return second
  if (!second || first === second) return first
  return `${first}\n${second}`.trim()
}

function mergeRecoveredFileChange(first: SessionRecoveredFileChange, second: SessionRecoveredFileChange): SessionRecoveredFileChange {
  const operation = first.operation === 'add' || second.operation === 'add'
    ? 'add'
    : first.operation === 'delete' || second.operation === 'delete'
      ? 'delete'
      : 'update'

  return {
    path: second.path || first.path,
    operation,
    movedToPath: second.movedToPath ?? first.movedToPath ?? null,
    diff: mergeRecoveredDiff(first.diff, second.diff),
    addedLineCount: first.addedLineCount + second.addedLineCount,
    removedLineCount: first.removedLineCount + second.removedLineCount,
  }
}

function isApplyPatchSectionBoundary(value: string): boolean {
  return value.startsWith('*** Update File: ')
    || value.startsWith('*** Add File: ')
    || value.startsWith('*** Delete File: ')
    || value === '*** End Patch'
}

function parseApplyPatchInput(input: string): SessionRecoveredFileChange[] {
  const normalized = input.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const changes: SessionRecoveredFileChange[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim()
      const contentLines: string[] = []
      for (index += 1; index < lines.length; index += 1) {
        const nextLine = lines[index] ?? ''
        if (isApplyPatchSectionBoundary(nextLine)) {
          index -= 1
          break
        }
        contentLines.push(nextLine.startsWith('+') ? nextLine.slice(1) : nextLine)
      }
      const diff = contentLines.join('\n').trimEnd()
      if (path) {
        changes.push({
          path,
          operation: 'add',
          movedToPath: null,
          diff,
          addedLineCount: countRecoveredContentLines(diff),
          removedLineCount: 0,
        })
      }
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim()
      if (path) {
        changes.push({
          path,
          operation: 'delete',
          movedToPath: null,
          diff: '',
          addedLineCount: 0,
          removedLineCount: 0,
        })
      }
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim()
      let movedToPath: string | null = null
      const diffLines: string[] = []

      for (index += 1; index < lines.length; index += 1) {
        const nextLine = lines[index] ?? ''
        if (nextLine.startsWith('*** Move to: ')) {
          const moved = nextLine.slice('*** Move to: '.length).trim()
          movedToPath = moved || null
          continue
        }
        if (isApplyPatchSectionBoundary(nextLine)) {
          index -= 1
          break
        }
        diffLines.push(nextLine)
      }

      const diff = diffLines.join('\n').trimEnd()
      const counts = countRecoveredPatchLines(diff)
      if (path) {
        changes.push({
          path,
          operation: 'update',
          movedToPath,
          diff,
          ...counts,
        })
      }
    }
  }

  return changes
}

function buildSessionFileChangeFallback(threadReadPayload: unknown, sessionLogRaw: string): SessionRecoveredTurnFileChanges[] {
  const payload = asRecord(threadReadPayload)
  const thread = asRecord(payload?.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const turnIndexById = new Map<string, number>()

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turnRecord = asRecord(turns[turnIndex])
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) {
      turnIndexById.set(turnId, turnIndex)
    }
  }

  const collectedByTurnId = new Map<string, SessionRecoveredFileChange[]>()
  let currentTurnId = ''

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const payloadRecord = asRecord(row.payload)
      currentTurnId = readNonEmptyString(payloadRecord?.turn_id) || currentTurnId
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId || !turnIndexById.has(currentTurnId)) {
      continue
    }

    const payloadRecord = asRecord(row.payload)
    if (
      payloadRecord?.type !== 'custom_tool_call'
      || payloadRecord.name !== 'apply_patch'
      || payloadRecord.status !== 'completed'
    ) {
      continue
    }

    const input = readNonEmptyString(payloadRecord.input)
    if (!input) continue

    const parsedChanges = parseApplyPatchInput(input)
    if (parsedChanges.length === 0) continue

    const previous = collectedByTurnId.get(currentTurnId) ?? []
    previous.push(...parsedChanges)
    collectedByTurnId.set(currentTurnId, previous)
  }

  const recovered: SessionRecoveredTurnFileChanges[] = []
  for (const [turnId, fileChanges] of collectedByTurnId.entries()) {
    const turnIndex = turnIndexById.get(turnId)
    if (typeof turnIndex !== 'number' || fileChanges.length === 0) continue

    const mergedByPath = new Map<string, SessionRecoveredFileChange>()
    for (const fileChange of fileChanges) {
      const key = `${fileChange.path}\u0000${fileChange.movedToPath ?? ''}`
      const previous = mergedByPath.get(key)
      mergedByPath.set(key, previous ? mergeRecoveredFileChange(previous, fileChange) : { ...fileChange })
    }

    recovered.push({
      turnId,
      turnIndex,
      fileChanges: Array.from(mergedByPath.values()),
    })
  }

  return recovered.sort((first, second) => first.turnIndex - second.turnIndex)
}

type SessionRecoveredCommand = {
  id: string
  type: 'commandExecution'
  command: string
  cwd: string | null
  status: 'completed' | 'failed'
  aggregatedOutput: string
  exitCode: number | null
  durationMs: number | null
  source?: 'cursor'
  cursorCallId?: string
}

function parseExecCommandOutput(output: string): { exitCode: number | null; wallTime: number | null; cleanOutput: string } {
  let exitCode: number | null = null
  let wallTime: number | null = null
  const lines = output.split('\n')

  for (const line of lines) {
    const exitMatch = line.match(/^Process exited with code (\d+)/)
    if (exitMatch) exitCode = Number.parseInt(exitMatch[1]!, 10)

    const wallMatch = line.match(/^Wall time:\s+([\d.]+)\s+seconds/)
    if (wallMatch) wallTime = Math.round(Number.parseFloat(wallMatch[1]!) * 1000)
  }

  const firstOutputIndex = lines.indexOf('Output:')
  if (firstOutputIndex < 0) {
    return { exitCode, wallTime, cleanOutput: output.trimEnd() }
  }

  let outputLines = lines.slice(firstOutputIndex + 1)
  const nestedOutputIndex = outputLines.indexOf('Output:')
  if (
    nestedOutputIndex >= 0
    && outputLines.slice(0, nestedOutputIndex).some((line) => (
      line.startsWith('Chunk ID:')
      || line.startsWith('Process exited with code ')
      || line.startsWith('Original token count:')
    ))
  ) {
    outputLines = outputLines.slice(nestedOutputIndex + 1)
  }

  return { exitCode, wallTime, cleanOutput: outputLines.join('\n').trimEnd() }
}

function readCustomToolCallOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        const record = asRecord(part)
        return typeof record?.text === 'string' ? record.text : ''
      })
      .join('')
  }
  const record = asRecord(output)
  return typeof record?.text === 'string' ? record.text : ''
}

function jsonObjectsAfterMarker(input: string, marker: string): string[] {
  const objects: string[] = []
  let searchFrom = 0

  while (searchFrom < input.length) {
    const markerIndex = input.indexOf(marker, searchFrom)
    if (markerIndex < 0) break

    let start = markerIndex + marker.length
    while (/\s/.test(input[start] ?? '')) start += 1
    if (input[start] !== '{') {
      searchFrom = markerIndex + marker.length
      continue
    }

    let depth = 0
    let stringQuote = ''
    let escaped = false
    let objectEnd = -1
    for (let index = start; index < input.length; index += 1) {
      const char = input[index]!
      if (stringQuote) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === stringQuote) {
          stringQuote = ''
        }
        continue
      }

      if (char === '"' || char === "'" || char === '`') {
        stringQuote = char
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          objectEnd = index + 1
          break
        }
      }
    }

    if (objectEnd < 0) {
      searchFrom = markerIndex + marker.length
      continue
    }
    objects.push(input.slice(start, objectEnd))
    searchFrom = objectEnd
  }

  return objects
}

function readJavaScriptStringLiteral(source: string, startIndex: number): { value: string, nextIndex: number } | null {
  const quote = source[startIndex]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null

  let value = ''
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const char = source[index]!
    if (char === quote) return { value, nextIndex: index + 1 }
    if (char !== '\\') {
      value += char
      continue
    }

    index += 1
    const escaped = source[index]
    if (escaped === undefined) return null
    if (escaped === '\n') continue
    if (escaped === '\r') {
      if (source[index + 1] === '\n') index += 1
      continue
    }

    const mapped = ({
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      0: '\0',
    } as Record<string, string>)[escaped]
    if (mapped !== undefined) {
      value += mapped
      continue
    }
    if (escaped === 'x') {
      const hex = source.slice(index + 1, index + 3)
      if (!/^[0-9a-f]{2}$/iu.test(hex)) return null
      value += String.fromCodePoint(Number.parseInt(hex, 16))
      index += 2
      continue
    }
    if (escaped === 'u') {
      if (source[index + 1] === '{') {
        const endIndex = source.indexOf('}', index + 2)
        const hex = endIndex < 0 ? '' : source.slice(index + 2, endIndex)
        if (!/^[0-9a-f]{1,6}$/iu.test(hex)) return null
        const codePoint = Number.parseInt(hex, 16)
        if (codePoint > 0x10ffff) return null
        value += String.fromCodePoint(codePoint)
        index = endIndex
        continue
      }
      const hex = source.slice(index + 1, index + 5)
      if (!/^[0-9a-f]{4}$/iu.test(hex)) return null
      value += String.fromCodePoint(Number.parseInt(hex, 16))
      index += 4
      continue
    }

    value += escaped
  }

  return null
}

function skipJavaScriptWhitespace(source: string, startIndex: number): number {
  let index = startIndex
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

function skipJavaScriptObjectValue(source: string, startIndex: number): number {
  let index = startIndex
  let curlyDepth = 0
  let squareDepth = 0
  let parenDepth = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '"' || char === "'" || char === '`') {
      const literal = readJavaScriptStringLiteral(source, index)
      if (!literal) return source.length
      index = literal.nextIndex
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const newlineIndex = source.indexOf('\n', index + 2)
      index = newlineIndex < 0 ? source.length : newlineIndex + 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      index = commentEnd < 0 ? source.length : commentEnd + 2
      continue
    }
    if (char === '{') curlyDepth += 1
    else if (char === '}') {
      if (curlyDepth === 0 && squareDepth === 0 && parenDepth === 0) return index
      curlyDepth = Math.max(0, curlyDepth - 1)
    } else if (char === '[') squareDepth += 1
    else if (char === ']') squareDepth = Math.max(0, squareDepth - 1)
    else if (char === '(') parenDepth += 1
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (char === ',' && curlyDepth === 0 && squareDepth === 0 && parenDepth === 0) return index
    index += 1
  }
  return index
}

function readJavaScriptObjectStringProperty(objectSource: string, propertyName: string): string | null {
  let index = skipJavaScriptWhitespace(objectSource, 0)
  if (objectSource[index] !== '{') return null
  index += 1

  while (index < objectSource.length) {
    index = skipJavaScriptWhitespace(objectSource, index)
    if (objectSource[index] === '}') return null

    let key = ''
    const char = objectSource[index]
    if (char === '"' || char === "'" || char === '`') {
      const literal = readJavaScriptStringLiteral(objectSource, index)
      if (!literal) return null
      key = literal.value
      index = literal.nextIndex
    } else {
      const keyMatch = objectSource.slice(index).match(/^[A-Za-z_$][\w$]*/u)
      if (!keyMatch) return null
      key = keyMatch[0]
      index += key.length
    }

    index = skipJavaScriptWhitespace(objectSource, index)
    if (objectSource[index] !== ':') return null
    index = skipJavaScriptWhitespace(objectSource, index + 1)
    if (key === propertyName) {
      return readJavaScriptStringLiteral(objectSource, index)?.value ?? null
    }

    index = skipJavaScriptObjectValue(objectSource, index)
    if (objectSource[index] === ',') {
      index += 1
      continue
    }
    if (objectSource[index] === '}') return null
  }

  return null
}

function readJavaScriptObjectIdentifierProperty(objectSource: string, propertyName: string): string | null {
  let index = skipJavaScriptWhitespace(objectSource, 0)
  if (objectSource[index] !== '{') return null
  index += 1

  while (index < objectSource.length) {
    index = skipJavaScriptWhitespace(objectSource, index)
    if (objectSource[index] === '}') return null

    let key = ''
    const char = objectSource[index]
    if (char === '"' || char === "'" || char === '`') {
      const literal = readJavaScriptStringLiteral(objectSource, index)
      if (!literal) return null
      key = literal.value
      index = literal.nextIndex
    } else {
      const keyMatch = objectSource.slice(index).match(/^[A-Za-z_$][\w$]*/u)
      if (!keyMatch) return null
      key = keyMatch[0]
      index += key.length
    }

    index = skipJavaScriptWhitespace(objectSource, index)
    if (objectSource[index] !== ':') {
      if (key === propertyName && (objectSource[index] === ',' || objectSource[index] === '}')) {
        return key
      }
      if (objectSource[index] === ',') {
        index += 1
        continue
      }
      return null
    }

    index = skipJavaScriptWhitespace(objectSource, index + 1)
    if (key === propertyName) {
      const identifier = objectSource.slice(index).match(/^[A-Za-z_$][\w$]*/u)?.[0] ?? ''
      if (!identifier) return null
      const nextIndex = skipJavaScriptWhitespace(objectSource, index + identifier.length)
      return objectSource[nextIndex] === ',' || objectSource[nextIndex] === '}' ? identifier : null
    }

    index = skipJavaScriptObjectValue(objectSource, index)
    if (objectSource[index] === ',') {
      index += 1
      continue
    }
    if (objectSource[index] === '}') return null
  }

  return null
}

function readJavaScriptDelimitedLiteral(
  source: string,
  startIndex: number,
  opening: '[' | '{',
  closing: ']' | '}',
): { value: string, nextIndex: number } | null {
  if (source[startIndex] !== opening) return null
  let depth = 0

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index]!
    if (char === '"' || char === "'" || char === '`') {
      const literal = readJavaScriptStringLiteral(source, index)
      if (!literal) return null
      index = literal.nextIndex - 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const newlineIndex = source.indexOf('\n', index + 2)
      index = newlineIndex < 0 ? source.length : newlineIndex
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      if (commentEnd < 0) return null
      index = commentEnd + 1
      continue
    }
    if (char === opening) {
      depth += 1
      continue
    }
    if (char === closing) {
      depth -= 1
      if (depth === 0) return { value: source.slice(startIndex, index + 1), nextIndex: index + 1 }
    }
  }

  return null
}

function splitJavaScriptArrayEntries(arraySource: string): string[] | null {
  if (arraySource[0] !== '[' || arraySource.at(-1) !== ']') return null

  const entries: string[] = []
  let entryStart = 1
  let squareDepth = 0
  let curlyDepth = 0
  let parenDepth = 0

  for (let index = 1; index < arraySource.length - 1; index += 1) {
    const char = arraySource[index]!
    if (char === '"' || char === "'" || char === '`') {
      const literal = readJavaScriptStringLiteral(arraySource, index)
      if (!literal) return null
      index = literal.nextIndex - 1
      continue
    }
    if (char === '/' && arraySource[index + 1] === '/') {
      const newlineIndex = arraySource.indexOf('\n', index + 2)
      index = newlineIndex < 0 ? arraySource.length - 1 : newlineIndex
      continue
    }
    if (char === '/' && arraySource[index + 1] === '*') {
      const commentEnd = arraySource.indexOf('*/', index + 2)
      if (commentEnd < 0) return null
      index = commentEnd + 1
      continue
    }
    if (char === '[') squareDepth += 1
    else if (char === ']') squareDepth -= 1
    else if (char === '{') curlyDepth += 1
    else if (char === '}') curlyDepth -= 1
    else if (char === '(') parenDepth += 1
    else if (char === ')') parenDepth -= 1
    else if (char === ',' && squareDepth === 0 && curlyDepth === 0 && parenDepth === 0) {
      entries.push(arraySource.slice(entryStart, index).trim())
      entryStart = index + 1
    }
  }

  const lastEntry = arraySource.slice(entryStart, -1).trim()
  if (lastEntry) entries.push(lastEntry)
  return entries
}

function readJavaScriptStaticTuple(tupleSource: string): Array<string | null> | null {
  const entries = splitJavaScriptArrayEntries(tupleSource.trim())
  if (!entries) return null

  return entries.map((entry) => {
    const start = skipJavaScriptWhitespace(entry, 0)
    const literal = readJavaScriptStringLiteral(entry, start)
    if (!literal) return null
    return skipJavaScriptWhitespace(entry, literal.nextIndex) === entry.length ? literal.value : null
  })
}

type StaticTupleDeclaration = {
  name: string
  startIndex: number
  endIndex: number
  tuples: Array<Array<string | null>>
}

function findStaticJavaScriptTupleDeclarations(input: string): StaticTupleDeclaration[] {
  const declarations: StaticTupleDeclaration[] = []
  const declarationPattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*/gu
  let match: RegExpExecArray | null

  while ((match = declarationPattern.exec(input)) !== null) {
    const arrayStart = skipJavaScriptWhitespace(input, declarationPattern.lastIndex)
    const arrayLiteral = readJavaScriptDelimitedLiteral(input, arrayStart, '[', ']')
    if (!arrayLiteral) continue
    const tupleEntries = splitJavaScriptArrayEntries(arrayLiteral.value)
    if (!tupleEntries) continue
    const tuples = tupleEntries
      .map((entry) => readJavaScriptStaticTuple(entry))
      .filter((tuple): tuple is Array<string | null> => Boolean(tuple))
    if (tuples.length !== tupleEntries.length) continue
    declarations.push({ name: match[1]!, startIndex: match.index, endIndex: input.length, tuples })
  }

  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index]!
    const nextSameName = declarations.slice(index + 1).find((candidate) => candidate.name === declaration.name)
    if (nextSameName) declaration.endIndex = nextSameName.startIndex
  }

  return declarations
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function buildStaticMappedExecRecoveredCommands(input: string): Array<{ startIndex: number, commands: Array<{ command: string, cwd: string | null }> }> {
  const declarations = findStaticJavaScriptTupleDeclarations(input)
  const recovered: Array<{ startIndex: number, commands: Array<{ command: string, cwd: string | null }> }> = []

  for (const declaration of declarations) {
    const mapPattern = new RegExp(
      `\\b${escapedRegExp(declaration.name)}\\s*\\.map\\s*\\(\\s*(?:async\\s*)?\\(\\s*\\[([^\\]]+)\\]\\s*\\)\\s*=>\\s*tools\\.exec_command\\s*\\(\\s*`,
      'gu',
    )
    let mapMatch: RegExpExecArray | null
    while ((mapMatch = mapPattern.exec(input)) !== null) {
      if (mapMatch.index < declaration.startIndex) continue
      if (mapMatch.index >= declaration.endIndex) break
      const tupleNames = mapMatch[1]!
        .split(',')
        .map((name) => name.trim())
        .filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name))
      const objectStart = skipJavaScriptWhitespace(input, mapPattern.lastIndex)
      const objectLiteral = readJavaScriptDelimitedLiteral(input, objectStart, '{', '}')
      if (!objectLiteral) continue

      const commandName = readJavaScriptObjectIdentifierProperty(objectLiteral.value, 'cmd')
      const commandIndex = commandName ? tupleNames.indexOf(commandName) : -1
      if (commandIndex < 0) continue
      const workdirName = readJavaScriptObjectIdentifierProperty(objectLiteral.value, 'workdir')
        || readJavaScriptObjectIdentifierProperty(objectLiteral.value, 'cwd')
      const workdirIndex = workdirName ? tupleNames.indexOf(workdirName) : -1
      const literalWorkdir = readJavaScriptObjectStringProperty(objectLiteral.value, 'workdir')
        || readJavaScriptObjectStringProperty(objectLiteral.value, 'cwd')

      const commands = declaration.tuples
        .map((tuple) => {
          const command = tuple[commandIndex]
          if (!command) return null
          return {
            command,
            cwd: literalWorkdir || (workdirIndex >= 0 ? tuple[workdirIndex] : null),
          }
        })
        .filter((command): command is { command: string, cwd: string | null } => Boolean(command))
      if (commands.length > 0) recovered.push({ startIndex: mapMatch.index, commands })
    }
  }

  return recovered
}

function buildCustomExecRecoveredCommands(payload: Record<string, unknown>): SessionRecoveredCommand[] {
  if (payload.name !== 'exec') return []
  const callId = readNonEmptyString(payload.call_id)
  const input = typeof payload.input === 'string' ? payload.input : ''
  const argumentJsons = jsonObjectsAfterMarker(input, 'tools.exec_command(')
  if (!callId || argumentJsons.length === 0) return []

  const commandGroups: Array<{ startIndex: number, commands: Array<{ command: string, cwd: string | null }> }> = []
  let searchFrom = 0
  for (const argumentJson of argumentJsons) {
    const startIndex = input.indexOf(argumentJson, searchFrom)
    searchFrom = startIndex < 0 ? searchFrom : startIndex + argumentJson.length
    let args: Record<string, unknown> | null = null
    try {
      args = asRecord(JSON.parse(argumentJson))
    } catch {
      // Older Codex sessions serialized tool input as JavaScript object literals
      // with unquoted property names. Read only literal strings; never execute it.
      args = null
    }
    const command = readNonEmptyString(args?.cmd)
      || readJavaScriptObjectStringProperty(argumentJson, 'cmd')
    if (!command) continue
    commandGroups.push({
      startIndex: startIndex < 0 ? Number.MAX_SAFE_INTEGER : startIndex,
      commands: [{
        command,
        cwd: readNonEmptyString(args?.workdir)
          || readNonEmptyString(args?.cwd)
          || readJavaScriptObjectStringProperty(argumentJson, 'workdir')
          || readJavaScriptObjectStringProperty(argumentJson, 'cwd')
          || null,
      }],
    })
  }

  commandGroups.push(...buildStaticMappedExecRecoveredCommands(input))
  const commands = commandGroups
    .sort((first, second) => first.startIndex - second.startIndex)
    .flatMap((group) => group.commands)
  if (commands.length === 0) return []

  return commands.map((command, index) => ({
    id: commands.length === 1 ? `session-cmd-${callId}` : `session-cmd-${callId}-${index}`,
    type: 'commandExecution',
    command: command.command,
    cwd: command.cwd,
    status: payload.status === 'failed' ? 'failed' : 'completed',
    aggregatedOutput: '',
    exitCode: null,
    durationMs: null,
  }))
}

type SessionRecoveredFileChangeItem = {
  id: string
  type: 'fileChange'
  status: 'completed'
  changes: Record<string, unknown>[]
}

type SessionRecoveredToolCall = {
  id: string
  type: 'sessionToolCall'
  name: string
  input: unknown
  output: unknown
  error: unknown
  status: 'completed' | 'failed'
}

type SessionItemSlot = {
  type: 'agentMessage' | 'commandExecution' | 'fileChange' | 'toolCall'
  text?: string
  cursorCallId?: string
  command?: SessionRecoveredCommand
  fileChange?: SessionRecoveredFileChangeItem
  toolCall?: SessionRecoveredToolCall
}

type CursorToolPayloadCache = Map<string, Record<string, unknown> | null>

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readCursorToolPayloadFromMessageText(
  text: string,
  payloadCache: CursorToolPayloadCache,
): Record<string, unknown> | null {
  const resolvedPath = resolveCursorToolPayloadPath(cursorToolPayloadPathFromText(text))
  if (!resolvedPath) return null
  if (payloadCache.has(resolvedPath)) {
    return payloadCache.get(resolvedPath) ?? null
  }

  try {
    const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as unknown
    const record = isCursorToolPayloadRecord(parsed) ? parsed : null
    payloadCache.set(resolvedPath, record)
    return record
  } catch {
    payloadCache.set(resolvedPath, null)
    return null
  }
}

function cursorOutputRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null
  const success = asRecord(value.success)
  if (success) return success
  const error = asRecord(value.error)
  if (error) return error
  const failure = asRecord(value.failure)
  if (failure) return failure
  return value
}

function hasCursorErrorOutput(value: Record<string, unknown> | null): boolean {
  return Boolean(value?.error || value?.failure)
}

function cursorToolCallIdFromMessageText(
  text: string,
  payloadCache: CursorToolPayloadCache = new Map(),
): string {
  const inlinePayload = readInlineCursorToolPayloadRecord(text)
  const inlineCallId = readNonEmptyString(inlinePayload?.call_id)
  if (inlineCallId) return inlineCallId

  const payload = readCursorToolPayloadFromMessageText(text, payloadCache)
  const payloadCallId = readNonEmptyString(payload?.call_id)
  if (payloadCallId) return payloadCallId

  const payloadPath = cursorToolPayloadPathFromText(text)
  return payloadPath ? basename(payloadPath).replace(/\.json$/iu, '') : ''
}

function buildCursorRecoveredCommand(payload: Record<string, unknown>): SessionRecoveredCommand | null {
  const callId = readNonEmptyString(payload.call_id)
  const args = asRecord(payload.arguments)
  const outputPayload = asRecord(payload.output)
  const output = cursorOutputRecord(outputPayload)
  const command = readNonEmptyString(args?.command)
    || readNonEmptyString(args?.cmd)
    || readNonEmptyString(output?.command)
  if (!callId || !command) return null

  const stdout = typeof output?.stdout === 'string' ? output.stdout : ''
  const stderr = typeof output?.stderr === 'string' ? output.stderr : ''
  const message = typeof output?.message === 'string' ? output.message : ''
  const interleavedOutput = typeof output?.interleavedOutput === 'string' ? output.interleavedOutput : ''
  const aggregatedOutput = stdout || stderr
    ? [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '')
    : interleavedOutput || message
  const exitCode = readOptionalNumber(output?.exitCode)
  const durationMs = readOptionalNumber(output?.executionTime)
    ?? readOptionalNumber(output?.localExecutionTimeMs)
  const outputIsError = hasCursorErrorOutput(outputPayload)

  return {
    id: `cursor-command-${callId}`,
    type: 'commandExecution',
    command,
    cwd: readNonEmptyString(args?.workingDirectory)
      || readNonEmptyString(args?.cwd)
      || readNonEmptyString(output?.workingDirectory)
      || null,
    status: outputIsError || (exitCode !== null && exitCode !== 0) ? 'failed' : 'completed',
    aggregatedOutput,
    exitCode,
    durationMs,
    source: 'cursor',
    cursorCallId: callId,
  }
}

function buildCursorToolSessionSlot(
  text: string,
  payloadCache: CursorToolPayloadCache,
): { matched: boolean; slot: SessionItemSlot | null } {
  const payload = readCursorToolPayloadFromMessageText(text, payloadCache)
  if (!payload) return { matched: false, slot: null }
  if (!CURSOR_TOOL_COMPLETED_MESSAGE.test(text.trimStart())) {
    return { matched: true, slot: null }
  }

  const callId = readNonEmptyString(payload.call_id)
  if (payload.tool === 'shell') {
    const command = buildCursorRecoveredCommand(payload)
    return { matched: true, slot: command ? { type: 'commandExecution', command } : null }
  }

  return {
    matched: true,
    slot: {
      type: 'agentMessage',
      text: `${text}\n<codex-ui-data>${JSON.stringify(payload)}</codex-ui-data>`,
      cursorCallId: callId,
    },
  }
}

function readSessionMessageText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    const blockRecord = asRecord(block)
    const text = typeof blockRecord?.text === 'string' ? blockRecord.text : ''
    if (!text) continue
    const type = typeof blockRecord?.type === 'string' ? blockRecord.type : ''
    if (type && type !== 'text' && type !== 'output_text') continue
    parts.push(text)
  }

  return parts.join('')
}

/**
 * Older app-server builds reject `thread/read(includeTurns=true)` for a
 * paginated rollout. Keep a narrow local fallback for those builds: it
 * reconstructs the user and assistant messages that make up the actual
 * conversation, while newer builds use `thread/turns/list` with full items.
 */
export function buildSessionTurnsFromRollout(sessionLogRaw: string): Record<string, unknown>[] {
  type RecoveredTurn = {
    id: string
    status: 'completed'
    items: Record<string, unknown>[]
  }

  let currentTurnId = ''
  let orphanTurnIndex = 0
  const turnsById = new Map<string, RecoveredTurn>()
  const orderedTurnIds: string[] = []

  const getTurn = (turnId: string): RecoveredTurn => {
    const existing = turnsById.get(turnId)
    if (existing) return existing
    const created: RecoveredTurn = { id: turnId, status: 'completed', items: [] }
    turnsById.set(turnId, created)
    orderedTurnIds.push(turnId)
    return created
  }

  for (const [lineIndex, line] of sessionLogRaw.split('\n').entries()) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = asRecord(row.payload)
    if (!payload) continue

    if (row.type === 'turn_context') {
      currentTurnId = readNonEmptyString(payload.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      if (payload.type === 'task_started') {
        currentTurnId = readNonEmptyString(payload.turn_id) || currentTurnId
      } else if (payload.type === 'task_complete') {
        currentTurnId = ''
      }
      continue
    }
    if (row.type !== 'response_item' || payload.type !== 'message') continue
    if (payload.role !== 'user' && payload.role !== 'assistant') continue

    let turnId = currentTurnId
    if (!turnId) {
      orphanTurnIndex += 1
      turnId = `rollout-${String(lineIndex + 1)}-${String(orphanTurnIndex)}`
    }
    const turn = getTurn(turnId)
    const itemId = readNonEmptyString(payload.id) || `session-${turnId}-${String(lineIndex + 1)}`

    if (payload.role === 'user') {
      const text = readSessionUserMessageText(payload)
      if (text) {
        turn.items.push({
          id: itemId,
          type: 'userMessage',
          content: [{ type: 'text', text }],
        })
      }
    } else {
      const text = readSessionMessageText(payload)
      if (text) {
        turn.items.push({
          id: itemId,
          type: 'agentMessage',
          text,
        })
      }
    }
  }

  return orderedTurnIds
    .map((turnId) => turnsById.get(turnId))
    .filter((turn): turn is RecoveredTurn => Boolean(turn && turn.items.length > 0))
}

function buildSessionItemOrder(sessionLogRaw: string, turnIds: Set<string>): Map<string, SessionItemSlot[]> {
  let currentTurnId = ''
  let orphanResponseTurnId = ''
  const orderByTurnId = new Map<string, SessionItemSlot[]>()
  const callIdToCommands = new Map<string, SessionRecoveredCommand[]>()
  const callIdToToolCall = new Map<string, SessionRecoveredToolCall>()
  const cursorPayloadCache: CursorToolPayloadCache = new Map()
  const lines = sessionLogRaw.split('\n')

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const p = asRecord(row.payload)
      currentTurnId = readNonEmptyString(p?.turn_id) || currentTurnId
      orphanResponseTurnId = ''
      continue
    }
    if (row.type === 'event_msg') {
      const p = asRecord(row.payload)
      if (p?.type === 'task_started') {
        currentTurnId = readNonEmptyString(p.turn_id) || currentTurnId
        orphanResponseTurnId = ''
      } else if (p?.type === 'task_complete') {
        currentTurnId = ''
        orphanResponseTurnId = ''
      }
      continue
    }

    if (row.type !== 'response_item') continue
    let targetTurnId = currentTurnId
    if (!targetTurnId) {
      orphanResponseTurnId ||= `rollout-${String(lineIndex + 1)}`
      targetTurnId = orphanResponseTurnId
    }
    if (!targetTurnId || !turnIds.has(targetTurnId)) continue
    const payload = asRecord(row.payload)
    if (!payload) continue

    let slots = orderByTurnId.get(targetTurnId)
    if (!slots) {
      slots = []
      orderByTurnId.set(targetTurnId, slots)
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = readSessionMessageText(payload)
      const cursorSlot = buildCursorToolSessionSlot(text, cursorPayloadCache)
      if (cursorSlot.slot) {
        slots.push(cursorSlot.slot)
      } else if (!cursorSlot.matched) {
        slots.push({ type: 'agentMessage', text })
      }
      continue
    }

    if (payload.type === 'custom_tool_call') {
      const commands = buildCustomExecRecoveredCommands(payload)
      if (commands.length > 0) {
        callIdToCommands.set(readNonEmptyString(payload.call_id), commands)
        for (const command of commands) {
          slots.push({ type: 'commandExecution', command })
        }
        continue
      }
    }

    if (payload.type === 'function_call' && payload.name === 'exec_command') {
      const callId = readNonEmptyString(payload.call_id)
      if (!callId) continue
      let cmd = ''
      try {
        const args = JSON.parse(payload.arguments as string) as Record<string, unknown>
        cmd = typeof args.cmd === 'string' ? args.cmd : ''
      } catch { /* empty */ }
      const command: SessionRecoveredCommand = {
        id: `session-cmd-${callId}`,
        type: 'commandExecution',
        command: cmd,
        cwd: null,
        status: 'completed',
        aggregatedOutput: '',
        exitCode: null,
        durationMs: null,
      }
      callIdToCommands.set(callId, [command])
      slots.push({ type: 'commandExecution', command })
      continue
    }

    if (payload.type === 'function_call') {
      const callId = readNonEmptyString(payload.call_id)
      const name = readNonEmptyString(payload.name)
      if (!callId || !name) continue
      const argumentsValue = typeof payload.arguments === 'string' ? payload.arguments : ''
      let input: unknown = argumentsValue
      try {
        input = JSON.parse(argumentsValue) as unknown
      } catch { /* preserve the raw arguments for malformed legacy records */ }
      const toolCall: SessionRecoveredToolCall = {
        id: `session-tool-${callId}`,
        type: 'sessionToolCall',
        name,
        input,
        output: '',
        error: null,
        status: 'completed',
      }
      callIdToToolCall.set(callId, toolCall)
      slots.push({ type: 'toolCall', toolCall })
      continue
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = readNonEmptyString(payload.call_id)
      if (!callId) continue
      const commands = callIdToCommands.get(callId)
      const rawOutput = payload.type === 'custom_tool_call_output'
        ? readCustomToolCallOutput(payload.output)
        : typeof payload.output === 'string' ? payload.output : ''
      if (commands?.length === 1) {
        const existing = commands[0]!
        const parsed = parseExecCommandOutput(rawOutput)
        existing.aggregatedOutput = parsed.cleanOutput
        existing.exitCode = parsed.exitCode
        existing.durationMs = parsed.wallTime
        if (parsed.exitCode !== null) {
          existing.status = parsed.exitCode === 0 ? 'completed' : 'failed'
        }
        continue
      }

      const toolCall = callIdToToolCall.get(callId)
      if (toolCall) toolCall.output = rawOutput
    }

    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && payload.status === 'completed') {
      const input = typeof payload.input === 'string' ? payload.input : ''
      const callId = readNonEmptyString(payload.call_id)
      if (!input || !callId) continue
      const parsedChanges = parseApplyPatchInput(input)
      if (parsedChanges.length === 0) continue
      const fcItem: SessionRecoveredFileChangeItem = {
        id: `session-fc-${callId}`,
        type: 'fileChange',
        status: 'completed',
        changes: parsedChanges.map((fc) => ({
          ...fc,
          kind: { type: fc.operation, ...(fc.movedToPath ? { move_path: fc.movedToPath } : {}) },
        })),
      }
      slots.push({ type: 'fileChange', fileChange: fcItem })
    }
  }

  return orderByTurnId
}

function splitMergedAgentMessageFromSessionSlots(
  agentMessages: Record<string, unknown>[],
  slots: SessionItemSlot[],
): Record<string, unknown>[] {
  if (agentMessages.length !== 1) return agentMessages

  const sessionAgentTexts = slots
    .filter((slot) => slot.type === 'agentMessage')
    .map((slot) => slot.text ?? '')
    .filter((text) => text.length > 0)
  if (sessionAgentTexts.length <= 1) return agentMessages

  const mergedMessage = agentMessages[0]!
  const mergedText = typeof mergedMessage.text === 'string' ? mergedMessage.text : ''
  if (!mergedText) return agentMessages

  let cursor = 0
  const splitTexts: string[] = []
  for (let index = 0; index < sessionAgentTexts.length; index += 1) {
    const sessionText = sessionAgentTexts[index]!
    const textIndex = mergedText.indexOf(sessionText, cursor)
    if (textIndex < 0) return agentMessages

    const textEnd = textIndex + sessionText.length
    const splitEnd = index === sessionAgentTexts.length - 1 ? mergedText.length : textEnd
    const splitText = mergedText.slice(cursor, splitEnd)
    if (!splitText) return agentMessages
    splitTexts.push(splitText)
    cursor = textEnd
  }

  if (splitTexts.join('') !== mergedText) return agentMessages

  return splitTexts.map((text, index) => ({
    ...mergedMessage,
    id: index === 0 ? mergedMessage.id : `${String(mergedMessage.id ?? 'agent')}-session-part-${index}`,
    text,
  }))
}

function readCommandTextFromRecoveredItem(item: Record<string, unknown>): string {
  const command = typeof item.command === 'string' ? item.command : ''
  if (command.trim()) return command.trim()
  const commandExecution = asRecord(item.commandExecution)
  const nestedCommand = typeof commandExecution?.command === 'string' ? commandExecution.command : ''
  return nestedCommand.trim()
}

function decodeCommandWrapperArgument(argument: string): string | null {
  const trimmed = argument.trim()
  if (trimmed.length < 2) return null
  const quote = trimmed[0]!
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return null

  const inner = trimmed.slice(1, -1)
  if (quote === "'") return inner.replace(/'\\''/g, "'")

  let decoded = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!
    if (char !== '\\' || index + 1 >= inner.length) {
      decoded += char
      continue
    }
    const next = inner[index + 1]!
    if (next === '"' || next === '\\' || next === '$' || next === '`') {
      decoded += next
      index += 1
    } else {
      decoded += char
    }
  }
  return decoded
}

function unwrapCommandShell(command: string): string | null {
  const posixShell = command.match(/^(?:(?:\/usr\/bin\/env)\s+)?(?:\/(?:usr\/bin|bin)\/)?(?:bash|sh|zsh)\b[\s\S]*?(?:^|\s)(?:-[A-Za-z]*c[A-Za-z]*|--command)\s+([\s\S]+)$/iu)
  if (posixShell) return decodeCommandWrapperArgument(posixShell[1]!)

  const powerShell = command.match(/^(?:(?:\/[^\s]+\/)?(?:powershell|pwsh)(?:\.exe)?)\b[\s\S]*?(?:^|\s)(?:-command|-c)\s+([\s\S]+)$/iu)
  if (powerShell) return decodeCommandWrapperArgument(powerShell[1]!)

  const cmdShell = command.match(/^(?:(?:[A-Za-z]:)?(?:[\\/][^\\/\s]+)*[\\/]?)?cmd(?:\.exe)?\b(?:\s+\/[A-Za-z]+)*\s+\/c\s+([\s\S]+)$/iu)
  if (cmdShell) return decodeCommandWrapperArgument(cmdShell[1]!)

  return null
}

function commandMatchVariants(command: string): string[] {
  const normalizedLineEndings = command.trim().replace(/\r\n?/g, '\n')
  if (!normalizedLineEndings) return []

  const variants = new Set([normalizedLineEndings])
  const unwrapped = unwrapCommandShell(normalizedLineEndings)
  if (unwrapped) variants.add(unwrapped.trim().replace(/\r\n?/g, '\n'))
  return [...variants].filter(Boolean)
}

function readCommandCwdFromRecoveredItem(item: Record<string, unknown>): string {
  const cwd = typeof item.cwd === 'string' ? item.cwd : ''
  if (cwd.trim()) return cwd.trim()
  const commandExecution = asRecord(item.commandExecution)
  const nestedCwd = typeof commandExecution?.cwd === 'string' ? commandExecution.cwd : ''
  return nestedCwd.trim()
}

type SessionCommandMatchQueue = {
  indexes: number[]
  nextIndex: number
}

type SessionCommandLookup = {
  byId: Map<string, SessionCommandMatchQueue>
  byCommandAndCwd: Map<string, SessionCommandMatchQueue>
  byCommand: Map<string, SessionCommandMatchQueue>
  fallbackAll: SessionCommandMatchQueue
  fallbackByCwd: Map<string, SessionCommandMatchQueue>
  usedIndexes: Set<number>
}

function commandAndCwdKey(command: string, cwd: string): string {
  return `${command}\u0000${cwd}`
}

function appendCommandMatchIndex(
  lookup: Map<string, SessionCommandMatchQueue>,
  key: string,
  index: number,
): void {
  let queue = lookup.get(key)
  if (!queue) {
    queue = { indexes: [], nextIndex: 0 }
    lookup.set(key, queue)
  }
  queue.indexes.push(index)
}

function createSessionCommandLookup(commandMessages: Record<string, unknown>[]): SessionCommandLookup {
  const lookup: SessionCommandLookup = {
    byId: new Map(),
    byCommandAndCwd: new Map(),
    byCommand: new Map(),
    fallbackAll: { indexes: [], nextIndex: 0 },
    fallbackByCwd: new Map(),
    usedIndexes: new Set(),
  }

  for (let index = 0; index < commandMessages.length; index += 1) {
    const item = commandMessages[index]!
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id) appendCommandMatchIndex(lookup.byId, id, index)

    const command = readCommandTextFromRecoveredItem(item)
    const cwd = readCommandCwdFromRecoveredItem(item)
    lookup.fallbackAll.indexes.push(index)
    appendCommandMatchIndex(lookup.fallbackByCwd, cwd, index)

    for (const commandVariant of commandMatchVariants(command)) {
      appendCommandMatchIndex(lookup.byCommand, commandVariant, index)
      if (cwd) appendCommandMatchIndex(lookup.byCommandAndCwd, commandAndCwdKey(commandVariant, cwd), index)
    }
  }

  return lookup
}

function takeCommandMatchIndex(
  queue: SessionCommandMatchQueue | undefined,
  usedIndexes: Set<number>,
): number | null {
  if (!queue) return null
  while (queue.nextIndex < queue.indexes.length) {
    const index = queue.indexes[queue.nextIndex++]!
    if (!usedIndexes.has(index)) {
      usedIndexes.add(index)
      return index
    }
  }
  return null
}

function peekCommandMatchIndex(
  queue: SessionCommandMatchQueue | undefined,
  usedIndexes: Set<number>,
): number | null {
  if (!queue) return null
  while (queue.nextIndex < queue.indexes.length && usedIndexes.has(queue.indexes[queue.nextIndex]!)) {
    queue.nextIndex += 1
  }
  return queue.nextIndex < queue.indexes.length ? queue.indexes[queue.nextIndex]! : null
}

function takeEarliestCommandMatchIndex(
  queues: Array<SessionCommandMatchQueue | undefined>,
  usedIndexes: Set<number>,
): number | null {
  let selectedQueue: SessionCommandMatchQueue | undefined
  let selectedIndex: number | null = null

  for (const queue of queues) {
    const index = peekCommandMatchIndex(queue, usedIndexes)
    if (index === null || (selectedIndex !== null && index >= selectedIndex)) continue
    selectedQueue = queue
    selectedIndex = index
  }

  return takeCommandMatchIndex(selectedQueue, usedIndexes)
}

function takeStrictCommandForSessionSlot(
  slotCommand: SessionRecoveredCommand,
  commandMessages: Record<string, unknown>[],
  commandLookup: SessionCommandLookup,
): Record<string, unknown> | null {
  const slotId = slotCommand.id.trim()
  let matchIndex = takeCommandMatchIndex(commandLookup.byId.get(slotId), commandLookup.usedIndexes)

  if (matchIndex === null) {
    const slotCommandTexts = commandMatchVariants(slotCommand.command)
    const slotCwd = slotCommand.cwd?.trim() ?? ''
    if (slotCwd.length > 0) {
      for (const slotCommandText of slotCommandTexts) {
        matchIndex = takeCommandMatchIndex(
          commandLookup.byCommandAndCwd.get(commandAndCwdKey(slotCommandText, slotCwd)),
          commandLookup.usedIndexes,
        )
        if (matchIndex !== null) break
      }
    }
    if (matchIndex === null) {
      for (const slotCommandText of slotCommandTexts) {
        matchIndex = takeCommandMatchIndex(commandLookup.byCommand.get(slotCommandText), commandLookup.usedIndexes)
        if (matchIndex !== null) break
      }
    }
  }

  if (matchIndex === null) return null
  return commandMessages[matchIndex]!
}

function takeOrderedFallbackCommandForSessionSlot(
  slotCommand: SessionRecoveredCommand,
  commandMessages: Record<string, unknown>[],
  commandLookup: SessionCommandLookup,
): Record<string, unknown> | null {
  const slotCwd = slotCommand.cwd?.trim() ?? ''
  const matchIndex = slotCwd
    ? takeEarliestCommandMatchIndex([
      commandLookup.fallbackByCwd.get(slotCwd),
      commandLookup.fallbackByCwd.get(''),
    ], commandLookup.usedIndexes)
    : takeCommandMatchIndex(commandLookup.fallbackAll, commandLookup.usedIndexes)

  return matchIndex === null ? null : commandMessages[matchIndex]!
}

function matchSessionCommandSlots(
  slots: SessionItemSlot[],
  commandMessages: Record<string, unknown>[],
): { matches: Map<SessionRecoveredCommand, Record<string, unknown>>, lookup: SessionCommandLookup } {
  const lookup = createSessionCommandLookup(commandMessages)
  const matches = new Map<SessionRecoveredCommand, Record<string, unknown>>()
  const unresolved: SessionRecoveredCommand[] = []

  for (const slot of slots) {
    if (slot.type !== 'commandExecution' || !slot.command) continue
    const existing = takeStrictCommandForSessionSlot(slot.command, commandMessages, lookup)
    if (existing) matches.set(slot.command, existing)
    else unresolved.push(slot.command)
  }

  for (const slotCommand of unresolved) {
    const existing = takeOrderedFallbackCommandForSessionSlot(slotCommand, commandMessages, lookup)
    if (existing) matches.set(slotCommand, existing)
  }

  return { matches, lookup }
}

function takeExistingFileChangeForSessionSlot(
  slotFileChange: SessionRecoveredFileChangeItem,
  fileChangeMessages: Record<string, unknown>[],
  usedFileChangeIndexes: Set<number>,
): Record<string, unknown> | null {
  const slotId = slotFileChange.id.trim()
  let matchIndex = fileChangeMessages.findIndex((item, index) => (
    !usedFileChangeIndexes.has(index)
    && typeof item.id === 'string'
    && item.id.trim() === slotId
  ))

  if (matchIndex < 0) {
    matchIndex = fileChangeMessages.findIndex((_item, index) => !usedFileChangeIndexes.has(index))
  }

  if (matchIndex < 0) return null
  usedFileChangeIndexes.add(matchIndex)
  return fileChangeMessages[matchIndex]!
}

function extractFilePathsFromCommand(cmd: string, cwd: string): string[] {
  const paths: string[] = []
  const absPathPattern = /(?:^|\s|>>|>|<)(\/?(?:Users|home|tmp|var|etc|root)\/[^\s;|&><"']+)/g
  let match: RegExpExecArray | null
  while ((match = absPathPattern.exec(cmd)) !== null) {
    const p = match[1]?.trim()
    if (p && !p.endsWith('/') && !p.startsWith('-')) paths.push(p)
  }

  const redirectPattern = /(?:>>?|cat\s*>\s*)([^\s;|&><"']+)/g
  while ((match = redirectPattern.exec(cmd)) !== null) {
    const p = match[1]?.trim()
    if (p && !p.startsWith('-') && !p.startsWith('/dev/')) {
      paths.push(isAbsolute(p) ? p : join(cwd, p))
    }
  }

  return [...new Set(paths)]
}

type CollectedTurnFileInfo = {
  patchInputs: { callId: string; input: string }[]
  commandFilePaths: string[]
}

function collectFileChangesForTurns(
  sessionLogRaw: string,
  turnIdsToRevert: Set<string>,
  cwd: string,
): Map<string, CollectedTurnFileInfo> {
  let currentTurnId = ''
  const infoByTurnId = new Map<string, CollectedTurnFileInfo>()

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const p = asRecord(row.payload)
      currentTurnId = readNonEmptyString(p?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      const p = asRecord(row.payload)
      if (p?.type === 'task_started') {
        currentTurnId = readNonEmptyString(p.turn_id) || currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId || !turnIdsToRevert.has(currentTurnId)) continue
    const payload = asRecord(row.payload)
    if (!payload) continue

    let info = infoByTurnId.get(currentTurnId)
    if (!info) {
      info = { patchInputs: [], commandFilePaths: [] }
      infoByTurnId.set(currentTurnId, info)
    }

    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && payload.status === 'completed') {
      const input = typeof payload.input === 'string' ? payload.input : ''
      const callId = readNonEmptyString(payload.call_id)
      if (input && callId) {
        info.patchInputs.push({ callId, input })
      }
    }

    if (payload.type === 'function_call' && payload.name === 'exec_command') {
      let cmd = ''
      try {
        const args = JSON.parse(payload.arguments as string) as Record<string, unknown>
        cmd = typeof args.cmd === 'string' ? args.cmd : ''
      } catch { /* empty */ }
      if (cmd) {
        const extracted = extractFilePathsFromCommand(cmd, cwd)
        for (const p of extracted) {
          if (!info.commandFilePaths.includes(p)) info.commandFilePaths.push(p)
        }
      }
    }
  }

  return infoByTurnId
}

function reverseV4aDiff(fileContent: string, diffText: string): string | null {
  const fileLines = fileContent.split('\n')
  const rawDiffLines = diffText.split('\n')
  while (rawDiffLines.length > 0 && rawDiffLines[rawDiffLines.length - 1]?.trim() === '') rawDiffLines.pop()
  const diffLines = rawDiffLines
  const result = [...fileLines]

  type DiffEntry = { type: 'context' | 'add' | 'remove'; text: string }
  const hunks: DiffEntry[][] = []
  let currentHunk: DiffEntry[] | null = null

  for (const dl of diffLines) {
    if (dl.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = []
      continue
    }
    if (!currentHunk) continue
    if (dl.startsWith('+')) {
      currentHunk.push({ type: 'add', text: dl.slice(1) })
    } else if (dl.startsWith('-')) {
      currentHunk.push({ type: 'remove', text: dl.slice(1) })
    } else if (dl.startsWith(' ')) {
      currentHunk.push({ type: 'context', text: dl.slice(1) })
    } else {
      currentHunk.push({ type: 'context', text: dl })
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const hunk = hunks[hi]!
    const expectedSequence = hunk
      .filter((e) => e.type === 'context' || e.type === 'add')
      .map((e) => e.text)

    if (expectedSequence.length === 0) continue

    let seqStart = -1
    outer: for (let ri = result.length - expectedSequence.length; ri >= 0; ri--) {
      for (let si = 0; si < expectedSequence.length; si++) {
        if (result[ri + si] !== expectedSequence[si]) continue outer
      }
      seqStart = ri
      break
    }

    if (seqStart < 0) return null

    const newLines: string[] = []
    let seqIdx = 0
    for (const entry of hunk) {
      if (entry.type === 'context') {
        newLines.push(result[seqStart + seqIdx]!)
        seqIdx++
      } else if (entry.type === 'add') {
        seqIdx++
      } else if (entry.type === 'remove') {
        newLines.push(entry.text)
      }
    }

    result.splice(seqStart, expectedSequence.length, ...newLines)
  }

  return result.join('\n')
}

async function revertTurnFileChanges(
  cwd: string,
  turnInfos: Map<string, CollectedTurnFileInfo>,
): Promise<{ reverted: number; errors: string[] }> {
  if (turnInfos.size === 0) return { reverted: 0, errors: [] }

  let reverted = 0
  const errors: string[] = []

  const allEntries = [...turnInfos.values()]
  const allPatchInputs = allEntries.flatMap((info) => info.patchInputs).reverse()
  const allCommandPaths = new Set(allEntries.flatMap((info) => info.commandFilePaths))

  let isGitRepo = false
  let gitRoot = ''
  try {
    gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    isGitRepo = !!gitRoot
  } catch { /* not a git repo */ }

  const trackedFiles = new Set<string>()
  if (isGitRepo) {
    try {
      const tracked = await runCommandCapture('git', ['ls-files', '--full-name'], { cwd: gitRoot })
      for (const f of tracked.split('\n')) {
        if (f.trim()) trackedFiles.add(join(gitRoot, f.trim()))
      }
    } catch { /* empty */ }
  }

  const patchRevertedPaths = new Set<string>()

  for (const patch of allPatchInputs) {
    const changes = parseApplyPatchInput(patch.input)
    for (let ci = changes.length - 1; ci >= 0; ci--) {
      const change = changes[ci]!
      const filePath = isAbsolute(change.path) ? change.path : join(cwd, change.path)

      try {
        if (change.operation === 'add') {
          const fileStat = await stat(filePath).catch(() => null)
          if (fileStat) {
            await rm(filePath, { force: true })
            reverted++
            patchRevertedPaths.add(filePath)
          }
        } else if (change.operation === 'update' && change.diff) {
          let reversed = false
          try {
            const currentContent = await readFile(filePath, 'utf8')
            const newContent = reverseV4aDiff(currentContent, change.diff)
            if (newContent !== null && newContent !== currentContent) {
              const { writeFile } = await import('node:fs/promises')
              await writeFile(filePath, newContent)
              reverted++
              patchRevertedPaths.add(filePath)
              reversed = true
            }
          } catch { /* file read/write failed */ }

          if (!reversed) {
            const isTracked = trackedFiles.has(filePath)
            if (isTracked && isGitRepo) {
              const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
              try {
                await runCommand('git', ['checkout', 'HEAD', '--', relativePath], { cwd: gitRoot })
                reverted++
                patchRevertedPaths.add(filePath)
              } catch {
                errors.push(`Could not revert: ${filePath}`)
              }
            } else {
              errors.push(`Could not reverse patch for untracked file: ${filePath}`)
            }
          }
        } else if (change.operation === 'delete') {
          const isTracked = trackedFiles.has(filePath)
          if (isTracked && isGitRepo) {
            const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
            try {
              await runCommand('git', ['checkout', 'HEAD', '--', relativePath], { cwd: gitRoot })
              reverted++
              patchRevertedPaths.add(filePath)
            } catch {
              errors.push(`Could not restore deleted file: ${filePath}`)
            }
          }
        }
      } catch (err) {
        errors.push(`Failed to revert patch for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  for (const filePath of allCommandPaths) {
    if (patchRevertedPaths.has(filePath)) continue
    const isTracked = trackedFiles.has(filePath)
    if (isTracked && isGitRepo) {
      const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
      try {
        await runCommand('git', ['checkout', 'HEAD', '--', relativePath], { cwd: gitRoot })
        reverted++
      } catch {
        errors.push(`Could not restore command-modified file: ${filePath}`)
      }
    }
  }

  return { reverted, errors }
}

function mergeSessionCommandsIntoTurns(turns: unknown[], sessionLogRaw: string): unknown[] {
  const turnIds = new Set<string>()
  for (const turn of turns) {
    const turnRecord = asRecord(turn)
    const turnId = readNonEmptyString(turnRecord?.id)
    if (turnId) turnIds.add(turnId)
  }

  if (turnIds.size === 0) return turns

  const orderByTurnId = buildSessionItemOrder(sessionLogRaw, turnIds)
  if (orderByTurnId.size === 0) return turns

  return turns.map((turn) => {
    const turnRecord = asRecord(turn)
    if (!turnRecord) return turn
    const turnId = readNonEmptyString(turnRecord.id)
    if (!turnId) return turn

    const slots = orderByTurnId.get(turnId)
    if (!slots || slots.length === 0) return turn

    const existingItems = Array.isArray(turnRecord.items) ? (turnRecord.items as Record<string, unknown>[]) : []

    const representedCursorCallIds = new Set<string>()
    for (const slot of slots) {
      const cursorCallId = slot.cursorCallId || slot.command?.cursorCallId || ''
      if (cursorCallId) representedCursorCallIds.add(cursorCallId)
    }
    const existingCursorPayloadCache: CursorToolPayloadCache = new Map()
    const agentMessages = existingItems.filter((it) => {
      if (it.type !== 'agentMessage') return false
      const text = typeof it.text === 'string' ? it.text : ''
      const cursorCallId = text ? cursorToolCallIdFromMessageText(text, existingCursorPayloadCache) : ''
      return !cursorCallId || !representedCursorCallIds.has(cursorCallId)
    })
    const splitAgentMessages = splitMergedAgentMessageFromSessionSlots(agentMessages, slots)
    const splitAgentMessageApplied = splitAgentMessages !== agentMessages
    const commandMessages = existingItems.filter((it) => it.type === 'commandExecution')
    const fileChangeMessages = existingItems.filter((it) => it.type === 'fileChange')
    const nonAgentNonUserItems = existingItems.filter((it) => (
      it.type !== 'agentMessage'
      && it.type !== 'userMessage'
      && it.type !== 'commandExecution'
      && it.type !== 'fileChange'
    ))
    const userMessages = existingItems.filter((it) => it.type === 'userMessage')

    let agentIdx = 0
    const { matches: commandMatches, lookup: commandLookup } = matchSessionCommandSlots(
      slots,
      commandMessages,
    )
    const usedFileChangeIndexes = new Set<number>()
    const interleaved: Record<string, unknown>[] = [...userMessages]

    for (const slot of slots) {
      if (slot.type === 'agentMessage') {
        if (slot.cursorCallId && slot.text) {
          interleaved.push({
            id: `session-cursor-${slot.cursorCallId}`,
            type: 'agentMessage',
            text: slot.text,
          })
          continue
        }
        if (splitAgentMessageApplied && !slot.text) continue
        if (agentIdx < splitAgentMessages.length) {
          interleaved.push(splitAgentMessages[agentIdx]!)
          agentIdx++
        }
      } else if (slot.type === 'commandExecution' && slot.command) {
        interleaved.push(commandMatches.get(slot.command)
          ?? slot.command as unknown as Record<string, unknown>)
      } else if (slot.type === 'fileChange' && slot.fileChange) {
        interleaved.push(takeExistingFileChangeForSessionSlot(
          slot.fileChange,
          fileChangeMessages,
          usedFileChangeIndexes,
        ) ?? slot.fileChange as unknown as Record<string, unknown>)
      } else if (slot.type === 'toolCall' && slot.toolCall) {
        interleaved.push(slot.toolCall as unknown as Record<string, unknown>)
      }
    }

    while (agentIdx < splitAgentMessages.length) {
      interleaved.push(splitAgentMessages[agentIdx]!)
      agentIdx++
    }

    for (let index = 0; index < commandMessages.length; index += 1) {
      if (!commandLookup.usedIndexes.has(index)) interleaved.push(commandMessages[index]!)
    }
    for (let index = 0; index < fileChangeMessages.length; index += 1) {
      if (!usedFileChangeIndexes.has(index)) interleaved.push(fileChangeMessages[index]!)
    }
    interleaved.push(...nonAgentNonUserItems)

    if (
      interleaved.length === existingItems.length
      && interleaved.every((item, index) => item === existingItems[index])
    ) {
      return turn
    }

    return {
      ...turnRecord,
      items: interleaved,
    }
  })
}

function isExactPhraseMatch(query: string, doc: ThreadSearchDocument): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return (
    doc.title.toLowerCase().includes(q) ||
    doc.preview.toLowerCase().includes(q) ||
    doc.messageText.toLowerCase().includes(q)
  )
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

export type SessionForkLineage = {
  threadId: string
  forkedFromId: string
  cwd: string
  forkPointOrdinal: number | null
  forkPointByteOffset: number | null
  historyBaseThreadId: string
  historyBaseOrdinal: number | null
  historyBaseByteOffset: number | null
  isPaginated: boolean
  isArchived: boolean
  sessionPath: string
}

const PAGINATED_FORK_RECOVERY_CACHE_TTL_MS = 30_000
const PAGINATED_FORK_SCAN_CONCURRENCY = 8
const SESSION_ROLLOUT_DIRECTORY_DEPTH = 3
const SESSION_ROLLOUT_ROOTS = [
  { directory: 'sessions', isArchived: false },
  { directory: 'archived_sessions', isArchived: true },
] as const

let sessionForkLineageCache: {
  scannedAtMs: number
  entries: SessionForkLineage[]
} | null = null
let sessionForkLineageScanPromise: Promise<SessionForkLineage[]> | null = null

export function invalidatePaginatedForkThreadListRecoveryCache(): void {
  sessionForkLineageCache = null
}

async function listSessionRolloutPaths(directory: string, depth = 0): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  const nestedDirectories: string[] = []

  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      paths.push(entryPath)
    } else if (entry.isDirectory() && depth < SESSION_ROLLOUT_DIRECTORY_DEPTH) {
      nestedDirectories.push(entryPath)
    }
  }

  for (const nestedDirectory of nestedDirectories) {
    paths.push(...await listSessionRolloutPaths(nestedDirectory, depth + 1))
  }
  return paths
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function readSessionForkLineage(
  sessionPath: string,
  isArchived: boolean,
): Promise<SessionForkLineage | null> {
  const stream = createReadStream(sessionPath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const entry = asRecord(JSON.parse(line) as unknown)
      if (entry?.type !== 'session_meta') return null
      const payload = asRecord(entry.payload)
      const historyBase = asRecord(payload?.history_base)
      const threadId = readNonEmptyString(payload?.session_id) || readNonEmptyString(payload?.id)
      const forkedFromId = readNonEmptyString(payload?.forked_from_id)
      const historyBaseThreadId = readNonEmptyString(historyBase?.thread_id)
      if (!threadId) return null

      // `forked_from_id` identifies the session on which `thread/fork` was
      // invoked. For paginated history, `history_base` identifies the physical
      // session containing the selected fork point, which is the sidebar's
      // actual topology parent.
      const forkPointIsInDirectParent = historyBaseThreadId === forkedFromId
      return {
        threadId,
        forkedFromId: forkedFromId ?? '',
        cwd: readNonEmptyString(payload?.cwd),
        forkPointOrdinal: forkPointIsInDirectParent
          ? readNonNegativeSafeInteger(historyBase?.end_ordinal_exclusive)
          : null,
        forkPointByteOffset: forkPointIsInDirectParent
          ? readNonNegativeSafeInteger(historyBase?.end_byte_offset)
          : null,
        historyBaseThreadId,
        historyBaseOrdinal: readNonNegativeSafeInteger(historyBase?.end_ordinal_exclusive),
        historyBaseByteOffset: readNonNegativeSafeInteger(historyBase?.end_byte_offset),
        isPaginated: payload?.history_mode === 'paginated' && Boolean(historyBaseThreadId),
        isArchived,
        sessionPath,
      }
    }
  } catch {
    return null
  } finally {
    lines.close()
    stream.destroy()
  }

  return null
}

function isArchivedSessionPath(sessionPath: string): boolean {
  return sessionPath.split(/[\\/]+/u).includes('archived_sessions')
}

async function scanSessionForkLineage(): Promise<SessionForkLineage[]> {
  const rolloutPaths = (await Promise.all(SESSION_ROLLOUT_ROOTS.map(async (root) => (
    (await listSessionRolloutPaths(join(getCodexHomeDir(), root.directory)))
      .map((sessionPath) => ({ sessionPath, isArchived: root.isArchived }))
  )))).flat()
  const entries: SessionForkLineage[] = []
  let nextPathIndex = 0

  await Promise.all(Array.from(
    { length: Math.min(PAGINATED_FORK_SCAN_CONCURRENCY, rolloutPaths.length) },
    async () => {
      while (nextPathIndex < rolloutPaths.length) {
        const rolloutPath = rolloutPaths[nextPathIndex]
        nextPathIndex += 1
        if (!rolloutPath) continue
        const entry = await readSessionForkLineage(rolloutPath.sessionPath, rolloutPath.isArchived)
        if (entry) entries.push(entry)
      }
    },
  ))

  const lineageByThreadId = new Map<string, SessionForkLineage>()
  for (const entry of entries) {
    const existing = lineageByThreadId.get(entry.threadId)
    if (!existing || (existing.isArchived && !entry.isArchived)) {
      lineageByThreadId.set(entry.threadId, entry)
    }
  }
  return Array.from(lineageByThreadId.values())
}

async function getSessionForkLineage(): Promise<SessionForkLineage[]> {
  const now = Date.now()
  if (
    sessionForkLineageCache
    && now - sessionForkLineageCache.scannedAtMs < PAGINATED_FORK_RECOVERY_CACHE_TTL_MS
  ) {
    return sessionForkLineageCache.entries
  }
  if (sessionForkLineageScanPromise) return await sessionForkLineageScanPromise

  sessionForkLineageScanPromise = scanSessionForkLineage()
    .then((entries) => {
      sessionForkLineageCache = { scannedAtMs: Date.now(), entries }
      return entries
    })
    .finally(() => {
      sessionForkLineageScanPromise = null
    })
  return await sessionForkLineageScanPromise
}

async function getPaginatedForkRecoveryCandidates(): Promise<SessionForkLineage[]> {
  return (await getSessionForkLineage()).filter((entry) => entry.isPaginated && !entry.isArchived)
}

function shouldRecoverPaginatedForksFromThreadList(params: unknown): boolean {
  const record = asRecord(params)
  if (!record || record.archived === true) return false
  return typeof record.cursor !== 'string' || record.cursor.trim().length === 0
}

function readThreadListCwdFilters(params: unknown): string[] | null {
  const cwd = asRecord(params)?.cwd
  if (typeof cwd === 'string') {
    const normalized = cwd.trim()
    return normalized ? [normalized] : null
  }
  if (!Array.isArray(cwd)) return null
  const filters = cwd.flatMap((value) => typeof value === 'string' && value.trim() ? [value.trim()] : [])
  return filters.length > 0 ? filters : null
}

function fallbackForkPreview(parentPreview: string): string {
  return parentPreview ? `Fork: ${parentPreview}` : 'Forked thread'
}

function sortThreadListDataByUpdatedAt(data: unknown[]): unknown[] {
  return [...data].sort((left, right) => {
    const leftUpdatedAt = asRecord(left)?.updatedAt
    const rightUpdatedAt = asRecord(right)?.updatedAt
    const leftTimestamp = typeof leftUpdatedAt === 'number' && Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0
    const rightTimestamp = typeof rightUpdatedAt === 'number' && Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0
    return rightTimestamp - leftTimestamp
  })
}

/**
 * `thread/list` does not expose fork lineage. Attach local rollout metadata so
 * the sidebar can build its tree without loading each thread. A paginated
 * history base wins over the invocation source when a fork point belongs to an
 * ancestor. If an intermediate parent is archived, fold its branch into the
 * closest listed ancestor.
 */
export async function decorateThreadListWithForkLineage(result: unknown): Promise<unknown> {
  const resultRecord = asRecord(result)
  const data = Array.isArray(resultRecord?.data) ? resultRecord.data : null
  if (!resultRecord || !data) return result

  const lineageByThreadId = new Map(
    (await getSessionForkLineage()).map((entry) => [entry.threadId, entry]),
  )
  const listedThreadIds = new Set(data.flatMap((item) => {
    const threadId = readNonEmptyString(asRecord(item)?.id)
    return threadId ? [threadId] : []
  }))
  let changed = false
  const decoratedData = data.map((item) => {
    const thread = asRecord(item)
    const threadId = readNonEmptyString(thread?.id)
    const lineage = threadId ? lineageByThreadId.get(threadId) : null
    if (!thread || !lineage) return item
    if (lineage.cwd && readNonEmptyString(thread.cwd) !== lineage.cwd) return item

    const resolvedLineage = resolveVisibleForkLineage(
      lineage,
      listedThreadIds,
      lineageByThreadId,
    )
    if (!resolvedLineage) return item

    changed = true
    return {
      ...thread,
      ...resolvedLineage,
    }
  })

  return changed ? { ...resultRecord, data: decoratedData } : result
}

function resolveVisibleForkLineage(
  lineage: SessionForkLineage,
  listedThreadIds: Set<string>,
  lineageByThreadId: Map<string, SessionForkLineage>,
): Pick<SessionForkLineage, 'forkedFromId' | 'forkPointOrdinal' | 'forkPointByteOffset'> | null {
  let candidate = lineage
  const visitedThreadIds = new Set([lineage.threadId])

  while (true) {
    const topologyParent = readForkTopologyParent(candidate)
    if (!topologyParent || visitedThreadIds.has(topologyParent.forkedFromId)) return null
    if (listedThreadIds.has(topologyParent.forkedFromId)) return topologyParent

    visitedThreadIds.add(topologyParent.forkedFromId)
    const parentLineage = lineageByThreadId.get(topologyParent.forkedFromId)
    if (parentLineage?.isArchived) {
      if (candidate.cwd && parentLineage.cwd && candidate.cwd !== parentLineage.cwd) return null
      candidate = parentLineage
      continue
    }
    return null
  }
}

function readForkTopologyParent(
  lineage: SessionForkLineage,
): Pick<SessionForkLineage, 'forkedFromId' | 'forkPointOrdinal' | 'forkPointByteOffset'> | null {
  if (lineage.isPaginated && lineage.historyBaseThreadId) {
    return {
      forkedFromId: lineage.historyBaseThreadId,
      forkPointOrdinal: lineage.historyBaseOrdinal,
      forkPointByteOffset: lineage.historyBaseByteOffset,
    }
  }
  if (!lineage.forkedFromId) return null
  return {
    forkedFromId: lineage.forkedFromId,
    forkPointOrdinal: lineage.forkPointOrdinal,
    forkPointByteOffset: lineage.forkPointByteOffset,
  }
}

/**
 * Codex currently omits a freshly forked paginated thread from `thread/list`
 * because its local rollout has only metadata and a history reference. Recover
 * those persistent forks from their rollout metadata until upstream lists them.
 */
export async function recoverUnlistedPaginatedForksInThreadList(
  result: unknown,
  params: unknown,
  appServer: RpcExecutor,
): Promise<unknown> {
  if (!shouldRecoverPaginatedForksFromThreadList(params)) return result

  const resultRecord = asRecord(result)
  const data = Array.isArray(resultRecord?.data) ? resultRecord.data : null
  if (!resultRecord || !data) return result

  const listedThreadIds = new Set<string>()
  const previewsByThreadId = new Map<string, string>()
  for (const item of data) {
    const thread = asRecord(item)
    const threadId = readNonEmptyString(thread?.id)
    if (!threadId) continue
    listedThreadIds.add(threadId)
    previewsByThreadId.set(threadId, readNonEmptyString(thread?.preview))
  }

  const candidates = await getPaginatedForkRecoveryCandidates()
  const cwdFilters = readThreadListCwdFilters(params)
  const recoveredThreads: unknown[] = []
  for (const candidate of candidates) {
    if (listedThreadIds.has(candidate.threadId)) continue
    if (cwdFilters && !cwdFilters.includes(candidate.cwd)) continue
    try {
      const threadReadResult = asRecord(await appServer.rpc('thread/read', {
        threadId: candidate.threadId,
        includeTurns: false,
      }))
      const thread = asRecord(threadReadResult?.thread)
      if (readNonEmptyString(thread?.id) !== candidate.threadId) continue
      if (candidate.cwd && readNonEmptyString(thread?.cwd) !== candidate.cwd) continue

      const preview = readNonEmptyString(thread?.preview)
      recoveredThreads.push(preview
        ? thread
        : {
            ...thread,
            preview: fallbackForkPreview(previewsByThreadId.get(candidate.forkedFromId) ?? ''),
          })
      listedThreadIds.add(candidate.threadId)
    } catch {
      // The rollout can disappear between the local scan and thread/read.
    }
  }

  if (recoveredThreads.length === 0) return result
  return {
    ...resultRecord,
    data: sortThreadListDataByUpdatedAt([...data, ...recoveredThreads]),
  }
}

function getSkillsInstallDir(): string {
  return join(getCodexHomeDir(), 'skills')
}

function getPromptsDir(): string {
  return join(getCodexHomeDir(), 'prompts')
}

type ComposerPromptRecord = {
  name: string
  path: string
  content: string
  description: string
}

function promptNameToFileName(name: string): string {
  const trimmed = name.trim()
  const withoutExtension = trimmed.replace(/\.md$/i, '')
  const sanitized = withoutExtension
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${sanitized || 'prompt'}.md`
}

function buildPromptDescription(content: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  return firstNonEmptyLine.slice(0, 120)
}

async function listComposerPrompts(): Promise<ComposerPromptRecord[]> {
  const promptsDir = getPromptsDir()
  try {
    const entries = await readdir(promptsDir, { withFileTypes: true })
    const prompts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const promptPath = join(promptsDir, entry.name)
        const content = await readFile(promptPath, 'utf8')
        return {
          name: entry.name.replace(/\.md$/i, ''),
          path: promptPath,
          content,
          description: buildPromptDescription(content),
        } satisfies ComposerPromptRecord
      }))
    return prompts.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
}

async function createComposerPromptFile(name: string, content: string): Promise<ComposerPromptRecord> {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Prompt name is required')
  const trimmedContent = content.trim()
  if (!trimmedContent) throw new Error('Prompt content is required')
  const promptsDir = getPromptsDir()
  await mkdir(promptsDir, { recursive: true })

  const baseFileName = promptNameToFileName(trimmedName)
  let targetPath = join(promptsDir, baseFileName)
  let suffix = 2
  while (existsSync(targetPath)) {
    const nextFileName = `${baseFileName.replace(/\.md$/i, '')}-${suffix}.md`
    targetPath = join(promptsDir, nextFileName)
    suffix += 1
  }

  await writeFile(targetPath, `${trimmedContent}\n`, 'utf8')
  return {
    name: basename(targetPath).replace(/\.md$/i, ''),
    path: targetPath,
    content: `${trimmedContent}\n`,
    description: buildPromptDescription(trimmedContent),
  }
}

async function removeComposerPromptFile(promptPath: string): Promise<boolean> {
  const resolvedPath = resolve(promptPath)
  const promptsDir = resolve(getPromptsDir())
  const relative = resolvedPath.startsWith(`${promptsDir}/`) ? resolvedPath.slice(promptsDir.length + 1) : ''
  if (!relative || relative.includes('..') || !resolvedPath.toLowerCase().endsWith('.md')) {
    throw new Error('Invalid prompt path')
  }
  try {
    await rm(resolvedPath, { force: false })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

async function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let closed = false
    const timeout =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true
          proc.kill('SIGTERM')
          setTimeout(() => {
            if (!closed) proc.kill('SIGKILL')
          }, 5_000).unref()
        }, options.timeoutMs)
        : null
    timeout?.unref()
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    proc.on('close', (code) => {
      closed = true
      if (timeout) clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`Command timed out after ${options.timeoutMs}ms (${command} ${args.join(' ')})`))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

function isMissingHeadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return (
    message.includes("not a valid object name: 'head'") ||
    message.includes('not a valid object name: head') ||
    message.includes('invalid reference: head')
  )
}

function isNotGitRepositoryError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return message.includes('not a git repository') || message.includes('fatal: not a git repository')
}

async function ensureRepoHasInitialCommit(repoRoot: string): Promise<void> {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  try {
    await stat(agentsPath)
  } catch {
    await writeFile(agentsPath, '', 'utf8')
  }

  await runCommand('git', ['add', 'AGENTS.md'], { cwd: repoRoot })
  await runCommand(
    'git',
    ['-c', 'user.name=Codex', '-c', 'user.email=codex@local', 'commit', '-m', 'Initialize repository for worktree support'],
    { cwd: repoRoot },
  )
}

async function runCommandCapture(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

function normalizeBranchRefName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length)
  if (trimmed.startsWith('refs/remotes/')) return trimmed.slice('refs/remotes/'.length)
  return trimmed
}

function toHeaderGitResetHistoryRef(branchName: string, commitSha: string): string {
  return `refs/codex/header-git-reset-history/${branchName}/${commitSha}`
}

const HEADER_GIT_RESET_HISTORY_REF_LIMIT = 25

async function assertLocalGitBranch(repoRoot: string, branchName: string): Promise<void> {
  await runCommandCapture('git', ['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: repoRoot })
}

async function checkoutGitBranchWithWorktreeRecovery(repoRoot: string, branchName: string): Promise<void> {
  try {
    await runCommand('git', ['checkout', branchName], { cwd: repoRoot })
  } catch (checkoutError) {
    const blockingWorktreePath = extractBranchLockedWorktreePath(checkoutError, branchName)
    if (!blockingWorktreePath) {
      throw checkoutError
    }
    await runCommand('git', ['checkout', '--detach'], { cwd: blockingWorktreePath })
    await runCommand('git', ['checkout', branchName], { cwd: repoRoot })
  }
}

async function pruneHeaderGitResetHistoryRefs(repoRoot: string, branchName: string): Promise<void> {
  const resetHistoryRefPrefix = `refs/codex/header-git-reset-history/${branchName}/`
  const refsRaw = await runCommandCapture(
    'git',
    ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', resetHistoryRefPrefix],
    { cwd: repoRoot },
  ).catch(() => '')
  const refs = refsRaw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const staleRefs = refs.slice(HEADER_GIT_RESET_HISTORY_REF_LIMIT)
  for (const refName of staleRefs) {
    await runCommand('git', ['update-ref', '-d', refName], { cwd: repoRoot })
  }
}

async function readGitHeaderState(cwd: string): Promise<{
  currentBranch: string | null
  headSha: string | null
  headSubject: string | null
  headDate: string | null
  detached: boolean
  dirty: boolean
  gitRoot: string
}> {
  const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
  const currentBranchRaw = await runCommandCapture('git', ['branch', '--show-current'], { cwd: gitRoot })
  const currentBranch = currentBranchRaw.trim() || null
  const headShaRaw = await runCommandCapture('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: gitRoot })
  const headCommitRaw = await runCommandCapture('git', ['show', '-s', '--date=short', '--format=%cd%x09%s', 'HEAD'], { cwd: gitRoot })
  const [headDate = '', ...headSubjectParts] = headCommitRaw.split('\t')
  const statusRaw = await runCommandCapture('git', ['status', '--porcelain'], { cwd: gitRoot })
  return {
    currentBranch,
    headSha: headShaRaw.trim() || null,
    headSubject: headSubjectParts.join('\t').trim() || null,
    headDate: headDate.trim() || null,
    detached: !currentBranch,
    dirty: statusRaw.trim().length > 0,
    gitRoot,
  }
}

async function assertNoTrackedGitChanges(repoRoot: string): Promise<void> {
  const statusRaw = await runCommandCapture('git', ['status', '--porcelain'], { cwd: repoRoot })
  const trackedChanges = statusRaw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('?? '))
  if (trackedChanges.length > 0) {
    throw new Error('Cannot switch branches or reset with tracked uncommitted changes. Commit, stash, or discard tracked changes first. Untracked files are allowed unless Git would overwrite them.')
  }
}

function extractBranchLockedWorktreePath(error: unknown, branchName: string): string {
  const message = getErrorMessage(error, '')
  if (!message || !branchName) return ''
  const escapedBranch = branchName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`'${escapedBranch}' is already checked out at '([^']+)'`, 'u')
  const match = pattern.exec(message)
  return match?.[1]?.trim() ?? ''
}

function toPermanentWorktreeBranchNameDraft(worktreeName: string): string {
  const sanitized = worktreeName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/\.+/gu, '.')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
  return sanitized || 'worktree'
}

async function isValidGitBranchName(gitRoot: string, branchName: string): Promise<boolean> {
  try {
    await runCommand('git', ['check-ref-format', '--branch', branchName], { cwd: gitRoot })
    return true
  } catch {
    return false
  }
}

async function doesLocalGitBranchExist(gitRoot: string, branchName: string): Promise<boolean> {
  try {
    await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: gitRoot })
    return true
  } catch {
    return false
  }
}

async function allocatePermanentWorktreeBranchName(gitRoot: string, worktreeName: string): Promise<string> {
  const base = toPermanentWorktreeBranchNameDraft(worktreeName)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    if (!await isValidGitBranchName(gitRoot, candidate)) continue
    if (!await doesLocalGitBranchExist(gitRoot, candidate)) return candidate
  }
  throw new Error('Failed to allocate a unique branch name for worktree')
}

async function runCommandWithOutput(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}


function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof item === 'string') {
      next[key] = item
    }
  }
  return next
}

function normalizeRemoteProjects(value: unknown): WorkspaceRootsState['remoteProjects'] {
  if (!Array.isArray(value)) return []
  const next: WorkspaceRootsState['remoteProjects'] = []
  const seen = new Set<string>()
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    next.push({
      id,
      hostId: typeof record.hostId === 'string' ? record.hostId.trim() : '',
      remotePath: typeof record.remotePath === 'string' ? record.remotePath.trim() : '',
      label: typeof record.label === 'string' ? record.label.trim() : '',
    })
  }
  return next
}



function getCodexAuthPath(): string {
  return join(getCodexHomeDir(), 'auth.json')
}

type CodexAuth = {
  auth_mode?: string
  last_refresh?: number
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
  }
}

const CODEX_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_CODEX_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(decoded) as unknown
    return asRecord(parsed)
  } catch {
    return null
  }
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  return decodeBase64UrlJson(parts[1] ?? '')
}

function extractChatgptTokenMetadata(accessToken: string | undefined): {
  chatgptAccountId: string | null
  chatgptPlanType: string | null
} {
  const payload = decodeJwtPayload(accessToken)
  const auth = asRecord(payload?.['https://api.openai.com/auth'])
  return {
    chatgptAccountId: readNonEmptyString(auth?.chatgpt_account_id) || null,
    chatgptPlanType: readNonEmptyString(auth?.chatgpt_plan_type) || null,
  }
}

function readTokenErrorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload)
  const message = readNonEmptyString(record?.message)
  if (message) return message
  const error = record?.error
  if (typeof error === 'string' && error.trim().length > 0) return error.trim()
  const nestedError = asRecord(error)
  return readNonEmptyString(nestedError?.message)
    || readNonEmptyString(nestedError?.error_description)
    || readNonEmptyString(record?.error_description)
    || fallback
}

function readTokenResponseString(payload: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!payload) return null
  for (const key of keys) {
    const value = readNonEmptyString(payload[key])
    if (value) return value
  }
  return null
}

export async function refreshChatgptAuthTokensForExternalAuth(
  params: ChatgptAuthTokensRefreshParams = {},
): Promise<ChatgptAuthTokensRefreshResponse> {
  const authPath = getCodexAuthPath()
  const raw = await readFile(authPath, 'utf8')
  const auth = JSON.parse(raw) as CodexAuth
  const currentRefreshToken = auth.tokens?.refresh_token?.trim() ?? ''
  if (!currentRefreshToken) {
    throw new Error('No ChatGPT refresh token is available. Please sign in again.')
  }

  const refreshUrl = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() || DEFAULT_CODEX_REFRESH_TOKEN_URL
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: CODEX_CHATGPT_CLIENT_ID,
  })

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25_000),
  })

  const text = await response.text()
  let payload: Record<string, unknown> | null = null
  try {
    payload = asRecord(JSON.parse(text))
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new Error(readTokenErrorMessage(payload, `ChatGPT token refresh failed with HTTP ${String(response.status)}`))
  }

  const accessToken = readTokenResponseString(payload, 'access_token', 'accessToken')
  if (!accessToken) {
    throw new Error('ChatGPT token refresh response did not include an access token.')
  }

  const nextRefreshToken = readTokenResponseString(payload, 'refresh_token', 'refreshToken') ?? currentRefreshToken
  const nextIdToken = readTokenResponseString(payload, 'id_token', 'idToken') ?? auth.tokens?.id_token
  const metadata = extractChatgptTokenMetadata(accessToken)
  const chatgptAccountId =
    metadata.chatgptAccountId
    || readTokenResponseString(payload, 'chatgpt_account_id', 'chatgptAccountId')
    || readNonEmptyString(params.previousAccountId)
    || readNonEmptyString(auth.tokens?.account_id)
  if (!chatgptAccountId) {
    throw new Error('ChatGPT token refresh response did not include account metadata.')
  }

  const nextAuth: CodexAuth = {
    ...auth,
    auth_mode: auth.auth_mode || 'chatgpt',
    last_refresh: Date.now(),
    tokens: {
      ...auth.tokens,
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      account_id: chatgptAccountId,
      ...(nextIdToken ? { id_token: nextIdToken } : {}),
    },
  }
  await writeFile(authPath, JSON.stringify(nextAuth, null, 2), { encoding: 'utf8', mode: 0o600 })

  return {
    accessToken,
    chatgptAccountId,
    chatgptPlanType: metadata.chatgptPlanType,
  }
}

async function readCodexAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    const token = auth.tokens?.access_token
    if (!token) return null
    return { accessToken: token, accountId: auth.tokens?.account_id ?? undefined }
  } catch {
    return null
  }
}

function hasUsableCodexAuthSync(): boolean {
  try {
    const raw = readFileSync(getCodexAuthPath(), 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    return Boolean(auth.tokens?.access_token?.trim())
  } catch {
    return false
  }
}

function readFreeModeStateSync(statePath: string): FreeModeState | null {
  try {
    return normalizeFreeModeState(JSON.parse(readFileSync(statePath, 'utf8')) as FreeModeState)
  } catch {
    return null
  }
}

function ensureDefaultFreeModeStateForMissingAuthSync(statePath: string): FreeModeState | null {
  const current = readFreeModeStateSync(statePath)
  if (!shouldCreateDefaultFreeModeStateForMissingAuth(current, hasUsableCodexAuthSync())) {
    return current
  }

  const fallback = createDefaultOpenCodeZenFreeModeState()

  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(fallback), { encoding: 'utf8', mode: 0o600 })
  return fallback
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress
  return normalized === '127.0.0.1' || normalized === '::1'
}

function getCodexGlobalStatePath(): string {
  return join(getCodexHomeDir(), '.codex-global-state.json')
}

function getTelegramBridgeConfigPath(): string {
  return join(getCodexHomeDir(), 'telegram-bridge.json')
}

function getCodexSessionIndexPath(): string {
  return join(getCodexHomeDir(), 'session_index.jsonl')
}

function getCodexAutomationsDir(): string {
  return join(getCodexHomeDir(), 'automations')
}

function getCursorToolPayloadsDir(): string {
  return join(getCodexHomeDir(), 'cursor-tool-payloads')
}

function safeCursorToolPayloadThreadId(threadId: string): string {
  const sanitized = threadId.replace(/[^A-Za-z0-9_-]/gu, '_')
  return sanitized.length > 0 ? sanitized : 'unknown'
}

async function deleteCursorToolPayloadsForThread(threadId: string): Promise<void> {
  if (!threadId) return
  await rm(join(getCursorToolPayloadsDir(), safeCursorToolPayloadThreadId(threadId)), { recursive: true, force: true })
}

type ThreadAutomationStatus = 'ACTIVE' | 'PAUSED'

type ThreadAutomationRecord = {
  id: string
  kind: 'heartbeat' | 'cron'
  name: string
  prompt: string
  rrule: string
  status: ThreadAutomationStatus
  targetThreadId: string | null
  cwds: string[]
  extraTomlLines: string[]
  createdAtMs: number | null
  updatedAtMs: number | null
  nextRunAtMs: number | null
}

function readTomlString(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function serializeTomlString(value: string): string {
  return JSON.stringify(value)
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const values: string[] = []
  let index = 1
  const endIndex = trimmed.length - 1

  while (index < endIndex) {
    while (index < endIndex && /[\s,]/u.test(trimmed[index] ?? '')) index += 1
    if (index >= endIndex) break

    const quote = trimmed[index]
    if (quote !== '"' && quote !== "'") return []
    const start = index
    index += 1
    let valueText = ''

    if (quote === "'") {
      const closeIndex = trimmed.indexOf("'", index)
      if (closeIndex < 0 || closeIndex > endIndex) return []
      valueText = trimmed.slice(index, closeIndex)
      index = closeIndex + 1
    } else {
      let escaped = false
      while (index < endIndex) {
        const char = trimmed[index] ?? ''
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          break
        }
        index += 1
      }
      if (index >= endIndex || trimmed[index] !== '"') return []
      try {
        valueText = JSON.parse(trimmed.slice(start, index + 1)) as string
      } catch {
        return []
      }
      index += 1
    }

    if (valueText.trim().length > 0) values.push(valueText)
    while (index < endIndex && /\s/u.test(trimmed[index] ?? '')) index += 1
    if (index < endIndex && trimmed[index] !== ',') return []
  }

  return values
}

function serializeTomlStringArray(values: string[]): string {
  return `[${values.map((value) => serializeTomlString(value)).join(', ')}]`
}

export function parseAutomationToml(raw: string): ThreadAutomationRecord | null {
  const values: Record<string, string> = {}
  const extraTomlLines: string[] = []
  const knownKeys = new Set([
    'version',
    'id',
    'kind',
    'name',
    'prompt',
    'status',
    'rrule',
    'target_thread_id',
    'cwds',
    'created_at',
    'updated_at',
  ])
  let isInsideExtraTable = false
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      isInsideExtraTable = true
      extraTomlLines.push(trimmed)
      continue
    }
    if (isInsideExtraTable) {
      extraTomlLines.push(trimmed)
      continue
    }
    if (!trimmed.includes('=')) {
      extraTomlLines.push(trimmed)
      continue
    }
    const separatorIndex = trimmed.indexOf('=')
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (!key) continue
    if (knownKeys.has(key)) {
      values[key] = value
    } else {
      extraTomlLines.push(trimmed)
    }
  }

  const id = readTomlString(values.id ?? '')
  const kindValue = readTomlString(values.kind ?? (values.cwds ? 'cron' : 'heartbeat'))
  const name = readTomlString(values.name ?? '')
  const prompt = readTomlString(values.prompt ?? '')
  const rrule = readTomlString(values.rrule ?? '')
  const statusValue = readTomlString(values.status ?? 'ACTIVE')
  const targetThreadId = readTomlString(values.target_thread_id ?? '') || null
  const cwds = parseTomlStringArray(values.cwds ?? '')
  const createdAtMs = Number.parseInt(values.created_at ?? '', 10)
  const updatedAtMs = Number.parseInt(values.updated_at ?? '', 10)

  if (!id || !name || !prompt || !rrule) return null
  if (kindValue !== 'heartbeat' && kindValue !== 'cron') return null
  if (statusValue !== 'ACTIVE' && statusValue !== 'PAUSED') return null

  return {
    id,
    kind: kindValue,
    name,
    prompt,
    rrule,
    status: statusValue,
    targetThreadId,
    cwds,
    extraTomlLines,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    nextRunAtMs: null,
  }
}

function serializeAutomationToml(record: ThreadAutomationRecord): string {
  const lines = [
    'version = 1',
    `id = ${serializeTomlString(record.id)}`,
    `kind = ${serializeTomlString(record.kind)}`,
    `name = ${serializeTomlString(record.name)}`,
    `prompt = ${serializeTomlString(record.prompt)}`,
    `status = ${serializeTomlString(record.status)}`,
    `rrule = ${serializeTomlString(record.rrule)}`,
  ]
  if (record.targetThreadId) {
    lines.push(`target_thread_id = ${serializeTomlString(record.targetThreadId)}`)
  }
  if (record.cwds.length > 0) {
    lines.push(`cwds = ${serializeTomlStringArray(record.cwds)}`)
  }
  lines.push(
    `created_at = ${String(record.createdAtMs ?? Date.now())}`,
    `updated_at = ${String(record.updatedAtMs ?? Date.now())}`,
  )
  lines.push(...record.extraTomlLines)
  return `${lines.join('\n')}\n`
}

export function toAutomationApiRecord(record: ThreadAutomationRecord): Omit<ThreadAutomationRecord, 'extraTomlLines'> {
  const { extraTomlLines: _extraTomlLines, ...apiRecord } = record
  return apiRecord
}

function toAutomationApiMap(
  automationsByTarget: Record<string, ThreadAutomationRecord[]>,
): Record<string, Array<Omit<ThreadAutomationRecord, 'extraTomlLines'>>> {
  return Object.fromEntries(
    Object.entries(automationsByTarget).map(([target, automations]) => [
      target,
      automations.map(toAutomationApiRecord),
    ]),
  )
}

function toAutomationApiData(
  automation: ThreadAutomationRecord | ThreadAutomationRecord[] | null,
): Omit<ThreadAutomationRecord, 'extraTomlLines'> | Array<Omit<ThreadAutomationRecord, 'extraTomlLines'>> | null {
  if (Array.isArray(automation)) return automation.map(toAutomationApiRecord)
  return automation ? toAutomationApiRecord(automation) : null
}

function slugifyAutomationId(threadId: string, name: string): string {
  const preferred = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (preferred) return preferred.slice(0, 48)
  const fallback = threadId.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `heartbeat-${fallback.slice(0, 24) || randomBytes(4).toString('hex')}`
}

async function readAutomationRecordFromFile(filePath: string): Promise<ThreadAutomationRecord | null> {
  try {
    return parseAutomationToml(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function listThreadHeartbeatAutomations(): Promise<Record<string, ThreadAutomationRecord[]>> {
  const automationRoot = getCodexAutomationsDir()
  const next: Record<string, ThreadAutomationRecord[]> = {}
  let entries
  try {
    entries = await readdir(automationRoot, { withFileTypes: true })
  } catch {
    return next
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const automation = await readAutomationRecordFromFile(join(automationRoot, entry.name, 'automation.toml'))
    if (!automation || automation.kind !== 'heartbeat' || !automation.targetThreadId) continue
    next[automation.targetThreadId] = [...(next[automation.targetThreadId] ?? []), automation]
  }

  for (const automations of Object.values(next)) {
    automations.sort((first, second) => {
      const firstCreatedAt = first.createdAtMs ?? 0
      const secondCreatedAt = second.createdAtMs ?? 0
      if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt - secondCreatedAt
      return first.id.localeCompare(second.id)
    })
  }

  return next
}

async function readThreadHeartbeatAutomations(threadId: string): Promise<ThreadAutomationRecord[]> {
  const all = await listThreadHeartbeatAutomations()
  return all[threadId] ?? []
}

async function readThreadHeartbeatAutomation(threadId: string, automationId = ''): Promise<ThreadAutomationRecord | null> {
  const automations = await readThreadHeartbeatAutomations(threadId)
  if (automationId) return automations.find((automation) => automation.id === automationId) ?? null
  return automations[0] ?? null
}

function resolveUniqueAutomationId(existingIds: Set<string>, threadId: string, name: string): string {
  const baseId = slugifyAutomationId(threadId, name)
  if (!existingIds.has(baseId)) return baseId
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}-${index}`
    if (!existingIds.has(candidate)) return candidate
  }
  return `${baseId}-${randomBytes(4).toString('hex')}`
}

async function writeThreadHeartbeatAutomation(input: {
  threadId: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: ThreadAutomationStatus
}): Promise<ThreadAutomationRecord> {
  const threadId = input.threadId.trim()
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  const rrule = input.rrule.trim()
  if (!threadId || !name || !prompt || !rrule) {
    throw new Error('threadId, name, prompt, and rrule are required')
  }

  const automationRoot = getCodexAutomationsDir()
  await mkdir(automationRoot, { recursive: true })
  const existing = input.id ? await readThreadHeartbeatAutomation(threadId, input.id.trim()) : null
  const entries = await readdir(automationRoot, { withFileTypes: true }).catch(() => [])
  const existingIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  const id = existing?.id ?? resolveUniqueAutomationId(existingIds, threadId, name)
  const automationDir = join(automationRoot, id)
  const now = Date.now()
  const record: ThreadAutomationRecord = {
    id,
    kind: 'heartbeat',
    name,
    prompt,
    rrule,
    status: input.status,
    targetThreadId: threadId,
    cwds: [],
    extraTomlLines: existing?.extraTomlLines ?? [],
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    nextRunAtMs: null,
  }

  await mkdir(automationDir, { recursive: true })
  await writeFile(join(automationDir, 'automation.toml'), serializeAutomationToml(record), 'utf8')
  const memoryPath = join(automationDir, 'memory.md')
  try {
    await stat(memoryPath)
  } catch {
    await writeFile(memoryPath, '', 'utf8')
  }
  return record
}

async function deleteThreadHeartbeatAutomation(threadId: string, automationId = ''): Promise<boolean> {
  const normalizedThreadId = threadId.trim()
  const normalizedAutomationId = automationId.trim()
  if (normalizedAutomationId) {
    const automation = await readThreadHeartbeatAutomation(normalizedThreadId, normalizedAutomationId)
    if (!automation) return false
    await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
    return true
  }

  const automations = await readThreadHeartbeatAutomations(normalizedThreadId)
  if (automations.length === 0) return false
  await Promise.all(automations.map((automation) => rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })))
  return true
}

async function listProjectCronAutomations(): Promise<Record<string, ThreadAutomationRecord[]>> {
  const automationRoot = getCodexAutomationsDir()
  const next: Record<string, ThreadAutomationRecord[]> = {}
  let entries
  try {
    entries = await readdir(automationRoot, { withFileTypes: true })
  } catch {
    return next
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const automation = await readAutomationRecordFromFile(join(automationRoot, entry.name, 'automation.toml'))
    if (!automation || automation.kind !== 'cron' || automation.cwds.length === 0) continue
    for (const cwd of automation.cwds) {
      next[cwd] = [...(next[cwd] ?? []), automation]
    }
  }

  for (const automations of Object.values(next)) {
    automations.sort((first, second) => {
      const firstCreatedAt = first.createdAtMs ?? 0
      const secondCreatedAt = second.createdAtMs ?? 0
      if (firstCreatedAt !== secondCreatedAt) return firstCreatedAt - secondCreatedAt
      return first.id.localeCompare(second.id)
    })
  }

  return next
}

async function readProjectCronAutomations(projectName: string): Promise<ThreadAutomationRecord[]> {
  const all = await listProjectCronAutomations()
  return all[projectName] ?? []
}

async function readProjectCronAutomation(projectName: string, automationId = ''): Promise<ThreadAutomationRecord | null> {
  const automations = await readProjectCronAutomations(projectName)
  if (automationId) return automations.find((automation) => automation.id === automationId) ?? null
  return automations[0] ?? null
}

async function writeProjectCronAutomation(input: {
  projectName: string
  id?: string
  name: string
  prompt: string
  rrule: string
  status: ThreadAutomationStatus
}): Promise<ThreadAutomationRecord> {
  const projectName = input.projectName.trim()
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  const rrule = input.rrule.trim()
  if (!projectName || !name || !prompt || !rrule) {
    throw new Error('projectName, name, prompt, and rrule are required')
  }
  if (!isAbsoluteLikePath(projectName)) {
    throw new Error('Project automation cwd must be an absolute path')
  }

  const automationRoot = getCodexAutomationsDir()
  await mkdir(automationRoot, { recursive: true })
  const existing = input.id ? await readProjectCronAutomation(projectName, input.id.trim()) : null
  const entries = await readdir(automationRoot, { withFileTypes: true }).catch(() => [])
  const existingIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  const id = existing?.id ?? resolveUniqueAutomationId(existingIds, projectName, name)
  const automationDir = join(automationRoot, id)
  const now = Date.now()
  const record: ThreadAutomationRecord = {
    id,
    kind: 'cron',
    name,
    prompt,
    rrule,
    status: input.status,
    targetThreadId: null,
    cwds: Array.from(new Set([...(existing?.cwds ?? []), projectName])),
    extraTomlLines: existing?.extraTomlLines ?? [],
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    nextRunAtMs: null,
  }

  await mkdir(automationDir, { recursive: true })
  await writeFile(join(automationDir, 'automation.toml'), serializeAutomationToml(record), 'utf8')
  const memoryPath = join(automationDir, 'memory.md')
  try {
    await stat(memoryPath)
  } catch {
    await writeFile(memoryPath, '', 'utf8')
  }
  return record
}

async function deleteProjectCronAutomation(projectName: string, automationId = ''): Promise<boolean> {
  const normalizedProjectName = projectName.trim()
  const normalizedAutomationId = automationId.trim()
  if (!normalizedProjectName || !isAbsoluteLikePath(normalizedProjectName)) return false
  if (normalizedAutomationId) {
    const automation = await readProjectCronAutomation(normalizedProjectName, normalizedAutomationId)
    if (!automation) return false
    const remainingCwds = automation.cwds.filter((cwd) => cwd !== normalizedProjectName)
    if (remainingCwds.length > 0) {
      const record = { ...automation, cwds: remainingCwds, updatedAtMs: Date.now() }
      await writeFile(join(getCodexAutomationsDir(), automation.id, 'automation.toml'), serializeAutomationToml(record), 'utf8')
    } else {
      await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
    }
    return true
  }

  const automations = await readProjectCronAutomations(normalizedProjectName)
  if (automations.length === 0) return false
  await Promise.all(automations.map(async (automation) => {
    const remainingCwds = automation.cwds.filter((cwd) => cwd !== normalizedProjectName)
    if (remainingCwds.length > 0) {
      const record = { ...automation, cwds: remainingCwds, updatedAtMs: Date.now() }
      await writeFile(join(getCodexAutomationsDir(), automation.id, 'automation.toml'), serializeAutomationToml(record), 'utf8')
      return
    }
    await rm(join(getCodexAutomationsDir(), automation.id), { recursive: true, force: true })
  }))
  return true
}

type ThreadTitleCache = { titles: Record<string, string>; order: string[] }
const MAX_THREAD_TITLES = 500
const EMPTY_THREAD_TITLE_CACHE: ThreadTitleCache = { titles: {}, order: [] }
const PINNED_THREAD_IDS_KEY = 'pinned-thread-ids'

type SessionIndexThreadTitleCacheState = {
  fileSignature: string | null
  cache: ThreadTitleCache
}

let sessionIndexThreadTitleCacheState: SessionIndexThreadTitleCacheState = {
  fileSignature: null,
  cache: EMPTY_THREAD_TITLE_CACHE,
}

type TelegramBridgeConfigState = {
  botToken: string
  chatIds: number[]
  allowedUserIds: Array<number | '*'>
}

function normalizeThreadTitleCache(value: unknown): ThreadTitleCache {
  const record = asRecord(value)
  if (!record) return EMPTY_THREAD_TITLE_CACHE
  const rawTitles = asRecord(record.titles)
  const titles: Record<string, string> = {}
  if (rawTitles) {
    for (const [k, v] of Object.entries(rawTitles)) {
      if (typeof v === 'string' && v.length > 0) titles[k] = v
    }
  }
  const order = normalizeStringArray(record.order)
  return { titles, order }
}

function normalizePinnedThreadIds(value: unknown): string[] {
  return normalizeStringArray(value)
}

function updateThreadTitleCache(cache: ThreadTitleCache, id: string, title: string): ThreadTitleCache {
  const titles = { ...cache.titles, [id]: title }
  const order = [id, ...cache.order.filter((o) => o !== id)]
  while (order.length > MAX_THREAD_TITLES) {
    const removed = order.pop()
    if (removed) delete titles[removed]
  }
  return { titles, order }
}

function removeFromThreadTitleCache(cache: ThreadTitleCache, id: string): ThreadTitleCache {
  const { [id]: _, ...titles } = cache.titles
  return { titles, order: cache.order.filter((o) => o !== id) }
}

type SessionIndexThreadTitle = {
  id: string
  title: string
  updatedAtMs: number
}

function normalizeSessionIndexThreadTitle(value: unknown): SessionIndexThreadTitle | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.thread_name === 'string' ? record.thread_name.trim() : ''
  const updatedAtIso = typeof record.updated_at === 'string' ? record.updated_at.trim() : ''
  const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : Number.NaN

  if (!id || !title) return null
  return {
    id,
    title,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
  }
}

function trimThreadTitleCache(cache: ThreadTitleCache): ThreadTitleCache {
  const titles = { ...cache.titles }
  const order = cache.order.filter((id) => {
    if (!titles[id]) return false
    return true
  }).slice(0, MAX_THREAD_TITLES)

  for (const id of Object.keys(titles)) {
    if (!order.includes(id)) {
      delete titles[id]
    }
  }

  return { titles, order }
}

function mergeThreadTitleCaches(base: ThreadTitleCache, overlay: ThreadTitleCache): ThreadTitleCache {
  const titles = { ...base.titles, ...overlay.titles }
  const order: string[] = []

  for (const id of [...overlay.order, ...base.order]) {
    if (!titles[id] || order.includes(id)) continue
    order.push(id)
  }

  for (const id of Object.keys(titles)) {
    if (!order.includes(id)) {
      order.push(id)
    }
  }

  return trimThreadTitleCache({ titles, order })
}

async function readThreadTitleCache(): Promise<ThreadTitleCache> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizeThreadTitleCache(payload['thread-titles'])
  } catch {
    return EMPTY_THREAD_TITLE_CACHE
  }
}

async function writeThreadTitleCache(cache: ThreadTitleCache): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  payload['thread-titles'] = cache
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function readPinnedThreadIds(): Promise<string[]> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizePinnedThreadIds(payload[PINNED_THREAD_IDS_KEY])
  } catch {
    return []
  }
}

async function writePinnedThreadIds(threadIds: string[]): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  payload[PINNED_THREAD_IDS_KEY] = normalizePinnedThreadIds(threadIds)
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function readPinnedThreadMetadata(threadIds: string[]): Promise<UiThread[]> {
  if (threadIds.length === 0) return []
  const [titleCache, lineageEntries] = await Promise.all([
    readMergedThreadTitleCache(),
    getSessionForkLineage(),
  ])
  const lineageByThreadId = new Map(lineageEntries.map((entry) => [entry.threadId, entry]))
  const includedThreadIds = new Set(threadIds)
  let changed = true
  while (changed) {
    changed = false
    for (const lineage of lineageEntries) {
      if (lineage.isArchived || includedThreadIds.has(lineage.threadId)) continue
      const parentThreadId = lineage.isPaginated && lineage.historyBaseThreadId
        ? lineage.historyBaseThreadId
        : lineage.forkedFromId
      if (!parentThreadId || !includedThreadIds.has(parentThreadId)) continue
      includedThreadIds.add(lineage.threadId)
      changed = true
    }
  }

  return Array.from(includedThreadIds).flatMap((threadId) => {
    const lineage = lineageByThreadId.get(threadId)
    if (!lineage || lineage.isArchived) return []
    const title = titleCache.titles[threadId]?.trim() || 'Untitled thread'
    const normalizedCwd = lineage.cwd.trim()
    const comparableCwd = normalizedCwd.replace(/\\/gu, '/').toLowerCase()
    return [{
      id: threadId,
      title,
      projectName: toProjectName(normalizedCwd),
      cwd: normalizedCwd,
      hasWorktree: comparableCwd.includes('/.codex/worktrees/') || comparableCwd.includes('/.git/worktrees/'),
      createdAtIso: '',
      updatedAtIso: '',
      preview: title,
      forkedFromId: lineage.forkedFromId || undefined,
      forkPointOrdinal: lineage.forkPointOrdinal,
      forkPointByteOffset: lineage.forkPointByteOffset,
      unread: false,
      inProgress: false,
    } satisfies UiThread]
  })
}

const FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY = 'first-launch-plugins-card-dismissed'
const THREAD_QUEUE_STATE_KEY = 'thread-queue-state'
const INTENTIONAL_INTERRUPT_TURN_IDS_KEY = 'intentional-interrupt-turn-ids'
const INTENTIONAL_INTERRUPT_THREAD_IDS_KEY = 'intentional-interrupt-thread-ids'
const MAX_INTENTIONAL_INTERRUPT_TURN_IDS = 500

type StoredQueuedMessage = {
  id: string
  text: string
  imageUrls: string[]
  skills: Array<{ name: string; path: string }>
  fileAttachments: Array<{ label: string; path: string; fsPath: string }>
  collaborationMode: 'default' | 'plan'
  model: string
  modelProvider: string
  reasoningEffort: ReasoningEffort | ''
  modelSelectionOverride: boolean
}

type ThreadQueueState = Record<string, StoredQueuedMessage[]>

type BackendQueuedTurn = {
  threadId: string
  message: StoredQueuedMessage
}

type ThreadQueueStateUpdate<T> = {
  nextState: ThreadQueueState
  result: T
}

type ResolvedCollaborationModeSettings = {
  model: string
  reasoningEffort: ReasoningEffort | null
}

function normalizeStoredQueuedMessage(value: unknown): StoredQueuedMessage | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null

  const normalizeNamedPathItems = (items: unknown): Array<{ name: string; path: string }> => {
    if (!Array.isArray(items)) return []
    return items.flatMap((item) => {
      const itemRecord = asRecord(item)
      if (!itemRecord) return []
      const name = typeof itemRecord.name === 'string' ? itemRecord.name.trim() : ''
      const path = typeof itemRecord.path === 'string' ? itemRecord.path.trim() : ''
      return name && path ? [{ name, path }] : []
    })
  }

  const normalizeFileAttachments = (items: unknown): Array<{ label: string; path: string; fsPath: string }> => {
    if (!Array.isArray(items)) return []
    return items.flatMap((item) => {
      const itemRecord = asRecord(item)
      if (!itemRecord) return []
      const label = typeof itemRecord.label === 'string' ? itemRecord.label.trim() : ''
      const path = typeof itemRecord.path === 'string' ? itemRecord.path.trim() : ''
      const fsPath = typeof itemRecord.fsPath === 'string' ? itemRecord.fsPath.trim() : ''
      return label && path && fsPath ? [{ label, path, fsPath }] : []
    })
  }

  return {
    id,
    text: typeof record.text === 'string' ? record.text : '',
    imageUrls: normalizeStringArray(record.imageUrls),
    skills: normalizeNamedPathItems(record.skills),
    fileAttachments: normalizeFileAttachments(record.fileAttachments),
    collaborationMode: record.collaborationMode === 'plan' ? 'plan' : 'default',
    model: readNonEmptyString(record.model),
    modelProvider: readNonEmptyString(record.modelProvider) || readNonEmptyString(record.model_provider),
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort ?? record.reasoning_effort),
    modelSelectionOverride: record.modelSelectionOverride === true || record.model_selection_override === true,
  }
}

function normalizeThreadQueueState(value: unknown): ThreadQueueState {
  const record = asRecord(value)
  if (!record) return {}

  const state: ThreadQueueState = {}
  for (const [threadId, rawMessages] of Object.entries(record)) {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || !Array.isArray(rawMessages)) continue
    const messages = rawMessages.flatMap((item) => {
      const message = normalizeStoredQueuedMessage(item)
      return message ? [message] : []
    })
    if (messages.length > 0) {
      state[normalizedThreadId] = messages
    }
  }
  return state
}

function normalizeIntentionalInterruptTurnIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (id && !ids.includes(id)) {
      ids.push(id)
    }
  }
  return ids.slice(-MAX_INTENTIONAL_INTERRUPT_TURN_IDS)
}

let threadQueueMutationChain: Promise<unknown> = Promise.resolve()

async function readThreadQueueState(): Promise<ThreadQueueState> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizeThreadQueueState(payload[THREAD_QUEUE_STATE_KEY])
  } catch {
    return {}
  }
}

async function readIntentionalInterruptTurnIds(): Promise<Set<string>> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return new Set(normalizeIntentionalInterruptTurnIds(payload[INTENTIONAL_INTERRUPT_TURN_IDS_KEY]))
  } catch {
    return new Set()
  }
}

async function readIntentionalInterruptThreadIds(): Promise<Set<string>> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return new Set(normalizeIntentionalInterruptTurnIds(payload[INTENTIONAL_INTERRUPT_THREAD_IDS_KEY]))
  } catch {
    return new Set()
  }
}

async function rememberIntentionalInterrupt(threadId: string, turnId: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId.trim()
  if (!normalizedThreadId || !normalizedTurnId) return

  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  const ids = normalizeIntentionalInterruptTurnIds(payload[INTENTIONAL_INTERRUPT_TURN_IDS_KEY])
  const nextIds = ids.filter((id) => id !== normalizedTurnId)
  nextIds.push(normalizedTurnId)
  payload[INTENTIONAL_INTERRUPT_TURN_IDS_KEY] = nextIds.slice(-MAX_INTENTIONAL_INTERRUPT_TURN_IDS)

  const threadIds = normalizeIntentionalInterruptTurnIds(payload[INTENTIONAL_INTERRUPT_THREAD_IDS_KEY])
  const nextThreadIds = threadIds.filter((id) => id !== normalizedThreadId)
  nextThreadIds.push(normalizedThreadId)
  payload[INTENTIONAL_INTERRUPT_THREAD_IDS_KEY] = nextThreadIds.slice(-MAX_INTENTIONAL_INTERRUPT_TURN_IDS)
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function forgetIntentionalInterruptThreadId(threadId: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return

  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  const threadIds = normalizeIntentionalInterruptTurnIds(payload[INTENTIONAL_INTERRUPT_THREAD_IDS_KEY])
  const nextThreadIds = threadIds.filter((id) => id !== normalizedThreadId)
  if (nextThreadIds.length > 0) {
    payload[INTENTIONAL_INTERRUPT_THREAD_IDS_KEY] = nextThreadIds
  } else {
    delete payload[INTENTIONAL_INTERRUPT_THREAD_IDS_KEY]
  }
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function writeThreadQueueStateUnlocked(nextState: ThreadQueueState): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  const normalized = normalizeThreadQueueState(nextState)
  if (Object.keys(normalized).length > 0) {
    payload[THREAD_QUEUE_STATE_KEY] = normalized
  } else {
    delete payload[THREAD_QUEUE_STATE_KEY]
  }
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function withThreadQueueStateUpdate<T>(
  update: (state: ThreadQueueState) => ThreadQueueStateUpdate<T> | Promise<ThreadQueueStateUpdate<T>>,
): Promise<T> {
  const run = threadQueueMutationChain.then(async () => {
    const currentState = await readThreadQueueState()
    const { nextState, result } = await update(currentState)
    await writeThreadQueueStateUnlocked(nextState)
    return result
  })
  threadQueueMutationChain = run.catch(() => {})
  return run
}

async function writeThreadQueueState(nextState: ThreadQueueState): Promise<void> {
  await withThreadQueueStateUpdate(() => ({
    nextState: normalizeThreadQueueState(nextState),
    result: undefined,
  }))
}

async function appendThreadQueuedMessage(threadId: string, message: StoredQueuedMessage): Promise<void> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) throw new Error('threadId is required')
  await withThreadQueueStateUpdate((state) => ({
    nextState: {
      ...state,
      [normalizedThreadId]: [...(state[normalizedThreadId] ?? []), message],
    },
    result: undefined,
  }))
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  const allowed: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  return typeof value === 'string' && allowed.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : ''
}

function normalizeCollaborationModeReasoningEffort(value: ReasoningEffort | '' | null | undefined): ReasoningEffort | null {
  return value && value.length > 0 ? value : null
}

function readThreadResultModelState(result: unknown): SessionRecoveredModelState {
  const record = asRecord(result)
  const thread = asRecord(record?.thread)
  return {
    model: (readNonEmptyString(record?.model) || readNonEmptyString(thread?.model)).trim(),
    modelProvider: (readNonEmptyString(record?.modelProvider)
      || readNonEmptyString(record?.model_provider)
      || readNonEmptyString(thread?.modelProvider)
      || readNonEmptyString(thread?.model_provider)).trim(),
    reasoningEffort: normalizeReasoningEffort(
      record?.reasoningEffort
      ?? record?.reasoning_effort
      ?? thread?.reasoningEffort
      ?? thread?.reasoning_effort,
    ),
  }
}

function extractLocalImagePathFromUrl(value: string): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value, 'http://localhost')
    if (parsed.pathname !== '/codex-local-image') return null
    const path = parsed.searchParams.get('path')?.trim() ?? ''
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

function buildTextWithAttachments(prompt: string, files: StoredQueuedMessage['fileAttachments']): string {
  if (files.length === 0) return prompt
  let prefix = '# Files mentioned by the user:\n'
  for (const f of files) {
    prefix += `\n## ${f.label}: ${f.path}\n`
  }
  return `${prefix}\n## My request for Codex:\n\n${prompt}\n`
}

function escapeHeartbeatXmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

function buildHeartbeatQueuedMessage(automation: ThreadAutomationRecord): StoredQueuedMessage {
  return {
    id: `automation-${automation.id}-${Date.now()}-${randomBytes(3).toString('hex')}`,
    text: `<heartbeat>
<automation_id>${escapeHeartbeatXmlText(automation.id)}</automation_id>
<current_time_iso>${new Date().toISOString()}</current_time_iso>
<instructions>
${escapeHeartbeatXmlText(automation.prompt)}
</instructions>
</heartbeat>`,
    imageUrls: [],
    skills: [],
    fileAttachments: [],
    collaborationMode: 'default',
    model: '',
    modelProvider: '',
    reasoningEffort: '',
    modelSelectionOverride: false,
  }
}

function fileNameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) ?? normalized
}

function extractThreadIdFromNotificationParams(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  const threadId =
    (typeof record.threadId === 'string' ? record.threadId : '') ||
    (typeof record.thread_id === 'string' ? record.thread_id : '') ||
    (typeof record.conversationId === 'string' ? record.conversationId : '') ||
    (typeof record.conversation_id === 'string' ? record.conversation_id : '')
  if (threadId) return threadId
  const thread = asRecord(record.thread)
  if (thread && typeof thread.id === 'string') return thread.id
  const turn = asRecord(record.turn)
  if (turn) {
    const turnThreadId =
      (typeof turn.threadId === 'string' ? turn.threadId : '') ||
      (typeof turn.thread_id === 'string' ? turn.thread_id : '')
    if (turnThreadId) return turnThreadId
  }
  return ''
}

function extractTurnIdFromNotificationParams(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  const directTurnId = readNonEmptyString(record.turnId) || readNonEmptyString(record.turn_id)
  if (directTurnId) return directTurnId
  return readNonEmptyString(asRecord(record.turn)?.id)
}

function isTurnCompletedNotification(notification: { method: string; params: unknown }): boolean {
  return notification.method === 'turn/completed'
}

function isContextWindowExceededErrorInfo(value: unknown): boolean {
  if (value === 'contextWindowExceeded' || value === 'context_window_exceeded') return true
  const record = asRecord(value)
  return Boolean(record?.contextWindowExceeded || record?.context_window_exceeded)
}

function isContextWindowExceededMessage(value: string): boolean {
  const normalized = value.toLowerCase()
  if (!normalized) return false
  return (
    /context\s+(window|length).*exceed/u.test(normalized) ||
    /exceed.*context\s+(window|length)/u.test(normalized) ||
    /maximum\s+context/u.test(normalized) ||
    /too\s+many\s+tokens/u.test(normalized) ||
    /token\s+limit/u.test(normalized)
  )
}

function readContextWindowExceededTurn(notification: { method: string; params: unknown }): { threadId: string; turnId: string } | null {
  if (!isTurnCompletedNotification(notification)) return null
  const params = asRecord(notification.params)
  if (!params) return null

  const turn = asRecord(params.turn)
  if (readProtocolToken(turn?.status) !== 'failed') return null

  const errorPayload = asRecord(turn?.error)
  const codexErrorInfo = errorPayload?.codexErrorInfo ?? errorPayload?.codex_error_info
  const message = readNonEmptyString(errorPayload?.message)
    || readNonEmptyString(errorPayload?.additionalDetails)
    || readNonEmptyString(errorPayload?.additional_details)

  if (!isContextWindowExceededErrorInfo(codexErrorInfo) && !isContextWindowExceededMessage(message)) {
    return null
  }

  const threadId = extractThreadIdFromNotificationParams(params)
  const turnId = readNonEmptyString(turn?.id) || readNonEmptyString(params.turnId) || readNonEmptyString(params.turn_id)
  if (!threadId || !turnId) return null
  return { threadId, turnId }
}

async function readFirstLaunchPluginsCardDismissed(): Promise<boolean> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return payload[FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY] === true
  } catch {
    return false
  }
}

async function writeFirstLaunchPluginsCardDismissed(dismissed: boolean): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  payload[FIRST_LAUNCH_PLUGINS_CARD_DISMISSED_KEY] = dismissed === true
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

function getSessionIndexFileSignature(stats: { mtimeMs: number; size: number }): string {
  return `${String(stats.mtimeMs)}:${String(stats.size)}`
}

async function parseThreadTitlesFromSessionIndex(sessionIndexPath: string): Promise<ThreadTitleCache> {
  const latestById = new Map<string, SessionIndexThreadTitle>()
  const input = createReadStream(sessionIndexPath, { encoding: 'utf8' })
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const entry = normalizeSessionIndexThreadTitle(JSON.parse(trimmed) as unknown)
        if (!entry) continue

        const previous = latestById.get(entry.id)
        if (!previous || entry.updatedAtMs >= previous.updatedAtMs) {
          latestById.set(entry.id, entry)
        }
      } catch {
        // Skip malformed lines and keep scanning the rest of the index.
      }
    }
  } finally {
    lines.close()
    input.close()
  }

  const entries = Array.from(latestById.values()).sort((first, second) => second.updatedAtMs - first.updatedAtMs)
  const titles: Record<string, string> = {}
  const order: string[] = []
  for (const entry of entries) {
    titles[entry.id] = entry.title
    order.push(entry.id)
  }

  return trimThreadTitleCache({ titles, order })
}

async function readThreadTitlesFromSessionIndex(): Promise<ThreadTitleCache> {
  const sessionIndexPath = getCodexSessionIndexPath()

  try {
    const stats = await stat(sessionIndexPath)
    const fileSignature = getSessionIndexFileSignature(stats)
    if (sessionIndexThreadTitleCacheState.fileSignature === fileSignature) {
      return sessionIndexThreadTitleCacheState.cache
    }

    const cache = await parseThreadTitlesFromSessionIndex(sessionIndexPath)
    sessionIndexThreadTitleCacheState = { fileSignature, cache }
    return cache
  } catch {
    sessionIndexThreadTitleCacheState = {
      fileSignature: 'missing',
      cache: EMPTY_THREAD_TITLE_CACHE,
    }
    return sessionIndexThreadTitleCacheState.cache
  }
}

async function readMergedThreadTitleCache(): Promise<ThreadTitleCache> {
  const [sessionIndexCache, persistedCache] = await Promise.all([
    readThreadTitlesFromSessionIndex(),
    readThreadTitleCache(),
  ])
  return mergeThreadTitleCaches(persistedCache, sessionIndexCache)
}

async function readWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}

  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    payload = asRecord(parsed) ?? {}
  } catch {
    payload = {}
  }

  return {
    order: normalizeStringArray(payload['electron-saved-workspace-roots']),
    labels: normalizeStringRecord(payload['electron-workspace-root-labels']),
    active: normalizeStringArray(payload['active-workspace-roots']),
    projectOrder: normalizeStringArray(payload['project-order']),
    remoteProjects: normalizeRemoteProjects(payload['remote-projects']),
  }
}

async function writeWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  payload['electron-saved-workspace-roots'] = normalizeStringArray(nextState.order)
  payload['electron-workspace-root-labels'] = normalizeStringRecord(nextState.labels)
  payload['active-workspace-roots'] = normalizeStringArray(nextState.active)
  payload['project-order'] = normalizeStringArray(nextState.projectOrder)

  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

let workspaceRootsMutation: Promise<void> = Promise.resolve()

function queueWorkspaceRootsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const run = workspaceRootsMutation.catch(() => undefined).then(mutation)
  workspaceRootsMutation = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function prependUniqueString(value: string, items: string[]): string[] {
  return [value, ...items.filter((item) => item !== value)]
}

async function updateWorkspaceRootsState(
  updater: (existingState: WorkspaceRootsState) => WorkspaceRootsState,
): Promise<void> {
  await queueWorkspaceRootsMutation(async () => {
    const existingState = await readWorkspaceRootsState()
    await writeWorkspaceRootsState(updater(existingState))
  })
}

async function persistWorkspaceRoot(workspaceRoot: string, label = ''): Promise<void> {
  const normalizedRoot = workspaceRoot.trim()
  if (!normalizedRoot) return

  await updateWorkspaceRootsState((existingState) => {
    const nextLabels = { ...existingState.labels }
    const trimmedLabel = label.trim()
    if (trimmedLabel.length > 0) {
      nextLabels[normalizedRoot] = trimmedLabel
    }
    return {
      order: prependUniqueString(normalizedRoot, existingState.order),
      labels: nextLabels,
      active: prependUniqueString(normalizedRoot, existingState.active),
      projectOrder: prependUniqueString(normalizedRoot, existingState.projectOrder),
      remoteProjects: existingState.remoteProjects,
    }
  })
}

function stripPathLineReference(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const hashLineMatch = trimmed.match(/^(.*)#L\d+(?:-L?\d+)?(?:C\d+)?$/u)
  if (hashLineMatch) return (hashLineMatch[1] ?? '').trim()
  const colonLineMatch = trimmed.match(/^(.*):\d+(?:-\d+)?(?::\d+)?$/u)
  if (colonLineMatch) return (colonLineMatch[1] ?? '').trim()
  return trimmed
}

function normalizeLocalPathInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

async function normalizeExistingDirectoryRoots(rawRoots: readonly string[], maxRoots: number): Promise<string[]> {
  const roots: string[] = []
  const seen = new Set<string>()
  for (const rawRoot of rawRoots) {
    const trimmed = rawRoot.trim()
    if (!trimmed) continue
    const root = normalizeLocalPathInput(trimmed)
    if (seen.has(root)) continue
    seen.add(root)
    try {
      const rootInfo = await stat(root)
      if (!rootInfo.isDirectory()) continue
    } catch {
      continue
    }
    roots.push(root)
    if (roots.length >= maxRoots) break
  }
  return roots
}

async function searchFileLinkPathCandidates(
  cwd: string,
  query: string,
  limit: number,
): Promise<Array<{ path: string; absolutePath: string; root: string; kind: 'file' | 'directory'; isSymlink: boolean }>> {
  const trimmedQuery = stripPathLineReference(query)
  if (!trimmedQuery) return []

  const maxResults = Math.max(1, Math.min(50, Math.floor(limit)))
  const results: Array<{ path: string; absolutePath: string; root: string; kind: 'file' | 'directory'; isSymlink: boolean }> = []
  const seen = new Set<string>()

  if (isAbsolute(trimmedQuery)) {
    try {
      const info = await stat(trimmedQuery)
      results.push({
        path: trimmedQuery,
        absolutePath: trimmedQuery,
        root: dirname(trimmedQuery),
        kind: info.isDirectory() ? 'directory' : 'file',
        isSymlink: false,
      })
      seen.add(trimmedQuery)
    } catch {
      // Keep searching workspace roots below.
    }
  }

  const workspaceState = await readWorkspaceRootsState()
  const roots = await normalizeExistingDirectoryRoots([
    cwd,
    ...workspaceState.active,
    ...workspaceState.order,
  ], 8)
  const perRootLimit = Math.max(5, Math.ceil(maxResults / Math.max(roots.length, 1)))

  for (const root of roots) {
    if (results.length >= maxResults) break
    let rows: Awaited<ReturnType<typeof searchComposerPaths>>
    try {
      rows = await searchComposerPaths(root, trimmedQuery, perRootLimit)
    } catch {
      continue
    }
    for (const row of rows) {
      const absolutePath = isAbsolute(row.path) ? row.path : resolve(root, row.path)
      if (seen.has(absolutePath)) continue
      seen.add(absolutePath)
      results.push({
        path: row.path,
        absolutePath,
        root,
        kind: row.kind,
        isSymlink: row.isSymlink,
      })
      if (results.length >= maxResults) break
    }
  }

  return results
}

async function rollbackCreatedWorktree(
  gitRoot: string,
  worktreeCwd: string,
  cleanupDirectory?: string,
  branchName?: string,
): Promise<void> {
  try {
    await runCommand('git', ['worktree', 'remove', '--force', worktreeCwd], { cwd: gitRoot })
  } catch {
    await rm(worktreeCwd, { recursive: true, force: true }).catch(() => undefined)
  }

  if (cleanupDirectory && cleanupDirectory !== worktreeCwd) {
    await rm(cleanupDirectory, { recursive: true, force: true }).catch(() => undefined)
  }

  if (branchName) {
    await runCommand('git', ['branch', '-D', branchName], { cwd: gitRoot }).catch(() => undefined)
  }
}

function normalizeTelegramBridgeConfig(value: unknown): TelegramBridgeConfigState {
  const record = asRecord(value)
  if (!record) return { botToken: '', chatIds: [], allowedUserIds: [] }
  const botToken = typeof record.botToken === 'string' ? record.botToken.trim() : ''
  const rawChatIds = Array.isArray(record.chatIds) ? record.chatIds : []
  const chatIds = Array.from(new Set(rawChatIds
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.trunc(value)))).slice(0, 50)
  const rawAllowedUserIds = Array.isArray(record.allowedUserIds) ? record.allowedUserIds : []
  const allowAllUsers = rawAllowedUserIds.some((value) => typeof value === 'string' && value.trim() === '*')
  const normalizedAllowedUserIds = Array.from(new Set(rawAllowedUserIds
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
      if (typeof value === 'string') {
        const normalized = value.trim().replace(/^(telegram|tg):/i, '').trim()
        if (/^-?\d+$/.test(normalized)) {
          return Number.parseInt(normalized, 10)
        }
      }
      return Number.NaN
    })
    .filter((value) => Number.isFinite(value)))).slice(0, 100)
  const allowedUserIds: Array<number | '*'> = allowAllUsers
    ? ['*' as const, ...normalizedAllowedUserIds]
    : normalizedAllowedUserIds
  return { botToken, chatIds, allowedUserIds }
}

async function readTelegramBridgeConfig(): Promise<TelegramBridgeConfigState> {
  const telegramConfigPath = getTelegramBridgeConfigPath()
  try {
    const raw = await readFile(telegramConfigPath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizeTelegramBridgeConfig(payload)
  } catch {
    return { botToken: '', chatIds: [], allowedUserIds: [] }
  }
}

async function writeTelegramBridgeConfig(nextState: TelegramBridgeConfigState): Promise<void> {
  const normalized = normalizeTelegramBridgeConfig(nextState)
  const telegramConfigPath = getTelegramBridgeConfigPath()
  await writeFile(telegramConfigPath, JSON.stringify({
    botToken: normalized.botToken,
    chatIds: normalized.chatIds,
    allowedUserIds: normalized.allowedUserIds,
  }), 'utf8')
}

let telegramBridgeConfigMutation: Promise<void> = Promise.resolve()

function rememberTelegramChatId(chatId: number): Promise<void> {
  const normalizedChatId = Math.trunc(chatId)
  if (!Number.isFinite(normalizedChatId)) return Promise.resolve()

  telegramBridgeConfigMutation = telegramBridgeConfigMutation.then(async () => {
    const current = await readTelegramBridgeConfig()
    if (current.chatIds.includes(normalizedChatId)) return
    const next = {
      ...current,
      chatIds: [normalizedChatId, ...current.chatIds].slice(0, 50),
    }
    await writeTelegramBridgeConfig(next)
  })
  return telegramBridgeConfigMutation
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return null
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function bufferIndexOf(buf: Buffer, needle: Buffer, start = 0): number {
  for (let i = start; i <= buf.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

function handleFileUpload(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = contentType.match(/boundary=(.+)/i)
      if (!boundaryMatch) { setJson(res, 400, { error: 'Missing multipart boundary' }); return }
      const boundary = boundaryMatch[1]
      const boundaryBuf = Buffer.from(`--${boundary}`)
      const parts: Buffer[] = []
      let searchStart = 0
      while (searchStart < body.length) {
        const idx = body.indexOf(boundaryBuf, searchStart)
        if (idx < 0) break
        if (searchStart > 0) parts.push(body.subarray(searchStart, idx))
        searchStart = idx + boundaryBuf.length
        if (body[searchStart] === 0x0d && body[searchStart + 1] === 0x0a) searchStart += 2
      }
      let fileName = 'uploaded-file'
      let fileData: Buffer | null = null
      const headerSep = Buffer.from('\r\n\r\n')
      for (const part of parts) {
        const headerEnd = bufferIndexOf(part, headerSep)
        if (headerEnd < 0) continue
        const headers = part.subarray(0, headerEnd).toString('utf8')
        const fnMatch = headers.match(/filename="([^"]+)"/i)
        if (!fnMatch) continue
        fileName = fnMatch[1].replace(/[/\\]/g, '_')
        let end = part.length
        if (end >= 2 && part[end - 2] === 0x0d && part[end - 1] === 0x0a) end -= 2
        fileData = part.subarray(headerEnd + 4, end)
        break
      }
      if (!fileData) { setJson(res, 400, { error: 'No file in request' }); return }
      const uploadDir = join(tmpdir(), 'codex-web-uploads')
      await mkdir(uploadDir, { recursive: true })
      const destDir = await mkdtemp(join(uploadDir, 'f-'))
      const destPath = join(destDir, fileName)
      await writeFile(destPath, fileData)
      setJson(res, 200, { path: destPath })
    } catch (err) {
      setJson(res, 500, { error: getErrorMessage(err, 'Upload failed') })
    }
  })
  req.on('error', (err: Error) => {
    setJson(res, 500, { error: getErrorMessage(err, 'Upload stream error') })
  })
}

function httpPost(
  url: string,
  headers: Record<string, string | number>,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  const doRequest = url.startsWith('http://') ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    const req = doRequest(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

let curlImpersonateAvailable: boolean | null = null

function curlImpersonatePost(
  url: string,
  headers: Record<string, string | number>,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-w', '\n%{http_code}', '-X', 'POST', url]
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'content-length') continue
      args.push('-H', `${k}: ${String(v)}`)
    }
    args.push('--data-binary', '@-')
    const proc = spawn('curl-impersonate-chrome', args, {
      env: { ...process.env, CURL_IMPERSONATE: 'chrome116' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.on('error', (e) => {
      curlImpersonateAvailable = false
      reject(e)
    })
    proc.on('close', (code) => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const lastNewline = raw.lastIndexOf('\n')
      const statusStr = lastNewline >= 0 ? raw.slice(lastNewline + 1).trim() : ''
      const responseBody = lastNewline >= 0 ? raw.slice(0, lastNewline) : raw
      const status = parseInt(statusStr, 10) || (code === 0 ? 200 : 500)
      curlImpersonateAvailable = true
      resolve({ status, body: responseBody })
    })
    proc.stdin.write(body)
    proc.stdin.end()
  })
}

async function proxyTranscribe(
  body: Buffer,
  contentType: string,
  authToken: string,
  accountId?: string,
): Promise<{ status: number; body: string }> {
  const chatgptHeaders: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    Authorization: `Bearer ${authToken}`,
    originator: 'Codex Desktop',
    'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
  }
  if (accountId) chatgptHeaders['ChatGPT-Account-Id'] = accountId

  const postFn = curlImpersonateAvailable !== false ? curlImpersonatePost : httpPost
  let result: { status: number; body: string }
  try {
    result = await postFn('https://chatgpt.com/backend-api/transcribe', chatgptHeaders, body)
  } catch {
    result = await httpPost('https://chatgpt.com/backend-api/transcribe', chatgptHeaders, body)
  }

  if (result.status === 403 && result.body.includes('cf_chl')) {
    if (curlImpersonateAvailable !== false && postFn !== curlImpersonatePost) {
      try {
        const ciResult = await curlImpersonatePost('https://chatgpt.com/backend-api/transcribe', chatgptHeaders, body)
        if (ciResult.status !== 403) return ciResult
      } catch {}
    }
    return { status: 503, body: JSON.stringify({ error: 'Transcription blocked by Cloudflare. Install curl-impersonate-chrome.' }) }
  }

  return result
}

function parseConnectorLogoUrl(rawUrl: string): { connectorId: string; theme: 'light' | 'dark' } | null {
  const trimmed = rawUrl.trim()
  if (!trimmed.startsWith('connectors://')) return null
  const rest = trimmed.slice('connectors://'.length)
  const connectorId = (rest.split(/[/?#]/u)[0] ?? '').trim()
  if (!connectorId) return null
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1).split('#')[0] ?? '' : ''
  const theme = new URLSearchParams(query).get('theme')?.toLowerCase() === 'dark' ? 'dark' : 'light'
  return { connectorId, theme }
}

async function fetchConnectorLogo(rawUrl: string): Promise<{ contentType: string; body: Buffer }> {
  const parsed = parseConnectorLogoUrl(rawUrl)
  if (!parsed) throw new Error('Unsupported connector logo URL')
  const auth = await readCodexAuth()
  if (!auth) throw new Error('No auth token available for connector logo')

  const endpoint = `https://chatgpt.com/backend-api/aip/connectors/${encodeURIComponent(parsed.connectorId)}/logo?theme=${parsed.theme}`
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      originator: 'Codex Desktop',
      'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
      ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Connector logo fetch failed (${response.status})`)

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const payload = asRecord(await response.json())
    const body = asRecord(payload?.body)
    const base64 = readNonEmptyString(body?.base64)
    const nestedContentType = readNonEmptyString(body?.contentType) ?? readNonEmptyString(body?.content_type)
    if (!base64 || !nestedContentType) throw new Error('Connector logo response was missing image data')
    return { contentType: nestedContentType, body: Buffer.from(base64, 'base64') }
  }

  return {
    contentType: contentType || 'image/png',
    body: Buffer.from(await response.arrayBuffer()),
  }
}

const STREAM_EVENT_BUFFER_LIMIT = 400
const APP_SERVER_THREAD_CACHE_LIMIT = 128

type StreamEventFrame = {
  method: string
  params: unknown
  atIso: string
}

type CapturedItem = {
  id: string
  type: string
  turnId: string
  data: Record<string, unknown>
  completed: boolean
}

function extractThreadIdFromParams(params: unknown): string {
  const record = asRecord(params)
  if (!record) return ''
  const threadId =
    (typeof record.threadId === 'string' ? record.threadId : '') ||
    (typeof record.thread_id === 'string' ? record.thread_id : '') ||
    (typeof record.conversationId === 'string' ? record.conversationId : '') ||
    (typeof record.conversation_id === 'string' ? record.conversation_id : '')
  if (threadId) return threadId
  const thread = asRecord(record.thread)
  if (thread && typeof thread.id === 'string') return thread.id
  const turn = asRecord(record.turn)
  if (turn) {
    const turnThreadId =
      (typeof turn.threadId === 'string' ? turn.threadId : '') ||
      (typeof turn.thread_id === 'string' ? turn.thread_id : '')
    if (turnThreadId) return turnThreadId
  }
  return ''
}

const MERGEABLE_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
])

type AppServerConfig = {
  command: string
  args: string[]
  env: Record<string, string>
}

function cloneFreeModeState(state: FreeModeState): FreeModeState {
  return {
    ...state,
    providerKeys: state.providerKeys ? { ...state.providerKeys } : undefined,
  }
}

function hasFreeModeStateChanged(current: FreeModeState, newState: FreeModeState): boolean {
  if (current.enabled !== newState.enabled) return true
  if (current.provider !== newState.provider) return true
  if (current.model !== newState.model) return true
  if (current.wireApi !== newState.wireApi) return true
  if (current.customBaseUrl !== newState.customBaseUrl) return true
  if (!isWrapperProvider(newState.provider) && current.apiKey !== newState.apiKey) return true
  return false
}

function isWrapperProvider(provider: FreeModeState['provider']): boolean {
  return provider === MOONBRIDGE_PROVIDER_ID || provider === ARK_PROVIDER_ID || provider === CURSOR_PROVIDER_ID
}

export function buildAppServerConfigForState(state: FreeModeState): AppServerConfig {
  const args = buildAppServerArgs()
  let extraEnv: Record<string, string> = {}
  const serverPort = parseInt(process.env.CODEXUI_SERVER_PORT ?? '', 10) || undefined
  let command = resolveCodexCommand()
  if (!command) {
    throw new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
  }
  const dynamicProvider = state.enabled ? readCodexUiProviderDescriptor(state.provider) : null
  if (dynamicProvider && (!isWrapperProvider(state.provider) || dynamicProvider.hasUiConfig)) {
    if (dynamicProvider.executable) {
      const resolvedCommand = resolveExecutableCommand(dynamicProvider.executable)
      if (!resolvedCommand) {
        throw new Error(`Provider launcher is not available: ${dynamicProvider.executable}`)
      }
      command = resolvedCommand
    }
    args.push(...buildCodexUiProviderConfigArgs(dynamicProvider, state.model))
  } else if (state.enabled && state.provider === MOONBRIDGE_PROVIDER_ID) {
    command = resolveCodexMoonCommand()
    if (!command) {
      throw new Error('Codex Moon Bridge CLI is not available. Install codex-moon or set CODEXUI_CODEX_MOON_COMMAND.')
    }
  } else if (state.enabled && state.provider === ARK_PROVIDER_ID) {
    command = resolveCodexArkCommand()
    if (!command) {
      throw new Error('Codex Ark CLI is not available. Install codex-ark or set CODEXUI_CODEX_ARK_COMMAND.')
    }
  } else if (state.enabled && state.provider === CURSOR_PROVIDER_ID) {
    command = resolveCodexCursorCommand()
    if (!command) {
      throw new Error('Codex Cursor CLI is not available. Install codex-cursor or set CODEXUI_CODEX_CURSOR_COMMAND.')
    }
  } else {
    args.push(...getFreeModeConfigArgs(state, serverPort))
    extraEnv = getFreeModeEnvVars(state)
  }
  return { command, args, env: extraEnv }
}

function getAppServerRuntimeSignature(state: FreeModeState): string {
  const config = buildAppServerConfigForState(state)
  const envEntries = Object.entries(config.env).sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify({
    command: config.command,
    args: config.args,
    env: envEntries,
  })
}

// A codex app-server is considered unhealthy when it emits this many
// "without active item" stderr errors within the window below. Such errors
// mean codex_core lost track of the active item, so turns end prematurely
// without a final agent message. Once unhealthy and idle, the process is
// restarted so subsequent turns run on a clean runtime.
const UNHEALTHY_STDERR_WINDOW_MS = 30_000
const UNHEALTHY_STDERR_THRESHOLD = 50

class AppServerProcess {
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly streamEventsByThreadId = new Map<string, StreamEventFrame[]>()
  private readonly lastThreadReadSnapshotByThreadId = new Map<string, unknown>()
  private readonly threadTurnPageReadCacheByThreadId = new Map<string, { result: unknown; expiresAt: number }>()
  private readonly threadTurnPageReadPromiseByThreadId = new Map<string, Promise<unknown>>()
  private readonly capturedItemsByThreadId = new Map<string, Map<string, CapturedItem>>()
  private readonly liveStateCache = new Map<string, { data: unknown; turnCount: number; sessionSize: number }>()
  private readonly activeTurnIdByThreadId = new Map<string, string>()
  private chatgptAuthRefreshPromise: Promise<ChatgptAuthTokensRefreshResponse> | null = null
  private freeModeState: FreeModeState = createDefaultFreeModeState()
  private unhealthy = false
  private activeTurnCount = 0
  private recentStderrErrorTimes: number[] = []

  private touchThreadCacheKey<T>(cache: Map<string, T>, threadId: string): T | undefined {
    const value = cache.get(threadId)
    if (value === undefined) return undefined
    cache.delete(threadId)
    cache.set(threadId, value)
    return value
  }

  private setBoundedThreadCache<T>(cache: Map<string, T>, threadId: string, value: T): void {
    cache.delete(threadId)
    cache.set(threadId, value)
    while (cache.size > APP_SERVER_THREAD_CACHE_LIMIT) {
      const oldestThreadId = cache.keys().next().value
      if (!oldestThreadId) break
      cache.delete(oldestThreadId)
    }
  }

  private clearThreadCaches(threadId = ''): void {
    const caches: Array<Map<string, unknown>> = [
      this.streamEventsByThreadId,
      this.lastThreadReadSnapshotByThreadId,
      this.threadTurnPageReadCacheByThreadId,
      this.threadTurnPageReadPromiseByThreadId,
      this.capturedItemsByThreadId,
      this.liveStateCache,
      this.activeTurnIdByThreadId,
    ]
    if (threadId) {
      for (const cache of caches) cache.delete(threadId)
      return
    }
    for (const cache of caches) cache.clear()
  }

  releaseThreadState(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (normalizedThreadId) this.clearThreadCaches(normalizedThreadId)
  }

  hasActiveTurn(threadId: string, turnId: string): boolean {
    return Boolean(threadId && turnId && this.activeTurnIdByThreadId.get(threadId) === turnId)
  }

  getFreeModeState(): FreeModeState {
    return cloneFreeModeState(this.freeModeState)
  }

  setFreeModeState(state: FreeModeState): void {
    this.freeModeState = cloneFreeModeState(state)
  }

  private buildAppServerConfig(): AppServerConfig {
    return buildAppServerConfigForState(this.freeModeState)
  }

  private start(): void {
    if (this.process) return

    this.stopping = false
    const config = this.buildAppServerConfig()
    const invocation = getSpawnInvocation(config.command, config.args)
    const spawnEnv = Object.keys(config.env).length > 0
      ? { ...process.env, ...config.env }
      : undefined
    const proc = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], ...(spawnEnv ? { env: spawnEnv } : {}) })
    this.process = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk

      let lineEnd = this.readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = this.readBuffer.slice(0, lineEnd).trim()
        this.readBuffer = this.readBuffer.slice(lineEnd + 1)

        if (line.length > 0) {
          this.handleLine(line)
        }

        lineEnd = this.readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (!message) return
      writeDebugLog('app-server-stderr', message.slice(0, 4000), {
        pid: proc.pid ?? -1,
      }).catch(() => {})
      if (message.includes('without active item')) {
        const matches = message.match(/without active item/g)
        this.recordStderrHealthSignal(matches ? matches.length : 1)
      }
    })

    proc.on('exit', () => {
      if (this.process !== proc) {
        return
      }

      console.error('[DEBUG:AppServerProcess] codex app-server exited — stopping=%s pid=%d', this.stopping, proc.pid ?? -1)
      writeDebugLog('app-server-exit', 'codex app-server exited', {
        stopping: this.stopping,
        pid: proc.pid ?? -1,
        pendingRequests: this.pending.size,
        pendingServerRequests: this.pendingServerRequests.size,
      }).catch(() => {})
      const failure = new Error(this.stopping ? 'codex app-server stopped' : 'codex app-server exited unexpectedly')
      for (const request of this.pending.values()) {
        request.reject(failure)
      }

      this.pending.clear()
      this.pendingServerRequests.clear()
      this.clearThreadCaches()
      this.activeTurnCount = 0
      this.process = null
      this.initialized = false
      this.initializePromise = null
      this.readBuffer = ''
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('codex app-server is not running')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }

    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id)
      this.pending.delete(message.id)

      if (!pendingRequest) return

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message))
      } else {
        pendingRequest.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && typeof message.id !== 'number') {
      if (message.method.startsWith('turn/') || message.method.startsWith('thread/') || message.method === 'error') {
        console.warn('[DEBUG:AppServerProcess] notification method=%s', message.method)
        writeDebugLog('app-server-notification', message.method, {
          threadId: this.extractThreadIdFromParams(message.params ?? null),
          params: message.method === 'error' ? message.params ?? null : undefined,
        }).catch(() => {})
      }
      this.emitNotification({
        method: message.method,
        params: message.params ?? null,
      })
      return
    }

    // Handle server-initiated JSON-RPC requests (approvals, dynamic tool calls, etc.).
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params ?? null)
    }
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    const sanitizedNotification = sanitizeCursorToolPayloadReferencesInNotification(notification)
    this.recordStreamEvent(sanitizedNotification)
    this.captureItemFromNotification(sanitizedNotification)
    const nThreadId = this.extractThreadIdFromParams(sanitizedNotification.params)
    if (nThreadId) {
      this.invalidateLiveStateCache(nThreadId)
      this.threadTurnPageReadCacheByThreadId.delete(nThreadId)
    }
    if (sanitizedNotification.method === 'turn/started') {
      this.activeTurnCount += 1
      const turnId = extractTurnIdFromNotificationParams(sanitizedNotification.params)
      if (nThreadId && turnId) this.activeTurnIdByThreadId.set(nThreadId, turnId)
    } else if (sanitizedNotification.method === 'turn/completed') {
      this.activeTurnCount = Math.max(0, this.activeTurnCount - 1)
      const turnId = extractTurnIdFromNotificationParams(sanitizedNotification.params)
      if (nThreadId && (!turnId || this.activeTurnIdByThreadId.get(nThreadId) === turnId)) {
        this.activeTurnIdByThreadId.delete(nThreadId)
      }
      this.trySelfHeal()
    } else if (sanitizedNotification.method === 'thread/status/changed' && nThreadId) {
      const params = asRecord(sanitizedNotification.params)
      const status = asRecord(params?.status)
      const statusType = readProtocolToken(status?.type ?? params?.status)
      const turnId = extractTurnIdFromNotificationParams(sanitizedNotification.params)
      if (isRunningProtocolToken(statusType) && turnId) {
        this.activeTurnIdByThreadId.set(nThreadId, turnId)
      } else if (statusType === 'idle' || statusType === 'interrupted' || isTerminalProtocolToken(statusType)) {
        this.activeTurnIdByThreadId.delete(nThreadId)
      }
    }
    for (const listener of this.notificationListeners) {
      listener(sanitizedNotification)
    }
  }

  private extractThreadIdFromParams(params: unknown): string {
    return extractThreadIdFromParams(params)
  }

  private recordStreamEvent(notification: { method: string; params: unknown }): void {
    const threadId = this.extractThreadIdFromParams(notification.params)
    if (!threadId) return
    const frame: StreamEventFrame = {
      method: notification.method,
      params: notification.params,
      atIso: new Date().toISOString(),
    }
    let buffer = this.streamEventsByThreadId.get(threadId)
    if (!buffer) {
      buffer = []
      this.setBoundedThreadCache(this.streamEventsByThreadId, threadId, buffer)
    } else {
      this.touchThreadCacheKey(this.streamEventsByThreadId, threadId)
    }
    buffer.push(frame)
    if (buffer.length > STREAM_EVENT_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - STREAM_EVENT_BUFFER_LIMIT)
    }
  }

  getStreamEvents(threadId: string, limit: number): StreamEventFrame[] {
    const buffer = this.touchThreadCacheKey(this.streamEventsByThreadId, threadId)
    if (!buffer || buffer.length === 0) return []
    return buffer.slice(-limit)
  }

  storeThreadReadSnapshot(threadId: string, snapshot: unknown): void {
    this.setBoundedThreadCache(this.lastThreadReadSnapshotByThreadId, threadId, snapshot)
    this.threadTurnPageReadCacheByThreadId.delete(threadId)
  }

  getLastThreadReadSnapshot(threadId: string): unknown | null {
    return this.touchThreadCacheKey(this.lastThreadReadSnapshotByThreadId, threadId) ?? null
  }

  private async readPaginatedThreadTurns(threadId: string): Promise<unknown[]> {
    const turns: unknown[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null

    do {
      const page = asRecord(await this.rpc('thread/turns/list', {
        threadId,
        cursor,
        limit: THREAD_TURNS_LIST_PAGE_LIMIT,
        sortDirection: 'asc',
        itemsView: 'full',
      }))
      const data = Array.isArray(page?.data) ? page.data : null
      if (!data) {
        throw new Error('thread/turns/list returned an invalid payload')
      }
      turns.push(...data)
      const nextCursor = readNonEmptyString(page?.nextCursor)
      if (!nextCursor || seenCursors.has(nextCursor)) break
      seenCursors.add(nextCursor)
      cursor = nextCursor
    } while (cursor)

    return turns
  }

  private async readPaginatedThreadForTurnPage(threadId: string, originalError: unknown): Promise<unknown> {
    const metadataResult = await this.rpc('thread/read', {
      threadId,
      includeTurns: false,
    })
    const metadataRecord = asRecord(metadataResult)
    const thread = asRecord(metadataRecord?.thread)
    const sessionPath = readNonEmptyString(thread?.path)
    if (!metadataRecord || !thread || !sessionPath || !isAbsolute(sessionPath)) {
      throw originalError
    }

    const lineage = await readSessionForkLineage(
      sessionPath,
      sessionPath.split(/[\\/]+/u).includes('archived_sessions'),
    ).catch(() => null)
    if (!lineage?.isPaginated) throw originalError

    let turns: unknown[]
    try {
      turns = await this.readPaginatedThreadTurns(threadId)
    } catch {
      // Older Codex versions have the same pagination storage format but no
      // turns/list endpoint. Reconstruct the local portion, then the caller
      // recursively supplies the inherited prefix from its source rollout.
      const sessionLogRaw = await readSessionRolloutSnapshot(sessionPath).then((snapshot) => snapshot.raw).catch(() => '')
      turns = sessionLogRaw ? buildSessionTurnsFromRollout(sessionLogRaw) : []
    }

    return {
      ...metadataRecord,
      thread: {
        ...thread,
        turns,
      },
    }
  }

  async readThreadForTurnPage(threadId: string): Promise<unknown> {
    const now = Date.now()
    const cached = this.threadTurnPageReadCacheByThreadId.get(threadId)
    if (cached && cached.expiresAt > now) return cached.result
    if (cached) this.threadTurnPageReadCacheByThreadId.delete(threadId)

    const pending = this.threadTurnPageReadPromiseByThreadId.get(threadId)
    if (pending) return pending

    const promise = this.rpc('thread/read', {
      threadId,
      includeTurns: true,
    }).catch(async (error) => {
      if (!isPaginatedThreadReadError(error)) throw error
      return await this.readPaginatedThreadForTurnPage(threadId, error)
    }).then((result) => {
      this.setBoundedThreadCache(this.threadTurnPageReadCacheByThreadId, threadId, {
        result,
        expiresAt: Date.now() + THREAD_TURN_PAGE_READ_CACHE_TTL_MS,
      })
      return result
    }).finally(() => {
      this.threadTurnPageReadPromiseByThreadId.delete(threadId)
    })

    this.threadTurnPageReadPromiseByThreadId.set(threadId, promise)
    return promise
  }

  cacheLiveState(threadId: string, data: unknown, turnCount: number, sessionSize: number): void {
    this.setBoundedThreadCache(this.liveStateCache, threadId, { data, turnCount, sessionSize })
  }

  getCachedLiveState(threadId: string, turnCount: number, sessionSize: number): unknown | null {
    const cached = this.touchThreadCacheKey(this.liveStateCache, threadId)
    if (!cached) return null
    if (cached.turnCount !== turnCount || cached.sessionSize !== sessionSize) return null
    return cached.data
  }

  invalidateLiveStateCache(threadId: string): void {
    this.liveStateCache.delete(threadId)
  }

  private captureItemFromNotification(notification: { method: string; params: unknown }): void {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return

    const params = asRecord(notification.params)
    if (!params) return
    const item = asRecord(params.item)
    if (!item) return
    const itemType = typeof item.type === 'string' ? item.type : ''
    if (!MERGEABLE_ITEM_TYPES.has(itemType)) return

    const itemId = typeof item.id === 'string' ? item.id : ''
    if (!itemId) return

    const threadId = this.extractThreadIdFromParams(params)
    if (!threadId) return

    const turnId =
      (typeof params.turnId === 'string' ? params.turnId : '') ||
      (typeof params.turn_id === 'string' ? params.turn_id : '')
    if (!turnId) return

    let threadItems = this.capturedItemsByThreadId.get(threadId)
    if (!threadItems) {
      threadItems = new Map()
      this.setBoundedThreadCache(this.capturedItemsByThreadId, threadId, threadItems)
    } else {
      this.touchThreadCacheKey(this.capturedItemsByThreadId, threadId)
    }

    const isCompleted = notification.method === 'item/completed'
    const existing = threadItems.get(itemId)

    if (existing && existing.completed && !isCompleted) return

    threadItems.set(itemId, {
      id: itemId,
      type: itemType,
      turnId,
      data: item as Record<string, unknown>,
      completed: isCompleted,
    })
  }

  mergeItemsIntoTurns(threadId: string, turns: unknown[]): unknown[] {
    const capturedMap = this.touchThreadCacheKey(this.capturedItemsByThreadId, threadId)
    if (!capturedMap || capturedMap.size === 0) return turns

    const itemsByTurnId = new Map<string, CapturedItem[]>()
    for (const captured of capturedMap.values()) {
      let group = itemsByTurnId.get(captured.turnId)
      if (!group) {
        group = []
        itemsByTurnId.set(captured.turnId, group)
      }
      group.push(captured)
    }

    return turns.map((turn) => {
      const turnRecord = asRecord(turn)
      if (!turnRecord) return turn
      const turnId = typeof turnRecord.id === 'string' ? turnRecord.id : ''
      if (!turnId) return turn

      const captured = itemsByTurnId.get(turnId)
      if (!captured || captured.length === 0) return turn

      const existingItems = Array.isArray(turnRecord.items) ? (turnRecord.items as Record<string, unknown>[]) : []
      const existingIds = new Set(existingItems.map((it) => (typeof it.id === 'string' ? it.id : '')).filter(Boolean))

      const newItems = captured
        .filter((c) => !existingIds.has(c.id))
        .map((c) => c.data)

      if (newItems.length === 0) return turn

      return {
        ...turnRecord,
        items: [...existingItems, ...newItems],
      }
    })
  }

  private sendServerRequestReply(requestId: number, reply: ServerRequestReply): void {
    if (reply.error) {
      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        error: reply.error,
      })
      return
    }

    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: reply.result ?? {},
    })
  }

  private resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): void {
    const pendingRequest = this.pendingServerRequests.get(requestId)
    if (!pendingRequest) {
      throw new Error(`No pending server request found for id ${String(requestId)}`)
    }
    this.pendingServerRequests.delete(requestId)

    this.sendServerRequestReply(requestId, reply)
    const requestParams = asRecord(pendingRequest.params)
    const threadId =
      typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
        ? requestParams.threadId
        : ''
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: pendingRequest.method,
        threadId,
        mode: 'manual',
        resolvedAtIso: new Date().toISOString(),
      },
    })
  }

  private async refreshChatgptAuthTokens(params: ChatgptAuthTokensRefreshParams): Promise<ChatgptAuthTokensRefreshResponse> {
    if (!this.chatgptAuthRefreshPromise) {
      this.chatgptAuthRefreshPromise = refreshChatgptAuthTokensForExternalAuth(params).finally(() => {
        this.chatgptAuthRefreshPromise = null
      })
    }
    return await this.chatgptAuthRefreshPromise
  }

  private async handleChatgptAuthTokensRefreshRequest(requestId: number, params: unknown): Promise<void> {
    const requestParams = asRecord(params)
    const previousAccountId = readNonEmptyString(requestParams?.previousAccountId ?? requestParams?.previous_account_id)
    try {
      const result = await this.refreshChatgptAuthTokens({
        reason: readNonEmptyString(requestParams?.reason) || undefined,
        previousAccountId: previousAccountId || undefined,
      })
      this.sendServerRequestReply(requestId, { result })
      this.emitNotification({
        method: 'server/request/resolved',
        params: {
          id: requestId,
          method: 'account/chatgptAuthTokens/refresh',
          mode: 'automatic',
          resolvedAtIso: new Date().toISOString(),
        },
      })
    } catch (error) {
      this.sendServerRequestReply(requestId, {
        error: {
          code: -32001,
          message: getErrorMessage(error, 'Failed to refresh ChatGPT auth tokens'),
        },
      })
    }
  }

  private handleServerRequest(requestId: number, method: string, params: unknown): void {
    if (method === 'account/chatgptAuthTokens/refresh') {
      void this.handleChatgptAuthTokensRefreshRequest(requestId, params)
      return
    }

    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
    }
    this.pendingServerRequests.set(requestId, pendingRequest)

    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    this.start()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      this.sendLine({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } satisfies JsonRpcCall)
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) {
      await this.initializePromise
      return
    }

    this.initializePromise = this.call('initialize', {
      clientInfo: {
        name: 'codex-web-local',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }).then(() => {
      this.sendLine({
        jsonrpc: '2.0',
        method: 'initialized',
      })
      this.initialized = true
    }).finally(() => {
      this.initializePromise = null
    })

    await this.initializePromise
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    await this.ensureInitialized()
    return this.call(method, params)
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    await this.ensureInitialized()

    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid response payload: expected object')
    }

    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }

    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      this.resolvePendingServerRequest(id, { error: { code, message } })
      return
    }

    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }

    this.resolvePendingServerRequest(id, { result: body.result })
  }

  listPendingServerRequests(): PendingServerRequest[] {
    return Array.from(this.pendingServerRequests.values())
  }

  private recordStderrHealthSignal(count = 1): void {
    const now = Date.now()
    for (let index = 0; index < count; index += 1) {
      this.recentStderrErrorTimes.push(now)
    }
    const cutoff = now - UNHEALTHY_STDERR_WINDOW_MS
    while (this.recentStderrErrorTimes.length > 0 && this.recentStderrErrorTimes[0] < cutoff) {
      this.recentStderrErrorTimes.shift()
    }
    if (!this.unhealthy && this.recentStderrErrorTimes.length >= UNHEALTHY_STDERR_THRESHOLD) {
      this.unhealthy = true
      writeDebugLog('app-server-unhealthy', 'codex app-server marked unhealthy after repeated without-active-item stderr errors', {
        pid: this.process?.pid ?? -1,
        errorCount: this.recentStderrErrorTimes.length,
      }).catch(() => {})
      this.trySelfHeal()
    }
  }

  private trySelfHeal(): void {
    if (!this.unhealthy) return
    if (this.activeTurnCount > 0) return
    if (this.pending.size > 0 || this.pendingServerRequests.size > 0) return
    this.restartForSelfHeal()
  }

  private restartForSelfHeal(): void {
    const proc = this.process
    writeDebugLog('app-server-self-heal-restart', 'Restarting unhealthy codex app-server while idle', {
      pid: proc?.pid ?? -1,
    }).catch(() => {})
    this.unhealthy = false
    this.activeTurnCount = 0
    this.recentStderrErrorTimes = []
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.readBuffer = ''
    const failure = new Error('codex app-server restarted for self-heal')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()
    this.clearThreadCaches()
    if (proc) {
      try {
        proc.stdin.end()
      } catch {
        // ignore close errors during self-heal restart
      }
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore SIGTERM errors during self-heal restart
      }
      const selfHealKillTimer = setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill('SIGKILL')
          } catch {
            // ignore SIGKILL errors during self-heal restart
          }
        }
      }, 1500)
      selfHealKillTimer.unref()
    }
  }

  dispose(): void {
    if (!this.process) return

    const proc = this.process
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.readBuffer = ''

    const failure = new Error('codex app-server stopped')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()

    try {
      proc.stdin.end()
    } catch {
      // ignore close errors on shutdown
    }

    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore kill errors on shutdown
    }

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore kill errors on shutdown
        }
      }
    }, 1500)
    forceKillTimer.unref()
  }
}

export class BackendQueueProcessor {
  private readonly processingThreadIds = new Set<string>()
  private readonly queueDrainTimersByThreadId = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly interruptedTurnCheckTimersByThreadId = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly interruptedTurnResolutionByThreadId = new Map<string, Promise<boolean>>()
  private readonly deferredNotificationByThreadId = new Map<string, Array<{ method: string; params: unknown }>>()
  private readonly deferredNotifications = new WeakSet<object>()
  private readonly intentionalInterruptTurnIds = new Set<string>()
  private readonly intentionalInterruptThreadIds = new Set<string>()
  private readonly autoContinueInFlightThreadIds = new Set<string>()
  private readonly autoContinuedInterruptedTurnIds = new Set<string>()
  private readonly queueDrainDueAtByThreadId = new Map<string, number>()
  private readonly cursorContextAutoCompactInFlightThreadIds = new Set<string>()
  private readonly cursorContextAutoCompactedTurnIds = new Set<string>()
  private readonly cursorContextAutoCompactCooldownUntilByThreadId = new Map<string, number>()
  private readonly unsubscribe: () => void
  private intentionalInterruptStateReady: Promise<void> = Promise.resolve()

  constructor(
    private readonly appServer: AppServerProcess,
    private readonly resolveAppServerForRpc: (method: string, params: unknown) => AppServerProcess = () => appServer,
    private readonly runtimeProvider = '',
    private readonly forwardNotification: ((notification: { method: string; params: unknown }) => void) | null = null,
  ) {
    this.unsubscribe = appServer.onNotification((notification) => {
      this.handleAppServerNotification(notification)
    })
    this.intentionalInterruptStateReady = this.loadIntentionalInterruptState()
    void this.scheduleAllQueuedThreads(1000)
  }

  dispose(): void {
    this.unsubscribe()
    for (const timer of this.queueDrainTimersByThreadId.values()) {
      clearTimeout(timer)
    }
    this.queueDrainTimersByThreadId.clear()
    this.queueDrainDueAtByThreadId.clear()
    for (const timer of this.interruptedTurnCheckTimersByThreadId.values()) {
      clearTimeout(timer)
    }
    this.interruptedTurnCheckTimersByThreadId.clear()
    this.interruptedTurnResolutionByThreadId.clear()
    this.deferredNotificationByThreadId.clear()
    this.processingThreadIds.clear()
    this.intentionalInterruptTurnIds.clear()
    this.intentionalInterruptThreadIds.clear()
    this.autoContinueInFlightThreadIds.clear()
    this.autoContinuedInterruptedTurnIds.clear()
    this.cursorContextAutoCompactInFlightThreadIds.clear()
    this.cursorContextAutoCompactedTurnIds.clear()
    this.cursorContextAutoCompactCooldownUntilByThreadId.clear()
  }

  isNotificationDeferred(notification: { method: string; params: unknown }): boolean {
    return this.deferredNotifications.has(notification)
  }

  private handleAppServerNotification(notification: { method: string; params: unknown }): void {
    const threadId = extractThreadIdFromNotificationParams(notification.params)
    const completedTurn = this.readCompletedTurnNotification(notification)
    const isUnexpectedInterruptedCompletion = readProtocolToken(completedTurn?.status) === 'interrupted'
    const isPotentialInterruptedStatus = isPotentiallyAutoContinuedStatusChange(notification)

    if (
      isInterruptedTurnAutoContinueEnabled()
      && threadId
      && !this.intentionalInterruptThreadIds.has(threadId)
      && (isUnexpectedInterruptedCompletion || isPotentialInterruptedStatus)
    ) {
      this.deferNotification(threadId, notification)
      this.scheduleInterruptedTurnCheck(
        threadId,
        250,
        isUnexpectedInterruptedCompletion ? 'turn/completed' : 'thread/status/changed',
        completedTurn?.turnId ?? '',
      )
      return
    }

    if (isTurnCompletedNotification(notification)) {
      void this.handleTurnCompletedNotification(notification)
      return
    }

    if (notification.method === 'thread/status/changed' && isInterruptedTurnAutoContinueEnabled() && threadId) {
      this.scheduleInterruptedTurnCheck(threadId)
    }
  }

  private deferNotification(threadId: string, notification: { method: string; params: unknown }): void {
    this.deferredNotifications.add(notification)
    const deferred = this.deferredNotificationByThreadId.get(threadId) ?? []
    deferred.push(notification)
    this.deferredNotificationByThreadId.set(threadId, deferred)
  }

  private forwardDeferredNotifications(threadId: string): void {
    const deferred = this.deferredNotificationByThreadId.get(threadId)
    if (!deferred || deferred.length === 0) return
    this.deferredNotificationByThreadId.delete(threadId)
    for (const notification of deferred) {
      this.deferredNotifications.delete(notification)
      this.forwardNotification?.(notification)
    }
  }

  private discardDeferredNotifications(threadId: string): void {
    const deferred = this.deferredNotificationByThreadId.get(threadId)
    if (!deferred) return
    this.deferredNotificationByThreadId.delete(threadId)
    for (const notification of deferred) {
      this.deferredNotifications.delete(notification)
    }
  }

  recordIntentionalInterrupt(threadId: string, turnId: string): void {
    const normalizedThreadId = threadId.trim()
    const normalizedTurnId = turnId.trim()
    if (!normalizedThreadId || !normalizedTurnId) return
    this.intentionalInterruptTurnIds.add(normalizedTurnId)
    this.intentionalInterruptThreadIds.add(normalizedThreadId)
    this.intentionalInterruptStateReady = this.intentionalInterruptStateReady
      .catch(() => {})
      .then(async () => {
        this.intentionalInterruptTurnIds.add(normalizedTurnId)
        this.intentionalInterruptThreadIds.add(normalizedThreadId)
        try {
          await rememberIntentionalInterrupt(normalizedThreadId, normalizedTurnId)
        } catch {
          // Intentional stop persistence is best-effort; live memory guards still apply.
        }
      })
  }

  clearIntentionalInterruptForThread(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    this.intentionalInterruptThreadIds.delete(normalizedThreadId)
    this.intentionalInterruptStateReady = this.intentionalInterruptStateReady
      .catch(() => {})
      .then(async () => {
        this.intentionalInterruptThreadIds.delete(normalizedThreadId)
        try {
          await forgetIntentionalInterruptThreadId(normalizedThreadId)
        } catch {
          // Intentional stop persistence is best-effort; live memory guards still apply.
        }
      })
  }

  async scheduleAllQueuedThreads(delayMs = 0): Promise<void> {
    try {
      const state = await readThreadQueueState()
      for (const threadId of Object.keys(state)) {
        this.scheduleThreadQueueDrain(threadId, delayMs)
      }
    } catch {
      // Queue recovery is best-effort; normal turn-completed events can still drain later.
    }
  }

  scheduleThreadQueueDrain(threadId: string, delayMs = 5000): void {
    if (!threadId) return
    const normalizedDelayMs = Math.max(0, delayMs)
    const nextDueAt = Date.now() + normalizedDelayMs
    const existingDueAt = this.queueDrainDueAtByThreadId.get(threadId)
    const existingTimer = this.queueDrainTimersByThreadId.get(threadId)
    if (existingTimer) {
      if (existingDueAt !== undefined && existingDueAt <= nextDueAt) return
      clearTimeout(existingTimer)
      this.queueDrainTimersByThreadId.delete(threadId)
      this.queueDrainDueAtByThreadId.delete(threadId)
    }
    const timer = setTimeout(() => {
      this.queueDrainTimersByThreadId.delete(threadId)
      this.queueDrainDueAtByThreadId.delete(threadId)
      void this.processThreadQueue(threadId)
    }, normalizedDelayMs)
    timer.unref?.()
    this.queueDrainTimersByThreadId.set(threadId, timer)
    this.queueDrainDueAtByThreadId.set(threadId, nextDueAt)
  }

  scheduleInterruptedTurnCheck(
    threadId: string,
    delayMs = 250,
    source: 'turn/completed' | 'thread/status/changed' = 'thread/status/changed',
    completedTurnId = '',
  ): void {
    if (!isInterruptedTurnAutoContinueEnabled()) return
    if (!threadId) return
    const existingTimer = this.interruptedTurnCheckTimersByThreadId.get(threadId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      this.interruptedTurnCheckTimersByThreadId.delete(threadId)
      void this.resolveInterruptedTurnCheck(threadId, source, completedTurnId)
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.interruptedTurnCheckTimersByThreadId.set(threadId, timer)
  }

  private async resolveInterruptedTurnCheck(
    threadId: string,
    source: 'turn/completed' | 'thread/status/changed',
    completedTurnId: string,
  ): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    let resolution = this.interruptedTurnResolutionByThreadId.get(normalizedThreadId)
    if (!resolution) {
      resolution = this.maybeAutoContinueInterruptedThread(normalizedThreadId, source, completedTurnId)
      this.interruptedTurnResolutionByThreadId.set(normalizedThreadId, resolution)
      void resolution.finally(() => {
        if (this.interruptedTurnResolutionByThreadId.get(normalizedThreadId) === resolution) {
          this.interruptedTurnResolutionByThreadId.delete(normalizedThreadId)
        }
      })
    }

    if (await resolution) {
      this.discardDeferredNotifications(normalizedThreadId)
    } else {
      this.forwardDeferredNotifications(normalizedThreadId)
    }
  }

  async processThreadQueue(threadId: string): Promise<void> {
    if (this.processingThreadIds.has(threadId)) return
    this.processingThreadIds.add(threadId)
    try {
      const recoveredModelState = await this.readQueuedTurnRecoveryState(threadId)
      if (!recoveredModelState) {
        if (await this.hasQueuedTurns(threadId)) {
          this.scheduleThreadQueueDrain(threadId)
        }
        return
      }
      const next = await this.popNextQueuedTurn(threadId)
      if (!next) return
      try {
        await this.startQueuedTurn(next, recoveredModelState)
        if (await this.hasQueuedTurns(threadId)) {
          this.scheduleThreadQueueDrain(threadId)
        }
      } catch {
        await this.restoreQueuedTurn(next)
        this.scheduleThreadQueueDrain(threadId)
      }
    } catch {
      // Queue processing is best-effort. Keep the bridge alive if app-server is unavailable.
      this.scheduleThreadQueueDrain(threadId)
    } finally {
      this.processingThreadIds.delete(threadId)
    }
  }

  private async handleTurnCompletedNotification(notification: { method: string; params: unknown }): Promise<void> {
    const turn = this.readCompletedTurnNotification(notification)
    if (!turn) return

    if (readProtocolToken(turn.status) === 'interrupted') {
      if (isInterruptedTurnAutoContinueEnabled()) {
        this.scheduleInterruptedTurnCheck(turn.threadId, 250, 'turn/completed', turn.turnId)
      } else if (await this.hasQueuedTurns(turn.threadId)) {
        void this.processThreadQueue(turn.threadId)
      }
      return
    }

    this.clearIntentionalInterruptForThread(turn.threadId)

    const contextExceededTurn = this.runtimeProvider === CURSOR_PROVIDER_ID
      ? readContextWindowExceededTurn(notification)
      : null
    if (contextExceededTurn) {
      const started = await this.maybeAutoCompactCursorContextExceededTurn(contextExceededTurn)
      if (!started) {
        void this.processThreadQueue(turn.threadId)
      }
      return
    }

    void this.processThreadQueue(turn.threadId)
  }

  private readCompletedTurnNotification(notification: { method: string; params: unknown }): { threadId: string; turnId: string; status: string } | null {
    if (!isTurnCompletedNotification(notification)) return null
    const params = asRecord(notification.params)
    if (!params) return null

    const threadId = extractThreadIdFromNotificationParams(params)
    if (!threadId) return null

    const turn = asRecord(params.turn)
    const turnId = readNonEmptyString(turn?.id) || readNonEmptyString(params.turnId) || readNonEmptyString(params.turn_id)
    if (!turnId) return null

    return {
      threadId,
      turnId,
      status: readNonEmptyString(turn?.status).trim(),
    }
  }

  private async loadIntentionalInterruptState(): Promise<void> {
    try {
      const [turnIds, threadIds] = await Promise.all([
        readIntentionalInterruptTurnIds(),
        readIntentionalInterruptThreadIds(),
      ])
      for (const id of turnIds) {
        this.intentionalInterruptTurnIds.add(id)
      }
      for (const id of threadIds) {
        this.intentionalInterruptThreadIds.add(id)
      }
    } catch {
      // Intentional stop recovery is best-effort; live turn/interrupt RPCs still mark stops.
    }
  }

  private async maybeAutoContinueInterruptedThread(
    threadId: string,
    source: 'turn/completed' | 'thread/status/changed',
    completedTurnId = '',
  ): Promise<boolean> {
    if (!isInterruptedTurnAutoContinueEnabled()) return false
    const normalizedThreadId = threadId.trim()
    const normalizedCompletedTurnId = completedTurnId.trim()
    if (!normalizedThreadId) return false
    if (this.autoContinueInFlightThreadIds.has(normalizedThreadId)) return false
    await this.intentionalInterruptStateReady
    if (this.intentionalInterruptThreadIds.has(normalizedThreadId)) return false

    let response: unknown = null
    try {
      response = await this.appServer.rpc('thread/read', {
        threadId: normalizedThreadId,
        includeTurns: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[DEBUG:BackendQueueProcessor] interrupted-turn inspection failed — threadId=%s source=%s error=%s', normalizedThreadId, source, message)
      writeDebugLog('auto-continue-interrupted-turn-read-failed', 'Interrupted turn inspection failed', {
        threadId: normalizedThreadId,
        source,
        error: message,
      }).catch(() => {})
      return false
    }

    const enrichedReadResponse = await mergeSessionModelStateIntoThreadResult(response, this.appServer)
    const reconciledThread = asRecord(asRecord(enrichedReadResponse)?.thread)
    const reconciledStatus = asRecord(reconciledThread?.status)
    if (isRunningProtocolToken(readProtocolToken(reconciledStatus?.type))) {
      const activeTurnId = readNonEmptyString(reconciledStatus?.turnId)
        || readNonEmptyString(reconciledStatus?.turn_id)
      this.forwardNotification?.({
        method: 'thread/status/changed',
        params: {
          threadId: normalizedThreadId,
          status: activeTurnId ? { type: 'running', turnId: activeTurnId } : { type: 'running' },
        },
      })
      return true
    }

    // The rollout-backed view above is presentation-safe. Keep recovery
    // eligibility based on the unmodified app-server snapshot: only an
    // actually abandoned interrupted turn should receive a new continuation.
    const snapshot = shouldAutoContinueInterruptedThreadFromThreadRead(response, this.intentionalInterruptTurnIds)
    if (!snapshot) return false
    if (normalizedCompletedTurnId && snapshot.turnId !== normalizedCompletedTurnId && source === 'turn/completed') {
      return false
    }
    if (this.autoContinuedInterruptedTurnIds.has(snapshot.turnId)) {
      return false
    }

    this.autoContinueInFlightThreadIds.add(normalizedThreadId)
    try {
      console.warn('[DEBUG:BackendQueueProcessor] auto-continuing interrupted turn — threadId=%s turnId=%s source=%s', snapshot.threadId, snapshot.turnId, source)
      writeDebugLog('auto-continue-interrupted-turn', 'Auto-continuing interrupted turn', {
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
        source,
      }).catch(() => {})
      const readModelState = readThreadResultModelState(enrichedReadResponse)
      const resumeParams: Record<string, unknown> = {
        threadId: snapshot.threadId,
        persistExtendedHistory: true,
      }
      if (readModelState.model) {
        resumeParams.model = readModelState.model
      }
      if (readModelState.modelProvider) {
        resumeParams.modelProvider = readModelState.modelProvider
      }
      const continuationAppServer = this.resolveAppServerForRpc('thread/resume', resumeParams)
      const resumeResult = await continuationAppServer.rpc('thread/resume', resumeParams)
      const enrichedResumeResult = await mergeSessionModelStateIntoThreadResult(resumeResult, this.appServer)
      const resumedModelState = readThreadResultModelState(enrichedResumeResult)
      const turnStartParams: Record<string, unknown> = {
        threadId: snapshot.threadId,
        input: [{
          type: 'text',
          text: 'Please continue.',
        }],
      }
      const resumedModel = readModelState.model || resumedModelState.model
      const resumedModelProvider = readModelState.modelProvider || resumedModelState.modelProvider
      const resumedReasoningEffort = readModelState.reasoningEffort || resumedModelState.reasoningEffort
      if (resumedModel) {
        turnStartParams.model = resumedModel
      }
      if (resumedModelProvider) {
        turnStartParams.modelProvider = resumedModelProvider
      }
      if (resumedReasoningEffort) {
        turnStartParams.effort = resumedReasoningEffort
        const settings: Record<string, unknown> = {
          model: resumedModel || (await this.resolveCollaborationModeSettings('default', '', '', continuationAppServer)).model,
          reasoning_effort: normalizeCollaborationModeReasoningEffort(resumedReasoningEffort),
          developer_instructions: null,
        }
        if (resumedModelProvider) {
          settings.model_provider = resumedModelProvider
        }
        turnStartParams.collaborationMode = {
          mode: 'default',
          settings,
        }
      }
      await this.resolveAppServerForRpc('turn/start', turnStartParams).rpc('turn/start', turnStartParams)
      // codex does not always re-emit thread/status/changed running after a
      // resume+turn/start auto-continuation, so the frontend never learns the
      // turn is active again and the UI drops out of "running". Forward a
      // synthetic running status change directly to subscribers (bypassing
      // this processor's own handler) so the sidebar stays truthful.
      this.forwardNotification?.({
        method: 'thread/status/changed',
        params: { threadId: snapshot.threadId, status: { type: 'running' } },
      })
      this.autoContinuedInterruptedTurnIds.add(snapshot.turnId)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[DEBUG:BackendQueueProcessor] auto-continue interrupted turn failed — threadId=%s turnId=%s error=%s', snapshot.threadId, snapshot.turnId, message)
      writeDebugLog('auto-continue-interrupted-turn-failed', 'Auto-continue interrupted turn failed', {
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
        source,
        error: message,
      }).catch(() => {})
      return false
    } finally {
      this.autoContinueInFlightThreadIds.delete(normalizedThreadId)
    }
  }

  private async maybeAutoCompactCursorContextExceededTurn(turn: { threadId: string; turnId: string }): Promise<boolean> {
    const threadId = turn.threadId.trim()
    const turnId = turn.turnId.trim()
    if (!threadId || !turnId) return false
    if (this.cursorContextAutoCompactedTurnIds.has(turnId)) return false
    if (this.cursorContextAutoCompactInFlightThreadIds.has(threadId)) return true

    const now = Date.now()
    const cooldownUntil = this.cursorContextAutoCompactCooldownUntilByThreadId.get(threadId) ?? 0
    if (cooldownUntil > now) return true

    this.cursorContextAutoCompactedTurnIds.add(turnId)
    this.cursorContextAutoCompactInFlightThreadIds.add(threadId)
    this.cursorContextAutoCompactCooldownUntilByThreadId.set(threadId, now + CURSOR_CONTEXT_AUTO_COMPACT_COOLDOWN_MS)
    try {
      console.warn('[DEBUG:BackendQueueProcessor] auto-starting Cursor context compact — threadId=%s turnId=%s', threadId, turnId)
      writeDebugLog('cursor-context-auto-compact-start', 'Auto-starting Cursor context compact after context overflow', {
        threadId,
        turnId,
      }).catch(() => {})
      await this.appServer.rpc('thread/compact/start', { threadId })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[DEBUG:BackendQueueProcessor] Cursor context auto-compact failed — threadId=%s turnId=%s error=%s', threadId, turnId, message)
      writeDebugLog('cursor-context-auto-compact-failed', 'Cursor context auto-compact failed', {
        threadId,
        turnId,
        error: message,
      }).catch(() => {})
      return false
    } finally {
      this.cursorContextAutoCompactInFlightThreadIds.delete(threadId)
    }
  }

  private async hasQueuedTurns(threadId: string): Promise<boolean> {
    const state = await readThreadQueueState()
    const queue = state[threadId]
    return Array.isArray(queue) && queue.length > 0
  }

  private async readQueuedTurnRecoveryState(threadId: string): Promise<SessionRecoveredModelState | null> {
    const rawResponse = await this.appServer.rpc('thread/read', { threadId, includeTurns: true })
    const response = asRecord(await mergeSessionModelStateIntoThreadResult(rawResponse, this.appServer))
    const thread = asRecord(response?.thread)
    if (!thread) return null

    const status = asRecord(thread.status)
    const statusType = readProtocolToken(status?.type)
    if (isRunningProtocolToken(statusType)) return null

    const turns = Array.isArray(thread.turns) ? thread.turns : []
    if (turns.some((turn) => isRunningProtocolToken(readProtocolToken(asRecord(turn)?.status)))) return null

    const latestTurn = asRecord(turns.at(-1))
    if (!latestTurn) return readThreadResultModelState(response)

    const latestStatus = readProtocolToken(latestTurn.status)
    if (latestStatus === 'interrupted') {
      await this.intentionalInterruptStateReady
      if (this.intentionalInterruptThreadIds.has(threadId)) return readThreadResultModelState(response)
      const latestTurnId = readNonEmptyString(latestTurn.id)
      if (latestTurnId && this.intentionalInterruptTurnIds.has(latestTurnId)) return readThreadResultModelState(response)
      return isInterruptedTurnAutoContinueEnabled() ? null : readThreadResultModelState(response)
    }
    if (isTerminalProtocolToken(latestStatus)) return readThreadResultModelState(response)

    return turnHasAssistantResult(latestTurn) ? readThreadResultModelState(response) : null
  }

  private async popNextQueuedTurn(threadId: string): Promise<BackendQueuedTurn | null> {
    return withThreadQueueStateUpdate((state) => {
      const queue = state[threadId]
      if (!queue || queue.length === 0) {
        return { nextState: state, result: null }
      }

      const [message, ...rest] = queue
      const nextState = { ...state }
      if (rest.length > 0) {
        nextState[threadId] = rest
      } else {
        delete nextState[threadId]
      }
      return { nextState, result: { threadId, message } }
    })
  }

  private async restoreQueuedTurn(turn: BackendQueuedTurn): Promise<void> {
    await withThreadQueueStateUpdate((state) => {
      const queue = state[turn.threadId] ?? []
      return {
        nextState: {
          ...state,
          [turn.threadId]: [turn.message, ...queue],
        },
        result: undefined,
      }
    })
  }

  private async resolveCollaborationModeSettings(
    mode: CollaborationModeKind,
    model?: string,
    reasoningEffort?: ReasoningEffort | '',
    appServer: AppServerProcess = this.appServer,
  ): Promise<ResolvedCollaborationModeSettings> {
    const explicitModel = readNonEmptyString(model)
    if (explicitModel) {
      return {
        model: explicitModel,
        reasoningEffort: normalizeCollaborationModeReasoningEffort(reasoningEffort ?? null),
      }
    }

    let currentConfig: Record<string, unknown> | null = null
    try {
      const configPayload = asRecord(await appServer.rpc('config/read', {}))
      currentConfig = asRecord(configPayload?.config)
    } catch {
      currentConfig = null
    }

    const configuredModel = readNonEmptyString(currentConfig?.model)
    if (configuredModel) {
      return {
        model: configuredModel,
        reasoningEffort: normalizeCollaborationModeReasoningEffort(normalizeReasoningEffort(currentConfig?.model_reasoning_effort)),
      }
    }

    try {
      const modelsPayload = asRecord(await appServer.rpc('model/list', {}))
      const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : []
      for (const row of models) {
        const record = asRecord(row)
        const candidate = readNonEmptyString(record?.id) || readNonEmptyString(record?.model)
        if (candidate) {
          return {
            model: candidate,
            reasoningEffort: normalizeCollaborationModeReasoningEffort(normalizeReasoningEffort(currentConfig?.model_reasoning_effort)),
          }
        }
      }
    } catch {
      // Fall through to no collaboration-mode payload.
    }

    throw new Error(`${mode === 'plan' ? 'Plan' : 'Default'} mode requires an available model.`)
  }

  private async buildQueuedTurnParams(
    turn: BackendQueuedTurn,
    modelState: SessionRecoveredModelState,
    appServer: AppServerProcess = this.appServer,
  ): Promise<Record<string, unknown>> {
    const localImageAttachments: StoredQueuedMessage['fileAttachments'] = []
    for (const imageUrl of turn.message.imageUrls) {
      const localImagePath = extractLocalImagePathFromUrl(imageUrl.trim())
      if (!localImagePath) continue
      localImageAttachments.push({
        label: fileNameFromPath(localImagePath),
        path: localImagePath,
        fsPath: localImagePath,
      })
    }

    const allFileAttachments = [...turn.message.fileAttachments, ...localImageAttachments]
    const dedupedFileAttachments = allFileAttachments.filter((entry, index) =>
      allFileAttachments.findIndex((candidate) => candidate.fsPath === entry.fsPath) === index)

    const input: Array<Record<string, unknown>> = [{
      type: 'text',
      text: buildTextWithAttachments(turn.message.text, dedupedFileAttachments),
    }]

    for (const imageUrl of turn.message.imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      const localImagePath = extractLocalImagePathFromUrl(normalizedUrl)
      if (localImagePath) {
        input.push({ type: 'localImage', path: localImagePath })
      } else {
        input.push({ type: 'image', url: normalizedUrl, image_url: normalizedUrl })
      }
    }

    for (const skill of turn.message.skills) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }

    const params: Record<string, unknown> = {
      threadId: turn.threadId,
      input,
    }
    if (dedupedFileAttachments.length > 0) {
      params.attachments = dedupedFileAttachments.map((f) => ({ label: f.label, path: f.path, fsPath: f.fsPath }))
    }

    try {
      const queuedModel = readNonEmptyString(turn.message.model)
      const queuedModelProvider = readNonEmptyString(turn.message.modelProvider)
      const queuedReasoningEffort = normalizeReasoningEffort(turn.message.reasoningEffort)
      const shouldUseQueuedSelection = turn.message.modelSelectionOverride === true
      const model = shouldUseQueuedSelection ? queuedModel : modelState.model || queuedModel
      const modelProvider = shouldUseQueuedSelection ? queuedModelProvider : modelState.modelProvider || queuedModelProvider
      const reasoningEffort = shouldUseQueuedSelection
        ? queuedReasoningEffort
        : modelState.reasoningEffort || queuedReasoningEffort
      const settings = await this.resolveCollaborationModeSettings(
        turn.message.collaborationMode,
        model,
        reasoningEffort,
        appServer,
      )
      if (model) {
        params.model = model
      }
      if (modelProvider) {
        params.modelProvider = modelProvider
      }
      if (reasoningEffort) {
        params.effort = reasoningEffort
      }
      const settingsRecord: Record<string, unknown> = {
        model: settings.model,
        reasoning_effort: settings.reasoningEffort,
        developer_instructions: null,
      }
      if (modelProvider) {
        settingsRecord.model_provider = modelProvider
      }
      params.collaborationMode = {
        mode: turn.message.collaborationMode,
        settings: settingsRecord,
      }
    } catch {
      // Older app-server versions still accept a plain turn/start without collaborationMode.
    }

    return params
  }

  private async startQueuedTurn(
    turn: BackendQueuedTurn,
    recoveredModelState: SessionRecoveredModelState = { model: '', modelProvider: '', reasoningEffort: '' },
  ): Promise<void> {
    const resumeParams: Record<string, unknown> = {
      threadId: turn.threadId,
      persistExtendedHistory: true,
    }
    const queuedModel = readNonEmptyString(turn.message.model)
    const queuedModelProvider = readNonEmptyString(turn.message.modelProvider)
    const shouldUseQueuedSelection = turn.message.modelSelectionOverride === true
    const model = shouldUseQueuedSelection ? queuedModel : recoveredModelState.model || queuedModel
    const modelProvider = shouldUseQueuedSelection
      ? queuedModelProvider
      : recoveredModelState.modelProvider || queuedModelProvider
    if (model) {
      resumeParams.model = model
    }
    if (modelProvider) {
      resumeParams.modelProvider = modelProvider
    }
    const queueAppServer = this.resolveAppServerForRpc('thread/resume', resumeParams)
    await queueAppServer.rpc('thread/resume', resumeParams)
    const turnStartParams = await this.buildQueuedTurnParams(turn, {
      model,
      modelProvider,
      reasoningEffort: shouldUseQueuedSelection
        ? normalizeReasoningEffort(turn.message.reasoningEffort)
        : recoveredModelState.reasoningEffort || normalizeReasoningEffort(turn.message.reasoningEffort),
    }, queueAppServer)
    await this.resolveAppServerForRpc('turn/start', turnStartParams).rpc('turn/start', turnStartParams)
  }
}

type BridgeNotification = {
  method: string
  params: unknown
  atIso: string
}

function readActiveFreeModeStateSync(): FreeModeState {
  return ensureDefaultFreeModeStateForMissingAuthSync(join(getCodexHomeDir(), FREE_MODE_STATE_FILE))
    ?? createDefaultFreeModeState()
}

async function persistFreeModeState(state: FreeModeState): Promise<void> {
  const statePath = join(getCodexHomeDir(), FREE_MODE_STATE_FILE)
  await writeFile(statePath, JSON.stringify(normalizeFreeModeState(state) ?? state), { encoding: 'utf8', mode: 0o600 })
}

class AppServerRuntime {
  readonly appServer: AppServerProcess
  readonly backendQueueProcessor: BackendQueueProcessor
  readonly signature: string
  private readonly unsubscribeNotifications: () => void
  private disposed = false

  constructor(
    state: FreeModeState,
    private readonly forwardNotification: (notification: BridgeNotification) => void,
    resolveAppServerForRpc?: (method: string, params: unknown) => AppServerProcess,
  ) {
    this.signature = getAppServerRuntimeSignature(state)
    this.appServer = new AppServerProcess()
    this.appServer.setFreeModeState(state)
    this.backendQueueProcessor = new BackendQueueProcessor(this.appServer, resolveAppServerForRpc, readNonEmptyString(state.provider), (notification) => {
      this.forwardNotification({ ...notification, atIso: new Date().toISOString() })
    })
    this.unsubscribeNotifications = this.appServer.onNotification((notification) => {
      if (this.backendQueueProcessor.isNotificationDeferred(notification)) return
      this.forwardNotification({
        ...notification,
        atIso: new Date().toISOString(),
      })
    })
    void initializeSkillsSyncOnStartup(this.appServer).catch(() => {})
  }

  setFreeModeState(state: FreeModeState): void {
    this.appServer.setFreeModeState(state)
  }

  getFreeModeState(): FreeModeState {
    return this.appServer.getFreeModeState()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeNotifications()
    this.backendQueueProcessor.dispose()
    this.appServer.dispose()
  }
}

class AppServerRuntimePool {
  private static readonly THREAD_RUNTIME_CACHE_LIMIT = 512
  private readonly runtimesBySignature = new Map<string, AppServerRuntime>()
  private readonly notificationListeners = new Set<(notification: BridgeNotification) => void>()
  private readonly runtimeByThreadId = new Map<string, AppServerRuntime>()
  private activeState: FreeModeState = readActiveFreeModeStateSync()

  private emitNotification(notification: BridgeNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private createRuntime(state: FreeModeState): AppServerRuntime {
    let runtime: AppServerRuntime
    runtime = new AppServerRuntime(state, (notification) => {
      const threadId = extractThreadIdFromParams(notification.params)
      if (threadId) {
        this.recordThreadRuntime(threadId, runtime)
      }
      this.emitNotification(notification)
    }, (method, params) => {
      const requestedProvider = readRequestedRuntimeProvider(method, params)
      if (!requestedProvider) return runtime.appServer

      const routedState = buildWrapperRuntimeState(this.activeState, requestedProvider, params)
      return this.getOrCreateRuntime(routedState).appServer
    })
    this.runtimesBySignature.set(runtime.signature, runtime)
    return runtime
  }

  private getOrCreateRuntime(state: FreeModeState): AppServerRuntime {
    const signature = getAppServerRuntimeSignature(state)
    const existing = this.runtimesBySignature.get(signature)
    if (existing) {
      existing.setFreeModeState(state)
      return existing
    }
    return this.createRuntime(state)
  }

  setActiveState(state: FreeModeState): AppServerRuntime {
    this.activeState = cloneFreeModeState(state)
    return this.getOrCreateRuntime(this.activeState)
  }

  getRuntimeForState(state: FreeModeState): AppServerRuntime {
    return this.getOrCreateRuntime(state)
  }

  getActiveState(): FreeModeState {
    return cloneFreeModeState(this.activeState)
  }

  getActiveRuntime(): AppServerRuntime {
    return this.getOrCreateRuntime(this.activeState)
  }

  recordThreadRuntime(threadId: string, runtime: AppServerRuntime): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    this.runtimeByThreadId.delete(normalizedThreadId)
    this.runtimeByThreadId.set(normalizedThreadId, runtime)
    while (this.runtimeByThreadId.size > AppServerRuntimePool.THREAD_RUNTIME_CACHE_LIMIT) {
      const oldestThreadId = this.runtimeByThreadId.keys().next().value
      if (!oldestThreadId) break
      this.runtimeByThreadId.delete(oldestThreadId)
    }
  }

  releaseThreadState(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    this.runtimeByThreadId.delete(normalizedThreadId)
    for (const runtime of this.runtimesBySignature.values()) {
      runtime.appServer.releaseThreadState(normalizedThreadId)
    }
  }

  findRuntimeWithThreadState(threadId: string, excludedRuntime?: AppServerRuntime): AppServerRuntime | null {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return null
    const recordedRuntime = this.runtimeByThreadId.get(normalizedThreadId)
    if (recordedRuntime && recordedRuntime !== excludedRuntime) {
      this.runtimeByThreadId.delete(normalizedThreadId)
      this.runtimeByThreadId.set(normalizedThreadId, recordedRuntime)
      return recordedRuntime
    }
    for (const runtime of this.runtimesBySignature.values()) {
      if (runtime === excludedRuntime) continue
      if (runtime.appServer.getLastThreadReadSnapshot(normalizedThreadId)) {
        return runtime
      }
    }
    return null
  }

  recordIntentionalInterrupt(threadId: string, turnId: string): void {
    const normalizedThreadId = threadId.trim()
    const normalizedTurnId = turnId.trim()
    if (!normalizedThreadId || !normalizedTurnId) return
    for (const runtime of this.runtimesBySignature.values()) {
      runtime.backendQueueProcessor.recordIntentionalInterrupt(normalizedThreadId, normalizedTurnId)
    }
  }

  clearIntentionalInterruptForThread(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    for (const runtime of this.runtimesBySignature.values()) {
      runtime.backendQueueProcessor.clearIntentionalInterruptForThread(normalizedThreadId)
    }
  }

  getActiveAppServer(): AppServerProcess {
    return this.getActiveRuntime().appServer
  }

  getActiveBackendQueueProcessor(): BackendQueueProcessor {
    return this.getActiveRuntime().backendQueueProcessor
  }

  subscribeNotifications(listener: (notification: BridgeNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  dispose(): void {
    for (const runtime of this.runtimesBySignature.values()) {
      runtime.dispose()
    }
    this.runtimesBySignature.clear()
    this.runtimeByThreadId.clear()
    this.notificationListeners.clear()
  }
}

function recordRuntimeThreadState(runtimePool: AppServerRuntimePool, threadId: string, runtime: AppServerRuntime): void {
  const maybeRuntimePool = runtimePool as AppServerRuntimePool & {
    recordThreadRuntime?: (threadId: string, runtime: AppServerRuntime) => void
  }
  maybeRuntimePool.recordThreadRuntime?.(threadId, runtime)
}

function findRuntimeWithThreadState(
  runtimePool: AppServerRuntimePool,
  threadId: string,
  excludedRuntime?: AppServerRuntime,
): AppServerRuntime | null {
  const maybeRuntimePool = runtimePool as AppServerRuntimePool & {
    findRuntimeWithThreadState?: (threadId: string, excludedRuntime?: AppServerRuntime) => AppServerRuntime | null
    findRuntimeWithThreadSnapshot?: (threadId: string, excludedRuntime?: AppServerRuntime) => AppServerRuntime | null
  }
  return maybeRuntimePool.findRuntimeWithThreadState?.(threadId, excludedRuntime)
    ?? maybeRuntimePool.findRuntimeWithThreadSnapshot?.(threadId, excludedRuntime)
    ?? null
}

class MethodCatalog {
  private methodCache: string[] | null = null
  private notificationCache: string[] | null = null

  private async runGenerateSchemaCommand(outDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const codexCommand = resolveCodexCommand()
      if (!codexCommand) {
        reject(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))
        return
      }

      const invocation = getSpawnInvocation(codexCommand, ['app-server', 'generate-json-schema', '--out', outDir])
      const process = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''

      process.stderr.setEncoding('utf8')
      process.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      process.on('error', reject)
      process.on('exit', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `generate-json-schema exited with code ${String(code)}`))
      })
    })
  }

  private extractMethodsFromClientRequest(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  private extractMethodsFromServerNotification(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  async listMethods(): Promise<string[]> {
    if (this.methodCache) {
      return this.methodCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'codex-web-local-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const clientRequestPath = join(outDir, 'ClientRequest.json')
    const raw = await readFile(clientRequestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromClientRequest(parsed)

    this.methodCache = methods
    return methods
  }

  async listNotificationMethods(): Promise<string[]> {
    if (this.notificationCache) {
      return this.notificationCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'codex-web-local-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const serverNotificationPath = join(outDir, 'ServerNotification.json')
    const raw = await readFile(serverNotificationPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromServerNotification(parsed)

    this.notificationCache = methods
    return methods
  }
}

type CodexBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => void
  subscribeNotifications: (listener: (value: { method: string; params: unknown; atIso: string }) => void) => () => void
}

function createLazyBridgeDependency<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = resolve()
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(_target, property, value) {
      return Reflect.set(resolve(), property, value)
    },
  })
}

type RuntimeProviderId = string

function shouldUseProviderRuntime(provider: string): boolean {
  if (!provider) return false
  if (isWrapperProvider(provider)) return true
  return readCodexUiProviderDescriptor(provider) != null
}

function readRequestedRuntimeProvider(method: string, params: unknown): RuntimeProviderId | null {
  if (!THREAD_MODEL_PROVIDER_OVERRIDE_METHODS.has(method)) return null

  const paramsRecord = asRecord(params)
  const provider = readNonEmptyString(paramsRecord?.modelProvider)
    || readNonEmptyString(paramsRecord?.model_provider)
  const normalizedProvider = provider.trim().toLowerCase()
  return shouldUseProviderRuntime(normalizedProvider) ? normalizedProvider : null
}

async function ensureTurnStartRuntimeThreadState(
  appServer: RpcExecutor,
  method: string,
  params: unknown,
): Promise<void> {
  if (method !== 'turn/start') return
  const requestedProvider = readRequestedRuntimeProvider(method, params)
  if (!requestedProvider) return

  const paramsRecord = asRecord(params)
  const threadId = readNonEmptyString(paramsRecord?.threadId)
  if (!threadId) return

  const resumeParams: Record<string, unknown> = {
    threadId,
    persistExtendedHistory: true,
    modelProvider: requestedProvider,
  }
  const model = readNonEmptyString(paramsRecord?.model)
  if (model) {
    resumeParams.model = model
  }

  try {
    await appServer.rpc('thread/resume', resumeParams)
  } catch (error) {
    if (!isNoRolloutFoundError(error)) {
      throw error
    }

    writeDebugLog('turn-start-runtime-resume-no-rollout', 'Skipping provider runtime resume because the thread rollout is not materialized yet', {
      threadId,
      provider: requestedProvider,
    }).catch(() => {})
  }
}

export function persistTurnStartModelProviderInCollaborationMode(method: string, params: unknown): unknown {
  if (method !== 'turn/start') return params
  const paramsRecord = asRecord(params)
  if (!paramsRecord) return params

  const modelProvider = readNonEmptyString(paramsRecord.modelProvider)
    || readNonEmptyString(paramsRecord.model_provider)
  if (!modelProvider) return params

  const collaborationMode = asRecord(paramsRecord.collaborationMode)
  const settings = asRecord(collaborationMode?.settings)
  if (!collaborationMode || !settings) return params
  if (readNonEmptyString(settings.model_provider) === modelProvider) return params

  return {
    ...paramsRecord,
    collaborationMode: {
      ...collaborationMode,
      settings: {
        ...settings,
        model_provider: modelProvider,
      },
    },
  }
}

function buildWrapperRuntimeState(
  currentState: FreeModeState,
  provider: RuntimeProviderId,
  params: unknown,
): FreeModeState {
  const paramsRecord = asRecord(params)
  const requestedModel = readNonEmptyString(paramsRecord?.model).trim()
  const dynamicDescriptor = readCodexUiProviderDescriptor(provider)
  const dynamicSelection = dynamicDescriptor
    ? getCodexUiProviderCatalogSelection(dynamicDescriptor, currentState.model)
    : null
  const fallbackModel = dynamicSelection?.currentModel
    || (provider === CURSOR_PROVIDER_ID
    ? getCursorModelSelection(currentState.model).currentModel
    : provider === ARK_PROVIDER_ID
      ? getArkModelSelection(currentState.model).currentModel
      : getMoonBridgeModels()[0] ?? currentState.model)
  const state: FreeModeState = {
    ...currentState,
    enabled: true,
    apiKey: null,
    model: requestedModel || fallbackModel || currentState.model,
    customKey: false,
    provider,
    customBaseUrl: undefined,
    wireApi: undefined,
  }
  return normalizeFreeModeState(state) ?? state
}

function readConfiguredProviderOptions(): Array<{ id: string; label: string }> {
  return readCodexUiProviderDescriptors().map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
  }))
}

function isCodexUiConfiguredRuntimeProvider(provider: string): boolean {
  const descriptor = readCodexUiProviderDescriptor(provider)
  return Boolean(descriptor && (!isWrapperProvider(provider) || descriptor.hasUiConfig))
}

function normalizeFreeModeProviderType(value: unknown): string {
  const provider = readNonEmptyString(value).trim().toLowerCase()
  if (provider === 'openrouter' || provider === FREE_MODE_PROVIDER_ID) return 'openrouter'
  if (provider === 'opencode-zen') return OPENCODE_ZEN_PROVIDER_ID
  if (provider === 'custom' || provider === 'custom-endpoint') return 'custom'
  if (provider === MOONBRIDGE_PROVIDER_ID) return MOONBRIDGE_PROVIDER_ID
  if (provider === ARK_PROVIDER_ID) return ARK_PROVIDER_ID
  if (provider === CURSOR_PROVIDER_ID) return CURSOR_PROVIDER_ID
  if (isCodexUiConfiguredRuntimeProvider(provider)) return provider
  return 'custom'
}

function providerUsesStoredApiKey(provider: string): boolean {
  return provider === 'openrouter' || provider === 'custom' || provider === OPENCODE_ZEN_PROVIDER_ID
}

async function resolveProviderStateModel(
  provider: string,
  currentModel: string | null | undefined,
  baseUrl: string,
  apiKey: string,
): Promise<string> {
  if (provider === 'openrouter') return currentModel || FREE_MODE_DEFAULT_MODEL
  if (provider === 'custom') return await fetchCustomEndpointDefaultModel(baseUrl, apiKey)
  if (provider === MOONBRIDGE_PROVIDER_ID && !isCodexUiConfiguredRuntimeProvider(provider)) {
    const moonModels = getMoonBridgeModels()
    const normalizedCurrentModel = currentModel?.trim() ?? ''
    return normalizedCurrentModel && moonModels.includes(normalizedCurrentModel)
      ? normalizedCurrentModel
      : moonModels[0] ?? ''
  }
  if (provider === ARK_PROVIDER_ID && !isCodexUiConfiguredRuntimeProvider(provider)) {
    return getArkModelSelection(currentModel).currentModel
  }
  if (provider === CURSOR_PROVIDER_ID && !isCodexUiConfiguredRuntimeProvider(provider)) {
    return getCursorModelSelection(currentModel).currentModel
  }

  const descriptor = readCodexUiProviderDescriptor(provider)
  if (descriptor) {
    const models = await readCodexUiProviderModelIds(descriptor, currentModel)
    return models.data[0] ?? ''
  }

  return OPENCODE_ZEN_DEFAULT_MODEL
}

type SharedBridgeState = {
  version: string
  runtimePool: AppServerRuntimePool
  terminalManager: ThreadTerminalManager
  methodCatalog: MethodCatalog
  telegramBridge: TelegramThreadBridge
}

const SHARED_BRIDGE_KEY = '__codexRemoteSharedBridge__'
const SHARED_BRIDGE_EXIT_CLEANUP_KEY = '__codexRemoteSharedBridgeExitCleanup__'
const SHARED_BRIDGE_VERSION = 'experimental-api-v2'

type SharedBridgeStateLike = Partial<SharedBridgeState> & {
  version?: string
  appServer?: AppServerProcess
  backendQueueProcessor?: BackendQueueProcessor
}

type SharedBridgeGlobalScope = typeof globalThis & {
  [SHARED_BRIDGE_KEY]?: SharedBridgeStateLike
  [SHARED_BRIDGE_EXIT_CLEANUP_KEY]?: boolean
}

function getSharedBridgeGlobalScope(): SharedBridgeGlobalScope {
  return globalThis as SharedBridgeGlobalScope
}

function disposeSharedBridgeState(state: SharedBridgeStateLike, globalScope = getSharedBridgeGlobalScope()): void {
  if (globalScope[SHARED_BRIDGE_KEY] === state) {
    delete globalScope[SHARED_BRIDGE_KEY]
  }
  state.telegramBridge?.stop()
  state.runtimePool?.dispose()
  state.backendQueueProcessor?.dispose()
  state.appServer?.dispose()
  state.terminalManager?.dispose()
}

function disposeCurrentSharedBridgeState(globalScope = getSharedBridgeGlobalScope()): void {
  const current = globalScope[SHARED_BRIDGE_KEY]
  if (!current) return
  disposeSharedBridgeState(current, globalScope)
}

function ensureSharedBridgeExitCleanup(globalScope: SharedBridgeGlobalScope): void {
  if (globalScope[SHARED_BRIDGE_EXIT_CLEANUP_KEY]) return
  globalScope[SHARED_BRIDGE_EXIT_CLEANUP_KEY] = true
  process.once('exit', () => {
    disposeCurrentSharedBridgeState(globalScope)
  })
}

function isCompleteSharedBridgeState(state: SharedBridgeStateLike): state is SharedBridgeState {
  return Boolean(
    state.runtimePool &&
    state.terminalManager &&
    state.methodCatalog &&
    state.telegramBridge,
  )
}

function getSharedBridgeState(): SharedBridgeState {
  const globalScope = getSharedBridgeGlobalScope()
  ensureSharedBridgeExitCleanup(globalScope)

  const existing = globalScope[SHARED_BRIDGE_KEY]
  if (existing) {
    if (existing.version === SHARED_BRIDGE_VERSION && isCompleteSharedBridgeState(existing)) {
      return existing
    }
    disposeCurrentSharedBridgeState(globalScope)
  }

  const runtimePool = new AppServerRuntimePool()
  const terminalManager = new ThreadTerminalManager()
  const created: SharedBridgeState = {
    version: SHARED_BRIDGE_VERSION,
    runtimePool,
    terminalManager,
    methodCatalog: new MethodCatalog(),
    telegramBridge: new TelegramThreadBridge(() => runtimePool.getActiveAppServer(), {
      onChatSeen: (chatId) => {
        void rememberTelegramChatId(chatId).catch(() => {})
      },
      subscribeNotifications: (listener) => runtimePool.subscribeNotifications(listener),
    }),
  }
  globalScope[SHARED_BRIDGE_KEY] = created
  return created
}

type PreparedThreadReadResult = {
  record: Record<string, unknown>
  thread: Record<string, unknown>
  turns: unknown[]
}

type ThreadTurnSliceResponse = {
  result: unknown
  startTurnIndex: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
}

async function readPreparedThreadReadResult(appServer: AppServerProcess, threadId: string): Promise<PreparedThreadReadResult> {
  const threadReadResult = await appServer.readThreadForTurnPage(threadId)
  const recoveredThreadReadResult = await mergeRecoveredTurnItemsIntoThreadResultFromSession(appServer, threadReadResult)
  const inheritedThreadReadResult = await mergePaginatedForkHistoryIntoThreadResultFromSession(
    appServer,
    recoveredThreadReadResult,
  )
  const enrichedThreadReadResult = await mergeSessionModelStateIntoThreadResult(inheritedThreadReadResult, appServer)
  const record = asRecord(enrichedThreadReadResult)
  const thread = asRecord(record?.thread)
  if (!record || !thread) {
    throw new Error('thread/read returned an invalid thread response')
  }

  return {
    record,
    thread,
    turns: Array.isArray(thread.turns) ? thread.turns : [],
  }
}

async function finalizeThreadReadResult(record: Record<string, unknown>, thread: Record<string, unknown>, turns: unknown[], startTurnIndex: number): Promise<unknown> {
  const pagedResult = {
    ...record,
    threadTurnStartIndex: startTurnIndex,
    thread: {
      ...thread,
      turns,
    },
  }
  const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', pagedResult)
  return mergeSessionSkillInputsIntoThreadResult(sanitized)
}

async function readThreadTurnSlice(
  appServer: AppServerProcess,
  threadId: string,
  startIndex: number,
  endIndex: number,
  prepared?: PreparedThreadReadResult,
): Promise<ThreadTurnSliceResponse> {
  const { record, thread, turns } = prepared ?? await readPreparedThreadReadResult(appServer, threadId)
  const rawStart = Math.floor(startIndex)
  const rawEnd = Math.floor(endIndex)
  const safeStart = Number.isFinite(rawStart) ? Math.max(0, Math.min(turns.length, rawStart)) : 0
  const safeEnd = Number.isFinite(rawEnd) ? Math.max(safeStart, Math.min(turns.length, rawEnd)) : safeStart
  const result = await finalizeThreadReadResult(record, thread, turns.slice(safeStart, safeEnd), safeStart)

  return {
    result,
    startTurnIndex: safeStart,
    hasMoreOlder: safeStart > 0,
    hasMoreNewer: safeEnd < turns.length,
  }
}

async function readFullSearchableThreadResult(appServer: AppServerProcess, threadId: string): Promise<unknown> {
  const { record, thread, turns } = await readPreparedThreadReadResult(appServer, threadId)
  return finalizeThreadReadResult(record, thread, turns, readThreadTurnStartIndex(record))
}

async function loadAllThreadsForSearch(appServer: AppServerProcess): Promise<ThreadSearchDocument[]> {
  const threads: Array<{ id: string; title: string; preview: string }> = []
  let cursor: string | null = null

  do {
    const response = asRecord(await appServer.rpc('thread/list', {
      archived: false,
      limit: 100,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor,
    }))
    const data = Array.isArray(response?.data) ? response.data : []
    for (const row of data) {
      const record = asRecord(row)
      const id = typeof record?.id === 'string' ? record.id : ''
      if (!id) continue
      const title = typeof record?.name === 'string' && record.name.trim().length > 0
        ? record.name.trim()
        : (typeof record?.preview === 'string' && record.preview.trim().length > 0 ? record.preview.trim() : 'Untitled thread')
      const preview = typeof record?.preview === 'string' ? record.preview : ''
      threads.push({ id, title, preview })
    }
    cursor = typeof response?.nextCursor === 'string' && response.nextCursor.length > 0 ? response.nextCursor : null
  } while (cursor)

  const docs: ThreadSearchDocument[] = threads.map((thread) => {
    const searchableText = [thread.title, thread.preview].filter(Boolean).join('\n')
    return {
      id: thread.id,
      title: thread.title,
      preview: thread.preview,
      messageText: '',
      searchableText,
    } satisfies ThreadSearchDocument
  })

  const docsById = new Map<string, ThreadSearchDocument>(docs.map((doc) => [doc.id, doc]))
  const fullTextThreads = threads.slice(0, THREAD_SEARCH_FULL_TEXT_THREAD_LIMIT)
  const concurrency = 4
  for (let offset = 0; offset < fullTextThreads.length; offset += concurrency) {
    const batch = fullTextThreads.slice(offset, offset + concurrency)
    const loaded = await Promise.all(batch.map(async (thread) => {
      try {
        const readResponse = await appServer.rpc('thread/read', {
          threadId: thread.id,
          includeTurns: true,
        })
        const messageText = extractThreadMessageText(readResponse)
        const searchableText = [thread.title, thread.preview, messageText].filter(Boolean).join('\n')
        return [thread.id, {
          id: thread.id,
          title: thread.title,
          preview: thread.preview,
          messageText,
          searchableText,
        } satisfies ThreadSearchDocument] as const
      } catch {
        return null
      }
    }))
    for (const row of loaded) {
      if (!row) continue
      docsById.set(row[0], row[1])
    }
  }

  return Array.from(docsById.values())
}

async function buildThreadSearchIndex(appServer: AppServerProcess): Promise<ThreadSearchIndex> {
  const docs = await loadAllThreadsForSearch(appServer)
  const docsById = new Map<string, ThreadSearchDocument>(docs.map((doc) => [doc.id, doc]))
  return { docsById }
}

export function createCodexBridgeMiddleware(): CodexBridgeMiddleware {
  const sharedBridgeState = getSharedBridgeState()
  const runtimePool = sharedBridgeState.runtimePool
  const terminalManager = sharedBridgeState.terminalManager
  const methodCatalog = sharedBridgeState.methodCatalog
  const telegramBridge = sharedBridgeState.telegramBridge
  let threadSearchIndex: ThreadSearchIndex | null = null
  let threadSearchIndexPromise: Promise<ThreadSearchIndex> | null = null

  function getActiveRuntime(): AppServerRuntime {
    return runtimePool.getActiveRuntime()
  }

  function getActiveAppServer(): AppServerProcess {
    return getActiveRuntime().appServer
  }

  function getActiveBackendQueueProcessor(): BackendQueueProcessor {
    return getActiveRuntime().backendQueueProcessor
  }

  function getRpcRuntime(method: string, params: unknown): AppServerRuntime {
    const requestedProvider = readRequestedRuntimeProvider(method, params)
    if (!requestedProvider) return getActiveRuntime()

    const state = buildWrapperRuntimeState(runtimePool.getActiveState(), requestedProvider, params)
    return runtimePool.getRuntimeForState(state)
  }

  function getRpcAppServer(method: string, params: unknown): AppServerProcess {
    return getRpcRuntime(method, params).appServer
  }

  async function applyActiveFreeModeState(state: FreeModeState): Promise<void> {
    const currentState = runtimePool.getActiveState()
    getAppServerRuntimeSignature(state)
    await persistFreeModeState(state)
    runtimePool.setActiveState(state)
    if (hasFreeModeStateChanged(currentState, state)) {
      threadSearchIndex = null
      threadSearchIndexPromise = null
    }
  }

  async function getThreadSearchIndex(): Promise<ThreadSearchIndex> {
    if (threadSearchIndex) return threadSearchIndex
    if (!threadSearchIndexPromise) {
      threadSearchIndexPromise = buildThreadSearchIndex(getActiveAppServer())
        .then((index) => {
          threadSearchIndex = index
          return index
        })
        .finally(() => {
          threadSearchIndexPromise = null
        })
    }
    return threadSearchIndexPromise
  }
  void readTelegramBridgeConfig()
    .then((config) => {
      if (!config.botToken) return
      telegramBridge.configureToken(config.botToken)
      telegramBridge.configureAllowedUserIds(config.allowedUserIds)
      telegramBridge.start()
    })
    .catch(() => {})

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url) {
      next()
      return
    }

    const parsedRequestUrl = new URL(req.url, 'http://localhost')
    const requestPath = parsedRequestUrl.pathname
    if (!requestPath.startsWith('/codex-api/')) {
      next()
      return
    }

    const requestStartNs = process.hrtime.bigint()
    const requestMethod = req.method ?? 'UNKNOWN'
    const rawContentLength = Array.isArray(req.headers['content-length'])
      ? req.headers['content-length'][0]
      : req.headers['content-length']
    const parsedContentLength = rawContentLength ? Number.parseInt(rawContentLength, 10) : NaN
    let requestBodyBytes: number | null = Number.isFinite(parsedContentLength) && parsedContentLength >= 0
      ? parsedContentLength
      : null
    let responseBodyBytes = 0
    let rpcMethod: string | null = null
    const originalWrite = res.write.bind(res)
    const originalEnd = res.end.bind(res)
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      const resolvedEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined
      responseBodyBytes += getChunkByteLength(chunk, resolvedEncoding)
      return originalWrite(chunk as never, encoding as never, cb as never)
    }) as typeof res.write
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      const resolvedEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : undefined
      responseBodyBytes += getChunkByteLength(chunk, resolvedEncoding)
      return originalEnd(chunk as never, encoding as never, cb as never)
    }) as typeof res.end
    let didLog = false
    const logApiRequestDuration = () => {
      if (!API_PERF_LOGGING_ENABLED || didLog || !requestPath.startsWith('/codex-api/')) return
      const durationMs = Number((process.hrtime.bigint() - requestStartNs) / 1_000_000n)
      const requestBytes = requestBodyBytes ?? 0
      const bodyMbValue = (requestBytes + responseBodyBytes) / MB_DIVISOR
      const shouldLog = durationMs > API_PERF_MS_THRESHOLD || bodyMbValue > API_PERF_BODY_MB_THRESHOLD
      if (!shouldLog) return
      didLog = true
      const rpcPart = rpcMethod ? `, rpcMethod=${rpcMethod}` : ''
      console.info(`[codex-api-perf] ${requestMethod} ${requestPath} -> ${res.statusCode} (${durationMs}ms, bodyMB=${bodyMbValue.toFixed(1)}${rpcPart})`)
    }
    res.once('finish', logApiRequestDuration)
    res.once('close', logApiRequestDuration)

    try {
      const url = parsedRequestUrl
      let resolvedAppServer: AppServerProcess | null = null
      let resolvedBackendQueueProcessor: BackendQueueProcessor | null = null
      const appServer = createLazyBridgeDependency(() => {
        resolvedAppServer ??= getActiveAppServer()
        return resolvedAppServer
      })
      const backendQueueProcessor = createLazyBridgeDependency(() => {
        resolvedBackendQueueProcessor ??= getActiveBackendQueueProcessor()
        return resolvedBackendQueueProcessor
      })

      if (url.pathname === '/codex-api/zen-proxy/v1/responses' && req.method === 'POST') {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
          setJson(res, 403, { error: 'Zen proxy is only available from localhost' })
          return
        }
        let bearerToken = ''
        let wireApi: 'responses' | 'chat' = 'chat'
        const state = appServer.getFreeModeState()
        bearerToken = state.apiKey ?? ''
        wireApi = state.wireApi === 'responses' ? 'responses' : 'chat'
        handleZenProxyRequest(req, res, bearerToken, wireApi)
        return
      }

      if (url.pathname === '/codex-api/openrouter-proxy/v1/responses' && req.method === 'POST') {
        let bearerToken = ''
        let wireApi: 'responses' | 'chat' = 'responses'
        const state = appServer.getFreeModeState()
        bearerToken = state.apiKey ?? ''
        wireApi = state.wireApi === 'chat' ? 'chat' : 'responses'
        handleOpenRouterProxyRequest(req, res, bearerToken, wireApi)
        return
      }

      if (url.pathname === '/codex-api/custom-proxy/v1/responses' && req.method === 'POST') {
        let bearerToken = ''
        let wireApi: 'responses' | 'chat' = 'responses'
        let baseUrl = ''
        const state = appServer.getFreeModeState()
        bearerToken = state.apiKey ?? ''
        wireApi = state.wireApi === 'chat' ? 'chat' : 'responses'
        baseUrl = state.customBaseUrl ?? ''
        handleCustomEndpointProxyRequest(req, res, { baseUrl, bearerToken, wireApi })
        return
      }

      if (url.pathname.startsWith('/codex-api/free-mode')) {
        function readFreeModeState(): FreeModeState {
          return appServer.getFreeModeState()
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode') {
          try {
            const body = await readJsonBody(req) as Record<string, unknown> | null
            const enable = Boolean(body?.enable)

            if (enable) {
              const apiKey = getRandomFreeKey()
              if (!apiKey) {
                setJson(res, 500, { error: 'No free keys available' })
                return
              }

              const prev = readFreeModeState()
              const prevKeys = { ...(prev.providerKeys ?? {}) }
              if (prev.provider && prev.apiKey) {
                prevKeys[prev.provider] = prev.apiKey
              }
              const state: FreeModeState = {
                enabled: true,
                apiKey,
                model: FREE_MODE_DEFAULT_MODEL,
                provider: 'openrouter',
                wireApi: prev.wireApi === 'chat' ? 'chat' : 'responses',
                providerKeys: prevKeys,
              }
              await applyActiveFreeModeState(state)
              const freeModels = await getFreeModels()
              setJson(res, 200, {
                ok: true,
                enabled: true,
                model: FREE_MODE_DEFAULT_MODEL,
                keyCount: getFreeKeyCount(),
                models: freeModels,
              })
            } else {
              const prev = readFreeModeState()
              const prevKeys = { ...(prev.providerKeys ?? {}) }
              if (prev.provider && prev.apiKey) {
                prevKeys[prev.provider] = prev.apiKey
              }
              const state: FreeModeState = {
                enabled: false,
                apiKey: null,
                model: FREE_MODE_DEFAULT_MODEL,
                wireApi: prev.wireApi === 'chat' ? 'chat' : 'responses',
                providerKeys: prevKeys,
              }
              await applyActiveFreeModeState(state)
              setJson(res, 200, { ok: true, enabled: false })
            }
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to toggle free mode') })
          }
          return
        }

        if (req.method === 'GET' && url.pathname === '/codex-api/free-mode/status') {
          try {
            const state = readFreeModeState()
            const providerOptions = readConfiguredProviderOptions()
            const maskedKey = state.apiKey && state.customKey
              ? state.apiKey.substring(0, 12) + '...' + state.apiKey.substring(state.apiKey.length - 4)
              : null
            let models = getCachedFreeModels()
            let currentModel = state.enabled ? state.model : null
            let wireApi = state.wireApi ?? null
            const activeDescriptor = state.provider ? readCodexUiProviderDescriptor(state.provider) : null
            if (activeDescriptor && (!isWrapperProvider(state.provider) || activeDescriptor.hasUiConfig)) {
              const dynamicModels = await readCodexUiProviderModelIds(activeDescriptor, state.model)
              models = dynamicModels.data
              currentModel = state.enabled ? dynamicModels.data[0] ?? activeDescriptor.defaultModel ?? state.model : null
              wireApi = activeDescriptor.executable ? null : wireApi
            } else if (state.provider === MOONBRIDGE_PROVIDER_ID) {
              models = getMoonBridgeModels()
              wireApi = null
            } else if (state.provider === ARK_PROVIDER_ID) {
              const arkSelection = getArkModelSelection(state.model)
              models = arkSelection.models
              currentModel = state.enabled ? arkSelection.currentModel : null
              wireApi = null
            } else if (state.provider === CURSOR_PROVIDER_ID) {
              const cursorSelection = getCursorModelSelection(state.model)
              models = cursorSelection.models
              currentModel = state.enabled ? cursorSelection.currentModel : null
              wireApi = null
            } else if (state.provider === OPENCODE_ZEN_PROVIDER_ID) {
              currentModel = state.enabled ? (state.model?.trim() || OPENCODE_ZEN_DEFAULT_MODEL) : null
              try {
                const zenModels = sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(state.apiKey))
                if (zenModels.length > 0) {
                  models = zenModels
                } else {
                  models = [
                    OPENCODE_ZEN_DEFAULT_MODEL,
                    'minimax-m2.5-free',
                    'nemotron-3-super-free',
                    'trinity-large-preview-free',
                  ]
                }
              } catch {
                models = [
                  OPENCODE_ZEN_DEFAULT_MODEL,
                  'minimax-m2.5-free',
                  'nemotron-3-super-free',
                  'trinity-large-preview-free',
                ]
              }
              wireApi = 'responses'
            } else if (!state.provider || state.provider === 'openrouter') {
              refreshFreeModelsInBackground()
            } else {
              models = []
            }
            setJson(res, 200, {
              enabled: state.enabled,
              keyCount: getFreeKeyCount(),
              models,
              currentModel,
              customKey: Boolean(state.customKey),
              maskedKey,
              provider: state.provider ?? 'openrouter',
              providers: providerOptions,
              customBaseUrl: state.customBaseUrl ?? null,
              wireApi,
            })
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to read free mode status') })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode/rotate-key') {
          try {
            const apiKey = getRandomFreeKey()
            if (!apiKey) {
              setJson(res, 500, { error: 'No free keys available' })
              return
            }
            const current = readFreeModeState()
            const state: FreeModeState = { ...current, apiKey, customKey: false }
            await applyActiveFreeModeState(state)
            setJson(res, 200, { ok: true })
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to rotate key') })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode/custom-key') {
          try {
            const body = await readJsonBody(req) as Record<string, unknown> | null
            const key = typeof body?.key === 'string' ? body.key.trim() : ''
            const current = readFreeModeState()

            if (key.length > 0) {
              const state: FreeModeState = {
                ...current,
                enabled: true,
                apiKey: key,
                customKey: true,
                provider: 'openrouter',
                wireApi: current.wireApi === 'chat' ? 'chat' : 'responses',
              }
              await applyActiveFreeModeState(state)
              setJson(res, 200, { ok: true, customKey: true })
            } else {
              const communityKey = getRandomFreeKey()
              const state: FreeModeState = {
                ...current,
                apiKey: communityKey,
                customKey: false,
                provider: 'openrouter',
                wireApi: current.wireApi === 'chat' ? 'chat' : 'responses',
              }
              await applyActiveFreeModeState(state)
              setJson(res, 200, { ok: true, customKey: false })
            }
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to set custom key') })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/codex-api/free-mode/custom-provider') {
          try {
            const body = await readJsonBody(req) as Record<string, unknown> | null
            const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
            const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
            const wireApi = body?.wireApi === 'chat' ? 'chat' as const : 'responses' as const
            const providerType = normalizeFreeModeProviderType(body?.provider)
            if (providerType === 'custom' && !baseUrl) {
              setJson(res, 400, { error: 'baseUrl is required' })
              return
            }
            const current = readFreeModeState()
            const prevKeys = { ...(current.providerKeys ?? {}) }
            if (current.provider && current.apiKey) {
              prevKeys[current.provider] = current.apiKey
            }
            const keyBackedProvider = providerUsesStoredApiKey(providerType)
            const resolvedKey = keyBackedProvider ? apiKey || prevKeys[providerType] || '' : ''
            if (keyBackedProvider && resolvedKey) {
              prevKeys[providerType] = resolvedKey
            }
            const resolvedModel = await resolveProviderStateModel(providerType, current.model, baseUrl, resolvedKey)
            const wrapperLikeProvider = isWrapperProvider(providerType) || isCodexUiConfiguredRuntimeProvider(providerType)
            const state: FreeModeState = {
              enabled: true,
              apiKey: wrapperLikeProvider ? null : resolvedKey,
              model: resolvedModel,
              customKey: providerType === 'openrouter' ? current.customKey : !wrapperLikeProvider,
              provider: providerType,
              customBaseUrl: providerType === 'custom' ? baseUrl : undefined,
              wireApi: wrapperLikeProvider ? undefined : wireApi,
              providerKeys: prevKeys,
            }
            await applyActiveFreeModeState(state)
            setJson(res, 200, { ok: true })
          } catch (error) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to set custom provider') })
          }
          return
        }

        next()
        return
      }

      if (await handleAccountRoutes(req, res, url, { appServer })) {
        return
      }

      if (await handleSkillsRoutes(req, res, url, { appServer, readJsonBody })) {
        return
      }

      if (await handleReviewRoutes(req, res, url, { readJsonBody })) {
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal/status') {
        setJson(res, 200, terminalManager.getAvailability())
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal/quick-commands') {
        const cwd = url.searchParams.get('cwd')?.trim() ?? ''
        if (!cwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        try {
          setJson(res, 200, { commands: await listTerminalQuickCommands(cwd) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load terminal quick commands') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/attach') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const threadId = readNonEmptyString(body?.threadId)
        const cwd = readNonEmptyString(body?.cwd)
        if (!threadId || !cwd) {
          setJson(res, 400, { error: 'Missing threadId or cwd' })
          return
        }
        const session = terminalManager.attach({
          threadId,
          cwd,
          sessionId: readNonEmptyString(body?.sessionId) || undefined,
          cols: typeof body?.cols === 'number' ? body.cols : undefined,
          rows: typeof body?.rows === 'number' ? body.rows : undefined,
          newSession: body?.newSession === true,
        })
        setJson(res, 200, { session })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/input') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const sessionId = readNonEmptyString(body?.sessionId)
        const data = typeof body?.data === 'string' ? body.data : ''
        if (!sessionId) {
          setJson(res, 400, { error: 'Missing sessionId' })
          return
        }
        terminalManager.write(sessionId, data)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/resize') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const sessionId = readNonEmptyString(body?.sessionId)
        if (!sessionId) {
          setJson(res, 400, { error: 'Missing sessionId' })
          return
        }
        terminalManager.resize(sessionId, body?.cols, body?.rows)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-terminal/close') {
        const availability = terminalManager.getAvailability()
        if (!availability.available) {
          setJson(res, 503, { error: availability.reason || 'Integrated terminal is unavailable on this host' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const sessionId = readNonEmptyString(body?.sessionId)
        if (!sessionId) {
          setJson(res, 400, { error: 'Missing sessionId' })
          return
        }
        terminalManager.close(sessionId)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-terminal-snapshot') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        setJson(res, 200, { session: terminalManager.getSnapshotForThread(threadId) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/upload-file') {
        handleFileUpload(req, res)
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/debug-log') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (record) {
          writeDebugLog(
            typeof record.tag === 'string' ? record.tag : 'unknown',
            typeof record.message === 'string' ? record.message : JSON.stringify(payload ?? {}),
            asRecord(record.extra) ?? undefined,
          ).catch(() => {})
        }
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/rpc') {
        const payload = await readJsonBody(req)
        const body = asRecord(payload) as RpcProxyRequest | null
        if (payload !== null && payload !== undefined) {
          requestBodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
        }
        rpcMethod = body?.method && typeof body.method === 'string' ? body.method : null

	        if (!body || typeof body.method !== 'string' || body.method.length === 0) {
	          setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
	          return
	        }

	        if (body.method === 'generate-thread-title') {
	          setJson(res, 200, { result: { title: '' } })
	          return
	        }

	        if (body.method === 'account/rateLimits/read' && !(await hasUsableCodexAuth())) {
	          setJson(res, 200, { result: null })
	          return
	        }

        const rpcRuntime = getRpcRuntime(body.method, body.params ?? null)
        let effectiveRpcRuntime = rpcRuntime
        let effectiveRpcAppServer = rpcRuntime.appServer

        if (body.method === 'thread/archive') {
          const paramsRecord = asRecord(body.params)
          const threadId = readNonEmptyString(paramsRecord?.threadId)
          // Archives mutate the rollout on disk. Use the persisted model
          // selection to identify its writer: a generic runtime can read the
          // global thread store but cannot archive a rollout it does not own.
          let threadOwningRuntime: AppServerRuntime | null = threadId
            ? findRuntimeWithThreadState(runtimePool, threadId)
            : null
          if (threadId && !threadOwningRuntime) {
            try {
              const threadReadResult = await effectiveRpcAppServer.rpc('thread/read', {
                threadId,
                includeTurns: false,
              })
              const modelState = readThreadResultModelState(
                await mergeSessionModelStateIntoThreadResult(threadReadResult, effectiveRpcAppServer),
              )
              const provider = modelState.modelProvider.trim().toLowerCase()
              if (modelState.model && shouldUseProviderRuntime(provider)) {
                threadOwningRuntime = runtimePool.getRuntimeForState(
                  buildWrapperRuntimeState(runtimePool.getActiveState(), provider, { model: modelState.model }),
                )
              }
            } catch {
              // A missing or unreadable rollout can still be associated with
              // an in-memory runtime from a preceding thread/read.
            }
          }
          if (threadOwningRuntime && threadOwningRuntime !== effectiveRpcRuntime) {
            effectiveRpcRuntime = threadOwningRuntime
            effectiveRpcAppServer = threadOwningRuntime.appServer
          }
        }

        if (body.method === 'turn/interrupt') {
          const paramsRecord = asRecord(body.params)
          const threadId = readNonEmptyString(paramsRecord?.threadId)
          const turnId = readNonEmptyString(paramsRecord?.turnId)
          runtimePool.recordIntentionalInterrupt(threadId, turnId)
          writeDebugLog('rpc-turn-interrupt', 'RPC turn/interrupt received', {
            threadId,
            turnId,
          }).catch(() => {})

          // Route to the runtime that actually owns this thread. When the
          // frontend omits modelProvider (provider cache evicted on long
          // sessions), getRpcRuntime falls back to the active runtime which
          // may be a different provider than the one running the turn; the
          // interrupt then no-ops silently. Prefer the runtime that has
          // thread state for this thread.
          const threadOwningRuntime = threadId ? findRuntimeWithThreadState(runtimePool, threadId) : null
          if (threadOwningRuntime && threadOwningRuntime !== effectiveRpcRuntime) {
            effectiveRpcRuntime = threadOwningRuntime
            effectiveRpcAppServer = threadOwningRuntime.appServer
          }

          // Fire the soft interrupt in the background so the HTTP response
          // returns immediately and the UI feels instant. We do NOT force-kill
          // the codex app-server here because the same child process is shared
          // by every thread that has the same free-mode signature, so a kill
          // would cascade into unrelated sessions being aborted.
          const softInterruptRuntime = effectiveRpcRuntime
          const softInterruptAppServer = effectiveRpcAppServer
          const softInterruptMethod = body.method
          const softInterruptParams = body.params ?? null

          const softInterruptPromise = (async () => {
            try {
              const softParams = await rewriteOpenAiThreadModelProvider(softInterruptAppServer, softInterruptMethod, softInterruptParams)
              const softFinalParams = persistTurnStartModelProviderInCollaborationMode(softInterruptMethod, softParams)
              await ensureTurnStartRuntimeThreadState(softInterruptAppServer, softInterruptMethod, softFinalParams)
              try {
                await callRpcWithArchiveRecovery(softInterruptAppServer, softInterruptMethod, softFinalParams)
              } catch (softError) {
                if (isThreadNotFoundError(softError) && threadId) {
                  const fallbackRuntime = findRuntimeWithThreadState(runtimePool, threadId, softInterruptRuntime)
                  if (fallbackRuntime) {
                    try {
                      await callRpcWithArchiveRecovery(fallbackRuntime.appServer, softInterruptMethod, softFinalParams)
                    } catch (fallbackSoftError) {
                      if (!isNoActiveTurnToInterruptError(fallbackSoftError)) {
                        writeDebugLog('rpc-turn-interrupt-soft-failed', 'soft turn/interrupt failed on fallback runtime', {
                          threadId,
                          turnId,
                          error: getErrorMessage(fallbackSoftError, 'unknown'),
                        }).catch(() => {})
                      }
                    }
                    return
                  }
                }
                if (!isNoActiveTurnToInterruptError(softError)) {
                  writeDebugLog('rpc-turn-interrupt-soft-failed', 'soft turn/interrupt failed', {
                    threadId,
                    turnId,
                    error: getErrorMessage(softError, 'unknown'),
                  }).catch(() => {})
                }
              }
            } catch (softError) {
              writeDebugLog('rpc-turn-interrupt-soft-failed', 'soft turn/interrupt threw', {
                threadId,
                turnId,
                error: getErrorMessage(softError, 'unknown'),
              }).catch(() => {})
            }
          })()
          softInterruptPromise.catch(() => {})

          setJson(res, 200, { result: {} })
          return
        }
        const rewrittenRpcParams = await rewriteOpenAiThreadModelProvider(effectiveRpcAppServer, body.method, body.params ?? null)
        const rpcParams = persistTurnStartModelProviderInCollaborationMode(body.method, rewrittenRpcParams)
        let rpcResult: unknown
        try {
          await ensureTurnStartRuntimeThreadState(effectiveRpcAppServer, body.method, rpcParams)
          rpcResult = await callRpcWithArchiveRecovery(effectiveRpcAppServer, body.method, rpcParams)
        } catch (error) {
          const paramsRecord = asRecord(rpcParams)
          const threadId = readNonEmptyString(paramsRecord?.threadId)
          // A fork is intentionally sent without model/provider overrides so
          // it inherits the source session. If the active runtime changed
          // since that session was loaded, retry once on the runtime that
          // already owns the source thread instead of making the UI look like
          // the Fork action did nothing.
          const fallbackRuntime = isOwningRuntimeRetryMethod(body.method) && isThreadNotFoundError(error)
            ? findRuntimeWithThreadState(runtimePool, threadId, effectiveRpcRuntime)
            : null
          if (fallbackRuntime) {
            effectiveRpcRuntime = fallbackRuntime
            effectiveRpcAppServer = fallbackRuntime.appServer
            writeDebugLog('rpc-turn-runtime-fallback', 'Retrying turn RPC on runtime that has the thread state', {
              method: body.method,
              threadId,
            }).catch(() => {})
            try {
              rpcResult = await callRpcWithArchiveRecovery(effectiveRpcAppServer, body.method, rpcParams)
            } catch (fallbackError) {
              if (body.method === 'turn/interrupt' && isNoActiveTurnToInterruptError(fallbackError)) {
                writeDebugLog('rpc-turn-interrupt-no-active', 'turn/interrupt found no active turn; treating stop as settled', {
                  threadId,
                }).catch(() => {})
                setJson(res, 200, { result: {} })
                return
              }
              throw fallbackError
            }
          } else {
	          if (body.method === 'account/rateLimits/read' && isUnauthenticatedRateLimitError(error)) {
	            setJson(res, 200, { result: null })
	            return
	          }
	          if (body.method === 'thread/read' && isEmptyThreadReadError(error)) {
	            const params = asRecord(body.params)
	            const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
	            const snapshot = threadId ? effectiveRpcAppServer.getLastThreadReadSnapshot(threadId) : null
	            if (snapshot) {
	              setJson(res, 200, { result: await mergeSessionModelStateIntoThreadResult(snapshot, effectiveRpcAppServer) })
	              return
	            }
	          }
	          if (body.method === 'thread/read' && isPaginatedThreadReadError(error)) {
	            const params = asRecord(rpcParams)
	            const paginatedThreadId = readNonEmptyString(params?.threadId)
	            if (paginatedThreadId) {
	              rpcResult = await effectiveRpcAppServer.readThreadForTurnPage(paginatedThreadId)
	            } else {
	              throw error
	            }
	          } else {
            if (body.method === 'turn/interrupt' && isNoActiveTurnToInterruptError(error)) {
              writeDebugLog('rpc-turn-interrupt-no-active', 'turn/interrupt found no active turn; treating stop as settled', {
                threadId,
              }).catch(() => {})
              setJson(res, 200, { result: {} })
              return
            }
	            throw error
          }
          }
	        }
        const recoveredResult = THREAD_METHODS_WITH_TURNS.has(body.method)
          ? await mergeRecoveredTurnItemsIntoThreadResultFromSession(effectiveRpcAppServer, rpcResult)
          : rpcResult
        const inheritedHistoryResult = THREAD_METHODS_WITH_TURNS.has(body.method)
          ? await mergePaginatedForkHistoryIntoThreadResultFromSession(effectiveRpcAppServer, recoveredResult)
          : recoveredResult
        const trimmedResult = trimThreadTurnsInRpcResult(body.method, inheritedHistoryResult)
        const sanitizedResult = await sanitizeThreadTurnsInlinePayloads(body.method, trimmedResult)
        const skillMergedResult = THREAD_METHODS_WITH_TURNS.has(body.method)
          ? await mergeSessionSkillInputsIntoThreadResult(sanitizedResult)
          : sanitizedResult
        let result = skillMergedResult
        if (THREAD_METHODS_WITH_THREAD_SNAPSHOT.has(body.method)) {
          const explicitModelResult = mergeExplicitModelStateIntoThreadResult(skillMergedResult, rpcParams)
          result = explicitModelResult === skillMergedResult
            ? await mergeSessionModelStateIntoThreadResult(skillMergedResult, effectiveRpcAppServer)
            : await mergeSessionModelStateIntoThreadResult(explicitModelResult, effectiveRpcAppServer)
        }

        if (THREAD_METHODS_WITH_THREAD_SNAPSHOT.has(body.method)) {
          const rpcRecord = asRecord(result)
          const rpcThread = asRecord(rpcRecord?.thread)
          const rpcThreadId = typeof rpcThread?.id === 'string' ? rpcThread.id : ''
          if (rpcThreadId) {
            effectiveRpcAppServer.storeThreadReadSnapshot(rpcThreadId, result)
            recordRuntimeThreadState(runtimePool, rpcThreadId, effectiveRpcRuntime)
          }
        }

        if (
          body.method === 'thread/fork'
          || body.method === 'thread/archive'
          || body.method === 'thread/unarchive'
        ) {
          invalidatePaginatedForkThreadListRecoveryCache()
        }
        if (body.method === 'thread/archive') {
          const archivedThreadId = readNonEmptyString(asRecord(rpcParams)?.threadId)
          if (archivedThreadId) {
            await deleteCursorToolPayloadsForThread(archivedThreadId).catch(() => undefined)
            runtimePool.releaseThreadState(archivedThreadId)
          }
        }
        if (body.method === 'thread/list') {
          result = await recoverUnlistedPaginatedForksInThreadList(result, rpcParams, effectiveRpcAppServer)
          result = await decorateThreadListWithForkLineage(result)
        }

        setJson(res, 200, { result })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-turn-page') {
        try {
          const threadId = url.searchParams.get('threadId')?.trim() ?? ''
          const beforeTurnId = url.searchParams.get('beforeTurnId')?.trim() ?? ''
          const limitRaw = url.searchParams.get('limit')?.trim() ?? String(THREAD_RESPONSE_TURN_LIMIT)
          const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || THREAD_RESPONSE_TURN_LIMIT))
          if (!threadId) {
            setJson(res, 400, { error: 'Missing threadId' })
            return
          }

          const prepared = await readPreparedThreadReadResult(appServer, threadId)
          const { turns } = prepared
          const beforeIndex = beforeTurnId
            ? turns.findIndex((turn) => asRecord(turn)?.id === beforeTurnId)
            : turns.length
          if (beforeTurnId && beforeIndex < 0) {
            const emptyPage = await readThreadTurnSlice(appServer, threadId, 0, 0, prepared)
            setJson(res, 200, {
              result: emptyPage.result,
              startTurnIndex: emptyPage.startTurnIndex,
              hasMoreOlder: false,
            })
            return
          }

          const endIndex = beforeIndex
          const startIndex = Math.max(0, endIndex - limit)
          const page = await readThreadTurnSlice(appServer, threadId, startIndex, endIndex, prepared)

          setJson(res, 200, {
            result: page.result,
            startTurnIndex: page.startTurnIndex,
            hasMoreOlder: page.hasMoreOlder,
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load earlier thread messages') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-turn-window') {
        try {
          const threadId = url.searchParams.get('threadId')?.trim() ?? ''
          const centerTurnId = url.searchParams.get('centerTurnId')?.trim() ?? ''
          const beforeRaw = url.searchParams.get('before')?.trim() ?? '8'
          const afterRaw = url.searchParams.get('after')?.trim() ?? '8'
          const before = Math.max(0, Math.min(50, Number.parseInt(beforeRaw, 10) || 8))
          const after = Math.max(0, Math.min(50, Number.parseInt(afterRaw, 10) || 8))
          if (!threadId) {
            setJson(res, 400, { error: 'Missing threadId' })
            return
          }
          if (!centerTurnId) {
            setJson(res, 400, { error: 'Missing centerTurnId' })
            return
          }

          const prepared = await readPreparedThreadReadResult(appServer, threadId)
          const { turns } = prepared
          const bounds = getThreadTurnWindowBounds(turns, centerTurnId, before, after)
          if (!bounds) {
            setJson(res, 404, { error: 'centerTurnId was not found in thread' })
            return
          }

          const page = await readThreadTurnSlice(appServer, threadId, bounds.startIndex, bounds.endIndex, prepared)
          setJson(res, 200, {
            result: page.result,
            startTurnIndex: page.startTurnIndex,
            hasMoreOlder: page.hasMoreOlder,
            hasMoreNewer: page.hasMoreNewer,
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load thread message window') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-message-search') {
        try {
          const payload = asRecord(await readJsonBody(req))
          const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
          const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
          const limitRaw = typeof payload?.limit === 'number' ? payload.limit : THREAD_MESSAGE_SEARCH_DEFAULT_LIMIT
          const limit = normalizeBoundedInteger(limitRaw, THREAD_MESSAGE_SEARCH_DEFAULT_LIMIT, 1, THREAD_MESSAGE_SEARCH_MAX_LIMIT)
          if (!threadId) {
            setJson(res, 400, { error: 'Missing threadId' })
            return
          }
          if (!query) {
            setJson(res, 200, {
              data: {
                threadId,
                query: '',
                totalMatches: 0,
                truncated: false,
                results: [],
              },
            })
            return
          }

          const threadReadResult = await readFullSearchableThreadResult(appServer, threadId)
          setJson(res, 200, {
            data: searchThreadMessagesInPayload(threadId, query, threadReadResult, limit),
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to search thread messages') })
        }
        return
      }

      if (
        req.method === 'GET'
        && (
          url.pathname === '/codex-api/thread-user-message-navigation'
          || url.pathname === '/codex-api/thread-user-message-index'
          || url.pathname === '/codex-api/thread-user-message-count'
        )
      ) {
        try {
          const threadId = url.searchParams.get('threadId')?.trim() ?? ''
          if (!threadId) {
            setJson(res, 400, { error: 'Missing threadId' })
            return
          }

          const navigation = await readThreadUserMessageNavigation(appServer, threadId)
          if (url.pathname === '/codex-api/thread-user-message-index') {
            setJson(res, 200, { entries: navigation.entries })
          } else if (url.pathname === '/codex-api/thread-user-message-count') {
            setJson(res, 200, { count: navigation.count })
          } else {
            setJson(res, 200, navigation)
          }
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load thread user message navigation') })
        }
        return
      }

            if (req.method === 'GET' && url.pathname === '/codex-api/thread-message-history') {
        try {
          const threadId = url.searchParams.get('threadId')?.trim() ?? ''
          if (!threadId) {
            setJson(res, 400, { error: 'Missing threadId' })
            return
          }

          const threadReadResult = await appServer.readThreadForTurnPage(threadId)
          const recoveredThreadReadResult = await mergeRecoveredTurnItemsIntoThreadResultFromSession(appServer, threadReadResult)
          const inheritedThreadReadResult = await mergePaginatedForkHistoryIntoThreadResultFromSession(
            appServer,
            recoveredThreadReadResult,
          )
          const enrichedThreadReadResult = await mergeSessionModelStateIntoThreadResult(inheritedThreadReadResult, appServer)
          const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', enrichedThreadReadResult)
          const result = await mergeSessionSkillInputsIntoThreadResult(sanitized)

          setJson(res, 200, {
            result,
            startTurnIndex: 0,
            hasMoreOlder: false,
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load thread message history') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-file-change-fallback') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }

        const threadReadResult = await appServer.readThreadForTurnPage(threadId)
        const threadReadRecord = asRecord(threadReadResult)
        const threadRecord = asRecord(threadReadRecord?.thread)
        const sessionPath = readNonEmptyString(threadRecord?.path)
        if (!sessionPath || !isAbsolute(sessionPath)) {
          setJson(res, 200, { data: [] })
          return
        }

        try {
          const sessionLogRaw = (await readSessionRolloutSnapshot(sessionPath)).raw
          setJson(res, 200, { data: buildSessionFileChangeFallback(threadReadResult, sessionLogRaw) })
        } catch {
          setJson(res, 200, { data: [] })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-stream-events') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const limitRaw = url.searchParams.get('limit')?.trim() ?? '80'
        const limit = Math.max(1, Math.min(400, Number.parseInt(limitRaw, 10) || 80))
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        const events = appServer.getStreamEvents(threadId, limit)
        setJson(res, 200, { events })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-live-state') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }

        try {
          const threadReadResult = await appServer.readThreadForTurnPage(threadId)
          const sanitized = await sanitizeThreadTurnsInlinePayloads('thread/read', threadReadResult)
          appServer.storeThreadReadSnapshot(threadId, sanitized)

          const record = asRecord(sanitized)
          const thread = asRecord(record?.thread)
          const rawTurns = Array.isArray(thread?.turns) ? thread.turns : []

          const sessionPath = readNonEmptyString(thread?.path)
          let sessionSize = 0
          if (sessionPath && isAbsolute(sessionPath)) {
            try {
              sessionSize = (await readSessionRolloutSnapshot(sessionPath)).size
            } catch { /* missing */ }
          }

          const cached = appServer.getCachedLiveState(threadId, rawTurns.length, sessionSize)
          if (cached) {
            setJson(res, 200, cached)
            return
          }

          let turns = appServer.mergeItemsIntoTurns(threadId, rawTurns)

          if (sessionPath && isAbsolute(sessionPath) && sessionSize > 0) {
            try {
              const sessionLogRaw = (await readSessionRolloutSnapshot(sessionPath)).raw
              turns = mergeSessionCommandsIntoTurns(turns, sessionLogRaw)
            } catch {
              // Session log not available — continue without command recovery
            }
          }

          const lastTurn = turns.length > 0 ? asRecord(turns[turns.length - 1]) : null
          const isInProgress = lastTurn?.status === 'inProgress'

          const responseData = {
            threadId,
            conversationState: {
              turns,
            },
            ownerClientId: null,
            liveStateError: null,
            isInProgress,
          }

          if (!isInProgress) {
            appServer.cacheLiveState(threadId, responseData, rawTurns.length, sessionSize)
          }

          setJson(res, 200, responseData)
        } catch (error) {
          const snapshot = appServer.getLastThreadReadSnapshot(threadId)
          if (snapshot) {
            const record = asRecord(snapshot)
            const thread = asRecord(record?.thread)
            const rawTurns = Array.isArray(thread?.turns) ? thread.turns : []
            const turns = appServer.mergeItemsIntoTurns(threadId, rawTurns)
            setJson(res, 200, {
              threadId,
              conversationState: { turns },
              ownerClientId: null,
              liveStateError: {
                kind: 'readFailed',
                message: getErrorMessage(error, 'thread/read failed'),
              },
              isInProgress: false,
            })
          } else {
            setJson(res, 200, {
              threadId,
              conversationState: null,
              ownerClientId: null,
              liveStateError: {
                kind: 'readFailed',
                message: getErrorMessage(error, 'thread/read failed'),
              },
              isInProgress: false,
            })
          }
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread/rollback-files') {
        try {
          const body = asRecord(await readJsonBody(req))
          const threadId = readNonEmptyString(body?.threadId)
          const turnId = readNonEmptyString(body?.turnId)
          const cwd = readNonEmptyString(body?.cwd)
          if (!threadId || !turnId || !cwd) {
            setJson(res, 400, { error: 'Missing threadId, turnId, or cwd' })
            return
          }

          const threadReadResult = await appServer.readThreadForTurnPage(threadId)
          const record = asRecord(threadReadResult)
          const thread = asRecord(record?.thread)
          const turns = Array.isArray(thread?.turns) ? thread.turns : []
          const sessionPath = readNonEmptyString(thread?.path)

          if (!sessionPath || !isAbsolute(sessionPath)) {
            setJson(res, 200, { reverted: 0, errors: [], message: 'No session log available' })
            return
          }

          let foundTurnIndex = -1
          const turnIdsToRevert = new Set<string>()
          for (let i = 0; i < turns.length; i++) {
            const turnRecord = asRecord(turns[i])
            const id = readNonEmptyString(turnRecord?.id)
            if (id === turnId) {
              foundTurnIndex = i
            }
            if (foundTurnIndex >= 0 && id) {
              turnIdsToRevert.add(id)
            }
          }

          if (turnIdsToRevert.size === 0) {
            setJson(res, 200, { reverted: 0, errors: [], message: 'No turns to revert' })
            return
          }

          let sessionLogRaw: string
          try {
            sessionLogRaw = (await readSessionRolloutSnapshot(sessionPath)).raw
          } catch {
            setJson(res, 200, { reverted: 0, errors: ['Could not read session log'], message: 'Session log unreadable' })
            return
          }

          const turnInfos = collectFileChangesForTurns(sessionLogRaw, turnIdsToRevert, cwd)
          if (turnInfos.size === 0) {
            setJson(res, 200, { reverted: 0, errors: [], message: 'No file changes to revert' })
            return
          }

          const result = await revertTurnFileChanges(cwd, turnInfos)
          setJson(res, 200, { ...result, message: `Reverted ${result.reverted} file change(s)` })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to revert file changes') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/transcribe') {
        const auth = await readCodexAuth()
        if (!auth) {
          setJson(res, 401, { error: 'No auth token available for transcription' })
          return
        }

        const rawBody = await readRawBody(req)
        const incomingCt = req.headers['content-type'] ?? 'application/octet-stream'
        const upstream = await proxyTranscribe(rawBody, incomingCt, auth.accessToken, auth.accountId)

        res.statusCode = upstream.status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(upstream.body)
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/composio/status') {
        try {
          setJson(res, 200, await readComposioStatus())
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to read Composio status') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/composio/connectors') {
        try {
          const query = url.searchParams.get('query') ?? ''
          const cursor = url.searchParams.get('cursor')?.trim() ?? null
          const limit = parseComposioLimit(url.searchParams.get('limit'))
          setJson(res, 200, await listComposioConnectors(query, cursor, limit))
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to list Composio connectors') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/composio/connector') {
        try {
          const slug = url.searchParams.get('slug') ?? ''
          setJson(res, 200, await readComposioConnectorDetail(slug))
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load Composio connector') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composio/link') {
        try {
          const payload = asRecord(await readJsonBody(req))
          const slug = readNonEmptyString(payload?.slug)
          setJson(res, 200, await startComposioLink(slug))
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to start Composio login') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composio/login') {
        try {
          setJson(res, 200, await startComposioLogin())
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to start Composio CLI login') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composio/install') {
        try {
          setJson(res, 200, await installComposioCli())
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to install Composio CLI') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/connector-logo') {
        const src = url.searchParams.get('src')?.trim() ?? ''
        if (!src) {
          setJson(res, 400, { error: 'Missing src' })
          return
        }
        try {
          const logo = await fetchConnectorLogo(src)
          res.statusCode = 200
          res.setHeader('Content-Type', logo.contentType)
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.end(logo.body)
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch connector logo') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/server-requests/respond') {
        const payload = await readJsonBody(req)
        await appServer.respondToServerRequest(payload)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/server-requests/pending') {
        setJson(res, 200, { data: appServer.listPendingServerRequests() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/methods') {
        const methods = await methodCatalog.listMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/notifications') {
        const methods = await methodCatalog.listNotificationMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/moonbridge/models') {
        setJson(res, 200, { data: getMoonBridgeModels(), source: 'moon' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/moonbridge/model-metadata') {
        setJson(res, 200, { data: getMoonBridgeModelMetadata(), source: 'moon' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/ark/models') {
        setJson(res, 200, { data: getArkModels(), source: 'ark' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/ark/model-metadata') {
        setJson(res, 200, { data: getArkModelMetadata(), source: 'ark' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/provider-models') {
        try {
          const fmState = appServer.getFreeModeState()
          if (fmState.enabled) {
            const activeDescriptor = fmState.provider ? readCodexUiProviderDescriptor(fmState.provider) : null
            if (activeDescriptor && (!isWrapperProvider(fmState.provider) || activeDescriptor.hasUiConfig)) {
              const dynamicModels = await readCodexUiProviderModelIds(activeDescriptor, fmState.model)
              if (providerModelsUseCodexDefaultList(dynamicModels)) {
                setJson(res, 200, {
                  data: [],
                  exclusive: false,
                  providerId: activeDescriptor.id,
                  source: dynamicModels.source,
                })
                return
              }
              setJson(res, 200, {
                data: dynamicModels.data,
                exclusive: true,
                providerId: activeDescriptor.id,
                source: dynamicModels.source,
              })
              return
            }
            if (fmState.provider === MOONBRIDGE_PROVIDER_ID) {
              setJson(res, 200, { data: getMoonBridgeModels(), exclusive: true, source: 'moon' })
              return
            }
            if (fmState.provider === ARK_PROVIDER_ID) {
              const data = getArkModelSelection(fmState.model).models
              setJson(res, 200, { data, exclusive: true, providerId: ARK_PROVIDER_ID, source: 'ark' })
              return
            }
            if (fmState.provider === CURSOR_PROVIDER_ID) {
              const data = getCursorModelSelection(fmState.model).models
              setJson(res, 200, { data, exclusive: true, providerId: CURSOR_PROVIDER_ID, source: 'cursor' })
              return
            }
            if (fmState.provider === OPENCODE_ZEN_PROVIDER_ID) {
              try {
                const modelIds = sortOpenCodeZenModelIds(await fetchOpenCodeZenModelIds(fmState.apiKey))
                if (modelIds.length > 0) {
                  setJson(res, 200, { data: modelIds, exclusive: true, source: 'opencode-zen' })
                  return
                }
              } catch {
                // OpenCode Zen model fetch failed
              }
              setJson(res, 200, { data: ['big-pickle', 'minimax-m2.5-free', 'nemotron-3-super-free', 'trinity-large-preview-free'], exclusive: true, source: 'opencode-zen' })
              return
            }
            if (fmState.provider === 'custom' && fmState.customBaseUrl) {
              try {
                const modelsUrl = fmState.customBaseUrl.replace(/\/+$/, '') + '/models'
                const headers: Record<string, string> = {}
                if (fmState.apiKey && fmState.apiKey !== 'dummy') {
                  headers['Authorization'] = `Bearer ${fmState.apiKey}`
                }
                const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) })
                if (resp.ok) {
                  const json = await resp.json() as unknown
                  const ids = normalizeProviderModelsData(json)
                  const currentModel = fmState.model?.trim() ?? ''
                  const orderedIds = currentModel && ids.includes(currentModel)
                    ? [currentModel, ...ids.filter((id) => id !== currentModel)]
                    : ids
                  setJson(res, 200, { data: orderedIds, exclusive: true, source: 'custom' })
                  return
                }
              } catch {
                // Custom endpoint model fetch failed — return empty list
              }
              setJson(res, 200, { data: [], exclusive: true, source: 'custom' })
              return
            }
            const freeModels = await getFreeModels()
            setJson(res, 200, { data: freeModels, exclusive: true })
            return
          }
        } catch {
          // No free-mode state — proceed normally
        }
        const data = await readProviderBackedModelIds(appServer)
        setJson(res, 200, data)
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/workspace-roots-state') {
        const state = await readWorkspaceRootsState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-queue-state') {
        const state = await readThreadQueueState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/home-directory') {
        setJson(res, 200, { data: { path: homedir() } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/worktree/create') {
        const payload = asRecord(await readJsonBody(req))
        const rawSourceCwd = typeof payload?.sourceCwd === 'string' ? payload.sourceCwd.trim() : ''
        const baseBranch = typeof payload?.baseBranch === 'string' ? payload.baseBranch.trim() : ''
        if (!rawSourceCwd) {
          setJson(res, 400, { error: 'Missing sourceCwd' })
          return
        }

        const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
        try {
          const sourceInfo = await stat(sourceCwd)
          if (!sourceInfo.isDirectory()) {
            setJson(res, 400, { error: 'sourceCwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'sourceCwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            await runCommand('git', ['init'], { cwd: sourceCwd })
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          }
          const repoName = basename(gitRoot) || 'repo'
          const worktreesRoot = join(getCodexHomeDir(), 'worktrees')
          await mkdir(worktreesRoot, { recursive: true })

          // Match Codex desktop layout so project grouping resolves to repo name:
          // ~/.codex/worktrees/<id>/<repoName>
          let worktreeId = ''
          let worktreeParent = ''
          let worktreeCwd = ''
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const candidate = randomBytes(2).toString('hex')
            const parent = join(worktreesRoot, candidate)
            try {
              await stat(parent)
              continue
            } catch {
              worktreeId = candidate
              worktreeParent = parent
              worktreeCwd = join(parent, repoName)
              break
            }
          }
          if (!worktreeId || !worktreeParent || !worktreeCwd) {
            throw new Error('Failed to allocate a unique worktree id')
          }
          const startPoint = baseBranch || 'HEAD'

          await mkdir(worktreeParent, { recursive: true })
          try {
            await runCommand('git', ['worktree', 'add', '--detach', worktreeCwd, startPoint], { cwd: gitRoot })
          } catch (error) {
            if (!isMissingHeadError(error)) throw error
            await ensureRepoHasInitialCommit(gitRoot)
            await runCommand('git', ['worktree', 'add', '--detach', worktreeCwd, startPoint], { cwd: gitRoot })
          }
          try {
            await persistWorkspaceRoot(worktreeCwd)
          } catch (error) {
            await rollbackCreatedWorktree(gitRoot, worktreeCwd, worktreeParent)
            throw error
          }

          setJson(res, 200, {
            data: {
              cwd: worktreeCwd,
              branch: null,
              gitRoot,
            },
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to create worktree') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/worktree/create-permanent') {
        const payload = asRecord(await readJsonBody(req))
        const rawSourceCwd = typeof payload?.sourceCwd === 'string' ? payload.sourceCwd.trim() : ''
        const rawWorktreeName = typeof payload?.worktreeName === 'string' ? payload.worktreeName.trim() : ''
        if (!rawSourceCwd) {
          setJson(res, 400, { error: 'Missing sourceCwd' })
          return
        }
        if (!rawWorktreeName) {
          setJson(res, 400, { error: 'Missing worktreeName' })
          return
        }
        if (rawWorktreeName.includes('/') || rawWorktreeName.includes('\\') || rawWorktreeName === '.' || rawWorktreeName === '..') {
          setJson(res, 400, { error: 'Worktree name must be a single folder name' })
          return
        }

        const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
        try {
          const sourceInfo = await stat(sourceCwd)
          if (!sourceInfo.isDirectory()) {
            setJson(res, 400, { error: 'sourceCwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'sourceCwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            await runCommand('git', ['init'], { cwd: sourceCwd })
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          }
          const worktreeCwd = join(dirname(gitRoot), rawWorktreeName)
          try {
            await stat(worktreeCwd)
            setJson(res, 409, { error: 'Worktree folder already exists' })
            return
          } catch {
            // Expected for a new worktree path.
          }

          const branchName = await allocatePermanentWorktreeBranchName(gitRoot, rawWorktreeName)
          try {
            await runCommand('git', ['worktree', 'add', '-b', branchName, worktreeCwd, 'HEAD'], { cwd: gitRoot })
          } catch (error) {
            if (!isMissingHeadError(error)) throw error
            await ensureRepoHasInitialCommit(gitRoot)
            await runCommand('git', ['worktree', 'add', '-b', branchName, worktreeCwd, 'HEAD'], { cwd: gitRoot })
          }
          try {
            await persistWorkspaceRoot(worktreeCwd)
          } catch (error) {
            await rollbackCreatedWorktree(gitRoot, worktreeCwd, undefined, branchName)
            throw error
          }

          setJson(res, 200, {
            data: {
              cwd: worktreeCwd,
              branch: branchName,
              gitRoot,
            },
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to create worktree') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/worktree/branches') {
        const rawSourceCwd = (url.searchParams.get('sourceCwd') ?? '').trim()
        if (!rawSourceCwd) {
          setJson(res, 400, { error: 'Missing sourceCwd' })
          return
        }
        const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
        try {
          const sourceInfo = await stat(sourceCwd)
          if (!sourceInfo.isDirectory()) {
            setJson(res, 400, { error: 'sourceCwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'sourceCwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            setJson(res, 200, { data: [] })
            return
          }
          const output = await runCommandCapture(
            'git',
            ['for-each-ref', '--format=%(committerdate:unix)\t%(refname)', 'refs/heads', 'refs/remotes'],
            { cwd: gitRoot },
          )
          const branchActivityByName = new Map<string, number>()
          for (const line of output.split('\n')) {
            const [rawTimestamp = '', rawRefName = ''] = line.split('\t')
            const normalized = normalizeBranchRefName(rawRefName)
            if (!normalized || normalized === 'origin/HEAD') continue
            const parsedTimestamp = Number.parseInt(rawTimestamp.trim(), 10)
            const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
            const current = branchActivityByName.get(normalized) ?? Number.MIN_SAFE_INTEGER
            if (timestamp > current) {
              branchActivityByName.set(normalized, timestamp)
            }
          }

          const branches = Array.from(branchActivityByName.entries())
            .map(([value]) => ({ value, label: value }))
            .sort((a, b) => {
              const aActivity = branchActivityByName.get(a.value) ?? 0
              const bActivity = branchActivityByName.get(b.value) ?? 0
              if (bActivity !== aActivity) return bActivity - aActivity
              return a.value.localeCompare(b.value)
            })
          setJson(res, 200, { data: branches })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to list branches') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/branches') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const cwdInfo = await stat(cwd)
          if (!cwdInfo.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          let gitRoot = ''
          try {
            gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          } catch (error) {
            if (!isNotGitRepositoryError(error)) throw error
            setJson(res, 200, {
              data: {
                currentBranch: null,
                options: [],
              },
            })
            return
          }

          const state = await readGitHeaderState(gitRoot)
          const currentBranch = state.currentBranch
          const output = await runCommandCapture(
            'git',
            ['for-each-ref', '--format=%(committerdate:unix)\t%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes'],
            { cwd: gitRoot },
          )
          const branchActivityByName = new Map<string, { timestamp: number; isRemote: boolean }>()
          for (const line of output.split('\n')) {
            const [rawTimestamp = '', rawRefName = ''] = line.split('\t')
            const normalized = normalizeBranchRefName(rawRefName)
            if (!normalized || normalized === 'origin/HEAD') continue
            const parsedTimestamp = Number.parseInt(rawTimestamp.trim(), 10)
            const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
            const isRemote = rawRefName.trim().startsWith('refs/remotes/')
            const current = branchActivityByName.get(normalized)
            if (!current || timestamp > current.timestamp) {
              branchActivityByName.set(normalized, { timestamp, isRemote })
            }
          }
          if (currentBranch && !branchActivityByName.has(currentBranch)) {
            branchActivityByName.set(currentBranch, { timestamp: Number.MAX_SAFE_INTEGER, isRemote: false })
          }
          const options = Array.from(branchActivityByName.entries())
            .map(([value, metadata]) => ({
              value,
              label: value,
              isCurrent: value === currentBranch,
              isRemote: metadata.isRemote,
            }))
            .sort((a, b) => {
              const aActivity = branchActivityByName.get(a.value)?.timestamp ?? 0
              const bActivity = branchActivityByName.get(b.value)?.timestamp ?? 0
              if (bActivity !== aActivity) return bActivity - aActivity
              return a.value.localeCompare(b.value)
            })
          setJson(res, 200, {
            data: {
              ...state,
              options,
            },
          })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to read Git branches') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/repository-status') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const cwdInfo = await stat(cwd)
          if (!cwdInfo.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          setJson(res, 200, {
            data: {
              isGitRepo: true,
              gitRoot,
            },
          })
        } catch (error) {
          if (!isNotGitRepositoryError(error)) {
            setJson(res, 500, { error: getErrorMessage(error, 'Failed to read Git repository status') })
            return
          }
          setJson(res, 200, {
            data: {
              isGitRepo: false,
              gitRoot: '',
            },
          })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git/checkout') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const rawCwd = readNonEmptyString(record.cwd)
        const targetBranch = readNonEmptyString(record.branch)
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!targetBranch) {
          setJson(res, 400, { error: 'Missing branch' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const cwdInfo = await stat(cwd)
          if (!cwdInfo.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await assertNoTrackedGitChanges(gitRoot)
          await checkoutGitBranchWithWorktreeRecovery(gitRoot, targetBranch)
          setJson(res, 200, { data: await readGitHeaderState(gitRoot) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to switch branch') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/git/branch-commits') {
        const rawCwd = (url.searchParams.get('cwd') ?? '').trim()
        const branch = (url.searchParams.get('branch') ?? '').trim()
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!branch) {
          setJson(res, 400, { error: 'Missing branch' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await runCommandCapture('git', ['rev-parse', '--verify', `${branch}^{commit}`], { cwd: gitRoot })
          const resetHistoryRefPrefix = `refs/codex/header-git-reset-history/${branch}/`
          const resetHistoryRefsRaw = await runCommandCapture(
            'git',
            ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', resetHistoryRefPrefix],
            { cwd: gitRoot },
          ).catch(() => '')
          const resetHistoryRefs = resetHistoryRefsRaw
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .slice(0, HEADER_GIT_RESET_HISTORY_REF_LIMIT)
          const output = await runCommandCapture(
            'git',
            ['log', '-n', '12', '--date=short', '--format=%H%x09%h%x09%cd%x09%s', branch, ...resetHistoryRefs],
            { cwd: gitRoot },
          )
          const commits = output.split('\n').flatMap((line) => {
            const [sha = '', shortSha = '', date = '', ...subjectParts] = line.split('\t')
            const subject = subjectParts.join('\t').trim()
            return sha.trim() && shortSha.trim()
              ? [{ sha: sha.trim(), shortSha: shortSha.trim(), date: date.trim(), subject: subject || shortSha.trim() }]
              : []
          })
          setJson(res, 200, { data: commits })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to load branch commits') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/git/reset-to-commit') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const rawCwd = readNonEmptyString(record.cwd)
        const branch = readNonEmptyString(record.branch)
        const sha = readNonEmptyString(record.sha)
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!branch) {
          setJson(res, 400, { error: 'Missing branch' })
          return
        }
        if (!sha) {
          setJson(res, 400, { error: 'Missing commit' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
          await assertNoTrackedGitChanges(gitRoot)
          await assertLocalGitBranch(gitRoot, branch)
          const currentBranch = (await runCommandCapture('git', ['branch', '--show-current'], { cwd: gitRoot })).trim()
          if (currentBranch && currentBranch !== branch) {
            await checkoutGitBranchWithWorktreeRecovery(gitRoot, branch)
          } else if (!currentBranch) {
            await checkoutGitBranchWithWorktreeRecovery(gitRoot, branch)
          }
          const previousTip = await runCommandCapture('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })
          const targetSha = await runCommandCapture('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: gitRoot })
          await runCommand('git', ['update-ref', toHeaderGitResetHistoryRef(branch, previousTip.trim()), previousTip.trim()], { cwd: gitRoot })
          await pruneHeaderGitResetHistoryRefs(gitRoot, branch)
          await runCommand('git', ['reset', '--hard', targetSha.trim()], { cwd: gitRoot })
          setJson(res, 200, { data: await readGitHeaderState(gitRoot) })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to reset branch to commit') })
        }
        return
      }



      if (req.method === 'PUT' && url.pathname === '/codex-api/workspace-roots-state') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        await updateWorkspaceRootsState((existingState) => ({
          order: normalizeStringArray(record.order),
          labels: normalizeStringRecord(record.labels),
          active: normalizeStringArray(record.active),
          projectOrder: Array.isArray(record.projectOrder)
            ? normalizeStringArray(record.projectOrder)
            : existingState.projectOrder,
          remoteProjects: existingState.remoteProjects,
        }))
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-queue-state') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        await writeThreadQueueState(normalizeThreadQueueState(record))
        void backendQueueProcessor.scheduleAllQueuedThreads()
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-root') {
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        const createIfMissing = payload?.createIfMissing === true
        const label = typeof payload?.label === 'string' ? payload.label : ''
        if (!rawPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }

        const normalizedPath = normalizeLocalPathInput(rawPath)
        let pathExists = true
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          pathExists = false
        }

        if (!pathExists && createIfMissing) {
          await mkdir(normalizedPath, { recursive: true })
        } else if (!pathExists) {
          setJson(res, 404, { error: 'Directory does not exist' })
          return
        }

        await persistWorkspaceRoot(normalizedPath, label)
        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/local-directory') {
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        if (!rawPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }

        const normalizedPath = normalizeLocalPathInput(rawPath)
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          await mkdir(normalizedPath, { recursive: true })
        }

        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/github-clone') {
        const payload = asRecord(await readJsonBody(req))
        const repoUrl = typeof payload?.url === 'string' ? payload.url.trim() : ''
        const basePath = typeof payload?.basePath === 'string' ? payload.basePath.trim() : ''
        try {
          const clonedPath = await cloneGithubRepositoryIntoBase(repoUrl, basePath)
          setJson(res, 200, { data: { path: clonedPath } })
        } catch (error) {
          setJson(res, 400, { error: error instanceof Error ? error.message : 'Failed to clone GitHub repository' })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/projectless-thread-cwd') {
        const payload = asRecord(await readJsonBody(req))
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt : null
        try {
          const directory = await createProjectlessThreadDirectory(prompt)
          setJson(res, 200, { data: directory })
        } catch (error) {
          setJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to create new chat folder' })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-root-suggestion') {
        const basePath = url.searchParams.get('basePath')?.trim() ?? ''
        if (!basePath) {
          setJson(res, 400, { error: 'Missing basePath' })
          return
        }
        const normalizedBasePath = normalizeLocalPathInput(basePath)
        try {
          const baseInfo = await stat(normalizedBasePath)
          if (!baseInfo.isDirectory()) {
            setJson(res, 400, { error: 'basePath is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'basePath does not exist' })
          return
        }

        let index = 1
        while (index < 100000) {
          const candidateName = `New Project (${String(index)})`
          const candidatePath = join(normalizedBasePath, candidateName)
          try {
            await stat(candidatePath)
            index += 1
            continue
          } catch {
            setJson(res, 200, { data: { name: candidateName, path: candidatePath } })
            return
          }
        }

        setJson(res, 500, { error: 'Failed to compute project name suggestion' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composer-file-search') {
        const payload = asRecord(await readJsonBody(req))
        const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 20
        const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
        const offsetRaw = typeof payload?.offset === 'number' ? payload.offset : 0
        const offset = Math.max(0, Math.floor(offsetRaw))
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = normalizeLocalPathInput(rawCwd)
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const paths = await searchComposerPaths(cwd, query, limit, offset)
          setJson(res, 200, { data: paths })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to search paths') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/file-link-search') {
        const payload = asRecord(await readJsonBody(req))
        const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 30
        const limit = Math.max(1, Math.min(50, Math.floor(limitRaw)))
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        if (!query) {
          setJson(res, 200, { data: [] })
          return
        }
        const cwd = normalizeLocalPathInput(rawCwd)
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const paths = await searchFileLinkPathCandidates(cwd, query, limit)
          setJson(res, 200, { data: paths })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to search linked paths') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/prompts') {
        setJson(res, 200, { data: await listComposerPrompts() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/prompts') {
        const payload = asRecord(await readJsonBody(req))
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        const content = typeof payload?.content === 'string' ? payload.content : ''
        if (!name || !content.trim()) {
          setJson(res, 400, { error: 'Prompt name and content are required' })
          return
        }
        try {
          const prompt = await createComposerPromptFile(name, content)
          setJson(res, 200, { data: prompt })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to create prompt') })
        }
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/prompts') {
        const promptPath = url.searchParams.get('path')?.trim() ?? ''
        if (!promptPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }
        try {
          const removed = await removeComposerPromptFile(promptPath)
          setJson(res, 200, { data: { removed } })
        } catch (error) {
          setJson(res, 400, { error: getErrorMessage(error, 'Failed to remove prompt') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-titles') {
        const cache = await readMergedThreadTitleCache()
        setJson(res, 200, { data: cache })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-pins') {
        const threadIds = await readPinnedThreadIds()
        const threads = await readPinnedThreadMetadata(threadIds)
        setJson(res, 200, { data: { threadIds, threads } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/preferences/first-launch-plugins-card') {
        const dismissed = await readFirstLaunchPluginsCardDismissed()
        setJson(res, 200, { data: { dismissed } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-automations') {
        const automationsByThreadId = await listThreadHeartbeatAutomations()
        setJson(res, 200, { data: toAutomationApiMap(automationsByThreadId) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-automations') {
        const automationsByProjectName = await listProjectCronAutomations()
        setJson(res, 200, { data: toAutomationApiMap(automationsByProjectName) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-automation') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        const automation = automationId
          ? await readThreadHeartbeatAutomation(threadId, automationId)
          : await readThreadHeartbeatAutomations(threadId)
        setJson(res, 200, { data: toAutomationApiData(automation) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-automation') {
        const projectName = url.searchParams.get('projectName')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!projectName) {
          setJson(res, 400, { error: 'Missing projectName' })
          return
        }
        const automation = automationId
          ? await readProjectCronAutomation(projectName, automationId)
          : await readProjectCronAutomations(projectName)
        setJson(res, 200, { data: toAutomationApiData(automation) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-search') {
        const payload = asRecord(await readJsonBody(req))
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 200
        const limit = Math.max(1, Math.min(1000, Math.floor(limitRaw)))
        if (!query) {
          setJson(res, 200, { data: { threadIds: [], indexedThreadCount: 0 } })
          return
        }

        const index = await getThreadSearchIndex()
        const matchedIds = Array.from(index.docsById.entries())
          .filter(([, doc]) => isExactPhraseMatch(query, doc))
          .slice(0, limit)
          .map(([id]) => id)

        setJson(res, 200, { data: { threadIds: matchedIds, indexedThreadCount: index.docsById.size } })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-titles') {
        const payload = asRecord(await readJsonBody(req))
        const id = typeof payload?.id === 'string' ? payload.id : ''
        const title = typeof payload?.title === 'string' ? payload.title : ''
        if (!id) {
          setJson(res, 400, { error: 'Missing id' })
          return
        }
        const cache = await readThreadTitleCache()
        const next = title ? updateThreadTitleCache(cache, id, title) : removeFromThreadTitleCache(cache, id)
        await writeThreadTitleCache(next)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-pins') {
        const payload = asRecord(await readJsonBody(req))
        const threadIds = normalizePinnedThreadIds(payload?.threadIds)
        await writePinnedThreadIds(threadIds)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/preferences/first-launch-plugins-card') {
        const payload = asRecord(await readJsonBody(req))
        const dismissed = payload?.dismissed === true
        await writeFirstLaunchPluginsCardDismissed(dismissed)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-automation') {
        const payload = asRecord(await readJsonBody(req))
        const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
        const rrule = typeof payload?.rrule === 'string' ? payload.rrule.trim() : ''
        const status = payload?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
        if (!threadId || !name || !prompt || !rrule) {
          setJson(res, 400, { error: 'threadId, name, prompt, and rrule are required' })
          return
        }
        const automation = await writeThreadHeartbeatAutomation({ threadId, id, name, prompt, rrule, status })
        setJson(res, 200, { data: toAutomationApiRecord(automation) })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/project-automation') {
        const payload = asRecord(await readJsonBody(req))
        const projectName = typeof payload?.projectName === 'string' ? payload.projectName.trim() : ''
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
        const rrule = typeof payload?.rrule === 'string' ? payload.rrule.trim() : ''
        const status = payload?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
        if (!projectName || !name || !prompt || !rrule) {
          setJson(res, 400, { error: 'projectName, name, prompt, and rrule are required' })
          return
        }
        if (!isAbsoluteLikePath(projectName)) {
          setJson(res, 400, { error: 'Project automation cwd must be an absolute path' })
          return
        }
        const automation = await writeProjectCronAutomation({ projectName, id, name, prompt, rrule, status })
        setJson(res, 200, { data: toAutomationApiRecord(automation) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/thread-automation/run') {
        const payload = asRecord(await readJsonBody(req))
        const threadId = typeof payload?.threadId === 'string' ? payload.threadId.trim() : ''
        const automationId = typeof payload?.automationId === 'string' ? payload.automationId.trim() : ''
        if (!threadId || !automationId) {
          setJson(res, 400, { error: 'threadId and automationId are required' })
          return
        }
        const automation = await readThreadHeartbeatAutomation(threadId, automationId)
        if (!automation) {
          setJson(res, 404, { error: 'Automation not found for thread' })
          return
        }
        await appendThreadQueuedMessage(threadId, buildHeartbeatQueuedMessage(automation))
        backendQueueProcessor.scheduleThreadQueueDrain(threadId, 0)
        setJson(res, 200, { data: { queued: true } })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/thread-automation') {
        const threadId = url.searchParams.get('threadId')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!threadId) {
          setJson(res, 400, { error: 'Missing threadId' })
          return
        }
        const removed = await deleteThreadHeartbeatAutomation(threadId, automationId)
        setJson(res, 200, { data: { removed } })
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/codex-api/project-automation') {
        const projectName = url.searchParams.get('projectName')?.trim() ?? ''
        const automationId = url.searchParams.get('automationId')?.trim() ?? ''
        if (!projectName) {
          setJson(res, 400, { error: 'Missing projectName' })
          return
        }
        const removed = await deleteProjectCronAutomation(projectName, automationId)
        setJson(res, 200, { data: { removed } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/telegram/configure-bot') {
        const payload = asRecord(await readJsonBody(req))
        const botToken = typeof payload?.botToken === 'string' ? payload.botToken.trim() : ''
        const rawAllowedUserIds = Array.isArray(payload?.allowedUserIds) ? payload.allowedUserIds : []
        if (!botToken) {
          setJson(res, 400, { error: 'Missing botToken' })
          return
        }
        const config = normalizeTelegramBridgeConfig({
          botToken,
          allowedUserIds: rawAllowedUserIds,
        })
        if (config.allowedUserIds.length === 0) {
          setJson(res, 400, { error: 'At least one allowed Telegram user ID is required' })
          return
        }

        telegramBridge.configureToken(config.botToken)
        telegramBridge.configureAllowedUserIds(config.allowedUserIds)
        telegramBridge.start()
        const existingConfig = await readTelegramBridgeConfig()
        await writeTelegramBridgeConfig({
          botToken: config.botToken,
          chatIds: existingConfig.chatIds,
          allowedUserIds: config.allowedUserIds,
        })
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/telegram/config') {
        const config = await readTelegramBridgeConfig()
        setJson(res, 200, {
          data: {
            botToken: config.botToken,
            allowedUserIds: config.allowedUserIds,
          },
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/telegram/status') {
        setJson(res, 200, { data: telegramBridge.getStatus() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/events') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')

        const unsubscribe = middleware.subscribeNotifications((notification: { method: string; params: unknown; atIso: string }) => {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify(notification)}\n\n`)
        })

        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        const keepAlive = setInterval(() => {
          res.write(': ping\n\n')
        }, 15000)

        const close = () => {
          clearInterval(keepAlive)
          unsubscribe()
          if (!res.writableEnded) {
            res.end()
          }
        }

        req.on('close', close)
        req.on('aborted', close)
        return
      }

      next()
    } catch (error) {
      const message = getErrorMessage(error, 'Unknown bridge error')
      setJson(res, 502, { error: message })
    }
  }

  middleware.dispose = () => {
    threadSearchIndex = null
    telegramBridge.stop()
    terminalManager.dispose()
    runtimePool.dispose()
  }
  middleware.subscribeNotifications = (
    listener: (value: { method: string; params: unknown; atIso: string }) => void,
  ) => {
    const unsubscribeAppServer = runtimePool.subscribeNotifications(listener)
    const unsubscribeTerminal = terminalManager.subscribe((notification) => {
      listener({
        ...notification,
        atIso: new Date().toISOString(),
      })
    })
    return () => {
      unsubscribeAppServer()
      unsubscribeTerminal()
    }
  }

  return middleware
}
