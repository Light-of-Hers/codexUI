import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

const MAX_VERSION_BYTES = 2 * 1024 * 1024
const HISTORY_LIMIT = 30

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

type GitVersion = {
  id: string
  label: string
}

type GitFileDiff = {
  gitRoot: string
  versions: GitVersion[]
  base: string
  compare: string
  diff: string
  rows: GitSideBySideDiffRow[]
  baseContent: string
  compareContent: string
}

type GitSideBySideDiffRow = {
  kind: 'context' | 'change' | 'remove' | 'add' | 'hunk'
  oldLine: number | null
  newLine: number | null
  oldText: string
  newText: string
}

export class LocalBrowseGitError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'LocalBrowseGitError'
    this.statusCode = statusCode
  }
}

function runGit(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const process = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    process.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    process.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    process.on('error', reject)
    process.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }))
  })
}

async function requireGitRoot(localPath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], dirname(localPath))
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new LocalBrowseGitError(400, 'This file is not inside a Git repository.')
  }
  return resolve(result.stdout.trim())
}

function relativeGitPath(gitRoot: string, localPath: string): string {
  const pathValue = relative(gitRoot, localPath)
  if (!pathValue || pathValue === '..' || pathValue.startsWith(`..${'/'.charAt(0)}`)) {
    throw new LocalBrowseGitError(400, 'File must be inside the Git repository root.')
  }
  return pathValue
}

function parseVersion(value: string): 'worktree' | 'index' | { commit: string } {
  if (value === 'worktree' || value === 'index') return value
  const match = value.match(/^commit:([0-9a-f]{40})$/iu)
  if (match) return { commit: match[1] }
  throw new LocalBrowseGitError(400, 'Invalid Git file version.')
}

async function ensureCommitExists(gitRoot: string, sha: string): Promise<void> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], gitRoot)
  if (result.code !== 0) throw new LocalBrowseGitError(400, 'The selected commit no longer exists.')
}

async function gitObjectContent(gitRoot: string, objectName: string): Promise<string | null> {
  const exists = await runGit(['cat-file', '-e', objectName], gitRoot)
  if (exists.code !== 0) return null

  const size = await runGit(['cat-file', '-s', objectName], gitRoot)
  const byteLength = Number.parseInt(size.stdout.trim(), 10)
  if (!Number.isFinite(byteLength) || byteLength > MAX_VERSION_BYTES) {
    throw new LocalBrowseGitError(413, 'Git file versions larger than 2 MB cannot be compared in the editor.')
  }

  const content = await runGit(['show', objectName], gitRoot)
  if (content.code !== 0) throw new LocalBrowseGitError(500, 'Could not read the selected Git file version.')
  return content.stdout
}

async function readVersionContent(
  gitRoot: string,
  relativePath: string,
  localPath: string,
  versionId: string,
): Promise<string | null> {
  const version = parseVersion(versionId)
  if (version === 'worktree') {
    try {
      const fileStat = await stat(localPath)
      if (fileStat.size > MAX_VERSION_BYTES) {
        throw new LocalBrowseGitError(413, 'Git file versions larger than 2 MB cannot be compared in the editor.')
      }
      return await readFile(localPath, 'utf8')
    } catch (error) {
      if (error instanceof LocalBrowseGitError) throw error
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : ''
      if (code === 'ENOENT') return null
      throw new LocalBrowseGitError(500, 'Could not read the working tree file version.')
    }
  }

  if (version === 'index') return await gitObjectContent(gitRoot, `:${relativePath}`)

  await ensureCommitExists(gitRoot, version.commit)
  return await gitObjectContent(gitRoot, `${version.commit}:${relativePath}`)
}

async function listVersions(gitRoot: string, relativePath: string): Promise<GitVersion[]> {
  const versions: GitVersion[] = [
    { id: 'worktree', label: 'Unstaged (working tree)' },
    { id: 'index', label: 'Staged (index)' },
  ]
  const history = await runGit([
    'log', `--max-count=${HISTORY_LIMIT}`, '--follow', '--format=%H%x09%h%x09%s%x09%cs', '--', relativePath,
  ], gitRoot)
  if (history.code !== 0) return versions

  for (const line of history.stdout.split(/\r?\n/u)) {
    const [sha, shortSha, subject, date] = line.split('\t')
    if (!/^[0-9a-f]{40}$/iu.test(sha ?? '')) continue
    versions.push({
      id: `commit:${sha}`,
      label: `${shortSha} · ${subject || '(no subject)'} · ${date || ''}`,
    })
  }
  return versions
}

