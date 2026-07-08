import { spawn } from 'node:child_process'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path'
import { normalizePathForUi } from '../pathUtils.js'
import { resolveRipgrepCommand } from '../commandResolution.js'

export type ComposerSearchPathKind = 'file' | 'directory'

export type ComposerSearchPathResult = {
  path: string
  kind: ComposerSearchPathKind
  isSymlink: boolean
}

type ComposerSearchPathCandidate = {
  path: string
  kind: ComposerSearchPathKind
}

type RankedComposerSearchPathCandidate = ComposerSearchPathCandidate & {
  score: number
  pathDepth: number
  pathLength: number
}

const COMPOSER_SEARCH_EXCLUDED_TOP_LEVEL_NAMES = new Set(['.git', 'node_modules'])
const COMPOSER_PATH_CACHE_TTL_MS = 30_000
const COMPOSER_FUZZY_INITIAL_SCAN_BUDGET_MS = 250
const COMPOSER_FILE_PREFILTER_MIN_ROWS = 80
const COMPOSER_FILE_PREFILTER_LIMIT_MULTIPLIER = 8
const COMPOSER_RIPGREP_FILE_ARGS = [
  '--files',
  '--follow',
  '--hidden',
  '-g',
  '!.git',
  '-g',
  '!node_modules',
]

type ComposerPathCacheEntry = {
  expiresAt: number
  promise: Promise<string[]>
  paths: string[]
  settled: boolean
  waiters: Set<() => void>
}

const composerPathCache = new Map<string, ComposerPathCacheEntry>()

function normalizeComposerSearchPath(rawPath: string): string {
  return normalizePathForUi(rawPath)
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.[/]+/u, '')
}

function normalizeSearchInput(rawPath: string): string {
  return normalizePathForUi(rawPath)
    .trim()
    .replace(/\\/gu, '/')
}

function expandHomeSearchPath(rawPath: string): string {
  const normalized = normalizeSearchInput(rawPath)
  if (normalized === '~') return homedir()
  if (normalized.startsWith('~/')) return resolve(homedir(), normalized.slice(2))
  return normalized
}

function isAbsoluteSearchInput(rawPath: string): boolean {
  const normalized = normalizeSearchInput(rawPath)
  return normalized === '~'
    || normalized.startsWith('~/')
    || isAbsolute(normalized)
    || /^[A-Za-z]:\//u.test(normalized)
}

function addCandidate(
  candidates: Map<string, ComposerSearchPathCandidate>,
  pathValue: string,
  kind: ComposerSearchPathKind,
): void {
  const path = normalizeComposerSearchPath(pathValue)
  if (!path || path === '.') return
  if (!candidates.has(path)) {
    candidates.set(path, { path, kind })
  }
}

function addAncestorDirectories(
  candidates: Map<string, ComposerSearchPathCandidate>,
  pathValue: string,
): void {
  let current = dirname(pathValue)
  while (current && current !== pathValue) {
    if (current === '.' || current === parse(current).root) break
    addCandidate(candidates, current, 'directory')
    const next = dirname(current)
    if (!next || next === current) break
    current = next
  }
}

function isPathSeparator(char: string | undefined): boolean {
  return char === '/' || char === '\\'
}

function isWordBoundary(previous: string | undefined, current: string | undefined): boolean {
  if (!current) return false
  if (!previous) return true
  if (isPathSeparator(previous)) return true
  if (/[^a-z0-9]/iu.test(previous) && /[a-z0-9]/iu.test(current)) return true
  return /[a-z0-9]/u.test(previous) && /[A-Z]/u.test(current)
}

function normalizeFuzzyQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '')
}

