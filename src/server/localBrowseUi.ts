import { basename, dirname, extname, join } from 'node:path'
import { open, readFile, readdir, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { renderMarkdownContent } from '../components/content/markdownRenderer.js'
import { KATEX_STYLESHEET_HREF } from './katexAssets.js'
import { EDITOR_LANGUAGE_OPTIONS, getEditorLanguageLabel, getEditorModeForPath } from '../utils/codeLanguage.js'

export type DirectoryItem = {
  name: string
  path: string
  isDirectory: boolean
  editable: boolean
  mtimeMs: number
}

export type LocalDirectoryListingEntry = {
  name: string
  path: string
}

export type LocalDirectoryListing = {
  path: string
  parentPath: string
  entries: LocalDirectoryListingEntry[]
}

type LocalDirectoryListingOptions = {
  showHidden?: boolean
}

const TEXT_EDITABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.scss',
  '.html', '.htm', '.xml', '.yml', '.yaml', '.log', '.csv', '.env', '.py',
  '.sh', '.toml', '.ini', '.conf', '.sql', '.bat', '.cmd', '.ps1', '.rs',
  '.markdown',
])

const MARKDOWN_PREVIEW_EXTENSIONS = new Set(['.md', '.markdown'])

export function normalizeLocalPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('file://')) {
    try {
      return decodeURIComponent(trimmed.replace(/^file:\/\//u, ''))
    } catch {
      return trimmed.replace(/^file:\/\//u, '')
    }
  }
  return trimmed
}

export function decodeBrowsePath(rawPath: string): string {
  if (!rawPath) return ''
  try {
    return decodeURIComponent(rawPath)
  } catch {
    return rawPath
  }
}

export function isTextEditablePath(pathValue: string): boolean {
  return TEXT_EDITABLE_EXTENSIONS.has(extname(pathValue).toLowerCase()) || getEditorModeForPath(pathValue) !== 'plaintext'
}

export function isMarkdownPath(pathValue: string): boolean {
  return MARKDOWN_PREVIEW_EXTENSIONS.has(extname(pathValue).toLowerCase())
}

export function createEditorReferenceText(
  localPath: string,
  startLine: number,
  endLine = startLine,
): string {
  const normalizedPath = localPath.trim()
  const normalizedStart = Number.isFinite(startLine) ? Math.floor(startLine) : 0
  const normalizedEnd = Number.isFinite(endLine) ? Math.floor(endLine) : 0
  const firstLine = Math.min(normalizedStart, normalizedEnd)
  const lastLine = Math.max(normalizedStart, normalizedEnd)
  if (!normalizedPath || firstLine < 1 || lastLine < 1) return ''
  return firstLine === lastLine
    ? `${normalizedPath}:${firstLine}`
    : `${normalizedPath}:${firstLine}-${lastLine}`
}

export function encodeAnnotationSourceForLocalBrowse(value: string): string {
  const annotationSlash = String.fromCharCode(92)
  const raw = String(value || '')
  const escapedBraceIndexes = new Set<number>()
  const openBraceStack: number[] = []

  const isEscapedAt = (index: number): boolean => {
    let slashCount = 0
    for (let cursor = index - 1; cursor >= 0 && raw[cursor] === annotationSlash; cursor -= 1) {
      slashCount += 1
    }
    return slashCount % 2 === 1
  }

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character !== '{' && character !== '}') continue
    if (isEscapedAt(index)) continue

    if (character === '{') {
      openBraceStack.push(index)
      continue
    }

    const openIndex = openBraceStack.pop()
    if (openIndex === undefined) {
      escapedBraceIndexes.add(index)
    }
  }

  for (const openIndex of openBraceStack) {
    escapedBraceIndexes.add(openIndex)
  }

  let encoded = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === annotationSlash) {
      const previousCharacter = index > 0 ? raw[index - 1] : ''
      const nextCharacter = index + 1 < raw.length ? raw[index + 1] : ''
      encoded += nextCharacter === annotationSlash || nextCharacter === '{' || nextCharacter === '}' || previousCharacter === annotationSlash
        ? annotationSlash + annotationSlash
        : character
      continue
    }

    if ((character === '{' || character === '}') && (escapedBraceIndexes.has(index) || isEscapedAt(index))) {
      encoded += annotationSlash + character
      continue
    }

    encoded += character
  }

  return encoded
}

type AnnotationCommentMatch = {
  comment: string
  commentStartOffset: number
  commentEndOffset: number
  commentBodyStartOffset: number
  commentBodyEndOffset: number
  commentInsertionEndOffset: number
}

export function findAnnotationCommentInSource(
  sourceSlice: string,
  selectedText: string,
  occurrence = 0,
): AnnotationCommentMatch | null {
  const annotationSlash = String.fromCharCode(92)
  const normalizeAnnotationText = (value: string): string => String(value || '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const normalizedSelection = normalizeAnnotationText(selectedText)
  if (!sourceSlice || !normalizedSelection) return null

  const decodeAnnotationSource = (value: string): string => {
    let decoded = ''
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === annotationSlash && index + 1 < value.length && (value[index + 1] === annotationSlash || value[index + 1] === '{' || value[index + 1] === '}')) {
        decoded += value[index + 1]
        index += 1
        continue
      }
      decoded += value[index]
    }
    return decoded
  }

  const readAnnotationCommandBody = (value: string, openBraceIndex: number): { value: string; endOffset: number } | null => {
    if (value[openBraceIndex] !== '{') return null
    let depth = 1
    let cursor = openBraceIndex + 1
    while (cursor < value.length) {
      const character = value[cursor]
      if (character === annotationSlash) {
        cursor += 2
        continue
      }
      if (character === '{') {
        depth += 1
      } else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          return {
            value: value.slice(openBraceIndex + 1, cursor),
            endOffset: cursor + 1,
          }
        }
      }
      cursor += 1
    }
    return null
  }

  const parseAnnotationCommandAt = (value: string, startOffset: number) => {
    if (value[startOffset] !== annotationSlash) return null
    const commands = [
      { raw: annotationSlash + 'comment{', kind: 'comment' },
      { raw: annotationSlash + 'mark{', kind: 'mark' },
      { raw: annotationSlash + 'cmt{', kind: 'comment' },
    ]
    const command = commands.find((candidate) => value.startsWith(candidate.raw, startOffset))
    if (!command) return null
    const openBraceIndex = startOffset + command.raw.length - 1
    const body = readAnnotationCommandBody(value, openBraceIndex)
    if (!body) return null
    return {
      kind: command.kind,
      startOffset,
      endOffset: body.endOffset,
      bodyStartOffset: openBraceIndex + 1,
      bodyEndOffset: body.endOffset - 1,
      value: decodeAnnotationSource(body.value),
    }
  }

  let matchedOccurrence = 0
  const findInSlice = (
    value: string,
    baseOffset: number,
    enclosingCommentEndOffset: number | null = null,
  ): AnnotationCommentMatch | null => {
    let searchFrom = 0
    while (searchFrom < value.length) {
      const commandIndex = value.indexOf(annotationSlash, searchFrom)
      if (commandIndex < 0) return null
      const command = parseAnnotationCommandAt(value, commandIndex)
      if (!command) {
        searchFrom = commandIndex + 1
        continue
      }
      if (command.kind === 'comment' && normalizeAnnotationText(command.value) === normalizedSelection) {
        if (matchedOccurrence >= occurrence) {
          return {
            comment: command.value,
            commentStartOffset: baseOffset + command.startOffset,
            commentEndOffset: baseOffset + command.endOffset,
            commentBodyStartOffset: baseOffset + command.bodyStartOffset,
            commentBodyEndOffset: baseOffset + command.bodyEndOffset,
            commentInsertionEndOffset: enclosingCommentEndOffset ?? baseOffset + command.endOffset,
          }
        }
        matchedOccurrence += 1
      }

      const nestedMatch = findInSlice(
        value.slice(command.bodyStartOffset, command.bodyEndOffset),
        baseOffset + command.bodyStartOffset,
        command.kind === 'comment'
          ? enclosingCommentEndOffset ?? baseOffset + command.endOffset
          : enclosingCommentEndOffset,
      )
      if (nestedMatch) return nestedMatch
      searchFrom = command.endOffset
    }
    return null
  }

  return findInSlice(sourceSlice, 0)
}

export function findRenderedInlineCodeSelectionInSource(
  sourceSlice: string,
  selectedText: string,
  options: { requireInlineCodeEnd?: boolean } = {},
): { startOffset: number; endOffset: number } | null {
  const normalizedSelection = String(selectedText || '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!sourceSlice || !normalizedSelection) return null

  const renderedCharacters: string[] = []
  const sourceOffsets: number[] = []
  const inlineCodeEndOffsets: Array<number | null> = []
  const appendCharacter = (character: string, sourceOffset: number, inlineCodeEndOffset: number | null = null): void => {
    renderedCharacters.push(character)
    sourceOffsets.push(sourceOffset)
    inlineCodeEndOffsets.push(inlineCodeEndOffset)
  }
  const appendPlainRange = (start: number, end: number): void => {
    for (let cursor = start; cursor < end; cursor += 1) {
      appendCharacter(sourceSlice[cursor], cursor)
    }
  }
  const isEscapedBacktick = (offset: number): boolean => {
    let slashCount = 0
    for (let cursor = offset - 1; cursor >= 0 && sourceSlice[cursor] === '\\'; cursor -= 1) {
      slashCount += 1
    }
    return slashCount % 2 === 1
  }

  let index = 0
  while (index < sourceSlice.length) {
    if (sourceSlice[index] !== '`' || isEscapedBacktick(index)) {
      appendCharacter(sourceSlice[index], index)
      index += 1
      continue
    }

    let delimiterEnd = index + 1
    while (sourceSlice[delimiterEnd] === '`') delimiterEnd += 1
    const delimiter = sourceSlice.slice(index, delimiterEnd)
    let closingIndex = sourceSlice.indexOf(delimiter, delimiterEnd)
    while (closingIndex >= 0 && (sourceSlice[closingIndex - 1] === '`' || sourceSlice[closingIndex + delimiter.length] === '`')) {
      closingIndex = sourceSlice.indexOf(delimiter, closingIndex + 1)
    }
    if (closingIndex < 0) {
      appendPlainRange(index, delimiterEnd)
      index = delimiterEnd
      continue
    }

    const inlineCodeEndOffset = closingIndex + delimiter.length
    for (let cursor = delimiterEnd; cursor < closingIndex; cursor += 1) {
      appendCharacter(sourceSlice[cursor], cursor, inlineCodeEndOffset)
    }
    index = inlineCodeEndOffset
  }

  let normalizedSource = ''
  const normalizedOffsets: number[] = []
  const normalizedInlineCodeEndOffsets: Array<number | null> = []
  let previousWasWhitespace = false
  for (let characterIndex = 0; characterIndex < renderedCharacters.length; characterIndex += 1) {
    const character = renderedCharacters[characterIndex] === '\u00a0' ? ' ' : renderedCharacters[characterIndex]
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) {
        normalizedSource += ' '
        normalizedOffsets.push(sourceOffsets[characterIndex])
        normalizedInlineCodeEndOffsets.push(inlineCodeEndOffsets[characterIndex])
        previousWasWhitespace = true
      }
      continue
    }
    normalizedSource += character
    normalizedOffsets.push(sourceOffsets[characterIndex])
    normalizedInlineCodeEndOffsets.push(inlineCodeEndOffsets[characterIndex])
    previousWasWhitespace = false
  }

  let trimStart = 0
  let trimEnd = normalizedSource.length
  while (trimStart < trimEnd && normalizedSource[trimStart] === ' ') trimStart += 1
  while (trimEnd > trimStart && normalizedSource[trimEnd - 1] === ' ') trimEnd -= 1
  const normalizedText = normalizedSource.slice(trimStart, trimEnd)
  let normalizedIndex = normalizedText.indexOf(normalizedSelection)
  while (normalizedIndex >= 0) {
    const sourceIndex = normalizedIndex + trimStart
    const sourceEndIndex = sourceIndex + normalizedSelection.length - 1
    const startOffset = normalizedOffsets[sourceIndex]
    const inlineCodeEndOffset = normalizedInlineCodeEndOffsets[sourceEndIndex]
    const endOffset = Number.isFinite(inlineCodeEndOffset)
      ? Number(inlineCodeEndOffset)
      : normalizedOffsets[sourceEndIndex] + 1
    if (Number.isFinite(startOffset) && Number.isFinite(endOffset) && (options.requireInlineCodeEnd !== true || Number.isFinite(inlineCodeEndOffset))) {
      return { startOffset, endOffset }
    }
    normalizedIndex = normalizedText.indexOf(normalizedSelection, normalizedIndex + 1)
  }

  return null
}

function isHiddenName(value: string): boolean {
  return value.startsWith('.')
}

function looksLikeTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  for (const byte of buffer) {
    if (byte === 0) return false
  }
  const decoded = buffer.toString('utf8')
  const replacementCount = (decoded.match(/\uFFFD/gu) ?? []).length
  return replacementCount / decoded.length < 0.05
}

async function probeFileIsText(localPath: string): Promise<boolean> {
  const handle = await open(localPath, 'r')
  try {
    const sample = Buffer.allocUnsafe(4096)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    return looksLikeTextBuffer(sample.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

export async function isTextEditableFile(localPath: string): Promise<boolean> {
  if (isTextEditablePath(localPath)) return true
  try {
    const fileStat = await stat(localPath)
    if (!fileStat.isFile()) return false
    return await probeFileIsText(localPath)
  } catch {
    return false
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function normalizeNewProjectName(value: string): string {
  return value.trim().replace(/[\\/]+/gu, '').trim()
}

function normalizeLocalEntryName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/u.test(trimmed)) return ''
  return trimmed
}

export function resolveLocalEntryPath(parentPath: string, rawName: string): string {
  const normalizedName = normalizeLocalEntryName(rawName)
  if (!normalizedName) return ''
  return join(parentPath, basename(normalizedName))
}

export class LocalBrowseMutationError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'LocalBrowseMutationError'
    this.statusCode = statusCode
  }
}

function fileSystemErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

export async function createLocalBrowseFile(parentPath: string, rawName: string): Promise<string> {
  const targetPath = resolveLocalEntryPath(parentPath, rawName)
  if (!targetPath) throw new LocalBrowseMutationError(400, 'Missing file name.')

  try {
    const parentStat = await stat(parentPath)
    if (!parentStat.isDirectory()) throw new LocalBrowseMutationError(400, 'Expected directory path.')
  } catch (error) {
    if (error instanceof LocalBrowseMutationError) throw error
    throw new LocalBrowseMutationError(404, 'Directory not found.')
  }

  try {
    await writeFile(targetPath, '', { encoding: 'utf8', flag: 'wx' })
    return targetPath
  } catch (error) {
    const code = fileSystemErrorCode(error)
    if (code === 'EEXIST') throw new LocalBrowseMutationError(409, 'File already exists.')
    if (code === 'EACCES' || code === 'EPERM') throw new LocalBrowseMutationError(403, 'Permission denied.')
    throw new LocalBrowseMutationError(500, 'Create file failed.')
  }
}


export async function createLocalBrowseDirectory(parentPath: string, rawName: string): Promise<string> {
  const targetPath = resolveLocalEntryPath(parentPath, rawName)
  if (!targetPath) throw new LocalBrowseMutationError(400, "Missing directory name.")

  try {
    const parentStat = await stat(parentPath)
    if (!parentStat.isDirectory()) throw new LocalBrowseMutationError(400, "Expected directory path.")
  } catch (error) {
    if (error instanceof LocalBrowseMutationError) throw error
    throw new LocalBrowseMutationError(404, "Directory not found.")
  }

  try {
    await mkdir(targetPath)
    return targetPath
  } catch (error) {
    const code = fileSystemErrorCode(error)
    if (code === "EEXIST") throw new LocalBrowseMutationError(409, "Directory already exists.")
    if (code === "EACCES" || code === "EPERM") throw new LocalBrowseMutationError(403, "Permission denied.")
    throw new LocalBrowseMutationError(500, "Create directory failed.")
  }
}

export async function createLocalBrowseEntry(
  parentPath: string,
  rawName: string,
  type: 'file' | 'directory' = 'file',
): Promise<string> {
  return type === 'directory'
    ? createLocalBrowseDirectory(parentPath, rawName)
    : createLocalBrowseFile(parentPath, rawName)
}

export async function deleteLocalBrowseDirectory(localPath: string): Promise<void> {
  try {
    const dirStat = await stat(localPath)
    if (!dirStat.isDirectory()) throw new LocalBrowseMutationError(400, "Expected directory path.")
  } catch (error) {
    if (error instanceof LocalBrowseMutationError) throw error
    throw new LocalBrowseMutationError(404, "Directory not found.")
  }

  try {
    await rm(localPath, { recursive: true })
  } catch (error) {
    const code = fileSystemErrorCode(error)
    if (code === "EACCES" || code === "EPERM") throw new LocalBrowseMutationError(403, "Permission denied.")
    throw new LocalBrowseMutationError(500, "Delete directory failed.")
  }
}

export async function deleteLocalBrowseFile(localPath: string): Promise<void> {
  try {
    const fileStat = await stat(localPath)
    if (!fileStat.isFile()) throw new LocalBrowseMutationError(400, 'Expected file path.')
  } catch (error) {
    if (error instanceof LocalBrowseMutationError) throw error
    throw new LocalBrowseMutationError(404, 'File not found.')
  }

  try {
    await rm(localPath)
  } catch (error) {
    const code = fileSystemErrorCode(error)
    if (code === 'EACCES' || code === 'EPERM') throw new LocalBrowseMutationError(403, 'Permission denied.')
    throw new LocalBrowseMutationError(500, 'Delete file failed.')
  }
}

export async function deleteLocalBrowseEntry(localPath: string): Promise<void> {
  try {
    const entryStat = await stat(localPath)
    if (entryStat.isFile()) {
      await deleteLocalBrowseFile(localPath)
      return
    }
    if (entryStat.isDirectory()) {
      await deleteLocalBrowseDirectory(localPath)
      return
    }
    throw new LocalBrowseMutationError(400, 'Expected file or directory path.')
  } catch (error) {
    if (error instanceof LocalBrowseMutationError) throw error
    throw new LocalBrowseMutationError(404, 'File or directory not found.')
  }
}

export function normalizeLineRangeQuery(value: string): string {
  const match = value.trim().match(/^(\d+)(?:-(\d+))?$/u)
  if (!match) return ''
  const startLine = Number(match[1])
  const endLine = Number(match[2] ?? match[1])
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < 1) return ''
  const firstLine = Math.min(Math.floor(startLine), Math.floor(endLine))
  const lastLine = Math.max(Math.floor(startLine), Math.floor(endLine))
  return firstLine === lastLine ? String(firstLine) : `${firstLine}-${lastLine}`
}

function buildLocalRouteQuery(newProjectName = '', lineRange = '', options: { raw?: boolean } = {}): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  const normalizedLineRange = normalizeLineRangeQuery(lineRange)
  const params = new URLSearchParams()
  if (normalizedName) params.set('newProjectName', normalizedName)
  if (normalizedLineRange) params.set('line', normalizedLineRange)
  if (options.raw === true) params.set('raw', '1')
  const queryString = params.toString()
  return queryString ? `?${queryString}` : ''
}

function toBrowseHref(pathValue: string, newProjectName = '', lineRange = '', options: { raw?: boolean } = {}): string {
  const query = buildLocalRouteQuery(newProjectName, lineRange, options)
  return `/codex-local-browse${encodeURI(pathValue)}${query}`
}

export function toEditHref(pathValue: string, newProjectName = '', lineRange = ''): string {
  const query = buildLocalRouteQuery(newProjectName, lineRange)
  return `/codex-local-edit${encodeURI(pathValue)}${query}`
}

function escapeForInlineScriptString(value: string): string {
  // Prevent breaking out of inline <script> blocks when file content contains HTML/script tokens.
  return JSON.stringify(value)
    .replace(/<\//gu, '<\\/')
    .replace(/<!--/gu, '<\\!--')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

async function getDirectoryItems(localPath: string): Promise<DirectoryItem[]> {
  const entries = await readdir(localPath, { withFileTypes: true })
  const withMeta = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(localPath, entry.name)
    try {
      const entryStat = await stat(entryPath)
      const isDirectory = entryStat.isDirectory()
      const editable = !isDirectory && await isTextEditableFile(entryPath)
      return {
        name: entry.name,
        path: entryPath,
        isDirectory,
        editable,
        mtimeMs: entryStat.mtimeMs,
      }
    } catch {
      return null
    }
  }))
  const visibleItems = withMeta.filter((item): item is DirectoryItem => item !== null)
  return visibleItems.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })
}

export async function getDirectoryItemList(
  localPath: string,
  options: { showHidden?: boolean } = {},
): Promise<DirectoryItem[]> {
  const entries = await readdir(localPath, { withFileTypes: true })
  const withMeta = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(localPath, entry.name)
    try {
      const entryStat = await stat(entryPath)
      const isDirectory = entryStat.isDirectory()
      const editable = !isDirectory && await isTextEditableFile(entryPath)
      return { name: entry.name, path: entryPath, isDirectory, editable, mtimeMs: entryStat.mtimeMs }
    } catch {
      return null
    }
  }))
  return withMeta
    .filter((item): item is DirectoryItem => item !== null)
    .filter((item) => options.showHidden === true || !isHiddenName(item.name))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

function projectCreationTargetPath(parentPath: string, newProjectName: string): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  if (!normalizedName) return ''
  return join(parentPath, normalizedName)
}

function projectCreationButtonLabel(newProjectName: string): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  return normalizedName ? `Create ${normalizedName} here` : ''
}

function projectCreationStatusText(newProjectName: string): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  return normalizedName ? `Creating ${normalizedName} in Codex...` : 'Creating project in Codex...'
}

function openFolderStatusText(newProjectName: string): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  return normalizedName
    ? `Opening folder in Codex without creating ${normalizedName}...`
    : 'Opening folder in Codex...'
}

function failureStatusText(newProjectName: string): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  return normalizedName
    ? `Failed to open folder or create ${normalizedName}.`
    : 'Failed to open folder.'
}

function deleteFileIconHtml(): string {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></svg>'
}

function rawFileIconHtml(): string {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></svg>'
}

function actionButtonsHtml(localPath: string, newProjectName: string): string {
  const normalizedName = normalizeNewProjectName(newProjectName)
  const createTargetPath = projectCreationTargetPath(localPath, normalizedName)
  const createButton = createTargetPath
    ? `<button class="header-open-btn create-project-btn" type="button" aria-label="${escapeHtml(projectCreationButtonLabel(normalizedName))}" title="${escapeHtml(projectCreationButtonLabel(normalizedName))}" data-path="${escapeHtml(createTargetPath)}" data-label="${escapeHtml(normalizedName)}" data-status="${escapeHtml(projectCreationStatusText(normalizedName))}" data-error="${escapeHtml(failureStatusText(normalizedName))}">${escapeHtml(projectCreationButtonLabel(normalizedName))}</button>`
    : ''
  const openButton = `<button class="header-open-btn open-folder-btn" type="button" aria-label="Open current folder in Codex" title="Open folder in Codex" data-path="${escapeHtml(localPath)}" data-label="" data-status="${escapeHtml(openFolderStatusText(normalizedName))}" data-error="${escapeHtml(failureStatusText(normalizedName))}">Open folder in Codex</button>`
  return `${createButton}${openButton}`
}

