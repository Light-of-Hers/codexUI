import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type CodexModelProviderInfo = Record<string, unknown>

export type CodexUiProviderDescriptor = {
  id: string
  label: string
  executable: string | null
  modelCatalogJson: string | null
  defaultModel: string | null
  providerInfo: CodexModelProviderInfo
  hasUiConfig: boolean
}

export type ModelCatalogMetadata = {
  id: string
  contextWindow: number | null
}

const CONFIG_TOML_FILE = 'config.toml'
const PROVIDER_MODELS_FETCH_TIMEOUT_MS = 8000
const PROVIDER_MODELS_FETCH_CACHE_TTL_MS = 60_000
const providerModelsFetchCache = new Map<string, { expiresAt: number; promise: Promise<string[]> }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed)
  }
  return null
}

function getCodexHomeDir(codexHome?: string): string {
  const explicit = codexHome?.trim() || process.env.CODEX_HOME?.trim()
  return explicit && explicit.length > 0 ? explicit : join(homedir(), '.codex')
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

function unescapeBasicTomlString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|["\\btnfr])/gu, (match, escape: string) => {
    switch (escape) {
      case '"':
        return '"'
      case '\\':
        return '\\'
      case 'b':
        return '\b'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'f':
        return '\f'
      case 'r':
        return '\r'
      default: {
        const codePoint = Number.parseInt(escape.slice(1), 16)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
      }
    }
  })
}

function parseQuotedTomlString(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) {
    return unescapeBasicTomlString(trimmed.slice(3, -3))
  }
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6) {
    return trimmed.slice(3, -3)
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeBasicTomlString(trimmed.slice(1, -1))
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return null
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false
  let squareDepth = 0
  let curlyDepth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') squareDepth += 1
    if (char === ']') squareDepth = Math.max(0, squareDepth - 1)
    if (char === '{') curlyDepth += 1
    if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1)
    if (char === delimiter && squareDepth === 0 && curlyDepth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter((part) => part.length > 0)
}

function parseTomlKeyPath(value: string): string[] {
  const rawParts = splitTopLevel(value.trim(), '.')
  const parts: string[] = []
  for (const rawPart of rawParts) {
    const quoted = parseQuotedTomlString(rawPart)
    parts.push((quoted ?? rawPart).trim())
  }
  return parts.filter(Boolean)
}

function parseInlineTomlTable(value: string): Record<string, unknown> {
  const table: Record<string, unknown> = {}
  const inner = value.trim().slice(1, -1).trim()
  if (!inner) return table
  for (const part of splitTopLevel(inner, ',')) {
    const equalsIndex = findTopLevelEquals(part)
    if (equalsIndex < 0) continue
    const keyPath = parseTomlKeyPath(part.slice(0, equalsIndex))
    if (keyPath.length === 0) continue
    setNestedValue(table, keyPath, parseTomlValue(part.slice(equalsIndex + 1)))
  }
  return table
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim()
  const quoted = parseQuotedTomlString(trimmed)
  if (quoted != null) return quoted
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    return inner ? splitTopLevel(inner, ',').map(parseTomlValue) : []
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseInlineTomlTable(trimmed)
  }
  const normalizedNumber = trimmed.replace(/_/gu, '')
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(normalizedNumber)) {
    const parsed = Number(normalizedNumber)
    if (Number.isFinite(parsed)) return parsed
  }
  return trimmed
}

function findTopLevelEquals(line: string): number {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '=') return index
  }
  return -1
}

function ensureNestedRecord(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = root
  for (const part of path) {
    const existing = current[part]
    if (!isRecord(existing)) {
      const next: Record<string, unknown> = {}
      current[part] = next
      current = next
    } else {
      current = existing
    }
  }
  return current
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return
  const parent = ensureNestedRecord(root, path.slice(0, -1))
  parent[path[path.length - 1]!] = value
}

export function parseCodexConfigToml(contents: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let currentTable = root
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      const isArrayTable = line.startsWith('[[') && line.endsWith(']]')
      if (isArrayTable) continue
      const path = parseTomlKeyPath(line.slice(1, -1))
      currentTable = ensureNestedRecord(root, path)
      continue
    }
    const equalsIndex = findTopLevelEquals(line)
    if (equalsIndex < 0) continue
    const keyPath = parseTomlKeyPath(line.slice(0, equalsIndex))
    if (keyPath.length === 0) continue
    setNestedValue(currentTable, keyPath, parseTomlValue(line.slice(equalsIndex + 1)))
  }
  return root
}

