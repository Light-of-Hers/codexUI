import { describe, expect, it } from 'vitest'
import { resolveAutoFollowAfterScroll, resolveLatestRenderWindow } from './threadConversationScroll'

describe('resolveAutoFollowAfterScroll', () => {
  it('disables auto-follow when the user scrolls away from the bottom', () => {
    expect(resolveAutoFollowAfterScroll(true, false, true)).toBe(false)
    expect(resolveAutoFollowAfterScroll(true, false, false)).toBe(false)
    expect(resolveAutoFollowAfterScroll(false, false, true)).toBe(false)
  })

  it('keeps auto-follow on while parked at the bottom of the latest window', () => {
    expect(resolveAutoFollowAfterScroll(true, true, true)).toBe(true)
    expect(resolveAutoFollowAfterScroll(false, true, true)).toBe(true)
  })

  it('does not break the bottom lock when the render window lags one frame behind streaming output', () => {
    // auto-follow is on, user is at the bottom, but isRenderingLatest is
    // transiently false because messages grew faster than the watcher could
    // advance renderWindowEnd. Previously this returned false and froze the
    // window below the latest messages.
    expect(resolveAutoFollowAfterScroll(true, true, false)).toBe(true)
  })

  it('does not auto-enable follow just because the user reached the bottom of a stale window', () => {
    // User scrolled down through history to the bottom of the currently
    // rendered window, but the window is not the latest segment. Keep the
    // previous (off) state; the load-more-below path will catch the window up
    // and a later scroll will flip follow on once isRenderingLatest is true.
    expect(resolveAutoFollowAfterScroll(false, true, false)).toBe(false)
  })
})

describe('resolveLatestRenderWindow', () => {
  it('uses a fixed trailing window when no turn is streaming', () => {
    expect(resolveLatestRenderWindow(100, -1, 50)).toEqual({ start: 50, end: 100 })
    expect(resolveLatestRenderWindow(30, -1, 50)).toEqual({ start: 0, end: 30 })
  })

  it('returns an empty window when there are no messages', () => {
    expect(resolveLatestRenderWindow(0, -1, 50)).toEqual({ start: 0, end: 0 })
    expect(resolveLatestRenderWindow(0, 0, 50)).toEqual({ start: 0, end: 0 })
  })

  it('covers the whole streaming turn plus a context buffer so text and latest command stay on screen together', () => {
    // 300-message turn (1 text + 299 commands) streaming at the tail of a
    // 320-message thread. The fixed 50-window would only show the last 50
    // commands; instead we cover from 20 messages before the turn start
    // (context buffer) through the very end.
    const streamingTurnStart = 20
    expect(resolveLatestRenderWindow(320, streamingTurnStart, 50)).toEqual({ start: 0, end: 320 })
  })

  it('clamps the context buffer at zero', () => {
    expect(resolveLatestRenderWindow(300, 10, 50)).toEqual({ start: 0, end: 300 })
  })

  it('keeps a context buffer before a mid-history streaming turn', () => {
    expect(resolveLatestRenderWindow(500, 200, 50)).toEqual({ start: 150, end: 500 })
  })
})
