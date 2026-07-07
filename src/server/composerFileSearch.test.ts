import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { scoreComposerPathCandidate, searchComposerPaths } from './composerFileSearch'

let tempDir = ''

afterEach(async () => {
  if (!tempDir) return
  await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('searchComposerPaths', () => {
  it('lists top-level directories and symlinks for empty queries', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))

    const realDir = join(tempDir, 'real')
    const nestedDir = join(realDir, 'nested')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(realDir, 'alpha.txt'), 'alpha')
    await writeFile(join(nestedDir, 'beta.txt'), 'beta')
    await symlink(join(realDir, 'alpha.txt'), join(tempDir, 'file-link.txt'))
    await symlink(nestedDir, join(tempDir, 'dir-link'))

    const results = await searchComposerPaths(tempDir, '', 20)
    const byPath = new Map(results.map((entry) => [entry.path, entry]))

    expect(byPath.get('real')?.kind).toBe('directory')
    expect(byPath.get('real')?.isSymlink).toBe(false)
    expect(byPath.get('file-link.txt')?.kind).toBe('file')
    expect(byPath.get('file-link.txt')?.isSymlink).toBe(true)
    expect(byPath.get('dir-link')?.kind).toBe('directory')
    expect(byPath.get('dir-link')?.isSymlink).toBe(true)
    expect(byPath.has('real/alpha.txt')).toBe(false)
    expect(byPath.has('real/nested')).toBe(false)
  })

  it('keeps partial results when ripgrep reports a symlink loop', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))

    await writeFile(join(tempDir, 'alpha.txt'), 'alpha')
    await symlink(tempDir, join(tempDir, 'loop'))

    const results = await searchComposerPaths(tempDir, 'alpha', 20)

    expect(results.some((entry) => entry.path === 'alpha.txt')).toBe(true)
  })

  it('supports fuzzy matching for misspelled file names', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))

    await writeFile(join(tempDir, 'install-configs.py'), 'print("ok")')
    await writeFile(join(tempDir, 'other-file.txt'), 'other')

    const results = await searchComposerPaths(tempDir, 'instalconf', 20)

    expect(results[0]?.path).toBe('install-configs.py')
    expect(results.some((entry) => entry.path === 'install-configs.py')).toBe(true)
  })

  it('returns top-level prefix matches without waiting for deep duplicate paths', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))

    await mkdir(join(tempDir, 'notes'), { recursive: true })
    await writeFile(join(tempDir, 'notes', 'README.md'), 'notes')
    await mkdir(join(tempDir, 'files', 'cache', 'triton', 'docs', 'meetups'), { recursive: true })
    await writeFile(join(tempDir, 'files', 'cache', 'triton', 'docs', 'meetups', 'notes.md'), 'deep')

    const results = await searchComposerPaths(tempDir, 'notes', 20)

    expect(results[0]?.path).toBe('notes')
    expect(results.some((entry) => entry.path === 'files/cache/triton/docs/meetups/notes.md')).toBe(false)
  })

  it('returns exact absolute path queries without treating them as cwd-relative text', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))
    const targetDir = join(tempDir, 'absolute-target')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'README.md'), 'target')

    const results = await searchComposerPaths(tempDir, targetDir, 20)

    expect(results[0]).toMatchObject({
      path: targetDir,
      kind: 'directory',
      isSymlink: false,
    })
  })

  it('completes partial absolute path queries from the nearest existing parent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))
    const targetDir = join(tempDir, 'absolute-target')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'README.md'), 'target')

    const results = await searchComposerPaths(tempDir, join(tempDir, 'absolute-targ'), 20)

    expect(results[0]).toMatchObject({
      path: targetDir,
      kind: 'directory',
      isSymlink: false,
    })
  })

  it('expands home-prefixed path queries before searching', async () => {
    const home = homedir().replace(/[\\/]+$/u, '')
    tempDir = await mkdtemp(join(home, 'codexui-composer-home-'))
    const targetDir = join(tempDir, 'home-target')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'README.md'), 'target')
    const homeQuery = `~/${targetDir.slice(home.length + 1)}`

    const results = await searchComposerPaths(tempDir, homeQuery, 20)

    expect(results[0]).toMatchObject({
      path: targetDir,
      kind: 'directory',
      isSymlink: false,
    })
  })

  it('prefers simpler paths when matches have the same quality', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))

    await mkdir(join(tempDir, 'SeedKernelBench'), { recursive: true })
    await writeFile(join(tempDir, 'SeedKernelBench', 'README.md'), 'root')
    await mkdir(join(tempDir, '.worktrees', 'op_134_153', 'SeedKernelBench'), { recursive: true })
    await writeFile(join(tempDir, '.worktrees', 'op_134_153', 'SeedKernelBench', 'README.md'), 'worktree')
    await mkdir(join(tempDir, '_workspace.tmp', 'deep', '3rdparty', 'SeedKernelBench'), { recursive: true })
    await writeFile(join(tempDir, '_workspace.tmp', 'deep', '3rdparty', 'SeedKernelBench', 'README.md'), 'workspace')

    const results = await searchComposerPaths(tempDir, 'KernelBench', 20)

    expect(results[0]?.path).toBe('SeedKernelBench')
    expect(results.findIndex((entry) => entry.path === 'SeedKernelBench')).toBeLessThan(
      results.findIndex((entry) => entry.path === '.worktrees/op_134_153/SeedKernelBench'),
    )
    expect(results.findIndex((entry) => entry.path === 'SeedKernelBench')).toBeLessThan(
      results.findIndex((entry) => entry.path === '_workspace.tmp/deep/3rdparty/SeedKernelBench'),
    )
  })

  it('prefers fzf-style basename acronym matches over path-spanning matches', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-composer-search-'))

    await writeFile(join(tempDir, 'ThreadComposer.vue'), 'component')
    await mkdir(join(tempDir, 'tests'), { recursive: true })
    await writeFile(join(tempDir, 'tests', 'cache.txt'), 'cache')

    const results = await searchComposerPaths(tempDir, 'tc', 20)

    expect(results[0]?.path).toBe('ThreadComposer.vue')
    expect(results.findIndex((entry) => entry.path === 'ThreadComposer.vue')).toBeLessThan(
      results.findIndex((entry) => entry.path === 'tests/cache.txt'),
    )
  })
})

describe('scoreComposerPathCandidate', () => {
  it('rewards compact word-boundary acronym matches like fzf', () => {
    expect(scoreComposerPathCandidate('ThreadComposer.vue', 'tc')).toBeLessThan(
      scoreComposerPathCandidate('tests/cache.txt', 'tc'),
    )
    expect(scoreComposerPathCandidate('SeedKernelBench', 'skb')).toBeLessThan(
      scoreComposerPathCandidate('sidekick-bootstrap.txt', 'skb'),
    )
  })
})