async function createUnifiedDiff(relativePath: string, baseContent: string | null, compareContent: string | null): Promise<string> {
  if (baseContent === null && compareContent === null) return ''

  const tempDirectory = await mkdtemp(join(tmpdir(), 'codexui-local-git-diff-'))
  const basePath = join(tempDirectory, 'base')
  const comparePath = join(tempDirectory, 'compare')
  try {
    if (baseContent !== null) await writeFile(basePath, baseContent, 'utf8')
    if (compareContent !== null) await writeFile(comparePath, compareContent, 'utf8')
    const result = await runGit([
      'diff', '--no-index', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
      '--', baseContent === null ? '/dev/null' : basePath, compareContent === null ? '/dev/null' : comparePath,
    ], tempDirectory)
    if (result.code === 0 || result.code === 1) {
      return result.stdout
        .replace(/^diff --git .+$/mu, `diff --git a/${relativePath} b/${relativePath}`)
        .replace(/^--- (?!\/dev\/null).+$/mu, `--- a/${relativePath}`)
        .replace(/^\+\+\+ (?!\/dev\/null).+$/mu, `+++ b/${relativePath}`)
    }
    throw new LocalBrowseGitError(500, result.stderr.trim() || 'Could not generate the Git diff.')
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

function parseSideBySideDiff(diff: string): GitSideBySideDiffRow[] {
  const rows: GitSideBySideDiffRow[] = []
  const removedRows: Array<{ line: number; text: string }> = []
  const addedRows: Array<{ line: number; text: string }> = []
  let oldLine = 0
  let newLine = 0

  const flushChangedRows = (): void => {
    const rowCount = Math.max(removedRows.length, addedRows.length)
    for (let index = 0; index < rowCount; index += 1) {
      const removed = removedRows[index]
      const added = addedRows[index]
      rows.push({
        kind: removed && added ? 'change' : removed ? 'remove' : 'add',
        oldLine: removed?.line ?? null,
        newLine: added?.line ?? null,
        oldText: removed?.text ?? '',
        newText: added?.text ?? '',
      })
    }
    removedRows.length = 0
    addedRows.length = 0
  }

  for (const line of diff.split(/\r?\n/u)) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u)
    if (hunk) {
      flushChangedRows()
      oldLine = Number.parseInt(hunk[1], 10)
      newLine = Number.parseInt(hunk[2], 10)
      rows.push({ kind: 'hunk', oldLine: null, newLine: null, oldText: line, newText: '' })
      continue
    }
    if (!oldLine && !newLine) continue
    if (line.startsWith('-') && !line.startsWith('---')) {
      removedRows.push({ line: oldLine, text: line.slice(1) })
      oldLine += 1
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedRows.push({ line: newLine, text: line.slice(1) })
      newLine += 1
      continue
    }
    if (line.startsWith(' ')) {
      flushChangedRows()
      rows.push({ kind: 'context', oldLine, newLine, oldText: line.slice(1), newText: line.slice(1) })
      oldLine += 1
      newLine += 1
    }
  }
  flushChangedRows()
  return rows
}

export async function getLocalBrowseGitDiff(
  localPath: string,
  requestedBase = 'index',
  requestedCompare = 'worktree',
): Promise<GitFileDiff> {
  const realLocalPath = realpathSync(localPath)
  const gitRoot = await requireGitRoot(realLocalPath)
  const gitPath = relativeGitPath(gitRoot, realLocalPath)
  const [versions, baseContent, compareContent] = await Promise.all([
    listVersions(gitRoot, gitPath),
    readVersionContent(gitRoot, gitPath, realLocalPath, requestedBase),
    readVersionContent(gitRoot, gitPath, realLocalPath, requestedCompare),
  ])
  const allowedVersionIds = new Set(versions.map((version) => version.id))
  if (!allowedVersionIds.has(requestedBase) || !allowedVersionIds.has(requestedCompare)) {
    throw new LocalBrowseGitError(400, 'The selected version is not available for this file.')
  }

  const diff = await createUnifiedDiff(gitPath, baseContent, compareContent)
  return {
    gitRoot,
    versions,
    base: requestedBase,
    compare: requestedCompare,
    diff,
    rows: parseSideBySideDiff(diff),
    baseContent: baseContent ?? '',
    compareContent: compareContent ?? '',
  }
}