function scoreFuzzySubsequence(path: string, query: string): number | null {
  const normalizedQuery = normalizeFuzzyQuery(query)
  if (!path || !normalizedQuery) return null

  const lowerPath = path.toLowerCase()
  let searchFrom = 0
  let firstMatch = -1
  let previousMatch = -1
  let boundaryMatches = 0
  let consecutiveMatches = 0
  let separatorMatches = 0
  let extensionMatches = 0

  for (const char of normalizedQuery) {
    const nextMatch = lowerPath.indexOf(char, searchFrom)
    if (nextMatch < 0) return null
    if (firstMatch < 0) firstMatch = nextMatch

    if (isWordBoundary(path[nextMatch - 1], path[nextMatch])) {
      boundaryMatches += 1
    }
    if (previousMatch >= 0 && nextMatch === previousMatch + 1) {
      consecutiveMatches += 1
    }
    if (isPathSeparator(path[nextMatch - 1])) {
      separatorMatches += 1
    }
    if (path[nextMatch - 1] === '.') {
      extensionMatches += 1
    }

    previousMatch = nextMatch
    searchFrom = nextMatch + 1
  }

  const span = previousMatch - firstMatch + 1
  const compactnessPenalty = span - normalizedQuery.length
  const leadingPenalty = firstMatch
  const lengthPenalty = Math.max(0, path.length - normalizedQuery.length)
  const boundaryBonus = boundaryMatches * 0.28
  const consecutiveBonus = consecutiveMatches * 0.18
  const separatorBonus = separatorMatches * 0.35
  const extensionPenalty = extensionMatches * 0.2
  return Math.min(
    9.5,
    Math.max(
      4.25,
      7
        + (leadingPenalty * 0.08)
        + (compactnessPenalty * 0.22)
        + (lengthPenalty * 0.01)
        + extensionPenalty
        - boundaryBonus
        - consecutiveBonus
        - separatorBonus,
    ),
  )
}

export function scoreComposerPathCandidate(path: string, query: string): number {
  if (!query) return 0
  const literalScore = scoreComposerPathLiteralCandidate(path, query)
  if (typeof literalScore === 'number') return literalScore
  const lowerQuery = query.toLowerCase()
  const normalizedOriginalPath = path.replace(/\\/gu, '/')
  const originalBaseName = normalizedOriginalPath.slice(normalizedOriginalPath.lastIndexOf('/') + 1)
  const baseNameFuzzyScore = scoreFuzzySubsequence(originalBaseName, lowerQuery)
  const pathFuzzyScore = scoreFuzzySubsequence(normalizedOriginalPath, lowerQuery)
  const fuzzyScores = [
    baseNameFuzzyScore,
    typeof pathFuzzyScore === 'number' ? pathFuzzyScore + 0.75 : null,
  ].filter((score): score is number => typeof score === 'number')
  if (fuzzyScores.length > 0) {
    return Math.min(...fuzzyScores)
  }
  return 10
}

function scoreComposerPathLiteralCandidate(path: string, query: string): number | null {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const normalizedPath = lowerPath.replace(/\\/gu, '/')
  const baseName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
  if (baseName === lowerQuery) return 0
  if (baseName.startsWith(lowerQuery)) return 1
  if (baseName.includes(lowerQuery)) return 2
  if (normalizedPath.includes(`/${lowerQuery}`)) return 3
  if (normalizedPath.includes(lowerQuery)) return 4
  return null
}

function compareComposerPathCandidates(
  a: RankedComposerSearchPathCandidate,
  b: RankedComposerSearchPathCandidate,
): number {
  return (a.score - b.score)
    || (a.pathDepth - b.pathDepth)
    || (a.pathLength - b.pathLength)
    || a.path.localeCompare(b.path)
}

function pushRankedComposerPathCandidate(
  ranked: RankedComposerSearchPathCandidate[],
  candidate: RankedComposerSearchPathCandidate,
  limit: number,
): void {
  if (ranked.length >= limit) {
    const worst = ranked[ranked.length - 1]
    if (worst && compareComposerPathCandidates(candidate, worst) >= 0) return
    ranked[ranked.length - 1] = candidate
  } else {
    ranked.push(candidate)
  }
  ranked.sort(compareComposerPathCandidates)
}

function notifyComposerPathCacheWaiters(entry: ComposerPathCacheEntry): void {
  for (const waiter of Array.from(entry.waiters)) {
    waiter()
  }
}

