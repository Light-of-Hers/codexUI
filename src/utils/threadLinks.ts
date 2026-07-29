import type { UiMessage } from '../types/codex'
import { getPathLeafName, normalizePathForComparison, normalizePathForUi } from '../pathUtils'

export type ThreadLinkKind = 'web' | 'file'

export type ThreadLink = {
  id: string
  value: string
  kind: ThreadLinkKind
  label: string
  href: string
  messageId: string
  role: 'user' | 'assistant'
}

type RawLink = {
  value: string
  kind: ThreadLinkKind
  messageId: string
  role: 'user' | 'assistant'
}

const URL_TRIM_TRAILING = /[.,;:!?，。；：！？、)]+$/u
const MARKDOWN_LINK_TARGET_PATTERN = /\]\(([^)\s]+)\)/g
const WEB_URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、()[\]{}「」『』《》]+/gi
const FILE_URI_PATTERN = /file:\/\/[^\s<>"'`，。；：！？、[\]{}「」『』《》]+/gi
const BACKTICK_PATTERN = /`([^`\n]+)`/g
const BARE_ABSOLUTE_PATH_PATTERN = /(?<![\p{L}\p{N}._@()-])(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\s<>"'`，。；：！？、()[\]{}「」『』《》]+/gu
const BARE_RELATIVE_PATH_PATTERN = /(?<![\p{L}\p{N}._@()-])(?:[A-Za-z0-9._@()-]+[\\/])+[A-Za-z0-9._@()-]+\.[A-Za-z0-9]{1,12}/gu
const FILE_LOCATION_SUFFIX_PATTERN = /(?::\d+(?:-\d+)?(?::\d+)?)?(?:#L\d+(?:-L?\d+)?(?:C\d+)?)?$/u

function trimTrailingPunct(value: string): string {
  return value.replace(URL_TRIM_TRAILING, '')
}

function stripFileLocationSuffix(value: string): string {
  return value.replace(FILE_LOCATION_SUFFIX_PATTERN, '')
}

function isWindowsLikePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

export function isFilePathLike(value: string): boolean {
  if (!value || /[\r\n]/u.test(value)) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) return false
  if (trimmed.startsWith('/') || isWindowsLikePath(trimmed)) return true
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~/')) return true
  if (/^[A-Za-z][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,3}$/u.test(trimmed)) return true
  if (/^[A-Za-z0-9._@()-]+(?:[\\/][A-Za-z0-9._@()-]+)+$/u.test(trimmed)) {
    const segments = trimmed.split(/[\\/]/u)
    return segments.some((segment) => /[A-Za-z]/u.test(segment))
  }
  return false
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/gu, '/')
}

function normalizeFileUrlToPath(value: string): string {
  if (!value.startsWith('file://')) return value
  let stripped = value.replace(/^file:\/\//u, '')
  try {
    stripped = decodeURIComponent(stripped)
  } catch {
    // Keep best-effort path if decoding fails.
  }
  if (/^\/[A-Za-z]:\//u.test(stripped)) {
    stripped = stripped.slice(1)
  }
  return stripped
}

function inferHomeFromCwd(cwd: string): string {
  const normalized = normalizePathSeparators(cwd)
  if (normalized === '/root' || normalized.startsWith('/root/')) return '/root'
  const userMatch = normalized.match(/^\/Users\/([^/]+)/u)
  if (userMatch) return `/Users/${userMatch[1]}`
  const homeMatch = normalized.match(/^\/home\/([^/]+)/u)
  if (homeMatch) return `/home/${homeMatch[1]}`
  return ''
}

function normalizePathDots(value: string): string {
  const normalized = normalizePathSeparators(value)
  if (!normalized) return normalized

  let root = ''
  let rest = normalized
  const driveMatch = rest.match(/^([A-Za-z]:)(\/.*)?$/u)
  if (driveMatch) {
    root = `${driveMatch[1]}/`
    rest = (driveMatch[2] ?? '').replace(/^\/+/u, '')
  } else if (rest.startsWith('/')) {
    root = '/'
    rest = rest.slice(1)
  }

  const parts = rest.split('/').filter(Boolean)
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(part)
  }

  const joined = stack.join('/')
  if (root) return `${root}${joined}`.replace(/\/+$/u, '') || root
  return joined || normalized
}

