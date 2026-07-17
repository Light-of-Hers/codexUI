import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path'
import { normalizePathForUi } from '../pathUtils.js'
import { resolveFzfCommand, resolveRipgrepCommand } from '../commandResolution.js'

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


// ---------------------------------------------------------------------------
// fzf V2 fuzzy matching algorithm (ported from fzf 0.38.0 src/algo/algo.go)
// ---------------------------------------------------------------------------
// This is a faithful port of fzf's FuzzyMatchV2 with --scheme=path. Running it
// in-process avoids the ~200ms overhead of spawning the fzf binary on every
// keystroke. The binary spawn is kept as a fallback for forward-compatibility.

const FZF_SCORE_MATCH = 16
const FZF_SCORE_GAP_START = -3
const FZF_SCORE_GAP_EXTENSION = -1
const FZF_BONUS_BOUNDARY = Math.floor(FZF_SCORE_MATCH / 2) // 8
const FZF_BONUS_NON_WORD = Math.floor(FZF_SCORE_MATCH / 2) // 8
const FZF_BONUS_CAMEL_123 = FZF_BONUS_BOUNDARY + FZF_SCORE_GAP_EXTENSION // 7
const FZF_BONUS_CONSECUTIVE = -(FZF_SCORE_GAP_START + FZF_SCORE_GAP_EXTENSION) // 4
const FZF_BONUS_FIRST_CHAR_MULTIPLIER = 2
const FZF_BONUS_BOUNDARY_WHITE = FZF_BONUS_BOUNDARY // 8 (path scheme)
const FZF_BONUS_BOUNDARY_DELIMITER = FZF_BONUS_BOUNDARY + 1 // 9 (path scheme)

const FZF_CHAR_WHITE = 0
const FZF_CHAR_NON_WORD = 1
const FZF_CHAR_DELIMITER = 2
const FZF_CHAR_LOWER = 3
const FZF_CHAR_UPPER = 4
const FZF_CHAR_NUMBER = 6

// In path scheme fzf only treats "/" as a delimiter (plus the OS separator on
// non-unix). "." "_" "-" etc. are charNonWord, which gives a smaller bonus.
const FZF_DELIMITER_CHARS = '/'
const FZF_WHITE_CHARS = ' \t\n\v\f\r\x85\xA0'

function fzfCharClassOf(c: string): number {
  if (c >= 'a' && c <= 'z') return FZF_CHAR_LOWER
  if (c >= 'A' && c <= 'Z') return FZF_CHAR_UPPER
  if (c >= '0' && c <= '9') return FZF_CHAR_NUMBER
  if (FZF_WHITE_CHARS.includes(c)) return FZF_CHAR_WHITE
  if (FZF_DELIMITER_CHARS.includes(c)) return FZF_CHAR_DELIMITER
  return FZF_CHAR_NON_WORD
}

function fzfBonusFor(prevClass: number, currClass: number): number {
  if (currClass > FZF_CHAR_NON_WORD) {
    if (prevClass === FZF_CHAR_WHITE) return FZF_BONUS_BOUNDARY_WHITE
    if (prevClass === FZF_CHAR_DELIMITER) return FZF_BONUS_BOUNDARY_DELIMITER
    if (prevClass === FZF_CHAR_NON_WORD) return FZF_BONUS_BOUNDARY
  }
  if (prevClass === FZF_CHAR_LOWER && currClass === FZF_CHAR_UPPER) return FZF_BONUS_CAMEL_123
  if (prevClass !== FZF_CHAR_NUMBER && currClass === FZF_CHAR_NUMBER) return FZF_BONUS_CAMEL_123
  if (currClass === FZF_CHAR_NON_WORD) return FZF_BONUS_NON_WORD
  if (currClass === FZF_CHAR_WHITE) return FZF_BONUS_BOUNDARY_WHITE
  return 0
}

/**
 * Computes the fzf V2 match score for `text` against `pattern` using the path
 * scoring scheme. Returns null when the pattern is not a subsequence of text
 * (i.e. no match). Higher scores are better.
 */
