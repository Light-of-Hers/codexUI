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
