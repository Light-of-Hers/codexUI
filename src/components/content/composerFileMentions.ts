import { normalizePathForUi } from '../../pathUtils.js'

export type ComposerInlineFileAttachment = {
  label: string
  path: string
  fsPath: string
}

const FILE_MENTION_TRIGGERS = ['@', '\uFF20'] as const

const MENTION_BOUNDARY_CHARS = new Set([
  '(', '[', '{', '<',
  '"', "'",
  '，', '。', '；', '：', '！', '？', '、',
  '「', '『', '《',
])

const UNQUOTED_MENTION_STOP_CHARS = new Set([
  ')', ']', '}', '>',
  '"', "'", '`',
  '，', '。', '；', '：', '！', '？', '、',
  ',', ';', '!', '?',
])

const ABSOLUTE_MENTION_ROOT_SEGMENTS = new Set([
  'Applications',
  'Library',
  'Volumes',
  'Users',
  'etc',
  'home',
  'media',
  'mnt',
  'opt',
  'private',
  'root',
  'srv',
  'tmp',
  'usr',
  'var',
])

function isWindowsAbsolutePath(pathValue: string): boolean {
  return /^[A-Za-z]:\//u.test(pathValue)
}

function isLikelyAbsoluteMentionPath(pathValue: string): boolean {
  if (isWindowsAbsolutePath(pathValue)) return true
  if (!pathValue.startsWith('/')) return false
  const firstSegment = pathValue.slice(1).split('/').filter(Boolean)[0] ?? ''
  return ABSOLUTE_MENTION_ROOT_SEGMENTS.has(firstSegment)
}

function normalizeMentionPath(pathValue: string): string {
  const normalized = normalizePathForUi(pathValue)
    .trim()
    .replace(/\\/gu, '/')

  if (normalized.startsWith('~/') || isLikelyAbsoluteMentionPath(normalized)) {
    return normalized
  }

  return normalized
    .replace(/^(?:\.\/|\/)+/u, '')
}

function stripTrailingMentionPunctuation(pathValue: string): string {
  let next = pathValue.trim()
  while (/[.,;:!?，。；：！？、]$/u.test(next)) {
    next = next.slice(0, -1).trimEnd()
  }
  return next
}

