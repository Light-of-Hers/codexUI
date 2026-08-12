# codex-web-local — Project Specification

## Overview

**codex-web-local** is a lightweight, browser-based web UI for [OpenAI Codex](https://github.com/openai/codex). It mirrors the Codex Desktop experience and runs on top of the Codex `app-server`, allowing remote access to a local Codex instance from any browser.

- **Author:** Pavel Voronin
- **License:** MIT
- **Repository:** https://github.com/pavel-voronin/codex-web-local

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (Vue 3 SPA)                                     │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ App.vue     │  │ Composables  │  │ API Layer        │ │
│  │ (Router)    │──│ useDesktop   │──│ codexGateway     │ │
│  │             │  │ State        │  │ codexRpcClient   │ │
│  └────────────┘  └──────────────┘  └────────┬─────────┘ │
└─────────────────────────────────────────────┼───────────┘
                                              │ HTTP/SSE
┌─────────────────────────────────────────────┼───────────┐
│  Node.js Server                             │           │
│  ┌──────────────────────────────────────────┼─────────┐ │
│  │ Express / Vite Middleware                │         │ │
│  │  ┌───────────────────┐  ┌───────────────┴───────┐ │ │
│  │  │ Auth Middleware    │  │ Codex Bridge          │ │ │
│  │  │ (password, cookie) │  │ /codex-api/*          │ │ │
│  │  └───────────────────┘  └───────────┬───────────┘ │ │
│  └─────────────────────────────────────┼─────────────┘ │
│                                        │ stdin/stdout   │
│  ┌─────────────────────────────────────┼─────────────┐ │
│  │ Provider-aware app-server pool      │             │ │
│  │ JSON-RPC over newline-delimited I/O │             │ │
│  └───────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

- **No Pinia / Vuex**: All state lives in a single composable (`useDesktopState`). Reactive refs + computed properties manage thread, message, model, and UI state.
- **Realtime transport**: Client prefers **WebSocket** on `/codex-api/ws` for server-to-client notifications, with automatic fallback to **SSE** (`EventSource`) on `/codex-api/events`. Client-to-server RPC stays on HTTP POST.
- **Provider-aware runtime pool**: Threads are routed to the correct `codex app-server` runtime while preserving fork/archive ownership across providers.
- **Shared bridge state**: A global singleton (`AppServerRuntimePool`) survives Vite HMR reloads during development. Thread-keyed state is bounded and released on archive, runtime exit, and disposal.
- **Shared rollout snapshots**: Rollout consumers reuse a signature-keyed, bounded snapshot rather than repeatedly reading and parsing the same JSONL file.
- **Shared local routes**: Development and production mount the same local browse/editor/preview middleware and enforce the same request limits and error contract.

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend framework | Vue 3 (Composition API, `<script setup>`) | ^3.5 |
| Routing | Vue Router 4 | ^4.6 |
| Styling | Tailwind CSS 4 (via `@tailwindcss/vite`) | ^4.1 |
| Build tool | Vite 6 | ^6.1 |
| CLI build | tsup 8 | ^8.4 |
| Type checking | TypeScript 5, vue-tsc 2 | ^5.7 / ^2.2 |
| Server | Express 5 | ^5.1 |
| CLI framework | Commander 13 | ^13.1 |
| Runtime | Node.js 20 or 22 | — |

## Project Structure

```
codex-web-local/
├── src/
│   ├── api/                          # Backend communication layer
│   │   ├── codexGateway.ts           # High-level API (threads, turns, models)
│   │   ├── codexRpcClient.ts         # HTTP/SSE transport for /codex-api/*
│   │   ├── codexErrors.ts            # Error normalization
│   │   ├── appServerDtos.ts          # Raw DTO types from app-server
│   │   └── normalizers/v2.ts         # DTO → UI type transformers
│   ├── components/
│   │   ├── content/                  # Main content area
│   │   │   ├── ThreadConversation.vue  # Message list with scroll management
│   │   │   ├── ThreadComposer.vue      # Input + model/reasoning selectors
│   │   │   ├── ComposerDropdown.vue    # Reusable dropdown (model, folder)
│   │   │   └── ContentHeader.vue       # Page title bar
│   │   ├── sidebar/                  # Left panel
│   │   │   ├── SidebarThreadTree.vue   # Thread list grouped by project
│   │   │   └── SidebarThreadControls.vue # New thread, auto-refresh toggle
│   │   ├── layout/
│   │   │   └── DesktopLayout.vue       # Sidebar + content split layout
│   │   └── icons/                    # Tabler icon components
│   ├── composables/
│   │   └── useDesktopState.ts        # Central state composable (~2000 LOC)
│   ├── server/                       # Node.js server (production + dev)
│   │   ├── codexAppServerBridge.ts   # Spawns/proxies codex app-server
│   │   ├── httpServer.ts             # Express app for production
│   │   ├── localHttpRoutes.ts        # Shared browse/editor/preview routes
│   │   ├── authMiddleware.ts         # Password-based auth
│   │   └── password.ts              # Password generation + comparison
│   ├── cli/
│   │   └── index.ts                  # CLI entry point (Commander)
│   ├── types/
│   │   └── codex.ts                  # UI-layer TypeScript types
│   ├── router/
│   │   └── index.ts                  # Vue Router config
│   ├── App.vue                       # Root component
│   ├── main.ts                       # Vue app bootstrap
│   └── style.css                     # Global Tailwind styles
├── documentation/                    # Codex app-server protocol docs
│   ├── APP_SERVER_DOCUMENTATION.md   # Full protocol reference (66 methods, 7 server requests, 34 notifications)
│   └── app-server-schemas/           # Materialized JSON + TypeScript schemas
│       ├── json/                     # JSON Schema files (v1, v2, root)
│       └── typescript/               # TypeScript type definitions (v1, v2, root)
├── index.html                        # SPA entry point
├── vite.config.ts                    # Vite config (Vue, Tailwind, bridge middleware)
├── tsup.config.ts                    # CLI build config
└── package.json                      # Scripts, deps, bin entry
```

## Features

### Implemented

| Feature | Description |
|---|---|
| Thread management | List, create, archive, fork, rollback, rename, pin, and select threads; resume inactive threads on demand |
| Chat conversation | Send, queue, and steer messages; browse paginated and fork-aware conversation history |
| Real-time streaming | WebSocket-first live updates for messages, reasoning, commands, file changes, plans, token usage, and turn lifecycle; SSE fallback |
| Model selection | Dropdown to choose from available models (`model/list` RPC) |
| Reasoning effort | Configurable reasoning effort level (none → xhigh) |
| Turn interrupt | Stop in-progress agent turns |
| Server request handling | Approve/reject server-initiated requests (command approvals, file changes, tool calls) |
| Project grouping | Threads organized by working directory (project) |
| Project customization | Rename, reorder, remove projects (persisted to localStorage) |
| Unread indicators | Track read/unread state per thread |
| Auto-refresh | Optional 4-second polling with visual countdown |
| Collapsible sidebar | Resizable (260–620px), toggle with Ctrl/Cmd+B |
| Scroll state persistence | Remember scroll position per thread across navigation |
| Password auth | Optional password protection with auto-generated passwords in production |
| New thread creation | "Let's build" hero view with folder selector |
| Live overlay | Reasoning text, activity labels, and error messages during agent work |
| Turn duration display | "Worked for Xm Ys" summary after turn completion |
| Rich transcript | Markdown, syntax highlighting, math, Mermaid, annotations, command output, file changes, and MCP progress |
| Skills and apps | Browse skills, inspect skill details, and use app integrations from the composer |
| Account and configuration | Account, rate-limit, model-provider, collaboration-mode, and configuration controls |
| Review and Git tooling | Start reviews and inspect local Git diffs and file history |

### Not Yet Implemented

Based on the app-server protocol (`documentation/APP_SERVER_DOCUMENTATION.md`), the following capabilities are available in the protocol but not yet surfaced in the UI:

| Feature | Relevant RPC Methods |
|---|---|
| Thread unarchiving | `thread/unarchive` |
| Manual context compaction | `thread/compact/start` |
| Command execution | `command/exec` |
| Experimental features | `experimentalFeature/list` |
| Terminal interaction | `item/commandExecution/terminalInteraction` notification |

## Communication Protocol

### HTTP Endpoints (Bridge)

| Method | Path | Purpose |
|---|---|---|
| POST | `/codex-api/rpc` | JSON-RPC proxy — forwards `{ method, params }` to app-server |
| POST | `/codex-api/server-requests/respond` | Reply to server-initiated requests |
| GET | `/codex-api/server-requests/pending` | List pending server requests |
| GET | `/codex-api/meta/methods` | Discover available RPC methods |
| GET | `/codex-api/meta/notifications` | Discover available notification types |
| GET | `/codex-api/events` | SSE fallback stream for real-time notifications |
| WS upgrade | `/codex-api/ws` | Primary WebSocket channel for real-time notifications |

### Bridge → App-Server

Communication uses newline-delimited JSON-RPC 2.0 over stdin/stdout of the `codex app-server` child process. The bridge:

1. Receives HTTP requests from the frontend
2. Translates them into JSON-RPC calls on stdin
3. Reads JSON-RPC responses from stdout
4. Forwards server-initiated requests to the frontend via SSE
5. Routes client responses back to the app-server

### RPC Methods Used by the Frontend

| Method | Purpose |
|---|---|
| `initialize` | Handshake with app-server (automatic) |
| `thread/list` | Fetch all non-archived threads |
| `thread/read` | Fetch thread detail with turns and items |
| `thread/start` | Create a new thread |
| `thread/resume` | Resume an inactive thread |
| `thread/archive` | Archive a thread |
| `thread/fork` | Fork a thread while preserving lineage |
| `thread/rollback` | Restore a thread to an earlier user turn |
| `thread/name/set` | Rename a thread |
| `turn/start` | Send a user message and start agent turn |
| `turn/interrupt` | Interrupt an in-progress turn |
| `model/list` | List available models |
| `config/read` | Read current model and reasoning effort |
| `config/batchWrite` | Persist configuration changes |
| `skills/list` | Discover local and remote skills |
| `collaborationMode/list` | Discover collaboration modes |
| `account/read` | Load account state and authentication requirements |
| `account/rateLimits/read` | Load current rate-limit windows |
| `review/start` | Start a code review turn |

### Notifications Handled by the Frontend

| Notification | Action |
|---|---|
| `turn/started` | Mark thread in-progress, show "Thinking" |
| `turn/completed` | Mark complete, show duration summary |
| `item/started` | Update activity label (Thinking / Writing) |
| `item/completed` | Finalize agent message or reasoning |
| `item/agentMessage/delta` | Append to live agent message text |
| `item/reasoning/summaryTextDelta` | Append to live reasoning overlay |
| `item/reasoning/summaryPartAdded` | Insert reasoning section break |
| `item/commandExecution/outputDelta` | Append frame-batched command output |
| `item/fileChange/outputDelta` | Append file-change output |
| `item/mcpToolCall/progress` | Update MCP tool progress |
| `turn/plan/updated` | Update the current plan |
| `turn/diff/updated` | Update the current turn diff |
| `thread/tokenUsage/updated` | Update token usage |
| `account/rateLimits/updated` | Update rate-limit windows |
| `server/request` | Show pending approval in UI |
| `server/request/resolved` | Remove resolved request from UI |
| `error` | Display error notification |
| `thread/name/updated` | (Queued for thread list refresh) |

## State Management

All frontend state is managed by `useDesktopState()` — a single Vue composable that provides:

### Reactive State

- `projectGroups` / `sourceGroups` — thread list grouped by project
- `selectedThreadId` / `selectedThread` — currently active thread
- `persistedMessagesByThreadId` — loaded messages from server
- `liveAgentMessagesByThreadId` — streaming agent messages
- `liveReasoningTextByThreadId` — streaming reasoning text
- `inProgressById` — per-thread turn-in-progress flags
- `availableModelIds` / `selectedModelId` / `selectedReasoningEffort`
- `pendingServerRequestsByThreadId` — approval requests
- `turnSummaryByThreadId` / `turnActivityByThreadId` / `turnErrorByThreadId`
- Loading/sending/interrupting boolean flags

### Persistence (localStorage)

| Key | Data |
|---|---|
| `codex-web-local.thread-read-state.v1` | Per-thread read timestamps |
| `codex-web-local.thread-scroll-state.v1` | Per-thread scroll positions |
| `codex-web-local.selected-thread-id.v1` | Last selected thread |
| `codex-web-local.project-order.v1` | Custom project ordering |
| `codex-web-local.project-display-name.v1` | Custom project names |
| `codex-web-local.auto-refresh-enabled.v1` | Auto-refresh preference |
| `codex-web-local.sidebar-collapsed.v1` | Sidebar collapse state |

### Event Processing Pipeline

1. Realtime events arrive via WebSocket on `/codex-api/ws` (fallback: `EventSource` on `/codex-api/events`)
2. Each event is passed to `applyRealtimeUpdates()` for immediate lifecycle effects; high-frequency text/output deltas are accumulated by thread and item and published at most once per animation frame
3. Events are also passed to `queueEventDrivenSync()` which debounces (220ms) a full data refresh
4. The debounced `syncFromNotifications()` calls `loadThreads()` and `loadMessages()` to reconcile server state

## Routing

| Route | Path | Behavior |
|---|---|---|
| Home | `/` | New thread creation view with folder selector |
| Thread | `/thread/:threadId` | Thread conversation view |
| Redirect | `/new-thread` | Redirects to Home |
| Fallback | `/:pathMatch(.*)*` | Redirects to Home |

Bidirectional sync between `selectedThreadId` state and URL is handled via Vue `watch`ers in `App.vue`.

## Development

### Prerequisites

- Node.js 20 or 22
- pnpm 11.10.0 (pinned in `packageManager`)
- `codex` CLI installed and in PATH

### Scripts

| Command | Description |
|---|---|
| `pnpm run dev` | Install deps + start Vite dev server (port 5173) |
| `pnpm run build` | Type-check + build frontend + build CLI |
| `pnpm run build:frontend` | `vue-tsc --noEmit && vite build` |
| `pnpm run build:cli` | `tsup` (builds CLI to `dist-cli/`) |
| `pnpm run check:bundle` | Enforce production entry and Markdown chunk budgets |
| `pnpm run ci` | Run unit tests, builds, and bundle budgets |
| `pnpm run preview` | Preview production build |

### Dev Mode

`pnpm run dev` installs dependencies and starts a Vite dev server that includes the codex bridge as middleware. The bridge spawns `codex app-server` as a child process. The frontend calls `/codex-api/*` endpoints on the same origin.

### Production Mode

```bash
npx codex-web-local [--port 5999] [--password mypass] [--no-password]
```

The CLI starts an Express server that serves the built frontend from `dist/` and uses the same bridge middleware. Password authentication is enabled by default. When a password is auto-generated, it is written to `$CODEX_HOME/codexui-password` with `0600` permissions and startup output prints only that file path.

### Auth (Production)

- Default: auto-generated password saved to `$CODEX_HOME/codexui-password` on startup
- Login: POST `/auth/login` with `{ password }` body
- Session: HttpOnly cookie `codex_web_local_token`
- Uses constant-time comparison to prevent timing attacks

## Design Principles

1. **Minimal dependencies**: Only essential packages — no state management library, no component library, no CSS framework beyond Tailwind
2. **Protocol-first**: The UI is designed around the Codex app-server protocol; all features map directly to RPC methods and notifications
3. **Offline-resilient**: localStorage persistence ensures the UI recovers gracefully from disconnections
4. **Reference equality optimization**: Extensive use of identity checks and shallow merging to minimize unnecessary Vue re-renders
5. **Explicit hot-path boundaries**: Shared rollout snapshots, runtime routing, startup request coalescing, stream batching, Markdown load policy, and local HTTP routes are independently testable boundaries around the larger UI state modules
