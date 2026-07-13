import { describe, expect, it } from 'vitest'
import { resolveAutoFollowAfterScroll } from './threadConversationScroll'

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
