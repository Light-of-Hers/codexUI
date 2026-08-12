import type { UiMessage } from '../../types/codex'

export type UserMessageNavigationItem = {
  id: string
  turnId: string
  ordinal: number
  messageIndex: number
  preview: string
  title: string
  kind?: 'forkBoundary'
  sourceThreadId?: string
}

export type SessionUserMessageNavigationEntry = {
  turnId: string
  ordinal: number
  preview: string
  title: string
  kind?: 'forkBoundary'
  sourceThreadId?: string
}

const DEFAULT_PREVIEW_LENGTH = 88

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return '…'
  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function messageNavigationText(message: UiMessage): string {
  const sections: string[] = []
  const text = normalizeWhitespace(message.text)
  if (text) sections.push(text)

  const fileLabels = (message.fileAttachments ?? [])
    .map((attachment) => normalizeWhitespace(attachment.label || attachment.path))
    .filter((label) => label.length > 0)
  if (fileLabels.length > 0) {
    sections.push(`Files: ${fileLabels.join(', ')}`)
  }

  const imageCount = message.images?.length ?? 0
  if (imageCount > 0) {
    sections.push(imageCount === 1 ? '1 image' : `${imageCount} images`)
  }

  const skillNames = (message.skills ?? [])
    .map((skill) => normalizeWhitespace(skill.name || skill.path))
    .filter((name) => name.length > 0)
  if (skillNames.length > 0) {
    sections.push(`Skills: ${skillNames.join(', ')}`)
  }

  return sections.join(' · ') || '(empty message)'
}

export function buildUserMessageNavigationItems(
  messages: readonly UiMessage[],
  previewLength = DEFAULT_PREVIEW_LENGTH,
): UserMessageNavigationItem[] {
  const items: UserMessageNavigationItem[] = []

  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return
    const title = messageNavigationText(message)
    items.push({
      id: message.id,
      turnId: message.turnId?.trim() ?? '',
      ordinal: items.length + 1,
      messageIndex,
      preview: truncateText(title, previewLength),
      title,
    })
  })

  return items
}

/**
 * Session metadata supplies the complete history, while the rendered messages
 * can contain a newly persisted turn before that metadata index has refreshed.
 */
export function mergeSessionUserMessageNavigationItems(
  sessionEntries: readonly SessionUserMessageNavigationEntry[],
  loadedItems: readonly UserMessageNavigationItem[],
): UserMessageNavigationItem[] {
  const idByTurnId = new Map<string, string>()
  for (const item of loadedItems) {
    const turnId = item.turnId.trim()
    if (turnId && item.id && !idByTurnId.has(turnId)) {
      idByTurnId.set(turnId, item.id)
    }
  }

  const knownTurnIds = new Set<string>()
  let latestOrdinal = 0
  const indexedItems = sessionEntries.map((entry) => {
    const turnId = entry.turnId.trim()
    if (turnId) knownTurnIds.add(turnId)
    if (entry.kind !== 'forkBoundary') {
      latestOrdinal = Math.max(latestOrdinal, entry.ordinal)
    }
    return {
      id: idByTurnId.get(turnId) ?? '',
      turnId,
      ordinal: entry.ordinal,
      messageIndex: -1,
      preview: entry.preview,
      title: entry.title,
      kind: entry.kind,
      sourceThreadId: entry.sourceThreadId,
    }
  })

  const newlyLoadedItems: UserMessageNavigationItem[] = []
  for (const item of loadedItems) {
    const turnId = item.turnId.trim()
    if (!turnId || knownTurnIds.has(turnId)) continue
    knownTurnIds.add(turnId)
    latestOrdinal += 1
    newlyLoadedItems.push({ ...item, turnId, ordinal: latestOrdinal })
  }

  return [...indexedItems, ...newlyLoadedItems]
}