export function fzfV2Match(text: string, pattern: string): number | null {
  const M = pattern.length
  const N = text.length
  if (M === 0) return 0
  if (M > N) return null

  const lower = text.toLowerCase()
  const pLower = pattern.toLowerCase()

  // Quick subsequence check (mirrors fzf asciiFuzzyIndex) so we can bail out
  // early for the common no-match case without allocating the DP tables.
  let pidx = 0
  for (let j = 0; j < N && pidx < M; j++) {
    if (lower[j] === pLower[pidx]) pidx++
  }
  if (pidx < M) return null

  // Bonus for each position. Path scheme uses charDelimiter as the initial
  // char class so a leading word start gets the delimiter bonus.
  const B = new Int16Array(N)
  let prevClass = FZF_CHAR_DELIMITER
  for (let j = 0; j < N; j++) {
    B[j] = fzfBonusFor(prevClass, fzfCharClassOf(text[j]))
    prevClass = fzfCharClassOf(text[j])
  }

  // Flat DP tables: H[i][j] and C[i][j] mapped to index i*(N+1)+j.
  const NEG_INF = -32768
  const H = new Int32Array((M + 1) * (N + 1))
  const C = new Int32Array((M + 1) * (N + 1))
  for (let i = 1; i <= M; i++) H[i * (N + 1)] = NEG_INF

  let maxScore = 0

  // Row 1: pattern[0] matching (fzf Phase 2 - greedy reset). When the first
  // pattern char matches, fzf resets the score directly instead of comparing
  // against the gap extension, which keeps later word starts competitive.
  let inGap0 = false
  for (let j = 1; j <= N; j++) {
    if (lower[j - 1] === pLower[0]) {
      const bonus = B[j - 1]
      const score = FZF_SCORE_MATCH + bonus * FZF_BONUS_FIRST_CHAR_MULTIPLIER
      H[(N + 1) + j] = Math.max(score, 0)
      C[(N + 1) + j] = 1
      inGap0 = false
      if (M === 1 && score > maxScore) maxScore = score
    } else {
      const hLeft = H[(N + 1) + j - 1]
      const s2: number = inGap0 ? hLeft + FZF_SCORE_GAP_EXTENSION : hLeft + FZF_SCORE_GAP_START
      H[(N + 1) + j] = Math.max(s2, 0)
      C[(N + 1) + j] = 0
      inGap0 = true
    }
  }

  // Rows 2..M: standard DP (fzf Phase 3).
  for (let i = 2; i <= M; i++) {
    const row = i * (N + 1)
    const prevRow = (i - 1) * (N + 1)
    let inGap = false

    for (let j = 1; j <= N; j++) {
      const hLeft = H[row + j - 1]
      const s2: number = inGap ? hLeft + FZF_SCORE_GAP_EXTENSION : hLeft + FZF_SCORE_GAP_START

      let s1 = 0
      let consecutive = 0

      if (lower[j - 1] === pLower[i - 1]) {
        s1 = H[prevRow + j - 1] + FZF_SCORE_MATCH
        let b = B[j - 1]
        consecutive = C[prevRow + j - 1] + 1

        if (consecutive > 1) {
          const fb = B[j - consecutive]
          if (b >= FZF_BONUS_BOUNDARY && b > fb) {
            consecutive = 1
          } else {
            b = Math.max(b, Math.max(FZF_BONUS_CONSECUTIVE, fb))
          }
        }

        if (s1 + b < s2) {
          s1 += B[j - 1]
          consecutive = 0
        } else {
          s1 += b
        }
      }

      C[row + j] = consecutive
      inGap = s1 < s2
      const score = Math.max(Math.max(s1, s2), 0)
      H[row + j] = score

      if (i === M && lower[j - 1] === pLower[i - 1] && score > maxScore) {
        maxScore = score
      }
    }
  }

  return maxScore > 0 ? maxScore : null
}

// fzf default tiebreak is byScore then byLength (shorter is better). We keep
// the original input order as a final stable tiebreaker.
function compareFzfRanks(
  a: { score: number; path: string; index: number },
  b: { score: number; path: string; index: number },
): number {
  if (b.score !== a.score) return b.score - a.score
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.index - b.index
}

