import { describe, expect, it } from 'vitest'
import {
  normalizeLinkBasePaths,
  parseFileReference,
  resolveFileLinkPath,
  toBrowseUrl,
} from './fileLinkResolver'

describe('fileLinkResolver', () => {
  it('normalizes persisted base paths to unique absolute directories', () => {
    expect(normalizeLinkBasePaths([
      '/work/project/',
      '/work/project',
      'relative/project',
      '',
      'file:///tmp/context%20dir/',
    ])).toEqual([
      '/work/project',
      '/tmp/context dir',
    ])
  })

  it('resolves bare relative paths against the first configured base path', () => {
    expect(resolveFileLinkPath('src/App.vue', {
      cwd: '/work/current',
      basePaths: ['/work/context', '/work/other'],
    })).toBe('/work/context/src/App.vue')
  })

  it('keeps explicit relative and tilde paths on their existing semantics', () => {
    expect(resolveFileLinkPath('./src/App.vue', {
      cwd: '/work/current',
      basePaths: ['/work/context'],
    })).toBe('/work/current/src/App.vue')

    expect(resolveFileLinkPath('~/work/my-agent-configs/AGENTS.md', {
      cwd: '/root/work/current',
      basePaths: ['/work/context'],
    })).toBe('/root/work/my-agent-configs/AGENTS.md')
  })

  it('preserves colon line ranges in browse urls', () => {
    expect(parseFileReference('src/App.vue:12-18')).toEqual({
      path: 'src/App.vue',
      line: 12,
      endLine: 18,
    })

    expect(toBrowseUrl('src/App.vue:12-18', {
      cwd: '/work/current',
      basePaths: ['/work/context'],
    })).toBe('/codex-local-browse/work/context/src/App.vue?line=12-18')
  })
})
