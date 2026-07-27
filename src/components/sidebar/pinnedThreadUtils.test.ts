import { describe, expect, it } from 'vitest'
import { reconcilePinnedThreadIds, reorderPinnedThreadIds } from './pinnedThreadUtils'

describe('reconcilePinnedThreadIds', () => {
  it('keeps pins whose threads have not loaded while pagination is still incomplete', () => {
    expect(
      reconcilePinnedThreadIds(['loaded', 'not-yet-loaded'], new Set(['loaded']), {
        canPruneMissing: false,
      }),
    ).toEqual(['loaded', 'not-yet-loaded'])
  })

  it('prunes missing pins after the thread list is fully loaded', () => {
    expect(
      reconcilePinnedThreadIds(['loaded', 'missing'], new Set(['loaded']), {
        canPruneMissing: true,
      }),
    ).toEqual(['loaded'])
  })
})

describe('reorderPinnedThreadIds', () => {
  it('moves a pinned thread before another pinned thread', () => {
    expect(reorderPinnedThreadIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('moves a pinned thread later in the list', () => {
    expect(reorderPinnedThreadIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('returns the same array reference when nothing changes', () => {
    const ids = ['a', 'b', 'c']
    expect(reorderPinnedThreadIds(ids, 'a', 'a')).toBe(ids)
    expect(reorderPinnedThreadIds(ids, 'missing', 'a')).toBe(ids)
  })
})
