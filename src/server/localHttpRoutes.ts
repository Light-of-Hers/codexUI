import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import {
  LocalBrowseMutationError,
  createDirectoryListingHtml,
  createLocalBrowseEntry,
  createMarkdownPreviewHtml,
  createTextEditorHtml,
  decodeBrowsePath,
  deleteLocalBrowseEntry,
  getDirectoryItemList,
  getLocalDirectoryListing,
  isTextEditableFile,
  normalizeLocalPath,
  toEditHref,
} from './localBrowseUi.js'
import { LocalBrowseGitError, getLocalBrowseGitDiff } from './localBrowseGit.js'
import { getKatexAssetContentType, KATEX_ASSET_ROUTE, resolveKatexAssetPath } from './katexAssets.js'

const JSON_BODY_LIMIT_BYTES = 1024 * 1024
const TEXT_BODY_LIMIT_BYTES = 10 * 1024 * 1024

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

class RequestBodyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
}

function normalizeLocalImagePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (!trimmed.startsWith('file://')) return trimmed
  try {
    return decodeURIComponent(trimmed.replace(/^file:\/\//u, ''))
  } catch {
    return trimmed.replace(/^file:\/\//u, '')
  }
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

function readBrowsePath(pathname: string, routePrefix: string): string {
  return decodeBrowsePath(pathname.slice(routePrefix.length))
}

async function readRequestBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > limitBytes) {
      throw new RequestBodyError('Request body too large.', 413)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

async function readJsonRequestBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readRequestBody(req, JSON_BODY_LIMIT_BYTES)).trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new RequestBodyError('Invalid JSON body.', 400)
  }
}

function streamFile(
  res: ServerResponse,
  filePath: string,
  notFoundMessage: string,
  contentType = '',
): void {
  res.statusCode = 200
  if (contentType) res.setHeader('Content-Type', contentType)
  const stream = createReadStream(filePath)
  const closeStream = () => stream.destroy()
  res.once('close', closeStream)
  stream.once('close', () => res.off('close', closeStream))
  stream.on('error', (error) => {
    if (!res.headersSent) {
      sendJson(res, 404, { error: notFoundMessage })
      return
    }
    res.destroy(error)
  })
  stream.pipe(res)
}

export type LocalHttpRouteMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void

export function createLocalHttpRouteMiddleware(): LocalHttpRouteMiddleware {
  return (req, res, next) => {
    void handleLocalHttpRoute(req, res).then((handled) => {
      if (!handled) next()
    }).catch((error: unknown) => {
      if (res.headersSent) return
      const bodyError = error instanceof RequestBodyError ? error : null
      sendJson(res, bodyError?.statusCode ?? 500, { error: bodyError?.message ?? 'Local route failed.' })
    })
  }
}