async function listPathsWithRipgrep(
  cwd: string,
  onPath?: (path: string) => void,
): Promise<string[]> {
  return await new Promise<string[]>((resolvePromise, reject) => {
    const ripgrepCommand = resolveRipgrepCommand()
    if (!ripgrepCommand) {
      reject(new Error('ripgrep (rg) is not available'))
      return
    }

    const proc = spawn(ripgrepCommand, COMPOSER_RIPGREP_FILE_ARGS, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const rows: string[] = []
    let pending = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/u)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const row = normalizeComposerSearchPath(line)
        if (!row) continue
        rows.push(row)
        onPath?.(row)
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      const finalRow = normalizeComposerSearchPath(pending)
      if (finalRow) {
        rows.push(finalRow)
        onPath?.(finalRow)
      }
      if (code === 0 || code === 1 || (typeof code === 'number' && rows.length > 0)) {
        resolvePromise(rows)
        return
      }
      const details = stderr.trim()
      const exitStatus = signal ? `signal ${signal}` : `exit code ${String(code)}`
      reject(new Error(details || `rg --files failed with ${exitStatus}`))
    })
  })
}

function getCachedPaths(cwd: string): string[] | null {
  const cached = composerPathCache.get(cwd)
  if (!cached || cached.expiresAt <= Date.now()) return null
  return cached.settled ? cached.paths : null
}

function getOrStartComposerPathCache(cwd: string): ComposerPathCacheEntry {
  const now = Date.now()
  const cached = composerPathCache.get(cwd)
  if (cached && cached.expiresAt > now) {
    return cached
  }

  const entry: ComposerPathCacheEntry = {
    expiresAt: now + COMPOSER_PATH_CACHE_TTL_MS,
    promise: Promise.resolve([]),
    paths: [],
    settled: false,
    waiters: new Set(),
  }
  const promise = listPathsWithRipgrep(cwd, (path) => {
    entry.paths.push(path)
    notifyComposerPathCacheWaiters(entry)
  }).then((paths) => {
    entry.paths = paths
    entry.settled = true
    entry.expiresAt = Date.now() + COMPOSER_PATH_CACHE_TTL_MS
    notifyComposerPathCacheWaiters(entry)
    return paths
  }).catch((error) => {
    if (composerPathCache.get(cwd)?.promise === promise) {
      composerPathCache.delete(cwd)
    }
    entry.settled = true
    notifyComposerPathCacheWaiters(entry)
    throw error
  })
  entry.promise = promise
  composerPathCache.set(cwd, entry)
  return entry
}

async function listCachedPathsWithRipgrep(cwd: string): Promise<string[]> {
  return await getOrStartComposerPathCache(cwd).promise
}

function warmComposerPathCache(cwd: string): void {
  void listCachedPathsWithRipgrep(cwd).catch(() => {})
}

function hasComposerPathMatch(paths: string[], query: string, startIndex: number): { matched: boolean; nextIndex: number } {
  const trimmedQuery = query.trim()
  for (let index = startIndex; index < paths.length; index += 1) {
    if (!trimmedQuery || scoreComposerPathCandidate(paths[index], trimmedQuery) < 10) {
      return { matched: true, nextIndex: index + 1 }
    }
  }
  return { matched: false, nextIndex: paths.length }
}

async function waitForComposerPathCacheMatch(
  entry: ComposerPathCacheEntry,
  query: string,
  budgetMs: number,
): Promise<void> {
  let checkedIndex = 0
  const initialMatch = hasComposerPathMatch(entry.paths, query, checkedIndex)
  checkedIndex = initialMatch.nextIndex
  if (entry.settled || initialMatch.matched) return

  await new Promise<void>((resolvePromise) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    let waiter: (() => void) | null = null
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (waiter) entry.waiters.delete(waiter)
      resolvePromise()
    }
    waiter = () => {
      const result = hasComposerPathMatch(entry.paths, query, checkedIndex)
      checkedIndex = result.nextIndex
      if (entry.settled || result.matched) cleanup()
    }
    timeout = setTimeout(cleanup, Math.max(1, budgetMs))
    entry.waiters.add(waiter)
  })
}

