import type { UiThread } from '../../types/codex'

export type ForkTreeNode = {
  thread: UiThread
  depth: number
  hasChildren: boolean
}

function readTimestamp(thread: UiThread, key: 'createdAtIso' | 'updatedAtIso'): number {
  const timestamp = new Date(thread[key]).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function compareForkChildren(first: UiThread, second: UiThread): number {
  const firstOrdinal = first.forkPointOrdinal
  const secondOrdinal = second.forkPointOrdinal
  if (firstOrdinal !== null && firstOrdinal !== undefined && secondOrdinal !== null && secondOrdinal !== undefined) {
    if (firstOrdinal !== secondOrdinal) return firstOrdinal - secondOrdinal
  } else if (firstOrdinal !== null && firstOrdinal !== undefined) {
    return -1
  } else if (secondOrdinal !== null && secondOrdinal !== undefined) {
    return 1
  }

  const firstByteOffset = first.forkPointByteOffset
  const secondByteOffset = second.forkPointByteOffset
  if (firstByteOffset !== null && firstByteOffset !== undefined && secondByteOffset !== null && secondByteOffset !== undefined) {
    if (firstByteOffset !== secondByteOffset) return firstByteOffset - secondByteOffset
  } else if (firstByteOffset !== null && firstByteOffset !== undefined) {
    return -1
  } else if (secondByteOffset !== null && secondByteOffset !== undefined) {
    return 1
  }

  const createdAtDifference = readTimestamp(first, 'createdAtIso') - readTimestamp(second, 'createdAtIso')
  return createdAtDifference || first.id.localeCompare(second.id)
}

function compareForkRoots(first: UiThread, second: UiThread): number {
  const updatedAtDifference = readTimestamp(second, 'updatedAtIso') - readTimestamp(first, 'updatedAtIso')
  return updatedAtDifference || compareForkChildren(first, second)
}

function readDirectParentId(thread: UiThread, threadsById: Map<string, UiThread>): string {
  const parentId = thread.forkedFromId?.trim() ?? ''
  if (!parentId || parentId === thread.id || !threadsById.has(parentId)) return ''

  const visited = new Set([thread.id])
  let currentId = parentId
  while (currentId) {
    if (visited.has(currentId)) return ''
    visited.add(currentId)
    const current = threadsById.get(currentId)
    const nextParentId = current?.forkedFromId?.trim() ?? ''
    if (!nextParentId || !threadsById.has(nextParentId)) return parentId
    currentId = nextParentId
  }
  return parentId
}

/**
 * Builds a pre-order tree from direct fork relationships. Fork point metadata
 * determines sibling order; a missing or cyclic parent degrades to a root.
 */
export function buildForkTree(
  threads: UiThread[],
  collapsedThreadIds: ReadonlySet<string> = new Set(),
): ForkTreeNode[] {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]))
  const childrenByParentId = new Map<string, UiThread[]>()
  const roots: UiThread[] = []

  for (const thread of threads) {
    const parentId = readDirectParentId(thread, threadsById)
    if (!parentId) {
      roots.push(thread)
      continue
    }
    const children = childrenByParentId.get(parentId)
    if (children) children.push(thread)
    else childrenByParentId.set(parentId, [thread])
  }

  roots.sort(compareForkRoots)
  for (const children of childrenByParentId.values()) {
    children.sort(compareForkChildren)
  }

  const nodes: ForkTreeNode[] = []
  const visit = (thread: UiThread, depth: number): void => {
    const children = childrenByParentId.get(thread.id) ?? []
    nodes.push({ thread, depth, hasChildren: children.length > 0 })
    if (collapsedThreadIds.has(thread.id)) return
    for (const child of children) visit(child, depth + 1)
  }

  for (const root of roots) visit(root, 0)
  return nodes
}
