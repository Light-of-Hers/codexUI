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

export function findAgentMessagesFollowedByRunnableIds(messages: readonly UiMessage[]): Set<string> {
  const ids = new Set<string>()

  for (let index = 0; index + 1 < messages.length; index += 1) {
    const message = messages[index]!
    const next = messages[index + 1]!
    if (
      message.role === 'assistant'
      && message.messageType === 'agentMessage'
      && isRunnableMessage(next)
      && (!message.turnId || !next.turnId || message.turnId === next.turnId)
    ) {
      ids.add(message.id)
    }
  }

  return ids
}