export async function getLocalDirectoryListing(
  localPath: string,
  options: LocalDirectoryListingOptions = {},
): Promise<LocalDirectoryListing> {
  const entries = await readdir(localPath, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(localPath, entry.name),
    }))
    .filter((entry) => options.showHidden === true || !isHiddenName(entry.name))
    .sort((a, b) => {
      const aHidden = isHiddenName(a.name)
      const bHidden = isHiddenName(b.name)
      if (aHidden !== bHidden) return aHidden ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  return {
    path: localPath,
    parentPath: dirname(localPath),
    entries: directories,
  }
}

export async function createDirectoryListingHtml(localPath: string, options?: { newProjectName?: string }): Promise<string> {
  const newProjectName = normalizeNewProjectName(options?.newProjectName ?? '')
  const items = await getDirectoryItems(localPath)
  const parentPath = dirname(localPath)
  const rows = items
    .map((item) => {
      const suffix = item.isDirectory ? '/' : ''
      const rawAction = item.editable
        ? ` <a class="icon-btn" aria-label="Raw ${escapeHtml(item.name)}" href="${escapeHtml(toBrowseHref(item.path, newProjectName, '', { raw: true }))}" title="Open raw">${rawFileIconHtml()}</a>`
        : ''
      const deleteAction = ` <button class="icon-btn danger delete-entry-btn" type="button" aria-label="Delete ${escapeHtml(item.name)}" title="Delete ${escapeHtml(item.name)}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}" data-is-dir="${item.isDirectory ? '1' : '0'}">${deleteFileIconHtml()}</button>`
      const expandBtn = item.isDirectory
        ? `<button class="expand-btn" type="button" aria-label="Expand ${escapeHtml(item.name)}" title="Expand ${escapeHtml(item.name)}" data-path="${escapeHtml(item.path)}" data-expanded="0"><span class="expand-chevron"></span></button>`
        : `<span class="expand-spacer"></span>`
      return `<li class="file-row" data-depth="0" style="--depth:0">${expandBtn}<a class="file-link" href="${escapeHtml(toBrowseHref(item.path, newProjectName))}">${escapeHtml(item.name)}${suffix}</a><span class="row-actions">${rawAction}${deleteAction}</span></li>`
    })
    .join('\n')

  const parentLink = localPath !== parentPath
    ? `<a class="header-parent-link" href="${escapeHtml(toBrowseHref(parentPath, newProjectName))}">..</a>`
    : ''
  const pickerSummary = newProjectName
    ? `<p class="picker-summary">Browse to the parent folder where you want to create <strong>${escapeHtml(newProjectName)}</strong>, or open the current folder directly.</p>`
    : ''
  const createFileForm = '<form id="newFileForm" class="header-create-form"><input id="newFileName" class="header-file-input" type="text" autocomplete="off" spellcheck="false" aria-label="New file name" placeholder="New file name" /><button id="createFileBtn" class="header-open-btn create-file-btn" type="submit">Create file</button></form>'
  const createDirForm = '<form id="newDirForm" class="header-create-form"><input id="newDirName" class="header-file-input" type="text" autocomplete="off" spellcheck="false" aria-label="New directory name" placeholder="New directory name" /><button id="createDirBtn" class="header-open-btn create-file-btn" type="submit">Create dir</button></form>'
  const actionButtons = actionButtonsHtml(localPath, newProjectName)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Index of ${escapeHtml(localPath)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --page-bg: #f8fafc;
      --page-fg: #0f172a;
      --link-fg: #2563eb;
      --link-hover-fg: #1d4ed8;
      --row-bg: #ffffff;
      --row-border: #cbd5e1;
      --row-hover-bg: #eff6ff;
      --row-shadow: rgba(148, 163, 184, 0.14);
      --header-link-bg: #e2e8f0;
      --header-link-border: #cbd5e1;
      --header-link-fg: #0f172a;
      --button-bg-start: #2e6ee6;
      --button-bg-end: #3d8cff;
      --button-border: #4f8de0;
      --button-fg: #eef6ff;
      --button-shadow: 0 6px 18px rgba(33, 90, 199, 0.28);
      --icon-bg: #f8fafc;
      --icon-border: #cbd5e1;
      --icon-fg: #0f172a;
      --summary-fg: #475569;
      --status-fg: #2563eb;
      --field-bg: #ffffff;
      --field-border: #cbd5e1;
      --field-fg: #0f172a;
      --field-placeholder: #64748b;
      --danger-bg: #fff1f2;
      --danger-border: #fda4af;
      --danger-fg: #be123c;
      --danger-hover-bg: #ffe4e6;
      --focus-ring: rgba(61, 140, 255, 0.28);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --page-bg: #0b1020;
        --page-fg: #dbe6ff;
        --link-fg: #8cc2ff;
        --link-hover-fg: #b8d5ff;
        --row-bg: #0f1b33;
        --row-border: #28405f;
        --row-hover-bg: #13213c;
        --row-shadow: rgba(6, 13, 30, 0.45);
        --header-link-bg: #101f3a;
        --header-link-border: #2a4569;
        --header-link-fg: #9ec8ff;
        --button-bg-start: #2e6ee6;
        --button-bg-end: #3d8cff;
        --button-border: #4f8de0;
        --button-fg: #eef6ff;
        --button-shadow: 0 6px 18px rgba(18, 63, 145, 0.45);
        --icon-bg: #162643;
        --icon-border: #36557a;
        --icon-fg: #dbe6ff;
        --summary-fg: #b8d5ff;
        --status-fg: #8cc2ff;
        --field-bg: #0f1b33;
        --field-border: #2a4569;
        --field-fg: #dbe6ff;
        --field-placeholder: #9ca3af;
        --danger-bg: rgba(127, 29, 29, 0.18);
        --danger-border: rgba(248, 113, 113, 0.35);
        --danger-fg: #fecaca;
        --danger-hover-bg: rgba(127, 29, 29, 0.3);
        --focus-ring: rgba(140, 194, 255, 0.32);
      }
    }
    html, body { width: 100%; min-height: 100%; margin: 0; }
    body { box-sizing: border-box; font-family: ui-monospace, Menlo, Monaco, monospace; padding: 16px; background: var(--page-bg); color: var(--page-fg); }
    a { color: var(--link-fg); text-decoration: none; }
    a:hover { color: var(--link-hover-fg); text-decoration: underline; }
    h1 { font-size: 18px; margin: 0; word-break: break-all; color: var(--page-fg); }
    ul { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-direction: column; gap: 8px; }
    .file-row { display: grid; grid-template-columns: 22px minmax(0,1fr) auto; align-items: center; gap: 10px; padding-left: calc(var(--depth, 0) * 1.1rem + 6px); box-sizing: border-box; }
    .expand-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; background: transparent; color: var(--summary-fg); cursor: pointer; border-radius: 6px; padding: 0; }
    .expand-btn:hover { background: var(--row-hover-bg); }
    .expand-btn:disabled { cursor: default; opacity: 0.5; }
    .expand-chevron { display: inline-block; width: 0; height: 0; border-left: 5px solid currentColor; border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform 0.12s ease; }
    .expand-btn[data-expanded="1"] .expand-chevron { transform: rotate(90deg); }
    .expand-spacer { display: inline-block; width: 22px; }
    .file-link { display: block; padding: 10px 12px; border: 1px solid var(--row-border); border-radius: 10px; background: var(--row-bg); box-shadow: 0 1px 2px var(--row-shadow); overflow-wrap: anywhere; color: var(--page-fg); }
    .file-link:hover { background: var(--row-hover-bg); text-decoration: none; }
    .header-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
    .header-create-form {
      display: flex;
      align-items: stretch;
      gap: 8px;
      flex: 1 1 18rem;
      min-width: min(100%, 18rem);
    }
    .header-file-input {
      flex: 1 1 auto;
      min-width: 0;
      height: 42px;
      padding: 0 12px;
      border: 1px solid var(--field-border);
      border-radius: 10px;
      background: var(--field-bg);
      color: var(--field-fg);
      font: inherit;
      box-sizing: border-box;
    }
    .header-file-input::placeholder { color: var(--field-placeholder); }
    .header-file-input:focus {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }
    .header-parent-link { color: var(--header-link-fg); font-size: 14px; padding: 8px 10px; border: 1px solid var(--header-link-border); border-radius: 10px; background: var(--header-link-bg); }
    .header-parent-link:hover { text-decoration: none; filter: brightness(1.08); }
    .header-open-btn {
      height: 42px;
      padding: 0 14px;
      border: 1px solid var(--button-border);
      border-radius: 10px;
      background: linear-gradient(135deg, var(--button-bg-start) 0%, var(--button-bg-end) 100%);
      color: var(--button-fg);
      font-weight: 700;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: var(--button-shadow);
    }
    .header-open-btn:hover { filter: brightness(1.08); }
    .header-open-btn:disabled { opacity: 0.6; cursor: default; }
    .header-actions .create-file-btn { flex: 0 0 auto; min-width: 7.8rem; }
    .picker-summary { margin: 10px 0 0; color: var(--summary-fg); max-width: 60rem; line-height: 1.45; }
    .row-actions { display: inline-flex; align-items: center; gap: 8px; min-width: 42px; justify-content: flex-end; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border: 1px solid var(--icon-border); border-radius: 10px; background: var(--icon-bg); color: var(--icon-fg); text-decoration: none; cursor: pointer; }
    .icon-btn:hover { filter: brightness(1.08); text-decoration: none; }
    .icon-btn svg { width: 16px; height: 16px; }
    .icon-btn.danger {
      background: var(--danger-bg);
      border-color: var(--danger-border);
      color: var(--danger-fg);
    }
    .icon-btn.danger:hover { background: var(--danger-hover-bg); }
    .status { margin: 10px 0 0; color: var(--status-fg); min-height: 1.25em; }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .file-row { gap: 8px; }
      .file-link { font-size: 15px; padding: 12px; }
      .header-create-form { width: 100%; }
      .header-file-input { width: 100%; }
      .header-actions .create-file-btn { min-width: 0; }
      .icon-btn { width: 44px; height: 44px; }
    }
  </style>
