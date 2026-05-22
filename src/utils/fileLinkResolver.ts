export type ParsedFileReference = {
  path: string
  line: number | null
  endLine: number | null
}

export type FileLinkResolveContext = {
  cwd?: string
  basePaths?: readonly string[]
}

export type BrowseUrlOptions = FileLinkResolveContext & {
  line?: number | null
  endLine?: number | null
}

export function normalizeLineRange(line: number | null, endLine: number | null = line): { startLine: number; endLine: number } | null {
  if (!Number.isFinite(line ?? NaN) || !Number.isFinite(endLine ?? NaN)) return null
  const startLine = Math.floor(line ?? NaN)
  const normalizedEndLine = Math.floor(endLine ?? NaN)
  if (startLine < 1 || normalizedEndLine < 1) return null
  return {
    startLine: Math.min(startLine, normalizedEndLine),
    endLine: Math.max(startLine, normalizedEndLine),
  }
}

export function lineRangeQueryValue(line: number | null, endLine: number | null = line): string {
  const normalized = normalizeLineRange(line, endLine)
  if (!normalized) return ''
  return normalized.startLine === normalized.endLine
    ? String(normalized.startLine)
    : `${normalized.startLine}-${normalized.endLine}`
}

export function appendLineQuery(href: string, line: number | null, endLine: number | null = line): string {
  const queryValue = lineRangeQueryValue(line, endLine)
  if (!queryValue) return href
  const separator = href.includes('?') ? '&' : '?'
  return `${href}${separator}line=${encodeURIComponent(queryValue)}`
}

export function fileReferenceDisplayPath(pathValue: string, line: number | null, endLine: number | null = line): string {
  const queryValue = lineRangeQueryValue(line, endLine)
  return queryValue ? `${pathValue}:${queryValue}` : pathValue
}

export function getBasename(pathValue: string): string {
  const normalized = pathValue.replace(/\\/gu, '/')
  const name = normalized.split('/').filter(Boolean).pop()
  return name || pathValue
}

export function normalizePathSeparators(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/')
}

