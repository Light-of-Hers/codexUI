import { describe, expect, it } from 'vitest'
import type { UiThread } from '../../types/codex'
import { buildForkTree } from './forkTree'

function thread(
  id: string,
  overrides: Partial<UiThread> = {},
): UiThread {
  return {
    id,
    title: id,
    projectName: 'project',
    cwd: '/tmp/project',
    hasWorktree: false,
    createdAtIso: '2026-08-12T00:00:00.000Z',
    updatedAtIso: '2026-08-12T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
    ...overrides,
  }
}

describe('buildForkTree', () => {
  it('keeps an inherited fork point under its direct parent', () => {
    const nodes = buildForkTree([
      thread('root'),
      thread('child', { forkedFromId: 'root', forkPointOrdinal: 20 }),
      thread('grandchild', { forkedFromId: 'child' }),
    ])

    expect(nodes.map((node) => [node.thread.id, node.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
    ])
  })

  it('orders siblings by fork point before creation time', () => {
    const nodes = buildForkTree([
      thread('parent'),
      thread('late', {
        forkedFromId: 'parent',
        forkPointOrdinal: 40,
        createdAtIso: '2026-08-12T00:00:01.000Z',
      }),
      thread('early', {
        forkedFromId: 'parent',
        forkPointOrdinal: 10,
        createdAtIso: '2026-08-12T00:00:03.000Z',
      }),
      thread('same-point-first', {
        forkedFromId: 'parent',
        forkPointOrdinal: 40,
        forkPointByteOffset: 100,
        createdAtIso: '2026-08-12T00:00:04.000Z',
      }),
      thread('same-point-second', {
        forkedFromId: 'parent',
        forkPointOrdinal: 40,
        forkPointByteOffset: 200,
        createdAtIso: '2026-08-12T00:00:00.000Z',
      }),
    ])

    expect(nodes.map((node) => node.thread.id)).toEqual([
      'parent',
      'early',
      'same-point-first',
      'same-point-second',
      'late',
    ])
  })

  it('hides descendants of collapsed nodes and breaks cyclic metadata into roots', () => {
    const nodes = buildForkTree([
      thread('parent'),
      thread('child', { forkedFromId: 'parent' }),
      thread('cycle-a', { forkedFromId: 'cycle-b' }),
      thread('cycle-b', { forkedFromId: 'cycle-a' }),
    ], new Set(['parent']))

    expect(nodes.map((node) => [node.thread.id, node.depth])).toEqual([
      ['cycle-a', 0],
      ['cycle-b', 0],
      ['parent', 0],
    ])
  })
})
