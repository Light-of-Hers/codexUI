import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import {
  buildFileBrowseHref,
  buildLinkTree,
  collectDirPaths,
  extractThreadLinks,
  flattenLinkTree,
  isFilePathLike,
  resolveRelativePath,
} from './threadLinks'

function userMessage(text: string, id = 'u1'): UiMessage {
  return { id, role: 'user', text }
}

function assistantMessage(text: string, id = 'a1'): UiMessage {
  return { id, role: 'assistant', text }
}

describe('threadLinks extractor', () => {
  it('extracts bare web urls from user and assistant messages', () => {
    const links = extractThreadLinks([
      userMessage('see https://example.com/path here'),
      assistantMessage('docs at http://docs.example.com/page'),
    ])
    expect(links.map((l) => l.value)).toEqual([
      'https://example.com/path',
      'http://docs.example.com/page',
    ])
    expect(links.every((l) => l.kind === 'web')).toBe(true)
    expect(links[0].role).toBe('user')
    expect(links[1].role).toBe('assistant')
  })

  it('trims trailing punctuation from urls', () => {
    const links = extractThreadLinks([
      userMessage('open https://example.com/path, then check http://foo.io/x.'),
    ])
    expect(links.map((l) => l.value)).toEqual(['https://example.com/path', 'http://foo.io/x'])
  })

  it('extracts markdown link targets', () => {
    const links = extractThreadLinks([
      assistantMessage('see [docs](https://example.com/docs) and [file](src/app.ts)'),
    ], '/root/proj')
    expect(links.map((l) => l.value)).toEqual(['https://example.com/docs', 'src/app.ts'])
    expect(links[1].kind).toBe('file')
    expect(links[1].href).toBe('/codex-local-browse/root/proj/src/app.ts')
  })

  it('extracts absolute unix paths and windows paths', () => {
    const links = extractThreadLinks([
      userMessage('edit /root/work/repo/src/index.ts and C:\\Users\\me\\file.txt'),
    ])
    expect(links.map((l) => l.value)).toEqual(['/root/work/repo/src/index.ts', 'C:\\Users\\me\\file.txt'])
    expect(links.every((l) => l.kind === 'file')).toBe(true)
  })

  it('extracts backtick-wrapped paths and urls', () => {
    const links = extractThreadLinks([
      assistantMessage('open `src/utils/threadLinks.ts` and visit `https://openai.com`'),
    ], '/root/proj')
    expect(links.map((l) => l.value)).toEqual(['src/utils/threadLinks.ts', 'https://openai.com'])
    expect(links[0].kind).toBe('file')
    expect(links[1].kind).toBe('web')
  })

  it('extracts file:// uris', () => {
    const links = extractThreadLinks([
      userMessage('load file:///root/work/repo/file.ts'),
    ])
    expect(links.map((l) => l.value)).toEqual(['/root/work/repo/file.ts'])
    expect(links[0].kind).toBe('file')
  })

  it('strips line/column suffixes from file references', () => {
    const links = extractThreadLinks([
      userMessage('see src/app.ts:42 and /root/repo/main.rs#L10'),
    ], '/root/proj')
    expect(links.map((l) => l.value)).toEqual(['src/app.ts', '/root/repo/main.rs'])
  })

  it('dedupes repeated links keeping first occurrence order', () => {
    const links = extractThreadLinks([
      userMessage('see https://example.com and src/app.ts'),
      assistantMessage('again https://example.com and src/app.ts'),
    ], '/root/proj')
    expect(links.map((l) => l.value)).toEqual(['https://example.com', 'src/app.ts'])
  })

  it('dedupes paths that differ only by path separator', () => {
    const links = extractThreadLinks([
      userMessage('a src\\app.ts b'),
      assistantMessage('c src/app.ts d'),
    ], '/root/proj')
    const fileLinks = links.filter((l) => l.kind === 'file').map((l) => l.value)
    expect(fileLinks).toEqual(['src\\app.ts'])
  })

  it('ignores system messages', () => {
    const links = extractThreadLinks([
      { id: 's1', role: 'system', text: 'see https://example.com' },
      userMessage('see https://foo.io'),
    ])
    expect(links.map((l) => l.value)).toEqual(['https://foo.io'])
  })

  it('reads additionalContext alongside text', () => {
    const links = extractThreadLinks([
      { id: 'u1', role: 'user', text: 'hi', additionalContext: 'ref https://ctx.example.com' },
    ])
    expect(links.map((l) => l.value)).toEqual(['https://ctx.example.com'])
  })

  it('resolves relative paths against cwd', () => {
    const links = extractThreadLinks([
      assistantMessage('edit ./src/app.ts and ../shared/util.ts'),
    ], '/root/proj')
    expect(links.map((l) => l.href)).toEqual([
      '/codex-local-browse/root/proj/src/app.ts',
      '/codex-local-browse/root/shared/util.ts',
    ])
  })

  it('resolves ~ paths using cwd home', () => {
    const links = extractThreadLinks([
      userMessage('open ~/.config/codex/config.toml'),
    ], '/root/proj')
    expect(links[0].href).toBe('/codex-local-browse/root/.config/codex/config.toml')
  })

  it('produces stable ids', () => {
    const links = extractThreadLinks([userMessage('see https://example.com and /a/b.ts')])
    expect(links.map((l) => l.id)).toEqual(['web:https://example.com', 'file:/a/b.ts'])
  })

  it('uses basename as label for file paths', () => {
    const links = extractThreadLinks([userMessage('see /root/work/repo/src/app.ts')])
    expect(links[0].label).toBe('app.ts')
  })

  it('returns empty array for messages without links', () => {
    expect(extractThreadLinks([userMessage('just plain text')])).toEqual([])
  })

  it('does not treat plain sentences as file paths', () => {
    const links = extractThreadLinks([assistantMessage('hello world, this is a normal sentence.')])
    expect(links).toEqual([])
  })

  it('rejects numeric and code-like tokens that are not file paths', () => {
    const links = extractThreadLinks([
      assistantMessage('accuracy `1.2` vs `1.2975`, ports `50060/50061`, step 0/3, call `F.linear`, config DP2 / TP4 / EP8'),
    ], '/root/proj')
    expect(links).toEqual([])
  })

  it('keeps real bare filenames with code extensions', () => {
    const links = extractThreadLinks([assistantMessage('run `build_wheel.py` and check `tgemm.mm`')])
    expect(links.map((l) => l.value).sort()).toEqual(['build_wheel.py', 'tgemm.mm'])
  })
})