async function handleLocalHttpRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!req.url) return false
  const method = req.method ?? 'GET'
  const url = new URL(req.url, 'http://localhost')

  if (isReadMethod(method) && url.pathname === '/codex-local-image') {
    const localPath = normalizeLocalImagePath(url.searchParams.get('path') ?? '')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    const contentType = IMAGE_CONTENT_TYPES[extname(localPath).toLowerCase()]
    if (!contentType) {
      sendJson(res, 415, { error: 'Unsupported image type.' })
      return true
    }
    res.setHeader('Cache-Control', 'private, max-age=300')
    streamFile(res, localPath, 'Image file not found.', contentType)
    return true
  }

  if (isReadMethod(method) && url.pathname.startsWith(`${KATEX_ASSET_ROUTE}/`)) {
    const assetPath = resolveKatexAssetPath(url.pathname.slice(KATEX_ASSET_ROUTE.length))
    if (!assetPath) {
      sendJson(res, 404, { error: 'KaTeX asset not found.' })
      return true
    }
    res.setHeader('Cache-Control', 'private, max-age=86400')
    streamFile(res, assetPath, 'KaTeX asset not found.', getKatexAssetContentType(assetPath))
    return true
  }

  if (isReadMethod(method) && url.pathname === '/codex-local-file') {
    const localPath = normalizeLocalPath(url.searchParams.get('path') ?? '')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', `inline; filename="${basename(localPath)}"`)
    streamFile(res, localPath, 'File not found.')
    return true
  }

  if (isReadMethod(method) && (url.pathname === '/codex-local-directories' || url.pathname === '/codex-local-entries')) {
    const localPath = normalizeLocalPath(url.searchParams.get('path') ?? '')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local directory path.' })
      return true
    }
    try {
      const fileStat = await stat(localPath)
      if (!fileStat.isDirectory()) {
        sendJson(res, 400, { error: 'Expected directory path.' })
        return true
      }
      const showHidden = ['1', 'true', 'yes', 'on'].includes((url.searchParams.get('showHidden') ?? '').toLowerCase())
      if (url.pathname === '/codex-local-directories') {
        sendJson(res, 200, { data: await getLocalDirectoryListing(localPath, { showHidden }) })
      } else {
        const entries = await getDirectoryItemList(localPath, { showHidden })
        sendJson(res, 200, { data: { path: localPath, parentPath: dirname(localPath), entries } })
      }
    } catch {
      sendJson(res, 404, { error: 'Directory not found.' })
    }
    return true
  }

  if (isReadMethod(method) && url.pathname.startsWith('/codex-local-git-diff/')) {
    const localPath = readBrowsePath(url.pathname, '/codex-local-git-diff')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    try {
      const data = await getLocalBrowseGitDiff(
        localPath,
        url.searchParams.get('base') ?? 'index',
        url.searchParams.get('compare') ?? 'worktree',
      )
      sendJson(res, 200, { data })
    } catch (error) {
      const gitError = error instanceof LocalBrowseGitError ? error : null
      sendJson(res, gitError?.statusCode ?? 500, { error: gitError?.message ?? 'Could not load the Git file diff.' })
    }
    return true
  }

  if ((method === 'POST' || method === 'DELETE') && url.pathname.startsWith('/codex-local-browse/')) {
    const localPath = readBrowsePath(url.pathname, '/codex-local-browse')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local path.' })
      return true
    }
    try {
      if (method === 'DELETE') {
        await deleteLocalBrowseEntry(localPath)
        sendJson(res, 200, { ok: true })
        return true
      }
      const payload = await readJsonRequestBody(req)
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
      const name = typeof record?.name === 'string' ? record.name : ''
      const type = record?.type === 'directory' ? 'directory' : 'file'
      const createdPath = await createLocalBrowseEntry(localPath, name, type)
      sendJson(res, 201, { data: { path: createdPath } })
    } catch (error) {
      if (error instanceof RequestBodyError) throw error
      const mutationError = error instanceof LocalBrowseMutationError ? error : null
      const fallbackMessage = method === 'POST' ? 'Create failed.' : 'Delete failed.'
      sendJson(res, mutationError?.statusCode ?? 500, { error: mutationError?.message ?? fallbackMessage })
    }
    return true
  }

  if (isReadMethod(method) && url.pathname.startsWith('/codex-local-browse/')) {
    const localPath = readBrowsePath(url.pathname, '/codex-local-browse')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    try {
      const fileStat = await stat(localPath)
      res.setHeader('Cache-Control', 'private, no-store')
      if (fileStat.isDirectory()) {
        sendHtml(res, await createDirectoryListingHtml(localPath, {
          newProjectName: url.searchParams.get('newProjectName') ?? '',
        }))
        return true
      }
      const rawMode = url.searchParams.get('raw') === '1' || url.searchParams.get('raw') === 'true'
      if (!rawMode && await isTextEditableFile(localPath)) {
        res.statusCode = 302
        res.setHeader('Location', toEditHref(
          localPath,
          url.searchParams.get('newProjectName') ?? '',
          url.searchParams.get('line') ?? '',
        ))
        res.end()
        return true
      }
      streamFile(res, localPath, 'File not found.')
    } catch {
      sendJson(res, 404, { error: 'File not found.' })
    }
    return true
  }

  if (isReadMethod(method) && url.pathname.startsWith('/codex-local-edit/')) {
    const localPath = readBrowsePath(url.pathname, '/codex-local-edit')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    try {
      const fileStat = await stat(localPath)
      if (!fileStat.isFile()) {
        sendJson(res, 400, { error: 'Expected file path.' })
        return true
      }
      sendHtml(res, await createTextEditorHtml(localPath))
    } catch {
      sendJson(res, 404, { error: 'File not found.' })
    }
    return true
  }

  if (method === 'POST' && url.pathname.startsWith('/codex-local-preview/')) {
    const localPath = readBrowsePath(url.pathname, '/codex-local-preview')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    try {
      const fileStat = await stat(localPath)
      if (!fileStat.isFile()) {
        sendJson(res, 400, { error: 'Expected file path.' })
        return true
      }
      sendHtml(res, createMarkdownPreviewHtml(localPath, await readRequestBody(req, TEXT_BODY_LIMIT_BYTES)))
    } catch (error) {
      if (error instanceof RequestBodyError) throw error
      sendJson(res, 404, { error: 'File not found.' })
    }
    return true
  }

  if (method === 'PUT' && url.pathname.startsWith('/codex-local-edit/')) {
    const localPath = readBrowsePath(url.pathname, '/codex-local-edit')
    if (!localPath || !isAbsolute(localPath)) {
      sendJson(res, 400, { error: 'Expected absolute local file path.' })
      return true
    }
    if (!(await isTextEditableFile(localPath))) {
      sendJson(res, 415, { error: 'Only text-like files are editable.' })
      return true
    }
    try {
      await writeFile(localPath, await readRequestBody(req, TEXT_BODY_LIMIT_BYTES), 'utf8')
      sendJson(res, 200, { ok: true })
    } catch (error) {
      if (error instanceof RequestBodyError) throw error
      sendJson(res, 404, { error: 'File not found.' })
    }
    return true
  }

  return false
}