export function resolveRelativePath(pathValue: string, cwd: string): string {
  const normalizedPath = normalizePathSeparators(normalizeFileUrlToPath(pathValue.trim()))
  if (!normalizedPath) return ''

  const looksLikeAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//u.test(normalizedPath)
  if (looksLikeAbsolute) return normalizePathDots(normalizedPath)

  if (normalizedPath.startsWith('~/')) {
    const homeBase = inferHomeFromCwd(cwd)
    if (homeBase) return normalizePathDots(`${homeBase}/${normalizedPath.slice(2)}`)
  }

  const base = normalizePathSeparators(cwd.trim())
  if (!base) return normalizePathDots(normalizedPath)
  return normalizePathDots(`${base.replace(/\/+$/u, '')}/${normalizedPath}`)
}

export function buildFileBrowseHref(pathValue: string, cwd: string): string {
  const resolved = resolveRelativePath(pathValue, cwd)
  if (!resolved) return '#'
  const normalizedResolved = resolved.startsWith('/') ? resolved : `/${resolved}`
  return `/codex-local-browse${encodeURI(normalizedResolved)}`
}

type LinkCandidate = {
  start: number
  end: number
  rawValue: string
  kind: ThreadLinkKind
}

function collectCandidates(text: string): LinkCandidate[] {
  const candidates: LinkCandidate[] = []
  const push = (match: RegExpMatchArray, kind: ThreadLinkKind, rawValue: string): void => {
    if (typeof match.index !== 'number') return
    if (!rawValue) return
    candidates.push({ start: match.index, end: match.index + match[0].length, rawValue, kind })
  }

  for (const match of text.matchAll(MARKDOWN_LINK_TARGET_PATTERN)) {
    const value = match[1]
    push(match, /^https?:\/\//iu.test(value) ? 'web' : 'file', value)
  }
  for (const match of text.matchAll(WEB_URL_PATTERN)) {
    push(match, 'web', match[0])
  }
  for (const match of text.matchAll(FILE_URI_PATTERN)) {
    push(match, 'file', match[0])
  }
  for (const match of text.matchAll(BACKTICK_PATTERN)) {
    const value = match[1].trim()
    if (!value) continue
    push(match, /^https?:\/\//iu.test(value) ? 'web' : 'file', value)
  }
  for (const match of text.matchAll(BARE_ABSOLUTE_PATH_PATTERN)) {
    push(match, 'file', match[0])
  }
  for (const match of text.matchAll(BARE_RELATIVE_PATH_PATTERN)) {
    push(match, 'file', match[0])
  }
  return candidates
}

function collectRawLinksFromText(text: string, messageId: string, role: 'user' | 'assistant'): RawLink[] {
  const out: RawLink[] = []
  if (!text) return out

  const candidates = collectCandidates(text)
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))

  let lastEnd = -1
  for (const candidate of candidates) {
    if (candidate.start < lastEnd) continue
    lastEnd = candidate.end
    if (candidate.kind === 'web') {
      const value = trimTrailingPunct(candidate.rawValue)
      if (value) out.push({ value, kind: 'web', messageId, role })
    } else {
      const normalized = normalizeFileUrlToPath(candidate.rawValue)
      const stripped = stripFileLocationSuffix(normalized)
      if (stripped && isFilePathLike(stripped)) {
        out.push({ value: stripped, kind: 'file', messageId, role })
      }
    }
  }

  return out
}

function collectMessageTexts(message: UiMessage): string[] {
  const texts: string[] = []
  if (typeof message.text === 'string' && message.text.length > 0) texts.push(message.text)
  if (typeof message.additionalContext === 'string' && message.additionalContext.length > 0) {
    texts.push(message.additionalContext)
  }
  return texts
}

function dedupeKey(kind: ThreadLinkKind, normalized: string): string {
  return kind === 'web'
    ? `web:${normalized}`
    : `file:${normalizePathForComparison(normalized)}`
}

function buildThreadLink(raw: RawLink, normalized: string, cwd: string): ThreadLink {
  const label = raw.kind === 'web' ? normalized : (getPathLeafName(normalized) || normalized)
  const href = raw.kind === 'web' ? normalized : buildFileBrowseHref(normalized, cwd)
  return {
    id: `${raw.kind}:${normalized}`,
    value: normalized,
    kind: raw.kind,
    label,
    href,
    messageId: raw.messageId,
    role: raw.role,
  }
}

export function extractThreadLinks(messages: readonly UiMessage[], cwd = ''): ThreadLink[] {
  const seen = new Set<string>()
  const result: ThreadLink[] = []

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    for (const text of collectMessageTexts(message)) {
      const raws = collectRawLinksFromText(text, message.id, message.role)
      for (const raw of raws) {
        const normalized = raw.kind === 'web' ? raw.value : normalizePathForUi(raw.value)
        const key = dedupeKey(raw.kind, normalized)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(buildThreadLink(raw, normalized, cwd))
      }
    }
  }

  return result
}
