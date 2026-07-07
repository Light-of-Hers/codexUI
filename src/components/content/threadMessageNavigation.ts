import type { UiMessage } from '../../types/codex'

export type UserMessageNavigationItem = {
  id: string
  ordinal: number
  messageIndex: number
  preview: string
  title: string
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
      ordinal: items.length + 1,
      messageIndex,
      preview: truncateText(title, previewLength),
      title,
    })
  })

  return items
}
