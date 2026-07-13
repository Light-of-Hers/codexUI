// Decide whether auto-follow ("stick to bottom") should remain active
// after a conversation scroll event.
//
// While the agent streams output, props.messages grows every frame but the
// render window (renderWindowEnd) is reconciled asynchronously by a watcher.
// For a brief moment isRenderingLatest can be false even though the user is
// still parked at the bottom. The previous logic
// (`autoFollow = isRenderingLatest && isAtBottom`) flipped auto-follow off
// during that gap, which froze the render window below the latest messages,
// hid the live overlay, and surfaced a spurious "Load later messages" button.
//
// The fix: only disable auto-follow when the user has genuinely scrolled
// away from the bottom. When at the bottom but the window is transiently
// behind, keep the previous value so the watcher can catch up.
export function resolveAutoFollowAfterScroll(
  currentAutoFollow: boolean,
  atBottom: boolean,
  isRenderingLatest: boolean,
): boolean {
  if (!atBottom) return false
  if (isRenderingLatest) return true
  return currentAutoFollow
}

// Compute the render window shown when sticking to the latest output.
//
// While a turn is streaming (`streamingTurnStart >= 0`), the window must
// cover the whole in-progress turn so the user can always see the streaming
// text together with the latest command output. A single turn can emit
// hundreds of command messages (each command is its own message); the
// previous fixed-size window (50, capped at 110) sliced the turn in half,
// so the assistant text and the latest command could never be on screen at
// the same time, and scrolling to the bottom snapped back to the turn top.
// The turn's commands are grouped/collapsed in the view, so rendering a
// large turn is still cheap.
//
// `streamingTurnStart` is -1 when no turn is streaming.
export function resolveLatestRenderWindow(
  messageCount: number,
  streamingTurnStart: number,
  windowSize: number,
): { start: number; end: number } {
  if (messageCount <= 0) return { start: 0, end: 0 }
  const end = messageCount
  if (streamingTurnStart < 0 || streamingTurnStart >= messageCount) {
    return { start: Math.max(0, messageCount - windowSize), end }
  }
  const start = Math.max(0, streamingTurnStart - windowSize)
  return { start, end }
}
