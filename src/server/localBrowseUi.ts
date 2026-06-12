import { basename, dirname, extname, join } from 'node:path'
import { open, readFile, readdir, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { renderMarkdownContent } from '../components/content/markdownRenderer.js'
import { KATEX_STYLESHEET_HREF } from './katexAssets.js'
import { getEditorModeForPath } from '../utils/codeLanguage.js'

type DirectoryItem = {
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
      return `<li class="file-row"><a class="file-link" href="${escapeHtml(toBrowseHref(item.path, newProjectName))}">${escapeHtml(item.name)}${suffix}</a><span class="row-actions">${rawAction}${deleteAction}</span></li>`
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
    .file-row { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; }
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
      padding: 0.45rem 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .message-code-pre {
      margin: 0;
      overflow-x: auto;
      padding: 0.8rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre;
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

function markdownPreviewScript(localPath: string): string {
  const safePathLiteral = escapeForInlineScriptString(localPath)
  return `
    (() => {
      const sourcePath = ${safePathLiteral};
      const interactiveSelector = 'a[href], button, input, textarea, select, label, summary';
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
    })();
  `
}

export function createMarkdownPreviewHtml(localPath: string, markdown: string): string {
  const rendered = renderMarkdownContent(markdown, {
    cwd: dirname(localPath),
    kind: 'message',
    highlightVersion: 0,
  }).html
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
  const supportsMarkdownPreview = isMarkdownPath(localPath)
  const escapedEditorPath = escapeForInlineScriptString(localPath)
  const copyReferenceButton = `<button id="copyRefBtn" type="button">Copy ref</button>`
  const previewButton = supportsMarkdownPreview
    ? '<button id="previewBtn" type="button" aria-pressed="false">Preview</button>'
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
    .toolbar { position: sticky; top: 0; z-index: 10; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--toolbar-bg); border-bottom: 1px solid var(--toolbar-border); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button, a { background: var(--control-bg); color: var(--control-fg); border: 1px solid var(--control-border); padding: 6px 10px; border-radius: 6px; text-decoration: none; cursor: pointer; }
    button:hover, a:hover { filter: brightness(1.08); }
    button:disabled { opacity: 0.65; cursor: default; }
    button[aria-pressed="true"] { border-color: var(--status-fg); color: var(--status-fg); }
    .editor-shell { --preview-editor-ratio: 0.48; flex: 1 1 auto; min-height: 0; width: 100%; display: flex; align-items: stretch; overflow: hidden; }
    #editor { flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%; border: none; overflow: hidden; }
    .editor-shell[data-preview="true"] #editor {
      flex: 0 0 calc(var(--preview-editor-ratio) * 100%);
      width: calc(var(--preview-editor-ratio) * 100%);
    }
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
    .editor-shell[data-preview="false"] .preview-splitter { display: none; }
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
      .editor-shell[data-preview="true"] .preview-splitter::before {
        top: 50%;
        bottom: auto;
        left: 0;
        width: 100%;
        height: 1px;
        transform: translateY(-50%);
      }
      .preview-pane { width: 100%; min-width: 0; min-height: 240px; border-left: 0; border-top: 1px solid var(--toolbar-border); }
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
      ${previewButton}
      <span id="status"></span>
      <span id="previewStatus"></span>
    </div>
    <div class="meta">${escapeHtml(localPath)} · ${escapeHtml(language)}</div>
  </div>
  <div id="editorShell" class="editor-shell" data-preview="false">
    <div id="editor"></div>
    ${previewPane}
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.36.2/ace.js"></script>
  <script>
    const saveBtn = document.getElementById('saveBtn');
    const copyRefBtn = document.getElementById('copyRefBtn');
    const previewBtn = document.getElementById('previewBtn');
    const status = document.getElementById('status');
    const previewStatus = document.getElementById('previewStatus');
    const editorShell = document.getElementById('editorShell');
    const previewSplitter = document.getElementById('previewSplitter');
    const previewFrame = document.getElementById('previewFrame');
    const supportsMarkdownPreview = ${supportsMarkdownPreview ? 'true' : 'false'};
    const editorReferencePath = ${escapedEditorPath};
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
    editor.resize();

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
    let lastEditorSyncedLine = 0;
    let lastPreviewSyncedLine = 0;
    const previewScrollAnchorSelector = '.message-scroll-anchor[data-source-line]';
    let previewScrollSyncSuppressedUntil = 0;
    const previewSplitStorageKeyHorizontal = 'codex.localBrowse.previewEditorRatio.horizontal.v1';
    const previewSplitStorageKeyVertical = 'codex.localBrowse.previewEditorRatio.vertical.v1';
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
      if (!supportsMarkdownPreview || !previewVisible || !editorShell || !previewSplitter || !primaryPointer) return;
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

    const handlePreviewJumpMessage = (event) => {
      if (!supportsMarkdownPreview || !previewFrame || event.source !== previewFrame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
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

    window.addEventListener('message', handlePreviewJumpMessage);

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

    const setPreviewVisible = (visible) => {
      if (!supportsMarkdownPreview || !previewBtn || !editorShell || !previewFrame) return;
      previewVisible = visible;
      editorShell.dataset.preview = visible ? 'true' : 'false';
      previewFrame.hidden = !visible;
      if (previewSplitter) {
        previewSplitter.hidden = !visible;
      }
      previewBtn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      previewBtn.textContent = visible ? 'Hide Preview' : 'Preview';
      if (visible) {
        pendingPreviewEditorSync = true;
        syncPreviewEditorRatio(false);
      } else {
        previewLoadToken += 1;
        stopPreviewDrag();
        detachPreviewScrollSync();
        cancelPreviewScrollSyncFrames();
        pendingPreviewEditorSync = false;
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
        schedulePreview();
      });
      editor.session.on('changeScrollTop', () => {
        if (!supportsMarkdownPreview || !previewVisible || isApplyingEditorScrollFromPreview) return;
        schedulePreviewScrollSyncFromEditor();
      });
    }

    if (previewSplitter) {
      previewSplitter.addEventListener('pointerdown', startPreviewDrag);
      previewSplitter.addEventListener('dblclick', () => {
        if (!supportsMarkdownPreview || !previewVisible) return;
        applyPreviewEditorRatio(defaultPreviewEditorRatio, true);
      });
      previewSplitter.addEventListener('keydown', (event) => {
        if (!supportsMarkdownPreview || !previewVisible) return;
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
      if (!supportsMarkdownPreview || !previewVisible) return;
      syncPreviewEditorRatio(false);
    });

    if (copyRefBtn) {
      copyRefBtn.addEventListener('click', async () => {
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

    const saveEditorContent = async () => {
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
