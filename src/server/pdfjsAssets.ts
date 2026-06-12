import { createRequire } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)

export const PDFJS_ASSET_ROUTE = '/codex-local-pdfjs'
export const PDFJS_BUILD_HREF = `${PDFJS_ASSET_ROUTE}/build/pdf.js`
export const PDFJS_VIEWER_HREF = `${PDFJS_ASSET_ROUTE}/web/pdf_viewer.js`
export const PDFJS_VIEWER_STYLESHEET_HREF = `${PDFJS_ASSET_ROUTE}/web/pdf_viewer.css`
export const PDFJS_WORKER_HREF = `${PDFJS_ASSET_ROUTE}/build/pdf.worker.js`
export const PDFJS_CMAPS_HREF = `${PDFJS_ASSET_ROUTE}/cmaps/`
export const PDFJS_STANDARD_FONTS_HREF = `${PDFJS_ASSET_ROUTE}/standard_fonts/`
export const PDFJS_IMAGE_RESOURCES_HREF = `${PDFJS_ASSET_ROUTE}/web/images/`

const pdfjsPackagePath = require.resolve('pdfjs-dist/package.json')
export const PDFJS_PACKAGE_DIR = resolve(dirname(pdfjsPackagePath))

const PDFJS_PACKAGE_ROOT = `${PDFJS_PACKAGE_DIR}${sep}`
const ALLOWED_TOP_LEVEL_DIRS = new Set(['build', 'web', 'cmaps', 'standard_fonts'])

export function resolvePdfjsAssetPath(requestPath: string): string | null {
  const rawPath = requestPath.replace(/^\/+/u, '')
  let decodedPath = ''
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (!decodedPath || decodedPath.includes('\0')) return null
  if (decodedPath.split(/[\\/]/u).some((segment) => segment === '..')) return null

  const [topLevel] = decodedPath.split(/[\\/]/u)
  if (!ALLOWED_TOP_LEVEL_DIRS.has(topLevel)) return null

  const resolvedPath = resolve(PDFJS_PACKAGE_DIR, decodedPath)
  if (resolvedPath !== PDFJS_PACKAGE_DIR && !resolvedPath.startsWith(PDFJS_PACKAGE_ROOT)) {
    return null
  }
  return resolvedPath
}

export function getPdfjsAssetContentType(assetPath: string): string {
  switch (extname(assetPath).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.map': return 'application/json; charset=utf-8'
    case '.bcmap': return 'application/octet-stream'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.pfb': return 'application/octet-stream'
    case '.ttf': return 'font/ttf'
    default: return 'application/octet-stream'
  }
}
