import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from './httpServer'

let tempDir = ''
let httpServer: HttpServer | null = null
let serverInstance: ReturnType<typeof createServer> | null = null

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer?.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    httpServer = null
  }

  if (serverInstance) {
    serverInstance.dispose()
    serverInstance = null
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

async function startServer(): Promise<string> {
  serverInstance = createServer()
  httpServer = serverInstance.app.listen(0)
  await new Promise<void>((resolve, reject) => {
    httpServer?.once('listening', () => resolve())
    httpServer?.once('error', reject)
  })

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral port.')
  }

  return `http://127.0.0.1:${String(address.port)}`
}

describe('local browse redirect behavior', () => {
  it('redirects editable files to the local editor from browse URLs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-'))
    const filePath = join(tempDir, 'note.txt')
    await writeFile(filePath, 'hello world\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(filePath)}`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/codex-local-edit${encodeURI(filePath)}`)
  })

  it('preserves line ranges when redirecting editable browse URLs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-lines-'))
    const filePath = join(tempDir, 'note.txt')
    await writeFile(filePath, 'hello world\nnext line\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(filePath)}?line=2-3`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/codex-local-edit${encodeURI(filePath)}?line=2-3`)
  })

  it('serves editable files as raw content when requested', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-raw-'))
    const filePath = join(tempDir, 'note.txt')
    await writeFile(filePath, 'hello raw\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(filePath)}?raw=1`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toBe('hello raw\n')
  })

  it('serves PDF browse URLs through the local PDF wrapper', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-pdf-wrapper-'))
    const filePath = join(tempDir, 'paper.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.7\n% test\n', 'utf8'))

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(filePath)}`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('id="viewerContainer"')
    expect(html).toContain('id="viewer" class="pdfViewer"')
    expect(html).toContain('Ctrl+S / Cmd+S')
    expect(html).toContain('Use Text or Ink to annotate')
    expect(html).toContain(`/codex-local-browse${encodeURI(filePath)}?raw=1`)
    expect(html).toContain(`/codex-local-pdf${encodeURI(filePath)}`)
    expect(html).toContain('/codex-local-pdfjs/build/pdf.js')
  })

  it('serves PDF files as raw content when requested', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-pdf-raw-'))
    const filePath = join(tempDir, 'paper.pdf')
    const bytes = Buffer.from('%PDF-1.7\n% raw\n', 'utf8')
    await writeFile(filePath, bytes)

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(filePath)}?raw=1`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
  })
})

describe('local PDF.js assets', () => {
  it('serves PDF.js viewer assets from the local package', async () => {
    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-pdfjs/web/pdf_viewer.css`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/css')
    expect(await response.text()).toContain('.pdfViewer')
  })

  it('rejects unsupported PDF.js asset paths', async () => {
    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-pdfjs/package.json`)

    expect(response.status).toBe(404)
  })
})

describe('local browse file mutations', () => {
  it('creates a new file from a directory browse POST', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-create-'))
    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(tempDir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'draft.md' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { path: join(tempDir, 'draft.md') } })
    expect(existsSync(join(tempDir, 'draft.md'))).toBe(true)
  })

  it('creates a new directory from a directory browse POST', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-create-dir-'))
    const dirPath = join(tempDir, 'docs')
    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(tempDir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'docs', type: 'directory' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { path: dirPath } })

    const dirStat = await stat(dirPath)
    expect(dirStat.isDirectory()).toBe(true)
    expect(dirStat.isFile()).toBe(false)
  })

  it('deletes files from browse URLs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-delete-'))
    const filePath = join(tempDir, 'note.txt')
    await writeFile(filePath, 'hello world\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(filePath)}`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(existsSync(filePath)).toBe(false)
  })

  it('deletes directories from browse URLs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-delete-dir-'))
    const dirPath = join(tempDir, 'docs')
    await mkdir(dirPath)
    await writeFile(join(dirPath, 'note.txt'), 'hello world\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(dirPath)}`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(existsSync(dirPath)).toBe(false)
  })
})

describe('local PDF saves', () => {
  it('writes PDF bytes back to the target local file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-pdf-save-'))
    const filePath = join(tempDir, 'paper.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.7\n% old\n', 'utf8'))
    const nextBytes = Buffer.from('%PDF-1.7\n% saved\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-pdf${encodeURI(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: nextBytes,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect((await readFile(filePath)).equals(nextBytes)).toBe(true)
  })

  it('rejects non-PDF local paths for PDF writes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-pdf-save-reject-'))
    const filePath = join(tempDir, 'note.txt')
    await writeFile(filePath, 'hello\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-pdf${encodeURI(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-1.7\n% saved\n', 'utf8'),
    })

    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'Only PDF files are writable through this endpoint.' })
    expect(await readFile(filePath, 'utf8')).toBe('hello\n')
  })

  it('rejects non-PDF content for PDF writes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-pdf-save-content-reject-'))
    const filePath = join(tempDir, 'paper.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.7\n% old\n', 'utf8'))

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-pdf${encodeURI(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('not a pdf\n', 'utf8'),
    })

    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'Expected PDF content.' })
    expect(await readFile(filePath, 'utf8')).toBe('%PDF-1.7\n% old\n')
  })
})
