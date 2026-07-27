export function reconcilePinnedThreadIds(
  pinnedThreadIds: string[],
  loadedThreadIds: Set<string>,
  options: { canPruneMissing: boolean },
): string[] {
  if (!options.canPruneMissing) return pinnedThreadIds
  return pinnedThreadIds.filter((threadId) => loadedThreadIds.has(threadId))
}

export function reorderPinnedThreadIds(
  pinnedThreadIds: string[],
  draggedId: string,
  targetId: string,
): string[] {
  if (draggedId === targetId) return pinnedThreadIds

  const fromIndex = pinnedThreadIds.indexOf(draggedId)
  const toIndex = pinnedThreadIds.indexOf(targetId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return pinnedThreadIds

  const next = [...pinnedThreadIds]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}