async function isSymlinkPath(cwd: string, path: string): Promise<boolean> {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    const info = await lstat(absolutePath)
    return info.isSymbolicLink()
  } catch {
    return false
  }
}

async function listTopLevelComposerPaths(cwd: string): Promise<ComposerSearchPathResult[]> {
  const entries = await readdir(cwd, { withFileTypes: true })
  const candidates = await Promise.all(entries
    .filter((entry) => !COMPOSER_SEARCH_EXCLUDED_TOP_LEVEL_NAMES.has(entry.name))
    .map(async (entry) => {
      let isDirectory = entry.isDirectory()
      const isSymlink = entry.isSymbolicLink()
      if (isSymlink) {
        try {
          isDirectory = (await stat(resolve(cwd, entry.name))).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      return {
        path: normalizeComposerSearchPath(entry.name),
        kind: isDirectory ? 'directory' as const : 'file' as const,
        isSymlink,
        isDirectory,
      }
    }))

  const topLevelResults = candidates
    .filter((entry) => Boolean(entry.path))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path))

  return topLevelResults.map(({ path, kind, isSymlink }) => ({ path, kind, isSymlink }))
}

function filterComposerPathResults(
  rows: ComposerSearchPathResult[],
  query: string,
  limit: number,
): ComposerSearchPathResult[] {
  const trimmedQuery = query.trim()
  return rows
    .map((row) => ({
      ...row,
      score: scoreComposerPathCandidate(row.path, trimmedQuery),
      pathDepth: row.path.split('/').filter(Boolean).length,
      pathLength: row.path.length,
    }))
    .filter((row) => trimmedQuery.length === 0 || row.score < 10)
    .sort(compareComposerPathCandidates)
    .slice(0, limit)
    .map(({ path, kind, isSymlink }) => ({ path, kind, isSymlink }))
}

function rankComposerPathCandidates(
  candidates: ComposerSearchPathCandidate[],
  query: string,
  limit: number,
): RankedComposerSearchPathCandidate[] {
  const trimmedQuery = query.trim()
  const ranked: RankedComposerSearchPathCandidate[] = []

  for (const candidate of candidates) {
    const score = scoreComposerPathCandidate(candidate.path, trimmedQuery)
    if (trimmedQuery.length > 0 && score >= 10) continue
    pushRankedComposerPathCandidate(ranked, {
      ...candidate,
      score,
      pathDepth: candidate.path.split('/').filter(Boolean).length,
      pathLength: candidate.path.length,
    }, limit)
  }

  return ranked.slice(0, limit)
}

function rankComposerFilePathRows(
  paths: string[],
  query: string,
  limit: number,
): RankedComposerSearchPathCandidate[] {
  const trimmedQuery = query.trim()
  const prefilterLimit = Math.max(COMPOSER_FILE_PREFILTER_MIN_ROWS, limit * COMPOSER_FILE_PREFILTER_LIMIT_MULTIPLIER)
  const ranked: RankedComposerSearchPathCandidate[] = []

  for (const path of paths) {
    const score = scoreComposerPathLiteralCandidate(path, trimmedQuery)
    if (typeof score !== 'number') continue
    pushRankedComposerPathCandidate(ranked, {
      path,
      kind: 'file',
      score,
      pathDepth: path.split('/').filter(Boolean).length,
      pathLength: path.length,
    }, prefilterLimit)
  }

  if (ranked.length > 0) return ranked

  for (const path of paths) {
    const score = scoreComposerPathCandidate(path, trimmedQuery)
    if (trimmedQuery.length > 0 && score >= 10) continue
    pushRankedComposerPathCandidate(ranked, {
      path,
      kind: 'file',
      score,
      pathDepth: path.split('/').filter(Boolean).length,
      pathLength: path.length,
    }, prefilterLimit)
  }

  return ranked
}

function buildComposerSearchPathCandidatesFromRankedFiles(
  files: RankedComposerSearchPathCandidate[],
): ComposerSearchPathCandidate[] {
  const candidates = new Map<string, ComposerSearchPathCandidate>()
  for (const file of files) {
    addCandidate(candidates, file.path, 'file')
    addAncestorDirectories(candidates, file.path)
  }
  return Array.from(candidates.values())
}

