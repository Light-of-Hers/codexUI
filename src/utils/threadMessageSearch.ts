import type { ThreadMessageSearchResult } from '../api/codexGateway'
import type { UiMessage } from '../types/codex'

export type ThreadSearchUiResult = ThreadMessageSearchResult & {
  source: 'backend' | 'live'
}

export type ThreadSearchUiResultEntry = {
  result: ThreadSearchUiResult
  order: number
}

const THREAD_SEARCH_SNIPPET_CONTEXT = 72

function appendThreadSearchPart(parts: string[], seen: Set<string>, value: unknown): void {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || seen.has(text)) return
  seen.add(text)
  parts.push(text)
}

export function buildUiMessageSearchText(message: UiMessage): string {
  const parts: string[] = []
  const seen = new Set<string>()
  appendThreadSearchPart(parts, seen, message.text)
  appendThreadSearchPart(parts, seen, message.rawPayload)
  if (message.commandExecution) {
    appendThreadSearchPart(parts, seen, message.commandExecution.command)
    appendThreadSearchPart(parts, seen, message.commandExecution.cwd ?? '')
    appendThreadSearchPart(parts, seen, message.commandExecution.aggregatedOutput)
    appendThreadSearchPart(parts, seen, message.commandExecution.exitCode === null ? '' : `exit ${message.commandExecution.exitCode}`)
    appendThreadSearchPart(parts, seen, message.commandExecution.status)
  }
  if (message.toolCall) {
    appendThreadSearchPart(parts, seen, message.toolCall.title)
    appendThreadSearchPart(parts, seen, message.toolCall.name)
    appendThreadSearchPart(parts, seen, message.toolCall.status)
    appendThreadSearchPart(parts, seen, message.toolCall.server ?? '')
    appendThreadSearchPart(parts, seen, message.toolCall.meta.join('\n'))
    appendThreadSearchPart(parts, seen, message.toolCall.progress)
    appendThreadSearchPart(parts, seen, message.toolCall.input)
    appendThreadSearchPart(parts, seen, message.toolCall.output)
    appendThreadSearchPart(parts, seen, message.toolCall.error)
  }
  for (const attachment of message.fileAttachments ?? []) {
    appendThreadSearchPart(parts, seen, `${attachment.label}\n${attachment.path}`)
  }
  for (const skill of message.skills ?? []) {
    appendThreadSearchPart(parts, seen, `${skill.name}\n${skill.path}`)
  }
  for (const change of message.fileChanges ?? []) {
    appendThreadSearchPart(parts, seen, [
      change.operation,
      change.path,
      change.movedToPath ?? '',
      change.diff,
      `+${change.addedLineCount}`,
      `-${change.removedLineCount}`,
    ].filter(Boolean).join('\n'))
  }
  return parts.join('\n').trim()
}

function buildThreadSearchSnippet(text: string, matchStart: number, matchEnd: number): Pick<ThreadMessageSearchResult, 'snippet' | 'snippetMatchStart' | 'snippetMatchEnd'> {
  const rawStart = Math.max(0, matchStart - THREAD_SEARCH_SNIPPET_CONTEXT)
  const rawEnd = Math.min(text.length, matchEnd + THREAD_SEARCH_SNIPPET_CONTEXT)
  const prefix = rawStart > 0 ? '...' : ''
  const suffix = rawEnd < text.length ? '...' : ''
  const snippet = `${prefix}${text.slice(rawStart, rawEnd)}${suffix}`.replace(/[\r\n\t]/gu, ' ')
  const snippetMatchStart = prefix.length + matchStart - rawStart
  return {
    snippet,
    snippetMatchStart,
    snippetMatchEnd: snippetMatchStart + (matchEnd - matchStart),
  }
}

export function isLiveOnlySearchCandidate(message: UiMessage): boolean {
  const type = message.messageType ?? ''
  return type.endsWith('.live') || !message.turnId || typeof message.turnIndex !== 'number'
}

export function buildLiveThreadSearchResults(
  query: string,
  backendMessageIds: Set<string>,
  messages: UiMessage[],
): ThreadSearchUiResult[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const results: ThreadSearchUiResult[] = []
  for (const message of messages) {
    if (!isLiveOnlySearchCandidate(message)) continue
    if (backendMessageIds.has(message.id)) continue
    const text = buildUiMessageSearchText(message)
    if (!text) continue
    const lowerText = text.toLowerCase()
    let offset = 0
    let occurrenceIndex = 0
    while (offset <= lowerText.length) {
      const matchStart = lowerText.indexOf(normalizedQuery, offset)
      if (matchStart < 0) break
      const matchEnd = matchStart + normalizedQuery.length
      results.push({
        id: `live:${message.id}:${occurrenceIndex}:${matchStart}`,
        turnId: message.turnId ?? '',
        turnIndex: typeof message.turnIndex === 'number' ? message.turnIndex : -1,
        messageId: message.id,
        role: message.role,
        messageType: message.messageType ?? '',
        occurrenceIndex,
        ...buildThreadSearchSnippet(text, matchStart, matchEnd),
        source: 'live',
      })
      occurrenceIndex += 1
      offset = matchEnd > matchStart ? matchEnd : matchStart + 1
    }
  }
  return results
}

export function compareThreadSearchResultEntriesByRecency(
  left: ThreadSearchUiResultEntry,
  right: ThreadSearchUiResultEntry,
): number {
  const leftTurn = left.result.turnIndex >= 0 ? left.result.turnIndex : Number.POSITIVE_INFINITY
  const rightTurn = right.result.turnIndex >= 0 ? right.result.turnIndex : Number.POSITIVE_INFINITY
  if (leftTurn !== rightTurn) return leftTurn > rightTurn ? -1 : 1
  if (left.result.messageId === right.result.messageId && left.result.occurrenceIndex !== right.result.occurrenceIndex) {
    return right.result.occurrenceIndex - left.result.occurrenceIndex
  }
  return left.order - right.order
}
