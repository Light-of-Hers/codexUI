import type { UiMessage } from '../../types/codex'

function isToolCallMessage(message: UiMessage): boolean {
  return message.messageType === 'toolCall' && !!message.toolCall
}

function isRunnableMessage(message: UiMessage): boolean {
  return (message.messageType === 'commandExecution' && !!message.commandExecution)
    || isToolCallMessage(message)
}

export function groupConsecutiveRunnableItemsByLatestId(messages: readonly UiMessage[]): Record<string, UiMessage[]> {
  const next: Record<string, UiMessage[]> = {}

  for (let index = 0; index < messages.length;) {
    if (!isRunnableMessage(messages[index])) {
      index += 1
      continue
    }

    const block: UiMessage[] = []
    while (index < messages.length && isRunnableMessage(messages[index])) {
      block.push(messages[index])
      index += 1
    }

    if (block.length <= 1) continue
    const latest = block[block.length - 1]
    next[latest.id] = block.slice(0, -1)
  }

  return next
}