function resolveConfigPath(rawPath: string, configDir: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  return resolve(configDir, trimmed)
}

function normalizeModelProviderInfo(value: unknown): CodexModelProviderInfo | null {
  if (!isRecord(value)) return null
  return { ...value }
}

function normalizeUiProviderInfo(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function readCodexUiProviderDescriptors(options: { codexHome?: string } = {}): CodexUiProviderDescriptor[] {
  const configPath = join(getCodexHomeDir(options.codexHome), CONFIG_TOML_FILE)
  if (!existsSync(configPath)) return []

  let parsed: Record<string, unknown>
  try {
    parsed = parseCodexConfigToml(readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }

  const configDir = dirname(configPath)
  const modelProviders = isRecord(parsed.model_providers) ? parsed.model_providers : {}
  const codexUi = isRecord(parsed.codex_ui) ? parsed.codex_ui : {}
  const uiProviders = isRecord(codexUi.providers) ? codexUi.providers : {}
  const descriptors: CodexUiProviderDescriptor[] = []

  for (const [id, rawProviderInfo] of Object.entries(modelProviders)) {
    const providerId = id.trim()
    if (!providerId) continue
    const providerInfo = normalizeModelProviderInfo(rawProviderInfo)
    if (!providerInfo) continue
    const uiInfo = normalizeUiProviderInfo(uiProviders[providerId])
    const label = readString(uiInfo?.label)
      || readString(uiInfo?.name)
      || readString(providerInfo.name)
      || providerId
    const rawCatalogPath = readString(uiInfo?.model_catalog_json)
      || readString(uiInfo?.modelCatalogJson)
    descriptors.push({
      id: providerId,
      label,
      executable: readString(uiInfo?.executable) || null,
      modelCatalogJson: rawCatalogPath ? resolveConfigPath(rawCatalogPath, configDir) : null,
      defaultModel: readString(uiInfo?.default_model) || readString(uiInfo?.defaultModel) || null,
      providerInfo,
      hasUiConfig: Boolean(uiInfo),
    })
  }

  return descriptors
}

export function readCodexUiProviderDescriptor(
  providerId: string | null | undefined,
  options: { codexHome?: string } = {},
): CodexUiProviderDescriptor | null {
  const normalizedProviderId = providerId?.trim()
  if (!normalizedProviderId) return null
  return readCodexUiProviderDescriptors(options)
    .find((descriptor) => descriptor.id === normalizedProviderId) ?? null
}

function quoteCodexConfigString(value: string): string {
  return JSON.stringify(value)
}

export function buildCodexUiProviderConfigArgs(
  descriptor: CodexUiProviderDescriptor,
  model?: string | null,
): string[] {
  const args: string[] = []
  const normalizedModel = model?.trim()
  if (normalizedModel) {
    args.push('-c', `model=${quoteCodexConfigString(normalizedModel)}`)
  }
  args.push('-c', `model_provider=${quoteCodexConfigString(descriptor.id)}`)
  if (descriptor.modelCatalogJson) {
    args.push('-c', `model_catalog_json=${quoteCodexConfigString(descriptor.modelCatalogJson)}`)
  }
  return args
}

function readModelCatalogRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  if (Array.isArray(value.models)) return value.models
  if (Array.isArray(value.data)) return value.data
  return []
}

function readModelCatalogId(record: Record<string, unknown>): string {
  for (const key of ['slug', 'display_name', 'id', 'model', 'name']) {
    const candidate = readString(record[key])
    if (candidate) return candidate
  }
  return ''
}

export function readModelCatalogMetadata(catalogPath: string | null | undefined): ModelCatalogMetadata[] {
  const normalizedPath = catalogPath?.trim()
  if (!normalizedPath) return []
  try {
    const raw = JSON.parse(readFileSync(normalizedPath, 'utf8')) as unknown
    const rows = readModelCatalogRows(raw)
    const models: ModelCatalogMetadata[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const id = readModelCatalogId(row)
      if (!id || models.some((model) => model.id === id)) continue
      models.push({
        id,
        contextWindow: readPositiveInteger(
          row.context_window
            ?? row.contextWindow
            ?? row.max_context_window
            ?? row.maxContextWindow,
        ),
      })
    }
    return models
  } catch {
    return []
  }
}

export function getCodexUiProviderCatalogSelection(
  descriptor: CodexUiProviderDescriptor,
  candidate: string | null | undefined,
): { metadata: ModelCatalogMetadata[]; models: string[]; currentModel: string } {
  const metadata = readModelCatalogMetadata(descriptor.modelCatalogJson)
  const catalogModels = metadata.map((model) => model.id)
  const trimmedCandidate = candidate?.trim() ?? ''
  const fallbackModel = catalogModels[0] ?? descriptor.defaultModel ?? trimmedCandidate
  const hasValidCatalogCandidate = trimmedCandidate.length > 0 && catalogModels.includes(trimmedCandidate)
  const hasUsableUncatalogedCandidate = catalogModels.length === 0 && trimmedCandidate.length > 0
  const currentModel = hasValidCatalogCandidate || hasUsableUncatalogedCandidate
    ? trimmedCandidate
    : fallbackModel
  const baseModels = catalogModels.length > 0 ? catalogModels : (currentModel ? [currentModel] : [])
  const models = currentModel && baseModels.includes(currentModel)
    ? [currentModel, ...baseModels.filter((model) => model !== currentModel)]
    : [...(currentModel ? [currentModel] : []), ...baseModels]
  return { metadata, models, currentModel }
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
  if (!isRecord(value)) return params
  for (const [key, rawValue] of Object.entries(value)) {
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

function normalizeProviderModelsPayload(payload: unknown): string[] {
  const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : null
  if (!rows) return []
  const ids: string[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = readString(row.id)
    if (!id || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

export async function fetchCodexUiProviderModelIds(descriptor: CodexUiProviderDescriptor): Promise<string[]> {
  const cacheKey = JSON.stringify({
    id: descriptor.id,
    providerInfo: descriptor.providerInfo,
  })
  const now = Date.now()
  const cached = providerModelsFetchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return await cached.promise
  }

  const promise = fetchCodexUiProviderModelIdsUncached(descriptor)
    .catch((error) => {
      providerModelsFetchCache.delete(cacheKey)
      throw error
    })
  providerModelsFetchCache.set(cacheKey, {
    expiresAt: now + PROVIDER_MODELS_FETCH_CACHE_TTL_MS,
    promise,
  })
  return await promise
}

async function fetchCodexUiProviderModelIdsUncached(descriptor: CodexUiProviderDescriptor): Promise<string[]> {
  const provider = descriptor.providerInfo
  if (readString(provider.wire_api) !== 'responses') return []
  const baseUrl = readString(provider.base_url)
  if (!baseUrl) return []

  let requestUrl: URL
  try {
    requestUrl = buildProviderModelsUrl(baseUrl, provider.query_params)
  } catch {
    return []
  }

  const headers = new Headers()
  const configuredHeaders = isRecord(provider.http_headers) ? provider.http_headers : null
  if (configuredHeaders) {
    for (const [key, rawValue] of Object.entries(configuredHeaders)) {
      const normalized = normalizeHeaderValue(rawValue)
      if (!normalized) continue
      headers.set(key, normalized)
    }
  }

  const bearerToken = readString(provider.experimental_bearer_token)
  if (bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${bearerToken}`)
  }

  const envKey = readString(provider.env_key)
  if (envKey && !headers.has('Authorization')) {
    const envValue = process.env[envKey]?.trim()
    if (!envValue) return []
    headers.set('Authorization', `Bearer ${envValue}`)
  }

  const envHttpHeaders = isRecord(provider.env_http_headers) ? provider.env_http_headers : null
  if (envHttpHeaders) {
    for (const [key, rawEnvName] of Object.entries(envHttpHeaders)) {
      const envName = readString(rawEnvName)
      const envValue = envName ? process.env[envName]?.trim() : ''
      if (!envName || !envValue) continue
      headers.set(key, envValue)
    }
  }

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROVIDER_MODELS_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return []
    return normalizeProviderModelsPayload(await response.json() as unknown)
  } catch {
    return []
  }
}