describe('threadLinks path helpers', () => {
  it('isFilePathLike classifies paths and rejects urls', () => {
    expect(isFilePathLike('/root/a.ts')).toBe(true)
    expect(isFilePathLike('src/a.ts')).toBe(true)
    expect(isFilePathLike('C:\\a.ts')).toBe(true)
    expect(isFilePathLike('https://example.com')).toBe(false)
    expect(isFilePathLike('')).toBe(false)
  })

  it('resolveRelativePath resolves absolute, relative, and home paths', () => {
    expect(resolveRelativePath('/root/a.ts', '/root/proj')).toBe('/root/a.ts')
    expect(resolveRelativePath('src/a.ts', '/root/proj')).toBe('/root/proj/src/a.ts')
    expect(resolveRelativePath('~/x', '/root/proj')).toBe('/root/x')
    expect(resolveRelativePath('~/x', '/home/bob/proj')).toBe('/home/bob/x')
  })

  it('buildFileBrowseHref returns browse route for resolved paths', () => {
    expect(buildFileBrowseHref('src/a.ts', '/root/proj')).toBe('/codex-local-browse/root/proj/src/a.ts')
    expect(buildFileBrowseHref('', '/root/proj')).toBe('#')
  })
})

describe('threadLinks tree builder', () => {
  function fileLink(value: string, id = value): import('../types/codex').UiMessage & {} {
    return { id, role: 'assistant', text: value }
  }

  it('merges shared prefixes into directory nodes', () => {
    const links = extractThreadLinks([
      fileLink('see /root/proj/src/app.ts and /root/proj/src/utils/helpers.ts'),
    ], '/root/proj')
    const tree = buildLinkTree(links)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('root')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].name).toBe('proj')
    const proj = tree[0].children[0]
    expect(proj.children.map((n) => n.name)).toEqual(['src'])
    const src = proj.children[0]
    expect(src.children.map((n) => n.name).sort()).toEqual(['app.ts', 'utils'])
    const utils = src.children.find((n) => n.name === 'utils')!
    expect(utils.children.map((n) => n.name)).toEqual(['helpers.ts'])
    expect(utils.children[0].link?.value).toBe('/root/proj/src/utils/helpers.ts')
  })

  it('keeps separate top-level roots for unrelated paths', () => {
    const links = extractThreadLinks([
      fileLink('a /root/x.ts b ./src/y.ts c /data00/run/z/'),
    ], '/root/proj')
    const tree = buildLinkTree(links)
    expect(tree.map((n) => n.name).sort()).toEqual(['data00', 'root', 'src'])
  })

  it('lists directories before files, alphabetically', () => {
    const links = extractThreadLinks([
      fileLink('/proj/z.ts and /proj/mid/a.ts and /proj/b.ts and /proj/mid/other/b.ts'),
    ])
    const tree = buildLinkTree(links)
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('proj')
    expect(tree[0].children.map((n) => n.name)).toEqual(['mid', 'b.ts', 'z.ts'])
  })

  it('flattens with expansion and respects collapsed dirs', () => {
    const links = extractThreadLinks([
      fileLink('/root/proj/src/app.ts and /root/proj/src/utils/helpers.ts'),
    ], '/root/proj')
    const tree = buildLinkTree(links)
    const allDirs = new Set(collectDirPaths(tree))
    const expanded = flattenLinkTree(tree, allDirs)
    expect(expanded.length).toBeGreaterThan(5)
    const collapsed = flattenLinkTree(tree, new Set())
    // only top-level root visible when everything collapsed
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].node.name).toBe('root')
  })

  it('ignores web links when building the file tree', () => {
    const links = extractThreadLinks([
      fileLink('see https://example.com and /a/b.ts'),
    ], '/root/proj')
    const tree = buildLinkTree(links)
    expect(tree.map((n) => n.name)).toEqual(['a'])
  })
})