function quoteMentionPathIfNeeded(pathValue: string): string {
  if (!/[\s"'`()\[\]{}<>，。；：！？、]/u.test(pathValue)) return pathValue
  if (!pathValue.includes('"')) return `"${pathValue}"`
  if (!pathValue.includes('`')) return `\`${pathValue}\``
  return pathValue
}

function hasMentionBoundary(text: string, atIndex: number): boolean {
  if (atIndex <= 0) return true
  const previous = text[atIndex - 1]
  return /\s/u.test(previous) || MENTION_BOUNDARY_CHARS.has(previous)
}

function readQuotedMentionPath(
  text: string,
  startIndex: number,
  quote: '"' | "'" | '`',
): { path: string; endIndex: number } | null {
  let index = startIndex + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\n' || char === '\r') return null
    if (char === quote) {
      const path = text.slice(startIndex + 1, index).trim()
      return path ? { path, endIndex: index + 1 } : null
    }
    index += 1
  }
  return null
}

function readUnquotedMentionPath(text: string, startIndex: number): { path: string; endIndex: number } | null {
  let index = startIndex
  while (index < text.length) {
    const char = text[index]
    if (/\s/u.test(char) || UNQUOTED_MENTION_STOP_CHARS.has(char)) break
    index += 1
  }

  const path = stripTrailingMentionPunctuation(text.slice(startIndex, index))
  return path ? { path, endIndex: index } : null
}

function readMentionPathAt(text: string, atIndex: number): { path: string; endIndex: number } | null {
  if (!hasMentionBoundary(text, atIndex)) return null

  let startIndex = -1
  if (FILE_MENTION_TRIGGERS.includes(text[atIndex] as typeof FILE_MENTION_TRIGGERS[number])) {
    startIndex = atIndex + 1
  } else if (text[atIndex] === '.' && text[atIndex + 1] === '/') {
    startIndex = atIndex + 2
  }
  if (startIndex < 0) return null

  const marker = text[startIndex]
  if (!marker || /\s/u.test(marker) || marker === '@') return null
  if (marker === '"' || marker === "'" || marker === '`') {
    return readQuotedMentionPath(text, startIndex, marker)
  }
  return readUnquotedMentionPath(text, startIndex)
}

export function toComposerFileMentionSearchQuery(query: string): string {
  return normalizeMentionPath(query)
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/')
}

function normalizeBasePath(pathValue: string): string {
  return normalizePathForUi(pathValue)
    .trim()
    .replace(/\\/gu, '/')
    .replace(/[\\/]+$/u, '')
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

function normalizePathDots(pathValue: string): string {
  const normalized = normalizePathSeparators(pathValue)
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

export function resolveComposerFileMentionFsPath(pathValue: string, cwd: string): string {
  const normalizedPath = normalizeMentionPath(pathValue)
  if (!normalizedPath) return ''

  const looksLikeAbsolute = isLikelyAbsoluteMentionPath(normalizedPath)
  if (looksLikeAbsolute) return normalizePathDots(normalizedPath)

  if (normalizedPath.startsWith('~/')) {
    const homeBase = inferHomeFromCwd(cwd)
    if (homeBase) return normalizePathDots(`${homeBase}/${normalizedPath.slice(2)}`)
  }

  const normalizedCwd = normalizeBasePath(cwd)
  if (!normalizedCwd) return normalizePathDots(normalizedPath)
  return normalizePathDots(`${normalizedCwd}/${normalizedPath}`)
}

export function formatComposerFileMention(pathValue: string): string {
  const normalizedPath = normalizeMentionPath(pathValue)
  if (!normalizedPath) return ''
  const prefix = normalizedPath.startsWith('~/') || isLikelyAbsoluteMentionPath(normalizedPath) ? '@' : './'
  return `${prefix}${quoteMentionPathIfNeeded(normalizedPath)}`
}

export function insertComposerFileMentionText(
  draft: string,
  pathValue: string,
  startIndex: number | null,
  cursorIndex = draft.length,
): { text: string; selectionIndex: number } | null {
  const mentionText = formatComposerFileMention(pathValue)
  if (!mentionText) return null

  if (startIndex !== null) {
    const start = Math.max(0, Math.min(startIndex, draft.length))
    const cursor = Math.max(start, Math.min(cursorIndex, draft.length))
    const after = draft.slice(cursor)
    const leadingWhitespaceLength = after.match(/^\s+/u)?.[0].length ?? 0
    const separator = leadingWhitespaceLength > 0 ? '' : ' '
    const text = `${draft.slice(0, start)}${mentionText}${separator}${after}`
    const selectionIndex = start + mentionText.length + separator.length + leadingWhitespaceLength
    return { text, selectionIndex }
  }

  const prefix = draft.length > 0 && !/\s$/u.test(draft) ? ' ' : ''
  const text = `${draft}${prefix}${mentionText} `
  return { text, selectionIndex: text.length }
}

export function createComposerFileAttachment(pathValue: string, cwd = ''): ComposerInlineFileAttachment | null {
  const normalizedPath = normalizeMentionPath(pathValue)
  if (!normalizedPath) return null

  const labelPath = normalizedPath.replace(/[\\/]+$/u, '') || normalizedPath
  const label = labelPath.split('/').filter(Boolean).at(-1) || labelPath
  const fsPath = resolveComposerFileMentionFsPath(normalizedPath, cwd) || normalizedPath
  return {
    label,
    path: normalizedPath,
    fsPath,
  }
}

export function extractComposerFileMentionAttachments(text: string, cwd = ''): ComposerInlineFileAttachment[] {
  const attachments: ComposerInlineFileAttachment[] = []
  const seen = new Set<string>()
  let index = 0

  while (index < text.length) {
    const atIndex = text.indexOf('@', index)
    const fullWidthAtIndex = text.indexOf('\uFF20', index)
    const dotIndex = text.indexOf('./', index)
    const mentionIndexes = [atIndex, fullWidthAtIndex, dotIndex].filter((value) => value >= 0)
    const nextIndex = mentionIndexes.length > 0 ? Math.min(...mentionIndexes) : -1
    if (nextIndex < 0) break

    const mention = readMentionPathAt(text, nextIndex)
    if (!mention) {
      index = nextIndex + 1
      continue
    }

    const attachment = createComposerFileAttachment(mention.path, cwd)
    if (attachment && !seen.has(attachment.fsPath)) {
      seen.add(attachment.fsPath)
      attachments.push(attachment)
    }
    index = Math.max(mention.endIndex, nextIndex + 1)
  }

  return attachments
}