async function readAbsolutePathResult(pathValue: string): Promise<ComposerSearchPathResult | null> {
  try {
    const linkInfo = await lstat(pathValue)
    let targetInfo = linkInfo
    if (linkInfo.isSymbolicLink()) {
      try {
        targetInfo = await stat(pathValue)
      } catch {
        targetInfo = linkInfo
      }
    }

    return {
      path: normalizeSearchInput(pathValue),
      kind: targetInfo.isDirectory() ? 'directory' : 'file',
      isSymlink: linkInfo.isSymbolicLink(),
    }
  } catch {
    return null
  }
}

async function searchAbsoluteComposerPaths(
  query: string,
  limit: number,
): Promise<ComposerSearchPathResult[] | null> {
  if (!isAbsoluteSearchInput(query)) return null

  const expandedQuery = expandHomeSearchPath(query)
  if (!isAbsolute(expandedQuery) && !/^[A-Za-z]:\//u.test(expandedQuery)) return []

  const results: ComposerSearchPathResult[] = []
  const seen = new Set<string>()
  const exact = await readAbsolutePathResult(expandedQuery)
  if (exact) {
    results.push(exact)
    seen.add(exact.path)
    return results.slice(0, limit)
  }

  const parentPath = expandedQuery.endsWith('/') ? expandedQuery.replace(/\/+$/u, '') : dirname(expandedQuery)
  if (!parentPath || parentPath === expandedQuery || parentPath === parse(parentPath).root) {
    return results
  }

  try {
    const parentInfo = await stat(parentPath)
    if (!parentInfo.isDirectory()) return results
  } catch {
    return results
  }

  const childQuery = expandedQuery.endsWith('/') ? '' : basename(expandedQuery)
  const rows = await searchComposerPaths(parentPath, childQuery, limit)
  for (const row of rows) {
    const absolutePath = normalizeSearchInput(isAbsolute(row.path) ? row.path : resolve(parentPath, row.path))
    if (seen.has(absolutePath)) continue
    seen.add(absolutePath)
    results.push({
      path: absolutePath,
      kind: row.kind,
      isSymlink: row.isSymlink,
    })
    if (results.length >= limit) break
  }

  return results
}

export async function searchComposerPaths(
  cwd: string,
  query: string,
  limit: number,
): Promise<ComposerSearchPathResult[]> {
  const trimmedQuery = query.trim()
  const maxResults = Math.max(1, Math.min(100, Math.floor(limit)))
  const absoluteResults = await searchAbsoluteComposerPaths(trimmedQuery, maxResults)
  if (absoluteResults) return absoluteResults

  const topLevelRows = await listTopLevelComposerPaths(cwd)
  if (!trimmedQuery) {
    warmComposerPathCache(cwd)
    return topLevelRows.slice(0, maxResults)
  }

  const topLevelMatches = filterComposerPathResults(topLevelRows, trimmedQuery, maxResults)
  if (topLevelMatches.some((row) => row.path.toLowerCase().startsWith(trimmedQuery.toLowerCase()))) {
    return topLevelMatches
  }

  const cachedPaths = getCachedPaths(cwd)
  const cacheEntry = cachedPaths ? null : getOrStartComposerPathCache(cwd)
  if (cacheEntry) {
    await waitForComposerPathCacheMatch(cacheEntry, trimmedQuery, COMPOSER_FUZZY_INITIAL_SCAN_BUDGET_MS)
  }
  const paths = cachedPaths ?? cacheEntry?.paths ?? []
  const rankedFiles = rankComposerFilePathRows(paths, trimmedQuery, maxResults)
  const candidates = rankComposerPathCandidates(
    buildComposerSearchPathCandidatesFromRankedFiles(rankedFiles),
    trimmedQuery,
    maxResults,
  )

  return await Promise.all(candidates.map(async (candidate) => ({
    path: candidate.path,
    kind: candidate.kind,
    isSymlink: await isSymlinkPath(cwd, candidate.path),
  })))
}
