import { describe, expect, it } from 'vitest'
import {
  extractComposerFileMentionAttachments,
  filterComposerFileMentionSuggestions,
  formatComposerFileMention,
  insertComposerFileMentionText,
  resolveComposerFileMentionFsPath,
  toComposerFileMentionSearchQuery,
} from './composerFileMentions'

describe('composerFileMentions', () => {
  it('formats plain relative paths as inline ./ mentions', () => {
    expect(formatComposerFileMention('repos/codexUI')).toBe('./repos/codexUI')
  })

  it('quotes paths with spaces so the mention remains parseable', () => {
    expect(formatComposerFileMention('New Project/app file.ts')).toBe('./"New Project/app file.ts"')
  })

  it('inserts a trailing space after inline mentions', () => {
    expect(insertComposerFileMentionText('', 'repos/codexUI', 0)).toEqual({
      text: './repos/codexUI ',
      selectionIndex: 16,
    })
  })

  it('keeps the cursor after existing whitespace when replacing a mention', () => {
    expect(insertComposerFileMentionText('Read @instalconf now', 'install-configs.py', 5, 16)).toEqual({
      text: 'Read ./install-configs.py now',
      selectionIndex: 26,
    })
  })

  it('treats leading slashes in mention search text as relative prefixes', () => {
    expect(toComposerFileMentionSearchQuery('/src/App')).toBe('src/App')
    expect(toComposerFileMentionSearchQuery('/')).toBe('')
    expect(toComposerFileMentionSearchQuery('src/App')).toBe('src/App')
  })

  it('preserves home and likely absolute paths in mention search text', () => {
    expect(toComposerFileMentionSearchQuery('~/work/my-agent-configs/repos/codexUI')).toBe(
      '~/work/my-agent-configs/repos/codexUI',
    )
    expect(toComposerFileMentionSearchQuery('/root/work/my-agent-configs/repos/codexUI')).toBe(
      '/root/work/my-agent-configs/repos/codexUI',
    )
  })

  it('extracts inline ./ mentions as file attachments', () => {
    const attachments = extractComposerFileMentionAttachments(
      'Read ./repos/codexUI and ./"New Project/app file.ts", then ignore user@example.com.',
      '/root/work/project',
    )

    expect(attachments).toEqual([
      { label: 'codexUI', path: 'repos/codexUI', fsPath: '/root/work/project/repos/codexUI' },
      {
        label: 'app file.ts',
        path: 'New Project/app file.ts',
        fsPath: '/root/work/project/New Project/app file.ts',
      },
    ])
  })

  it('does not treat @/ as an absolute-path mode', () => {
    const attachments = extractComposerFileMentionAttachments('Open @/src/App.vue', '/root/work/project')

    expect(attachments).toEqual([
      { label: 'App.vue', path: 'src/App.vue', fsPath: '/root/work/project/src/App.vue' },
    ])
  })

  it('extracts home and likely absolute inline @ mentions as file attachments', () => {
    const attachments = extractComposerFileMentionAttachments(
      'Compare @~/work/my-agent-configs/repos/codexUI with @"/root/work/my-notebook/notes/space file.md".',
      '/root/work/my-notebook',
    )

    expect(attachments).toEqual([
      {
        label: 'codexUI',
        path: '~/work/my-agent-configs/repos/codexUI',
        fsPath: '/root/work/my-agent-configs/repos/codexUI',
      },
      {
        label: 'space file.md',
        path: '/root/work/my-notebook/notes/space file.md',
        fsPath: '/root/work/my-notebook/notes/space file.md',
      },
    ])
  })

  it('extracts full-width @ inline mentions as file attachments', () => {
    const attachments = extractComposerFileMentionAttachments(
      'Read \uFF20notes/2026-04-24-codex-sandboxing.md next.',
      '/root/work/my-notebook',
    )

    expect(attachments).toEqual([
      {
        label: '2026-04-24-codex-sandboxing.md',
        path: 'notes/2026-04-24-codex-sandboxing.md',
        fsPath: '/root/work/my-notebook/notes/2026-04-24-codex-sandboxing.md',
      },
    ])
  })

  it('formats absolute selections as @ mentions so they remain extractable', () => {
    expect(formatComposerFileMention('/root/work/my-agent-configs/repos/codexUI')).toBe(
      '@/root/work/my-agent-configs/repos/codexUI',
    )
    expect(formatComposerFileMention('/root/work/my notebook/notes.md')).toBe(
      '@"/root/work/my notebook/notes.md"',
    )
    expect(insertComposerFileMentionText('', '/root/work/my-agent-configs/repos/codexUI', 0)).toEqual({
      text: '@/root/work/my-agent-configs/repos/codexUI ',
      selectionIndex: 43,
    })
  })

  it('expands tilde file mentions from the current cwd', () => {
    expect(resolveComposerFileMentionFsPath('~/work/my-agent-configs/repos/codexUI', '/root/work/my-notebook')).toBe(
      '/root/work/my-agent-configs/repos/codexUI',
    )
  })

  it('filters cached suggestions locally with basename-first ranking', () => {
    const suggestions = [
      { path: '_notebooks/byte/_workspace/amd/sec_token_string.txt', kind: 'file' as const, isSymlink: false },
      { path: '_notebooks/byte/sec_string.txt', kind: 'file' as const, isSymlink: false },
      { path: '_notebooks/byte/unrelated.txt', kind: 'file' as const, isSymlink: false },
    ]

    expect(filterComposerFileMentionSuggestions(suggestions, 'sec_string', 20)[0]?.path).toBe(
      '_notebooks/byte/sec_string.txt',
    )
    expect(filterComposerFileMentionSuggestions(suggestions, 'sec', 20)[0]?.path).toBe(
      '_notebooks/byte/sec_string.txt',
    )
  })
})