</head>
<body>
  <h1>Index of ${escapeHtml(localPath)}</h1>
  ${pickerSummary}
  <div class="header-actions">
    ${parentLink}
    ${createFileForm}
    ${createDirForm}
    ${actionButtons}
  </div>
  <p id="status" class="status"></p>
  <ul>${rows}</ul>
  <script>
    const status = document.getElementById('status');
    const newFileForm = document.getElementById('newFileForm');
    const newFileNameInput = document.getElementById('newFileName');
    const createFileBtn = document.getElementById('createFileBtn');
    const newDirForm = document.getElementById('newDirForm');
    const newDirNameInput = document.getElementById('newDirName');
    const createDirBtn = document.getElementById('createDirBtn');
    const setStatus = (message) => {
      status.textContent = message;
    };
    const readJsonPayload = async (response) => {
      try {
        return await response.json();
      } catch {
        return null;
      }
    };
    const RAW_ICON_HTML = ${JSON.stringify(rawFileIconHtml())};
    const DELETE_ICON_HTML = ${JSON.stringify(deleteFileIconHtml())};
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const createEntryLi = (entry, depth) => {
      const li = document.createElement('li');
      li.className = 'file-row';
      li.setAttribute('data-depth', String(depth));
      li.style.setProperty('--depth', String(depth));
      const suffix = entry.isDirectory ? '/' : '';
      const escapedName = escapeHtml(entry.name);
      const escapedPath = escapeHtml(entry.path);
      const browseHref = '/codex-local-browse' + encodeURI(entry.path);
      const expandBtn = entry.isDirectory
        ? '<button class="expand-btn" type="button" aria-label="Expand ' + escapedName + '" title="Expand ' + escapedName + '" data-path="' + escapedPath + '" data-expanded="0"><span class="expand-chevron"></span></button>'
        : '<span class="expand-spacer"></span>';
      const rawAction = entry.editable
        ? '<a class="icon-btn" aria-label="Raw ' + escapedName + '" href="' + browseHref + '?raw=1" title="Open raw">' + RAW_ICON_HTML + '</a>'
        : '';
      const deleteAction = '<button class="icon-btn danger delete-entry-btn" type="button" aria-label="Delete ' + escapedName + '" title="Delete ' + escapedName + '" data-path="' + escapedPath + '" data-name="' + escapedName + '" data-is-dir="' + (entry.isDirectory ? '1' : '0') + '">' + DELETE_ICON_HTML + '</button>';
      li.innerHTML = expandBtn + '<a class="file-link" href="' + browseHref + '">' + escapedName + suffix + '</a><span class="row-actions">' + rawAction + deleteAction + '</span>';
      return li;
    };
    const normalizeEntryName = (value) => {
      const trimmed = String(value || '').trim();
      if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\\\/]/.test(trimmed)) return '';
      return trimmed;
    };
    const createLocalFile = async () => {
      if (!(newFileNameInput instanceof HTMLInputElement)) return;
      const fileName = normalizeEntryName(newFileNameInput.value);
      if (!fileName) {
        setStatus('Enter a file name without path separators.');
        newFileNameInput.focus();
        return;
      }
      if (createFileBtn instanceof HTMLButtonElement) createFileBtn.disabled = true;
      setStatus('Creating ' + fileName + '...');
      try {
        const response = await fetch(location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fileName }),
        });
        const payload = await readJsonPayload(response);
        if (!response.ok) {
          setStatus(payload && payload.error ? String(payload.error) : 'Create file failed.');
          return;
        }
        const createdPath = payload && payload.data && typeof payload.data.path === 'string'
          ? payload.data.path
          : '';
        if (!createdPath) {
          setStatus('File created, but the editor path is missing.');
          return;
        }
        setStatus('File created. Opening editor...');
        window.location.assign('/codex-local-edit' + encodeURI(createdPath));
      } catch {
        setStatus('Create file failed.');
      } finally {
        if (createFileBtn instanceof HTMLButtonElement) createFileBtn.disabled = false;
      }
    };
    const createLocalDir = async () => {
      if (!(newDirNameInput instanceof HTMLInputElement)) return;
      const dirName = normalizeEntryName(newDirNameInput.value);
      if (!dirName) {
        setStatus('Enter a directory name without path separators.');
        newDirNameInput.focus();
        return;
      }
      if (createDirBtn instanceof HTMLButtonElement) createDirBtn.disabled = true;
      setStatus('Creating directory ' + dirName + '...');
      try {
        const response = await fetch(location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: dirName, type: 'directory' }),
        });
        const payload = await readJsonPayload(response);
        if (!response.ok) {
          setStatus(payload && payload.error ? String(payload.error) : 'Create directory failed.');
          return;
        }
        setStatus('Directory created. Refreshing...');
        window.location.reload();
      } catch {
        setStatus('Create directory failed.');
      } finally {
        if (createDirBtn instanceof HTMLButtonElement) createDirBtn.disabled = false;
      }
    };
    if (newFileForm instanceof HTMLFormElement) {
      newFileForm.addEventListener('submit', (event) => {
        event.preventDefault();
        createLocalFile();
      });
    }
    if (newDirForm instanceof HTMLFormElement) {
      newDirForm.addEventListener('submit', (event) => {
        event.preventDefault();
        createLocalDir();
      });
    }
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const expandBtn = target.closest('.expand-btn');
      if (expandBtn instanceof HTMLButtonElement) {
        event.preventDefault();
        const li = expandBtn.closest('.file-row');
        if (!li) return;
        const depth = Number(li.getAttribute('data-depth') || '0');
        if (expandBtn.getAttribute('data-expanded') === '1') {
          let next = li.nextElementSibling;
          while (next && next instanceof HTMLElement && next.classList.contains('file-row') && Number(next.getAttribute('data-depth') || '0') > depth) {
            const toRemove = next;
            next = next.nextElementSibling;
            toRemove.remove();
          }
          expandBtn.setAttribute('data-expanded', '0');
          return;
        }
        const dirPath = expandBtn.getAttribute('data-path') || '';
        if (!dirPath) return;
        expandBtn.setAttribute('data-expanded', '1');
        expandBtn.disabled = true;
        setStatus('Loading...');
        try {
          const response = await fetch('/codex-local-entries?path=' + encodeURIComponent(dirPath));
          const payload = await readJsonPayload(response);
          if (!response.ok) {
            setStatus(payload && payload.error ? String(payload.error) : 'Failed to load directory.');
            expandBtn.setAttribute('data-expanded', '0');
            return;
          }
          const entries = payload && payload.data && Array.isArray(payload.data.entries) ? payload.data.entries : [];
          const fragment = document.createDocumentFragment();
          for (const entry of entries) {
            fragment.appendChild(createEntryLi(entry, depth + 1));
          }
          li.after(fragment);
          setStatus('');
        } catch {
          setStatus('Failed to load directory.');
          expandBtn.setAttribute('data-expanded', '0');
        } finally {
          expandBtn.disabled = false;
        }
        return;
      }
      const deleteButton = target.closest('.delete-entry-btn');
      if (deleteButton instanceof HTMLButtonElement) {
        event.preventDefault();
        const entryPath = deleteButton.getAttribute('data-path') || '';
        const entryName = deleteButton.getAttribute('data-name') || 'entry';
        const isDir = deleteButton.getAttribute('data-is-dir') === '1';
        if (!entryPath) return;
        const confirmMsg = isDir ? 'Delete directory ' + entryName + ' and all its contents?' : 'Delete ' + entryName + '?';
        if (!window.confirm(confirmMsg)) return;
        deleteButton.disabled = true;
        setStatus('Deleting ' + entryName + '...');
        try {
          const response = await fetch('/codex-local-browse' + encodeURI(entryPath), { method: 'DELETE' });
          const payload = await readJsonPayload(response);
          if (!response.ok) {
            setStatus(payload && payload.error ? String(payload.error) : 'Delete failed.');
            deleteButton.disabled = false;
            return;
          }
          setStatus('Deleted ' + entryName + '. Refreshing...');
          window.location.reload();
        } catch {
          setStatus('Delete failed.');
          deleteButton.disabled = false;
        }
        return;
      }
      const button = target.closest('.open-folder-btn, .create-project-btn');
      if (!(button instanceof HTMLButtonElement)) return;

      const path = button.getAttribute('data-path') || '';
      const label = button.getAttribute('data-label') || '';
      const statusText = button.getAttribute('data-status') || 'Opening folder in Codex...';
      const errorText = button.getAttribute('data-error') || 'Failed to open folder.';
      if (!path) return;
      button.disabled = true;
      setStatus(statusText);
      try {
        const response = await fetch('/codex-api/project-root', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path,
            createIfMissing: button.classList.contains('create-project-btn'),
            label,
          }),
        });
        if (!response.ok) {
          setStatus(errorText);
          button.disabled = false;
          return;
        }
        setStatus('Folder opened. Returning to Codex...');
        const nextUrl = '/?openProjectPath=' + encodeURIComponent(path) + '#/';
        window.location.assign(nextUrl);
      } catch {
        setStatus(errorText);
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`
}

function markdownPreviewStyles(): string {
  return `
    :root {
      color-scheme: light dark;
      --preview-bg: #ffffff;
      --preview-fg: #24292f;
      --muted-fg: #57606a;
      --border: #d0d7de;
      --soft-bg: #f6f8fa;
      --blockquote-bg: #f6f8fa;
      --link-fg: #0969da;
      --link-hover: #1f6feb;
      --code-bg: rgba(175, 184, 193, 0.2);
      --code-fg: #24292f;
      --block-code-bg: #f6f8fa;
      --block-code-fg: #24292f;
      --table-bg: #ffffff;
      --table-head-bg: #f6f8fa;
      --syntax-keyword: #d73a49;
      --syntax-entity: #6f42c1;
      --syntax-constant: #005cc5;
      --syntax-string: #032f62;
      --syntax-variable: #e36209;
      --syntax-comment: #6a737d;
      --syntax-entity-tag: #22863a;
      --syntax-subst: #24292f;
      --syntax-markup-heading: #005cc5;
      --syntax-markup-list: #735c0f;
      --syntax-addition-fg: #22863a;
      --syntax-addition-bg: #f0fff4;
      --syntax-deletion-fg: #b31d28;
      --syntax-deletion-bg: #ffeef0;
      --highlight-bg: #fff3b0;
      --highlight-fg: #3b2300;
      --annotation-mark-bg: rgba(9, 105, 218, 0.12);
      --annotation-mark-border: #0969da;
      --annotation-comment-bg: #fff8c5;
      --annotation-comment-border: #d4a72c;
      --annotation-comment-fg: #3b2300;
      --annotation-comment-label: #9a6700;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --preview-bg: #0d1117;
        --preview-fg: #c9d1d9;
        --muted-fg: #8b949e;
        --border: #30363d;
        --soft-bg: #161b22;
        --blockquote-bg: #161b22;
        --link-fg: #58a6ff;
        --link-hover: #79c0ff;
        --code-bg: rgba(110, 118, 129, 0.4);
        --code-fg: #c9d1d9;
        --block-code-bg: #0d1117;
        --block-code-fg: #c9d1d9;
        --table-bg: #0d1117;
        --table-head-bg: #161b22;
        --syntax-keyword: #ff7b72;
        --syntax-entity: #d2a8ff;
        --syntax-constant: #79c0ff;
        --syntax-string: #a5d6ff;
        --syntax-variable: #ffa657;
        --syntax-comment: #8b949e;
        --syntax-entity-tag: #7ee787;
        --syntax-subst: #c9d1d9;
        --syntax-markup-heading: #1f6feb;
        --syntax-markup-list: #f2cc60;
        --syntax-addition-fg: #aff5b4;
        --syntax-addition-bg: #033a16;
        --syntax-deletion-fg: #ffdcd7;
        --syntax-deletion-bg: #67060c;
        --highlight-bg: rgba(187, 128, 9, 0.42);
        --highlight-fg: #f2cc60;
        --annotation-mark-bg: rgba(56, 139, 253, 0.18);
        --annotation-mark-border: #58a6ff;
        --annotation-comment-bg: rgba(210, 153, 34, 0.14);
        --annotation-comment-border: rgba(210, 153, 34, 0.38);
        --annotation-comment-fg: #f8e3a1;
        --annotation-comment-label: #e3b341;
      }
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      background: var(--preview-bg);
      color: var(--preview-fg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.58;
      letter-spacing: 0;
      padding: 22px;
      overflow-wrap: anywhere;
      -webkit-text-size-adjust: 100%;
    }
    .preview-meta {
      margin: 0 0 14px;
      color: var(--muted-fg);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .markdown-preview {
      width: min(82ch, 100%);
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }
    .message-text,
    .message-heading,
    .message-blockquote,
    .message-collapse,
    .message-list,
    .message-table-wrap,
    .message-code-block,
    .message-divider { margin: 0; }
    .message-text {
      white-space: pre-wrap;
      color: var(--preview-fg);
    }
    .message-heading {
      color: var(--preview-fg);
      font-weight: 650;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .message-heading-h1 { font-size: 1.75rem; }
    .message-heading-h2 { font-size: 1.45rem; }
    .message-heading-h3 { font-size: 1.25rem; }
    .message-heading-h4 { font-size: 1.08rem; }
    .message-heading-h5 { font-size: 0.95rem; text-transform: uppercase; }
    .message-heading-h6 { font-size: 0.82rem; color: var(--muted-fg); text-transform: uppercase; }
    .message-blockquote {
      border-left: 4px solid var(--border);
      border-radius: 0 8px 8px 0;
      background: var(--blockquote-bg);
      color: var(--preview-fg);
      padding: 0.45rem 0.9rem;
      white-space: pre-wrap;
    }
    .message-collapse {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--blockquote-bg);
      color: var(--preview-fg);
      padding: 0.55rem 0.75rem;
      overflow-wrap: anywhere;
    }
    .message-collapse-summary {
      margin: -0.25rem -0.45rem;
      border-radius: 6px;
      padding: 0.25rem 0.45rem;
      color: var(--preview-fg);
      cursor: pointer;
      font-weight: 650;
    }
    .message-collapse-summary:hover { background: var(--code-bg); }
    .message-collapse > :not(.message-collapse-summary) { margin-top: 0.6rem; }
    .message-list {
      padding-left: 1.35rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .message-list-unordered { list-style: disc; }
    .message-list-ordered { list-style: decimal; }
    .message-list-item { padding-left: 0.15rem; }
    .message-list-item-content {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .message-list-item-text { white-space: pre-wrap; }
    .message-task-list {
      list-style: none;
      padding-left: 0;
    }
    .message-task-item {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
    }
    .message-task-checkbox {
      margin-top: 0.08rem;
      color: var(--muted-fg);
      user-select: none;
    }
    .message-table-wrap {
      width: 100%;
      overflow-x: auto;
    }
    .message-table {
      min-width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--table-bg);
      color: var(--preview-fg);
      font-size: 0.95em;
    }
    .message-table-head-cell,
    .message-table-cell {
      border-left: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 0.55rem 0.72rem;
      vertical-align: top;
      white-space: pre-wrap;
    }
    .message-table-head-cell:first-child,
    .message-table-cell:first-child { border-left: 0; }
    .message-table-head-cell {
      background: var(--table-head-bg);
      font-weight: 650;
    }
    .message-table-body-row:last-child .message-table-cell { border-bottom: 0; }
    .message-inline-code {
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--code-bg);
      color: var(--code-fg);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
      padding: 0.1rem 0.32rem;
    }
    .message-code-block {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--block-code-bg);
      color: var(--block-code-fg);
    }
    .message-code-language {
      border-bottom: 1px solid var(--border);
      color: var(--muted-fg);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
      padding: 0.45rem 2.8rem 0.45rem 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .message-code-pre {
      margin: 0;
      overflow-x: auto;
      padding: 0.8rem 2.8rem 0.8rem 0.8rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre;
    }
    .message-code-copy-button {
      position: absolute;
      top: 0.45rem;
      right: 0.55rem;
      z-index: 2;
      display: inline-flex;
      width: 1.5rem;
      height: 1.5rem;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--block-code-bg) 86%, var(--preview-bg));
      color: var(--muted-fg);
      opacity: 0.78;
      cursor: pointer;
      transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease, opacity 140ms ease;
    }
    .message-code-copy-button:hover,
    .message-code-copy-button:focus-visible {
      border-color: var(--syntax-constant);
      color: var(--syntax-constant);
      opacity: 1;
    }
    .message-code-copy-button[data-copied="true"] {
      border-color: var(--syntax-addition-fg);
      background: var(--syntax-addition-bg);
      color: var(--syntax-addition-fg);
      opacity: 1;
    }
    .message-code-copy-icon {
      width: 0.86rem;
      height: 0.86rem;
      display: block;
      background: currentColor;
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z'/%3E%3Cpath d='M4 8v10a2 2 0 0 0 2 2h10'/%3E%3C/svg%3E") center / contain no-repeat;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z'/%3E%3Cpath d='M4 8v10a2 2 0 0 0 2 2h10'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    .message-code-pre .hljs {
      display: block;
      background: transparent;
      color: var(--block-code-fg);
      padding: 0;
    }
    .hljs-doctag,
    .hljs-keyword,
    .hljs-meta .hljs-keyword,
    .hljs-template-tag,
    .hljs-template-variable,
    .hljs-type,
    .hljs-variable.language_ { color: var(--syntax-keyword); }
    .hljs-title,
    .hljs-title.class_,
    .hljs-title.class_.inherited__,
    .hljs-title.function_ { color: var(--syntax-entity); }
    .hljs-attr,
    .hljs-attribute,
    .hljs-literal,
    .hljs-meta,
    .hljs-number,
    .hljs-operator,
    .hljs-variable,
    .hljs-selector-attr,
    .hljs-selector-class,
    .hljs-selector-id { color: var(--syntax-constant); }
    .hljs-regexp,
    .hljs-string,
    .hljs-meta .hljs-string { color: var(--syntax-string); }
    .hljs-built_in,
    .hljs-symbol { color: var(--syntax-variable); }
    .hljs-comment,
    .hljs-code,
    .hljs-formula { color: var(--syntax-comment); }
    .hljs-name,
    .hljs-quote,
    .hljs-selector-tag,
    .hljs-selector-pseudo { color: var(--syntax-entity-tag); }
    .hljs-subst { color: var(--syntax-subst); }
    .hljs-section {
      color: var(--syntax-markup-heading);
      font-weight: 600;
    }
    .hljs-bullet { color: var(--syntax-markup-list); }
    .hljs-emphasis {
      color: var(--block-code-fg);
      font-style: italic;
    }
    .hljs-strong {
      color: var(--block-code-fg);
      font-weight: 600;
    }
    .hljs-addition {
      color: var(--syntax-addition-fg);
      background-color: var(--syntax-addition-bg);
    }
    .hljs-deletion {
      color: var(--syntax-deletion-fg);
      background-color: var(--syntax-deletion-bg);
    }
    .message-file-link {
      color: var(--link-fg);
      text-decoration: none;
      text-underline-offset: 2px;
    }
    .message-file-link:hover {
      color: var(--link-hover);
      text-decoration: underline;
    }
    .message-bold-text { font-weight: 650; }
    .message-italic-text { font-style: italic; }
    .message-strikethrough-text {
      text-decoration: line-through;
      color: var(--muted-fg);
    }
    .message-highlight {
      border-radius: 3px;
      background: var(--highlight-bg);
      color: var(--highlight-fg);
      padding: 0 0.12em;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .message-annotation {
      display: inline;
      vertical-align: baseline;
    }
    .message-annotation > .message-annotation-comment {
      margin-left: 0.25rem;
    }
    .message-annotation-mark {
      border-radius: 3px;
      border-bottom: 2px solid var(--annotation-mark-border);
      background: var(--annotation-mark-bg);
      color: inherit;
      padding: 0 0.12em;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .message-annotation-comment {
      display: inline-flex;
      max-width: 100%;
      align-items: baseline;
      gap: 0.3rem;
      border: 1px solid var(--annotation-comment-border);
      border-radius: 6px;
      background: var(--annotation-comment-bg);
      color: var(--annotation-comment-fg);
      padding: 0.08rem 0.4rem;
      font-size: 0.82em;
      line-height: 1.35;
      vertical-align: baseline;
      overflow-wrap: anywhere;
    }
    .message-annotation-label {
      flex-shrink: 0;
      color: var(--annotation-comment-label);
      font-size: 0.72em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .message-annotation-body {
      min-width: 0;
    }
    .message-divider {
      height: 1px;
      border: 0;
      background: var(--border);
    }
    .message-markdown-image {
      display: block;
      width: auto;
      height: auto;
      max-width: min(560px, 100%);
      max-height: min(460px, 68vh);
      object-fit: contain;
      background: #fff;
      border-radius: 8px;
    }
    @media (max-width: 720px) {
      body { padding: 16px; }
      .markdown-preview { width: 100%; }
      .message-heading-h1 { font-size: 1.5rem; }
      .message-heading-h2 { font-size: 1.25rem; }
    }
  `
}

function markdownPreviewCodeCopyButtonHtml(): string {
  return '<button class="message-code-copy-button" type="button" title="Copy code" aria-label="Copy code"><span class="message-code-copy-icon" aria-hidden="true"></span></button>'
}

function addMarkdownPreviewCodeCopyButtons(html: string): string {
  if (!html.includes('message-code-block') || html.includes('message-code-copy-button')) return html
  return html.replace(
    /<div\b(?=[^>]*class="[^"]*\bmessage-code-block\b[^"]*")[^>]*>/gu,
    (openingTag) => {
      const focusableOpeningTag = /\stabindex=/u.test(openingTag)
        ? openingTag
        : openingTag.replace(/>$/u, ' tabindex="0">')
      return `${focusableOpeningTag}${markdownPreviewCodeCopyButtonHtml()}`
    },
  )
}

function markdownPreviewScript(localPath: string): string {
  const safePathLiteral = escapeForInlineScriptString(localPath)
  return `
    (() => {
      const sourcePath = ${safePathLiteral};
      const interactiveSelector = 'a[href], button, input, textarea, select, label, summary';
      const serializeRect = (rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
      let activePreviewActionTarget = null;
      let copiedCodeBlockResetTimer = 0;
      let floatingActionPositionFrame = 0;
      let highlightSelectionFrame = 0;
      let isPreviewPointerSelectionActive = false;
      const writeTextToClipboard = async (text) => {
        if (!text) return false;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        const fallback = document.createElement('textarea');
        fallback.value = text;
        fallback.setAttribute('readonly', 'readonly');
        fallback.style.position = 'fixed';
        fallback.style.top = '-9999px';
        fallback.style.left = '-9999px';
        fallback.style.opacity = '0';
        document.body.appendChild(fallback);
        fallback.focus();
        fallback.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(fallback);
        if (!copied) throw new Error('Clipboard copy failed');
        return true;
      };
      const copyCodeBlock = async (button) => {
        const block = button.closest('.message-code-block');
        if (!block) return;
        const code = block.querySelector('.message-code-pre code');
        const content = code?.textContent || '';
        if (!content) return;
        try {
          await writeTextToClipboard(content);
        } catch {
          return;
        }
        const previousCopiedButton = document.querySelector('.message-code-copy-button[data-copied="true"]');
        if (previousCopiedButton && previousCopiedButton !== button) {
          previousCopiedButton.dataset.copied = 'false';
          previousCopiedButton.setAttribute('aria-label', 'Copy code');
          previousCopiedButton.setAttribute('title', 'Copy code');
        }
        button.dataset.copied = 'true';
        button.setAttribute('aria-label', 'Code copied');
        button.setAttribute('title', 'Code copied');
        if (copiedCodeBlockResetTimer) {
          window.clearTimeout(copiedCodeBlockResetTimer);
        }
        copiedCodeBlockResetTimer = window.setTimeout(() => {
          button.dataset.copied = 'false';
          button.setAttribute('aria-label', 'Copy code');
          button.setAttribute('title', 'Copy code');
          copiedCodeBlockResetTimer = 0;
        }, 1400);
      };
      const postHighlightActionDismiss = () => {
        activePreviewActionTarget = null;
        window.parent.postMessage({
          type: 'codex-local-markdown-highlight-dismiss',
          path: sourcePath,
        }, '*');
      };
      const postSaveRequest = () => {
        window.parent.postMessage({
          type: 'codex-local-markdown-preview-save',
          path: sourcePath,
        }, '*');
      };
      const isPreviewSaveShortcut = (event) => {
        if (event.defaultPrevented) return false;
        if (!(event.ctrlKey || event.metaKey)) return false;
        if (event.altKey || event.shiftKey) return false;
        const key = String(event.key || '').toLowerCase();
        return key === 's' || event.code === 'KeyS';
      };
      const sourceElementForTarget = (target) => {
        const targetElement = target instanceof Element
          ? target
          : target && target.nodeType === Node.TEXT_NODE
            ? target.parentElement
            : null;
        if (!targetElement) return null;
        if (targetElement.closest(interactiveSelector)) return null;
        return targetElement.closest('[data-source-line]');
      };
      const dismissInactiveHighlightSelection = () => {
        if (activePreviewActionTarget) return;
        postHighlightActionDismiss();
      };

      document.addEventListener('dblclick', (event) => {
        const sourceElement = sourceElementForTarget(event.target);
        if (!sourceElement) return;
        const sourceLine = Number.parseInt(sourceElement.getAttribute('data-source-line') || '', 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return;
        const sourceEndLine = Number.parseInt(sourceElement.getAttribute('data-source-end-line') || '', 10);
        event.preventDefault();
        event.stopPropagation();
        window.parent.postMessage({
          type: 'codex-local-markdown-preview-jump',
          path: sourcePath,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
        }, '*');
      });

      const postHighlightSelection = (options = {}) => {
        const dismissWhenEmpty = options.dismissWhenEmpty === true;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          if (dismissWhenEmpty) dismissInactiveHighlightSelection();
          return false;
        }
        const text = selection.toString().replace(/\\u00a0/g, ' ').trim();
        if (!text) {
          if (dismissWhenEmpty) dismissInactiveHighlightSelection();
          return false;
        }
        const range = selection.getRangeAt(0);
        const sourceElement = sourceElementForTarget(range.commonAncestorContainer)
          || sourceElementForTarget(range.startContainer)
          || sourceElementForTarget(range.endContainer);
        if (!sourceElement) {
          if (dismissWhenEmpty) dismissInactiveHighlightSelection();
          return false;
        }
        const sourceLine = Number.parseInt(sourceElement.getAttribute('data-source-line') || '', 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) {
          if (dismissWhenEmpty) dismissInactiveHighlightSelection();
          return false;
        }
        const sourceEndLine = Number.parseInt(sourceElement.getAttribute('data-source-end-line') || '', 10);
        const rect = range.getBoundingClientRect();
        const inlineCodeElements = Array.from(sourceElement.querySelectorAll('code.message-inline-code'));
        const containsInlineCode = inlineCodeElements.some((element) => range.intersectsNode(element));
        const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
          ? range.endContainer
          : range.endContainer.parentElement;
        const endingInlineCode = endElement?.closest('code.message-inline-code')
          || (range.endContainer.nodeType === Node.ELEMENT_NODE && range.endOffset > 0
            ? range.endContainer.childNodes[range.endOffset - 1]?.nodeType === Node.ELEMENT_NODE
              ? range.endContainer.childNodes[range.endOffset - 1]
              : range.endContainer.childNodes[range.endOffset - 1]?.parentElement
            : null)?.closest?.('code.message-inline-code');
        const endsInInlineCode = Boolean(endingInlineCode);
        activePreviewActionTarget = null;
        window.parent.postMessage({
          type: 'codex-local-markdown-preview-selection',
          path: sourcePath,
          text,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          containsInlineCode,
          endsInInlineCode,
          rect: serializeRect(rect),
        }, '*');
        return true;
      };

      const scheduleHighlightSelectionPost = (dismissWhenEmpty = true) => {
        if (highlightSelectionFrame) return;
        highlightSelectionFrame = window.requestAnimationFrame(() => {
          highlightSelectionFrame = 0;
          if (isPreviewPointerSelectionActive) return;
          postHighlightSelection({ dismissWhenEmpty });
        });
      };

      const postAnnotationMarkClick = (annotationMarkElement) => {
        const sourceElement = sourceElementForTarget(annotationMarkElement);
        if (!sourceElement) return false;
        const sourceLine = Number.parseInt(sourceElement.getAttribute('data-source-line') || '', 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return false;
        const sourceEndLine = Number.parseInt(sourceElement.getAttribute('data-source-end-line') || '', 10);
        const markText = annotationMarkElement.textContent || '';
        const markSource = annotationMarkElement.getAttribute('data-annotation-mark') || markText;
        const siblingMarks = Array.from(sourceElement.querySelectorAll('mark.message-annotation-mark'));
        const occurrence = Math.max(0, siblingMarks
          .filter((element) => (element.getAttribute('data-annotation-mark') || element.textContent || '') === markSource)
          .indexOf(annotationMarkElement));
        window.parent.postMessage({
          type: 'codex-local-markdown-mark-click',
          path: sourcePath,
          text: markText,
          sourceText: markSource,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          occurrence,
          rect: serializeRect(annotationMarkElement.getBoundingClientRect()),
        }, '*');
        return true;
      };

      const postCommentClick = (commentElement) => {
        const sourceElement = sourceElementForTarget(commentElement);
        if (!sourceElement) return false;
        const sourceLine = Number.parseInt(sourceElement.getAttribute('data-source-line') || '', 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return false;
        const sourceEndLine = Number.parseInt(sourceElement.getAttribute('data-source-end-line') || '', 10);
        const commentBodyElement = commentElement.querySelector('.message-annotation-body');
        const commentText = commentElement.getAttribute('data-annotation-comment') || commentBodyElement?.textContent || '';
        const siblingComments = Array.from(sourceElement.querySelectorAll('.message-annotation-comment'));
        const occurrence = Math.max(0, siblingComments
          .filter((element) => (element.getAttribute('data-annotation-comment') || element.querySelector('.message-annotation-body')?.textContent || '') === commentText)
          .indexOf(commentElement));
        window.parent.postMessage({
          type: 'codex-local-markdown-comment-click',
          path: sourcePath,
          text: commentText,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          occurrence,
          rect: serializeRect(commentElement.getBoundingClientRect()),
        }, '*');
        return true;
      };

      const postHighlightClick = (highlightElement) => {
        const sourceElement = sourceElementForTarget(highlightElement);
        if (!sourceElement) return false;
        const sourceLine = Number.parseInt(sourceElement.getAttribute('data-source-line') || '', 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return false;
        const sourceEndLine = Number.parseInt(sourceElement.getAttribute('data-source-end-line') || '', 10);
        const highlightText = highlightElement.textContent || '';
        const highlightSource = highlightElement.getAttribute('data-highlight-source') || highlightText;
        const siblingHighlights = Array.from(sourceElement.querySelectorAll('mark.message-highlight'));
        const occurrence = Math.max(0, siblingHighlights
          .filter((element) => (element.getAttribute('data-highlight-source') || element.textContent || '') === highlightSource)
          .indexOf(highlightElement));
        window.parent.postMessage({
          type: 'codex-local-markdown-highlight-click',
          path: sourcePath,
          text: highlightText,
          sourceText: highlightSource,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          occurrence,
          rect: serializeRect(highlightElement.getBoundingClientRect()),
        }, '*');
        return true;
      };

      const postActiveFloatingActionPosition = () => {
        if (postHighlightSelection()) return;
        if (!activePreviewActionTarget || !activePreviewActionTarget.element?.isConnected) return;
        if (activePreviewActionTarget.kind === 'mark') {
          postAnnotationMarkClick(activePreviewActionTarget.element);
          return;
        }
        if (activePreviewActionTarget.kind === 'highlight') {
          postHighlightClick(activePreviewActionTarget.element);
          return;
        }
        if (activePreviewActionTarget.kind === 'comment') {
          postCommentClick(activePreviewActionTarget.element);
        }
      };

      const scheduleFloatingActionPositionUpdate = () => {
        if (floatingActionPositionFrame) return;
        floatingActionPositionFrame = window.requestAnimationFrame(() => {
          floatingActionPositionFrame = 0;
          postActiveFloatingActionPosition();
        });
      };

      document.addEventListener('click', (event) => {
        const targetElement = event.target instanceof Element
          ? event.target
          : event.target && event.target.nodeType === Node.TEXT_NODE
            ? event.target.parentElement
            : null;
        const codeCopyButton = targetElement?.closest('button.message-code-copy-button');
        if (codeCopyButton) {
          event.preventDefault();
          event.stopPropagation();
          void copyCodeBlock(codeCopyButton);
          return;
        }
        const imageElement = targetElement?.closest('img.message-markdown-image[data-browse-href]');
        const imageBrowseHref = imageElement?.getAttribute('data-browse-href') || '';
        if (imageBrowseHref && imageBrowseHref !== '#') {
          event.preventDefault();
          event.stopPropagation();
          window.open(imageBrowseHref, '_blank', 'noopener,noreferrer');
          return;
        }
        const commentElement = targetElement?.closest('.message-annotation-comment');
        if (commentElement) {
          event.preventDefault();
          event.stopPropagation();
          activePreviewActionTarget = { kind: 'comment', element: commentElement };
          postCommentClick(commentElement);
          return;
        }
        const annotationMarkElement = targetElement?.closest('mark.message-annotation-mark');
        if (annotationMarkElement) {
          event.preventDefault();
          event.stopPropagation();
          activePreviewActionTarget = { kind: 'mark', element: annotationMarkElement };
          postAnnotationMarkClick(annotationMarkElement);
          return;
        }
        const highlightElement = targetElement?.closest('mark.message-highlight');
        if (!highlightElement) return;
        event.preventDefault();
        event.stopPropagation();
        activePreviewActionTarget = { kind: 'highlight', element: highlightElement };
        postHighlightClick(highlightElement);
      });

      document.addEventListener('keydown', (event) => {
        if (!isPreviewSaveShortcut(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          postSaveRequest();
        }
      }, { capture: true });
      const previewPointerDownEvent = typeof window.PointerEvent === 'function' ? 'pointerdown' : 'mousedown';
      const previewPointerUpEvent = typeof window.PointerEvent === 'function' ? 'pointerup' : 'mouseup';
      const beginPreviewPointerSelection = () => {
        isPreviewPointerSelectionActive = true;
        postHighlightActionDismiss();
      };
      const endPreviewPointerSelection = () => {
        if (!isPreviewPointerSelectionActive) return;
        isPreviewPointerSelectionActive = false;
        scheduleHighlightSelectionPost(true);
      };
      document.addEventListener(previewPointerDownEvent, beginPreviewPointerSelection, { capture: true });
      document.addEventListener(previewPointerUpEvent, endPreviewPointerSelection, { capture: true });
      if (typeof window.PointerEvent === 'function') {
        document.addEventListener('pointercancel', endPreviewPointerSelection, { capture: true });
      }
      document.addEventListener('selectionchange', () => scheduleHighlightSelectionPost(true));
      document.addEventListener('keyup', () => scheduleHighlightSelectionPost(true));
      window.addEventListener('scroll', scheduleFloatingActionPositionUpdate, { passive: true });
      window.addEventListener('resize', scheduleFloatingActionPositionUpdate, { passive: true });
    })();
  `
}

export function createMarkdownPreviewHtml(localPath: string, markdown: string): string {
  const rendered = addMarkdownPreviewCodeCopyButtons(renderMarkdownContent(markdown, {
    cwd: dirname(localPath),
    kind: 'message',
    highlightVersion: 0,
  }).html)
  const bodyHtml = rendered.trim()
    ? rendered
    : '<p class="message-text">Nothing to preview.</p>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Preview ${escapeHtml(localPath)}</title>
  <link rel="stylesheet" href="${KATEX_STYLESHEET_HREF}" />
  <style>${markdownPreviewStyles()}</style>
</head>
<body>
  <p class="preview-meta">${escapeHtml(localPath)}</p>
  <article class="markdown-preview message-text-flow">${bodyHtml}</article>
  <script>${markdownPreviewScript(localPath)}</script>
</body>
</html>`
}

export async function createTextEditorHtml(localPath: string): Promise<string> {
  const content = await readFile(localPath, 'utf8')
  const parentPath = dirname(localPath)
  const language = getEditorModeForPath(localPath)
  const languageLabel = getEditorLanguageLabel(language)
  const languageSelectOptions = EDITOR_LANGUAGE_OPTIONS
    .map((option) => `<option value="${escapeHtml(option.mode)}"${option.mode === language ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')
  const languageSelect = `<label class="lang-label" for="langSelect">Language</label><select id="langSelect" class="lang-select" aria-label="Editor language">${languageSelectOptions}</select>`
  const supportsMarkdownPreview = isMarkdownPath(localPath)
  const escapedEditorPath = escapeForInlineScriptString(localPath)
  const copyReferenceButton = `<button id="copyRefBtn" type="button">Copy ref</button>`
  const gitDiffButton = '<button id="gitDiffBtn" type="button">Git diff</button>'
  const previewButton = supportsMarkdownPreview
    ? '<button id="previewBtn" type="button" aria-pressed="false">Preview</button>'
    : ''
  const floatingHighlightControls = supportsMarkdownPreview
    ? '<div id="floatingSelectionActions" class="floating-highlight-action floating-action-group" hidden><button id="floatingHighlightBtn" type="button">Highlight</button><button id="floatingMarkBtn" type="button">Mark</button><button id="floatingSelectionCommentBtn" type="button">Add comment</button></div><div id="floatingHighlightActions" class="floating-highlight-action floating-action-group" hidden><button id="floatingRemoveHighlightBtn" class="danger" type="button">Remove highlight</button><button id="floatingAddHighlightCommentBtn" type="button">Add comment</button></div><div id="floatingMarkActions" class="floating-highlight-action floating-action-group" hidden><button id="floatingUnmarkBtn" type="button">Unmark</button><button id="floatingAddMarkCommentBtn" type="button">Add comment</button></div><div id="floatingCommentActions" class="floating-highlight-action floating-action-group" hidden><button id="floatingAddCommentBtn" type="button">Add comment</button><button id="floatingEditCommentBtn" type="button">Edit comment</button><button id="floatingRemoveCommentBtn" class="danger" type="button">Remove comment</button></div><form id="floatingCommentEditor" class="floating-highlight-action floating-comment-editor" hidden><label id="floatingCommentEditorTitle" class="floating-comment-title" for="floatingCommentInput">Add comment</label><textarea id="floatingCommentInput" class="floating-comment-input" rows="3"></textarea><div class="floating-comment-row"><button id="floatingCancelCommentBtn" type="button">Cancel</button><button id="floatingSaveCommentBtn" type="submit">Save</button></div></form>'
    : ''
  const previewPane = supportsMarkdownPreview
    ? '<div id="previewSplitter" class="preview-splitter" role="separator" aria-orientation="vertical" aria-label="Resize markdown preview" tabindex="0" hidden></div><iframe id="previewFrame" class="preview-pane" title="Markdown preview" hidden></iframe>'
    : ''
  const safeContentLiteral = escapeForInlineScriptString(content)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Edit ${escapeHtml(localPath)}</title>
  <style>
    @font-face {
      font-family: "CodexLocalEditorLatin";
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: local("SFMono-Regular"), local("SF Mono"), local("Menlo"), local("Monaco"), local("Consolas"), local("Liberation Mono"), local("Roboto Mono"), local("Droid Sans Mono"), local("Courier New");
      unicode-range: U+0000-024F, U+1E00-1EFF, U+2000-206F, U+2070-209F, U+20A0-20CF, U+2100-214F, U+2190-21FF, U+2200-22FF;
    }
    :root {
      color-scheme: light dark;
      --page-bg: #f6f8fa;
      --page-fg: #24292f;
      --toolbar-bg: #ffffff;
      --toolbar-border: #d0d7de;
      --control-bg: #f6f8fa;
      --control-fg: #24292f;
      --control-border: #d0d7de;
      --status-fg: #0969da;
      --preview-status-fg: #57606a;
      --ace-bg: #ffffff;
      --ace-fg: #24292f;
      --ace-gutter-bg: #f6f8fa;
      --ace-gutter-fg: #57606a;
      --ace-gutter-active-bg: #eaeef2;
      --ace-active-line: rgba(208, 215, 222, 0.42);
      --ace-selection: rgba(9, 105, 218, 0.24);
      --ace-selected-word-border: rgba(9, 105, 218, 0.42);
      --ace-cursor: #24292f;
      --ace-bracket-border: #d0d7de;
      --ace-invisible: #afb8c1;
      --syntax-keyword: #cf222e;
      --syntax-entity: #8250df;
      --syntax-constant: #0550ae;
      --syntax-string: #0a3069;
      --syntax-variable: #953800;
      --syntax-comment: #6e7781;
      --syntax-entity-tag: #116329;
      --syntax-markup-heading: #0550ae;
      --syntax-markup-list: #3b2300;
      --syntax-addition-fg: #116329;
      --syntax-addition-bg: #dafbe1;
      --syntax-deletion-fg: #82071e;
      --syntax-deletion-bg: #ffebe9;
      --syntax-invalid-fg: #f6f8fa;
      --syntax-invalid-bg: #82071e;
      --editor-font-family: "CodexLocalEditorLatin", "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Roboto Mono", "Droid Sans Mono", "Courier New", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
      --editor-font-weight: 400;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --page-bg: #0d1117;
        --page-fg: #c9d1d9;
        --toolbar-bg: #161b22;
        --toolbar-border: #30363d;
        --control-bg: #21262d;
        --control-fg: #c9d1d9;
        --control-border: #30363d;
        --status-fg: #58a6ff;
        --preview-status-fg: #8b949e;
        --ace-bg: #0d1117;
        --ace-fg: #c9d1d9;
        --ace-gutter-bg: #161b22;
        --ace-gutter-fg: #8b949e;
        --ace-gutter-active-bg: #21262d;
        --ace-active-line: rgba(110, 118, 129, 0.18);
        --ace-selection: rgba(56, 139, 253, 0.32);
        --ace-selected-word-border: rgba(56, 139, 253, 0.48);
        --ace-cursor: #c9d1d9;
        --ace-bracket-border: #6e7681;
        --ace-invisible: #6e7681;
        --syntax-keyword: #ff7b72;
        --syntax-entity: #d2a8ff;
        --syntax-constant: #79c0ff;
        --syntax-string: #a5d6ff;
        --syntax-variable: #ffa657;
        --syntax-comment: #8b949e;
        --syntax-entity-tag: #7ee787;
        --syntax-markup-heading: #1f6feb;
        --syntax-markup-list: #f2cc60;
        --syntax-addition-fg: #aff5b4;
        --syntax-addition-bg: #033a16;
        --syntax-deletion-fg: #ffdcd7;
        --syntax-deletion-bg: #67060c;
        --syntax-invalid-fg: #f0f6fc;
        --syntax-invalid-bg: #8e1519;
      }
    }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--page-bg); color: var(--page-fg); display: flex; flex-direction: column; overflow: hidden; -webkit-text-size-adjust: 100%; }
    .toolbar { position: sticky; top: 0; z-index: 10; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--toolbar-bg); border-bottom: 1px solid var(--toolbar-border); font-size: 13px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button, a { background: var(--control-bg); color: var(--control-fg); border: 1px solid var(--control-border); padding: 5px 10px; border-radius: 6px; text-decoration: none; cursor: pointer; font: inherit; font-size: 13px; display: inline-flex; align-items: center; white-space: nowrap; }
    button:hover, a:hover { filter: brightness(1.08); }
    button:disabled { opacity: 0.65; cursor: default; }
    button[aria-pressed="true"] { border-color: var(--status-fg); color: var(--status-fg); }
    .lang-label { font-size: 12px; color: var(--control-fg); white-space: nowrap; }
    .lang-select { background: var(--control-bg); color: var(--control-fg); border: 1px solid var(--control-border); border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px; cursor: pointer; max-width: 60vw; }
    .git-diff-panel { display: none; min-width: 0; flex: 1 1 0; flex-direction: column; background: var(--page-bg); }
    .git-diff-panel[hidden] { display: none; }
    .editor-shell[data-diff="true"] .git-diff-panel { display: flex; }
    .editor-shell[data-diff="true"] #editor, .editor-shell[data-diff="true"] .preview-splitter, .editor-shell[data-diff="true"] .preview-pane { display: none; }
    .git-diff-card { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 12px; background: var(--toolbar-bg); }
    .git-diff-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .git-diff-title { margin: 0; font-size: 16px; }
    .git-diff-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .git-diff-label { font-size: 12px; color: var(--preview-status-fg); }
    .git-diff-select { min-width: min(360px, 44vw); max-width: 100%; background: var(--control-bg); color: var(--control-fg); border: 1px solid var(--control-border); border-radius: 6px; padding: 6px 8px; font: inherit; }
    .git-diff-editors { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 14px; border: 1px solid var(--toolbar-border); border-radius: 6px; overflow: hidden; }
    .git-diff-editor-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .git-diff-editor-pane + .git-diff-editor-pane { border-left: 1px solid var(--toolbar-border); }
    .git-diff-pane-title { padding: 6px 10px; color: var(--preview-status-fg); background: var(--ace-gutter-bg); border-bottom: 1px solid var(--toolbar-border); font-size: 12px; font-weight: 600; }
    .git-diff-legend { display: inline-flex; gap: 8px; margin-left: auto; font-size: 12px; font-weight: 400; }
    .git-diff-legend span { padding: 1px 5px; border-radius: 3px; }
    .git-diff-legend .added { color: var(--syntax-addition-fg); background: var(--syntax-addition-bg); }
    .git-diff-legend .removed { color: var(--syntax-deletion-fg); background: var(--syntax-deletion-bg); }
    .git-diff-editor { min-height: 0; flex: 1; }
    .git-diff-overview { width: 14px; min-height: 0; position: relative; border-left: 1px solid var(--toolbar-border); background: var(--ace-gutter-bg); cursor: pointer; }
    .git-diff-overview-marker { position: absolute; left: 2px; right: 2px; border-radius: 2px; min-height: 2px; }
    .git-diff-overview-marker.remove { background: color-mix(in srgb, var(--syntax-deletion-fg) 50%, var(--syntax-deletion-bg)); }
    .git-diff-overview-marker.add { background: color-mix(in srgb, var(--syntax-addition-fg) 50%, var(--syntax-addition-bg)); }
    .git-diff-overview-viewport { position: absolute; left: 0; right: 0; border: 1px solid var(--status-fg); border-radius: 2px; pointer-events: none; }
    .floating-highlight-action {
      position: fixed;
      z-index: 50;
      transform: translate(-50%, calc(-100% - 10px));
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      white-space: nowrap;
    }
    .floating-highlight-action[data-placement="below"] {
      transform: translate(-50%, 10px);
    }
    .floating-highlight-action.danger {
      border-color: #d1242f;
      color: #d1242f;
    }
    .floating-action-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 0;
      background: transparent;
      box-shadow: none;
      padding: 0;
    }
    .floating-action-group button {
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      white-space: nowrap;
    }
    .floating-action-group button.danger {
      border-color: #d1242f;
      color: #d1242f;
    }
    .floating-comment-editor {
      width: min(320px, calc(100vw - 24px));
      padding: 10px;
      border: 1px solid var(--control-border);
      border-radius: 8px;
      background: var(--toolbar-bg);
      color: var(--page-fg);
      display: flex;
      flex-direction: column;
      gap: 8px;
      white-space: normal;
    }
    .floating-comment-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted-fg);
    }
    .floating-comment-input {
      min-height: 76px;
      resize: vertical;
      border: 1px solid var(--control-border);
      border-radius: 6px;
      padding: 8px;
      background: var(--control-bg);
      color: var(--control-fg);
      font: inherit;
      line-height: 1.35;
    }
    .floating-comment-row {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }
    @media (prefers-color-scheme: dark) {
      .floating-highlight-action.danger {
        border-color: #ff7b72;
        color: #ff7b72;
      }
      .floating-action-group button.danger {
        border-color: #ff7b72;
        color: #ff7b72;
      }
    }
    .floating-highlight-action[hidden] { display: none; }
    .editor-shell { --preview-editor-ratio: 0.48; flex: 1 1 auto; min-height: 0; width: 100%; display: flex; align-items: stretch; overflow: hidden; }
    #editor { flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%; border: none; overflow: hidden; }
    .editor-shell[data-preview="true"] #editor {
      flex: 0 0 calc(var(--preview-editor-ratio) * 100%);
      width: calc(var(--preview-editor-ratio) * 100%);
    }
    .editor-shell[data-diff="true"] .preview-pane { display: none; }
    .preview-splitter {
      display: none;
      flex: 0 0 12px;
      width: 12px;
      cursor: col-resize;
      touch-action: none;
      user-select: none;
      background: transparent;
      position: relative;
    }
    .preview-splitter::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 50%;
      width: 1px;
      transform: translateX(-50%);
      background: var(--toolbar-border);
    }
    .preview-splitter:hover::before,
    .preview-splitter.is-dragging::before {
      background: var(--status-fg);
    }
    .preview-pane { flex: 1 1 0; min-width: 320px; border: 0; border-left: 1px solid var(--toolbar-border); background: var(--page-bg); }
    .editor-shell[data-preview="false"] .preview-pane { display: none; }
    .editor-shell[data-preview="false"][data-diff="false"] .preview-splitter { display: none; }
    .editor-shell[data-preview="true"] .preview-splitter { display: block; }
    #status { margin-left: 8px; color: var(--status-fg); }
    #previewStatus { color: var(--preview-status-fg); font-size: 12px; }
    .ace_editor { background: var(--ace-bg) !important; color: var(--ace-fg) !important; width: 100% !important; height: 100% !important; }
    .ace_editor, .ace_editor .ace_content, .ace_editor .ace_text-layer { font-family: var(--editor-font-family) !important; font-weight: var(--editor-font-weight) !important; font-synthesis: none; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
    .ace_editor.ace_nobold .ace_line > span, .ace_editor.ace_nobold .ace_bold { font-weight: var(--editor-font-weight) !important; }
    .ace_gutter { background: var(--ace-gutter-bg) !important; color: var(--ace-gutter-fg) !important; }
    .ace_gutter-active-line { background-color: var(--ace-gutter-active-bg) !important; color: var(--ace-fg) !important; }
    .ace_cursor { color: var(--ace-cursor) !important; }
    .ace_marker-layer .ace_active-line { background: var(--ace-active-line) !important; }
    .ace_marker-layer .ace_selection { background: var(--ace-selection) !important; }
    .ace_marker-layer .ace_selected-word { border: 1px solid var(--ace-selected-word-border) !important; }
    .ace_marker-layer .git-diff-added-line { position: absolute; background: var(--syntax-addition-bg); }
    .ace_marker-layer .git-diff-removed-line { position: absolute; background: var(--syntax-deletion-bg); }
    .ace_marker-layer .git-diff-empty-line { position: absolute; background: repeating-linear-gradient(45deg, var(--toolbar-border), var(--toolbar-border) 3px, transparent 3px, transparent 6px); }
    .ace_gutter-cell.git-diff-empty-gutter { color: var(--ace-invisible); opacity: 0.5; }
    .ace_gutter-cell.git-diff-added-gutter { box-shadow: inset 3px 0 0 var(--syntax-addition-fg); }
    .ace_gutter-cell.git-diff-removed-gutter { box-shadow: inset 3px 0 0 var(--syntax-deletion-fg); }
    .ace_marker-layer .ace_bracket { border: 1px solid var(--ace-bracket-border) !important; margin: -1px 0 0 -1px; }
    .ace_invisible { color: var(--ace-invisible) !important; }
    .ace_print-margin { background: var(--toolbar-border) !important; }
    .ace_fold { background: var(--syntax-constant) !important; border-color: var(--ace-bg) !important; }
    .ace_comment,
    .ace_punctuation.ace_definition.ace_comment,
    .ace_string.ace_comment { color: var(--syntax-comment) !important; font-style: normal !important; }
    .ace_keyword,
    .ace_storage,
    .ace_storage.ace_type,
    .ace_meta.ace_tag,
    .ace_meta.ace_selector { color: var(--syntax-keyword) !important; }
    .ace_string,
    .ace_string.ace_quoted,
    .ace_string.ace_interpolated,
    .ace_string.ace_unquoted { color: var(--syntax-string) !important; }
    .ace_string.ace_regexp,
    .ace_regexp { color: var(--syntax-entity-tag) !important; }
    .ace_constant,
    .ace_constant.ace_numeric,
    .ace_constant.ace_language,
    .ace_constant.ace_character,
    .ace_constant.ace_other,
    .ace_support.ace_constant,
    .ace_variable.ace_language { color: var(--syntax-constant) !important; }
    .ace_entity.ace_name.ace_function,
    .ace_support.ace_function,
    .ace_function,
    .ace_function.ace_buildin,
    .ace_variable.ace_function { color: var(--syntax-entity) !important; }
    .ace_entity.ace_name.ace_tag,
    .ace_entity.ace_other.ace_attribute-name,
    .ace_tag { color: var(--syntax-entity-tag) !important; }
    .ace_variable,
    .ace_variable.ace_parameter,
    .ace_variable.ace_instance,
    .ace_support.ace_variable,
    .ace_property { color: var(--syntax-variable) !important; }
    .ace_support.ace_class,
    .ace_support.ace_type,
    .ace_entity.ace_name.ace_class,
    .ace_entity.ace_name.ace_type,
    .ace_entity.ace_other.ace_inherited-class { color: var(--syntax-entity) !important; }
    .ace_markup.ace_heading { color: var(--syntax-markup-heading) !important; }
    .ace_markup.ace_list { color: var(--syntax-markup-list) !important; }
    .ace_markup.ace_inserted { color: var(--syntax-addition-fg) !important; background-color: var(--syntax-addition-bg) !important; }
    .ace_markup.ace_deleted { color: var(--syntax-deletion-fg) !important; background-color: var(--syntax-deletion-bg) !important; }
    .ace_invalid { color: var(--syntax-invalid-fg) !important; background-color: var(--syntax-invalid-bg) !important; }
    .meta { opacity: 0.9; font-size: 12px; overflow-wrap: anywhere; font-family: var(--editor-font-family); }
    @media (max-width: 768px), (pointer: coarse) {
      .toolbar { gap: 10px; padding: 12px; }
      .editor-shell[data-preview="true"] { flex-direction: column; }
      .editor-shell[data-preview="true"] #editor {
        flex: 0 0 calc(var(--preview-editor-ratio) * 100%);
        width: 100%;
      }
      .editor-shell[data-preview="true"] .preview-splitter {
        display: block;
        flex: 0 0 12px;
        width: 100%;
        height: 12px;
        cursor: row-resize;
      }
      .editor-shell[data-preview="true"] .preview-splitter::before, .editor-shell[data-diff="true"] .preview-splitter::before {
        top: 50%;
        bottom: auto;
        left: 0;
        width: 100%;
        height: 1px;
        transform: translateY(-50%);
      }
      .preview-pane { width: 100%; min-width: 0; min-height: 240px; border-left: 0; border-top: 1px solid var(--toolbar-border); }
      .git-diff-editors { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 14px; grid-template-rows: minmax(240px, 1fr) minmax(240px, 1fr); }
      .git-diff-editor-pane + .git-diff-editor-pane { border-top: 1px solid var(--toolbar-border); border-left: 0; }
      .ace_editor, .ace_editor * { font-weight: var(--editor-font-weight) !important; font-synthesis: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="row">
      <a href="${escapeHtml(toBrowseHref(parentPath))}">Back</a>
      <button id="saveBtn" type="button">Save</button>
      ${copyReferenceButton}
      ${gitDiffButton}
      ${previewButton}
      <button id="wrapBtn" type="button" aria-pressed="true">Wrap lines</button>
      ${languageSelect}
      <span id="status"></span>
      <span id="previewStatus"></span>
    </div>
    <div class="meta">${escapeHtml(localPath)} · <span id="languageLabel">${escapeHtml(languageLabel)}</span></div>
  </div>
  <div id="editorShell" class="editor-shell" data-preview="false">
    <div id="editor"></div>
    ${previewPane}
    <section id="gitDiffPanel" class="git-diff-panel" aria-label="Git file diff" hidden>
      <div class="git-diff-card">
        <div class="git-diff-header"><h2 id="gitDiffTitle" class="git-diff-title">Git diff</h2><span class="git-diff-legend"><span class="removed">Removed / changed</span><span class="added">Added / changed</span></span><button id="closeGitDiffBtn" type="button">Close</button></div>
        <div class="git-diff-controls"><label class="git-diff-label" for="gitDiffBase">From</label><select id="gitDiffBase" class="git-diff-select"></select><label class="git-diff-label" for="gitDiffCompare">To</label><select id="gitDiffCompare" class="git-diff-select"></select><button id="copyGitDiffRefBtn" type="button">Copy ref</button></div>
        <div id="gitDiffStatus" class="meta" aria-live="polite"></div>
        <div class="git-diff-editors"><section class="git-diff-editor-pane"><div id="gitDiffBaseTitle" class="git-diff-pane-title">From</div><div id="gitDiffBaseEditor" class="git-diff-editor"></div></section><section class="git-diff-editor-pane"><div id="gitDiffCompareTitle" class="git-diff-pane-title">To</div><div id="gitDiffCompareEditor" class="git-diff-editor"></div></section><div id="gitDiffOverview" class="git-diff-overview"></div></div>
      </div>
    </section>
  </div>
  ${floatingHighlightControls}
  <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.36.2/ace.js"></script>
  <script>
    const saveBtn = document.getElementById('saveBtn');
    const langSelect = document.getElementById('langSelect');
    const languageLabel = document.getElementById('languageLabel');
    const copyRefBtn = document.getElementById('copyRefBtn');
    const wrapBtn = document.getElementById('wrapBtn');
    const gitDiffBtn = document.getElementById('gitDiffBtn');
    const gitDiffPanel = document.getElementById('gitDiffPanel');
    const closeGitDiffBtn = document.getElementById('closeGitDiffBtn');
    const gitDiffBase = document.getElementById('gitDiffBase');
    const gitDiffCompare = document.getElementById('gitDiffCompare');
    const gitDiffStatus = document.getElementById('gitDiffStatus');
    const gitDiffBaseTitle = document.getElementById('gitDiffBaseTitle');
    const gitDiffCompareTitle = document.getElementById('gitDiffCompareTitle');
    const copyGitDiffRefBtn = document.getElementById('copyGitDiffRefBtn');
    const previewBtn = document.getElementById('previewBtn');
    const floatingSelectionActions = document.getElementById('floatingSelectionActions');
    const floatingHighlightBtn = document.getElementById('floatingHighlightBtn');
    const floatingMarkBtn = document.getElementById('floatingMarkBtn');
    const floatingSelectionCommentBtn = document.getElementById('floatingSelectionCommentBtn');
    const floatingHighlightActions = document.getElementById('floatingHighlightActions');
    const floatingRemoveHighlightBtn = document.getElementById('floatingRemoveHighlightBtn');
    const floatingAddHighlightCommentBtn = document.getElementById('floatingAddHighlightCommentBtn');
    const floatingMarkActions = document.getElementById('floatingMarkActions');
    const floatingUnmarkBtn = document.getElementById('floatingUnmarkBtn');
    const floatingAddMarkCommentBtn = document.getElementById('floatingAddMarkCommentBtn');
    const floatingCommentActions = document.getElementById('floatingCommentActions');
    const floatingAddCommentBtn = document.getElementById('floatingAddCommentBtn');
    const floatingEditCommentBtn = document.getElementById('floatingEditCommentBtn');
    const floatingRemoveCommentBtn = document.getElementById('floatingRemoveCommentBtn');
    const floatingCommentEditor = document.getElementById('floatingCommentEditor');
    const floatingCommentEditorTitle = document.getElementById('floatingCommentEditorTitle');
    const floatingCommentInput = document.getElementById('floatingCommentInput');
    const floatingSaveCommentBtn = document.getElementById('floatingSaveCommentBtn');
    const floatingCancelCommentBtn = document.getElementById('floatingCancelCommentBtn');
    const status = document.getElementById('status');
    const previewStatus = document.getElementById('previewStatus');
    const editorShell = document.getElementById('editorShell');
    const previewSplitter = document.getElementById('previewSplitter');
    const previewFrame = document.getElementById('previewFrame');
    const supportsMarkdownPreview = ${supportsMarkdownPreview ? 'true' : 'false'};
    const editorReferencePath = ${escapedEditorPath};
    const gitDiffPath = '/codex-local-git-diff' + encodeURI(editorReferencePath);
    let lineWrapEnabled = true;
    let diffVisible = false;
    let gitDiffBaseEditor = null;
    let gitDiffCompareEditor = null;
    let gitDiffBaseMarkers = [];
    let gitDiffCompareMarkers = [];
    let gitDiffAlignedRows = [];
    let gitDiffBaseRawContent = '';
    let gitDiffCompareRawContent = '';
    let gitDiffBaseVersionId = '';
    let gitDiffCompareVersionId = '';
    let gitDiffVersions = [];
    const editor = ace.edit('editor');
    const editorFontFamily = '"CodexLocalEditorLatin", "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Roboto Mono", "Droid Sans Mono", "Courier New", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    editor.container.classList.add('ace_nobold');
    const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const applyEditorTheme = () => {
      const theme = colorSchemeQuery.matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      editor.setTheme(theme === 'dark' ? 'ace/theme/github_dark' : 'ace/theme/github');
      editor.container.classList.add('ace_nobold');
    };
    applyEditorTheme();
    if (typeof colorSchemeQuery.addEventListener === 'function') {
      colorSchemeQuery.addEventListener('change', applyEditorTheme);
    }
    editor.session.setMode('ace/mode/${escapeHtml(language)}');
    editor.setValue(${safeContentLiteral}, -1);
    editor.setOptions({
      fontSize: '13px',
      fontFamily: editorFontFamily,
      wrap: true,
      showPrintMargin: false,
      useSoftTabs: true,
      tabSize: 2,
      behavioursEnabled: true,
    });
    editor.session.setUseWrapMode(lineWrapEnabled);
    editor.resize();

    if (langSelect) {
      langSelect.addEventListener('change', () => {
        editor.session.setMode('ace/mode/' + langSelect.value);
        if (languageLabel) {
          languageLabel.textContent = langSelect.options[langSelect.selectedIndex].text;
        }
      });
    }

    const parseRequestedLineRange = () => {
      const raw = new URLSearchParams(location.search).get('line') || '';
      const match = raw.trim().match(/^(\\d+)(?:-(\\d+))?$/);
      if (!match) return null;
      const startLine = Number.parseInt(match[1], 10);
      const endLine = Number.parseInt(match[2] || match[1], 10);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < 1) return null;
      return {
        startLine: Math.min(startLine, endLine),
        endLine: Math.max(startLine, endLine),
      };
    };

    const jumpEditorToLineRange = (rawStartLine, rawEndLine = rawStartLine, preserveSelection = false, onScrollComplete = () => {}) => {
      const lineCount = editor.session.getLength();
      const startLine = Math.min(Math.max(Number.parseInt(String(rawStartLine), 10) || 1, 1), lineCount);
      const endLine = Math.min(Math.max(Number.parseInt(String(rawEndLine), 10) || startLine, startLine), lineCount);
      editor.gotoLine(startLine, 0, true);
      editor.scrollToLine(startLine, true, true, () => {
        onScrollComplete();
      });
      if (preserveSelection && endLine > startLine) {
        try {
          const Range = ace.require('ace/range').Range;
          const endColumn = editor.session.getLine(endLine - 1).length;
          editor.selection.setRange(new Range(startLine - 1, 0, endLine - 1, endColumn), false);
        } catch {
          editor.moveCursorTo(startLine - 1, 0);
        }
      } else {
        editor.moveCursorTo(startLine - 1, 0);
        editor.clearSelection();
      }
      editor.focus();
    };

    const jumpToRequestedLineRange = () => {
      const requestedRange = parseRequestedLineRange();
      if (!requestedRange) return;
      jumpEditorToLineRange(requestedRange.startLine, requestedRange.endLine, true);
    };

    window.requestAnimationFrame(jumpToRequestedLineRange);

    let statusTimer = 0;
    let previewVisible = false;
    let previewTimer = 0;
    let previewRevision = 0;
    let previewController = null;
    let previewStatusTimer = 0;
    let previewDragCleanup = null;
    let previewLoadToken = 0;
    let previewScrollSyncCleanup = null;
    let editorScrollSyncFrame = 0;
    let previewScrollSyncFrame = 0;
    let isApplyingEditorScrollFromPreview = false;
    let isApplyingPreviewScrollFromEditor = false;
    let pendingPreviewEditorSync = false;
    let lastPreviewScrollState = null;
    let lastPreviewHighlightSelection = null;
    let lastPreviewClickedHighlight = null;
    let lastPreviewClickedMark = null;
    let lastPreviewClickedComment = null;
    let lastEditorHighlightSelection = null;
    let pendingFloatingCommentSubmit = null;
    let lastFloatingCommentEditorRect = null;
    let lastEditorSyncedLine = 0;
    let lastPreviewSyncedLine = 0;
    let editorSelectionFrame = 0;
    let editorPointerSelectionActive = false;
    let suppressFloatingActionsUntil = 0;
    const previewScrollAnchorSelector = '.message-scroll-anchor[data-source-line]';
    let previewScrollSyncSuppressedUntil = 0;
    const previewSplitStorageKeyHorizontal = 'codex.localBrowse.previewEditorRatio.horizontal.v1';
    const previewSplitStorageKeyVertical = 'codex.localBrowse.previewEditorRatio.vertical.v1';
    const previewVisibleStorageKey = 'codex.localBrowse.previewVisible.v1:' + editorReferencePath;
    const gitDiffVisibleStorageKey = 'codex.localBrowse.gitDiffVisible.v1:' + editorReferencePath;
    const gitDiffBaseStorageKey = 'codex.localBrowse.gitDiffBase.v1:' + editorReferencePath;
    const gitDiffCompareStorageKey = 'codex.localBrowse.gitDiffCompare.v1:' + editorReferencePath;
    const defaultPreviewEditorRatio = 0.48;
    const previewEditorMinWidth = 320;
    const previewPaneMinWidth = 420;
    const previewEditorMinHeight = 240;
    const previewPaneMinHeight = 240;
    const previewSplitterWidth = 12;

    const createEditorReferenceText = (localPath, startLine, endLine = startLine) => {
      const normalizedPath = String(localPath || '').trim();
      const normalizedStart = Number.isFinite(startLine) ? Math.floor(startLine) : 0;
      const normalizedEnd = Number.isFinite(endLine) ? Math.floor(endLine) : 0;
      const firstLine = Math.min(normalizedStart, normalizedEnd);
      const lastLine = Math.max(normalizedStart, normalizedEnd);
      if (!normalizedPath || firstLine < 1 || lastLine < 1) return '';
      return firstLine === lastLine
        ? normalizedPath + ':' + String(firstLine)
        : normalizedPath + ':' + String(firstLine) + '-' + String(lastLine);
    };

    const isStackedPreviewLayout = () => {
      if (!editorShell) return false;
      return window.getComputedStyle(editorShell).flexDirection === 'column';
    };

    const isSplitPaneVisible = () => previewVisible || diffVisible;

    const getPreviewSplitStorageKey = () => {
      return isStackedPreviewLayout()
        ? previewSplitStorageKeyVertical
        : previewSplitStorageKeyHorizontal;
    };

    const updatePreviewSplitterOrientation = () => {
      if (!previewSplitter) return;
      previewSplitter.setAttribute('aria-orientation', isStackedPreviewLayout() ? 'horizontal' : 'vertical');
    };

    const loadPreviewEditorRatio = () => {
      try {
        const raw = window.localStorage.getItem(getPreviewSplitStorageKey());
        const parsed = Number.parseFloat(raw ?? '');
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
          return parsed;
        }
      } catch {
        // Ignore storage failures and use the default split.
      }
      return defaultPreviewEditorRatio;
    };

    const savePreviewEditorRatio = (ratio) => {
      try {
        window.localStorage.setItem(getPreviewSplitStorageKey(), String(ratio));
      } catch {
        // Ignore storage failures.
      }
    };

    const loadPreviewVisible = () => {
      try {
        return window.localStorage.getItem(previewVisibleStorageKey) === 'true';
      } catch {
        return false;
      }
    };

    const savePreviewVisible = (visible) => {
      try {
        window.localStorage.setItem(previewVisibleStorageKey, visible ? 'true' : 'false');
      } catch {
        // Ignore storage failures.
      }
    };

    const getPreviewSplitMetrics = () => {
      const shellRect = editorShell
        ? editorShell.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      const splitterRect = previewSplitter
        ? previewSplitter.getBoundingClientRect()
        : { width: previewSplitterWidth, height: previewSplitterWidth };
      const stacked = isStackedPreviewLayout();
      const splitterSize = stacked
        ? (splitterRect.height || previewSplitterWidth)
        : (splitterRect.width || previewSplitterWidth);
      const shellLength = stacked ? shellRect.height : shellRect.width;
      return {
        stacked,
        shellRect,
        usableLength: Math.max(shellLength - splitterSize, 1),
        shellLength,
        editorMin: stacked ? previewEditorMinHeight : previewEditorMinWidth,
        previewMin: stacked ? previewPaneMinHeight : previewPaneMinWidth,
      };
    };

    const getPreviewEditorRatioBounds = () => {
      const metrics = getPreviewSplitMetrics();
      if (!metrics.shellLength) {
        return { min: 0.28, max: 0.72 };
      }
      const min = Math.min(0.75, Math.max(0.25, metrics.editorMin / metrics.usableLength));
      const max = Math.max(min, Math.min(0.82, 1 - (metrics.previewMin / metrics.usableLength)));
      return { min, max };
    };

    const clampPreviewEditorRatio = (ratio) => {
      const value = Number.isFinite(ratio) ? ratio : defaultPreviewEditorRatio;
      const { min, max } = getPreviewEditorRatioBounds();
      return Math.min(max, Math.max(min, value));
    };

    const applyPreviewEditorRatio = (ratio, persist = false) => {
      if (!editorShell) return defaultPreviewEditorRatio;
      updatePreviewSplitterOrientation();
      const nextRatio = clampPreviewEditorRatio(ratio);
      editorShell.style.setProperty('--preview-editor-ratio', String(nextRatio));
      if (persist) {
        savePreviewEditorRatio(nextRatio);
      }
      window.requestAnimationFrame(() => editor.resize());
      return nextRatio;
    };

    const syncPreviewEditorRatio = (persist = false) => {
      applyPreviewEditorRatio(loadPreviewEditorRatio(), persist);
    };

    const stopPreviewDrag = () => {
      if (previewDragCleanup) {
        previewDragCleanup();
        previewDragCleanup = null;
      }
      if (previewSplitter) {
        previewSplitter.classList.remove('is-dragging');
      }
    };

    const startPreviewDrag = (startEvent) => {
      const primaryPointer = startEvent.button === 0 || startEvent.pointerType === 'touch' || startEvent.pointerType === 'pen';
      if (!isSplitPaneVisible() || !editorShell || !previewSplitter || !primaryPointer) return;
      startEvent.preventDefault();
      startEvent.stopPropagation();
      previewSplitter.classList.add('is-dragging');

      try {
        previewSplitter.setPointerCapture(startEvent.pointerId);
      } catch {
        // Pointer capture is best effort across browsers.
      }

      const updateFromClientPosition = (clientX, clientY) => {
        const metrics = getPreviewSplitMetrics();
        const rawRatio = metrics.stacked
          ? (clientY - metrics.shellRect.top) / metrics.usableLength
          : (clientX - metrics.shellRect.left) / metrics.usableLength;
        const nextRatio = clampPreviewEditorRatio(rawRatio);
        applyPreviewEditorRatio(nextRatio, true);
      };

      const onPointerMove = (moveEvent) => {
        if (moveEvent.pointerId !== startEvent.pointerId) return;
        updateFromClientPosition(moveEvent.clientX, moveEvent.clientY);
      };

      const onPointerUp = (endEvent) => {
        if (endEvent.pointerId !== startEvent.pointerId) return;
        stopPreviewDrag();
      };

      previewDragCleanup = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      updateFromClientPosition(startEvent.clientX, startEvent.clientY);
    };

    const setStatus = (message, timeoutMs = 0) => {
      if (!status) return;
      status.textContent = message;
      if (statusTimer) {
        window.clearTimeout(statusTimer);
        statusTimer = 0;
      }
      if (timeoutMs > 0) {
        statusTimer = window.setTimeout(() => {
          status.textContent = '';
          statusTimer = 0;
        }, timeoutMs);
      }
    };

    const normalizeReferenceLineRange = () => {
      const selectionRange = editor.getSelectionRange();
      if (!selectionRange || selectionRange.isEmpty()) {
        const cursorRow = editor.getCursorPosition().row
        return { startLine: cursorRow + 1, endLine: cursorRow + 1 }
      }
      const startRow = Math.min(selectionRange.start.row, selectionRange.end.row)
      let endRow = Math.max(selectionRange.start.row, selectionRange.end.row)
      if (selectionRange.end.row > selectionRange.start.row && selectionRange.end.column === 0) {
        endRow -= 1
      }
      if (endRow < startRow) endRow = startRow
      return { startLine: startRow + 1, endLine: endRow + 1 }
    };

    const buildReferenceText = () => {
      const range = normalizeReferenceLineRange()
      return createEditorReferenceText(editorReferencePath, range.startLine, range.endLine)
    };

    const setLineWrapEnabled = (enabled, persist = true) => {
      lineWrapEnabled = Boolean(enabled);
      editor.session.setUseWrapMode(lineWrapEnabled);
      if (gitDiffBaseEditor && gitDiffCompareEditor) {
        gitDiffBaseEditor.session.setUseWrapMode(lineWrapEnabled);
        gitDiffCompareEditor.session.setUseWrapMode(lineWrapEnabled);
      }
      if (wrapBtn) {
        wrapBtn.setAttribute('aria-pressed', lineWrapEnabled ? 'true' : 'false');
        wrapBtn.textContent = lineWrapEnabled ? 'Wrap lines' : 'No wrap';
      }
      if (persist) {
        try { window.localStorage.setItem('codex.localBrowse.lineWrap.v1:' + editorReferencePath, lineWrapEnabled ? 'true' : 'false'); } catch {}
      }
      window.requestAnimationFrame(() => {
        editor.resize();
        if (gitDiffBaseEditor && gitDiffCompareEditor) {
          gitDiffBaseEditor.resize();
          gitDiffCompareEditor.resize();
        }
      });
    };

    try {
      setLineWrapEnabled(window.localStorage.getItem('codex.localBrowse.lineWrap.v1:' + editorReferencePath) !== 'false', false);
    } catch {
      setLineWrapEnabled(true, false);
    }

    if (wrapBtn) {
      wrapBtn.addEventListener('click', () => setLineWrapEnabled(!lineWrapEnabled));
    }

    const writeTextToClipboard = async (text) => {
      if (!text) return false;
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const fallback = document.createElement('textarea');
      fallback.value = text;
      fallback.setAttribute('readonly', 'readonly');
      fallback.style.position = 'fixed';
      fallback.style.top = '-9999px';
      fallback.style.left = '-9999px';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.focus();
      fallback.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(fallback);
      if (!copied) throw new Error('Clipboard copy failed');
      return true;
    };

    const setPreviewStatus = (message) => {
      if (!previewStatus) return;
      previewStatus.textContent = message;
      if (previewStatusTimer) {
        window.clearTimeout(previewStatusTimer);
        previewStatusTimer = 0;
      }
      if (message === 'Preview updated') {
        previewStatusTimer = window.setTimeout(() => {
          previewStatus.textContent = '';
          previewStatusTimer = 0;
        }, 1200);
      }
    };

    const hideFloatingCommentEditor = () => {
      pendingFloatingCommentSubmit = null;
      if (floatingCommentEditor) floatingCommentEditor.hidden = true;
      if (floatingCommentInput) floatingCommentInput.value = '';
    };

    const hideFloatingActionGroups = () => {
      if (floatingSelectionActions) floatingSelectionActions.hidden = true;
      if (floatingHighlightBtn) floatingHighlightBtn.hidden = true;
      if (floatingMarkBtn) floatingMarkBtn.hidden = true;
      if (floatingSelectionCommentBtn) floatingSelectionCommentBtn.hidden = true;
      if (floatingHighlightActions) floatingHighlightActions.hidden = true;
      if (floatingRemoveHighlightBtn) floatingRemoveHighlightBtn.hidden = true;
      if (floatingAddHighlightCommentBtn) floatingAddHighlightCommentBtn.hidden = true;
      if (floatingMarkActions) floatingMarkActions.hidden = true;
      if (floatingAddMarkCommentBtn) floatingAddMarkCommentBtn.hidden = true;
      if (floatingCommentActions) floatingCommentActions.hidden = true;
    };

    const hideFloatingHighlightActions = () => {
      hideFloatingActionGroups();
      hideFloatingCommentEditor();
    };

    const dismissFloatingHighlightActions = () => {
      lastPreviewHighlightSelection = null;
      lastPreviewClickedHighlight = null;
      lastPreviewClickedMark = null;
      lastPreviewClickedComment = null;
      lastEditorHighlightSelection = null;
      hideFloatingHighlightActions();
    };

    const suppressFloatingHighlightActions = (durationMs = 220) => {
      suppressFloatingActionsUntil = window.performance.now() + durationMs;
      hideFloatingHighlightActions();
    };

    const shouldSuppressFloatingHighlightActions = () => (
      window.performance.now() < suppressFloatingActionsUntil
    );

    const rectFromPreviewMessage = (rawRect) => {
      if (!previewFrame || !rawRect || typeof rawRect !== 'object') return null;
      const left = Number(rawRect.left);
      const top = Number(rawRect.top);
      const right = Number(rawRect.right);
      const bottom = Number(rawRect.bottom);
      if (![left, top, right, bottom].every(Number.isFinite)) return null;
      const frameRect = previewFrame.getBoundingClientRect();
      return {
        left: frameRect.left + left,
        top: frameRect.top + top,
        right: frameRect.left + right,
        bottom: frameRect.top + bottom,
        clipLeft: frameRect.left,
        clipTop: frameRect.top,
        clipRight: frameRect.right,
        clipBottom: frameRect.bottom,
      };
    };

    const positionFloatingHighlightAction = (button, rect, offsetX = 0) => {
      if (!button || !rect || shouldSuppressFloatingHighlightActions()) return;
      const left = Number(rect.left);
      const right = Number(rect.right);
      const top = Number(rect.top);
      const bottom = Number(rect.bottom);
      if (![left, right, top, bottom].every(Number.isFinite)) return;
      const clipLeft = Number(rect.clipLeft);
      const clipRight = Number(rect.clipRight);
      const clipTop = Number(rect.clipTop);
      const clipBottom = Number(rect.clipBottom);
      if ([clipLeft, clipRight, clipTop, clipBottom].every(Number.isFinite)) {
        if (right < clipLeft || left > clipRight || bottom < clipTop || top > clipBottom) {
          button.hidden = true;
          return;
        }
      }
      const visibleLeft = Number.isFinite(clipLeft) ? Math.max(left, clipLeft) : left;
      const visibleRight = Number.isFinite(clipRight) ? Math.min(right, clipRight) : right;
      const visibleTop = Number.isFinite(clipTop) ? Math.max(top, clipTop) : top;
      const visibleBottom = Number.isFinite(clipBottom) ? Math.min(bottom, clipBottom) : bottom;
      const centerX = (visibleLeft + visibleRight) / 2;
      const padding = 12;
      const x = Math.min(Math.max(centerX + offsetX, padding), Math.max(padding, window.innerWidth - padding));
      const placeBelow = visibleTop < 48;
      const y = placeBelow ? Math.min(Math.max(visibleBottom, padding), Math.max(padding, window.innerHeight - padding)) : Math.min(Math.max(visibleTop, padding), Math.max(padding, window.innerHeight - padding));
      button.dataset.placement = placeBelow ? 'below' : 'above';
      button.style.left = x + 'px';
      button.style.top = y + 'px';
      button.hidden = false;
    };

    const rectFromElement = (element) => {
      if (!element || typeof element.getBoundingClientRect !== 'function') return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    };

    const showFloatingCommentEditor = ({ title, initialValue = '', rect, onSubmit }) => {
      if (!supportsMarkdownPreview || !floatingCommentEditor || !floatingCommentInput || typeof onSubmit !== 'function') return false;
      pendingFloatingCommentSubmit = onSubmit;
      if (floatingCommentEditorTitle) floatingCommentEditorTitle.textContent = title || 'Comment';
      if (floatingSaveCommentBtn) floatingSaveCommentBtn.textContent = title === 'Edit comment' ? 'Save' : 'Add';
      floatingCommentInput.value = String(initialValue || '');
      floatingCommentInput.setAttribute('aria-label', title || 'Comment');
      hideFloatingActionGroups();
      const targetRect = rect || lastFloatingCommentEditorRect;
      if (targetRect) {
        positionFloatingHighlightAction(floatingCommentEditor, targetRect);
      } else {
        floatingCommentEditor.dataset.placement = 'below';
        floatingCommentEditor.style.left = '50%';
        floatingCommentEditor.style.top = '72px';
        floatingCommentEditor.hidden = false;
      }
      if (floatingCommentEditor.hidden) return false;
      window.requestAnimationFrame(() => {
        floatingCommentInput.focus();
        floatingCommentInput.select();
      });
      return true;
    };

    const submitFloatingCommentEditor = () => {
      if (!floatingCommentInput || typeof pendingFloatingCommentSubmit !== 'function') return;
      const normalized = String(floatingCommentInput.value || '').trim();
      if (!normalized) {
        setPreviewStatus('Comment cannot be empty');
        floatingCommentInput.focus();
        return;
      }
      const submitComment = pendingFloatingCommentSubmit;
      hideFloatingCommentEditor();
      submitComment(normalized);
    };

    const showFloatingHighlightButton = (rect) => {
      if (!supportsMarkdownPreview) return;
      lastFloatingCommentEditorRect = rect || lastFloatingCommentEditorRect;
      hideFloatingCommentEditor();
      if (floatingSelectionActions) {
        if (floatingHighlightBtn) floatingHighlightBtn.hidden = false;
        if (floatingMarkBtn) floatingMarkBtn.hidden = false;
        if (floatingSelectionCommentBtn) floatingSelectionCommentBtn.hidden = false;
        if (floatingHighlightActions) floatingHighlightActions.hidden = true;
        if (floatingMarkActions) floatingMarkActions.hidden = true;
        if (floatingCommentActions) floatingCommentActions.hidden = true;
        if (floatingRemoveHighlightBtn) floatingRemoveHighlightBtn.hidden = true;
        if (floatingAddHighlightCommentBtn) floatingAddHighlightCommentBtn.hidden = true;
        if (floatingAddMarkCommentBtn) floatingAddMarkCommentBtn.hidden = true;
        positionFloatingHighlightAction(floatingSelectionActions, rect);
        return;
      }
      if (!floatingHighlightBtn) return;
      if (floatingHighlightActions) floatingHighlightActions.hidden = true;
      if (floatingRemoveHighlightBtn) floatingRemoveHighlightBtn.hidden = true;
      if (floatingMarkActions) floatingMarkActions.hidden = true;
      positionFloatingHighlightAction(floatingHighlightBtn, rect, floatingMarkBtn ? -42 : 0);
      if (floatingMarkBtn) positionFloatingHighlightAction(floatingMarkBtn, rect, 42);
    };

    const showFloatingRemoveHighlightButton = (rect) => {
      if (!supportsMarkdownPreview) return;
      lastFloatingCommentEditorRect = rect || lastFloatingCommentEditorRect;
      hideFloatingCommentEditor();
      if (floatingSelectionActions) floatingSelectionActions.hidden = true;
      if (floatingHighlightBtn) floatingHighlightBtn.hidden = true;
      if (floatingMarkBtn) floatingMarkBtn.hidden = true;
      if (floatingMarkActions) floatingMarkActions.hidden = true;
      if (floatingCommentActions) floatingCommentActions.hidden = true;
      if (floatingHighlightActions) {
        if (floatingRemoveHighlightBtn) floatingRemoveHighlightBtn.hidden = false;
        if (floatingAddHighlightCommentBtn) floatingAddHighlightCommentBtn.hidden = false;
        positionFloatingHighlightAction(floatingHighlightActions, rect);
        return;
      }
      if (!floatingRemoveHighlightBtn) return;
      positionFloatingHighlightAction(floatingRemoveHighlightBtn, rect);
    };

    const showFloatingMarkActions = (rect) => {
      if (!supportsMarkdownPreview || !floatingMarkActions) return;
      lastFloatingCommentEditorRect = rect || lastFloatingCommentEditorRect;
      hideFloatingCommentEditor();
      if (floatingSelectionActions) floatingSelectionActions.hidden = true;
      if (floatingHighlightBtn) floatingHighlightBtn.hidden = true;
      if (floatingMarkBtn) floatingMarkBtn.hidden = true;
      if (floatingHighlightActions) floatingHighlightActions.hidden = true;
      if (floatingCommentActions) floatingCommentActions.hidden = true;
      if (floatingRemoveHighlightBtn) floatingRemoveHighlightBtn.hidden = true;
      if (floatingAddHighlightCommentBtn) floatingAddHighlightCommentBtn.hidden = true;
      if (floatingAddMarkCommentBtn) floatingAddMarkCommentBtn.hidden = false;
      positionFloatingHighlightAction(floatingMarkActions, rect);
    };

    const showFloatingCommentActions = (rect) => {
      if (!supportsMarkdownPreview || !floatingCommentActions) return;
      lastFloatingCommentEditorRect = rect || lastFloatingCommentEditorRect;
      hideFloatingCommentEditor();
      if (floatingSelectionActions) floatingSelectionActions.hidden = true;
      if (floatingHighlightBtn) floatingHighlightBtn.hidden = true;
      if (floatingMarkBtn) floatingMarkBtn.hidden = true;
      if (floatingHighlightActions) floatingHighlightActions.hidden = true;
      if (floatingMarkActions) floatingMarkActions.hidden = true;
      if (floatingRemoveHighlightBtn) floatingRemoveHighlightBtn.hidden = true;
      if (floatingAddHighlightCommentBtn) floatingAddHighlightCommentBtn.hidden = true;
      if (floatingAddMarkCommentBtn) floatingAddMarkCommentBtn.hidden = true;
      positionFloatingHighlightAction(floatingCommentActions, rect);
    };

    const editorSelectionRect = (selectionRange) => {
      if (!selectionRange || selectionRange.isEmpty()) return null;
      try {
        const end = selectionRange.end;
        const coords = editor.renderer.textToScreenCoordinates(end.row, end.column);
        const x = Number(coords.pageX) - window.scrollX;
        const y = Number(coords.pageY) - window.scrollY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          left: x,
          right: x,
          top: y,
          bottom: y + editor.renderer.lineHeight,
        };
      } catch {
        return null;
      }
    };

    const captureEditorHighlightSelection = () => {
      if (!supportsMarkdownPreview || shouldSuppressFloatingHighlightActions() || editorPointerSelectionActive) return;
      const selectionRange = editor.getSelectionRange();
      if (!selectionRange || selectionRange.isEmpty()) {
        lastEditorHighlightSelection = null;
        lastPreviewClickedHighlight = null;
        lastPreviewClickedMark = null;
        lastPreviewClickedComment = null;
        hideFloatingHighlightActions();
        return;
      }
      const editorValue = editor.getValue();
      const startIndex = editorPositionToIndex(editorValue, selectionRange.start);
      const endIndex = editorPositionToIndex(editorValue, selectionRange.end);
      lastPreviewHighlightSelection = null;
      lastPreviewClickedHighlight = null;
      lastPreviewClickedMark = null;
      lastPreviewClickedComment = null;
      lastEditorHighlightSelection = {
        startIndex: Math.min(startIndex, endIndex),
        endIndex: Math.max(startIndex, endIndex),
      };
      showFloatingHighlightButton(editorSelectionRect(selectionRange));
    };

    const scheduleEditorHighlightSelectionCapture = () => {
      if (!supportsMarkdownPreview || editorSelectionFrame) return;
      editorSelectionFrame = window.requestAnimationFrame(() => {
        editorSelectionFrame = 0;
        captureEditorHighlightSelection();
      });
    };

    const normalizeHighlightSelectionText = (value) => (
      String(value || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\r\\n?/g, '\\n')
        .trim()
    );

    const getLineStartOffsets = (value) => {
      const offsets = [0];
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '\\n') offsets.push(index + 1);
      }
      return offsets;
    };

    const indexToEditorPosition = (value, rawIndex) => {
      const index = Math.min(Math.max(0, rawIndex), value.length);
      const prefix = value.slice(0, index);
      const lines = prefix.split('\\n');
      return {
        row: lines.length - 1,
        column: lines[lines.length - 1].length,
      };
    };

    const editorPositionToIndex = (value, position) => {
      const offsets = getLineStartOffsets(value);
      const row = Math.min(Math.max(0, Number(position?.row) || 0), Math.max(0, offsets.length - 1));
      const lineStart = offsets[row] ?? 0;
      const lineEnd = row + 1 < offsets.length ? offsets[row + 1] - 1 : value.length;
      const column = Math.min(Math.max(0, Number(position?.column) || 0), Math.max(0, lineEnd - lineStart));
      return lineStart + column;
    };

    const normalizeTextWithIndexMap = (value) => {
      let text = '';
      const indexMap = [];
      let previousWasWhitespace = false;

      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] === '\\u00a0' ? ' ' : value[index];
        if (/\\s/u.test(character)) {
          if (!previousWasWhitespace) {
            text += ' ';
            indexMap.push(index);
            previousWasWhitespace = true;
          }
          continue;
        }
        text += character;
        indexMap.push(index);
        previousWasWhitespace = false;
      }

      let trimStart = 0;
      let trimEnd = text.length;
      while (trimStart < trimEnd && text[trimStart] === ' ') trimStart += 1;
      while (trimEnd > trimStart && text[trimEnd - 1] === ' ') trimEnd -= 1;

      return {
        text: text.slice(trimStart, trimEnd),
        indexMap: indexMap.slice(trimStart, trimEnd),
      };
    };

    const findRenderedInlineCodeSelectionInSource = ${findRenderedInlineCodeSelectionInSource.toString()};

    const findSelectionInSourceSlice = (sourceSlice, selectedText, options = {}) => {
      if (!sourceSlice || !selectedText) return null;

      if (options.containsInlineCode === true) {
        const inlineCodeMatch = findRenderedInlineCodeSelectionInSource(sourceSlice, selectedText, {
          requireInlineCodeEnd: options.endsInInlineCode === true,
        });
        if (inlineCodeMatch) return inlineCodeMatch;
      }

      const exactIndex = sourceSlice.indexOf(selectedText);
      if (exactIndex >= 0) {
        return {
          startOffset: exactIndex,
          endOffset: exactIndex + selectedText.length,
        };
      }

      const normalizedSource = normalizeTextWithIndexMap(sourceSlice);
      const normalizedSelection = normalizeTextWithIndexMap(selectedText);
      if (!normalizedSource.text || !normalizedSelection.text) return null;

      const normalizedIndex = normalizedSource.text.indexOf(normalizedSelection.text);
      if (normalizedIndex < 0) return null;

      const mappedStart = normalizedSource.indexMap[normalizedIndex];
      const mappedEnd = normalizedSource.indexMap[normalizedIndex + normalizedSelection.text.length - 1];
      if (!Number.isFinite(mappedStart) || !Number.isFinite(mappedEnd)) return null;

      return {
        startOffset: mappedStart,
        endOffset: mappedEnd + 1,
      };
    };

    const sourceWindowForLines = (editorValue, rawStartLine, rawEndLine = rawStartLine) => {
      const offsets = getLineStartOffsets(editorValue);
      if (offsets.length === 0) return null;
      const lineCount = offsets.length;
      const startLine = Math.min(Math.max(1, Number.parseInt(String(rawStartLine), 10) || 1), lineCount);
      const endLine = Math.min(Math.max(startLine, Number.parseInt(String(rawEndLine), 10) || startLine), lineCount);
      const startIndex = offsets[startLine - 1] ?? 0;
      const endIndex = endLine < offsets.length ? Math.max(startIndex, offsets[endLine] - 1) : editorValue.length;
      return {
        startIndex,
        endIndex,
        value: editorValue.slice(startIndex, endIndex),
      };
    };

    const findHighlightSelectionInEditor = (selectedText, sourceLine, sourceEndLine, options = {}) => {
      const editorValue = editor.getValue();
      const lineWindow = sourceWindowForLines(editorValue, sourceLine, sourceEndLine);
      if (lineWindow) {
        const lineMatch = findSelectionInSourceSlice(lineWindow.value, selectedText, options);
        if (lineMatch) {
          return {
            startIndex: lineWindow.startIndex + lineMatch.startOffset,
            endIndex: lineWindow.startIndex + lineMatch.endOffset,
          };
        }
      }

      const fullMatch = findSelectionInSourceSlice(editorValue, selectedText, options);
      if (!fullMatch) return null;
      return {
        startIndex: fullMatch.startOffset,
        endIndex: fullMatch.endOffset,
      };
    };

    const findHighlightMarkupInSourceSlice = (sourceSlice, selectedText, occurrence = 0, sourceText = '') => {
      if (!sourceSlice || !selectedText) return null;
      const normalizedSelection = normalizeTextWithIndexMap(sourceText || selectedText).text;
      if (!normalizedSelection) return null;

      let searchFrom = 0;
      let matchedOccurrence = 0;
      while (searchFrom < sourceSlice.length) {
        const openIndex = sourceSlice.indexOf('==', searchFrom);
        if (openIndex < 0) return null;
        const closeIndex = sourceSlice.indexOf('==', openIndex + 2);
        if (closeIndex < 0) return null;
        const innerSource = sourceSlice.slice(openIndex + 2, closeIndex);
        if (normalizeTextWithIndexMap(innerSource).text === normalizedSelection) {
          if (matchedOccurrence < occurrence) {
            matchedOccurrence += 1;
            searchFrom = closeIndex + 2;
            continue;
          }
          const highlightEndOffset = closeIndex + 2;
          const commentCommand = parseAdjacentCommentCommand(sourceSlice, highlightEndOffset);
          return {
            startOffset: openIndex,
            endOffset: highlightEndOffset,
            highlightEndOffset,
            innerSource,
            comment: commentCommand ? commentCommand.value : '',
            commentStartOffset: commentCommand ? commentCommand.startOffset : null,
            commentEndOffset: commentCommand ? commentCommand.endOffset : null,
            commentBodyStartOffset: commentCommand ? commentCommand.bodyStartOffset : null,
            commentBodyEndOffset: commentCommand ? commentCommand.bodyEndOffset : null,
            commentGapStartOffset: commentCommand ? commentCommand.gapStartOffset : null,
          };
        }
        searchFrom = openIndex + 2;
      }

      return null;
    };

    const findHighlightMarkupInEditor = (selectedText, sourceLine, sourceEndLine, occurrence = 0, sourceText = '') => {
      const editorValue = editor.getValue();
      const lineWindow = sourceWindowForLines(editorValue, sourceLine, sourceEndLine);
      if (lineWindow) {
        const lineMatch = findHighlightMarkupInSourceSlice(lineWindow.value, selectedText, occurrence, sourceText);
        if (lineMatch) {
          return {
            startIndex: lineWindow.startIndex + lineMatch.startOffset,
            endIndex: lineWindow.startIndex + lineMatch.endOffset,
            highlightEndIndex: lineWindow.startIndex + lineMatch.highlightEndOffset,
            innerSource: lineMatch.innerSource,
            comment: lineMatch.comment,
            commentStartIndex: lineMatch.commentStartOffset === null ? null : lineWindow.startIndex + lineMatch.commentStartOffset,
            commentEndIndex: lineMatch.commentEndOffset === null ? null : lineWindow.startIndex + lineMatch.commentEndOffset,
            commentBodyStartIndex: lineMatch.commentBodyStartOffset === null ? null : lineWindow.startIndex + lineMatch.commentBodyStartOffset,
            commentBodyEndIndex: lineMatch.commentBodyEndOffset === null ? null : lineWindow.startIndex + lineMatch.commentBodyEndOffset,
            commentGapStartIndex: lineMatch.commentGapStartOffset === null ? null : lineWindow.startIndex + lineMatch.commentGapStartOffset,
          };
        }
      }

      const fullMatch = findHighlightMarkupInSourceSlice(editorValue, selectedText, occurrence, sourceText);
      if (!fullMatch) return null;
      return {
        startIndex: fullMatch.startOffset,
        endIndex: fullMatch.endOffset,
        highlightEndIndex: fullMatch.highlightEndOffset,
        innerSource: fullMatch.innerSource,
        comment: fullMatch.comment,
        commentStartIndex: fullMatch.commentStartOffset,
        commentEndIndex: fullMatch.commentEndOffset,
        commentBodyStartIndex: fullMatch.commentBodyStartOffset,
        commentBodyEndIndex: fullMatch.commentBodyEndOffset,
        commentGapStartIndex: fullMatch.commentGapStartOffset,
      };
    };

    const annotationSlash = String.fromCharCode(92);

    const encodeAnnotationSource = ${encodeAnnotationSourceForLocalBrowse.toString()};

    const decodeAnnotationSource = (value) => {
      let decoded = '';
      const raw = String(value || '');
      for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] === annotationSlash && index + 1 < raw.length && (raw[index + 1] === annotationSlash || raw[index + 1] === '{' || raw[index + 1] === '}')) {
          decoded += raw[index + 1];
          index += 1;
          continue;
        }
        decoded += raw[index];
      }
      return decoded;
    };

    const readAnnotationCommandBody = (sourceSlice, openBraceIndex) => {
      if (sourceSlice[openBraceIndex] !== '{') return null;
      let depth = 1;
      let cursor = openBraceIndex + 1;
      while (cursor < sourceSlice.length) {
        const character = sourceSlice[cursor];
        if (character === annotationSlash) {
          cursor += 2;
          continue;
        }
        if (character === '{') {
          depth += 1;
        } else if (character === '}') {
          depth -= 1;
          if (depth === 0) {
            return {
              value: sourceSlice.slice(openBraceIndex + 1, cursor),
              endOffset: cursor + 1,
            };
          }
        }
        cursor += 1;
      }
      return null;
    };

    const parseAnnotationCommandAt = (sourceSlice, startOffset) => {
      if (sourceSlice[startOffset] !== annotationSlash) return null;
      const commands = [
        { raw: annotationSlash + 'comment{', kind: 'comment' },
        { raw: annotationSlash + 'mark{', kind: 'mark' },
        { raw: annotationSlash + 'cmt{', kind: 'comment' },
      ];
      const command = commands.find((candidate) => sourceSlice.startsWith(candidate.raw, startOffset));
      if (!command) return null;
      const openBraceIndex = startOffset + command.raw.length - 1;
      const body = readAnnotationCommandBody(sourceSlice, openBraceIndex);
      if (!body) return null;
      return {
        kind: command.kind,
        startOffset,
        endOffset: body.endOffset,
        bodyStartOffset: openBraceIndex + 1,
        bodyEndOffset: body.endOffset - 1,
        rawBody: body.value,
        value: decodeAnnotationSource(body.value),
      };
    };

    const parseAdjacentCommentCommand = (sourceSlice, fromOffset) => {
      let cursor = fromOffset;
      while (cursor < sourceSlice.length && (sourceSlice[cursor] === ' ' || sourceSlice[cursor] === '\\t')) {
        cursor += 1;
      }
      const command = parseAnnotationCommandAt(sourceSlice, cursor);
      if (!command || command.kind !== 'comment') return null;
      return {
        ...command,
        gapStartOffset: fromOffset,
      };
    };

    const findCommentMarkupInSourceSlice = ${findAnnotationCommentInSource.toString()};

    const findCommentMarkupInEditor = (selectedText, sourceLine, sourceEndLine, occurrence = 0) => {
      const editorValue = editor.getValue();
      const lineWindow = sourceWindowForLines(editorValue, sourceLine, sourceEndLine);
      if (lineWindow) {
        const lineMatch = findCommentMarkupInSourceSlice(lineWindow.value, selectedText, occurrence);
        if (lineMatch) {
          return {
            comment: lineMatch.comment,
            commentStartIndex: lineWindow.startIndex + lineMatch.commentStartOffset,
            commentEndIndex: lineWindow.startIndex + lineMatch.commentEndOffset,
            commentBodyStartIndex: lineWindow.startIndex + lineMatch.commentBodyStartOffset,
            commentBodyEndIndex: lineWindow.startIndex + lineMatch.commentBodyEndOffset,
            commentInsertionEndIndex: lineWindow.startIndex + lineMatch.commentInsertionEndOffset,
          };
        }
      }

      const fullMatch = findCommentMarkupInSourceSlice(editorValue, selectedText, occurrence);
      if (!fullMatch) return null;
      return {
        comment: fullMatch.comment,
        commentStartIndex: fullMatch.commentStartOffset,
        commentEndIndex: fullMatch.commentEndOffset,
        commentBodyStartIndex: fullMatch.commentBodyStartOffset,
        commentBodyEndIndex: fullMatch.commentBodyEndOffset,
        commentInsertionEndIndex: fullMatch.commentInsertionEndOffset,
      };
    };

    const findMarkMarkupInSourceSlice = (sourceSlice, selectedText, occurrence = 0, sourceText = '') => {
      if (!sourceSlice || !selectedText) return null;
      const normalizedSelection = normalizeTextWithIndexMap(sourceText || selectedText).text;
      if (!normalizedSelection) return null;

      let matchedOccurrence = 0;
      const findInSlice = (value, baseOffset = 0) => {
        let searchFrom = 0;
        while (searchFrom < value.length) {
          const commandIndex = value.indexOf(annotationSlash, searchFrom);
          if (commandIndex < 0) return null;
          const command = parseAnnotationCommandAt(value, commandIndex);
          if (!command) {
            searchFrom = commandIndex + 1;
            continue;
          }
          if (command.kind === 'mark' && normalizeTextWithIndexMap(command.value).text === normalizedSelection) {
            if (matchedOccurrence >= occurrence) {
              return {
                ...command,
                startOffset: baseOffset + command.startOffset,
                endOffset: baseOffset + command.endOffset,
                bodyStartOffset: baseOffset + command.bodyStartOffset,
                bodyEndOffset: baseOffset + command.bodyEndOffset,
              };
            }
            matchedOccurrence += 1;
          }
          const nestedMatch = findInSlice(
            value.slice(command.bodyStartOffset, command.bodyEndOffset),
            baseOffset + command.bodyStartOffset,
          );
          if (nestedMatch) return nestedMatch;
          searchFrom = command.endOffset;
        }
        return null;
      };

      const markCommand = findInSlice(sourceSlice);
      if (!markCommand) return null;
      const commentCommand = parseAdjacentCommentCommand(sourceSlice, markCommand.endOffset);
      return {
        startOffset: markCommand.startOffset,
        markEndOffset: markCommand.endOffset,
        endOffset: markCommand.endOffset,
        innerSource: markCommand.value,
        rawInnerSource: markCommand.rawBody,
        comment: commentCommand ? commentCommand.value : '',
        commentStartOffset: commentCommand ? commentCommand.startOffset : null,
        commentEndOffset: commentCommand ? commentCommand.endOffset : null,
        commentBodyStartOffset: commentCommand ? commentCommand.bodyStartOffset : null,
        commentBodyEndOffset: commentCommand ? commentCommand.bodyEndOffset : null,
        commentGapStartOffset: commentCommand ? commentCommand.gapStartOffset : null,
      };
    };

    const findMarkMarkupInEditor = (selectedText, sourceLine, sourceEndLine, occurrence = 0, sourceText = '') => {
      const editorValue = editor.getValue();
      const lineWindow = sourceWindowForLines(editorValue, sourceLine, sourceEndLine);
      if (lineWindow) {
        const lineMatch = findMarkMarkupInSourceSlice(lineWindow.value, selectedText, occurrence, sourceText);
        if (lineMatch) {
          return {
            startIndex: lineWindow.startIndex + lineMatch.startOffset,
            markEndIndex: lineWindow.startIndex + lineMatch.markEndOffset,
            endIndex: lineWindow.startIndex + lineMatch.endOffset,
            innerSource: lineMatch.innerSource,
            rawInnerSource: lineMatch.rawInnerSource,
            comment: lineMatch.comment,
            commentStartIndex: lineMatch.commentStartOffset === null ? null : lineWindow.startIndex + lineMatch.commentStartOffset,
            commentEndIndex: lineMatch.commentEndOffset === null ? null : lineWindow.startIndex + lineMatch.commentEndOffset,
            commentBodyStartIndex: lineMatch.commentBodyStartOffset === null ? null : lineWindow.startIndex + lineMatch.commentBodyStartOffset,
            commentBodyEndIndex: lineMatch.commentBodyEndOffset === null ? null : lineWindow.startIndex + lineMatch.commentBodyEndOffset,
            commentGapStartIndex: lineMatch.commentGapStartOffset === null ? null : lineWindow.startIndex + lineMatch.commentGapStartOffset,
          };
        }
      }

      const fullMatch = findMarkMarkupInSourceSlice(editorValue, selectedText, occurrence, sourceText);
      if (!fullMatch) return null;
      return {
        startIndex: fullMatch.startOffset,
        markEndIndex: fullMatch.markEndOffset,
        endIndex: fullMatch.endOffset,
        innerSource: fullMatch.innerSource,
        rawInnerSource: fullMatch.rawInnerSource,
        comment: fullMatch.comment,
        commentStartIndex: fullMatch.commentStartOffset,
        commentEndIndex: fullMatch.commentEndOffset,
        commentBodyStartIndex: fullMatch.commentBodyStartOffset,
        commentBodyEndIndex: fullMatch.commentBodyEndOffset,
        commentGapStartIndex: fullMatch.commentGapStartOffset,
      };
    };

    const replaceEditorRangeWithHighlight = (startIndex, endIndex) => {
      const editorValue = editor.getValue();
      const safeStart = Math.min(Math.max(0, startIndex), editorValue.length);
      const safeEnd = Math.min(Math.max(safeStart, endIndex), editorValue.length);
      const selectedSource = editorValue.slice(safeStart, safeEnd);
      if (!selectedSource.trim()) return false;

      if (editorValue.slice(Math.max(0, safeStart - 2), safeStart) === '==' && editorValue.slice(safeEnd, safeEnd + 2) === '==') {
        setStatus('Already highlighted', 1400);
        return true;
      }

      const Range = ace.require('ace/range').Range;
      const start = indexToEditorPosition(editorValue, safeStart);
      const end = indexToEditorPosition(editorValue, safeEnd);
      editor.session.replace(new Range(start.row, start.column, end.row, end.column), '==' + selectedSource + '==');

      const nextValue = editor.getValue();
      const nextStart = indexToEditorPosition(nextValue, safeStart);
      const nextEnd = indexToEditorPosition(nextValue, safeEnd + 4);
      editor.selection.setRange(new Range(nextStart.row, nextStart.column, nextEnd.row, nextEnd.column), false);
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Highlighted; save to persist', 1800);
      return true;
    };

    const removeHighlightMarkup = (match) => {
      if (!match || typeof match.innerSource !== 'string') return false;
      const editorValue = editor.getValue();
      const safeStart = Math.min(Math.max(0, match.startIndex), editorValue.length);
      const safeEnd = Math.min(Math.max(safeStart, match.endIndex), editorValue.length);
      const Range = ace.require('ace/range').Range;
      const start = indexToEditorPosition(editorValue, safeStart);
      const end = indexToEditorPosition(editorValue, safeEnd);
      editor.session.replace(new Range(start.row, start.column, end.row, end.column), match.innerSource);

      const nextValue = editor.getValue();
      const nextStart = indexToEditorPosition(nextValue, safeStart);
      const nextEnd = indexToEditorPosition(nextValue, safeStart + match.innerSource.length);
      editor.selection.setRange(new Range(nextStart.row, nextStart.column, nextEnd.row, nextEnd.column), false);
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Highlight removed; save to persist', 1800);
      return true;
    };

    const replaceEditorRangeWithMark = (startIndex, endIndex) => {
      const editorValue = editor.getValue();
      const safeStart = Math.min(Math.max(0, startIndex), editorValue.length);
      const safeEnd = Math.min(Math.max(safeStart, endIndex), editorValue.length);
      const selectedSource = editorValue.slice(safeStart, safeEnd);
      if (!selectedSource.trim()) return false;

      if (editorValue.slice(Math.max(0, safeStart - 6), safeStart) === annotationSlash + 'mark{' && editorValue[safeEnd] === '}') {
        setStatus('Already marked', 1400);
        return true;
      }

      const replacement = annotationSlash + 'mark{' + encodeAnnotationSource(selectedSource) + '}';
      const Range = ace.require('ace/range').Range;
      const start = indexToEditorPosition(editorValue, safeStart);
      const end = indexToEditorPosition(editorValue, safeEnd);
      editor.session.replace(new Range(start.row, start.column, end.row, end.column), replacement);

      const nextValue = editor.getValue();
      const nextStart = indexToEditorPosition(nextValue, safeStart);
      const nextEnd = indexToEditorPosition(nextValue, safeStart + replacement.length);
      editor.selection.setRange(new Range(nextStart.row, nextStart.column, nextEnd.row, nextEnd.column), false);
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Marked; save to persist', 1800);
      return true;
    };

    const unmarkMarkup = (match) => {
      if (!match || typeof match.innerSource !== 'string') return false;
      const editorValue = editor.getValue();
      const safeStart = Math.min(Math.max(0, match.startIndex), editorValue.length);
      const safeEnd = Math.min(Math.max(safeStart, match.endIndex), editorValue.length);
      const Range = ace.require('ace/range').Range;
      const start = indexToEditorPosition(editorValue, safeStart);
      const end = indexToEditorPosition(editorValue, safeEnd);
      editor.session.replace(new Range(start.row, start.column, end.row, end.column), match.innerSource);

      const nextValue = editor.getValue();
      const nextStart = indexToEditorPosition(nextValue, safeStart);
      const nextEnd = indexToEditorPosition(nextValue, safeStart + match.innerSource.length);
      editor.selection.setRange(new Range(nextStart.row, nextStart.column, nextEnd.row, nextEnd.column), false);
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Mark removed; save to persist', 1800);
      return true;
    };

    const insertEditorCommentAt = (insertIndex, commentText) => {
      if (typeof commentText !== 'string') return false;
      const editorValue = editor.getValue();
      const safeIndex = Math.min(Math.max(0, insertIndex), editorValue.length);
      const encodedComment = encodeAnnotationSource(commentText);
      const point = indexToEditorPosition(editorValue, safeIndex);
      editor.session.insert(point, annotationSlash + 'comment{' + encodedComment + '}');
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Comment added; save to persist', 1800);
      return true;
    };

    const upsertCommentMarkup = (match, commentText) => {
      if (!match || typeof commentText !== 'string' || !Number.isFinite(match.commentStartIndex) || !Number.isFinite(match.commentEndIndex)) return false;
      const editorValue = editor.getValue();
      const encodedComment = encodeAnnotationSource(commentText);
      const Range = ace.require('ace/range').Range;
      const start = indexToEditorPosition(editorValue, match.commentStartIndex);
      const end = indexToEditorPosition(editorValue, match.commentEndIndex);
      editor.session.replace(new Range(start.row, start.column, end.row, end.column), annotationSlash + 'comment{' + encodedComment + '}');
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Comment updated; save to persist', 1800);
      return true;
    };

    const removeCommentMarkup = (match) => {
      if (!match || !Number.isFinite(match.commentStartIndex) || !Number.isFinite(match.commentEndIndex)) return false;
      const editorValue = editor.getValue();
      const safeStart = Math.min(Math.max(0, match.commentStartIndex), editorValue.length);
      const safeEnd = Math.min(Math.max(safeStart, match.commentEndIndex), editorValue.length);
      const Range = ace.require('ace/range').Range;
      const start = indexToEditorPosition(editorValue, safeStart);
      const end = indexToEditorPosition(editorValue, safeEnd);
      editor.session.replace(new Range(start.row, start.column, end.row, end.column), '');
      editor.focus();
      suppressFloatingHighlightActions();
      schedulePreview(0);
      setStatus('Comment removed; save to persist', 1800);
      return true;
    };

    const highlightEditorSelection = () => {
      const selectionRange = editor.getSelectionRange();
      if (selectionRange && !selectionRange.isEmpty()) {
        const editorValue = editor.getValue();
        const startIndex = editorPositionToIndex(editorValue, selectionRange.start);
        const endIndex = editorPositionToIndex(editorValue, selectionRange.end);
        return replaceEditorRangeWithHighlight(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex));
      }
      if (!lastEditorHighlightSelection) return false;
      return replaceEditorRangeWithHighlight(lastEditorHighlightSelection.startIndex, lastEditorHighlightSelection.endIndex);
    };

    const highlightPreviewSelection = () => {
      if (!lastPreviewHighlightSelection) return false;
      const selectedText = normalizeHighlightSelectionText(lastPreviewHighlightSelection.text);
      if (!selectedText) return false;
      const match = findHighlightSelectionInEditor(
        selectedText,
        lastPreviewHighlightSelection.line,
        lastPreviewHighlightSelection.endLine,
        {
          containsInlineCode: lastPreviewHighlightSelection.containsInlineCode === true,
          endsInInlineCode: lastPreviewHighlightSelection.endsInInlineCode === true,
        },
      );
      if (!match) {
        setPreviewStatus('Could not find selected text in source');
        return true;
      }
      return replaceEditorRangeWithHighlight(match.startIndex, match.endIndex);
    };

    const highlightCurrentSelection = () => {
      if (!supportsMarkdownPreview) return;
      if (lastPreviewHighlightSelection && highlightPreviewSelection()) return;
      if (highlightEditorSelection()) return;
      setPreviewStatus('Select text in preview or editor first');
    };

    const markEditorSelection = () => {
      const selectionRange = editor.getSelectionRange();
      if (selectionRange && !selectionRange.isEmpty()) {
        const editorValue = editor.getValue();
        const startIndex = editorPositionToIndex(editorValue, selectionRange.start);
        const endIndex = editorPositionToIndex(editorValue, selectionRange.end);
        return replaceEditorRangeWithMark(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex));
      }
      if (!lastEditorHighlightSelection) return false;
      return replaceEditorRangeWithMark(lastEditorHighlightSelection.startIndex, lastEditorHighlightSelection.endIndex);
    };

    const markPreviewSelection = () => {
      if (!lastPreviewHighlightSelection) return false;
      const selectedText = normalizeHighlightSelectionText(lastPreviewHighlightSelection.text);
      if (!selectedText) return false;
      const match = findHighlightSelectionInEditor(
        selectedText,
        lastPreviewHighlightSelection.line,
        lastPreviewHighlightSelection.endLine,
        {
          containsInlineCode: lastPreviewHighlightSelection.containsInlineCode === true,
          endsInInlineCode: lastPreviewHighlightSelection.endsInInlineCode === true,
        },
      );
      if (!match) {
        setPreviewStatus('Could not find selected text in source');
        return true;
      }
      return replaceEditorRangeWithMark(match.startIndex, match.endIndex);
    };

    const markCurrentSelection = () => {
      if (!supportsMarkdownPreview) return;
      if (lastPreviewHighlightSelection && markPreviewSelection()) return;
      if (markEditorSelection()) return;
      setPreviewStatus('Select text in preview or editor first');
    };

    const findCommentInsertIndexForEditorSelection = () => {
      const selectionRange = editor.getSelectionRange();
      if (selectionRange && !selectionRange.isEmpty()) {
        const editorValue = editor.getValue();
        const startIndex = editorPositionToIndex(editorValue, selectionRange.start);
        const endIndex = editorPositionToIndex(editorValue, selectionRange.end);
        return Math.max(startIndex, endIndex);
      }
      if (!lastEditorHighlightSelection) return null;
      return lastEditorHighlightSelection.endIndex;
    };

    const findCommentInsertIndexForPreviewSelection = () => {
      if (!lastPreviewHighlightSelection) return null;
      const selectedText = normalizeHighlightSelectionText(lastPreviewHighlightSelection.text);
      if (!selectedText) return null;
      const match = findHighlightSelectionInEditor(
        selectedText,
        lastPreviewHighlightSelection.line,
        lastPreviewHighlightSelection.endLine,
        {
          containsInlineCode: lastPreviewHighlightSelection.containsInlineCode === true,
          endsInInlineCode: lastPreviewHighlightSelection.endsInInlineCode === true,
        },
      );
      if (!match) {
        setPreviewStatus('Could not find selected text in source');
        return null;
      }
      return match.endIndex;
    };

    const addCommentToCurrentSelection = (rect = null) => {
      if (!supportsMarkdownPreview) return;
      const insertIndex = lastPreviewHighlightSelection
        ? findCommentInsertIndexForPreviewSelection()
        : findCommentInsertIndexForEditorSelection();
      if (insertIndex === null) {
        setPreviewStatus('Select text in preview or editor first');
        return;
      }
      showFloatingCommentEditor({
        title: 'Add comment',
        rect,
        onSubmit: (commentText) => {
          insertEditorCommentAt(insertIndex, commentText);
        },
      });
    };

    const findCurrentMarkMarkup = () => {
      if (!supportsMarkdownPreview || !lastPreviewClickedMark) {
        setPreviewStatus('Click marked text first');
        return null;
      }
      const selectedText = normalizeHighlightSelectionText(lastPreviewClickedMark.text);
      if (!selectedText) {
        setPreviewStatus('Click marked text first');
        return null;
      }
      const match = findMarkMarkupInEditor(
        selectedText,
        lastPreviewClickedMark.line,
        lastPreviewClickedMark.endLine,
        Number.isFinite(lastPreviewClickedMark.occurrence) ? lastPreviewClickedMark.occurrence : 0,
        typeof lastPreviewClickedMark.sourceText === 'string' ? lastPreviewClickedMark.sourceText : '',
      );
      if (!match) {
        setPreviewStatus('Could not find mark in source');
        return null;
      }
      return match;
    };

    const unmarkCurrentMark = () => {
      const match = findCurrentMarkMarkup();
      if (!match) return;
      unmarkMarkup(match);
    };

    const findCurrentCommentMarkup = () => {
      if (!supportsMarkdownPreview || !lastPreviewClickedComment) {
        setPreviewStatus('Click a comment first');
        return null;
      }
      const selectedText = normalizeHighlightSelectionText(lastPreviewClickedComment.text);
      if (!selectedText) {
        setPreviewStatus('Click a comment first');
        return null;
      }
      const match = findCommentMarkupInEditor(
        selectedText,
        lastPreviewClickedComment.line,
        lastPreviewClickedComment.endLine,
        Number.isFinite(lastPreviewClickedComment.occurrence) ? lastPreviewClickedComment.occurrence : 0,
      );
      if (!match) {
        setPreviewStatus('Could not find comment in source');
        return null;
      }
      return match;
    };

    const editCurrentComment = (rect = null) => {
      const match = findCurrentCommentMarkup();
      if (!match) return;
      showFloatingCommentEditor({
        title: 'Edit comment',
        initialValue: match.comment || '',
        rect,
        onSubmit: (commentText) => {
          upsertCommentMarkup(match, commentText);
        },
      });
    };

    const removeCurrentComment = () => {
      const match = findCurrentCommentMarkup();
      if (!match) return;
      removeCommentMarkup(match);
    };

    const addCommentToCurrentComment = (rect = null) => {
      const match = findCurrentCommentMarkup();
      if (!match) return;
      addCommentAtInsertIndex(
        Number.isFinite(match.commentInsertionEndIndex) ? match.commentInsertionEndIndex : match.commentEndIndex,
        rect,
      );
    };

    const findCurrentHighlightMarkup = () => {
      if (!supportsMarkdownPreview || !lastPreviewClickedHighlight) {
        setPreviewStatus('Click a highlighted block first');
        return null;
      }
      const selectedText = normalizeHighlightSelectionText(lastPreviewClickedHighlight.text);
      if (!selectedText) {
        setPreviewStatus('Click a highlighted block first');
        return null;
      }
      const match = findHighlightMarkupInEditor(
        selectedText,
        lastPreviewClickedHighlight.line,
        lastPreviewClickedHighlight.endLine,
        Number.isFinite(lastPreviewClickedHighlight.occurrence) ? lastPreviewClickedHighlight.occurrence : 0,
        typeof lastPreviewClickedHighlight.sourceText === 'string' ? lastPreviewClickedHighlight.sourceText : '',
      );
      if (!match) {
        setPreviewStatus('Could not find highlight markers in source');
        return null;
      }
      return match;
    };

    const commentInsertIndexAfterMarkup = (match, fallbackIndex) => {
      if (match && Number.isFinite(match.commentEndIndex)) return match.commentEndIndex;
      if (Number.isFinite(fallbackIndex)) return fallbackIndex;
      if (match && Number.isFinite(match.endIndex)) return match.endIndex;
      return null;
    };

    const addCommentAtInsertIndex = (insertIndex, rect = null) => {
      if (!Number.isFinite(insertIndex)) {
        setPreviewStatus('Could not find annotation target in source');
        return;
      }
      showFloatingCommentEditor({
        title: 'Add comment',
        rect,
        onSubmit: (commentText) => {
          insertEditorCommentAt(insertIndex, commentText);
        },
      });
    };

    const addCommentToCurrentHighlight = (rect = null) => {
      const match = findCurrentHighlightMarkup();
      if (!match) return;
      addCommentAtInsertIndex(commentInsertIndexAfterMarkup(match, match.highlightEndIndex), rect);
    };

    const addCommentToCurrentMark = (rect = null) => {
      const match = findCurrentMarkMarkup();
      if (!match) return;
      addCommentAtInsertIndex(commentInsertIndexAfterMarkup(match, match.markEndIndex), rect);
    };

    const removeCurrentHighlight = () => {
      const match = findCurrentHighlightMarkup();
      if (!match) return;
      removeHighlightMarkup(match);
    };

    const handlePreviewMessage = (event) => {
      if (!supportsMarkdownPreview || !previewFrame || event.source !== previewFrame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'codex-local-markdown-preview-selection') {
        if (data.path !== editorReferencePath) return;
        const selectedText = normalizeHighlightSelectionText(data.text);
        if (!selectedText) return;
        const sourceLine = Number.parseInt(String(data.line), 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return;
        const sourceEndLine = Number.parseInt(String(data.endLine ?? sourceLine), 10);
        lastPreviewHighlightSelection = {
          text: selectedText,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          containsInlineCode: data.containsInlineCode === true,
          endsInInlineCode: data.endsInInlineCode === true,
        };
        lastEditorHighlightSelection = null;
        lastPreviewClickedHighlight = null;
        lastPreviewClickedMark = null;
        lastPreviewClickedComment = null;
        showFloatingHighlightButton(rectFromPreviewMessage(data.rect));
        return;
      }
      if (data.type === 'codex-local-markdown-highlight-click') {
        if (data.path !== editorReferencePath) return;
        const selectedText = normalizeHighlightSelectionText(data.text);
        if (!selectedText) return;
        const sourceLine = Number.parseInt(String(data.line), 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return;
        const sourceEndLine = Number.parseInt(String(data.endLine ?? sourceLine), 10);
        lastPreviewClickedHighlight = {
          text: selectedText,
          sourceText: typeof data.sourceText === 'string' ? data.sourceText : '',
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          occurrence: Number.isFinite(Number(data.occurrence)) ? Math.max(0, Math.floor(Number(data.occurrence))) : 0,
        };
        lastPreviewHighlightSelection = null;
        lastEditorHighlightSelection = null;
        lastPreviewClickedMark = null;
        lastPreviewClickedComment = null;
        showFloatingRemoveHighlightButton(rectFromPreviewMessage(data.rect));
        return;
      }
      if (data.type === 'codex-local-markdown-mark-click') {
        if (data.path !== editorReferencePath) return;
        const selectedText = normalizeHighlightSelectionText(data.text);
        if (!selectedText) return;
        const sourceLine = Number.parseInt(String(data.line), 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return;
        const sourceEndLine = Number.parseInt(String(data.endLine ?? sourceLine), 10);
        lastPreviewClickedMark = {
          text: selectedText,
          sourceText: typeof data.sourceText === 'string' ? data.sourceText : '',
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          occurrence: Number.isFinite(Number(data.occurrence)) ? Math.max(0, Math.floor(Number(data.occurrence))) : 0,
        };
        lastPreviewHighlightSelection = null;
        lastPreviewClickedHighlight = null;
        lastEditorHighlightSelection = null;
        lastPreviewClickedComment = null;
        showFloatingMarkActions(rectFromPreviewMessage(data.rect));
        return;
      }
      if (data.type === 'codex-local-markdown-comment-click') {
        if (data.path !== editorReferencePath) return;
        const selectedText = normalizeHighlightSelectionText(data.text);
        if (!selectedText) return;
        const sourceLine = Number.parseInt(String(data.line), 10);
        if (!Number.isFinite(sourceLine) || sourceLine < 1) return;
        const sourceEndLine = Number.parseInt(String(data.endLine ?? sourceLine), 10);
        lastPreviewClickedComment = {
          text: selectedText,
          line: sourceLine,
          endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
          occurrence: Number.isFinite(Number(data.occurrence)) ? Math.max(0, Math.floor(Number(data.occurrence))) : 0,
        };
        lastPreviewHighlightSelection = null;
        lastPreviewClickedHighlight = null;
        lastPreviewClickedMark = null;
        lastEditorHighlightSelection = null;
        showFloatingCommentActions(rectFromPreviewMessage(data.rect));
        return;
      }
      if (data.type === 'codex-local-markdown-highlight-dismiss') {
        if (data.path !== editorReferencePath) return;
        dismissFloatingHighlightActions();
        return;
      }
      if (data.type === 'codex-local-markdown-preview-save') {
        if (data.path !== editorReferencePath) return;
        saveEditorContent();
        return;
      }
      if (data.type !== 'codex-local-markdown-preview-jump') return;
      if (data.path !== editorReferencePath) return;
      const sourceLine = Number.parseInt(String(data.line), 10);
      if (!Number.isFinite(sourceLine) || sourceLine < 1) return;
      const sourceEndLine = Number.parseInt(String(data.endLine ?? sourceLine), 10);
      let releaseTimer = 0;
      let released = false;
      const releaseEditorScrollSync = () => {
        if (released) return;
        released = true;
        isApplyingEditorScrollFromPreview = false;
        if (releaseTimer) {
          window.clearTimeout(releaseTimer);
          releaseTimer = 0;
        }
      };
      isApplyingEditorScrollFromPreview = true;
      lastEditorSyncedLine = sourceLine;
      lastPreviewSyncedLine = sourceLine;
      releaseTimer = window.setTimeout(releaseEditorScrollSync, 800);
      jumpEditorToLineRange(
        sourceLine,
        Number.isFinite(sourceEndLine) ? sourceEndLine : sourceLine,
        false,
        releaseEditorScrollSync,
      );
    };

    window.addEventListener('message', handlePreviewMessage);

    const previewEndpoint = () => {
      if (!location.pathname.startsWith('/codex-local-edit')) return '';
      return '/codex-local-preview' + location.pathname.slice('/codex-local-edit'.length);
    };

    const previewErrorHtml = (message) => {
      const escaped = String(message || 'Preview failed')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:22px;font:14px system-ui;color:#b91c1c;background:#fff1f2}@media(prefers-color-scheme:dark){body{color:#fecdd3;background:#2a0f18}}</style></head><body>' + escaped + '</body></html>';
    };

    const getPreviewScrollRoot = () => {
      if (!previewFrame) return null;
      const frameWindow = previewFrame.contentWindow;
      const frameDocument = previewFrame.contentDocument;
      if (!frameWindow || !frameDocument) return null;
      const scrollingElement = frameDocument.scrollingElement || frameDocument.documentElement || frameDocument.body;
      if (!scrollingElement) return null;
      return { frameWindow, scrollingElement };
    };

    const capturePreviewScrollState = () => {
      const root = getPreviewScrollRoot();
      if (!root) return null;
      return {
        left: root.frameWindow.scrollX || root.scrollingElement.scrollLeft || 0,
        top: root.frameWindow.scrollY || root.scrollingElement.scrollTop || 0,
      };
    };

    const restorePreviewScrollState = (state) => {
      if (!state || !previewVisible) return;
      const root = getPreviewScrollRoot();
      if (!root) return;
      const maxLeft = Math.max(0, root.scrollingElement.scrollWidth - root.scrollingElement.clientWidth);
      const maxTop = Math.max(0, root.scrollingElement.scrollHeight - root.scrollingElement.clientHeight);
      const nextLeft = Math.min(maxLeft, Math.max(0, Number(state.left) || 0));
      const nextTop = Math.min(maxTop, Math.max(0, Number(state.top) || 0));
      root.frameWindow.scrollTo(nextLeft, nextTop);
    };

    const suppressPreviewScrollSync = (durationMs = 180) => {
      previewScrollSyncSuppressedUntil = Math.max(
        previewScrollSyncSuppressedUntil,
        window.performance.now() + durationMs,
      );
    };

    const isPreviewScrollSyncSuppressed = () => (
      window.performance.now() < previewScrollSyncSuppressedUntil
    );

    const detachPreviewScrollSync = () => {
      if (previewScrollSyncCleanup) {
        previewScrollSyncCleanup();
        previewScrollSyncCleanup = null;
      }
    };

    const cancelPreviewScrollSyncFrames = () => {
      if (editorScrollSyncFrame) {
        window.cancelAnimationFrame(editorScrollSyncFrame);
        editorScrollSyncFrame = 0;
      }
      if (previewScrollSyncFrame) {
        window.cancelAnimationFrame(previewScrollSyncFrame);
        previewScrollSyncFrame = 0;
      }
    };

    const parsePreviewAnchorLine = (anchor) => {
      const sourceLine = Number.parseInt(anchor.getAttribute('data-source-line') || '', 10);
      if (!Number.isFinite(sourceLine) || sourceLine < 1) {
        return null;
      }
      const sourceEndLine = Number.parseInt(anchor.getAttribute('data-source-end-line') || '', 10);
      return {
        line: sourceLine,
        endLine: Number.isFinite(sourceEndLine) && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine,
      };
    };

    const getPreviewAnchorElements = () => {
      const root = getPreviewScrollRoot();
      if (!root) return [];
      return Array.from(root.scrollingElement.querySelectorAll(previewScrollAnchorSelector));
    };

    const findPreviewAnchorForSourceLine = (targetLine) => {
      const anchors = getPreviewAnchorElements();
      if (anchors.length === 0) return null;

      let floorAnchor = null;
      let ceilAnchor = null;

      for (const anchor of anchors) {
        const sourceRange = parsePreviewAnchorLine(anchor);
        if (!sourceRange) continue;

        if (sourceRange.line <= targetLine && sourceRange.endLine >= targetLine) {
          return anchor;
        }

        if (sourceRange.line <= targetLine) {
          if (!floorAnchor || sourceRange.line > floorAnchor.line) {
            floorAnchor = { anchor, line: sourceRange.line };
          }
          continue;
        }

        if (!ceilAnchor || sourceRange.line < ceilAnchor.line) {
          ceilAnchor = { anchor, line: sourceRange.line };
        }
      }

      return floorAnchor?.anchor ?? ceilAnchor?.anchor ?? null;
    };

    const getEditorVisibleSourceLine = () => {
      const renderer = editor.renderer;
      if (!renderer || typeof renderer.getFirstVisibleRow !== 'function' || typeof renderer.getLastVisibleRow !== 'function') {
        return 0;
      }

      const firstVisibleRow = Number(renderer.getFirstVisibleRow());
      const lastVisibleRow = Number(renderer.getLastVisibleRow());
      if (!Number.isFinite(firstVisibleRow) || !Number.isFinite(lastVisibleRow)) return 0;

      const lineCount = editor.session.getLength();
      const centerRow = Math.floor((Math.min(firstVisibleRow, lastVisibleRow) + Math.max(firstVisibleRow, lastVisibleRow)) / 2);
      const centerLine = centerRow + 1;
      if (!Number.isFinite(centerLine) || centerLine < 1) return 0;
      return lineCount > 0 ? Math.min(lineCount, centerLine) : centerLine;
    };

    const getPreviewVisibleSourceLine = () => {
      const root = getPreviewScrollRoot();
      if (!root) return 0;

      const viewportHeight = root.frameWindow.innerHeight || root.scrollingElement.clientHeight || 0;
      if (!viewportHeight) return 0;

      const anchors = getPreviewAnchorElements();
      if (anchors.length === 0) return 0;

      let bestAnchor = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const anchor of anchors) {
        const sourceRange = parsePreviewAnchorLine(anchor);
        if (!sourceRange) continue;

        const rect = anchor.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;

        const anchorCenter = (rect.top + rect.bottom) / 2;
        const distance = Math.abs(anchorCenter - (viewportHeight / 2));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestAnchor = sourceRange.line;
        }
      }

      return bestAnchor || 0;
    };

    const syncPreviewScrollFromEditor = (force = false) => {
      if (!supportsMarkdownPreview || !previewVisible || isApplyingPreviewScrollFromEditor || isApplyingEditorScrollFromPreview) return;

      const targetLine = getEditorVisibleSourceLine();
      if (!targetLine) return;
      if (!force && targetLine === lastEditorSyncedLine) return;

      const anchor = findPreviewAnchorForSourceLine(targetLine);
      if (!anchor) return;

      isApplyingPreviewScrollFromEditor = true;
      suppressPreviewScrollSync();
      lastEditorSyncedLine = targetLine;
      lastPreviewSyncedLine = targetLine;

      try {
        anchor.scrollIntoView({ block: 'start', inline: 'nearest' });
        const scrollState = capturePreviewScrollState();
        if (scrollState) {
          lastPreviewScrollState = scrollState;
        }
      } finally {
        window.requestAnimationFrame(() => {
          isApplyingPreviewScrollFromEditor = false;
        });
      }
    };

    const syncEditorScrollFromPreview = (force = false) => {
      if (!supportsMarkdownPreview || !previewVisible || isApplyingEditorScrollFromPreview || isApplyingPreviewScrollFromEditor) return;

      const targetLine = getPreviewVisibleSourceLine();
      if (!targetLine) return;
      if (!force && targetLine === lastPreviewSyncedLine) return;

      isApplyingEditorScrollFromPreview = true;
      lastPreviewSyncedLine = targetLine;
      lastEditorSyncedLine = targetLine;

      try {
        editor.scrollToLine(targetLine, true, false, () => {});
      } finally {
        window.requestAnimationFrame(() => {
          isApplyingEditorScrollFromPreview = false;
        });
      }
    };

    const schedulePreviewScrollSyncFromEditor = (force = false) => {
      if (!supportsMarkdownPreview || !previewVisible || previewScrollSyncFrame || isApplyingEditorScrollFromPreview) return;
      previewScrollSyncFrame = window.requestAnimationFrame(() => {
        previewScrollSyncFrame = 0;
        if (!supportsMarkdownPreview || !previewVisible || isApplyingEditorScrollFromPreview) return;
        syncPreviewScrollFromEditor(force);
      });
    };

    const scheduleEditorScrollSyncFromPreview = (force = false) => {
      if (!supportsMarkdownPreview || !previewVisible || editorScrollSyncFrame || isApplyingPreviewScrollFromEditor || isPreviewScrollSyncSuppressed()) return;
      editorScrollSyncFrame = window.requestAnimationFrame(() => {
        editorScrollSyncFrame = 0;
        if (!supportsMarkdownPreview || !previewVisible || isApplyingPreviewScrollFromEditor || isPreviewScrollSyncSuppressed()) return;
        syncEditorScrollFromPreview(force);
      });
    };

    const bindPreviewScrollSync = () => {
      detachPreviewScrollSync();
      const root = getPreviewScrollRoot();
      if (!root) return;

      const handlePreviewScroll = () => {
        if (!supportsMarkdownPreview || !previewVisible || isApplyingPreviewScrollFromEditor || isPreviewScrollSyncSuppressed()) return;
        const scrollState = capturePreviewScrollState();
        if (scrollState) {
          lastPreviewScrollState = scrollState;
        }
        scheduleEditorScrollSyncFromPreview();
      };

      root.frameWindow.addEventListener('scroll', handlePreviewScroll, { passive: true });
      previewScrollSyncCleanup = () => {
        root.frameWindow.removeEventListener('scroll', handlePreviewScroll);
      };
      const scrollState = capturePreviewScrollState();
      if (scrollState) {
        lastPreviewScrollState = scrollState;
      }
    };

    const setPreviewFrameHtml = (html, preserveScroll) => {
      const scrollState = preserveScroll ? capturePreviewScrollState() : null;
      const loadToken = ++previewLoadToken;
      detachPreviewScrollSync();
      if (scrollState) {
        previewFrame.addEventListener('load', () => {
        if (loadToken !== previewLoadToken || !previewVisible) return;
          window.requestAnimationFrame(() => {
            if (loadToken !== previewLoadToken || !previewVisible) return;
            suppressPreviewScrollSync();
            restorePreviewScrollState(scrollState);
            lastPreviewScrollState = scrollState;
            bindPreviewScrollSync();
            suppressPreviewScrollSync();
          });
        }, { once: true });
      } else {
        previewFrame.addEventListener('load', () => {
          if (loadToken !== previewLoadToken || !previewVisible) return;
          window.requestAnimationFrame(() => {
            if (loadToken !== previewLoadToken || !previewVisible) return;
            if (pendingPreviewEditorSync) {
              pendingPreviewEditorSync = false;
              suppressPreviewScrollSync();
              syncPreviewScrollFromEditor(true);
            }
            bindPreviewScrollSync();
            suppressPreviewScrollSync();
          });
        }, { once: true });
      }
      previewFrame.srcdoc = html;
    };

    const renderPreview = async () => {
      if (!supportsMarkdownPreview || !previewVisible || !previewFrame) return;
      const endpoint = previewEndpoint();
      if (!endpoint) return;
      const revision = ++previewRevision;
      if (previewController) {
        previewController.abort();
      }
      previewController = new AbortController();
      setPreviewStatus('Rendering preview...');
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: editor.getValue(),
          signal: previewController.signal,
        });
        if (!response.ok) throw new Error('Preview failed');
        const html = await response.text();
        if (revision !== previewRevision || !previewVisible) return;
        setPreviewFrameHtml(html, !pendingPreviewEditorSync);
        setPreviewStatus('Preview updated');
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (revision !== previewRevision || !previewVisible) return;
        setPreviewFrameHtml(previewErrorHtml('Preview failed'), false);
        setPreviewStatus('Preview failed');
      }
    };

    const schedulePreview = (delay = 250) => {
      if (!supportsMarkdownPreview || !previewVisible) return;
      if (previewTimer) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        renderPreview();
      }, delay);
    };

    const setPreviewVisible = (visible, persist = true) => {
      if (!supportsMarkdownPreview || !previewBtn || !editorShell || !previewFrame) return;
      previewVisible = visible;
      if (persist) {
        savePreviewVisible(visible);
      }
      editorShell.dataset.preview = visible ? 'true' : 'false';
      previewFrame.hidden = !visible;
      if (previewSplitter) {
        previewSplitter.hidden = !visible;
      }
      previewBtn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      previewBtn.textContent = visible ? 'Hide Preview' : 'Preview';
      if (visible) {
        setGitDiffVisible(false);
        pendingPreviewEditorSync = true;
        syncPreviewEditorRatio(false);
      } else {
        previewLoadToken += 1;
        stopPreviewDrag();
        detachPreviewScrollSync();
        cancelPreviewScrollSyncFrames();
        pendingPreviewEditorSync = false;
        lastPreviewHighlightSelection = null;
        lastPreviewClickedHighlight = null;
        lastPreviewClickedMark = null;
        lastPreviewClickedComment = null;
        lastEditorHighlightSelection = null;
        hideFloatingHighlightActions();
      }
      window.requestAnimationFrame(() => editor.resize());
      if (visible) {
        schedulePreview(0);
      } else {
        setPreviewStatus('');
      }
    };

    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        setPreviewVisible(!previewVisible);
      });
      editor.session.on('change', () => {
        lastPreviewHighlightSelection = null;
        lastPreviewClickedHighlight = null;
        lastPreviewClickedMark = null;
        lastPreviewClickedComment = null;
        lastEditorHighlightSelection = null;
        hideFloatingHighlightActions();
        schedulePreview();
      });
      editor.session.on('changeScrollTop', () => {
        if (!supportsMarkdownPreview || !previewVisible || isApplyingEditorScrollFromPreview) return;
        schedulePreviewScrollSyncFromEditor();
      });
      editor.selection.on('changeSelection', scheduleEditorHighlightSelectionCapture);
      if (loadPreviewVisible()) {
        setPreviewVisible(true, false);
      }
    }

    function setGitDiffVisible(visible) {
      if (!editorShell || !gitDiffPanel || !gitDiffBtn) return;
      diffVisible = visible;
      try { window.localStorage.setItem(gitDiffVisibleStorageKey, visible ? 'true' : 'false'); } catch {}
      editorShell.dataset.diff = visible ? 'true' : 'false';
      gitDiffPanel.hidden = !visible;
      if (previewSplitter) previewSplitter.hidden = !visible;
      gitDiffBtn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      gitDiffBtn.textContent = visible ? 'Hide Git diff' : 'Git diff';
      if (visible) {
        syncPreviewEditorRatio(false);
      } else {
        stopPreviewDrag();
      }
      window.requestAnimationFrame(() => editor.resize());
    }

    if (previewSplitter) {
      previewSplitter.addEventListener('pointerdown', startPreviewDrag);
      previewSplitter.addEventListener('dblclick', () => {
        if (!isSplitPaneVisible()) return;
        applyPreviewEditorRatio(defaultPreviewEditorRatio, true);
      });
      previewSplitter.addEventListener('keydown', (event) => {
        if (!isSplitPaneVisible()) return;
        const key = event.key;
        const stacked = isStackedPreviewLayout();
        const shrinkKey = stacked ? 'ArrowUp' : 'ArrowLeft';
        const growKey = stacked ? 'ArrowDown' : 'ArrowRight';
        if (key !== shrinkKey && key !== growKey && key !== 'Home' && key !== 'End') return;
        event.preventDefault();
        const { min, max } = getPreviewEditorRatioBounds();
        const currentRatio = clampPreviewEditorRatio(Number.parseFloat(editorShell.style.getPropertyValue('--preview-editor-ratio')) || loadPreviewEditorRatio());
        if (key === 'Home') {
          applyPreviewEditorRatio(min, true);
        } else if (key === 'End') {
          applyPreviewEditorRatio(max, true);
        } else if (key === shrinkKey) {
          applyPreviewEditorRatio(currentRatio - 0.03, true);
        } else if (key === growKey) {
          applyPreviewEditorRatio(currentRatio + 0.03, true);
        }
      });
    }

    window.addEventListener('resize', () => {
      if (!isSplitPaneVisible()) return;
      syncPreviewEditorRatio(false);
      hideFloatingHighlightActions();
    });

    if (floatingHighlightBtn) {
      floatingHighlightBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        highlightCurrentSelection();
      });
    }

    if (floatingMarkBtn) {
      floatingMarkBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        markCurrentSelection();
      });
    }

    if (floatingRemoveHighlightBtn) {
      floatingRemoveHighlightBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeCurrentHighlight();
      });
    }

    if (floatingAddHighlightCommentBtn) {
      floatingAddHighlightCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        addCommentToCurrentHighlight(rectFromElement(event.currentTarget));
      });
    }

    if (floatingSelectionCommentBtn) {
      floatingSelectionCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        addCommentToCurrentSelection(rectFromElement(event.currentTarget));
      });
    }

    if (floatingUnmarkBtn) {
      floatingUnmarkBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        unmarkCurrentMark();
      });
    }

    if (floatingAddMarkCommentBtn) {
      floatingAddMarkCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        addCommentToCurrentMark(rectFromElement(event.currentTarget));
      });
    }

    if (floatingAddCommentBtn) {
      floatingAddCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        addCommentToCurrentComment(rectFromElement(event.currentTarget));
      });
    }

    if (floatingEditCommentBtn) {
      floatingEditCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        editCurrentComment(rectFromElement(event.currentTarget));
      });
    }

    if (floatingRemoveCommentBtn) {
      floatingRemoveCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeCurrentComment();
      });
    }

    if (floatingCommentEditor) {
      floatingCommentEditor.addEventListener('submit', (event) => {
        event.preventDefault();
        event.stopPropagation();
        submitFloatingCommentEditor();
      });
    }

    if (floatingCancelCommentBtn) {
      floatingCancelCommentBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideFloatingCommentEditor();
      });
    }

    if (floatingCommentInput) {
      floatingCommentInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          hideFloatingCommentEditor();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          submitFloatingCommentEditor();
        }
      });
    }

    document.addEventListener('mousedown', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.floating-highlight-action')) return;
      editorPointerSelectionActive = target instanceof Element && editor.container.contains(target);
      dismissFloatingHighlightActions();
      if (!editorPointerSelectionActive) {
        suppressFloatingActionsUntil = window.performance.now() + 220;
      }
    });

    window.addEventListener('mouseup', () => {
      if (!editorPointerSelectionActive) return;
      editorPointerSelectionActive = false;
      scheduleEditorHighlightSelectionCapture();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      hideFloatingHighlightActions();
    });

   if (copyRefBtn) {
     copyRefBtn.addEventListener('click', async () => {
        if (diffVisible) {
          copyRefBtn.disabled = true;
          try { await copyActiveGitDiffReference(); } catch { gitDiffStatus.textContent = 'Copy reference failed'; }
          finally { copyRefBtn.disabled = false; }
          return;
        }
       const referenceText = buildReferenceText();
        if (!referenceText) {
          setStatus('Reference unavailable');
          return;
        }
        copyRefBtn.disabled = true;
        try {
          await writeTextToClipboard(referenceText);
          setStatus('Reference copied', 1400);
        } catch {
          setStatus('Copy reference failed');
        } finally {
          copyRefBtn.disabled = false;
          editor.focus();
        }
      });
    }

    const updateGitVersionOptions = (versions, base, compare) => {
      const selectedBase = gitDiffBase.value || base;
      const selectedCompare = gitDiffCompare.value || compare;
      const options = versions.map((version) => '<option value="' + String(version.id).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' + String(version.label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</option>').join('');
      gitDiffBase.innerHTML = options;
      gitDiffCompare.innerHTML = options;
      gitDiffBase.value = versions.some((version) => version.id === selectedBase) ? selectedBase : base;
      gitDiffCompare.value = versions.some((version) => version.id === selectedCompare) ? selectedCompare : compare;
    };

    gitDiffBaseEditor = ace.edit('gitDiffBaseEditor');
    gitDiffCompareEditor = ace.edit('gitDiffCompareEditor');
    let activeGitDiffEditor = gitDiffCompareEditor;
    let isSyncingGitDiffScroll = false;
    const gitDiffOverview = document.getElementById('gitDiffOverview');
    const updateGitDiffOverview = () => {
      if (!gitDiffOverview || !gitDiffAlignedRows || gitDiffAlignedRows.length === 0) return;
      const total = gitDiffAlignedRows.length;
      const parts = [];
      for (let i = 0; i < total; i++) {
        const row = gitDiffAlignedRows[i];
        if (row.kind === 'remove') parts.push({ index: i, type: 'remove' });
        else if (row.kind === 'add') parts.push({ index: i, type: 'add' });
        else if (row.kind === 'change') { parts.push({ index: i, type: 'remove' }); parts.push({ index: i, type: 'add' }); }
      }
      let html = '';
      for (const part of parts) {
        const top = (part.index / total) * 100;
        const height = Math.max(2, (1 / total) * 100);
        html += '<div class="git-diff-overview-marker ' + part.type + '" style="top:' + top.toFixed(2) + '%;height:' + height.toFixed(2) + '%;"></div>';
      }
      html += '<div id="gitDiffOverviewViewport" class="git-diff-overview-viewport" style="top:0%;height:100%;"></div>';
      gitDiffOverview.innerHTML = html;
      updateGitDiffOverviewViewport();
    };
    const updateGitDiffOverviewViewport = () => {
      if (!gitDiffOverview || !gitDiffCompareEditor) return;
      const viewport = document.getElementById('gitDiffOverviewViewport');
      if (!viewport) return;
      const session = gitDiffCompareEditor.session;
      const total = session.getLength();
      if (total === 0) return;
      const scrollTop = session.getScrollTop();
      const lineHeight = gitDiffCompareEditor.renderer.lineHeight || 15;
      const visibleHeight = gitDiffCompareEditor.renderer.$size.height || 1;
      const totalHeight = total * lineHeight;
      const topPct = totalHeight > 0 ? Math.max(0, Math.min(100, (scrollTop / totalHeight) * 100)) : 0;
      const heightPct = totalHeight > 0 ? Math.max(2, Math.min(100, (visibleHeight / totalHeight) * 100)) : 100;
      viewport.style.top = topPct.toFixed(2) + '%';
      viewport.style.height = heightPct.toFixed(2) + '%';
    };

    const configureGitDiffEditor = (diffEditor) => {
      diffEditor.container.classList.add('ace_nobold');
      diffEditor.setTheme(colorSchemeQuery.matches ? 'ace/theme/github_dark' : 'ace/theme/github');
      diffEditor.session.setMode('ace/mode/${escapeHtml(language)}');
      diffEditor.setOptions({
        fontSize: '13px',
        fontFamily: editorFontFamily,
        wrap: lineWrapEnabled,
        showPrintMargin: false,
        readOnly: true,
        highlightActiveLine: true,
        highlightGutterLine: true,
      });
      diffEditor.session.setUseWrapMode(lineWrapEnabled);
      diffEditor.on('focus', () => { activeGitDiffEditor = diffEditor; });
    };
    const gitDiffGutterRenderer = {
      getWidth: (session, lastLineNumber, config) => {
        const maxLine = Math.max(1, ...gitDiffAlignedRows.map((r) => r.baseLine ?? r.compareLine ?? 0));
        return String(maxLine).length * config.characterWidth;
      },
      getText: (session, row) => {
        if (!gitDiffAlignedRows[row]) return '';
        const editor = session === gitDiffBaseEditor.session ? gitDiffBaseEditor : gitDiffCompareEditor;
        const lineNum = editor === gitDiffBaseEditor ? gitDiffAlignedRows[row].baseLine : gitDiffAlignedRows[row].compareLine;
        return lineNum !== null ? String(lineNum) : '';
      }
    };
    configureGitDiffEditor(gitDiffBaseEditor);
    configureGitDiffEditor(gitDiffCompareEditor);

    const syncGitDiffScroll = (sourceEditor, targetEditor) => {
      if (!diffVisible || isSyncingGitDiffScroll) return;
      isSyncingGitDiffScroll = true;
      targetEditor.session.setScrollTop(sourceEditor.session.getScrollTop());
      window.requestAnimationFrame(() => { isSyncingGitDiffScroll = false; });
    };
    gitDiffBaseEditor.session.on('changeScrollTop', () => syncGitDiffScroll(gitDiffBaseEditor, gitDiffCompareEditor));
    gitDiffCompareEditor.session.on('changeScrollTop', () => { syncGitDiffScroll(gitDiffCompareEditor, gitDiffBaseEditor); updateGitDiffOverviewViewport(); });
    if (gitDiffOverview) {
      gitDiffOverview.addEventListener('click', (event) => {
        const rect = gitDiffOverview.getBoundingClientRect();
        const pct = (event.clientY - rect.top) / rect.height;
        const session = gitDiffCompareEditor.session;
        const total = session.getLength();
        const lineHeight = gitDiffCompareEditor.renderer.lineHeight || 15;
        session.setScrollTop(pct * total * lineHeight - gitDiffCompareEditor.renderer.$size.height / 2);
      });
    }

    const updateGitDiffEditors = (data) => {
      const versions = data.versions || [];
      updateGitVersionOptions(versions, data.base, data.compare);
      const baseLabel = versions.find((version) => version.id === data.base)?.label || data.base;
      const compareLabel = versions.find((version) => version.id === data.compare)?.label || data.compare;
      const baseEditable = data.base === 'worktree';
      const compareEditable = data.compare === 'worktree';
      gitDiffBaseTitle.textContent = 'From: ' + baseLabel + (baseEditable ? ' (editable)' : '');
      gitDiffCompareTitle.textContent = 'To: ' + compareLabel + (compareEditable ? ' (editable)' : '');
      gitDiffBaseEditor.setReadOnly(!baseEditable);
      gitDiffCompareEditor.setReadOnly(!compareEditable);
      gitDiffBaseRawContent = data.baseContent || '';
      gitDiffCompareRawContent = data.compareContent || '';
      gitDiffBaseVersionId = data.base || '';
      gitDiffCompareVersionId = data.compare || '';
      gitDiffVersions = data.versions || [];
      const aligned = [];
      const rawBase = data.baseContent || '';
      const rawCompare = data.compareContent || '';
      const baseLines = rawBase === '' ? [] : rawBase.split('\\n');
      const compareLines = rawCompare === '' ? [] : rawCompare.split('\\n');
      if (baseLines.length > 1 && baseLines[baseLines.length - 1] === '' && rawBase.endsWith('\\n')) baseLines.pop();
      if (compareLines.length > 1 && compareLines[compareLines.length - 1] === '' && rawCompare.endsWith('\\n')) compareLines.pop();
      if (data.diff) {
        let oldCursor = 1;
        let newCursor = 1;
        for (const line of data.diff.split('\\n')) {
          if (line === '') continue;
          const hunk = line.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
          if (hunk) {
            const hunkOld = parseInt(hunk[1], 10);
            const hunkNew = parseInt(hunk[2], 10);
            while (oldCursor < hunkOld && newCursor < hunkNew) {
              aligned.push({ baseText: baseLines[oldCursor - 1] ?? '', compareText: compareLines[newCursor - 1] ?? '', baseLine: oldCursor, compareLine: newCursor, kind: 'context' });
              oldCursor += 1; newCursor += 1;
            }
            oldCursor = hunkOld; newCursor = hunkNew;
            continue;
          }
          if (line.startsWith('-') && !line.startsWith('---')) {
            aligned.push({ baseText: line.slice(1), compareText: '', baseLine: oldCursor, compareLine: null, kind: 'remove' });
            oldCursor += 1;
          } else if (line.startsWith('+') && !line.startsWith('+++')) {
            aligned.push({ baseText: '', compareText: line.slice(1), baseLine: null, compareLine: newCursor, kind: 'add' });
            newCursor += 1;
          } else if (line.startsWith(' ')) {
            aligned.push({ baseText: line.slice(1), compareText: line.slice(1), baseLine: oldCursor, compareLine: newCursor, kind: 'context' });
            oldCursor += 1; newCursor += 1;
          }
        }
        while (oldCursor <= baseLines.length || newCursor <= compareLines.length) {
          const hasOld = oldCursor <= baseLines.length;
          const hasNew = newCursor <= compareLines.length;
          if (hasOld && hasNew) {
            aligned.push({ baseText: baseLines[oldCursor - 1] ?? '', compareText: compareLines[newCursor - 1] ?? '', baseLine: oldCursor, compareLine: newCursor, kind: 'context' });
            oldCursor += 1; newCursor += 1;
          } else if (hasOld) {
            aligned.push({ baseText: baseLines[oldCursor - 1] ?? '', compareText: '', baseLine: oldCursor, compareLine: null, kind: 'remove' });
            oldCursor += 1;
          } else {
            aligned.push({ baseText: '', compareText: compareLines[newCursor - 1] ?? '', baseLine: null, compareLine: newCursor, kind: 'add' });
            newCursor += 1;
          }
        }
      } else if (data.baseContent) {
        const maxLines = Math.max(baseLines.length, compareLines.length);
        for (let i = 0; i < maxLines; i++) {
          aligned.push({ baseText: baseLines[i] ?? '', compareText: compareLines[i] ?? '', baseLine: i + 1, compareLine: i + 1, kind: 'context' });
        }
      }
      gitDiffBaseEditor.setValue(aligned.map((row) => row.baseText).join('\\n'), -1);
      gitDiffCompareEditor.setValue(aligned.map((row) => row.compareText).join('\\n'), -1);
      const Range = ace.require('ace/range').Range;
      for (const markerId of gitDiffBaseMarkers) gitDiffBaseEditor.session.removeMarker(markerId);
      for (const markerId of gitDiffCompareMarkers) gitDiffCompareEditor.session.removeMarker(markerId);
      gitDiffBaseMarkers = [];
      gitDiffCompareMarkers = [];
      gitDiffBaseEditor.session.clearBreakpoints();
      gitDiffCompareEditor.session.clearBreakpoints();
      aligned.forEach((row, index) => {
        if (row.kind === 'remove' || row.kind === 'change') {
          gitDiffBaseMarkers.push(gitDiffBaseEditor.session.addMarker(new Range(index, 0, index, 1), 'git-diff-removed-line', 'fullLine'));
          gitDiffBaseEditor.session.addGutterDecoration(index, 'git-diff-removed-gutter');
        }
        if (row.kind === 'add' || row.kind === 'change') {
          gitDiffCompareMarkers.push(gitDiffCompareEditor.session.addMarker(new Range(index, 0, index, 1), 'git-diff-added-line', 'fullLine'));
          gitDiffCompareEditor.session.addGutterDecoration(index, 'git-diff-added-gutter');
        }
        if (row.kind === 'add') {
          gitDiffBaseMarkers.push(gitDiffBaseEditor.session.addMarker(new Range(index, 0, index, 1), 'git-diff-empty-line', 'fullLine'));
          gitDiffBaseEditor.session.addGutterDecoration(index, 'git-diff-empty-gutter');
        }
        if (row.kind === 'remove') {
          gitDiffCompareMarkers.push(gitDiffCompareEditor.session.addMarker(new Range(index, 0, index, 1), 'git-diff-empty-line', 'fullLine'));
          gitDiffCompareEditor.session.addGutterDecoration(index, 'git-diff-empty-gutter');
        }
      });
      gitDiffBaseEditor.renderer.updateFull();
      gitDiffCompareEditor.renderer.updateFull();
      gitDiffBaseEditor.gotoLine(1, 0, false);
      gitDiffCompareEditor.gotoLine(1, 0, false);
      gitDiffAlignedRows = aligned;
      gitDiffBaseEditor.session.gutterRenderer = gitDiffGutterRenderer;
      gitDiffCompareEditor.session.gutterRenderer = gitDiffGutterRenderer;
      gitDiffBaseEditor.renderer.$gutterLayer.update = gitDiffBaseEditor.renderer.$gutterLayer.update;
      updateGitDiffOverview();
      gitDiffStatus.textContent = baseEditable || compareEditable
        ? 'The Unstaged version is editable. Save to refresh both versions and highlights.'
        : 'Changed lines are highlighted; select lines in either version, then use Copy ref';
      window.requestAnimationFrame(() => {
        gitDiffBaseEditor.resize();
        gitDiffCompareEditor.resize();
      });
    };

    const loadGitDiff = async () => {
      if (!gitDiffBase || !gitDiffCompare || !gitDiffStatus) return;
      gitDiffStatus.textContent = 'Loading Git versions…';
      try {
        const params = new URLSearchParams({ base: gitDiffBase.value || 'index', compare: gitDiffCompare.value || 'worktree' });
        const response = await fetch(gitDiffPath + '?' + params.toString(), { cache: 'no-store' });
        const responseText = await response.text();
        let payload;
        try {
          payload = JSON.parse(responseText);
        } catch {
          throw new Error('Git diff endpoint returned an invalid response. Restart CodexUI to load the latest server routes.');
        }
        if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'Could not load the Git versions.');
        updateGitDiffEditors(payload.data);
      } catch (error) {
        gitDiffStatus.textContent = error instanceof Error ? error.message : 'Could not load the Git versions.';
      }
    };

    const copyActiveGitDiffReference = async () => {
      if (!gitDiffAlignedRows || gitDiffAlignedRows.length === 0) {
        gitDiffStatus.textContent = 'No Git diff loaded yet';
        return;
      }
      const range = activeGitDiffEditor.getSelectionRange();
      const startRow = Math.min(range.start.row, range.end.row);
      let endRow = Math.max(range.start.row, range.end.row);
      if (!range.isEmpty() && range.end.row > range.start.row && range.end.column === 0) endRow -= 1;
      const isBase = activeGitDiffEditor === gitDiffBaseEditor;
      const editorRows = gitDiffAlignedRows.map((row) => isBase ? row.baseLine : row.compareLine);
      const findRealLine = (row) => {
        if (row < 0 || row >= editorRows.length) return null;
        if (editorRows[row] !== null && editorRows[row] !== undefined) return editorRows[row];
        for (let i = row; i >= 0; i--) { if (editorRows[i] !== null && editorRows[i] !== undefined) return editorRows[i]; }
        for (let i = row + 1; i < editorRows.length; i++) { if (editorRows[i] !== null && editorRows[i] !== undefined) return editorRows[i]; }
        return null;
      };
      const realStart = findRealLine(startRow);
      const realEnd = findRealLine(endRow);
      if (realStart === null || realEnd === null) {
        gitDiffStatus.textContent = 'Cannot copy reference for an empty (placeholder) line';
        return;
      }
      const firstLine = Math.min(realStart, realEnd);
      const lastLine = Math.max(realStart, realEnd);
      const versionId = isBase ? gitDiffBaseVersionId : gitDiffCompareVersionId;
      let suffix = '';
      if (versionId === 'index') suffix = ' (staged)';
      else if (versionId.startsWith('commit:')) {
        const ver = gitDiffVersions.find((v) => v.id === versionId);
        const shortHash = ver ? ver.label.split(' ')[0] : versionId.slice(7, 13);
        suffix = ' @ ' + shortHash;
      }
      const baseRef = createEditorReferenceText(editorReferencePath, firstLine, lastLine);
      const referenceText = baseRef + suffix;
      await writeTextToClipboard(referenceText);
      gitDiffStatus.textContent = 'Reference copied: ' + referenceText;
    };

    const activeGitDiffIsWorktree = () => {
      return activeGitDiffEditor === gitDiffBaseEditor
        ? gitDiffBase.value === 'worktree'
        : gitDiffCompare.value === 'worktree';
    };

    const saveActiveGitDiffEditor = async () => {
      if (!activeGitDiffIsWorktree()) {
        gitDiffStatus.textContent = 'Select the Unstaged (working tree) version to edit and save it';
        return false;
      }
      gitDiffStatus.textContent = 'Saving working tree…';
      try {
      const isBaseEditor = activeGitDiffEditor === gitDiffBaseEditor;
      const editorValue = activeGitDiffEditor.getValue();
      const editorLines = editorValue.split('\\n');
      const filteredLines = gitDiffAlignedRows
        .filter((row) => isBaseEditor ? row.baseLine !== null : row.compareLine !== null)
        .map((_, filteredIndex) => {
          let count = 0;
          for (let i = 0; i < gitDiffAlignedRows.length; i++) {
            const match = isBaseEditor ? gitDiffAlignedRows[i].baseLine !== null : gitDiffAlignedRows[i].compareLine !== null;
            if (match) { if (count === filteredIndex) return editorLines[i] ?? ''; count++; }
          }
          return '';
        });
      const rawContent = isBaseEditor ? gitDiffBaseRawContent : gitDiffCompareRawContent;
      const hasTrailingNewline = rawContent.length > 0 && rawContent.endsWith('\\n');
      const originalContent = filteredLines.join('\\n') + (hasTrailingNewline ? '\\n' : '');
      const response = await fetch(location.pathname, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: originalContent,
        });
        if (!response.ok) throw new Error('Save failed');
        editor.setValue(originalContent, -1);
        await loadGitDiff();
        gitDiffStatus.textContent = 'Saved working tree and refreshed Git diff';
        return true;
      } catch {
        gitDiffStatus.textContent = 'Save failed';
        return false;
      }
    };

    if (gitDiffBtn && gitDiffPanel && closeGitDiffBtn && gitDiffBase && gitDiffCompare) {
      gitDiffBtn.addEventListener('click', async () => {
        if (diffVisible) {
          setGitDiffVisible(false);
          return;
        }
        if (previewVisible) setPreviewVisible(false);
        setGitDiffVisible(true);
        await loadGitDiff();
        gitDiffCompareEditor.focus();
      });
      closeGitDiffBtn.addEventListener('click', () => {
        setGitDiffVisible(false);
        gitDiffBtn.focus();
      });
      gitDiffBase.addEventListener('change', () => { try { window.localStorage.setItem(gitDiffBaseStorageKey, gitDiffBase.value); } catch {} loadGitDiff(); });
      gitDiffCompare.addEventListener('change', () => { try { window.localStorage.setItem(gitDiffCompareStorageKey, gitDiffCompare.value); } catch {} loadGitDiff(); });
      copyGitDiffRefBtn.addEventListener('click', async () => {
        try {
          await copyActiveGitDiffReference();
        } catch {
          gitDiffStatus.textContent = 'Copy reference failed';
        }
      });
      // Restore diff state from localStorage
      try {
        if (window.localStorage.getItem(gitDiffVisibleStorageKey) === 'true') {
          if (previewVisible) setPreviewVisible(false);
          setGitDiffVisible(true);
          const savedBase = window.localStorage.getItem(gitDiffBaseStorageKey);
          const savedCompare = window.localStorage.getItem(gitDiffCompareStorageKey);
          loadGitDiff().then(() => {
            let needsReload = false;
            if (savedBase && gitDiffBase.value !== savedBase) { gitDiffBase.value = savedBase; needsReload = true; }
            if (savedCompare && gitDiffCompare.value !== savedCompare) { gitDiffCompare.value = savedCompare; needsReload = true; }
            if (needsReload) loadGitDiff();
          });
        }
      } catch {}
    }

    const saveEditorContent = async () => {
      if (diffVisible) {
        await saveActiveGitDiffEditor();
        return;
      }
      setStatus('Saving...');
      try {
        const response = await fetch(location.pathname, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: editor.getValue(),
        });
        setStatus(response.ok ? 'Saved' : 'Save failed');
      } catch {
        setStatus('Save failed');
      }
    };

    const isEditorSaveShortcut = (event) => {
      if (event.defaultPrevented) return false;
      if (!(event.ctrlKey || event.metaKey)) return false;
      if (event.altKey || event.shiftKey) return false;
      const key = String(event.key || '').toLowerCase();
      return key === 's' || event.code === 'KeyS';
    };

    window.addEventListener('keydown', (event) => {
      if (!isEditorSaveShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        saveEditorContent();
      }
    }, { capture: true });

    saveBtn.addEventListener('click', () => {
      saveEditorContent();
    });
  </script>
</body>
</html>`
}
