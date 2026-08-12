import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from './httpServer'

const execFile = promisify(execFileCallback)

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

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  await execFile('git', args, { cwd })
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

  it('rejects create payloads larger than the shared JSON limit', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-create-limit-'))
    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-browse${encodeURI(tempDir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(1024 * 1024) }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Request body too large.' })
  })
})

describe('local editor and preview', () => {
  it('uses the same text route contract for preview and save', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-edit-'))
    const filePath = join(tempDir, 'note.md')
    await writeFile(filePath, '# Old\n', 'utf8')
    const baseUrl = await startServer()

    const previewResponse = await fetch(`${baseUrl}/codex-local-preview${encodeURI(filePath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '# Preview',
    })
    expect(previewResponse.status).toBe(200)
    expect(await previewResponse.text()).toContain('Preview')

    const saveResponse = await fetch(`${baseUrl}/codex-local-edit${encodeURI(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '# Saved\n',
    })
    expect(saveResponse.status).toBe(200)
    expect(await saveResponse.json()).toEqual({ ok: true })
  })
})

describe('local browse Git file diff', () => {
  it('compares staged, unstaged, and commit versions of a file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-git-diff-'))
    const filePath = join(tempDir, 'note.txt')
    await runGit(tempDir, 'init')
    await runGit(tempDir, 'config', 'user.email', 'test@example.com')
    await runGit(tempDir, 'config', 'user.name', 'Test User')
    await writeFile(filePath, 'first version\n', 'utf8')
    await runGit(tempDir, 'add', 'note.txt')
    await runGit(tempDir, 'commit', '-m', 'add note')
    await writeFile(filePath, 'staged version\n', 'utf8')
    await runGit(tempDir, 'add', 'note.txt')
    await writeFile(filePath, 'unstaged version\n', 'utf8')

    const baseUrl = await startServer()
    const stagedResponse = await fetch(`${baseUrl}/codex-local-git-diff${encodeURI(filePath)}?base=index&compare=worktree`)
    expect(stagedResponse.status).toBe(200)
    const stagedPayload = await stagedResponse.json() as { data: { baseContent: string; compareContent: string; diff: string; rows: Array<{ kind: string; oldLine: number | null; newLine: number | null; oldText: string; newText: string }>; versions: Array<{ id: string }> } }
    expect(stagedPayload.data.diff).toContain('-staged version')
    expect(stagedPayload.data.diff).toContain('+unstaged version')
    expect(stagedPayload.data.baseContent).toBe('staged version\n')
    expect(stagedPayload.data.compareContent).toBe('unstaged version\n')
    expect(stagedPayload.data.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'change', oldLine: 1, newLine: 1, oldText: 'staged version', newText: 'unstaged version' }),
    ]))
    expect(stagedPayload.data.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'worktree' }),
      expect.objectContaining({ id: 'index' }),
    ]))
    const commitVersion = stagedPayload.data.versions.find((version) => version.id.startsWith('commit:'))
    expect(commitVersion).toBeDefined()

    const historyResponse = await fetch(`${baseUrl}/codex-local-git-diff${encodeURI(filePath)}?base=${encodeURIComponent(commitVersion?.id ?? '')}&compare=index`)
    expect(historyResponse.status).toBe(200)
    const historyPayload = await historyResponse.json() as { data: { diff: string } }
    expect(historyPayload.data.diff).toContain('-first version')
    expect(historyPayload.data.diff).toContain('+staged version')
  })

  it('rejects Git diffs outside a repository', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-http-server-no-git-diff-'))
    const filePath = join(tempDir, 'note.txt')
    await writeFile(filePath, 'plain text\n', 'utf8')

    const baseUrl = await startServer()
    const response = await fetch(`${baseUrl}/codex-local-git-diff${encodeURI(filePath)}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'This file is not inside a Git repository.' })
  })
})
