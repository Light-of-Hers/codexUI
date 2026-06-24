# Current Thread Session Search Design

## Goal

Add a search experience for the currently opened thread that can find text across the complete persisted conversation, including turns that are not currently loaded or rendered in the browser.

The design follows the backend-search approach: persisted search is computed from complete thread data on the server, while the frontend displays results and asks the conversation view to reveal a selected result.

## Scope

- Search only the currently opened thread.
- Search complete persisted turns from the backend.
- Include live, not-yet-persisted messages from frontend state without using DOM search.
- Match plain text case-insensitively.
- Return result snippets with enough metadata to navigate to a matching message.
- Keep the existing sidebar thread search behavior unchanged.
- Do not introduce a global full-text database or external indexing dependency.

## Backend API

Add a new endpoint in `src/server/codexAppServerBridge.ts`:

```http
POST /codex-api/thread-message-search
```

Request body:

```ts
{
  threadId: string
  query: string
  limit?: number
}
```

Response body:

```ts
{
  data: {
    threadId: string
    query: string
    totalMatches: number
    truncated: boolean
    results: ThreadMessageSearchResult[]
  }
}
```

`ThreadMessageSearchResult`:

```ts
{
  id: string
  turnId: string
  turnIndex: number
  messageId: string
  role: 'user' | 'assistant' | 'system'
  messageType: string
  occurrenceIndex: number
  snippet: string
  snippetMatchStart: number
  snippetMatchEnd: number
}
```

The server will read the full thread with `thread/read` and `includeTurns: true`, then scan structured text extracted from each turn item. The existing `extractThreadMessageText()` helper currently returns one concatenated text blob; implementation should refactor that logic into a structured extractor that yields one searchable row per message-like item while preserving the current global thread-search behavior.

Returned `messageId` values must match the IDs used by the normalized `UiMessage` rows rendered in `ThreadConversation.vue`. If the server extractor reads raw turn items directly, it must follow the same ID derivation strategy as the existing thread normalizers.

The endpoint should cap `limit` to a bounded value, defaulting to `100` and allowing up to `500`. `totalMatches` counts all discovered matches before truncation so the UI can show when only the first page is displayed.

## Live Message Handling

Backend search covers persisted turns. Active live messages can exist only in browser state until they are persisted.

`App.vue` should merge backend results with live-only matches from `filteredMessages`. This merge scans message data, not rendered DOM. A message counts as live-only when it has a `.live` message type or lacks a stable persisted turn mapping. Backend result `messageId` values are used only to dedupe live candidates that became persisted while a search request was in flight.

Merged results should be sorted by `turnIndex` when available, with live results after persisted results for the same turn.

## Frontend API Client

Add a typed client function in `src/api/codexGateway.ts`:

```ts
export async function searchThreadMessages(
  threadId: string,
  query: string,
  limit = 100,
): Promise<ThreadMessageSearchResponse>
```

This client should normalize empty input by returning an empty result locally, and throw a user-facing error message if the endpoint fails.

## UI Entry Point

Add a search icon button to the content header actions for thread routes only. It should not appear on the home, skills, automations, or review pane views.

When opened, the header shows a compact thread-search control:

- input
- result counter
- previous result button
- next result button
- close button
- loading/error status text when needed

Keyboard behavior:

- `Enter`: next result
- `Shift+Enter`: previous result
- `Escape`: close search

The existing sidebar search remains independent and keeps its current thread-filtering behavior.

## Result Navigation

Search results are independent of rendering. Selecting a result uses its `turnId` and `messageId`:

1. If the matching message is already loaded in `filteredMessages`, ask `ThreadConversation.vue` to reveal it.
2. If it is not loaded, request a small backend window around the target turn before revealing it.

To avoid sequentially loading every older page, add a second endpoint:

```http
GET /codex-api/thread-turn-window?threadId=...&centerTurnId=...&before=8&after=8
```

This endpoint mirrors the existing `/codex-api/thread-turn-page` normalization path but slices turns around `centerTurnId`. The frontend merges the returned messages into the existing persisted message cache, then reveals the matching message.

This keeps search independent from the render window and avoids tying search correctness to current DOM state.

## Conversation Reveal API

Extend the exposed API from `ThreadConversation.vue`:

```ts
defineExpose({
  jumpToLatest,
  revealMessage,
})
```

`revealMessage(messageId: string)` should:

- expand `renderWindowStart` so the target message is included in `visibleMessages`
- wait for Vue to render
- scroll the matching `.conversation-item` into view
- apply a short highlight state to the matching item

This reveal method is navigation-only. It does not compute search results.

## Data Flow

1. User opens search on a thread.
2. User enters a query.
3. `App.vue` debounces the query and calls `searchThreadMessages(threadId, query)`.
4. The backend scans the complete persisted thread and returns structured matches.
5. `App.vue` merges live-only matches from `filteredMessages`.
6. The header search UI shows count and current index.
7. User moves between matches.
8. If the result is not loaded, `App.vue` loads a turn window around `turnId`.
9. `ThreadConversation.vue` reveals and highlights `messageId`.

## Error Handling

- Empty query clears results without a network request.
- Missing or invalid `threadId` returns `400`.
- Search failures show a compact inline error in the header search control.
- If a result cannot be revealed because the turn was deleted or reloaded, the UI refreshes the current thread once and retries one time.
- If retry fails, the result remains in the list but shows a stale-result error.

## Performance

- Search runs only after debounce, not on every keystroke.
- Requests are cancelled or ignored by token when the query/thread changes.
- Backend scans one current thread, not all threads.
- Results are capped and report truncation.
- Jumping to old results loads a bounded turn window instead of walking page by page from the newest turn.
- The conversation render window remains bounded; reveal expands only enough to include the selected message.

## Tests

Unit tests:

- server text extraction returns per-message results with snippets
- case-insensitive matching
- multiple matches in one message
- truncation metadata
- turn-window endpoint slices around `centerTurnId`
- frontend client handles empty query, success, and failure
- frontend live-message merge does not duplicate persisted results

Manual tests to add to `tests.md` during implementation:

- search current visible message
- search older non-rendered message
- search live assistant output while a turn is running
- next/previous result navigation
- no-results state
- error state
- light theme verification
- dark theme verification

## Non-Goals

- Fuzzy matching.
- Regex search.
- Searching all threads from this UI.
- Highlighting every text occurrence inside rendered Markdown.
- Persisting search history across browser sessions.