const COMPOSER_PATH_CACHE_TTL_MS = 5 * 60_000
const COMPOSER_PATH_CACHE_SETTLE_BUDGET_MS = 8_000
const COMPOSER_SHALLOW_DIRECTORY_CANDIDATE_LIMIT = 1_000
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

async function waitForComposerPathCacheSettle(
  entry: ComposerPathCacheEntry,
  budgetMs: number,
): Promise<void> {
  if (entry.settled) return

  await new Promise<void>((resolvePromise) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    let waiter: (() => void) | null = null
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      if (timeout) clearTimeout(timeout)
      if (waiter) entry.waiters.delete(waiter)
      resolvePromise()
    }
    waiter = () => {
      if (entry.settled) cleanup()
    }
    timeout = setTimeout(cleanup, Math.max(1, budgetMs))
    entry.waiters.add(waiter)
    if (entry.settled) cleanup()
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

type ShallowDirectoryCacheEntry = {
  expiresAt: number
  promise: Promise<ComposerSearchPathResult[]>
}

const composerShallowDirectoryCache = new Map<string, ShallowDirectoryCacheEntry>()

async function computeShallowComposerDirectoryCandidates(
  cwd: string,
  topLevelRows: ComposerSearchPathResult[],
  limit: number,
): Promise<ComposerSearchPathResult[]> {
  if (limit <= 0) return []

  const results: ComposerSearchPathResult[] = []
  for (const topLevelRow of topLevelRows) {
    if (results.length >= limit) break
    if (topLevelRow.kind !== 'directory' || topLevelRow.isSymlink) continue

    let entries: Dirent<string>[]
    try {
      entries = await readdir(resolve(cwd, topLevelRow.path), { withFileTypes: true })
    } catch {
      continue
    }

    const sortedEntries = entries
      .filter((entry) => !COMPOSER_SEARCH_EXCLUDED_TOP_LEVEL_NAMES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of sortedEntries) {
      if (results.length >= limit) break

      let isDirectory = entry.isDirectory()
      const isSymlink = entry.isSymbolicLink()
      const childPath = normalizeComposerSearchPath(`${topLevelRow.path}/${entry.name}`)
      if (!childPath) continue

      if (isSymlink) {
        try {
          isDirectory = (await stat(resolve(cwd, childPath))).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!isDirectory) continue

      results.push({
        path: childPath,
        kind: 'directory',
        isSymlink,
      })
    }
  }

  return results
}

async function listShallowComposerDirectoryCandidates(
  cwd: string,
  topLevelRows: ComposerSearchPathResult[],
  limit: number,
): Promise<ComposerSearchPathResult[]> {
  if (limit <= 0) return []

  const now = Date.now()
  const cached = composerShallowDirectoryCache.get(cwd)
  if (cached && cached.expiresAt > now) {
    return await cached.promise
  }

  const entry: ShallowDirectoryCacheEntry = {
    expiresAt: now + COMPOSER_PATH_CACHE_TTL_MS,
    promise: computeShallowComposerDirectoryCandidates(
      cwd,
      topLevelRows,
      COMPOSER_SHALLOW_DIRECTORY_CANDIDATE_LIMIT,
    ).catch((error) => {
      if (composerShallowDirectoryCache.get(cwd) === entry) {
        composerShallowDirectoryCache.delete(cwd)
      }
      throw error
    }),
  }
  composerShallowDirectoryCache.set(cwd, entry)
  return await entry.promise
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

type ComposerCandidatePool = Map<string, ComposerSearchPathCandidate>

function poolAdd(
  pool: ComposerCandidatePool,
  pathValue: string,
  kind: ComposerSearchPathKind,
): void {
  const normalized = normalizeComposerSearchPath(pathValue)
  if (!normalized || normalized === '.') return
  if (!pool.has(normalized)) {
    pool.set(normalized, { path: normalized, kind })
  }
}

async function runFzfFilter(candidates: string[], query: string): Promise<string[] | null> {
  const command = resolveFzfCommand()
  if (!command) return null
  if (candidates.length === 0) return []

  return await new Promise<string[] | null>((resolvePromise) => {
    const proc = spawn(command, ['--filter', query, '--scheme=path', '--tiebreak=length,index'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    })
    let stdout = ''
    let failed = false
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => { stdout += chunk })
    proc.on('error', () => { failed = true; resolvePromise(null) })
    proc.on('close', (code) => {
      if (failed) return
      // fzf exits with 1 when there are no matches; any other non-zero is a real error
      if (code !== 0 && code !== 1) {
        resolvePromise(null)
        return
      }
      const lines = stdout.split(/\r?\n/u).filter(Boolean)
      resolvePromise(lines)
    })
    proc.stdin.end(candidates.join('\n'))
  })
}

function fallbackRankComposerCandidates(
  candidates: ComposerSearchPathCandidate[],
  query: string,
  limit: number,
): ComposerSearchPathCandidate[] {
  return rankComposerPathCandidates(candidates, query, limit)
    .map(({ path, kind }) => ({ path, kind }))
}

async function collectComposerCandidatePool(
  cwd: string,
  topLevelRows: ComposerSearchPathResult[],
): Promise<{ pool: ComposerCandidatePool; symlinks: Map<string, boolean> }> {
  const pool: ComposerCandidatePool = new Map()
  const symlinks = new Map<string, boolean>()

  for (const row of topLevelRows) {
    poolAdd(pool, row.path, row.kind)
    symlinks.set(row.path, row.isSymlink)
  }

  const shallowRows = await listShallowComposerDirectoryCandidates(
    cwd,
    topLevelRows,
    COMPOSER_SHALLOW_DIRECTORY_CANDIDATE_LIMIT,
  )
  for (const row of shallowRows) {
    poolAdd(pool, row.path, row.kind)
    symlinks.set(row.path, row.isSymlink)
  }

  return { pool, symlinks }
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

  // Wait for a full path index before ranking. Partial scans made fzf rank
  // whatever happened to stream first, which buried real hits under random
  // deep paths that only subsequence-matched.
  const cacheEntry = getOrStartComposerPathCache(cwd)
  await waitForComposerPathCacheSettle(cacheEntry, COMPOSER_PATH_CACHE_SETTLE_BUDGET_MS)

  const { pool, symlinks } = await collectComposerCandidatePool(cwd, topLevelRows)
  for (const filePath of cacheEntry.paths) {
    poolAdd(pool, filePath, 'file')
  }

  const orderedPaths = await orderComposerCandidatesWithFzf(pool, trimmedQuery, maxResults)

  return await Promise.all(orderedPaths.slice(0, maxResults).map(async (candidate) => ({
    path: candidate.path,
    kind: candidate.kind,
    isSymlink: symlinks.get(candidate.path) ?? await isSymlinkPath(cwd, candidate.path),
  })))
}

async function orderComposerCandidatesWithFzf(
  pool: ComposerCandidatePool,
  query: string,
  limit: number,
): Promise<ComposerSearchPathCandidate[]> {
  const candidates = Array.from(pool.values())
  if (candidates.length === 0) return []

  const trimmedQuery = query.trim()

  // In-process fzf V2 ranking. Avoids spawning the fzf binary on every
  // keystroke (~200ms spawn overhead) and stays faithful to fzf's scoring.
  if (trimmedQuery) {
    const ranked: { score: number; path: string; index: number }[] = []
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      const score = fzfV2Match(candidate.path, trimmedQuery)
      if (score !== null) {
        ranked.push({ score, path: candidate.path, index: i })
      }
    }
    ranked.sort(compareFzfRanks)

    const output: ComposerSearchPathCandidate[] = []
    for (const entry of ranked) {
      const hit = pool.get(entry.path)
      if (hit) output.push(hit)
      if (output.length >= limit) break
    }
    return output
  }

  // Fall back to the fzf binary for empty queries.
  const fzfOrdered = await runFzfFilter(candidates.map((c) => c.path), query)
  if (fzfOrdered) {
    const output: ComposerSearchPathCandidate[] = []
    for (const path of fzfOrdered) {
      const hit = pool.get(path)
      if (hit) output.push(hit)
      if (output.length >= limit) break
    }
    return output
  }

  return fallbackRankComposerCandidates(candidates, query, limit)
}