export function normalizeFileUrlToPath(pathValue: string): string {
  if (!pathValue.startsWith('file://')) return pathValue
  let stripped = pathValue.replace(/^file:\/\//u, '')
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

export function normalizePathDots(pathValue: string): string {
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

function isAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(pathValue)
}

function isExplicitRelativePath(pathValue: string): boolean {
  return pathValue.startsWith('./') || pathValue.startsWith('../') || pathValue.startsWith('~/')
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

export function normalizeLinkBasePath(pathValue: string): string {
  let normalized = normalizePathSeparators(normalizeFileUrlToPath(pathValue.trim()))
  if (!normalized) return ''
  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep best-effort path if decoding fails.
  }
  normalized = normalized.replace(/[\\/]+$/u, '')
  if (!isAbsolutePath(normalized)) return ''
  return normalizePathDots(normalized)
}

export function normalizeLinkBasePaths(paths: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const pathValue of paths ?? []) {
    if (typeof pathValue !== 'string') continue
    const normalized = normalizeLinkBasePath(pathValue)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    next.push(normalized)
  }
  return next
}

function resolveAgainstBase(pathValue: string, basePath: string): string {
  const normalizedBase = normalizePathSeparators(basePath.trim())
  if (!normalizedBase) return normalizePathDots(pathValue)
  return normalizePathDots(`${normalizedBase.replace(/\/+$/u, '')}/${pathValue}`)
}

export function resolveFileLinkPath(pathValue: string, context: FileLinkResolveContext = {}): string {
  const normalizedPath = normalizePathSeparators(normalizeFileUrlToPath(pathValue.trim()))
  if (!normalizedPath) return ''

  if (isAbsolutePath(normalizedPath)) return normalizePathDots(normalizedPath)

  const cwd = normalizePathSeparators((context.cwd ?? '').trim())
  if (normalizedPath.startsWith('~/')) {
    const homeBase = inferHomeFromCwd(cwd)
    if (homeBase) {
      return normalizePathDots(`${homeBase}/${normalizedPath.slice(2)}`)
    }
  }

  if (!isExplicitRelativePath(normalizedPath)) {
    const basePaths = normalizeLinkBasePaths(context.basePaths)
    if (basePaths.length > 0) {
      return resolveAgainstBase(normalizedPath, basePaths[0])
    }
  }

  if (!cwd) return normalizePathDots(normalizedPath)
  return resolveAgainstBase(normalizedPath, cwd)
}

export function isFilePath(value: string): boolean {
  if (!value || /[\r\n]/u.test(value)) return false
  if (value.endsWith('/') || value.endsWith('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return false

  const looksLikeAbsolute = isAbsolutePath(value)
  const looksLikeRelative = isExplicitRelativePath(value)
  if (looksLikeAbsolute || looksLikeRelative) return true

  const looksLikeBareFilename = /^[A-Za-z0-9._@() -]+\.[A-Za-z0-9]{1,12}$/u.test(value)
  if (looksLikeBareFilename) return true

  return /^[A-Za-z0-9._@() -]+(?:[\\/][A-Za-z0-9._@() -]+)+$/u.test(value)
}

export function parseFileReference(value: string): ParsedFileReference | null {
  if (!value) return null

  let pathValue = value.trim()
  const wrapped = trimLinkWrappers(pathValue)
  pathValue = wrapped.core.trim()
  let line: number | null = null
  let endLine: number | null = null

  const hashLineMatch = pathValue.match(/^(.*)#L(\d+)(?:-L?(\d+))?(?:C\d+)?$/u)
  if (hashLineMatch) {
    pathValue = hashLineMatch[1]
    line = Number(hashLineMatch[2])
    endLine = Number(hashLineMatch[3] ?? hashLineMatch[2])
  } else {
    const colonLineMatch = pathValue.match(/^(.*):(\d+)(?:-(\d+))?(?::\d+)?$/u)
    if (colonLineMatch) {
      pathValue = colonLineMatch[1]
      line = Number(colonLineMatch[2])
      endLine = Number(colonLineMatch[3] ?? colonLineMatch[2])
    }
  }

  pathValue = normalizeFileUrlToPath(pathValue)
  try {
    pathValue = decodeURIComponent(pathValue)
  } catch {
    // Keep best-effort path if decoding fails.
  }
  pathValue = pathValue.replace(/[\\/]+$/u, '')
  if (!isFilePath(pathValue)) return null
  const normalizedRange = normalizeLineRange(line, endLine)
  return {
    path: pathValue,
    line: normalizedRange?.startLine ?? null,
    endLine: normalizedRange?.endLine ?? null,
  }
}

export function trimLinkWrappers(value: string): { core: string; leading: string; trailing: string } {
  let core = value
  let leading = ''
  let trailing = ''

  const wrapperPairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>',
    '"': '"',
    '\'': '\'',
    '`': '`',
    '“': '”',
    '‘': '’',
  }

  while (core.length > 0) {
    const opening = core[0]
    const closing = Object.prototype.hasOwnProperty.call(wrapperPairs, opening) ? wrapperPairs[opening] : ''
    if (!closing || !core.endsWith(closing)) break
    leading += opening
    trailing += closing
    core = core.slice(1, -1)
  }

  return { core, leading, trailing }
}

export function shouldAutoLinkPlainTextFileReference(ref: ParsedFileReference): boolean {
  if (ref.line !== null) return true

  const normalizedPath = normalizePathSeparators(ref.path)
  if (!normalizedPath.startsWith('/')) return true

  const rest = normalizedPath.slice(1)
  if (!rest || rest.includes('/')) return true
  return /\.[A-Za-z0-9]{1,12}$/u.test(rest)
}

export function toBrowseUrl(pathValue: string, options: BrowseUrlOptions = {}): string {
  const normalized = pathValue.trim()
  if (!normalized) return '#'

  const parsed = parseFileReference(normalized)
  const candidatePath = parsed?.path ?? normalized
  const resolved = resolveFileLinkPath(candidatePath, options)
  if (!resolved) return '#'

  const normalizedResolved = resolved.startsWith('/') ? resolved : `/${resolved}`
  return appendLineQuery(
    `/codex-local-browse${encodeURI(normalizedResolved)}`,
    parsed?.line ?? options.line ?? null,
    parsed?.endLine ?? options.endLine ?? options.line ?? null,
  )
}

export function toRenderableImageUrl(value: string, context: FileLinkResolveContext = {}): string {
  const normalized = value.trim()
  if (!normalized) return ''
  if (
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('/codex-local-image?')
  ) {
    return normalized
  }

  if (normalized.startsWith('file://')) {
    return `/codex-local-image?path=${encodeURIComponent(normalized)}`
  }

  const ref = parseFileReference(normalized)
  if (ref) {
    const resolved = resolveFileLinkPath(ref.path, context)
    if (resolved) {
      const normalizedResolved = resolved.startsWith('/') ? resolved : `/${resolved}`
      return `/codex-local-image?path=${encodeURIComponent(normalizedResolved)}`
    }
  }

  return normalized
}
