import { describe, expect, it } from 'vitest'
import { BoundedLruCache } from './boundedLruCache'

describe('BoundedLruCache', () => {
  it('keeps only the most recently used entries', () => {
    const cache = new BoundedLruCache<string>({ maxEntries: 2, maxWeight: 100, maxIdleMs: 1_000 })
    cache.set('first', 'first', 10)
    cache.set('second', 'second', 10)
    expect(cache.get('first')).toBe('first')
    cache.set('third', 'third', 10)

    expect(cache.get('second')).toBeUndefined()
    expect(cache.get('first')).toBe('first')
    expect(cache.get('third')).toBe('third')
  })

  it('evicts by aggregate weight and expires idle entries', () => {
    let now = 0
    const cache = new BoundedLruCache<string>({
      maxEntries: 10,
      maxWeight: 15,
      maxIdleMs: 100,
      now: () => now,
    })
    cache.set('first', 'first', 10)
    cache.set('second', 'second', 10)
    expect(cache.get('first')).toBeUndefined()
    expect(cache.weight).toBe(10)

    now = 101
    expect(cache.get('second')).toBeUndefined()
    expect(cache.size).toBe(0)
    expect(cache.weight).toBe(0)
  })

  it('stays bounded across a 1,000-thread workload', () => {
    const cache = new BoundedLruCache<{ id: number }>({
      maxEntries: 128,
      maxWeight: 64 * 1024,
      maxIdleMs: 60_000,
    })
    for (let index = 0; index < 1_000; index += 1) {
      cache.set(`thread-${index}`, { id: index }, 1024)
    }

    expect(cache.size).toBe(64)
    expect(cache.weight).toBe(64 * 1024)
    expect(cache.get('thread-935')).toBeUndefined()
    expect(cache.get('thread-999')).toEqual({ id: 999 })
  })
})
