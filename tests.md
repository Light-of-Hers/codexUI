# Tests

This file tracks manual regression and feature verification steps.

### Feature: Paginated session message submission

#### Prerequisites
- App server is running from this repository.
- A historical thread is large enough for Codex to serve it through paginated turn history.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the paginated thread in light theme and wait for its latest messages to load.
2. Enter a short follow-up and send it.
3. Confirm the user message appears immediately and Codex starts a new turn.
4. Repeat steps 1-3 in dark theme.

#### Expected Results
- Sending does not issue a full `thread/read(includeTurns=true)` request merely to confirm that the thread is idle.
- The user message is visible and the new turn begins in both themes.

#### Rollback/Cleanup
- Stop or archive any disposable verification turn when finished.

### Feature: Browser font families

#### Prerequisites
- App server is running from this repository.
- Fira Sans, Fira Code, and 舟方日明 are installed in the browser environment; Calibri and Consolas are available as fallbacks.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the main application in light theme and inspect ordinary UI text in the browser's computed styles.
2. Confirm Latin text resolves to `Fira Sans` and falls back to `Calibri` when Fira Sans is unavailable; confirm Chinese text resolves to `舟方日明`.
3. Open a code block and the integrated terminal, then confirm their computed font family starts with `Fira Code`, falls back to `Consolas`, and uses `舟方日明` for Chinese glyphs.
4. Open a local file through the local browser/editor route and confirm its toolbar uses the sans-serif stack and its editor uses the monospace stack.
5. Inspect a standard UI label or button that uses the `font-medium` utility and confirm its computed font weight is `400`; confirm explicitly semibold/bold headings remain visually emphasized.
6. Repeat steps 1-5 in dark theme, including the authentication page when password protection is enabled.

#### Expected Results
- All ordinary browser-page text uses `Fira Sans`, then `Calibri`, with Chinese glyphs preferring `舟方日明`.
- UI elements using Tailwind's `font-medium` utility render at regular weight `400`; deliberate semibold and bold emphasis remains available.
- Code blocks, composer previews, terminals, and the local editor use `Fira Code`, then `Consolas`, with Chinese glyphs preferring `舟方日明`.
- The same font stacks are applied in light and dark themes without visual regressions.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Grouped command summary font

#### Prerequisites
- App server is running from this repository.
- A thread contains two or more consecutive command executions, so they render as a collapsed command group.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the thread in light theme and find the collapsed group labeled like `2 commands · latest: <command>`.
2. Inspect the summary and confirm only the latest-command portion is rendered by `code.cmd-group-latest-command`.
3. Confirm the count and `latest:` label retain the ordinary UI font while the command portion uses the shared monospace stack.
4. Expand and collapse the group, confirming its count, status, truncation, and click behavior are unchanged.
5. Repeat steps 1-4 in dark theme.

#### Expected Results
- The latest command uses `Fira Code`, then `Consolas`, with `舟方日明` as the Chinese-glyph fallback.
- The count and label remain in the standard UI typeface.
- The summary remains a single-line, clickable, truncated control in both themes.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Session fork runtime recovery

#### Prerequisites
- App server is running from this repository.
- Have a completed session created under a non-default provider, such as Cursor, Moon, or Ark.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the source session and ensure its completed response is visible.
2. Switch the new-session provider selection to a different provider without reopening the source session.
3. Use the session menu's `Fork` action and confirm that the new thread opens.
4. Return to the source session and use `Fork` from a completed assistant response; confirm that its branch opens.
5. Repeat steps 1-4 in light theme and dark theme.

#### Expected Results
- Both fork entry points create and open a new session even after the active provider changes.
- The fork inherits the source session's working directory and runtime configuration rather than failing because of stale browser-cached overrides.
- Theme changes do not affect the Fork controls or the resulting navigation.

#### Rollback/Cleanup
- Archive disposable forked sessions after verification.

## Template

### Feature: <name>

#### Prerequisites
- <required setup>

#### Steps
1. <action>
2. <action>

#### Expected Results
- <result>

#### Rollback/Cleanup
- <cleanup action, if any>

### Feature: Active turn running-state reconciliation

#### Prerequisites
- App server is running from this repository.
- A thread exists where Codex can run a slow enough task to observe the active turn state.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the thread in light theme and send a prompt that keeps the agent running for several seconds.
2. While the turn is running, confirm the composer shows the stop button when the draft is empty.
3. Confirm the same thread shows the circular running indicator in the sidebar.
4. Confirm the live overlay shows `Thinking` or the current activity label before assistant text is persisted.
5. Type a short follow-up while the turn is running and send it with the busy-send mode set to `Steer`.
6. Confirm the UI remains in the running state after the follow-up is sent.
7. In a thread that only receives a running `thread/status/changed` notification before a visible `turn/started` notification, confirm the composer stop button, sidebar running indicator, and `Thinking` overlay still appear.
8. Open a direct thread route before that thread is visible in the loaded sidebar page, send a prompt, and confirm the composer still switches from send to stop immediately.
9. On that direct thread route, set reasoning effort to `Extra High`, send a prompt, and confirm the composer still shows `Extra High` while the turn is running.
10. Confirm an interrupted/completed `thread/status/changed` notification clears the running state without waiting for a later full thread refresh.
11. Repeat the same flow in dark theme.
12. While a turn is running, queue a follow-up for the same thread and let the current turn complete.
13. Confirm the sidebar and composer stay in the running state until the queued follow-up has started.

#### Expected Results
- If `thread/read` briefly lags behind `turn/start`, the UI keeps the thread marked as running instead of reverting to idle.
- If a later detail refresh discovers an active turn while the local state was idle, the composer stop button, sidebar running indicator, and `Thinking` overlay all appear.
- If `turn/started` is missed but a running thread status notification arrives, the UI still marks the thread as running and uses the notification turn id for stop/steer.
- The composer stop button is driven by the selected thread's local running state, so it appears even when the selected session has not yet been merged into the sidebar list.
- Direct thread routes remain the active composer context even when the thread is not present in the loaded sidebar page, preserving per-thread settings such as `Extra High` reasoning effort.
- Terminal status notifications such as interrupted, completed, and failed clear the running indicators immediately.
- When a persisted follow-up is ready, the completed turn's terminal notifications are not shown as an idle interval before the follow-up begins.
- The follow-up prompt is sent as a steer message without hiding the active-turn controls.
- Light and dark theme controls remain readable.

#### Rollback/Cleanup
- Stop the test turn if it is still running.

### Feature: Historical session command rendering

#### Prerequisites
- App server is running from this repository.
- A historical thread exists whose session JSONL contains `exec_command` calls or custom `exec` wrappers that invoke `tools.exec_command(...)`, but whose stored `thread/read` turn items omit those commands.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the historical thread from the sidebar or by direct `#/thread/<id>` route.
2. Confirm command execution entries appear in the conversation at their original position between the surrounding user and assistant messages.
3. For a thread whose stored `thread/read` result has one merged assistant message, confirm command execution entries still appear between the matching assistant text fragments when the session JSONL preserves those fragments.
4. For a thread whose stored `thread/read` result already contains command execution entries grouped before the assistant text, confirm those existing command cards are reordered between the matching assistant text fragments.
5. For a thread that contains `response_item` entries after `task_complete`, confirm recovered command cards appear in the matching `rollout-*` section rather than the previous completed turn.
6. For a session with custom `exec` wrappers, confirm each wrapped `tools.exec_command(...)` is rendered as a command card with its command text, working directory, output, exit code, and duration.
7. For a Cursor-derived history whose `payload` filename differs from the embedded `call_id`, confirm each `Called Cursor tool` completion renders once, while its matching `Calling Cursor tool` and `Running`/`Ran` source records do not create duplicate cards.
8. For a session containing non-shell function calls such as `update_plan` or `write_stdin`, confirm each call renders once as a `Codex tool` card with input and output.
9. Load older messages in the same thread, if available, and confirm recovered command entries remain visible after pagination.
10. Switch to light theme and dark theme, then repeat the same thread rendering check.

#### Expected Results
- Historical `exec_command` calls and custom `exec` wrappers recovered from session JSONL render as command execution cards in `thread/read` results.
- Cursor shell commands and non-shell Cursor tool calls use the payload's canonical `call_id` for reconciliation, so each completed call has one card even when its payload filename is opaque.
- Other historical function calls render as `Codex tool` cards instead of being silently omitted.
- Command cards preserve command text, output, exit code, and duration when available.
- When session assistant text fragments can be matched to a merged stored assistant message, recovered command cards are interleaved between those fragments instead of being grouped before or after the whole message.
- Existing recovered command cards are reused and reordered instead of duplicated.
- Command cards recovered from orphan post-completion `response_item` entries stay with the matching synthesized `rollout-*` assistant messages.
- Recovered command entries stay ordered with the surrounding conversation items and are not dropped by older-message pagination.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Live turn output does not flicker away before persistence

#### Prerequisites
- App server is running from this repository.
- A thread is available where Codex can stream reasoning and run at least one command.
- Browser devtools Network panel is available.

#### Steps
1. Open the thread and send a prompt that causes a multi-step response with reasoning and a command.
2. While the turn is still running, watch the live reasoning, assistant text, and command card.
3. When assistant text starts after reasoning, confirm the previous live reasoning text remains visible during the active turn.
4. When the turn completes, watch the command card until the follow-up `thread/read` refresh finishes.
5. Repeat once in dark theme.

#### Expected Results
- Live reasoning is not cleared merely because assistant text starts streaming.
- Live command/tool cards remain visible after `turn/completed` until the persisted thread messages replace them.
- The conversation does not briefly collapse to only the newest thinking/status overlay before the final persisted output appears.

#### Rollback/Cleanup
- Stop any disposable test turn if it is still running.

### Feature: Incremental message-position reconciliation

#### Prerequisites
- App server is running from this repository.
- A thread can produce a user prompt, agent text, and an agent tool call in the same active turn.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the thread and send a prompt that starts with a short explanation, invokes a tool, and then produces another agent message.
2. Keep the thread open while its background message refresh runs; do not manually refresh the page.
3. Confirm the user message, tool-call card, and agent messages remain in their source order while the turn is active and after it completes.
4. Repeat steps 1-3 in dark theme.

#### Expected Results
- A background snapshot reconciliation does not move a user message, agent message, or tool-call card to the end of the turn.
- Refreshing the browser leaves the already-correct order unchanged.
- The order is stable and readable in both light and dark themes.

#### Rollback/Cleanup
- Stop or archive any disposable test turn after verification.

### Feature: Parallel custom-command history positioning

#### Prerequisites
- App server is running from this repository.
- A thread can run an agent task whose custom `exec` script issues at least three `tools.exec_command(...)` calls in parallel.
- The task produces an agent message before the commands and another agent message after them.
- Light and dark themes are both available from Settings.

#### Steps
1. In light theme, open the thread while the task is active and confirm its first agent message is visible.
2. Wait for the parallel commands to complete, then confirm their collapsed command group remains between the first and second agent messages.
3. Reload the browser while keeping the CodexUI server running and confirm the same command group stays in that position with the captured command output available.
4. Switch to dark theme and repeat steps 1-3 with another disposable task.

#### Expected Results
- Every nested command remains visible; a multi-command custom script does not collapse to one recovered command.
- Commands are grouped only when consecutive and never appear as one tail group after the final agent response.
- Light and dark themes preserve the existing command-group controls, output panels, and readable contrast.

#### Performance Audit
- The recovery parser scans each custom-tool script once and matches command items through bounded per-turn queues. It adds no request, polling loop, or client render pass.

#### Rollback/Cleanup
- Archive or delete any disposable verification thread after testing. No Codex configuration or session-log cleanup is required.

### Feature: GitHub-style local editor syntax highlighting

#### Prerequisites
- App server is running from this repository.
- A local source file is available, preferably TypeScript, Python, Rust, or Markdown.
- Light and dark themes are both available from the operating system or browser color-scheme setting.

#### Steps
1. Open the source file through the local edit route.
2. In light theme, confirm the editor uses a GitHub-like light surface with distinct keyword, string, comment, number, function, tag, and selection colors.
3. Switch to dark theme and reload or wait for the editor to react to the color-scheme change.
4. Confirm the editor switches to GitHub dark highlighting and the gutter, active line, cursor, and selection remain readable.
5. For a Markdown file, open `Preview` and confirm fenced code blocks use the same GitHub-style light and dark syntax colors.
6. Add a `<details><summary>More</summary>Hidden content</details>` block to the Markdown file and confirm preview renders it as a clickable collapse block.

#### Expected Results
- Local editor pages use `ace/theme/github` in light mode and `ace/theme/github_dark` in dark mode.
- Syntax highlighting is visibly richer than plain text in both themes.
- Markdown editor previews keep code fences readable and aligned with the selected color scheme.
- Markdown editor previews preserve safe collapse blocks while still removing unsafe HTML attributes and scripts.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Startup background refresh scheduling

#### Prerequisites
- App server is running from this repository.
- Browser devtools Network panel is available.
- At least one workspace root and one Git-backed project are available.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the app home route and hard-refresh the browser.
2. Confirm the thread list and composer become usable before Telegram, first-launch card, terminal status, and project suggestion requests finish.
3. In Network, confirm startup does not issue `/codex-api/git/repository-status` for every sidebar project.
4. In Network, confirm concurrent `/codex-api/workspace-roots-state` calls are coalesced to a single request during reload.
5. Open a project menu for a Git-backed project and confirm the Git status request is made lazily.
6. Switch to light theme and dark theme, then reopen the project menu.

#### Expected Results
- Startup keeps critical thread/provider loading ahead of non-critical settings and helper refreshes.
- Sidebar project Git checks do not fan out during page reload.
- The project menu still shows `New worktree` for Git projects after its lazy status check finishes.
- Light and dark project menus remain readable while the lazy menu item appears.

#### Rollback/Cleanup
- No cleanup is required.

### Asset: Conversation avatars are optimized

#### Prerequisites
- App server is running from this repository.
- A thread with conversation messages is available.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open the thread in light theme.
2. Confirm the agent and user avatars render in the conversation list.
3. Verify the avatar images still look crisp at the rendered size.
4. Switch to dark theme.
5. Confirm the same avatars still render correctly and remain legible against the dark UI surfaces.

#### Expected Results
- Conversation avatars render normally in both themes.
- The images remain visually sharp at the small display size.
- No layout shift or clipping appears around the avatar boxes.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Conversation markdown renderer loads after first paint

#### Prerequisites
- App server is running from this repository.
- A thread with markdown content is available, preferably including a code fence and a math expression.
- Browser devtools Network panel is available.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open the thread in light theme and reload the page.
2. Watch the Network panel during the refresh and confirm the conversation shell appears before the markdown renderer and KaTeX assets finish loading.
3. Confirm the first visible conversation content uses the lightweight fallback rendering and then upgrades to rich markdown after the async renderer loads.
4. Verify code fences still render with syntax highlighting after the enhancement finishes.
5. Verify math content renders correctly after KaTeX CSS is loaded.
6. Switch to dark theme and repeat the refresh check.

#### Expected Results
- First paint is no longer blocked on the full markdown/KaTeX renderer chunk.
- Rich markdown still appears after the lazy-loaded renderer finishes.
- Code blocks and math remain readable in both light and dark themes.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Composer helper lazy loading

#### Prerequisites
- App server is running from this repository.
- Browser devtools Network panel is available.
- At least one workspace folder is available for file mention checks.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the app home route and hard-refresh the browser.
2. Confirm the initial network burst no longer includes `markdownRenderer`, composer file mention, or composer skill mention modules.
3. Open the markdown preview in the composer and confirm the markdown renderer module loads only when preview is shown.
4. Select a workspace folder, type `@` and `$` mention prefixes in the composer, and confirm the file and skill mention helper modules load on demand.
5. Switch to light theme and dark theme, then repeat the preview and mention checks.

#### Expected Results
- The initial composer load avoids the markdown rendering stack and mention helper modules.
- Markdown preview still renders correctly after it is opened.
- File and skill mentions still work after their helper modules load lazily.
- Light and dark theme composer surfaces remain readable.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Markdown editor preview for local files

#### Prerequisites
- App server is running from this repository.
- A writable local `.md` file is available, or a temporary markdown file can be created under a test folder.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open a local markdown file through the local edit route.
2. Click `Preview` to open the rendered panel.
3. Confirm inline and block math render with proper KaTeX formatting, including subscript and superscript placement.
4. Switch to light theme and repeat the preview check.
5. Switch to dark theme and repeat the preview check.

#### Expected Results
- The preview panel renders markdown with the same KaTeX styling used by the main app.
- Formula fragments such as `$L_0$` keep their subscript spacing and do not collapse to plain `L0` text.
- The KaTeX MathML layer remains hidden, so rendered math is not duplicated by raw accessibility text.
- Light and dark preview surfaces both stay readable.

#### Rollback/Cleanup
- Delete any temporary markdown file created for the check.

### Feature: Thread heartbeat automations

#### Prerequisites
- App is running from this repository.
- At least one local thread exists in the sidebar.
- Local Codex home is writable (`$CODEX_HOME` or `~/.codex`).

#### Steps
1. Open the sidebar thread menu for a thread without an attached automation.
2. Confirm the menu shows `Add automation…`.
3. Click `Add automation…`.
4. Fill name, prompt, RRULE schedule, and set status to `Paused`.
5. Save the automation and reopen the same thread menu.
6. Confirm the menu now shows `Edit automation…` and the thread row shows an automation chip.
7. Open `Edit automation…`, confirm the saved values are prefilled, then remove the automation.

#### Expected Results
- Thread-scoped heartbeat automations are created under the Codex automations store and attached by `target_thread_id`.
- The automation editor is hosted from the thread menu and uses Codex.app wording.
- Removing the automation removes the thread row automation chip and returns the menu to `Add automation…`.

#### Rollback/Cleanup
- Remove any test automation from the thread automation dialog or delete its folder under `$CODEX_HOME/automations/<automation-id>/`.

### Feature: Projectless new chat folders

#### Prerequisites
- App server is running from this repository.
- Home directory is writable.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the app in light theme and click the sidebar `New chat` action while an existing thread is selected.
2. Confirm the home composer does not inherit the selected thread folder.
3. Send a first message with a unique prompt such as `Projectless folder smoke test`.
4. Confirm the new thread starts in `~/Documents/Codex/<YYYY-MM-DD>/projectless-folder-smoke-test`.
5. Start another new chat with the same prompt and confirm the folder receives a numeric suffix.
6. Switch to dark theme and repeat steps 1-3 with a different unique prompt.

#### Expected Results
- `New chat` starts as a projectless chat instead of reusing the current thread cwd.
- Sending the first message creates a real directory under `~/Documents/Codex/<YYYY-MM-DD>/`.
- Folder names are derived from the prompt using lowercase alphanumeric tokens, with suffixes for duplicates.
- Projectless chat rows appear in the `Chats` section and do not create a separate project group from the generated folder name.
- Short projectless prompts such as `hi` remain visible in `Chats` after the thread list refreshes and workspace-root filtering runs.
- If the selected model returns `requires a newer version of Codex`, the turn retries with `gpt-5.4-mini` instead of leaving the new chat failed on 5.5.
- Light and dark theme composer surfaces remain readable and unchanged apart from the folder behavior.

#### Rollback/Cleanup
- Delete only the test folders created under `~/Documents/Codex/<YYYY-MM-DD>/`.

### Feature: Empty project new thread action

#### Prerequisites
- App server is running from this repository.
- At least one workspace root is registered that has no threads.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the app in light theme.
2. Find the empty project row in the sidebar that shows `No threads`.
3. Click that project's new thread icon.
4. Confirm the home composer opens and the folder dropdown is set to the empty project's workspace root.
5. Switch to dark theme and repeat steps 2-4.

#### Expected Results
- The new thread icon works for projects with zero threads.
- The new thread screen uses the clicked project's registered workspace root instead of leaving the folder blank or reusing another project.
- Light and dark theme sidebar and composer surfaces remain readable.

#### Rollback/Cleanup
- No cleanup is required unless a test message is sent; delete that test thread if created.

### Feature: Start new thread header Git branch dropdown

#### Prerequisites
- App server is running from this repository.
- At least one Git-backed workspace folder is available in the Start new thread folder dropdown.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the app in light theme.
2. Click the sidebar or header new thread icon to open Start new thread.
3. Select a Git-backed folder.
4. Confirm the header actions next to the terminal control show the Git checkout branch dropdown.
5. Open the branch dropdown and confirm branch search/options are available.
6. Switch to dark theme and repeat steps 2-5.

#### Expected Results
- Start new thread shows the same header Git checkout dropdown used by existing thread pages when the selected folder is a Git repository.
- Switching the selected folder updates the dropdown branch state for that folder.
- Non-Git folders do not show the Git checkout dropdown.
- Light and dark theme header controls remain readable and aligned.

#### Rollback/Cleanup
- If a branch was switched during testing, switch back to the original branch before continuing.

### Feature: Telegram bot token stored in dedicated global file

#### Prerequisites
- App server is running from this repository.
- A valid Telegram bot token is available.
- At least one Telegram user ID is available for allowlisting.
- Access to `~/.codex/` on the host machine.

#### Steps
1. In the app UI, open Telegram connection and submit a bot token plus one or more allowed Telegram user IDs.
2. Verify file `~/.codex/telegram-bridge.json` exists.
3. Open `~/.codex/telegram-bridge.json` and confirm it contains `botToken` and `allowedUserIds` fields.
4. Restart the app server and call Telegram status endpoint from UI to confirm it still reports configured.

#### Expected Results
- Telegram token is persisted in `~/.codex/telegram-bridge.json`.
- Telegram allowlisted user IDs are persisted in `~/.codex/telegram-bridge.json`.
- Telegram bridge remains configured after restart.

#### Rollback/Cleanup
- Remove `~/.codex/telegram-bridge.json` to clear saved Telegram token.

### Feature: Telegram chatIds persisted for bot DM sending

#### Prerequisites
- App server is running from this repository.
- Telegram bot already configured in the app.
- Access to `~/.codex/telegram-bridge.json`.

#### Steps
1. Send `/start` to the Telegram bot from your DM.
2. Wait for the app to process the update, then open `~/.codex/telegram-bridge.json`.
3. Confirm `chatIds` contains your DM chat id as the first element.
4. In the app, reconnect Telegram bot with the same token.
5. Re-open `~/.codex/telegram-bridge.json` and confirm `chatIds` remains present.

#### Expected Results
- `chatIds` is written after Telegram DM activity.
- `chatIds` persists across bot reconfiguration.
- `botToken`, `chatIds`, and `allowedUserIds` are all present in `~/.codex/telegram-bridge.json`.

#### Rollback/Cleanup
- Remove `chatIds` or delete `~/.codex/telegram-bridge.json` to clear persisted chat targets.

### Feature: Telegram bridge rejects unauthorized senders

#### Prerequisites
- App server is running from this repository.
- Telegram bot is configured with a known `allowedUserIds` entry.
- One Telegram account is allowlisted and one separate Telegram account is not.

#### Steps
1. From the allowlisted Telegram account, send `/start` to the bot.
2. Confirm the bot responds normally.
3. From the non-allowlisted Telegram account, send `/start` to the same bot.
4. From the non-allowlisted account, send a normal text prompt.

#### Expected Results
- The allowlisted account can use the Telegram bridge normally.
- The non-allowlisted account receives an unauthorized response.
- No thread is created or updated for the non-allowlisted account.

#### Rollback/Cleanup
- Remove test chat mappings from `~/.codex/telegram-bridge.json` if needed.

### Feature: Skills dropdown closes after selection in composer

#### Prerequisites
- App is running from this repository.
- At least one thread exists and can be selected.
- At least one installed skill is available.

#### Steps
1. Open an existing thread so the message composer is enabled.
2. Click the `Skills` dropdown in the composer footer.
3. Click any skill option in the dropdown list.
4. Re-open the `Skills` dropdown and click the same skill again to unselect it.

#### Expected Results
- The skills dropdown closes immediately after each selection click.
- Selected skill appears as a chip above the composer input when checked.
- Skill chip is removed when the skill is unchecked on the next selection.

#### Rollback/Cleanup
- Remove the selected skill chip(s) before leaving the thread, if needed.

### Feature: Composer $ skill autocomplete

#### Prerequisites
- App is running from this repository.
- At least one installed skill is available.
- A thread composer is visible and editable.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open an existing thread in light theme.
2. Click into the composer input and type `$` followed by part of an installed skill name.
3. Confirm the skill suggestion popup appears under the input.
4. Use Arrow keys or click a suggestion.
5. Confirm the chosen skill token is inserted directly into the input, with the cursor placed after it, like `@` path completion.
6. Submit the message and confirm the turn starts normally.
7. Switch to dark theme and repeat steps 2 through 6.

#### Expected Results
- Typing `$` opens a skill suggestion list filtered from the installed skills.
- Selecting a skill writes the chosen `$skill` text back into the composer instead of only setting footer state.
- The inserted skill token stays in the draft until the user edits it or sends the message.
- Light and dark autocomplete surfaces remain readable and the active row highlight is visible in both themes.

#### Rollback/Cleanup
- Clear the draft or switch threads if you do not want to keep the test message.

### Feature: Composer path autocomplete inserts ./

#### Prerequisites
- App is running from this repository.
- At least one installed skill is available.
- A thread composer is visible and editable.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open an existing thread in light theme.
2. Click into the composer input and type `@` followed by part of an existing file path.
3. Confirm the file suggestion popup appears under the input.
4. Pick a suggestion with Enter, Tab, or mouse click.
5. Confirm the chosen path is inserted as `./...` in the input, not `@...`.
6. Submit the message and confirm the file attachment is still recognized.
7. Switch to dark theme and repeat steps 2 through 6.

#### Expected Results
- Typing `@` still opens the file suggestion list.
- Selecting a path replaces the trigger with `./` in the draft text.
- The submitted turn still treats the inline path as a file attachment.
- Light and dark autocomplete surfaces remain readable and the active row highlight is visible in both themes.

#### Rollback/Cleanup
- Clear the draft or switch threads if you do not want to keep the test message.

### Feature: Skills Hub local-only installed skills

#### Prerequisites
- App is running from this repository.
- Open the `Skills Hub` view.

#### Steps
1. Open `Skills Hub`.
2. Confirm the page shows only locally installed skills.
3. Confirm there is no remote skill count such as `6818 skills`.
4. Confirm there are no remote browse cards from the OpenClaw catalog.

#### Expected Results
- Skills Hub does not fetch or display the OpenClaw remote skills catalog.
- Only locally installed skills are shown.
- No remote total-count badge is rendered.

#### Rollback/Cleanup
- None.

---

### Unread thread cutoff state

#### Feature/Change Name
Unread thread state uses a local cutoff timestamp so existing threads are not all marked unread after first load.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`).
2. Browser localStorage is available for the app origin.
3. At least two existing threads are present.
4. Light theme and dark theme are available from the appearance switcher.

#### Steps
1. Clear only `codex-web-local.thread-unread-cutoff.v1` from localStorage for the app origin.
2. Load the app in light theme.
3. Confirm existing threads are not all marked unread on first load.
4. Create or receive an update in a different thread after the app has loaded.
5. Confirm that updated thread can show unread when it is not selected or in progress.
6. Create or receive an update in a second unselected thread.
7. Open the first updated thread and confirm only that thread's unread indicator clears.
8. Confirm the second updated thread remains unread until it is opened.
9. Switch to dark theme and repeat steps 4 through 8.

#### Expected Results
- Missing cutoff state initializes to the current time instead of treating every thread as unread.
- Threads updated after the cutoff can still become unread.
- Opening a thread updates only that thread's read state and clears only that thread's unread indicator.
- Unread indicators remain readable in both light theme and dark theme.

#### Rollback/Cleanup
- Remove any disposable test threads created for this validation.

---

### CLI password output redaction

#### Feature/Change Name
CLI startup output no longer prints the configured password or embeds it in the tunnel URL.

#### Prerequisites/Setup
1. Project dependencies are installed.
2. CLI build is available from the current branch.

#### Steps
1. Run `pnpm run build:cli`.
2. Start the CLI with a disposable password: `node dist-cli/index.js --no-tunnel --no-open --port 5998 --password TEST_SECRET_SHOULD_NOT_PRINT`.
3. Confirm startup output includes the local and network URLs.
4. Confirm startup output does not include `Password:` or `TEST_SECRET_SHOULD_NOT_PRINT`.
5. Start the CLI without an explicit password and confirm startup output prints `Generated password file:` with a path under `$CODEX_HOME`.
6. Confirm the generated password file exists, is readable by the current user, and has `0600` permissions.
7. If tunnel testing is available, start with tunnel enabled and confirm the printed tunnel URL and QR code do not include `/password=`.

#### Expected Results
- Password-protected startup still works.
- The password is not printed as a standalone line.
- Auto-generated passwords remain discoverable through the generated password file path.
- Tunnel output does not include an autologin URL containing the password.

#### Rollback/Cleanup
- Stop the disposable CLI process.

---

### Composer skill chip opens SKILL.md

#### Feature/Change Name
Selected skill labels in the thread composer open that skill's `SKILL.md` in the web file browser.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least one installed skill is available in the composer skill picker
3. Browser pop-ups from the local dev origin are allowed
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open any thread with the composer enabled.
2. Open the `Skills` picker and select an installed skill.
3. Confirm the selected skill appears as a green chip above the input field.
4. Click the skill name on the green chip.
5. Confirm a new tab opens to `/codex-local-browse.../SKILL.md` for that skill.
6. Return to the composer and click the chip `x`.
7. Confirm the skill is removed and no file-browser tab is opened by the remove action.
8. Switch to dark theme and repeat steps 2 through 7.

#### Expected Results
- The skill chip label is clickable and opens the selected skill's `SKILL.md` in the web file browser.
- Skill paths that point at a skill directory are normalized to the nested `SKILL.md` file.
- The remove button still only removes the skill from the composer.
- The chip and focus/hover states remain readable in light theme and dark theme.

#### Rollback/Cleanup
- Close any file-browser tabs opened during validation.

---

### npx run dev compatibility shim

#### Feature/Change Name
The accidental `npx run dev` command starts the repository dev wrapper instead of failing with a missing `dev` module.

#### Prerequisites/Setup
1. Run from the repository root.
2. Local dependencies are available, or the dev wrapper can install them with `pnpm install`.
3. Port 5173 is free, or Vite can select the next available port.

#### Steps
1. Run `npx run dev`.
2. Confirm the command reaches the existing `scripts/dev.cjs` wrapper and starts Vite.
3. Stop the dev server with Ctrl-C.
4. Repeat with `npx run dev --host 127.0.0.1 --port 4173`.

#### Expected Results
- `npx run dev` no longer fails with `Cannot find module '<repo>/dev'`.
- The command starts the same dev server path as `npm run dev` / `pnpm run dev`.
- Host and port arguments are passed through to Vite.

#### Rollback/Cleanup
- Stop any dev server process started for validation.

---

### Skills sync idempotent commits and nested shared skills handling

#### Feature/Change Name
Skills Sync skips unchanged manifest writes and does not fail parent commits when only nested `shared_skills` content is dirty.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 5173`)
2. GitHub Skills Sync is connected to a private skills sync repo
3. `/Users/igor/.codex/skills/shared_skills` exists as a nested Git repository
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open `#/skills`.
2. Click `Startup Sync` when no installed skills manifest content has changed.
3. Confirm the sync completes without adding a new `Update synced skills manifest` commit to the GitHub repo.
4. Modify a file inside `/Users/igor/.codex/skills/shared_skills` without committing it inside that nested repository.
5. Click `Push` or `Startup Sync` again.
6. Confirm the sync does not show `Command failed (git commit -m Sync installed skills folder and manifest)` for the parent `/Users/igor/.codex/skills` repository.
7. Confirm the startup auto-push path skips when the only local status is dirty nested `shared_skills` content and local `HEAD` equals `origin/main`.
8. Switch to dark theme and repeat steps 1, 2, and 5.

#### Expected Results
- Unchanged `installed-skills.json` content is not written back to GitHub, so repeated empty-looking manifest commits are not created.
- A dirty nested `shared_skills` repository does not make the parent skills sync fail with `no changes added to commit`.
- Dirty nested `shared_skills` content alone does not keep triggering no-op startup push work.
- Skills Sync status, errors, and action buttons remain readable in light theme and dark theme.

#### Rollback/Cleanup
- Revert or commit the intentional test edit inside `/Users/igor/.codex/skills/shared_skills`.

---

### Header Git branch dropdown with commit reset

#### Feature/Change Name
Thread header Git dropdown replaces the simple review action with branch search, Review access, safe branch switching, branch reset-to-commit, and reset-history commit preservation.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a thread whose `cwd` is inside a Git repository with at least two branches and several commits
3. Use a disposable local branch with at least two commits ahead of its reset target.
4. Ensure the repository has no tracked uncommitted changes for successful branch switch/reset paths: `git -C <thread-cwd> status --porcelain`
5. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open the Git dropdown in the thread header.
2. Confirm the trigger shows the current branch, or the detached commit subject if the repository is already detached.
3. Click `Review` and confirm the review pane opens; click it again and confirm the pane toggles.
4. Type part of a branch name in search and confirm the branch list filters.
5. Select a different branch with a clean worktree and confirm the header updates to that branch.
6. Expand a branch row and confirm recent commits load with short SHA, subject, and date.
7. Expand a remote branch row and confirm its commit rows are disabled with a tooltip explaining remote branches cannot be reset.
8. Select an older commit on the disposable local branch and confirm the header stays on that branch instead of entering detached HEAD.
9. Confirm `git -C <thread-cwd> rev-parse --abbrev-ref HEAD` still prints the branch name and `git -C <thread-cwd> rev-parse --short HEAD` matches the selected commit.
10. Reopen/expand the same branch and confirm commits that were ahead of the reset target still appear, with the selected branch HEAD marked `current`.
11. Repeat reset on the same branch several times and confirm the dropdown still opens quickly and shows recent reset-history commits.
12. Create a tracked uncommitted change, try to switch branch or reset to a commit, and confirm the dropdown shows a dirty-worktree error instead of switching or resetting.
13. Create only an untracked file, try to reset to a commit, and confirm the reset proceeds unless Git reports the untracked file would be overwritten.
14. Switch to dark theme and repeat steps 1, 2, 4, 6, 7, 10, 12, and 13.

#### Expected Results
- The header dropdown exposes Review, current checkout state, searchable branches, and inline commits.
- Branch switching and branch reset-to-commit are blocked by tracked uncommitted changes, but untracked-only changes are allowed unless Git would overwrite them.
- Commit selection resets the local branch to that commit instead of detaching HEAD.
- Remote branch commit rows are inspectable but cannot trigger local branch reset.
- The branch commit list still shows commits that were ahead of the reset target by reading saved internal reset-history refs.
- Reset-history refs are bounded so repeated resets do not grow commit-list inputs without limit.
- The selected branch HEAD commit is marked `current` in expanded commit lists.
- Loading and error messages remain visible in the dropdown without using browser alerts.
- Dropdown surfaces, text, badges, and errors are readable in both light theme and dark theme.

#### Rollback/Cleanup
- Restore any dirty-worktree file changed for validation.
- Restore or delete the disposable branch used for reset validation.

---

### Termux install without native PTY build

#### Feature/Change Name
Android Termux installs can complete when `node-pty` has no compatible native build.

#### Prerequisites/Setup
1. Android device or emulator with Termux installed.
2. Node.js and npm available in Termux.
3. Network access to npm and GitHub.
4. A macOS or Linux desktop remains available for supported-host integrated terminal checks.
5. Light theme and dark theme are available from the appearance switcher on the desktop check.

#### Steps
1. In Termux, run `npm i -g codexapp@latest` after the fixed version is published.
2. Confirm installation does not fail if npm cannot build `node-pty` for `android-arm64`.
3. Run `codexapp --no-login` in Termux.
4. Open the printed URL and confirm the app loads.
5. Open a thread and confirm the integrated terminal reports unavailable instead of crashing the server if native PTY support is missing.
6. On macOS or Linux, run `npm i -g codexapp@latest`, then start `codexapp --no-login`.
7. Open a thread in light theme and confirm the integrated terminal still opens on the supported host.
8. Switch to dark theme and confirm the integrated terminal remains readable.

#### Expected Results
- Termux install completes even when `node-pty` cannot build on Android.
- The Termux app server starts and the browser UI loads.
- Missing native PTY support disables only the integrated terminal, not the whole app.
- Supported hosts still install `node-pty` and keep integrated terminal behavior in light theme and dark theme.

#### Rollback/Cleanup
- Remove test global installs with `npm rm -g codexapp`.

---

### Composer controls stay editable during responses

#### Feature/Change Name
Model, skill, thinking, and plan controls remain usable while a thread turn is in progress.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A thread that can produce a long enough response to interact with the composer while the assistant is responding
3. At least one installed skill or saved prompt
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, send a message that starts an assistant response.
2. While the response is still streaming, type a follow-up draft in the composer.
3. Open the model dropdown and select a different model.
4. Open the skills dropdown and select a skill or saved prompt.
5. Open the thinking dropdown and select a different value.
6. Open the attachment menu and toggle plan mode.
7. Verify the stop button and send/queue behavior still match the in-progress turn state.
8. Switch to dark theme and repeat steps 1 through 7.

#### Expected Results
- The message textarea remains editable while the assistant is responding.
- Model, skills, thinking, and plan controls are not disabled during the in-progress response.
- Selected controls update the composer state for the next submitted or queued message.
- Stop remains available while no draft content is present, and the submit button switches to the configured steer/queue behavior when draft content exists.
- Light-theme and dark-theme controls remain readable and do not overlap.

#### Rollback/Cleanup
- Remove any disposable queued messages or test skill selections from the thread.

### Feature: Remove GitHub trending projects from the new-thread screen

#### Prerequisites
- App is running from this repository.
- Home/new-thread screen is open.
- Any previously saved local storage value for `codex-web-local.github-trending-projects.v1` may still exist from older builds.

#### Steps
1. Open Settings and inspect the available rows.
2. Confirm there is no `GitHub trending projects` toggle.
3. Return to the home/new-thread screen and confirm no trending cards or scope dropdown are shown.
4. Refresh the page and confirm the UI stays unchanged even if the old local storage key exists.

#### Expected Results
- Settings no longer offers any GitHub trending projects preference.
- The home/new-thread screen no longer renders a trending projects section.
- Refreshing does not restore the removed feature from stale local storage.

#### Rollback/Cleanup
- None.

### Feature: Dark theme for worktree runtime selector and Skills Hub

#### Prerequisites
- App is running from this repository.
- Appearance is set to `Dark` in Settings.
- Skills Hub route is accessible.

#### Steps
1. Open the home/new-thread screen and inspect the `Local project / New worktree` runtime selector trigger.
2. Open the runtime selector and verify menu title, options, selected state, and checkmark visibility in dark mode.
3. Trigger a worktree action that shows worktree status and verify running/error status blocks remain readable in dark mode.
4. Open `Skills Hub` and verify header/subtitle, search bar, search/sort buttons, sync panel, badges, and status text.
5. Verify at least one skill card surface (title, owner, description, date, browse icon) in dark mode.
6. Open a skill detail modal and verify panel, title/owner, close button, README/body text, and footer actions in dark mode.

#### Expected Results
- Runtime dropdown trigger and menu use dark backgrounds, borders, and readable text/icons.
- Worktree status blocks use dark-friendly contrast for both running and error states.
- Skills Hub controls and sync panel are fully dark-themed with consistent hover/active states.
- Skill cards and the skill detail modal render with dark theme colors and accessible contrast.

#### Rollback/Cleanup
- Reset appearance to the previous user preference.

### Feature: Markdown file links with backticked filename labels render correctly

#### Prerequisites
- App is running from this repository.
- An active thread is open.
- Light and dark themes are both available.
- Local file exists at `/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt`.

#### Steps
1. In light theme, send a message containing: `Added [`TrustedBrowserLauncher.kt`](/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt)`.
2. Confirm the rendered message shows one clickable file link with visible text `TrustedBrowserLauncher.kt`.
3. Click the link and confirm it opens the local editor for `/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt`.
4. Right-click the same link and choose `Copy link`, then paste it into a text field and inspect it.
5. Switch to dark theme and repeat steps 1-4.

#### Expected Results
- The markdown link renders as one clickable file link instead of splitting around backticks.
- The visible link text is the markdown label `TrustedBrowserLauncher.kt`, without backtick glyphs.
- Clicking opens the local browse route for the full file path.
- Copied link includes the full encoded path and still resolves to the same file.
- Light and dark theme message surfaces keep the link readable and styled consistently.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Deferred ancillary startup refreshes

#### Prerequisites
- App is running from this repository.
- At least one large existing thread is available in the sidebar.
- Browser runtime profiler can run with Playwright from this repository.

#### Steps
1. Open a large thread route directly, for example `#/thread/<thread-id>`.
2. Confirm the thread message history appears before non-critical metadata finishes refreshing.
3. Run `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_ROUTE="#/thread/<thread-id>" PROFILE_WAIT_MS=7000 node scripts/profile-browser-runtime.cjs`.
4. Open the generated JSON report under `output/playwright/`.
5. Inspect `slowestApiRows` and `duplicateCounts`.

#### Expected Results
- The selected thread uses exactly one `thread/resume` and zero `thread/read` calls during initial load.
- Direct thread route hydration has one owner and does not trigger duplicate selected-thread message loads from route watchers.
- Thread history loading is not blocked by waiting for `skills/list`, `account/rateLimits/read`, or `collaborationMode/list`.
- Skills, model metadata, rate limits, and collaboration modes still populate shortly after the thread is visible.
- The profiler report has no duplicate-load warnings.

#### Rollback/Cleanup
- Remove generated `output/playwright/browser-runtime-profile-*` artifacts if they are not needed for comparison evidence.

### Feature: Runtime selector uses a toggle-style control

#### Prerequisites
- App is running from this repository.
- Home/new-thread screen is open.

#### Steps
1. On the home/new-thread screen, locate the runtime control below `Choose folder`.
2. Verify both options (`Local project` and `New worktree`) are visible at once without opening a menu.
3. Click `New worktree` and confirm it becomes the selected option style.
4. Click `Local project` and confirm selection returns.
5. Set Appearance to `Dark` in Settings and verify selected/unselected contrast remains readable.

#### Expected Results
- Runtime mode is presented as a two-option toggle (segmented control), not a dropdown menu.
- Clicking each option immediately switches the selected state.
- Selected option has a distinct active background/border in both light and dark themes.

#### Rollback/Cleanup
- Leave runtime mode and appearance at the previous user preference.

### Feature: Dark theme states for runtime mode toggle

#### Prerequisites
- App is running from this repository.
- Home/new-thread screen is open.
- Appearance is set to `Dark` in Settings.

#### Steps
1. Locate the runtime mode toggle (`Local project` and `New worktree`) under `Choose folder`.
2. Hover each option and verify hover state is visible against dark backgrounds.
3. Select `New worktree`, then select `Local project` and compare active/inactive contrast.
4. Tab to the toggle options with keyboard navigation and verify the focus ring is visible.
5. Confirm icon color remains readable for selected and unselected options.

#### Expected Results
- Toggle container, options, and text/icons use dark-friendly colors.
- Hover and selected states are clearly distinguishable in dark mode.
- Keyboard focus ring is visible and does not blend into the background.

#### Rollback/Cleanup
- Return appearance and runtime selection to the previous user preference.

### Feature: Per-thread model selection

#### Prerequisites
- App is running from this repository against a Codex app-server that supports thread-scoped model persistence.
- At least two selectable models are available in the composer model picker.
- At least one existing thread is available, or you can create one during the test.

#### Steps
1. On the new-thread screen, choose model `A` in the composer.
2. Send a message to create a new thread.
3. In that thread, switch the composer model to model `B`.
4. Send another message in the same thread so the thread persists model `B`.
5. Create or open a different thread and set its model to model `A`.
6. Switch back and forth between the two threads.
7. Refresh the browser while one of the threads is selected.
8. Re-open both threads again after the refresh.
9. While thread `A` is selected, use the sidebar thread menu to fork thread `B`.
10. Open the forked thread and confirm the composer model matches thread `B`, not the currently selected thread.
11. Restart the app-server or otherwise force a model-list refresh that does not include one thread’s persisted model, then switch back to that thread.
12. Delete one of the test threads you changed, refresh the thread list, and continue switching between the remaining thread and the new-thread screen.

#### Expected Results
- Each thread restores its own last selected model when you switch threads.
- The new-thread screen keeps its own draft model selection instead of inheriting the last opened thread.
- After browser refresh, reopening a thread restores the model persisted for that thread.
- Forked or newly created threads keep the resolved model returned by Codex, including fallback to the supported default model when needed.
- Forking a nonselected thread from the sidebar uses that source thread’s persisted model.
- If the selected thread’s persisted model is not returned in the latest model list, the composer still shows that model as the active selection instead of falling back to the placeholder label.
- Removing a thread prunes its saved per-thread model state, and model selection continues to update normally for the remaining threads without runtime errors.

#### Rollback/Cleanup
- Reset each tested thread back to its original model selection if you changed an existing conversation for the test.

### Feature: Sandbox approval requests recognize newer Codex payloads

#### Prerequisites
- App is running from this repository with a Codex CLI/app-server version that can request approvals.
- `bubblewrap` is installed so sandboxed command approvals can be triggered.
- Approval policy is set to request approval on sandbox escalation.

#### Steps
1. Start a thread and ask Codex to run a command that requires approval outside the current sandbox.
2. Wait for the pending request panel to appear.
3. Confirm the request is shown as an approval prompt, not the generic fallback with `Return Empty Result` and `Reject Request`.
4. Verify the panel offers approval choices (`Yes`, `Yes for Session`, decline text field, `Skip`).
5. If the approval payload includes a command preview or writable root, verify that preview text is shown in the panel.

#### Expected Results
- Sandbox-related approval requests are classified as approvals even when Codex sends newer method or payload variants.
- The approval UI offers normal approval actions instead of the unknown-request fallback buttons.
- The request stays attached to the correct thread rather than only appearing as a global pending request.

#### Rollback/Cleanup
- Decline or skip the pending approval request after verification.

### Feature: MCP elicitation requests and thread status labels

#### Prerequisites
- App is running from this repository with a recent Codex CLI/app-server build.
- At least one configured MCP server can trigger `mcpServer/elicitation/request` or `item/permissions/requestApproval`.

#### Steps
1. Start a thread and trigger an MCP flow that asks for user input or permission approval.
2. Confirm the thread row status chip in the sidebar appears in English (`Awaiting approval` or `Awaiting response`).
3. Open the pending request panel for `mcpServer/elicitation/request`.
4. Confirm only the black pending-request panel is shown for the request; no duplicate yellow in-conversation request card should appear.
5. If the elicitation is `form` mode, verify the requested fields are rendered as inputs/selects/checkboxes based on the schema.
6. For a required form field that has no schema default, click `Continue` without answering it and verify the request stays open with a validation error instead of submitting a fabricated answer.
7. For an optional boolean or enum field that has no schema default, verify the control starts unselected rather than prefilled with `False` or the first enum option.
8. If the elicitation is `url` mode, verify an authorization link is shown only when the URL uses `http` or `https`.
9. Submit `Continue`, then repeat and verify `Decline` and `Cancel` are also available.
10. Trigger an `item/permissions/requestApproval` request and verify `Accept` and `Accept for Session` are shown instead of the generic fallback buttons.

#### Expected Results
- MCP elicitation requests no longer fall back to `Return Empty Result` / `Reject Request`.
- Pending requests are shown only once, in the dedicated black pending-request panel.
- Form-mode elicitation requests submit structured `{ action, content }` responses.
- Required MCP form fields without defaults must be answered explicitly before the request can be accepted.
- Optional MCP boolean/enum fields without defaults remain unset until the user chooses a value.
- URL-mode elicitation requests show an authorization link and submit a valid `{ action }` response.
- Non-HTTP(S) authorization URLs are not rendered as clickable links.
- Permissions approval requests submit proper permission grants with turn/session scope.
- Sidebar pending-request chips are displayed in English.

#### Rollback/Cleanup
- Decline or cancel the MCP request after verification, and close any opened authorization URL if it was only used for testing.

### Feature: pnpm dev script installs dependencies and starts Vite

#### Prerequisites
- `pnpm` is available on PATH.
- Port `5373` is free, or choose another disposable port for the smoke check.

#### Steps
1. Run `node -c scripts/dev.cjs`.
2. Run `timeout 6s codex-ui-dev --host 127.0.0.1 --port 5373`.
3. Confirm the startup command line prints `node scripts/dev.cjs --host 127.0.0.1 --port 5373`, without a leading standalone `--`.
4. Confirm Vite reports `http://127.0.0.1:5373/`, not the default `5173`.
5. Run `timeout 6s pnpm run dev --host 127.0.0.1 --port 5373` and confirm the same port behavior.

#### Expected Results
- The generated `codex-ui-dev` launcher forwards flags through `pnpm run dev` without adding a literal `--` to `scripts/dev.cjs`.
- `scripts/dev.cjs` defensively strips a leading standalone `--` if another caller still provides one.
- Vite receives `--host` and `--port` as real flags and binds the requested port.

#### Performance Audit
- Argument normalization is a constant-time check of the first passthrough argument.
- The launcher change does not add filesystem scans, dependency installs, network calls, or extra child processes.

#### Rollback/Cleanup
- Stop the temporary dev server after the smoke check.

### Feature: Tailscale CIDRs bypass password and Cloudflare tunnel is opt-in

#### Prerequisites
- App is running from this repository via CLI.
- A Tailscale client can reach the host over Tailscale IPv4 (`100.64.0.0/10`) or IPv6 (`fd7a:115c:a1e0::/48`).
- `cloudflared` is installed only if testing `--tunnel`.

#### Steps
1. Start CLI without tunnel flag: `npx codexapp --port 5900`.
2. From a Tailscale client, open `http://100.x.x.x:5900` using a host address in `100.64.0.0/10` (replace with host tailnet IP).
3. Confirm the app opens directly without the password login page.
4. (Optional IPv6 check) Open the same service using the host Tailscale IPv6 address in `fd7a:115c:a1e0::/48` and confirm it also bypasses password.
5. Stop the server and start again with tunnel enabled: `npx codexapp --port 5900 --tunnel`.
6. Confirm startup output now includes a `Tunnel:` URL only when `--tunnel` is provided.
7. Stop and restart once more without `--tunnel`, and verify no tunnel URL is printed.

#### Expected Results
- Requests from Tailscale IPv4 `100.64.0.0/10` are treated as trusted and do not require password sign-in.
- Requests from Tailscale IPv6 `fd7a:115c:a1e0::/48` are treated as trusted and do not require password sign-in.
- Cloudflare tunnel does not start by default.
- Cloudflare tunnel starts only when `--tunnel` is explicitly passed.

#### Rollback/Cleanup
- Stop the CLI process.
- If a cloudflared tunnel was started, ensure the tunnel child process has exited.

### Feature: Tunnel auto mode follows Tailscale IP detection

#### Prerequisites
- App is running from this repository via CLI.
- One environment with detected Tailscale IP (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`) and one without (or simulated by disabling Tailscale).

#### Steps
1. Start server without explicit tunnel flags: `npx codexapp --port 5900`.
2. In a host where Tailscale IP is detected, verify startup output includes `Tunnel:`.
3. In a host where Tailscale IP is not detected, verify startup output does not include `Tunnel:`.
4. Start server with explicit override `--no-tunnel` and verify no `Tunnel:` output even when Tailscale IP is present.
5. Start server with explicit override `--tunnel` and verify `Tunnel:` output even when Tailscale IP is not present.

#### Expected Results
- Without explicit flags, tunnel enablement follows Tailscale IP detection.
- `--no-tunnel` always disables tunnel startup.
- `--tunnel` always enables tunnel startup.

#### Rollback/Cleanup
- Stop the CLI process after each verification run.
- Ensure cloudflared child process exits after shutdown.

### Feature: Reverse tunnel login is required unless request is trusted local or Tailscale

#### Prerequisites
- App is running with password enabled.
- One direct local browser session (`localhost`).
- One reverse tunnel path (for example SSH/Cloudflare forwarding) that reaches the same server.
- Optional Tailscale client in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`.

#### Steps
1. Open app via `http://localhost:<port>` and confirm it opens without login when request is true local loopback.
2. Open app via reverse-tunnel URL and confirm login page is shown.
3. Enter correct password in reverse-tunnel URL and confirm session cookie allows access.
4. (Optional) Open app via Tailscale IP and confirm login is bypassed.

#### Expected Results
- Local loopback access is allowed without login prompt.
- Reverse-tunnel access does not bypass auth and requires password.
- Valid login on reverse-tunnel path creates session and grants access.
- Tailscale CIDR requests remain trusted.

#### Rollback/Cleanup
- Clear browser cookies for the app origin(s).
- Stop the CLI process.

### Feature: Cloudflare tunnel QR omits password auto-login path

#### Prerequisites
- App is running from this repository with password enabled.
- Cloudflare tunnel startup is enabled (`--tunnel` or auto-enabled path).

#### Steps
1. Start CLI and wait for tunnel output.
2. Verify the printed `Tunnel:` URL does not include a `/password=` suffix.
3. Scan the terminal QR code from a phone/browser.
4. Confirm first page load shows the password form when no trusted bypass applies.
5. Use the generated password file path from startup output to retrieve the password and sign in.

#### Expected Results
- Tunnel URL shown in startup output does not expose the password.
- QR code encodes the base tunnel URL without a password-bearing path.
- The generated password remains available from the local password file.
- Base tunnel URL requires login when no trusted bypass applies.

#### Rollback/Cleanup
- Stop the CLI process.
- Clear cookies for the tunnel origin if needed.

### Feature: No automatic restore of last active thread on startup

#### Prerequisites
- App is running from this repository.
- At least one existing thread is available.
- Browser local storage is enabled.

#### Steps
1. Open the app in a regular browser tab (`http://localhost:<port>/`), select any thread, then navigate back to home route (`#/`).
2. Refresh the browser tab.
3. Confirm the app remains on home route and does not auto-switch to `#/thread/:threadId`.
4. Install/open the app in PWA standalone mode, select any thread, navigate to `#/`, and relaunch the PWA.

#### Expected Results
- In regular browser-tab mode, startup does not restore and redirect to the last active thread.
- In PWA standalone mode, startup also does not restore and redirect to the last active thread.
- Existing `openProjectPath` startup behavior still opens the requested project on home.

#### Rollback/Cleanup
- Clear app local storage state if you need to reset startup behavior for retesting.

#### Prerequisites
- `pnpm` is installed globally (`npm i -g pnpm` or via corepack).
- Repository is cloned and `node_modules/` does not exist (or may be stale).

#### Steps
1. Remove `node_modules/` if present: `rm -rf node_modules`.
2. Run `pnpm run dev`.
3. Wait for Vite dev server to start and display the local URL.
4. Open the displayed URL in a browser.

#### Expected Results
- `pnpm install` runs automatically before Vite starts (dependencies are installed).
- Vite dev server starts successfully and serves the app.
- No `npm` commands are invoked.

#### Rollback/Cleanup
- None.

### Feature: Stop button interrupts active turn without missing turnId

### Feature: Default runtime uses workspace-write sandbox with on-request approvals

#### Prerequisites
- App server is running from this repository.
- No `CODEXUI_SANDBOX_MODE` or `CODEXUI_APPROVAL_POLICY` environment overrides are set for the launch shell.

#### Steps
1. Start the app normally from this repository without passing `--sandbox-mode` or `--approval-policy`.
2. Open the startup logs or terminal output and find the runtime summary.
3. Confirm the reported sandbox mode is `workspace-write`.
4. Confirm the reported approval policy is `on-request`.
5. Restart the app with explicit overrides, for example `--sandbox-mode danger-full-access --approval-policy never`, and confirm those override the defaults.
6. With those overrides still active, trigger an account flow that uses the temporary app-server path (for example a quota/account inspection request).
7. Confirm the temporary app-server request succeeds under the active override settings and does not behave as if it were still using the original startup defaults.

#### Expected Results
- Default launch uses `workspace-write` sandbox mode.
- Default launch uses `on-request` approval policy.
- Explicit CLI flags still override the defaults when provided.
- Temporary app-server spawns in account routes use the current env-derived runtime args, including CLI overrides.

#### Rollback/Cleanup
- Remove any temporary CLI overrides before leaving the environment.

### Feature: Backticked HTTP(S) URL renders as clickable link

#### Prerequisites
- App is running from this repository.
- An active thread is open.

#### Steps
1. Send a message containing exactly: `` `https://github.com/marmeladema` ``.
2. Find the rendered message row and inspect the backticked URL token.
3. Click the rendered URL.

#### Expected Results
- The backticked URL is rendered as a clickable link, not plain inline code text.
- Clicking opens `https://github.com/marmeladema` in a new tab.

#### Rollback/Cleanup
- None.

### Feature: Stop button interrupts active turn without missing turnId

### Feature: Windows npx install no longer depends on legacy PTY package

#### Prerequisites
- A Windows machine with Node.js and npm installed.
- No globally installed `codexapp` package.
- Clear any previous temporary npm cache for `codexapp` if needed.

#### Steps
1. Run `npx codexapp --no-login` on Windows.
2. Confirm npm does not print deprecation warnings for `prebuild-install`, `npmlog`, `are-we-there-yet`, or `gauge` during package install.
3. Exit the app, then run `npx codexapp --no-login` again.
4. Run `npm i -g codexapp` on Windows.
5. Start the globally installed CLI with `codexapp --no-login`.
6. On macOS or Linux, start the app normally and confirm the integrated terminal still opens in a thread.
7. Repeat the integrated terminal check in both light theme and dark theme.

#### Expected Results
- Windows `npx` install no longer pulls `node-pty-prebuilt-multiarch` as a required install dependency.
- The deprecated `prebuild-install` dependency chain warnings no longer appear for `codexapp` installation.
- Re-running `npx codexapp --no-login` works without getting stuck in the same failed temporary install loop.
- Global installation succeeds on Windows.
- Integrated terminal continues to work through `node-pty` on supported hosts.
- Light theme and dark theme terminal surfaces remain readable and unchanged.

#### Rollback/Cleanup
- Remove the global package with `npm rm -g codexapp` if it was installed only for verification.

#### Prerequisites
- App is running from this repository.
- At least one thread can run a long response (for example, request a large code explanation).

#### Steps
1. Send a prompt that keeps the assistant generating for several seconds.
2. Immediately click the `Stop` button before the first assistant chunk fully completes.
3. Confirm generation halts.
4. Repeat with a resumed/existing in-progress thread (reload app while a turn is running, then click `Stop`).

#### Expected Results
- No error appears saying `turn/interrupt requires turnId`.
- Turn is interrupted successfully in both immediate-stop and resumed-thread scenarios.
- Thread state exits in-progress and the stop control returns to idle.

#### Rollback/Cleanup
- None.

### Feature: Revert PR #16 mobile viewport and chat scroll behavior changes

### Feature: Revert new-project folder-browser flow to inline add flow

#### Prerequisites
- App is running from this repository.
- Home/new-thread screen is open.
- At least one writable parent directory exists for creating a test project folder.

#### Steps
1. On the home/new-thread screen, open the `Choose folder` dropdown.
2. Click `+ Add new project`.
3. Enter a new folder name (for example `New Project Inline Test`) and click `Open`.
4. Confirm the app selects the newly created/opened project folder.
5. Repeat step 2, but enter an absolute path to an existing folder and click `Open`.

#### Expected Results
- Clicking `+ Add new project` opens inline input inside the dropdown instead of navigating to `/codex-local-browse...`.
- Entering a folder name creates/selects that project under the current base directory.
- Entering an absolute path opens that existing folder without creating a nested directory.

#### Rollback/Cleanup
- Delete the test folder created in step 3 if it was created only for verification.

### Feature: Disable auto-restore to last thread when opening home URL

#### Prerequisites
- App is running from this repository.
- At least one existing thread is available.
- Browser local storage may contain previous app state.

#### Steps
1. Open an existing thread route and confirm messages are visible.
2. Open `http://localhost:<port>/` (home route) in the same browser profile.
3. Refresh the home route once.
4. Close and re-open the app/tab at the home URL again.

#### Expected Results
- The app remains on the home/new-thread screen and does not auto-navigate to `/thread/<id>`.
- Refreshing home still keeps the user on home.

#### Rollback/Cleanup
- None.

#### Prerequisites
- App is running from this repository.
- A thread exists with enough messages to scroll.
- Test on a mobile-sized viewport (for example 375x812).

#### Steps
1. Open an existing thread and scroll up to the middle of the chat history.
2. Wait for an assistant response to stream while staying at the same scroll position.
3. Send a follow-up message and observe chat positioning when completion finishes.
4. Open the composer on mobile and drag within the composer area.
5. Open/close the on-screen keyboard on mobile and verify the page layout remains usable.

#### Expected Results
- Chat behavior matches pre-PR #16 baseline (no PR #16 scroll-preservation logic active).
- No regressions from reverting PR #16 changes in conversation rendering and composer behavior.
- Mobile layout no longer includes PR #16 visual-viewport sync changes.

#### Rollback/Cleanup
- Re-apply PR #16 commits if the reverted behavior is not desired.

### Feature: Thread load capped to latest 10 turns

#### Prerequisites
- App is running from this repository.
- At least one thread exists with more than 10 turns/messages.

#### Steps
1. Open a long thread that previously caused UI lag during initial load.
2. While the thread is loading, immediately click another thread in the sidebar.
3. Return to the long thread.
4. Count visible loaded history blocks and confirm only the newest portion is shown.
5. Call `/codex-api/rpc` with method `thread/read` for the same thread and inspect `result.thread.turns.length`.
6. Call `/codex-api/rpc` with method `thread/resume` for the same thread and inspect `result.thread.turns.length`.

#### Expected Results
- Initial thread load renders only the most recent 10 turns.
- UI remains responsive during thread load.
- You can switch to another thread without the UI freezing.
- `thread/read` and `thread/resume` RPC responses contain at most 10 turns.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Realtime skills list refresh for $ mentions

#### Prerequisites
- App is running from this repository.
- At least one repo thread whose cwd contains `./.agents/skills`.
- `~/.codex/skills` is writable.

#### Steps
1. Open a thread in repo A and type `$` in the composer; note the visible repo/user skills.
2. Quickly switch to a thread in repo B and type `$` again without reloading the page.
3. Confirm repo B's `./.agents/skills` appear (badge `R`) and repo A-only skills are gone.
4. Install or edit a skill under `~/.codex/skills` (or Skills Hub install/uninstall).
5. Without restarting, type `$` again and confirm the new/updated user skill appears (badge `U`).
6. In Network tab, confirm `skills/list` after step 5 includes `forceReload: true` when driven by `skills/changed` or Skills Hub actions.

#### Expected Results
- `$` mention suggestions follow the currently selected composer/thread cwd.
- Switching threads does not leave a stale skills list from the previous cwd.
- Changes under `~/.codex/skills` and watched skill roots are picked up via `skills/changed` + force reload without app restart.
- Repo skills continue to come from app-server scanning of `<cwd>/.agents/skills`.

#### Rollback/Cleanup
- Revert `refreshSkills` race handling in `useDesktopState.ts`, the `skills/changed` handler, `composerCwd` watch in `App.vue`, and `getSkillsList(..., { forceReload })`.

### Feature: Display UserPromptSubmit additional context

#### Prerequisites
- App is running from this repository.
- The active Codex session has a `UserPromptSubmit` hook that emits non-empty `additionalContext`.

#### Steps
1. Send a user message that triggers the hook.
2. When the user message appears in the conversation, locate the collapsed **Hook additional context** block directly beneath it.
3. Expand the block and verify its content matches the hook-injected context, including newlines, and that the container has square corners.
4. Switch between light and dark themes and repeat step 3.

#### Expected Results
- The original user prompt remains unchanged.
- Hook context is attached only to its matching user message and is collapsed by default.
- Context is rendered as plain text rather than executable HTML or Markdown.
- The collapsed block remains legible in both light and dark themes.

#### Rollback/Cleanup
- Revert the session JSONL recovery in `src/server/codexAppServerBridge.ts`, the `additionalContext` message field, and the conversation details block.

### Feature: Skills list request scoped to active thread cwd

#### Prerequisites
- App is running from this repository.
- Browser DevTools Network tab is open.
- At least two threads exist with different `cwd` values.

#### Steps
1. Reload the app and wait for initial data load.
2. In Network tab, inspect `/codex-api/rpc` requests with method `skills/list`.
3. Verify request params contain `cwds` with only the currently selected thread cwd.
4. Switch to another thread with a different cwd.
5. Inspect the next `skills/list` request and verify `cwds` now contains only the new selected thread cwd.

#### Expected Results

### Feature: Pinned threads persist across reload and prune removed threads

#### Prerequisites
- App is running from this repository.
- At least two threads exist in the sidebar.

#### Steps
1. Pin two threads from the sidebar using the pin button.
2. Refresh the app page.
3. Confirm the same threads are still shown in the `Pinned` section and in the same order.
4. Archive one of the pinned threads from the thread menu.
5. Refresh the app page again.

#### Expected Results
- Pinned threads are restored after reload from Codex app global state (`~/.codex/.codex-global-state.json` key `thread-pinned-ids`).
- Pin order is preserved between reloads.
- Archived/removed pinned thread is automatically pruned and no stale pinned row remains.

#### Rollback/Cleanup
- Unpin test threads if needed.
- `skills/list` no longer sends every thread cwd in one request.
- Each `skills/list` call includes at most one cwd for the active thread context.
- Skills list still updates when changing selected thread.

#### Rollback/Cleanup
- No cleanup required.

---

### Feature: GitHub Website Redesign — OpenClaw-Inspired Design + Web Demo Link

#### Prerequisites
- The `docs/index.html` file has been updated with the new design.
- A browser is available to view the page locally or via GitHub Pages.

#### Steps
1. Open `docs/index.html` in a browser (local file or via GitHub Pages).
2. Verify the fixed **navigation bar** at top with brand logo, section links, and "Get the App" CTA.
3. Verify the **announcement banner** below nav shows the XCodex WASM link.
4. Verify **hero section** displays lobster emoji, "AnyClaw" title with gradient, tagline, and four CTA buttons: "Try Web Demo", "Google Play", "Download APK", "GitHub".
5. Click **"Try Web Demo"** button — confirm it navigates to `https://xcodex.slrv.md/#/`.
6. Verify the **stats bar** shows key metrics (2 AI Agents, 1 APK, 0 Root Required, 73MB, infinity).
7. Scroll to **Live Demo** section — verify embedded iframe loads `https://xcodex.slrv.md/#/` with mock browser chrome.
8. Scroll to **Screenshots** section — verify four images render (2 desktop, 2 mobile).
9. Scroll to **Features** section — verify 6 feature cards in a 3-column grid.
10. Scroll to **Testimonials** section — verify two rows of auto-scrolling marquee cards (row 2 scrolls reverse). Hover to pause.
11. Scroll through **Architecture**, **Boot Sequence**, **Quick Start**, and **Tech Stack** sections — verify content renders.
12. Verify the **footer** includes a "Web Demo" link to `https://xcodex.slrv.md/#/`.
13. Test responsive at 768px and 480px — nav links collapse, grids single-column, buttons stack vertically.

#### Expected Results
- Page has a dark, premium feel with gradient accents, grain overlay, and smooth animations.
- All links to `https://xcodex.slrv.md/#/` work (announcement, hero CTA, demo section, quick start text, footer).
- Marquee testimonials scroll continuously and pause on hover.
- Embedded iframe demo loads successfully.
- Mobile responsive layout works at all breakpoints.

#### Rollback/Cleanup
- Revert `docs/index.html` to previous commit if needed.

### Feature: Keep manual chat scroll position during streaming

#### Prerequisites
- App is running from this repository.
- A thread exists with enough history to allow scrolling away from bottom.

#### Steps
1. Open the thread and scroll upward so latest messages are not visible.
2. Send a new message that produces a streaming assistant response.
3. During streaming, do not scroll and observe viewport position.
4. After streaming completes, verify the viewport remains at the same manual position.

#### Expected Results
- Streaming updates do not force auto-scroll to the bottom when user has manually scrolled away.
- User can continue reading older history while the response streams.
- If the thread is already at the bottom when streaming starts, the latest streaming overlay remains visible.

#### Rollback/Cleanup
- Revert the scroll-preservation change in `src/components/content/ThreadConversation.vue` if manual scroll locking needs to be removed.

### Feature: Rollback API/UI no longer requires turn index in rollback payload

#### Prerequisites
- App is running from this repository.
- A thread exists with at least 2 completed turns.
- Rollback control is visible in the thread conversation message actions.

#### Steps
1. Open any existing thread with multiple turns.
2. In DevTools Network tab, keep `/codex-api/rpc` requests visible.
3. Click rollback on a user or assistant message that is not the newest one.
4. Confirm rollback succeeds and the thread is truncated to the selected turn.
5. Inspect the UI event flow by repeating rollback from a different turn and confirm the selected message can rollback without relying on a numeric turn index.
6. Use dictation resend flow (or "rollback latest user turn" flow) and confirm the latest user turn is rolled back correctly.

#### Expected Results
- Rollback works when triggered from message actions using `turnId` as the identifier.
- No UI path depends on `turnIndex` in rollback event payloads.
- Latest-user-turn rollback flow still works and targets the latest user `turnId`.
- No TypeScript/runtime errors are introduced in rollback interaction.

#### Rollback/Cleanup
- Revert the updated files if this behavior is not desired:
  - `src/types/codex.ts`
  - `src/api/normalizers/v2.ts`
  - `src/components/content/ThreadConversation.vue`
  - `src/App.vue`
  - `src/composables/useDesktopState.ts`

### Feature: Rollback init commit includes `.codex/.gitignore`

#### Prerequisites
- App server is running from this repository.
- Use a fresh temporary project directory with no existing `.codex/rollbacks/.git` history.

#### Steps
1. In a fresh test project folder, trigger rollback automation init by calling `/codex-api/worktree/auto-commit` with a valid commit message.
2. Verify rollback repo exists at `.codex/rollbacks/.git`.
3. In that rollback repo, run `git --git-dir .codex/rollbacks/.git --work-tree . show --name-only --pretty=format: HEAD`.
4. Confirm `.codex/.gitignore` appears in the file list for the init commit.
5. Open `.codex/.gitignore` and verify `rollbacks/` exists.

#### Expected Results
- First rollback-history commit is `Initialize rollback history`.
- That commit includes `.codex/.gitignore`.
- `.codex/.gitignore` contains `rollbacks/`.

#### Rollback/Cleanup
- Remove the temporary test folder after verification.

### Feature: Deterministic rollback commit + exact lookup with debug logs

#### Prerequisites
- App server is running from this repository.
- `worktree git automation` is enabled in UI settings.
- Test thread available where you can send at least 3 user turns.

#### Steps
1. Send a user turn that changes files and completes.
2. Send a user turn that produces no file edits and completes.
3. Send a third user turn and complete it.
4. In rollback git history (`.codex/rollbacks/.git`), verify each completed turn created a commit, including the no-edit turn.
5. Inspect one rollback commit body and confirm it contains the user message text plus `Rollback-User-Message-SHA256: <hash>`.
6. Trigger rollback to the second turn message via UI rollback action.
7. Verify server logs contain `[rollback-debug]` entries for lookup, stash (if dirty), reset, and completion.
8. Temporarily test missing-commit path by calling `/codex-api/worktree/rollback-to-message` with a non-existent message text.

#### Expected Results
- Auto-commit creates a rollback commit for every completed turn (`--allow-empty` behavior).
- Commit body includes the user message and stable hash trailer.
- Rollback uses exact hash-based commit lookup only.
- If exact commit is missing, rollback returns error and does not continue.
- Server logs include `[rollback-debug]` records for commit creation, lookup, stash, reset, and error paths.
- Browser console includes `[rollback-debug]` client-side start/success/error logs for auto-commit and rollback API calls.
- Rollback init no longer fails when `.codex` is ignored globally; init force-adds `.codex/.gitignore`.

#### Rollback/Cleanup
- Revert the changed files if you want previous non-deterministic behavior back.

### Feature: Per-turn changed files panel with lazy diff loading

#### Prerequisites
- App server running from this repository.
- Worktree git automation enabled.
- A thread with at least one completed turn that touched files.

#### Steps
1. Open a thread and locate a `Worked for ...` separator message.
2. Expand the worked separator.
3. Verify a changed-files panel appears above command details.
4. Confirm file list entries show file path and `+/-` counts.
5. Click one changed file row to expand it.
6. Verify diff content loads only after expansion (lazy load behavior).
7. Collapse and re-expand the same file row; verify diff reuses loaded content.
8. Switch to another thread and back; verify panel reloads for the active thread context.

#### Expected Results
- Each worked message can show changed files for its turn.
- Diff for a file is fetched only on expand, not for all files upfront.
- Errors (missing commit/diff load failure) are shown inline in the panel.
- Existing command output expand/collapse behavior remains unchanged.
- Changed-files panel still resolves after page refresh or app-server restart.
- Changed-files panel appears at the end of the worked message block (after command rows).

#### Rollback/Cleanup
- No cleanup required.

### Feature: Worked separator is non-expandable

#### Prerequisites
- App server running from this repository.
- A thread with at least one `Worked for ...` separator.

#### Steps
1. Open a thread and locate a `Worked for ...` message.
2. Click the separator line/text area.
3. Verify no expand/collapse behavior is triggered on the separator itself.
4. Verify changed-files panel still appears below the separator when data exists.

#### Expected Results
- `Worked for ...` acts as a visual separator only (non-interactive).
- Changed-files and command sections are not gated by a worked-separator expand toggle.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Changed-files lookup fallback when turnId metadata is missing

#### Prerequisites
- App server running from this repository.
- Playwright CLI available.

#### Steps
1. Create/prepare a test workspace (example: `/tmp/rollback-pw`).
2. Call `/codex-api/worktree/auto-commit` with:
   - `cwd=/tmp/rollback-pw`
   - `message='pw-msg-turn-1'`
   - `turnId='turn-real-1'`
3. Call `/codex-api/worktree/message-changes` with:
   - same `cwd`
   - same `message`
   - mismatched `turnId='turn-wrong'`
4. Verify response is still `200` and returns the matching commit data (message-hash fallback).
5. Capture Playwright artifact screenshot.

#### Expected Results
- `message-changes` first attempts turnId lookup.
- If turnId lookup misses, it falls back to exact message-hash lookup.
- API returns commit data instead of `No matching commit found for this user message` when message matches.

#### Rollback/Cleanup
- Remove temporary test workspace if created.

### Feature: Changed-files panel persists across refresh (assistant message level)

#### Prerequisites
- App server running from this repository.
- Existing thread in `TestChat` project with completed assistant messages.
- Worktree rollback auto-commit enabled.

#### Steps
1. Open a `TestChat` thread and confirm assistant message cards render.
2. Verify changed-files panel is shown at the end of assistant messages that have rollback commit data.
3. Hard refresh the page.
4. Re-open the same `TestChat` thread.
5. Verify changed-files panel is still shown for the same assistant message(s).
6. Expand one file diff and verify diff content loads.

#### Expected Results
- Changed-files panel is attached to assistant messages (not transient worked separators).
- Changed-files panel appears only once per turn (on the last assistant message in that turn).
- Changed-files panel is hidden while a turn is still in progress.
- Panels remain available after refresh/restart because lookup is turnId/message-hash based.
- File diff expansion still lazy-loads and displays content.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Rollback debug logs controlled by `.env`

#### Prerequisites
- App server stopped.
- Edit `.env` directly, and use `.env.local` for private local overrides.

#### Steps
1. Set `ROLLBACK_DEBUG=0` and `VITE_ROLLBACK_DEBUG=0` in `.env`.
2. Start app and trigger rollback auto-commit/message-changes flow.
3. Verify `[rollback-debug]` logs are not emitted in terminal/browser console.
4. Set `ROLLBACK_DEBUG=1` and `VITE_ROLLBACK_DEBUG=1` in `.env`.
5. Restart app and trigger the same flow again.
6. Verify `[rollback-debug]` logs appear in terminal/browser console.

#### Expected Results
- Debug logs are disabled when env flags are `0`.
- Debug logs are enabled when env flags are `1`.

#### Rollback/Cleanup
- Restore `.env` values to preferred defaults.

### Feature: Auto-commit default is disabled for new preference state

#### Prerequisites
- App server running from this repository.
- Browser local storage key `codex-web-local.worktree-git-automation.v1` is absent (new user state).

#### Steps
1. Open the app in a fresh browser profile (or clear only `codex-web-local.worktree-git-automation.v1`).
2. Open Settings and inspect the `Rollback commits` toggle state.
3. Confirm it starts in the disabled/off state.
4. Enable the toggle manually.
5. Reload the page and confirm the toggle remains enabled.
6. Disable it again, reload, and confirm it remains disabled.

#### Expected Results
- Default state is disabled when no prior preference exists.
- User-selected state persists via local storage across reloads.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Skills sync pull live-reloads installed skills list

#### Prerequisites
- App running from this repository with Skills Hub available.
- GitHub skills sync configured and connected.
- At least one skill update available in the sync source (new or edited skill metadata).

#### Steps
1. Open the app and note the currently visible installed skills for the active thread cwd.
2. In Skills Hub, trigger `Pull` from GitHub sync.
3. Wait for the pull success toast.
4. Without restarting the app/server, navigate to thread composer skill picker and verify the installed skills list.
5. Switch to another thread and back to force a normal UI refresh path.

#### Expected Results
- Pull completes successfully.
- Installed skills list reflects pulled changes immediately without app/server restart.
- Thread switch keeps showing the updated skills list (no stale cache rollback).

#### Rollback/Cleanup
- If needed, run another sync pull/push to restore previous skill state in the sync repo.

### Feature: Force Refresh Skills button in Skills Sync panel

#### Prerequisites
- App running from this repository with Skills Hub route accessible.
- At least one installed skill is available for the current thread cwd.

#### Steps
1. Open `Skills Hub`.
2. In `Skills Sync (GitHub)`, click `Force Refresh Skills`.
3. Verify button text changes to `Refreshing...` during the request and returns after completion.
4. Verify success toast appears.
5. Open the thread composer skills picker and confirm installed skills list is present and current.
6. Switch to another thread and back to ensure refreshed list remains consistent.

#### Expected Results
- `Force Refresh Skills` triggers a manual refresh without requiring pull/push.
- Loading state prevents duplicate clicks while refresh is in progress.
- Installed skills list updates immediately and remains updated across thread switches.

#### Rollback/Cleanup
- No cleanup required.

### Feature: SkillHub shows detailed skill load errors

#### Prerequisites
- App running from this repository.
- At least one invalid installed skill file exists (for example unresolved merge markers in `SKILL.md`).

#### Steps
1. Open `Skills Hub`.
2. Trigger `Force Refresh Skills`.
3. Locate the `Some skills failed to load` panel above the skills sections.
4. Verify each row shows:
   - the failing `SKILL.md` path
   - the exact parser error message from app server (for example invalid YAML line/column details).
5. Fix the invalid skill file and trigger `Force Refresh Skills` again.

#### Expected Results
- SkillHub surfaces app-server load failures with detailed path and message.
- Messages are specific enough to identify the broken file and parser failure reason.
- Error panel disappears after invalid skills are fixed and refreshed.

#### Rollback/Cleanup
- Restore any intentionally broken local skill files used for testing.

### Feature: Startup sync preserves local skill edits when remote is ahead

#### Prerequisites
- Skills sync configured to a private GitHub fork.
- Local skills repo has a tracked edit in an existing skill file.
- Remote `main` has at least one newer commit than local (simulate from another machine or commit directly on GitHub).

#### Steps
1. Edit a local skill file (for example update description text in `SKILL.md`) and keep the change.
2. Trigger `Startup Sync` in Skills Hub.
3. If a non-fast-forward condition exists, allow startup sync to complete retry path.
4. Re-open the same local skill file and verify your edit remains.
5. Trigger `Force Refresh Skills` and verify no unexpected skill removals occurred.

#### Expected Results
- Startup sync no longer fails with non-fast-forward push due to missing remote integration.
- Local tracked skill edits remain after sync (not overwritten by remote state).
- Sync path rebases/pulls with autostash and auto-resolves conflicts by mtime policy:
  - choose remote (`theirs`) when remote file commit time is newer than local file mtime.
  - choose local (`ours`) otherwise.
- No manual conflict intervention is required during startup sync retries.

#### Rollback/Cleanup
- Revert test-only skill text changes if they were not intended to keep.

### Feature: Startup sync conflict fallback when one side is missing

#### Prerequisites
- Skills sync repo contains a conflict candidate where only one side exists for a path (for example delete/modify scenario).
- Skills Hub is accessible.

#### Steps
1. Open `Skills Hub`.
2. Click `Startup Sync`.
3. Wait for sync completion or error toast.
4. Verify no toast/error contains `does not have our version`.

#### Expected Results
- Sync conflict resolver handles missing `--ours`/`--theirs` versions safely.
- Startup sync does not fail with `git checkout --ours/--theirs` missing-version errors.

#### Rollback/Cleanup
- None.

### Feature: Remote changes win when no local uncommitted skill edits exist

#### Prerequisites
- Skills sync configured with GitHub.
- Local skills repo working tree is clean (`git status --porcelain` empty under skills dir).
- Remote skills repo has newer commits touching existing skill files.

#### Steps
1. Confirm no local uncommitted changes in skills directory.
2. Trigger `Startup Sync` in Skills Hub.
3. After sync, inspect the skill file changed remotely.
4. Trigger `Force Refresh Skills` and confirm loaded skill content matches remote update.

#### Expected Results
- Sync pull/reconcile does not preserve stale local file content when local tree is clean.
- Remote updates are applied locally and remain after startup sync completes.

#### Rollback/Cleanup
- None.

### Feature: Startup sync does not delete remote AGENTS.md

#### Prerequisites
- Skills sync configured to `friuns2/codexskills`.
- Remote `main` contains `AGENTS.md`.
- Local skills repo is clean before startup sync.

#### Steps
1. Confirm remote `AGENTS.md` exists on `main`.
2. Confirm local `~/.codex/skills` is clean.
3. Trigger `Startup Sync`.
4. After completion, inspect latest commit created by sync (if any).
5. Verify `AGENTS.md` still exists locally and in remote `origin/main`.

#### Expected Results
- Startup sync may update manifest, but must not delete `AGENTS.md`.
- If sync creates a commit, changed files do not include `D AGENTS.md`.
- Local and remote `AGENTS.md` hashes remain equal after sync.

#### Rollback/Cleanup
- None.

### Feature: Bidirectional AGENTS.md sync via Startup Sync

#### Prerequisites
- Skills sync configured to `friuns2/codexskills`.
- `~/.codex/skills` is a clean git working tree before each sub-test.
- Skills Hub startup sync endpoint is reachable.

#### Steps
1. Remote -> Local:
2. Add a unique marker to remote `AGENTS.md` on `main`.
3. Confirm local `HEAD` is behind `origin/main`.
4. Trigger `Startup Sync`.
5. Verify local `AGENTS.md` contains the remote marker and local `HEAD == origin/main`.
6. Local -> Remote:
7. Add a different unique marker to local `~/.codex/skills/AGENTS.md`.
8. Confirm local working tree shows `M AGENTS.md`.
9. Trigger `Startup Sync`.
10. Verify remote `origin/main:AGENTS.md` contains the local marker and local `HEAD == origin/main`.

#### Expected Results
- Remote-only AGENTS edits are pulled into local without deletion.
- Local AGENTS edits are pushed to remote after startup sync.
- After each sync direction, local and remote commit SHAs match.

#### Rollback/Cleanup
- Remove temporary test markers from `AGENTS.md` if required.

### Feature: Mixed local+remote AGENTS edits do not stall Startup Sync

#### Prerequisites
- Skills sync configured and working.
- Local skills repo clean before test start.

#### Steps
1. Add marker `A` to remote `AGENTS.md`.
2. Add marker `B` to local `AGENTS.md` before syncing.
3. Trigger `Startup Sync`.
4. Wait for startup status to finish (`inProgress=false`).
5. Verify sync outcome explicitly:
6. If sync succeeds, local/remote SHAs match and expected merged marker result is present.
7. If sync fails, status includes a concrete error message (not silent success).

#### Expected Results
- Startup sync must not report success while local remains behind remote.
- No stale stash side-effects are introduced (no unexpected conflict from old stash entries).
- Final state is either a valid synchronized result or an explicit failure status with actionable error.

#### Rollback/Cleanup
- Reset local skills repo to `origin/main` after test if needed.

### Feature: Startup sync uses deterministic pull reconcile (`fetch + reset --hard`) before local replay

#### Prerequisites
- Skills sync is logged in and targets `friuns2/codexskills`.
- Local repo path is `~/.codex/skills`.
- Startup Sync endpoint is reachable at `/codex-api/skills-sync/startup-sync`.

#### Steps
1. Remote-only case:
2. Commit a unique marker to remote `AGENTS.md` on `main`.
3. Ensure local repo is clean and reset to `origin/main`, then trigger `Startup Sync`.
4. Confirm marker appears locally and `HEAD == origin/main`.
5. Local-only case:
6. Add a unique local marker to `~/.codex/skills/AGENTS.md` (uncommitted), trigger `Startup Sync`.
7. Confirm marker is pushed and `HEAD == origin/main` with clean worktree.
8. Mixed case:
9. Add local marker first, then commit a newer remote marker.
10. Trigger `Startup Sync` and verify mtime policy result (newer remote marker wins, older local marker dropped).
11. Confirm final state is clean with `HEAD == origin/main`.

#### Expected Results
- Startup sync does not fail with missing merge refs (`MERGE_HEAD`/`REBASE_HEAD`) in this path.
- Remote-only changes are always pulled first and visible locally.
- Local-only changes are preserved and pushed during the same startup sync run.
- Mixed local+remote edits converge automatically with no manual conflict handling.

#### Rollback/Cleanup
- Remove temporary test markers from `AGENTS.md` if not needed.

### Feature: Revert Renat scrolling/input-layout behavior (without Fast mode changes)

#### Prerequisites
- App builds successfully (`pnpm run build`).
- Open a thread with enough messages to scroll.
- Composer is visible in the main chat view.

#### Steps
1. Open a long thread and scroll upward away from bottom.
2. Trigger live overlay updates (for example by sending a new prompt) and observe scroll behavior.
3. Confirm message list horizontal overflow behavior in conversation and desktop main area.
4. In composer, verify there is no drag/drop overlay UI when dragging files over the input.
5. In composer, paste an image from clipboard and verify it is not auto-attached through paste handler.
6. Use file picker/camera attach buttons and confirm attachments still work.
7. Confirm Fast mode UI/toggle remains present and unchanged.

#### Expected Results
- Scroll behavior follows reverted layout logic for conversation/desktop containers.
- Composer drag-active overlay is removed from the input field layout.
- Clipboard image paste no longer triggers drag/paste attachment flow.
- Standard picker-based attachments still work.
- Fast mode button and related controls are unchanged.

#### Rollback/Cleanup
- `git restore src/components/content/ThreadComposer.vue src/components/content/ThreadConversation.vue src/components/layout/DesktopLayout.vue src/style.css tests.md`

### Feature: Chat file-link context menu (open/copy/edit)

#### Prerequisites
- App server is running from this repository.
- Open a thread that contains rendered `.message-file-link` anchors (for example Markdown file links).

#### Steps
1. In a message with a file link, right-click the file link text.
2. Verify the custom context menu appears near the pointer.
3. Click `Open link` and confirm the link opens in a new tab.
4. Right-click the same file link again and click `Copy link`, then paste into a text input to verify copied value.
5. For links under `/codex-local-browse...`, right-click and click `Edit file`.
6. Click outside the menu and press `Escape` while the menu is open.

#### Expected Results
- Right-clicking any `.message-file-link` opens the custom context menu.
- Menu includes `Open link` and `Copy link` for all links.
- Menu includes `Edit file` only for browseable local file links.
- Pointer-down outside, blur, and `Escape` close the menu.

#### Rollback/Cleanup
- Close any tabs opened during the test.

### Feature: Dark theme command rows in chat remain readable

#### Prerequisites
- App is running from this repository.
- Open any thread that contains command execution entries.
- Appearance is set to `Dark` in Settings.

#### Steps
1. Open a thread with one or more command execution rows in the conversation.
2. Verify command label text, grouped command label text, and status text in collapsed rows.
3. Locate a file-change summary row (for example: `▶ 2 files changed · 2 edited`) and verify the chevron and summary text are readable.
4. Expand a command row to show output and inspect the output panel border contrast.
5. Confirm status colors for running/success/error command rows are distinguishable in dark mode.
6. Toggle back to `Light` theme and confirm command rows still use the existing light styling.

#### Expected Results
- Command labels and grouped command labels are readable against dark row backgrounds.
- File-change summary rows keep readable chevron and summary text in dark mode.
- Default status text is readable in dark mode.
- Running/success/error status colors remain visible in dark mode.
- Expanded command output border is visible without using a bright light-theme border.
- Light theme command row styling is unchanged.

#### Rollback/Cleanup
- Return appearance setting to the previous user preference.

### Feature: Home composer vertical alignment matches reference layout

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open the `New thread` (home) screen with a selected folder/project.
- Ensure desktop viewport width (for example >= 1280px).

#### Steps
1. Open the home screen and observe the hero block (`Let's build`) and composer placement.
2. Confirm the hero/settings block is vertically centered within the available content area.
3. Confirm the message composer sits in the lower area of the content column (not immediately below top content).
4. Resize window height taller/shorter and re-check vertical placement.
5. Open any thread route and verify thread composer layout remains unchanged.

#### Expected Results
- Home hero block is centered again (not top-anchored).
- Home composer aligns toward the bottom region similar to the reference screenshot.
- Resizing preserves the intended centered-hero + lower-composer structure.
- Thread route composer behavior is unchanged.

#### Rollback/Cleanup
- Revert the `.new-thread-empty` style in [src/App.vue](/Users/igor/.codex/worktrees/eaf8/codex-web-local/src/App.vue).

### Feature: Restore composer drag-and-drop file attach on input field

#### Prerequisites
- App is running with a selected thread and active composer.
- At least one local file is available to drag from Finder/File Explorer.

#### Steps
1. Drag a file over the composer input area.
2. Confirm drag highlight/overlay appears above the input.
3. Drop the file on the composer input field.
4. Verify the file is attached in composer chips.
5. Repeat with an image file and verify image preview appears.
6. In dark mode, repeat steps 1-2 and verify overlay remains readable.

#### Expected Results
- Composer shows drag-active visual state while file is hovering.
- Dropped files are attached through the same attachment pipeline as regular uploads.
- Image drops create image preview attachments.
- Dark mode drag overlay uses dark-theme colors and remains legible.

#### Rollback/Cleanup
- Remove attached files/images from the composer before closing the test thread.

### Feature: Restore clipboard image paste attachments in composer

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open any thread where the composer is enabled.
- Have an image copied to system clipboard (for example screenshot copy).

#### Steps
1. Focus the composer textarea.
2. Paste clipboard content that contains only an image file payload.
3. Confirm an image chip/preview is added to composer attachments.
4. Copy plain text only and paste into composer.
5. Copy mixed content (plain text + image, if source provides both) and paste once.
6. Copy long plain text (at least 2000 characters) and paste into composer.
7. Confirm the long text is attached as a `.txt` file instead of being inserted into the textarea.
8. Send the message with the pasted image/text attachment.

#### Expected Results
- Image-only clipboard paste adds an image attachment to composer.
- Plain-text paste still inserts text into the composer and does not create an attachment.
- Mixed payload paste attaches the image while preserving text paste behavior.
- Long plain-text paste (>= 2000 chars) creates a `.txt` attachment and does not insert raw text into the textarea.
- Sending proceeds with the attached pasted image.

#### Rollback/Cleanup
- Remove the attached image chip from composer if not needed.

### Feature: Show user file attachments as visible chips in chat

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open any thread with an active composer.
- Have at least one local file available to attach.

#### Steps
1. Attach one or more files via composer (file picker, paste long text as `.txt`, or other file attachment flow).
2. Send the message.
3. Locate the sent user message in conversation.
4. Verify file attachment chips are rendered above message text.
5. Click a file chip and confirm it opens the browse URL in a new tab/window.
6. Right-click the chip link and verify file-link context actions still appear (`Open link`, `Copy link`, and `Edit file` when applicable).

#### Expected Results
- Sent user messages with `fileAttachments` show visible file chips in chat.
- Chip labels match attachment labels from composer payload.
- Chip links resolve through browse URLs and remain clickable.
- Existing file-link context menu behavior works on the chip links.

#### Rollback/Cleanup
- Close any opened file tabs and remove temporary test messages if needed.

### Feature: Conversation turn avatars show agent and user images

#### Prerequisites
- App server is running from this repository.
- Open a thread that already contains at least one assistant message and one user message, or send a short prompt to create them.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the app in light theme and select a thread with both user and assistant replies.
2. Confirm each assistant turn starts with a 64px square avatar on its own line.
3. Confirm each user turn starts with the provided 64px square avatar on its own line and the message content starts on the next line.
4. If needed, send a short prompt such as `avatar smoke test` and confirm both turns show the avatar first, then the message content starts on the next line.
5. Switch to dark theme and repeat the same check on the same thread.

#### Expected Results
- Each assistant turn begins with a visible 64px square agent avatar on its own line.
- Each user turn begins with a visible 64px square user avatar on its own line.
- The message content starts on the next line instead of running directly after the avatar.
- The avatar image comes from `public/icons/agent-avatar.png`.
- The user avatar image comes from `public/icons/user-avatar.png`.
- The avatar stays readable in both light and dark themes.

#### Rollback/Cleanup
- Delete or ignore any disposable test thread/message created for the check.

### Feature: Composer @ search includes folders and symlinks

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open a thread whose `cwd` contains at least one folder and one symlink you can safely reference.
- Have a temporary folder and symlink available inside the workspace if the current tree does not already contain one.

#### Steps
1. Switch the app to `Light` theme.
2. Focus the composer and type `@` followed by a folder name from the current workspace.
3. Confirm a folder result appears in the mention list and shows a folder-style icon.
4. Select the folder result and confirm it becomes a file attachment chip.
5. Type `@` again and search for a symlink path or symlink target name.
6. Confirm the symlink result appears with a symlink indicator and can be selected.
7. Send the message and confirm the attached folder/symlink path is preserved in the sent message.
8. Switch the app to `Dark` theme and repeat steps 2-7.

#### Expected Results
- `@` search returns both files and folders from the workspace.
- Symlinked paths also appear in the suggestion list.
- Folder rows use a folder icon and symlink rows are visibly marked.
- Selected folder and symlink paths attach the same way as file paths.
- Light theme and dark theme both keep the suggestion list readable.

#### Rollback/Cleanup
- Remove any temporary symlink or folder created only for this test.
- Clear attached chips or discard the test message if you do not want to keep it.

### Feature: Frontend missing-entry 404 page auto-redirects to chat

#### Prerequisites
- Build or runtime state where frontend entry cannot be served (for example missing `dist/index.html`).
- Start server and open the failing route in a browser.

#### Steps
1. Trigger the frontend missing-entry error page.
2. Confirm the page shows an error headline and a `Back to chat` link.
3. Wait 3 seconds without clicking the link.
4. Repeat and click `Back to chat` immediately.

#### Expected Results
- Error page still renders with the manual `Back to chat` link.
- Page automatically redirects to `/` after about 3 seconds.
- Manual link works instantly and is not blocked by the timer.

#### Rollback/Cleanup
- Restore frontend assets (`pnpm run build:frontend`) if they were intentionally removed for testing.

### Feature: Import 10 working DB accounts and keep Accounts section collapsed by default

#### Prerequisites
- Have a SQLite DB with `account_tokens.refresh_token` rows (default path: `/Users/igor/Git-projects/any-auto-register/account_manager.db`).
- Network access available for token exchange against OpenAI OAuth endpoint.
- Codex home available at `~/.codex` (or set `CODEX_HOME`).
- Start the app from this repository (`pnpm run dev`).

#### Steps
1. Run `scripts/import-working-accounts-from-db.sh`.
2. Verify script reports `imported` rows and ends with `done imported=<n>` where `n <= 10`.
3. Open `~/.codex/accounts.json` and verify new account entries were appended/updated.
4. Verify snapshot files exist under `~/.codex/accounts/<sha256(account_id)>/auth.json`.
5. Open app settings and check the `Accounts` section is collapsed on first load.
6. Click the chevron toggle in Accounts header to expand.
7. Confirm account list/error/empty state renders correctly after expanding.
8. Reload the page and confirm collapsed/expanded state persists.

#### Expected Results
- Script imports up to 10 valid (token-exchange-successful) accounts and skips invalid tokens.
- `accounts.json` and per-account snapshot `auth.json` files are created with secure file modes.
- Accounts panel in settings is collapsed by default when no saved preference exists.
- User can expand/collapse Accounts via header toggle, and the state persists in localStorage.

#### Rollback/Cleanup
- Remove imported snapshots from `~/.codex/accounts/` and corresponding rows in `~/.codex/accounts.json` if needed.
- Delete localStorage key `codex-web-local.accounts-section-collapsed.v1` to reset UI preference.

### Feature: Copy Codex accounts to Android via ssh helper script

#### Prerequisites
- Local Codex state exists at `~/.codex/accounts` and `~/.codex/accounts.json`.
- Android helper exists and is executable: `/Users/igor/Git-projects/codex-web-local-android/andclaw/ssh.sh`.
- Android target is reachable through helper SSH path.

#### Steps
1. Run `scripts/copy-accounts-to-android.sh`.
2. Confirm script prints local account count and upload/extract progress.
3. Confirm script prints remote account count.
4. Verify script exits successfully with `Copy complete: local and remote counts match.`
5. On Android host, verify `~/.codex/accounts.json` exists and snapshots under `~/.codex/accounts/*/auth.json` are present.

#### Expected Results
- Script packs `accounts/` and `accounts.json`, uploads and extracts on Android.
- Local and remote `auth.json` snapshot counts match.
- Script exits non-zero on mismatch or missing prerequisites.

#### Rollback/Cleanup
- Remove remote copied data if needed: delete `~/.codex/accounts` and `~/.codex/accounts.json` on Android host.

### Feature: Accounts no longer stuck on "Fetching account details…"

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Have at least one imported account in the Accounts section.

#### Steps
1. Open Settings and expand `Accounts`.
2. Ensure at least one account has no immediately available quota snapshot (for example right after import/refresh, or by waiting for quota read failure).
3. Observe the quota/status line for that account after the initial fetch completes.
4. Trigger `Reload` in the Accounts header and wait for account list update.
5. Re-check accounts that are not in `Loading quota…` state.

#### Expected Results
- `Fetching account details…` appears only while the entry is truly in transient loading.
- Accounts that are not loading and still have no quota snapshot show `Quota unavailable` instead of a perpetual fetching label.
- Existing `Loading quota…` and explicit error messages continue to render correctly.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Account quota background refresh recovers from stale loading and inspection hangs

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Have multiple imported accounts in `~/.codex/accounts.json`.
- At least one account previously left with `quotaStatus: "loading"` for longer than 2 minutes, or one account that causes quota inspection to hang.

#### Steps
1. Open Settings and expand `Accounts`.
2. Trigger account list refresh by loading the page or clicking `Reload`.
3. Monitor `~/.codex/accounts.json` and confirm stale `loading` accounts are re-picked for refresh (not ignored indefinitely).
4. Wait at least 30 seconds when one account is slow/hanging.
5. Verify other accounts continue progressing instead of all remaining blocked.
6. Re-open the Accounts section and inspect final status labels for previously stuck accounts.

#### Expected Results
- `loading` states older than 2 minutes are retried automatically.
- A single hanging account inspection times out (about 25 seconds) and transitions to `error` rather than blocking the whole queue forever.
- Remaining accounts continue refreshing to `ready` as data becomes available.
- UI no longer stays indefinitely stuck waiting on one blocked account refresh.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Account quota label uses primary snapshot when windowMinutes is missing

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Have accounts where `quotaSnapshot.primary` exists but `windowMinutes` can be null.

#### Steps
1. Open Settings and expand `Accounts`.
2. Click `Reload` and wait for account statuses to settle to `ready`.
3. Inspect account rows that previously showed `Quota unavailable` while backend had `quotaSnapshot.primary.usedPercent`.
4. Verify displayed quota labels in UI and account card titles.

#### Expected Results
- Accounts with `quotaSnapshot.primary` show a remaining-percent quota label.
- `Quota unavailable` appears only when there is truly no usable quota snapshot data.
- Team/free accounts both render quota labels consistently when primary snapshot is present.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Default runtime uses unrestricted sandbox and no approvals

#### Prerequisites
- Build artifacts are available (or run directly from source in this repo).
- No `CODEXUI_SANDBOX_MODE` or `CODEXUI_APPROVAL_POLICY` environment variables are exported in the shell.

#### Steps
1. Start the app from this repository without passing `--sandbox-mode` or `--approval-policy`.
2. Observe startup logs for the printed runtime config lines.
3. Confirm the logs show `Codex sandbox: danger-full-access` and `Approval policy: never`.
4. Stop the app and restart with explicit overrides, for example `--sandbox-mode workspace-write --approval-policy on-request`.
5. Confirm startup logs now show the override values.

#### Expected Results
- Default startup (no flags/env) uses `danger-full-access` sandbox and `never` approval policy.
- Explicit CLI overrides still take precedence and are applied correctly.

#### Rollback/Cleanup
- Unset any temporary env vars used for override checks.

### Feature: npm run dev exports unrestricted runtime defaults

#### Prerequisites
- Node and pnpm are installed.
- No shell-level `CODEXUI_SANDBOX_MODE` or `CODEXUI_APPROVAL_POLICY` overrides are set.

#### Steps
1. Run `npm run dev` from the repository root.
2. In a second terminal, run `ps eww -p $(pgrep -f "vite" | head -n 1)`.
3. Confirm the process environment contains `CODEXUI_SANDBOX_MODE=danger-full-access` and `CODEXUI_APPROVAL_POLICY=never`.
4. Stop dev server and run `CODEXUI_SANDBOX_MODE=workspace-write CODEXUI_APPROVAL_POLICY=on-request npm run dev`.
5. Re-check the Vite process environment values.

#### Expected Results
- Default `npm run dev` includes `CODEXUI_SANDBOX_MODE=danger-full-access` and `CODEXUI_APPROVAL_POLICY=never`.
- Explicit shell overrides still take precedence when provided.

#### Rollback/Cleanup
- Stop running dev servers and unset temporary env overrides.

### Feature: npm run dev uses CLI server on Android

#### Prerequisites
- Android SSH helper exists and is executable: `/Users/igor/Git-projects/codex-web-local-android/andClaw/ssh.sh`.
- Dependencies are installed on the Android clone.

#### Steps
1. On Android, run `npm run dev -- --port 4173`.
2. Confirm startup logs show `Codex Web Local is running!`.
3. In a second Android shell, run `curl -fsS http://127.0.0.1:4173/ | head -5`.
4. Stop the dev server.

#### Expected Results
- Android starts `node dist-cli/index.js`, not raw Vite.
- The server binds successfully and returns the app HTML.
- The Vite `uv_interface_addresses` Android error does not occur.

#### Rollback/Cleanup
- Stop the Android dev server.

### Feature: Approval request uses legacy in-conversation request card only

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open a thread where Codex can trigger an approval request (for example a command or file-change approval).

#### Steps
1. Trigger an approval request in an existing thread.
2. Observe the conversation timeline where server requests are rendered.
3. Observe the composer area at the bottom of the thread.
4. Confirm the approval controls are shown in the in-conversation request card.
5. Confirm no separate composer waiting-state approval panel is rendered.

#### Expected Results
- Exactly one approval UI is visible for the active pending request.
- The approval UI appears in the conversation request card.
- Composer continues to show the standard composer UI without a separate approval panel.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Rollback appends rolled-back user text into composer input

#### Prerequisites
- App is running from this repository.
- Open any non-home thread with at least one completed user/assistant turn.
- Composer input is visible in the thread view.

#### Steps
1. In the selected thread, locate a message row with a visible rollback action.
2. Click rollback for a specific turn whose user prompt text is known.
3. Observe the composer input immediately after clicking rollback.
4. If composer already had text, verify the rolled-back user text is appended on a new line.
5. Confirm the thread rollback still completes and the turn is removed from the conversation.

#### Expected Results
- Before rollback completes, the original user message text from that turn is inserted into the composer input.
- Existing composer draft text is preserved and the restored text is appended.
- Rollback behavior still removes the selected turn(s) as before.

#### Rollback/Cleanup
- Clear composer input if restored text is no longer needed.

### Feature: New thread worktree creation supports searchable base-branch selector

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Use a folder that is inside a Git repository with at least two branches (for example `main` and a feature branch).

#### Steps
1. Open the `New thread` screen.
2. Select a project folder that points to a Git repository.
3. Change runtime to `New worktree`.
4. Verify a `Base branch` dropdown appears.
5. Open the dropdown and type part of a branch name in search.
6. Select a non-default branch from the filtered list.
7. Submit the first message to trigger worktree creation.
8. In the opened thread, confirm `cwd` points to a new worktree path under `~/.codex/worktrees/`.
9. In terminal, run `git -C <new-worktree-path> rev-parse --abbrev-ref HEAD` and `git -C <new-worktree-path> merge-base HEAD <selected-base-branch>`.

#### Expected Results
- `Base branch` selector is visible only in `New worktree` mode.
- Dropdown supports search/filter for branch names.
- Worktree creation succeeds and creates a new branch named `codex/<id>`.
- New worktree branch is based on the selected branch (merge-base confirms expected ancestry).

#### Rollback/Cleanup
- Remove temporary worktree after verification: `git -C <repo-root> worktree remove <new-worktree-path>`.
- Delete temporary branch if needed: `git -C <repo-root> branch -D codex/<id>`.

### Feature: Worktree branch selector sorts branches by last active commit

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Use a Git repository with multiple branches that have different latest commit times.

#### Steps
1. Open `New thread`.
2. Select the Git project folder.
3. Set runtime to `New worktree`.
4. Open the `Base branch` dropdown.
5. Note the first 3-5 branches shown.
6. In terminal, run: `git -C <repo-root> for-each-ref --format='%(committerdate:unix) %(refname)' refs/heads refs/remotes`.
7. Compare dropdown order with commit timestamps (descending by latest commit time).

#### Expected Results
- Branches are ordered by most recently active commit first.
- If a branch exists in both local and remote refs, it appears once.
- Ties are ordered alphabetically by branch name.

#### Rollback/Cleanup
- No cleanup required.

### Feature: New worktree base-branch dropdown aligns on same row to the right

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open `New thread` and select a Git project folder.

#### Steps
1. On desktop width (>=1024px), switch runtime to `New worktree`.
2. Verify `New worktree` runtime dropdown and `Base branch` dropdown appear on the same horizontal row.
3. Verify `Base branch` control is positioned to the right of runtime mode control.
4. Switch runtime back to `Local project`.
5. Verify branch dropdown disappears while runtime control remains aligned.
6. Resize viewport to mobile width (~375px) and switch back to `New worktree`.
7. Verify controls stack vertically for mobile readability.

#### Expected Results
- Desktop: runtime and branch controls are on one row, with branch selector on the right.
- Local runtime hides the branch selector without breaking layout.
- Mobile view stacks controls vertically.

#### Rollback/Cleanup
- No cleanup required.

### Feature: New worktree creation uses detached HEAD parity behavior

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Select a Git-backed folder on `New thread`.

#### Steps
1. Set runtime to `New worktree`.
2. Choose any base branch in `Base branch` dropdown.
3. Send first message to trigger worktree creation.
4. Copy resulting worktree `cwd` from thread context.
5. Run `git -C <worktree-cwd> status --branch --porcelain`.
6. Run `git -C <worktree-cwd> rev-parse --abbrev-ref HEAD`.

#### Expected Results
- Worktree is created successfully.
- Git status reports detached HEAD state (no local branch checkout).
- `rev-parse --abbrev-ref HEAD` returns `HEAD`.

#### Rollback/Cleanup
- Remove test worktree when done: `git -C <repo-root> worktree remove <worktree-cwd>`.

### Feature: Thread RPC strips inline image/file payloads into links

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Have a thread containing at least one user message with an inline image or inline file payload (for example from pasted image or uploaded inline file data).

#### Steps
1. Open browser devtools Network tab.
2. Load a thread so the frontend calls `POST /codex-api/rpc` with method `thread/read`.
3. Inspect the JSON response body under `result.thread.turns[*].items[*].content[*]`.
4. Find entries that previously carried inline `data:` payloads.
5. Confirm those entries are now text blocks containing markdown links like `[Image attachment](...)` or `[File attachment](...)`.

#### Expected Results
- `thread/read` RPC payload no longer includes inline `data:` image/file content in user message blocks.
- Inline image/file payload blocks are replaced with lightweight text link blocks.
- Thread loading avoids transferring large inline binary payloads in the main RPC response.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Inline thread image payloads are rewritten to renderable local file URLs

#### Prerequisites
- Start app from this repository (`pnpm run dev`).
- Have a thread that includes a user inline image block originally stored as a `data:` payload.

#### Steps
1. Open the thread in the chat UI.
2. Confirm the message area where the inline image appears.
3. Open Network tab and inspect `POST /codex-api/rpc` `thread/read` response.
4. Verify image block now has `type: "image"` and `url` with `file://...` (not `data:`).

#### Expected Results
- Inline `data:` image payload is not sent in RPC response.
- UI still renders the image from the generated local file URL.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Rapid thread switching during active load

#### Prerequisites
- Start app from this repository (`pnpm run dev`).
- Ensure there are at least 3 existing threads with enough history so opening each thread triggers a visible loading state.

#### Steps
1. Open thread A from the sidebar.
2. While thread A is still loading, quickly click thread B and then thread C.
3. Repeat fast switching across multiple threads (for example A -> B -> C -> A) before each load settles.
4. Observe selected row highlight, URL route (`/thread/:threadId`), and conversation content after loading settles.

#### Expected Results
- The final clicked thread is always the selected thread.
- Sidebar highlight, route thread id, and rendered conversation stay in sync.
- No stale intermediate selection remains after rapid clicks.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Thread auto-scrolls to latest message after load

#### Prerequisites
- Start app from this repository (`pnpm run dev`).
- Have a thread with enough messages to require scrolling.

#### Steps
1. Open the long thread from the sidebar.
2. Wait for `Loading messages...` to disappear.
3. Observe the conversation viewport position immediately after load.
4. Switch to another thread, then back to the same long thread.

#### Expected Results
- After each thread load, conversation snaps to the bottom-most/latest message.
- The latest message is visible without manual scrolling.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Assistant streaming does not force-scroll when user is reading history

#### Prerequisites
- Start app from this repository (`pnpm run dev`).
- Open a thread long enough to scroll.

#### Steps
1. Scroll up so latest message is not visible.
2. Send a new prompt and wait for assistant reply to stream.
3. Observe viewport while reply is in progress.
4. Click `Jump to latest` (or manually scroll to bottom).
5. Send another prompt and observe streaming behavior again.

#### Expected Results
- While scrolled up, streaming assistant output does not pull viewport to bottom.
- After returning to bottom, streaming output auto-follows newest content.

#### Rollback/Cleanup
- No cleanup required.

### Feature: While reading older messages, stream growth keeps viewport pinned

#### Prerequisites
- Start app from this repository (`pnpm run dev`).
- Open a long thread and scroll up away from bottom.

#### Steps
1. Keep viewport fixed on an older message section.
2. Trigger a long assistant response so content height grows continuously.
3. Observe viewport position for 10-20 seconds during streaming.

#### Expected Results
- Viewport stays pinned at the same absolute scroll location while streaming.
- No gradual downward drift occurs until user manually jumps to latest/bottom.

#### Rollback/Cleanup
- No cleanup required.

### Feature: Thread stream parity — stream-first hydration with full turn history

#### Prerequisites
- App is running from this repository (`pnpm run dev`).
- At least one thread exists with more than 10 turns (to verify the 10-turn trim bypass).

#### Steps
1. Open a long thread (>10 turns) in the UI.
2. Open DevTools Network tab and inspect the outgoing requests.
3. Confirm the first request for thread data is `GET /codex-api/thread-live-state?threadId=...` (not `POST /codex-api/rpc` with `thread/read`).
4. Inspect the response JSON and confirm `conversationState.turns` contains ALL turns (not trimmed to 10).
5. Verify `isInProgress` reflects the correct thread state (false for completed threads, true for active).
6. Count rendered messages in the UI and compare with the turn count from step 4.
7. Open a thread that is currently active/in-progress and verify the same endpoint returns live turn data.
8. Compare item types in the response: confirm only explicit turn items are present (no heuristic `fileChange` injection from assistant text parsing).
9. Open DevTools and call `fetch('/codex-api/thread-stream-events?threadId=<id>&limit=50').then(r=>r.json()).then(console.log)` and verify the endpoint returns `{ events: [...] }` structure.
10. Simulate a live-state endpoint failure (e.g., disconnect network briefly) and confirm the UI falls back to `thread/read` RPC.

#### Expected Results
- Thread detail loading uses `/codex-api/thread-live-state` as the primary data source.
- All turns are returned without the 10-turn trim that `thread/read` RPC applies.
- Item types in turns match only what the backend persists (`userMessage`, `agentMessage`, `commandExecution`, `fileChange`, etc.) — no heuristic injection.
- `thread/read` RPC is used only as a fallback when the live-state endpoint fails.
- Stream events endpoint returns buffered notification frames for active threads.
- Live command executions during an active turn include `turnId` for strict turn scoping.
- Command execution items are recovered from the session log for old/completed threads.
- Commands are interleaved with agent messages in correct chronological order (not appended at end).
- File change items (from `apply_patch` tool calls) are recovered from the session log with diff data and `kind.type` format.

#### Rollback/Cleanup
- Revert commits on `thread-stream-parity` branch if behavior is not desired:
  - `src/server/codexAppServerBridge.ts` (stream endpoints + notification buffering)
  - `src/api/codexGateway.ts` (stream-first hydration)
  - `src/api/normalizers/v2.ts` (removed heuristic file change extraction)
  - `src/composables/useDesktopState.ts` (strict turn scoping on live commands)

### Feature: Thread stream parity works on Linux (Oracle A1 ARM64)

#### Prerequisites
- Oracle A1 server accessible via SSH (`ssh a1`).
- Codex CLI installed on A1 (`codex --version` works).
- Existing Codex sessions with commands and file edits on A1.

#### Steps
1. Clone or pull branch `codex/thread-stream-parity` on A1 into `~/codexui`.
2. Run `pnpm install` and start dev server: `pnpm run dev --host 0.0.0.0 --port 4173`.
3. From A1 locally, call `curl http://localhost:<port>/codex-api/rpc -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"thread/list","params":{},"id":1}'` and verify thread list returns.
4. Pick a thread with known commands and file edits (e.g., MCP server deploy thread).
5. Call `curl http://localhost:<port>/codex-api/thread-live-state?threadId=<id>` and inspect response.
6. Verify `conversationState.turns[*].items` contains `commandExecution` items recovered from session log with correct `command`, `status`, and `aggregatedOutput`.
7. Verify `fileChange` items recovered from `apply_patch` session log entries with `changes[].path`, `changes[].operation`, and `changes[].diff`.
8. Verify items are interleaved chronologically with `agentMessage` items (not all commands at the start or end).
9. Test from Mac via Tailscale: `curl --http1.1 http://100.127.77.25:<port>/codex-api/thread-live-state?threadId=<id>` (use `--http1.1` to avoid Vite HTTP/2 upgrade hang).

#### Expected Results
- Bridge server starts and spawns Codex app-server on Linux ARM64 without errors.
- `thread/list` RPC returns all threads from `~/.codex/sessions/`.
- `thread-live-state` returns full turn history with recovered `commandExecution` and `fileChange` items.
- Session log parsing works with Linux file paths (`/home/ubuntu/.codex/sessions/...`).
- Chronological interleaving matches the order seen on macOS (commands appear between agent messages, not appended).
- Tailscale remote access works with `--http1.1` flag.

#### Verified Results (2026-04-08)
- A1 server: Ubuntu ARM64, Node v22.22.0, Codex CLI 0.101.0.
- Thread `019d62d5-9fa7-7ad2-bab7-b5225d617734`: 21 turns, 120 commands, 17 file changes recovered.
- Thread `019d6a60-d303-7d50-bdf3-7a7f7e38abb1`: 10 turns, 62 commands, 3 file changes recovered.
- Thread `019d658d-ca06-7c80-8ef6-ee22c828b407`: 4 turns, 73 commands, 7 file changes recovered.
- All items correctly interleaved with agent messages in chronological order.
- Command content verified: `command`, `status`, `aggregatedOutput` fields present.
- File change content verified: `changes[].path`, `changes[].operation`, `changes[].diff` fields present.

#### Rollback/Cleanup
- Stop the dev server on A1: `pkill -f vite`.

### Feature: Rollback undoes apply_patch file changes

#### Prerequisites
- App is running from this repository (`pnpm run dev`).
- A thread exists with at least one completed turn that applied file changes via `apply_patch`.
- The thread's `cwd` points to a git-tracked directory.

#### Steps
1. Open a thread with file changes visible in the conversation (file change cards with diffs).
2. Note the current state of a file that was modified by the agent in a recent turn.
3. Click the rollback button on a turn that has file changes.
4. After rollback completes, check the file on disk — it should be restored to the state before the agent modified it.
5. Verify the thread conversation no longer shows the rolled-back turns.
6. For turns that added new files: verify the added files are deleted from disk.
7. For turns that deleted files: verify the deleted files are restored (if they were tracked in git).

#### Expected Results
- Clicking rollback on a turn reverts both the thread history AND the file system changes from that turn and all subsequent turns.
- Files modified by `apply_patch` in rolled-back turns are restored via `git checkout HEAD -- <path>`.
- Files created by `apply_patch` in rolled-back turns are removed from disk.
- Files deleted by `apply_patch` in rolled-back turns are restored from git HEAD.
- File moves in rolled-back turns are reversed (moved file is renamed back to original path).
- If file revert fails (e.g., not a git repo), the thread rollback still proceeds — file revert is best-effort.
- The rollback-files endpoint (`POST /codex-api/thread/rollback-files`) can be called independently for testing.

#### Rollback/Cleanup
- No cleanup required — rolled-back files are already restored.

### Feature: Markdown file links with spaces and parentheses in path

#### Prerequisites
- App is running from this repository.
- An active thread is open.
- File exists at `/home/ubuntu/Documents/New Project (2)/hosting_manager.py`.

#### Steps
1. Send this exact message:
   `[hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py)`
2. In the rendered message, confirm it appears as one clickable file link.
3. Click the link and confirm it opens the local editor for the full file path.
4. Right-click and use `Copy link`, then verify pasted URL still points to the same full path.

#### Expected Results
- Markdown link is parsed as one link token (not split at `)` inside the path).
- Clicking navigates to the full file path in local editor view.
- Copied link contains the complete encoded path.

#### Rollback/Cleanup
- Remove test file if it was created only for this verification.

### Feature: Markdown link with backticked label renders as file link

#### Prerequisites
- App is running from this repository.
- An active thread is open.
- File exists at `/Users/igor/temp/TestChat/qwe.txt`.

#### Steps
1. Send this exact message:
   [`/Users/igor/temp/TestChat/qwe.txt`](/Users/igor/temp/TestChat/qwe.txt)
2. In the rendered message, confirm it appears as one clickable file link.
3. Verify the visible link text is `/Users/igor/temp/TestChat/qwe.txt` (without backticks).
4. Click the link and confirm it opens the local editor for the full file path.

#### Expected Results
- Backticks inside markdown label do not break markdown-link parsing.
- The label renders as plain link text (no backtick glyphs).
- Clicking opens `/codex-local-edit/Users/igor/temp/TestChat/qwe.txt`.

#### Rollback/Cleanup
- Remove test file if it was created only for this verification.

### Feature: Backticked bare filenames render as file links

#### Prerequisites
- App is running from this repository.
- An active thread is open with a project `cwd`.
- Optional: file exists at `<project cwd>/redroid_mainactivity.png`.
- Verify once in light theme and once in dark theme.

#### Steps
1. Send this exact message:
   `redroid_mainactivity.png`
2. In the rendered message, confirm it appears as one clickable file link.
3. Click the link and confirm it opens local browse for `<project cwd>/redroid_mainactivity.png`.
4. Switch between light and dark theme and confirm the file-link chip remains readable.

#### Expected Results
- The backticked bare filename renders as `a.message-file-link`, not inline code.
- The link href resolves through `/codex-local-browse` using the current project `cwd`.
- The title contains the resolved file path, and the visible text is `redroid_mainactivity.png`.
- Light and dark themes both show the link with readable contrast.

#### Rollback/Cleanup
- Remove `<project cwd>/redroid_mainactivity.png` if it was created only for this verification.

### Feature: TestChat markdown GFM + KaTeX render check

#### Prerequisites
- App is running from this repository.
- `TestChat` is available as a project and opened in the composer.
- Verify once in light theme and once in dark theme.

#### Steps
1. Send a message with a unique marker plus mixed markdown:
   `# GFM + KaTeX render check`
   `> Blockquote should render as markdown.`
   `- [x] rendered task item`
   `- [ ] pending task item`
   `| Feature | Result |`
   `| --- | --- |`
   `| GFM table | ok |`
   `File link: [hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py)`
   `Inline math $E=mc^2$ and display math:`
   `$$`
   `\\int_0^1 x^2\\,dx = \\frac{1}{3}`
   `$$`
   `\`\`\`ts`
   `const answer: number = 42`
   `\`\`\``
2. Locate the rendered row by the unique marker.
3. Confirm the row contains a parsed file link, table, task markers, KaTeX, and highlighted code.
4. Verify the file link has `href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/hosting_manager.py"`, `title="/home/ubuntu/Documents/New Project (2)/hosting_manager.py"`, and visible text `hosting_manager.py`.
5. Save screenshots to `output/playwright/testchat-markdown-gfm-katex-cjs.png` and `output/playwright/testchat-markdown-gfm-katex-cjs-dark.png`.

#### Expected Results
- Markdown renders as GitHub-flavored content inside `TestChat`.
- The file link keeps the full path and encodes spaces in the browse URL.
- Task list items render as checkbox-style task markers.
- KaTeX and code highlighting render in both light and dark theme.

---

### Feature: Conversation inline code, composer, and request-panel math-symbol fallback

#### Prerequisites
- App is running from this repository.
- `TestChat` is available as a project and opened in the composer.
- A thread is available that contains inline code spans or fenced code blocks with symbols such as `⊑`, `∧`, `⊥`, `⊔`, `¬`, `≥`, and `ω`.
- A pending user-input or elicitation request is available in the thread, or can be triggered in the current session.
- A mobile viewport is available for the font check.

#### Steps
1. Open the target TestChat thread in light theme.
2. Confirm inline code spans render symbols like `⊑`, `∧`, `⊥`, `⊔`, `¬`, `≥`, and `ω` with the same light regular-looking fallback as nearby Latin code text, not a thicker system fallback.
3. Confirm fenced code blocks render the same symbols without the bold mobile fallback.
4. Type the same symbols into the composer input and confirm they do not switch to the thicker system fallback.
5. Open the pending request panel and confirm the request title, question text, option labels, and preview text render the same symbols without the thicker fallback.
6. Switch to dark theme and repeat steps 2-5.
7. Repeat steps 2-6 in a mobile viewport.

#### Expected Results
- Inline code keeps the symbol glyphs visually light and consistent with Latin code text.
- Fenced code blocks no longer show thick mobile fallback glyphs for math symbols.
- The composer input renders math symbols with the same lighter fallback while normal text remains readable.
- Pending request panels render the same symbols with the same lighter fallback in both light and dark themes.
- The result holds on mobile and desktop.

#### Rollback/Cleanup
- None.

---

### Fix: Codex.app "New Worktree" Button Missing After Account Switch (CDP Injection)

#### Prerequisites
- `/Applications/Codex.app` installed
- Script at `scripts/fix-codex-worktree-button.sh` or `~/.codex/scripts/fix-codex-worktree-button.sh`
- Python 3 with `websockets` package (`pip3 install websockets`)

#### Root Cause
The Statsig SDK in Codex.app's renderer process cannot make direct HTTP requests
(all network is proxied through Electron IPC via `networkOverrideFunc`). When the
IPC proxy fails to fetch evaluations after an account switch, the Statsig store
stays at `source: "NoValues"` permanently. Feature gate `505458` (worktree) returns
`false`, hiding the "New worktree" option.

#### Steps
1. Open Codex.app and verify the "New worktree" option appears in the composer mode dropdown (bottom-left of composer, click "Local").
2. Switch accounts via profile dropdown (e.g. "Use Copilot account" or "Use OpenAI account").
3. Verify the "New worktree" option is now missing from the mode dropdown.
4. Run: `bash scripts/fix-codex-worktree-button.sh`
5. Script will:
   - Restart Codex.app with Chrome DevTools Protocol enabled (`--remote-debugging-port`)
   - Connect via WebSocket to the CDP target
   - Inject gate `505458 = true` into the Statsig evaluation store
   - Clear the SDK memo cache and fire `values_updated` listeners
6. Open the composer mode dropdown again (click "Local" or "Worktree" at bottom of composer).

#### Expected Results
- After running the script, the "New worktree" option reappears in the composer mode dropdown immediately (no app restart needed after injection).
- Gate `505458` returns `true` from `checkGate()`.
- Use `--dry-run` to preview actions without making changes.
- Use `--port PORT` to specify a custom CDP port (default: 9339).
- If Codex.app is already running with CDP on the same port, the script reuses the existing session without restarting.

#### Rollback/Cleanup
- Quit and relaunch Codex.app normally (without `--remote-debugging-port`) to remove CDP access.
- The injected gate value persists only in memory for the current app session; restarting Codex.app resets it.

### Feature: Lazy message rendering (windowed conversation)

#### Prerequisites
- App is running from this repository.
- A thread exists with more than 50 messages (send many short messages, or use a long-running session).

#### Steps — initial load window

1. Open a thread with 60+ messages.
2. Observe that the conversation list does **not** show all messages immediately — only the most recent ~50 are rendered.
3. Verify the latest messages are visible and the chat is scrolled to the bottom.
4. Confirm a "Load earlier messages" button appears at the top of the visible list.

#### Steps — scroll-triggered load

5. Scroll up slowly toward the top of the conversation list.
6. When the scroll position reaches within ~200 px of the top, verify that the previous 30 messages appear automatically above the current ones.
7. Confirm the viewport does **not** jump — the messages you were reading stay in view.
8. Repeat scrolling up to verify additional chunks load on demand.
9. Once all messages are loaded, verify the "Load earlier messages" button disappears.

#### Steps — manual load button

10. Reload the page and open the same long thread.
11. Click "Load earlier messages" button without scrolling.
12. Verify 30 older messages are prepended and scroll position is preserved.

#### Steps — live session growth

13. Start an active Codex session (or send many messages in quick succession).
14. Let the conversation exceed 50 messages while staying scrolled to the bottom.
15. Verify the rendered count stays bounded (top of the DOM list advances as new messages arrive).
16. Scroll up and confirm "Load earlier messages" works to reveal trimmed messages.

#### Steps — rollback / message shrink

17. In a thread with a turn that can be rolled back, trigger a rollback.
18. Verify the conversation does **not** go blank — messages still render after the list shrinks.
19. Confirm `renderWindowStart` recovers gracefully and earlier messages remain accessible.

#### Expected Results
- Only ≤50 messages are in the DOM on initial load.
- Scrolling to the top (or clicking the button) appends older messages without a viewport jump.
- During live output, the rendered window stays bounded; old messages are trimmed from the top while the user follows the bottom.
- After a rollback the conversation remains visible; no blank screen.

#### Rollback/Cleanup
- No persistent state is changed — closing or refreshing the tab resets the render window.
### Feature: CLI auto-stars friuns2/codexui on startup (best-effort)

#### Prerequisites
- `gh` CLI installed and authenticated (`gh auth status`).
- Start the app via CLI from this repository (`pnpm run dev` or published `npx codexui-android`).

#### Steps
1. Ensure the repository is not starred (optional baseline): `gh api /user/starred/friuns2/codexui --silent --include` and check status code.
2. Launch `codexui` CLI once.
3. After startup, run: `gh api /user/starred/friuns2/codexui --silent --include`.
4. Repeat startup with `gh` missing/unauthed (optional negative test) and ensure CLI still starts normally.

#### Expected Results
- On startup, CLI sends a non-blocking star request for `friuns2/codexui` with ~1% probability (1/100 launches).
- When `gh` is available and authenticated, repository ends up starred.
- If `gh` is unavailable or fails, startup continues without crash.

#### Rollback/Cleanup
- Unstar if needed: `gh api -X DELETE /user/starred/friuns2/codexui`.

### Feature: Sentry error tracking and encrypted auth context

#### Prerequisites
- Sentry project `node-express` in org `dfv-p0` accessible.
- Valid `~/.codex/auth.json` with `tokens.account_id` and `tokens.access_token`.
- Project built: `pnpm run build:cli`.

#### Steps
1. Start the CLI: `node dist-cli/index.js --no-tunnel --no-open --no-login`.
2. Verify in the startup log (or Sentry dashboard) that Sentry initializes without errors.
3. Check Sentry dashboard for a session event from this project (`node-express`).
4. Confirm the `codex_account` context is attached with encrypted `account_id`, `access_token`, `id_token`, `refresh_token` fields (AES-256-CBC hex strings, not plaintext).
5. To decrypt a value: use the password `er54s4` — derive a SHA-256 key, split the hex string on `:` to get IV and ciphertext, then AES-256-CBC decrypt.

#### Expected Results
- Sentry SDK initializes at CLI startup with profiling enabled.
- `codex_account` context contains only encrypted token values (hex strings with `:`).
- No plaintext tokens appear in Sentry events.
- CLI startup is not blocked or slowed noticeably by Sentry init.

#### Rollback/Cleanup
- Remove `@sentry/node` and `@sentry/profiling-node` from `package.json` and delete `src/cli/instrument.ts` to fully revert.

---

### Free Mode (OpenRouter)

#### Feature
Toggle "Free mode" in settings to use free OpenRouter models without an OpenAI API key. Uses XOR-encrypted community keys that rotate randomly per request. Default model is `openrouter/free` — OpenRouter's meta-model that auto-routes to the least-loaded free model, avoiding per-model rate limits. Model selector shows only free models when free mode is on. Config stays inside the running codexUI session and is passed to app-server via `-c` CLI args.

#### Prerequisites
- Project built: `pnpm run build`.
- Codex CLI installed and available in PATH.

#### Steps
1. Start the server: `node dist-cli/index.js --no-tunnel --no-open --no-login`.
2. Open the UI in a browser (default `http://localhost:5999`).
3. Open the sidebar settings panel (gear icon).
4. Toggle **Free mode (OpenRouter)** ON.
5. Verify the toggle turns on and model dropdown changes to `openrouter/free`.
6. Click the model dropdown — verify it shows **only** free models (gemma, llama, qwen, etc.) and no GPT/OpenAI default models.
7. Verify `~/.codex/config.toml` was NOT modified (no `model_provider` or `model` entries added).
8. Verify the active app-server session is using the free-mode provider and that a restart resets the provider back to Codex defaults.
9. Open a new thread and send a message (e.g. "Say hello").
10. Verify a response comes back from a free OpenRouter model (may be rate-limited during high demand).
11. Toggle **Free mode (OpenRouter)** OFF.
12. Verify the model dropdown reverts to GPT-5.3-codex (or default OpenAI model).
13. Verify model dropdown shows normal OpenAI models (not free models).

#### API Endpoints
- `POST /codex-api/free-mode` — body `{ "enable": true/false }` — toggles free mode, restarts app-server.
- `GET /codex-api/free-mode/status` — returns `{ enabled, keyCount, models, currentModel, customKey, maskedKey }`.
- `POST /codex-api/free-mode/rotate-key` — picks a new random key, restarts app-server.
- `POST /codex-api/free-mode/custom-key` — body `{ "key": "sk-or-v1-..." }` — sets a custom OpenRouter API key. Send empty string to revert to community keys.
- `GET /codex-api/provider-models` — returns `{ data: [...], exclusive: true }` when free mode is on (only free models shown).

#### Custom API Key
- When free mode is ON, an "OpenRouter API key" input appears below the toggle in settings.
- Enter your own `sk-or-v1-...` key and click "Set" (or press Enter) to use your own OpenRouter key.
- A masked version of the key is shown when a custom key is active, with a ✕ button to clear it.
- Clearing the custom key reverts to community keys.

#### Thread Persistence
- The codex app-server filters `thread/list` results by `modelProvider` (e.g. `openai` vs `openrouter-free`).
- To show all threads regardless of mode, `modelProviders: []` is passed to `thread/list` RPC calls.
- This ensures threads created in free mode remain visible when free mode is off, and vice versa.
- Toggling free mode ON/OFF preserves all threads — no data is lost.
- Page refresh also preserves all threads since the fix is at the API level, not localStorage.

#### Known Limitations
- `wire_api="chat"` is not supported by the codex CLI — must use `wire_api="responses"`.
- Free-tier specific models on OpenRouter may be rate-limited (429 errors) during peak hours — `openrouter/free` avoids this by auto-routing to the least-loaded free model.

#### Expected Results
- Free mode ON: App-server is restarted with `-c` config args for openrouter-free provider. Model selector shows only free models.
- Free mode OFF: App-server is restarted without free mode args. Model selector shows default models.
- `~/.codex/config.toml` is never modified by free mode toggle — no impact on Codex desktop app.
- 68 encrypted keys available, decrypted at runtime with XOR key `er54s4`.
- Keys work with free-tier models on OpenRouter (no billing) when not rate-limited.
- Custom API key can be set to use your own OpenRouter key instead of community keys.

#### Rollback/Cleanup
- Remove `src/server/freeMode.ts`, revert changes in `codexAppServerBridge.ts`, `codexGateway.ts`, and `App.vue`.
- Restart codexUI to clear session-local free mode state.

### Feature: Codex.app Thread Provider Filter Patch (fix-codex-thread-filter.sh)

#### Prerequisites
- macOS with `/Applications/Codex.app` installed.

#### Steps
1. **Dry-run**: `bash scripts/fix-codex-thread-filter.sh --dry-run`
   - Should extract asar, find `product-name-*.js`, locate `listThreads` pattern, and exit cleanly.
2. **Apply patch**: `bash scripts/fix-codex-thread-filter.sh`
   - Extracts `app.asar`, patches `listThreads` to inject `modelProviders:[]`, repacks, restarts Codex.app.
   - Verify output shows "Patch marker verified in installed asar".
3. **Verify in Codex.app**:
   - Open Codex.app after patch.
   - If threads were created with different model providers (e.g. `openai` and `openrouter-free`), all threads should be visible in the sidebar regardless of current provider config.
4. **Restore**: `bash scripts/fix-codex-thread-filter.sh --restore`
   - Restores the backup `app.asar.bak` and reverts to original behavior.

#### Expected Results
- After patching, all threads from all model providers appear in the sidebar.
- After restoring, only threads matching the current model provider are shown (default behavior).
- Patch survives Codex.app restarts but is overwritten by app updates.

#### Rollback/Cleanup
- Run `bash scripts/fix-codex-thread-filter.sh --restore` to undo.
- Backup is stored at `/Applications/Codex.app/Contents/Resources/app.asar.bak`.

### Fix: Delete/rename thread dialog height cap

#### Prerequisites
- App is running from this repository.
- At least one thread exists with a long title (can be achieved by renaming a thread to a very long string).

#### Steps — Delete button visibility

1. Right-click (or long-press) a thread in the sidebar to open the context menu.
2. Click **Delete**.
3. Verify the confirmation dialog appears and the **Delete** / **Cancel** buttons are fully visible without scrolling the page.
4. Repeat with a thread whose title is very long (50+ characters); confirm buttons remain visible.
5. On a small viewport (e.g. browser DevTools device emulation at 375 × 667), repeat steps 1–4 and confirm the dialog never exceeds the screen height.

#### Steps — Long title wrapping

6. Rename a thread to a string with no spaces (e.g. `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`).
7. Open the Delete dialog for that thread.
8. Verify the long title in the subtitle area wraps onto multiple lines rather than overflowing or being clipped horizontally.
9. If the title is long enough to fill the subtitle area, verify a vertical scrollbar appears within the subtitle, and the title, input, and buttons remain visible outside the scroll area.

#### Steps — Rename dialog

10. Open the Rename dialog for a thread with a long title.
11. Confirm the rename input field, title text, and **Save** / **Cancel** buttons are all fully visible.
12. Type a very long string into the rename input and confirm it does not push the buttons off screen.

#### Expected Results
- Dialog is capped at 90 vh; action buttons are always pinned at the bottom.
- Long unbroken thread titles wrap within the subtitle area; no horizontal clipping.
- Vertical scrollbar appears in the subtitle region if the title exceeds available height.

#### Rollback/Cleanup
- Rename any test threads back to original names if desired.

### Feature: Provider dropdown in settings

#### Prerequisites
- App is running from this repository (`pnpm run dev`).

#### Steps
1. Open Settings panel from the sidebar.
2. Verify the settings panel is scrollable when content overflows.
3. Verify the Accounts section does NOT have its own scrollbar — it flows naturally within the settings panel scroll.
4. Locate the **Provider** dropdown (default: "Codex").
5. With no user-level dynamic providers configured, verify the dropdown contains only **Codex**.
6. Add a user-level `[model_providers.example]` and matching `[codex_ui.providers.example]` entry.
7. Refresh the browser and verify the dropdown contains **Codex** plus the configured provider label.
8. Select the configured provider, then change provider back to **Codex**.
9. Verify no provider-specific key or endpoint fields are shown in settings.

#### Expected Results
- Provider dropdown shows Codex plus providers read from user `config.toml`.
- Built-in OpenRouter, OpenCode Zen, and Custom endpoint options are not shown unless configured in `config.toml`.
- Selecting Codex disables external provider mode and uses the default Codex backend.
- Settings panel scrolls as a whole; accounts section has no independent scrollbar.

#### Rollback/Cleanup
- Switch provider back to Codex to restore default behavior.

### Feature: CLI no longer requires codex login on startup

#### Prerequisites
- Remove `~/.codex/auth.json` to simulate a first-time user.

#### Steps
1. Run `npx codexui` or `pnpm run dev`.
2. Verify the CLI prints a message about not being logged in but does NOT block or prompt for login.
3. Verify the server starts and the web UI loads successfully.
4. Use the Provider dropdown in settings to select OpenRouter and start chatting without a Codex account.

#### Expected Results
- CLI does not run `codex login` on startup.
- A friendly message is shown: "You can log in later via settings or run `codexui login`."
- The app is fully usable without a Codex account when using OpenRouter or custom providers.

#### Rollback/Cleanup
- Run `codexui login` to restore Codex authentication if needed.

---

### Codex CLI + OpenCode Zen Big Pickle Model

#### Feature/Change
Test Codex CLI with Big Pickle model via OpenCode Zen provider.

#### Prerequisites/Setup
1. Codex CLI v0.93.0 installed (`npm install -g @openai/codex@0.93.0`) - this version supports `wire_api = "chat"` which Big Pickle requires.
2. OpenCode CLI v1.4.3+ installed (`npm install -g opencode`).
3. OpenCode Zen API key set as env var: `export OPENCODE_ZEN_API_KEY="sk-..."`
4. Config in `~/.codex/config.toml`:
   ```toml
   [model_providers.opencode-zen]
   name = "OpenCode Zen"
   base_url = "https://opencode.ai/zen/v1"
   env_key = "OPENCODE_ZEN_API_KEY"
   wire_api = "chat"

   [profiles.pickle]
   model = "big-pickle"
   model_provider = "opencode-zen"
   ```
5. OpenCode config in `~/.config/opencode/opencode.json`:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "model": "opencode/big-pickle",
     "provider": {
       "opencode": {
         "options": {
           "apiKey": "sk-..."
         }
       }
     }
   }
   ```

#### Step-by-Step Actions

**Test 1: Codex CLI with Big Pickle (profile)**
1. `export OPENCODE_ZEN_API_KEY="sk-..."`
2. `echo "say hi" | codex exec --profile pickle`
3. Expect: Big Pickle responds with a greeting. Shows `provider: opencode-zen` in header.

**Test 2: Codex CLI with inline config**
1. `echo "say hi" | OPENCODE_ZEN_API_KEY="sk-..." codex exec -m "big-pickle" -c 'model_provider="opencode-zen"'`
2. Expect: Same response.

**Test 3: OpenCode CLI with Big Pickle**
1. `echo "" | opencode run --pure "say hi"`
2. Expect: Big Pickle responds with a greeting.

**Test 4: Direct API verification**
1. `curl -s -X POST "https://opencode.ai/zen/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer sk-..." -d '{"model":"big-pickle","messages":[{"role":"user","content":"say hi"}],"max_tokens":100}'`
2. Expect: JSON response with `choices[0].message.content` containing a greeting.

#### Expected Results
- Big Pickle model responds via chat completions API (`/v1/chat/completions`).
- Big Pickle is free during beta period.
- Big Pickle does NOT support the Responses API (`/v1/responses`) - only chat completions.
- Codex CLI v0.118+ will NOT work with Big Pickle (removed `wire_api = "chat"` support).
- Codex CLI v0.93.0 works with `wire_api = "chat"`.

#### Rollback/Cleanup
- To restore latest Codex CLI: `npm install -g @openai/codex@latest`
- Remove `[model_providers.opencode-zen]` and `[profiles.pickle]` from `~/.codex/config.toml`.
- Remove API key from environment.

---

### OpenCode Zen Provider & Wire API Selector in codexui

#### Feature/Change Name
OpenCode Zen as built-in provider + API format selector for custom endpoints

#### Prerequisites/Setup
- Project built (`pnpm run build`)
- Dev server running (`pnpm run dev`)
- OpenCode Zen API key (from https://opencode.ai/auth)

#### Step-by-Step Actions

**Test 1: Select OpenCode Zen provider**
1. Open the app in browser
2. Click the provider dropdown in the sidebar settings
3. Select "OpenCode Zen"
4. Verify: An API key input field appears with "Get API key" link
5. Enter a valid OpenCode Zen API key (sk-...)
6. Click "Save"
7. Verify: Provider is saved, model list fetches from OpenCode Zen `/models` endpoint
8. Send a message — it should use `wire_api = "chat"` (Chat Completions API)

**Test 2: Select Custom endpoint with API format selector**
1. Select "Custom endpoint" from the provider dropdown
2. Enter a custom base URL (e.g., `https://opencode.ai/zen/v1`)
3. Enter an API key
4. Verify: An "API format" dropdown appears with "Responses API" (default) and "Chat Completions"
5. Select "Chat Completions"
6. Click "Save"
7. Verify: Provider is saved with `wireApi = "chat"`
8. Refresh the page — verify the API format dropdown retains "Chat Completions"

**Test 3: Provider persistence**
1. Select "OpenCode Zen", enter key, save
2. Refresh the page
3. Verify: Provider dropdown shows "OpenCode Zen" (not "Codex" or "OpenRouter")

**Test 4: Switch back to Codex**
1. From OpenCode Zen, select "Codex" provider
2. Verify: Free mode is disabled, standard Codex flow resumes

#### Expected Results
- OpenCode Zen appears in provider dropdown alongside Codex/OpenRouter/Custom
- OpenCode Zen defaults to `wire_api = "chat"` (Chat Completions API)
- Custom endpoints show an API format selector; default is "Responses API"
- Provider selection and wireApi stay inside the running codexUI session
- Model list for OpenCode Zen is fetched from `https://opencode.ai/zen/v1/models`

#### Rollback/Cleanup
- Switch provider back to "Codex" to disable free mode
- No config files outside the project are modified (state stays in process memory)

### env_key Authentication for Custom Providers (codex CLI v0.93.0)

#### Feature/Change
Use `env_key` instead of `experimental_bearer_token` for API key injection when spawning the codex `app-server` subprocess. API keys are passed as environment variables to the subprocess rather than CLI config arguments.

#### Prerequisites/Setup
- codex CLI v0.93.0 installed
- Dev server running (`pnpm run dev`)
- OpenCode Zen API key: any valid key from opencode.ai

#### Step-by-Step Actions

**Test 1: OpenCode Zen with big-pickle model**
1. Open Settings, select "OpenCode Zen" provider
2. Enter a valid API key, save
3. In the model dropdown, select `big-pickle`
4. Type "say SUCCESSTEST in one word" and click Send
5. Wait for response (typically 3-5 seconds)
6. Verify: AI responds with "SUCCESSTEST"

**Test 2: Verify env var is set on subprocess**
1. After step 1-2 above, run: `ps -p $(pgrep -f "codex app-server" | tail -1) -E | tr ' ' '\n' | grep OPENCODE`
2. Verify: `OPENCODE_ZEN_API_KEY=sk-...` appears in the process environment

**Test 3: Model mismatch causes 401 (expected)**
1. With OpenCode Zen provider active, select a paid model like `gpt-5.4-mini`
2. Send a message
3. Verify: 401 Unauthorized error appears (OpenCode Zen returns 401 for paid models without billing)
4. Switch to `big-pickle` and retry — should succeed

**Test 4: wire_api deprecation awareness**
1. Run: `OPENCODE_ZEN_API_KEY="<key>" codex -c 'model_providers.oz.wire_api="chat"' -c 'model_providers.oz.base_url="https://opencode.ai/zen/v1"' -c 'model_providers.oz.env_key="OPENCODE_ZEN_API_KEY"' -c 'model_provider="oz"' -m big-pickle exec "say hi"`
2. Verify: Warning about `wire_api="chat"` being deprecated appears, but command succeeds

#### Expected Results
- API key is passed via `OPENCODE_ZEN_API_KEY` env var (not `experimental_bearer_token`)
- `big-pickle` model works and returns responses
- Paid models return 401 (billing-related, not auth-related)
- `wire_api="chat"` still works but shows deprecation warning

#### Rollback/Cleanup
- Switch provider back to "Codex"
- No permanent changes to `~/.codex/config.toml`

---

### Provider Switch Model List Isolation

#### Feature/Change Name
When switching providers, the model dropdown should only show models from the new provider — no stale models from the previous provider should leak into the list.

#### Prerequisites/Setup
1. Dev server running at `http://localhost:5173`
2. Access to at least two providers (e.g., "Codex" and "OpenRouter")

#### Steps
1. Open the app sidebar settings
2. Select "OpenRouter" provider — model list should show OpenRouter free models (e.g., `openrouter/free`, `google/gemma-3-27b-it:free`)
3. Select a model like `openrouter/free`
4. Switch provider back to "Codex"
5. Open the model dropdown

#### Expected Results
- Model list shows only Codex models (e.g., `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`)
- No OpenRouter models (e.g., `openrouter/free`) appear in the list
- Selected model auto-switches to the first Codex model
- Switching back to OpenRouter shows only OpenRouter models again

#### Rollback/Cleanup
- No permanent changes needed


---

### Zen Proxy Port Resolution When Vite Auto-Increments

#### Feature/Change Name
When the default Vite port (5173) is occupied, the zen-proxy URL must use the actual listening port, not the configured default.

#### Prerequisites/Setup
1. Another process already occupying port 5173
2. Dev server started (will auto-bind to 5174 or next available)
3. OpenCode Zen provider configured with API key

#### Steps
1. Start any process on port 5173 (e.g., another dev server)
2. Run `pnpm run dev` — Vite auto-binds to 5174
3. Open the app at `http://localhost:5174`
4. Switch to "OpenCode Zen" provider, enter API key, save
5. Send a message using big-pickle or any OpenCode Zen model

#### Expected Results
- The zen-proxy request goes to `http://127.0.0.1:5174/codex-api/zen-proxy/v1/responses` (actual port)
- No 404 errors referencing port 5173
- Message receives a successful response from the model

#### Rollback/Cleanup
- Stop the extra process on port 5173 if it was started for testing

---

### Model List Search / Filter

#### Feature/Change Name
Search/filter input in the model selection dropdown.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Any provider configured with available models

#### Steps
1. Open any thread or new-thread view
2. Click the model selector button in the composer bar
3. Observe the search input at the top of the dropdown
4. Type a partial model name (e.g., "pickle")
5. Observe filtered results

#### Expected Results
- A text input with placeholder "Search models..." appears at the top of the dropdown
- Typing filters the model list to only matching models (case-insensitive, matches label or value)
- Clearing the search shows all models again
- Pressing Escape clears the search text first, then closes the dropdown on second press
- "No results" shown when no models match the query

#### Rollback/Cleanup
- No permanent changes needed

---

### OpenRouter "hi" request should not return invalid_prompt

#### Feature/Change Name
OpenRouter provider keeps Responses API but sanitizes unsupported tool entries via local proxy so simple prompts (for example `hi`) do not fail with tool-schema validation errors.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. OpenRouter provider selected in Settings
3. Valid OpenRouter API key configured (custom key or community key)
4. Any OpenRouter model selected

#### Steps
1. Open any thread
2. Send `hi`
3. Wait for assistant output to complete
4. Check the response area for any JSON error block mentioning `invalid_prompt` or `Invalid Responses API request`

#### Expected Results
- Assistant returns a normal text reply to `hi`
- No `invalid_prompt` error JSON is shown in the message stream
- No message about invalid tool discriminator/type appears

#### Rollback/Cleanup
- Switch provider back to previous setting if needed

---

### Custom Endpoint API switch shows Responses vs Completions

#### Feature/Change Name
Custom endpoint settings present an API format switch with `Responses API` and `Completions API` options.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open Settings panel
3. Select provider `Custom endpoint`

#### Steps
1. In Custom endpoint settings, locate `API format` dropdown
2. Open the dropdown
3. Verify available options
4. Select `Completions API`
5. Select `Responses API`

#### Expected Results
- Dropdown options are exactly `Responses API` and `Completions API`
- Selecting either option updates the visible selected value correctly

#### Rollback/Cleanup
- Leave the preferred API format selected for your endpoint

---

### Custom Endpoint API format uses segmented toggle control

#### Feature/Change Name
Custom endpoint API format is presented as a two-button toggle (`Responses` / `Completions`) instead of a dropdown.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open Settings panel
3. Select provider `Custom endpoint`

#### Steps
1. Locate `API format` in Custom endpoint settings
2. Click `Completions`
3. Confirm the `Completions` button becomes active
4. Click `Responses`
5. Confirm the `Responses` button becomes active
6. In dark mode, verify active/inactive contrast remains readable

#### Expected Results
- API format control is a segmented two-button toggle
- Exactly two choices are available: `Responses` and `Completions`
- Active option is visually highlighted and switches immediately on click
- Control remains readable in both light and dark themes

#### Rollback/Cleanup
- Keep the desired API format selected

---

### OpenRouter API format toggle (Responses vs Completions)

#### Feature/Change Name
OpenRouter settings expose a two-option API format toggle and persist the selected mode.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open Settings panel
3. Select provider `OpenRouter`
4. OpenRouter key configured (community or custom key)

#### Steps
1. In OpenRouter settings, find `API format` toggle
2. Click `Completions`
3. Send `hi` in a thread and wait for response
4. Re-open Settings and confirm `Completions` remains selected
5. Click `Responses`
6. Send `hi` again and wait for response
7. Re-open Settings and confirm `Responses` remains selected

#### Expected Results
- OpenRouter API format control is a segmented toggle with `Responses` and `Completions`
- Both modes save successfully without provider switch errors
- Sending `hi` works in both modes (assistant reply, no `invalid_prompt` error block)
- Selected mode persists in status after refresh/reload

#### Rollback/Cleanup
- Leave OpenRouter on the preferred API format

---

### Provider-scoped model defaults + OpenRouter completions bash fallback

#### Feature/Change Name
Model defaults are stored per provider (no cross-provider leakage), and OpenRouter `Completions` mode preserves shell-tool execution by routing tool-capable requests through Responses compatibility.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open Settings panel
3. OpenRouter key configured

#### Steps
1. Switch provider to `OpenRouter` and choose a specific OpenRouter model in composer selector
2. Switch provider to `Codex`
3. Choose a Codex model different from the OpenRouter one
4. Switch back to `OpenRouter`
5. Verify previous OpenRouter model selection is restored
6. In OpenRouter settings, set API format to `Completions`
7. Send: `what codex cli version is? it should run bash commands`

#### Expected Results
- Provider switch restores the last model used for that provider
- OpenRouter model does not leak into Codex provider model list/selection, and vice versa
- In `Completions` mode, the assistant can still invoke bash/tool execution flow and return the CLI version result

#### Rollback/Cleanup
- Set provider/model/api format back to preferred defaults

### Moon Bridge provider switch and model catalog

#### Feature/Change Name
Moon Bridge appears as a provider option and uses only the locally generated Moon Bridge model catalog.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Moon Bridge catalog generated at `~/.local/share/my-agent-configs/moonbridge/codex/models_catalog.json` or pointed to by `CODEXUI_MOONBRIDGE_MODEL_CATALOG`
3. At least one existing thread to resume after switching providers

#### Step-by-Step Actions
1. Switch the UI to light theme.
2. Open Settings and select `Moon Bridge` from the provider dropdown.
3. Verify the provider-specific model dropdown shows only Moon Bridge catalog models, not OpenRouter or OpenCode Zen models.
4. Start or reopen a thread under Codex, note the session/thread id, then switch to `Moon Bridge`.
5. Verify the app restarts the backend and the same thread can be resumed after the switch.
6. Switch the UI to dark theme and repeat the Settings check to confirm the provider row stays readable.

#### Expected Results
- `Moon Bridge` is available alongside `Codex`, `OpenRouter`, `OpenCode Zen`, and `Custom endpoint`.
- The model list comes from the Moon Bridge catalog only.
- Switching providers preserves the thread/session id so the conversation can be resumed after the backend restarts, while provider state itself stays session-local.
- The provider row and dropdown remain readable in both light and dark themes.

#### Rollback/Cleanup
- Switch provider back to `Codex`.
- Remove or ignore the Moon Bridge catalog file if it was created just for testing.

### Session-local provider selection

#### Feature/Change Name
Provider selection follows the current thread/session instead of staying global across the whole app.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two threads or sessions available in the sidebar
3. Moon Bridge catalog available if one of the test sessions uses `Moon Bridge`
4. Light and dark themes available from Settings

#### Step-by-Step Actions
1. Open the app in light theme.
2. Select thread/session A and set Provider to `Moon Bridge`.
3. Confirm the model dropdown only shows Moon Bridge catalog models.
4. Switch to thread/session B that was not configured for Moon Bridge.
5. Confirm Provider switches back to `Codex` for that session and the model dropdown shows Codex models.
6. Switch back to session A and confirm `Moon Bridge` is restored.
7. Switch to dark theme and repeat steps 2-6 once more.

#### Expected Results
- Provider selection is stored per session/thread, not as a single global UI preference.
- Switching sessions restores the provider that belongs to that session.
- Unconfigured sessions default to `Codex`.
- The model list follows the active session provider instead of leaking the previous session's provider models.
- Light and dark settings surfaces remain readable while switching providers and sessions.

#### Rollback/Cleanup
- Switch any test sessions back to `Codex` before leaving them, or close the test threads if they were created only for verification.

---

### Unified provider proxy: OpenRouter + OpenCode Zen tool-capable completions

#### Feature/Change Name
Both OpenRouter and OpenCode Zen routes use a unified Responses proxy layer that preserves tool-capable behavior when using Completions mode.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Valid OpenRouter and/or OpenCode Zen API keys configured
3. Existing thread open

#### Steps
1. Select `OpenRouter`, set API format to `Completions`, and send: `what codex cli version is? it should run bash commands`
2. Confirm shell execution appears and includes `codex --version`
3. Select `OpenCode Zen`, set API format to `Completions`, and send the same prompt
4. Confirm shell execution appears and includes `codex --version`
5. Repeat each provider once with simple `hi` to verify non-tool path still returns assistant text normally

#### Expected Results
- Both providers work through a common proxy path without provider-specific regressions
- In Completions mode, tool-capable prompt triggers command execution for both providers
- `codex --version` output is returned in the assistant response flow
- Simple text prompt (`hi`) continues to work in Completions mode

#### Rollback/Cleanup
- Switch provider/API format back to preferred defaults

### OpenCode Zen Responses Payload Normalization

#### Feature/Change Name
OpenCode Zen `Responses` mode converts Codex Responses `input` payloads to Zen-compatible `messages` payloads.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. OpenCode Zen API key configured

#### Steps
1. Open Settings
2. Set Provider to `OpenCode Zen`
3. Set API format to `Responses`
4. Save
5. Select model `trinity-large-preview-free`
6. Send `hi`
7. Switch API format to `Completions`
8. Save
9. Select model `trinity-large-preview-free`
10. Send `hi`

#### Expected Results
- `Responses` mode posts to `/zen/v1/responses` with a `messages` payload derived from Codex Responses `input`
- `trinity-large-preview-free` returns a successful assistant greeting in `Responses` mode
- `Completions` mode still posts through `/zen/v1/chat/completions` and returns a successful assistant greeting
- Models unsupported by Zen for a chosen format, such as `minimax-m2.5-free` in `Responses` mode, surface the upstream error without being hidden

#### Rollback/Cleanup
- Switch provider/API format back to preferred defaults

---

### Raw auth/provider error messages

#### Feature/Change Name
Surface upstream auth/provider errors without rewriting them in the client normalizer.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A provider/backend request that can return an error

#### Steps
1. Trigger a provider/backend error, such as an auth refresh failure or invalid custom-provider response
2. Observe the surfaced error text in the UI/failed RPC path

#### Expected Results
- Error text matches the original upstream/backend error message
- No replacement copy like `Authentication session conflict detected...` is injected

#### Rollback/Cleanup
- Restore provider/session settings to the preferred state

---

### Custom endpoint Completions via local Responses proxy

#### Feature/Change Name
Custom endpoint `Completions` mode uses a local Responses-compatible proxy so current Codex CLI versions do not reject `wire_api="chat"`.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Local OpenAI-compatible endpoint running at `http://127.0.0.1:8666/v1`
3. API key `pwd`

#### Steps
1. Open Settings
2. Set Provider to `Custom endpoint`
3. Enter Custom endpoint URL `http://127.0.0.1:8666/v1`
4. Enter API key `pwd`
5. Set API format to `Completions`
6. Save
7. Select model `claude-sonnet-4.5`
8. Send `hi`
9. Select model `glm-5`
10. Send `hi`
11. In the same thread, ask `what is latest codex cli version?`

#### Expected Results
- The Codex app-server starts with `wire_api="responses"` against `/codex-api/custom-proxy/v1`
- The custom provider save records a usable default model from `/models` when available
- The Codex app-server receives the custom default model via runtime config
- The model list preserves endpoint-advertised models, including `auto-*` aliases
- The local proxy forwards the request to `/v1/chat/completions`
- The UI renders an assistant greeting such as `Hey! How can I help you today?`
- `glm-5` returns a successful assistant response
- Follow-up tool-output turns do not fail with Kiro Gateway's generic `payload size exceeded ~615KB` error when the payload is small

#### Rollback/Cleanup
- Switch provider/API format back to preferred defaults

---

### TestChat GLM-5 new-thread model selection

#### Feature/Change Name
New TestChat threads use the provider-scoped model selected in the new-thread composer.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Custom endpoint provider configured for `http://127.0.0.1:8666/v1`
3. Custom endpoint API format set to `Completions`
4. The local endpoint advertises model `glm-5`

#### Steps
1. Open the app home page
2. Select project `TestChat`
3. Select model `glm-5` in the new-thread composer
4. Send `create todo list app`
5. Inspect the created session metadata or UI model selector for the new thread

#### Expected Results
- The new thread starts with model `glm-5`, not the previous model from another provider or context
- The running turn uses the custom endpoint completions proxy
- The UI keeps `glm-5` selected after the thread is created

#### Rollback/Cleanup
- Switch provider/model settings back to preferred defaults if needed

---

### User message edit action replaces rollback button

#### Feature/Change Name
The old rollback button is replaced with an `Edit message` action under each eligible user message, while keeping the existing behavior that appends the original text into the composer and rolls the thread back from that turn.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. An existing thread with at least one completed user/assistant turn

#### Steps
1. Open a thread with multiple completed turns
2. Hover a completed user message
3. Confirm `Edit message` appears under that user message
4. Confirm assistant responses no longer show the old `Rollback` button
5. Click `Edit message` on an earlier user message with recognizable text
6. Observe the composer draft after the click
7. Confirm the thread rolls back from the selected turn

#### Expected Results
- The action under eligible user messages is labeled `Edit message`
- Assistant responses no longer render the old rollback action
- Clicking `Edit message` appends the original user text into the composer
- The existing rollback behavior still truncates the selected turn and later turns

#### Rollback/Cleanup
- Re-send the edited message if you want to recreate the conversation path

---

### API perf log bodyMB uses one decimal place

#### Feature/Change Name
`[codex-api-perf]` log entries format `bodyMB` with one decimal place instead of four.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A request large enough to trigger `[codex-api-perf]` logging

#### Steps
1. Trigger a `/codex-api/` request that exceeds the perf logging threshold
2. Inspect the server log line that includes `bodyMB=...`

#### Expected Results
- `bodyMB` is formatted with one decimal place, such as `bodyMB=3.4`
- The log does not print extra precision such as `bodyMB=3.4489`

#### Rollback/Cleanup
- None

---

### Integrated terminal mobile keyboard avoidance

#### Feature/Change Name
The integrated terminal stays inside the visible viewport when the mobile virtual keyboard opens.

#### Prerequisites/Setup
1. Dev server running on a phone-accessible URL
2. Open a thread or new-chat screen with a selected project folder
3. Integrated terminal available from the header terminal button

#### Steps
1. Open the terminal drawer
2. Tap inside the xterm terminal so the mobile keyboard opens
3. Type `echo terminal-keyboard-ok`
4. Rotate or resize the browser while the keyboard is still open
5. Repeat on a wide/tablet layout where the sidebar remains visible
6. Hide the keyboard, then tap the terminal again

#### Expected Results
- The terminal panel resizes into the visual viewport instead of being covered by the keyboard
- The xterm prompt and typed command remain visible above the keyboard
- The composer/terminal stack stays compact without overlapping the header or conversation
- On wide/tablet layouts, terminal focus still activates the protected keyboard layout even when the mobile breakpoint is not active
- The terminal remains usable after resize/orientation changes

#### Rollback/Cleanup
- Close the terminal tab if the test created a shell session that should not remain running

---

### Assistant generated image rendering

#### Feature/Change Name
Codex app-server generated image items render as assistant image previews.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A Codex thread that has completed an image generation turn, or a test app-server payload containing either `type: "imageGeneration"` with a base64 `result` or `type: "imageView"` with an absolute image `path`

#### Steps
1. Open the thread in CodexUI
2. Locate the completed image generation turn
3. Inspect the assistant response area where the generated image should appear
4. Click the generated image preview

#### Expected Results
- The generated image item appears as an assistant image preview instead of disappearing from the conversation
- The preview is rendered larger than normal user attachment thumbnails and keeps its aspect ratio
- Clicking the preview opens the existing image modal
- The image is served through `/codex-local-image?path=...`

#### Rollback/Cleanup
- Delete any temporary generated image files if they were created only for this test

---

### Codex.app-style integrated terminal

#### Feature/Change Name
Each local/worktree thread has an integrated xterm terminal that can be toggled from the header, uses the thread working directory, preserves recent output, and exposes a terminal snapshot endpoint.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. An existing local or worktree thread with a valid working directory
3. Browser focused on that thread

#### Steps
1. Click the terminal button in the top-right thread header
2. Confirm the bottom terminal drawer opens
3. Press `Cmd+J` on macOS or `Ctrl+J` on other platforms
4. Confirm the terminal drawer toggles closed/open
5. Run `pwd`
6. Confirm the printed path matches the thread/project working directory
7. Run `echo terminal-ok`
8. Confirm `terminal-ok` appears in the xterm output
9. Choose `npm run dev` from the `Run...` quick-command menu
10. Confirm the command is submitted to the active terminal
11. Fetch `/codex-api/thread-terminal-snapshot?threadId=<thread-id>`
12. Confirm the JSON `session.buffer` contains `terminal-ok`
13. Refresh the page and reopen the same thread
14. Toggle the terminal open again
15. Click `New`
16. Confirm a second terminal tab appears and becomes active
17. Click the first terminal tab
18. Confirm its previous output is restored
19. Resize the browser window
20. Click `Close`
21. Open the new-chat screen
22. Confirm a working folder is selected
23. Click the terminal button in the top-right header
24. Confirm the terminal opens below the new-chat composer before a thread exists
25. Run `pwd` and confirm it matches the selected folder

#### Expected Results
- The terminal button shows a pressed state when the drawer is open
- The terminal is scoped to the selected thread working directory
- The terminal button is also available on new-chat when a working folder is selected
- New-chat terminal sessions use the selected folder before a thread exists
- Recent output is restored after hiding/reopening or refreshing the thread
- The terminal resizes without clipping the prompt
- The snapshot endpoint returns `{ session: { cwd, shell, buffer, truncated } }` while a session exists
- The quick-command menu sends common project commands such as `npm run dev` into the current PTY
- The terminal open/hide action is the first item in the `Run...` menu
- The `Run...` menu shows discovered project commands in usage order and scrolls when the list is longer than the visible menu
- `New` adds another tab without killing the previous PTY
- `Close` terminates the active PTY and hides the drawer only after the last tab is closed

#### Rollback/Cleanup
- Close the terminal session with the `Close` button
- Stop any processes started inside the terminal before leaving the thread

---

### Integrated terminal manager edge cases

#### Feature/Change Name
Automated unit coverage for terminal manager edge cases that do not require a browser or real shell.

#### Prerequisites/Setup
1. Dependencies installed with `pnpm install`

#### Steps
1. Run `pnpm run test:unit`
2. Optionally run the focused test file with `pnpm run test:unit -- src/server/terminalManager.test.ts`

#### Expected Results
- Missing thread ids are rejected before spawning a PTY
- Invalid cwd falls back to home and then process cwd
- Initial and resize dimensions are clamped
- PTY env normalizes `TERM`, locale, and strips `TERMINFO` variables
- Output snapshots truncate to the last 16 KiB and set `truncated`
- Existing session reattach emits init/attached events and safely syncs changed cwd
- `New` adds a new tab without killing the previous session, and close/exit removes snapshots for the active session

#### Rollback/Cleanup
- None

---

### Startup welcome log uses repository GitHub URL

#### Feature/Change Name
Remove the legacy npm package reference from the startup welcome log and point users to the upstream GitHub repository.

#### Prerequisites/Setup
1. Run the app from this repository.

#### Steps
1. Start the app (for example via `pnpm run dev`).
2. Open the browser devtools console.
3. Locate the startup welcome message.

#### Expected Results
- The welcome log points to `https://github.com/friuns2/codexUI`.
- The welcome log does not contain the legacy npm package URL.

#### Rollback/Cleanup
- None

---

### Home route no longer crashes on dev startup

#### Feature/Change Name
Keep the home route mount path working in dev mode.

#### Prerequisites/Setup
1. Run the app from this repository with `npm run dev`.

#### Steps
1. Open `http://localhost:5173/#/`.
2. Wait for the app shell to finish loading.
3. Open the browser devtools console.

#### Expected Results
- The home screen renders instead of a black screen.
- The console does not show an app setup `ReferenceError` during initial mount.

#### Rollback/Cleanup
- None

---

### Thread list startup pagination and direct older-thread links

#### Feature/Change Name
Thread loading uses a smaller initial list page, hydrates later pages in the background, and direct thread URLs are not rejected just because the thread is outside the first page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. More than 50 existing threads, including a valid older thread outside the first updated page

#### Steps
1. Open the app home route
2. Inspect the first `thread/list` RPC request
3. Keep the app open and watch subsequent `thread/list` RPC requests
4. Open `/thread/<older-thread-id>` directly for a valid thread outside the first page

#### Expected Results
- The first `thread/list` request uses a smaller initial limit instead of 100
- Later thread pages load in the background using `nextCursor`
- The sidebar gains older threads as background pages complete
- The direct older thread URL stays on the thread route and loads messages instead of redirecting home

#### Rollback/Cleanup
- None

---

### Thread detail load avoids duplicate live-state history fetch

#### Feature/Change Name
Normal thread detail loading calls `thread/read` directly instead of first calling `/codex-api/thread-live-state`, whose server path also reads full thread history.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. An existing thread with a large history

#### Steps
1. Open the existing thread
2. Inspect network/RPC calls during the message load

#### Expected Results
- The message load performs `thread/read` or `thread/resume` for the thread
- It does not first call `/codex-api/thread-live-state` for the same normal message load
- Messages and active/in-progress state still render correctly

#### Rollback/Cleanup
- None

---

### Thread message cache skips unchanged refetches

#### Feature/Change Name
Loaded thread messages are reused when the thread list version has not changed and the thread is not in progress.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. An existing completed thread

#### Steps
1. Open the completed thread and wait for messages to render
2. Switch to another thread or home
3. Return to the same completed thread without new turn or thread update events
4. Inspect network/RPC calls during the return

#### Expected Results
- The first open loads messages normally
- Returning to the unchanged completed thread reuses cached messages
- No additional `thread/read` or `thread/resume` call is made for that unchanged return
- If the thread version changes or the thread is in progress, messages still refresh from the server

#### Rollback/Cleanup
- None

---

### Thread selection keeps sidebar list stable during refresh

#### Feature/Change Name
Selecting a thread does not briefly hide older/sidebar threads while thread list refresh and background pagination run.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. More than one page of threads available in the sidebar
3. Background pagination has loaded older threads

#### Steps
1. Open the app and wait until older thread pages appear in the sidebar
2. Select a different thread
3. Watch the sidebar while the selected thread loads and any thread list refresh occurs
4. Repeat selection between recent and older threads

#### Expected Results
- The sidebar does not collapse to only the first page of recent threads
- Previously loaded older threads remain visible during refresh
- The selected thread stays highlighted and messages load normally
- Background pagination can still add newly loaded older threads without hiding existing ones

#### Rollback/Cleanup
- None

---

### Browser runtime profiling with Playwright

#### Feature/Change Name
Playwright browser runtime profiler captures route timing, Codex API network counts, screenshots, and trace files.

#### Prerequisites/Setup
1. Dev server running at `http://localhost:5173`
2. Dependencies installed (`pnpm install`)
3. Target route available, such as `#/thread/019da7c0-4e12-7a91-837c-f7c11cc8ab6c`

#### Steps
1. Run `pnpm run profile:browser`
2. Run `PROFILE_ROUTE='#/thread/019da7c0-4e12-7a91-837c-f7c11cc8ab6c' pnpm run profile:browser`
3. Inspect console output for duplicate counts and slowest API rows
4. Open the generated `output/playwright/browser-runtime-profile-*.json`
5. Open the generated `output/playwright/browser-runtime-profile-*-trace.zip` with `npx playwright show-trace`

#### Expected Results
- The profiler prints final URL, title, total observed time, duplicate request counts, and slowest Codex API calls
- JSON report includes raw API rows, grouped summaries, Performance API data, and artifact paths
- Screenshot is saved under `output/playwright/browser-runtime-profile-*.png`
- Trace is saved under `output/playwright/browser-runtime-profile-*-trace.zip`

#### Rollback/Cleanup
- Delete generated files under `output/playwright/` if local artifacts are no longer needed

---

### Codex.app-style Plugins Directory

#### Feature/Change Name
The `#/skills` route shows a full Skills & Apps directory with Plugins, Apps, Composio, and a Skills tab where an `MCPs(count)` section appears just before `Installed skills (count)`.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Codex CLI available in `PATH`
3. Optional: a Codex CLI version with `plugin/list`, `app/list`, and `mcpServerStatus/list` app-server APIs

#### Steps
1. Open `http://127.0.0.1:4173/#/skills`
2. Verify the page title is `Skills & Apps` and the tab row contains `Plugins`, `Apps`, `Composio`, and `Skills`
3. On `Plugins`, verify plugin cards load, the default sort is `Popular`, and `A-Z`, `Date`, and search controls work
4. Open a plugin card when one is available and verify description, capabilities, included apps/skills/MCPs, and install/uninstall or enable/disable actions are visible
5. For an installed plugin with bundled MCP servers, such as Cloudflare, verify each MCP row shows auth status (`Logged in`, `Bearer token`, `Login required`, `Auth unsupported`, or `Status unknown`)
6. If a bundled MCP server shows `Login required`, click `Authenticate` and verify the browser opens the returned MCP OAuth authorization URL
7. Switch to `Apps` and verify app cards load, or the unavailable/empty state appears without breaking the page
8. On `Apps`, verify the default sort control is `Popular`, app icons render, connected apps show `Manage`, and disconnected apps show `Login`
9. Click a disconnected app `Login` button and verify it opens the app login/manage URL
10. Click `Try it!` for a connected and enabled app and verify a new thread opens with an auto-submitted prompt asking what the app can do
11. While the app `Try it!` request is starting, click the button repeatedly and verify only one new thread is created
12. Open an installed/enabled plugin detail, click `Try it!`, and verify a new thread opens with an auto-submitted plugin test prompt
13. Open an installed/enabled skill detail, click `Try it!`, and verify a new thread opens with an auto-submitted skill test prompt and the skill attached
14. Install a plugin whose install response includes `appsNeedingAuth`, and verify the first required app login/manage URL opens automatically
15. Open a plugin whose detail lists a required app that is absent from the Apps catalog for the current account, such as Gmail on an account without Gmail app access, and verify the footer shows a disabled `ChatGPT Plus` action instead of `Install`
16. Switch Apps sorting to `A-Z` and verify apps reorder alphabetically; switch to `Date` and verify app-server catalog order is restored; switch back to `Popular` and verify casual-user relevant apps are prioritized and capped to 100 when no search is active
17. Search Apps and verify matching results are not capped to the Popular top 100 list
18. Switch to `Composio` and verify the workspace summary card shows the current installed Composio CLI login state, or a clear not-installed / not-authenticated message appears
19. If Composio CLI is not installed, click `Install Composio` and verify the app installs the CLI to `~/.composio/composio` using the official Composio installer
20. If Composio is available but not authenticated, click `Login` and verify the app opens a new tab, starts the installed `composio login --no-browser -y`, captures the returned auth URL, and navigates the new tab to that URL
21. Verify Composio connector cards show real connector details such as tool counts, trigger counts, auth mode, and connection state instead of only aggregate totals
22. In Composio search, type `instagram` and verify the Instagram connector appears first when it is returned by the connector source, ahead of description-only matches such as Meta Ads
23. Open a disconnected Composio connector and click `Connect` or `Reconnect`; verify the returned `connect.composio.dev` authorization URL opens
24. Open a connected Composio connector and verify connection rows show account identifiers and statuses such as `Active` or `Expired`
25. Click `Try it!` on a connected or no-auth Composio connector and verify a new thread opens with a Composio-specific prompt and the `composio-cli` skill attached
26. On Composio, verify that if more than one page exists, `Load more` appears and appends additional connectors while keeping prior results visible
27. In Composio search, verify the page state resets (the list returns to the first result page and stale pagination is cleared)
28. Switch to `Skills` and verify the view shows an `MCPs(count)` collapsible section immediately before the `Installed skills (count)` section
29. Expand `MCPs(count)` and verify server cards show auth status and tool/resource counts, or the unavailable/empty state appears without breaking the page
30. Click header `Refresh` while on `Skills` and verify MCP state reloads (it should perform MCP reload behavior on this tab instead of using a separate `Reload MCPs` button)
31. Verify no separate `Reload MCPs` button is shown in the header or inside the MCP section body
32. Verify the `MCPs(count)` section does not show its own search or sort controls
33. Verify MCP cards use the same visual card/grid layout pattern as Installed skills cards (avatar circle, title row, badge, secondary text)
34. Verify the `Installed skills (count)` section below MCPs still supports the existing Skills Hub behavior
35. Verify both light and dark themes render Composio cards and status/detail actions with readable contrast
36. In dark mode, verify MCP cards use the same dark card surface styling as Installed skills cards (not a light/white card)

#### Expected Results
- The directory tabs render without a full-page error
- Plugin/app/Composio API failures are isolated to their tab
- Existing Skills Hub behavior remains available under the `Skills` tab, with MCPs presented just before Installed skills
- App and plugin enable/disable actions update their local card state after a successful config write
- Plugin detail shows bundled MCP login state and can launch MCP OAuth for `notLoggedIn` servers
- Disconnected apps are labeled `Login`; connected apps are labeled `Manage`
- The Composio tab uses the installed Composio CLI, preferring `CODEXUI_COMPOSIO_COMMAND` when set and otherwise `~/.composio/composio` or `composio` on `PATH`
- The Composio install action uses the official installer and produces a working `~/.composio/composio` binary
- The Composio login action opens a new tab from the click, starts the installed `composio login --no-browser -y`, then navigates that tab to the returned auth URL
- Composio connector cards and detail views show concrete connector details, connection rows, and useful tool samples
- Composio search prioritizes exact slug/name matches above connectors that only mention the query in their description
- Unit coverage verifies that Composio exact query matches outrank description-only matches and that gateway connector search sends `query`, `cursor`, and `limit` params expected by the server
- Connected or no-auth Composio connectors expose `Try it!`, creating a new chat with the `composio-cli` skill attached
- Composio pagination supports page-by-page loading with a clear `Load more` path and cursor-based page continuation
- Plugin install opens the first required app login/manage page before falling back to bundled MCP OAuth login
- Plugin install is blocked with `ChatGPT Plus` when the plugin requires an app that is absent from the Apps catalog for the current account
- Connected and enabled apps, plus installed/enabled plugins/skills, expose `Try it!`, creating a new chat with an auto-submitted test prompt
- Repeated `Try it!` clicks during startup are ignored until the first request resolves, so duplicate threads are not created
- Plugins, Apps, and the Skills-tab MCP section default to local popularity-style ordering because app-server does not expose numeric popularity fields
- The Skills tab presents MCPs in the same section style as Installed skills, just above Installed skills, instead of using a separate top-level MCP tab
- `Date` uses the app-server/catalog order as the available freshness proxy because app/plugin/MCP APIs do not expose created or published timestamps
- Popular views show only the top 100 when no search is active; search results can show all matches

#### Rollback/Cleanup
- Re-enable any app or plugin disabled during testing
- Uninstall any plugin installed only for this test

---

### Skills tab npx skills search

#### Feature/Change Name
The Skills tab includes a registry search panel backed by `npx skills find`, shows matching skill cards, and installs selected registry results with `npx skills add`.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Network access available for `npx skills find`
3. `npx` can run the published `skills` package
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. Open `http://127.0.0.1:4173/#/skills`
2. Verify the `Skills` tab is selected by default; open `http://127.0.0.1:4173/#/skills?tab=plugins`, then click `Skills` and verify the URL updates to `?tab=skills`
3. Verify the `Find skills` header shows a `Skills directory` link on the right that opens `https://skills.anyclaw.store/` in a new tab
4. In `Find skills`, type a query such as `browser`
5. Click `Search`
6. Verify the app calls `/codex-api/skills-hub/search?q=browser`, which runs `npx --yes skills find browser`
7. Verify `Search results (count)` appears above `Installed skills (count)`
8. Verify each registry result card shows its install count metadata, such as `1.2K installs`, even when a GitHub `SKILL.md` description is shown
9. Open one GitHub-backed result and verify the detail modal shows the skill name, owner/repository, parsed `SKILL.md` description, GitHub-backed icon/avatar, and external link
10. Click `Install` for a result and verify the backend runs `npx --yes skills add <owner/repo@skill> --yes --global`
11. After install, verify the result becomes installed and the installed skills list refreshes from local installed skill data rather than appending the remote registry card
12. Switch to dark theme and repeat the search visibility check
13. Search for an already-installed skill and verify its search result shows `Installed`
14. Verify installed matches in search results keep their remote registry owner/details while showing the `Installed` badge
15. Open the installed search result and verify the modal reads the local installed `SKILL.md`, exposes `Uninstall`, and does not show the registry install flow
16. Open a local-only installed skill and verify the modal does not show a dead `View on GitHub` link when no external URL is available
17. Verify cards in the `Installed skills (count)` section do not show `Installed`, `Disabled`, or repeated `local` owner labels, while search result cards can still show installed state and registry owner details
18. Verify installed cards show local `SKILL.md` descriptions when the installed skill has frontmatter or readable markdown content
19. Verify Find skills result cards do not show the local folder browse icon; Browse files remains available inside the installed local modal

#### Expected Results
- Search results are parsed from the real `npx skills find` output, not a static catalog
- Skills search/install commands use the repo command invocation wrapper so `npx` starts reliably on Windows
- Skills search/install commands include outer `npx --yes` so first-run package prompts cannot hang with ignored stdin
- The Skills directory link is visible beside Find skills in light and dark theme and opens the public directory in a new tab
- Registry installs run noninteractively with `--yes --global`, so the process cannot stop at the agent-selection prompt and falsely report success
- Registry install responses only return `ok: true` when the local installed `SKILL.md` path is found and validates successfully
- The UI treats a missing returned path or missing post-refresh local skill as an install failure instead of showing the remote registry card as installed
- GitHub-backed results fetch the repository `SKILL.md` and show its `description` frontmatter when available, falling back to the install count when unavailable
- GitHub metadata enrichment is bounded to the first 20 results with limited concurrency, so broad searches still return without unbounded raw GitHub fetch fanout
- Search result cards keep the registry install count visible as card metadata even when GitHub enrichment replaces the fallback description
- GitHub-backed results show an explicit frontmatter `icon` when provided, otherwise they show the GitHub repository owner avatar instead of a generic letter fallback
- The search UI does not replace or hide local installed skills
- Installed matching results show the existing `Installed` badge and can be opened like local skills
- Installed detection uses the same installed skills source as the Skills Hub list, including RPC/plugin/shared skills and not only the base skills directory
- Installed search result cards keep remote registry ownership/content but include local installed state and path for actions
- Newly installed registry results are reloaded from the local installed skills source before appearing in the Installed skills section
- Opening an installed search result uses the local installed skill record/path, so local content, uninstall, enable/disable, browse, and try actions behave the same as the Installed skills section
- Local-only installed skills hide the external GitHub link when no URL is available
- Installed skills section cards hide redundant installed/disabled status labels
- Installed skills section cards hide the repeated local owner label; registry search cards keep owner/repository labels to distinguish remote results
- Installed skill descriptions come from the local installed `SKILL.md`, so installed cards are useful without opening each modal
- Installed entries are assembled concurrently so reading local `SKILL.md` descriptions does not add one file-read round trip per installed skill
- Opening or switching to the Skills tab lists MCP servers without forcing an MCP reload; the top-level Refresh button remains the explicit reload action
- The top-level Refresh button only shows `Refreshing...` for explicit user-triggered refreshes, not for ordinary initial tab loading
- Find skills cards hide local folder browse actions to avoid mixing remote registry cards with local-only card controls
- Light theme and dark theme keep the search panel, cards, and modal readable

#### Rollback/Cleanup
- Uninstall any skill installed only for this test

---

### Sidebar thread row edge click selects thread

#### Feature/Change Name
Thread rows now select when clicking anywhere on the highlighted row area (including left/right edge/time area), while pin/menu buttons keep their own actions.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Sidebar contains multiple threads
3. At least one thread has visible time text on the right

#### Steps
1. Hover a thread row and confirm the row highlight appears
2. Click near the left edge (outside the title text and not on pin icon)
3. Click near the right edge/time area (outside the menu button)
4. Click the thread title/body area
5. Click the pin button and menu button to verify their behavior

#### Expected Results
- Steps 2, 3, and 4 all select/open the clicked thread
- Hover highlight and click target area now match user expectations
- Pin button toggles pin state without selecting due to event bubbling
- Menu button opens thread menu without selecting due to event bubbling

#### Rollback/Cleanup
- None

---

### Content header actions remain right aligned

#### Feature/Change Name
Thread and new-chat header action buttons stay pinned to the right edge while long titles remain constrained and truncated.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Sidebar collapsed or viewport wide enough to show content header actions
3. Terminal toggle available in the header

#### Steps
1. Open `http://127.0.0.1:4173/#/`
2. Inspect the header row containing `Start new thread`
3. Verify the terminal toggle is aligned to the far right of the content header, not immediately after the title
4. Open a thread with a long title and repeat the alignment check
5. Confirm the title truncates with a tooltip and does not overlap the terminal or branch controls

#### Expected Results
- Header actions use the available right edge of the content header
- Long title truncation does not pull action buttons toward the center
- Terminal and branch controls remain visible and clickable

#### Rollback/Cleanup
- Remove generated screenshots under `output/playwright/` if they are not needed

---

### Stop button activates promptly for new threads

#### Feature/Change Name
The composer stop control switches from the temporary saving spinner to a real stop button as soon as the active turn id is available for a newly created thread.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Home route available with a writable project/folder selected
3. Codex can start a normal assistant turn

#### Steps
1. Open `http://127.0.0.1:4173/#/`
2. Send a short prompt from the new-thread composer
3. Immediately watch the right-side composer control after routing into the new thread
4. Before the full response finishes, verify the temporary saving spinner transitions into the stop icon/button
5. Click `Stop` while the turn is still running

#### Expected Results
- A new thread may briefly show the saving spinner while the turn starts
- The control becomes an actual stop button as soon as the active turn id is known, without waiting for thread-list persistence
- Clicking stop interrupts the running turn

#### Rollback/Cleanup
- Archive or delete the test thread if it was created only for this check

---

### New-thread plan mode persists and toggles correctly

#### Feature/Change Name
New threads started from the home composer honor the selected plan mode for the first turn, and turning plan mode off on the created thread switches later turns back to default mode.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Home route available with a writable project/folder selected
3. At least one model is available for plan mode

#### Steps
1. Open `http://127.0.0.1:4173/#/`
2. Enable `Plan mode` in the new-thread composer
3. Send a prompt that produces a visible plan response
4. After routing into the new thread, confirm the composer still shows `Plan mode` enabled
5. Toggle `Plan mode` off in that thread
6. Send another prompt in the same thread
7. Confirm the next turn runs in default mode rather than generating another plan-first response

#### Expected Results
- The very first turn of a newly created thread uses the plan-mode setting chosen on the home composer
- The newly created thread retains that plan-mode selection after route transition
- Turning plan mode off updates the thread-scoped mode, and later turns in that thread no longer use plan mode

#### Rollback/Cleanup
- Archive or delete any test thread created only for this check

---

### Completed plan cards expose implement action

#### Feature/Change Name
Completed plan cards show an `Implement plan` button that turns plan mode off and sends an implementation prompt built from the plan content.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. An existing thread contains a completed persisted plan card
3. The thread composer is available for follow-up messages

#### Steps
1. Open a thread containing a completed plan card
2. Verify the plan card shows `Implement plan` at the bottom
3. Click `Implement plan`
4. Confirm the composer thread switches back to default mode
5. Inspect the next `turn/start` request or the resulting assistant behavior

#### Expected Results
- Completed plan cards render the `Implement plan` action even when the plan body is structured as headings/lists instead of checkbox steps
- Clicking the button sends a simple implementation follow-up message instead of copying the whole plan body into chat
- The next turn runs in default mode rather than plan mode

#### Rollback/Cleanup
- Archive or delete any test thread created only for this check

---

### Dark theme plan card contrast

#### Feature/Change Name
Plan cards in dark mode keep readable contrast and a lighter surface than the surrounding page background, including the `Implement plan` action.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. A thread contains a visible plan card
3. Appearance is set to `Dark`

#### Steps
1. Open a thread containing a plan card in dark mode
2. Inspect the card background, title, explanation text, headings, lists, inline code, and blockquote styling
3. Verify the `Implement plan` button is readable and visually distinct
4. Hover the `Implement plan` button and confirm the hover state remains visible

#### Expected Results
- The plan card surface is distinguishable from the page background without looking crushed into near-black
- Plan text and headings stay readable in dark mode
- Inline code, file links, and blockquotes keep enough contrast to scan comfortably
- The `Implement plan` button remains readable and clickable in dark mode

#### Rollback/Cleanup
- Reset appearance to the previous user preference

---

### Terminal focus does not fullscreen panel

#### Feature/Change Name
Terminal focus on mobile keeps the terminal as a bottom panel instead of expanding it to full screen.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. A thread or new-chat project with the terminal toggle available
3. Mobile viewport or Android device browser

#### Steps
1. Open a thread or new chat with a valid project path
2. Tap the terminal toggle
3. Tap inside the terminal area
4. If the virtual keyboard appears, keep focus in the terminal
5. Hide and reopen the terminal

#### Expected Results
- Terminal remains a bottom panel and does not take over the full viewport
- Conversation/new-chat content is not forcibly hidden by terminal focus
- Composer keeps its normal compact placement instead of stretching above the terminal
- Terminal can still fit within the available viewport when the keyboard changes size

#### Rollback/Cleanup
- Close the terminal panel

---

### Feature: Nested skill bundles are grouped in discovery

#### Feature/Change Name
Composer skill discovery collapses nested `skills/<subskill>/SKILL.md` entries under their top-level bundle skill when the bundle root skill is also present, including curated plugin skill packs such as `cloudflare:*`.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a thread whose cwd can access installed skills
3. At least one installed skill bundle or curated plugin pack contains a top-level/root `SKILL.md` plus additional subskills

#### Steps
1. Open the thread composer skill picker
2. Search for a grouped bundle or plugin root such as `cloudflare`
3. Confirm the grouped root appears once in the picker
4. Search for one nested subskill or prefixed plugin skill name such as `agents-sdk` or `cloudflare:workers-best-practices`
5. Refresh the page or switch threads and reopen the skill picker

#### Expected Results
- The picker shows a single top-level entry for the bundled skill or plugin root
- Nested subskill folder names and plugin-prefixed variants do not appear as separate skill discovery entries when the parent/root entry exists
- Grouped plugin roots render a clean label such as `cloudflare` instead of `cloudflare:cloudflare`
- The grouped result remains stable after refresh or thread switching

#### Rollback/Cleanup
- None

---

### Default mode can follow plan mode in the same thread

#### Feature/Change Name
Composer collaboration mode changes send `default` explicitly so a thread can leave plan mode without opening a new chat.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. A Codex account/session with both Default and Plan collaboration modes available
3. A project folder selected for a new or existing thread

#### Steps
1. Select Plan mode in the composer
2. Send a prompt asking Codex to create a plan
3. After the turn completes, switch the composer back to Default mode
4. Send a follow-up prompt asking Codex to implement the plan in the same thread
5. Repeat the Default follow-up once more in the same thread

#### Expected Results
- The implementation prompts run in Default mode instead of staying in Plan mode
- The thread remains usable without opening a new chat
- The composer selection and the backend turn mode stay aligned across consecutive turns

#### Rollback/Cleanup
- Archive the test thread if it was created only for verification

---

### First-launch home card for Plugins and Apps

#### Feature/Change Name
The home route shows a dismissible first-launch card that introduces Plugins and Apps and opens the existing Skills & Apps directory on the Plugins tab.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Codex global-state preference `first-launch-plugins-card-dismissed` removed or set to `false` before the first check
3. App loaded on the home/new-thread route

#### Steps
1. Open the app on the home route with the local storage key removed
2. Verify the home screen shows a card with the heading `Plugins are here`
3. Verify the body copy mentions app examples such as Gmail and Calendar
4. Click `Explore Plugins & Apps`
5. Verify the app navigates to the `#/skills` route and the `Plugins` tab is active
6. Return to the home route and verify the card does not reappear
7. Remove the local storage key again, reload the home route, and click `Dismiss`
8. Reload the home route once more

#### Expected Results
- The card appears only when the server-backed dismissal preference is unset or `false`
- The primary CTA hides the card and opens the Skills & Apps directory
- The directory opens with `Plugins` selected by default
- Dismissing the card hides it immediately and keeps it hidden after reload

#### Rollback/Cleanup
- Remove or set `first-launch-plugins-card-dismissed` to `false` in Codex global state if you want to see the card again

---

### Composer prompts inside Skills dropdown

#### Feature/Change Name
The composer control row uses one `Skills` dropdown for both skills and saved prompts. The `+` action creates a prompt, prompt rows can be inserted or removed from the same menu, and there is no separate `Prompt` control.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Open any existing thread so the composer controls are enabled
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open the composer controls and confirm `Skills` appears and no separate `Prompt` control is present
2. Open `Skills` and verify the popup matches the wider card-like layout with large stacked label/description rows
3. Confirm skill rows have compact source markers, such as `R` for repo, `U` for user, `S` for system, or `P` for plugin
4. Click the `+` action in the `Skills` dropdown, enter a unique prompt name such as `ui-test-prompt`, and enter sample content such as `Prompt dropdown smoke test`
5. Reopen `Skills` and confirm the new prompt appears with a `Prompt` marker and an inline `×` remove action
6. Click the prompt row and confirm the prompt text is inserted into the composer draft without toggling a skill
7. Reopen `Skills`, click the `×` button for `ui-test-prompt`, and confirm the removal dialog
8. Confirm the prompt disappears from the dropdown while skill rows remain available
9. Type `/` into the composer and verify no slash skill picker appears
10. Switch to dark theme and repeat the visibility check for the combined `Skills` dropdown contents

#### Expected Results
- The composer shows one `Skills` dropdown for skills and prompts; no standalone `Prompt` dropdown is rendered
- The combined `Skills` popup uses the wider rounded layout with vertically stacked label/description rows
- Skill rows show readable source markers that distinguish repo, user, system, and plugin-provided skills
- Prompt rows show a readable `Prompt` marker and are the only rows with an inline remove action
- Typing `/` in the composer does not open a skill picker
- The `+` action creates a markdown file in the Codex prompt store and adds it to the `Skills` dropdown immediately
- Selecting a saved prompt appends its content into the draft without sending the message
- Clicking `×` removes only the targeted prompt and updates the dropdown immediately
- Light theme and dark theme both keep the new control, menu, and remove action readable and usable

#### Rollback/Cleanup
- Delete any temporary verification prompt created during the test

---

### Editable current folder path in the folder picker

#### Feature/Change Name
The `Select folder` dialog now lets the user edit the current folder path directly, reload that folder on `Enter` or blur, and open the typed path without first clicking a child row.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open the home/new-thread route
3. Have at least two accessible local directories available for navigation
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open the `Select folder` dialog from the new-thread folder chooser
2. Confirm the `Current folder` field is an editable text input instead of static text
3. Type a different absolute path and press `Enter`
4. Confirm the folder list reloads for the typed path
5. Edit the path again, click outside the input, and confirm blur also reloads the listing
6. Type a valid absolute path and click `Open`
7. Reopen the dialog, switch to dark theme, and confirm the editable current-folder input remains readable and focusable

#### Expected Results
- The current-folder path can be typed into directly
- Pressing `Enter` on a changed path reloads the folder listing for that path
- Blurring a changed path also reloads the folder listing for that path
- Clicking `Open` uses the typed path when it is valid
- The input remains readable and has visible focus treatment in both light theme and dark theme

#### Rollback/Cleanup
- Return the chooser to the original folder if the test changed the selected project path

---

### Expandable Projects, Pinned, and Chats sidebar sections

#### Feature/Change Name
The sidebar labels the grouped thread area as `Projects`, makes `Projects`, `Pinned`, and `Chats` independently expandable, and places `Chats` after `Projects` in the same scrollable sidebar area.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:5174` or the active Vite dev URL
2. At least one existing thread is available in the sidebar
3. At least one pinned thread exists to verify the `Pinned` section
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open the app with the sidebar expanded
2. Verify the grouped thread header reads `Projects` instead of `Threads`
3. Verify `Pinned`, `Projects`, and `Chats` each show a chevron when present
4. Collapse and expand `Pinned`, confirming pinned rows hide and return
5. Collapse and expand `Projects`, confirming project groups hide and return
6. Confirm `Chats` appears after `Projects` and scrolls with the same sidebar content, not as a fixed bottom shelf
7. Collapse and expand `Chats`, confirming recent chat rows hide and return
8. Click the `Chats` filter icon and verify the existing sidebar search field opens and the filter button shows active state
9. Click the `Chats` compose icon and verify the app navigates to the new-chat/home composer
10. Open the Projects organize menu, enable `Chats first`, and verify `Chats` moves above `Projects`
11. In the same menu, switch `Sort by` between `Created` and `Updated`, then verify the active checkmark moves and the chat rows reorder by the selected timestamp
12. Refresh the page and verify `Chats first` and the selected sort mode persist
13. Switch to dark theme and repeat the visibility checks for section headers, chevrons, active filter state, sort menu state, and row text

#### Expected Results
- The sidebar uses `Projects` for the grouped project/thread area
- `Pinned`, `Projects`, and `Chats` expansion state changes immediately and persists across reload
- `Chats` is appended after `Projects` in the same scroll space
- `Chats first` moves the `Chats` section before `Projects` and persists across reload
- `Created` and `Updated` sort options update only the `Chats` ordering and persist across reload
- The filter icon toggles the sidebar search without losing the `Chats` section
- The compose icon starts a new chat using the existing new-thread flow
- Light theme and dark theme both keep section headers, controls, and rows readable

#### Rollback/Cleanup
- Clear the sidebar search query if the filter step left it open

---

### Thread menu copy path action

#### Feature/Change Name
The thread overflow menu includes a `Copy path` item that copies the selected thread's working directory path.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:5174` or the active Vite dev URL
2. Open any existing thread with a known project path
3. Browser clipboard access is available
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, hover a thread row in the sidebar and open its overflow menu
2. Verify `Copy path` appears after `Browse files`
3. Click `Copy path`
4. Paste the clipboard contents into a text field or clipboard inspector
5. Reopen the same menu in dark theme and verify the item remains readable and in the same position

#### Expected Results
- The menu order is `Add automation...`, `Browse files`, `Copy path`, `Export chat`, `Create chat fork`, `Rename thread`, `Delete thread`
- Clicking `Copy path` closes the menu
- Clipboard contents equal the thread's `cwd` path
- Light theme and dark theme both keep the menu item readable

#### Rollback/Cleanup
- Restore any previous clipboard contents manually if needed

---

### Terminal quick commands from project files

#### Feature/Change Name
Terminal quick commands are discovered from the current project instead of using a static built-in npm list.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:5174` or the active Vite dev URL
2. Open a thread or new chat whose working directory has a `package.json` with scripts
3. Optionally create executable candidates under the project root and `scripts/`, such as `check.sh`, `scripts/check.sh`, or `scripts/build.cmd`
4. Optionally add `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, or `bun.lockb` to verify package-manager detection
5. Optionally add a `Makefile` with simple targets such as `test:` or `build:`

#### Steps
1. Open the terminal panel for that project
2. Open the `Run...` dropdown
3. Verify each `package.json` script appears with the detected package manager, such as `pnpm run <script>`, `yarn <script>`, `bun run <script>`, or `npm run <script>`
4. Verify simple `Makefile` targets appear as `make <target>`
5. Verify root-level `*.sh` / `*.cmd` files appear as `./<file>`
6. Verify `scripts/*.sh` and `scripts/*.cmd` files appear as `./scripts/<file>`
7. Select one discovered command and confirm it is sent to the terminal
8. Reopen the dropdown after running commands multiple times
9. If the project has more commands than fit in the menu, scroll the dropdown and verify lower-priority entries such as `./scripts/<file>.sh` remain reachable
10. From a closed terminal state on a remote server, select a command immediately after opening the `Run...` menu and confirm it runs after the terminal attaches

#### Expected Results
- The dropdown is based on the current project `cwd`
- Static defaults like `npm run dev` do not appear unless they exist in that project's `package.json`
- Package script commands use the lockfile-preferred package manager
- Make targets are listed after package scripts
- Root and `scripts/` script-file commands are listed after Make targets
- Commands are sorted by most-used and then most-recent usage, and the dropdown scrolls instead of hiding entries beyond the first five
- Selecting a command while the terminal is still mounting waits for the attach flow instead of dropping the command

#### Rollback/Cleanup
- Remove any temporary files created under the project root or `scripts/`

---

### Queue mode is default for in-progress messages

#### Feature/Change Name
When a turn is already running, the in-progress message path defaults to `Queue` for new sessions and existing users without a saved preference.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open any existing thread with message composer enabled
3. Start from a clean setting state by clearing localStorage key `codex-web-local.in-progress-send-mode` if present
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. Open a thread and ensure no previous turn is running
2. Confirm settings shows `When busy` line labeled as `Queue`
3. Send a message that triggers an in-progress response
4. While the response is running, submit a second message and observe submit mode label / destination behavior
5. Open the queue list and confirm the second message is queued
6. Switch to dark theme and repeat step 4 using another thread

#### Expected Results
- The in-progress setting defaults to `Queue` when no saved preference exists
- A second message sent during an active turn is queued, not used as steer
- Queue order and queued item actions remain functional in both light theme and dark theme

#### Rollback/Cleanup
- Clear the queue by sending/steering queued items or deleting queued rows

---

### Backend-persisted queued messages and drag reorder

#### Feature/Change Name
Queued messages are saved through the backend, survive page refresh, and can be reordered by dragging a queued row before another queued row.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a thread where a turn is actively running
3. Queue at least three messages while the turn is running
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, confirm each queued row has a drag handle at the start of the row
2. Refresh the page and reopen the same thread
3. Confirm all queued rows are still visible in the same order
4. Drag the third queued message onto the first queued message
5. Confirm the third message moves to the first position and the remaining queued messages keep their relative order
6. Refresh again and confirm the reordered queue order is preserved
7. Let the active turn finish and confirm the next sent queued message is the first reordered item
8. Queue at least two more messages, switch to dark theme, and repeat the drag reorder check

#### Expected Results
- Queued rows survive a page refresh because they are restored from backend state
- Dragging a queued row onto another queued row immediately reorders the queue
- The reordered queue order survives page refresh
- The reordered queue order controls which message sends next after the active turn finishes
- Edit, Steer, and Delete actions still operate on the correct queued row after reordering
- Drag handle, hover/drop target, and row text remain readable in both light theme and dark theme

#### Rollback/Cleanup
- Delete any queued test messages that should not be sent

---

### Backend-drained queue UI refresh

#### Feature/Change Name
The queue panel refreshes when the backend starts and drains persisted queued messages.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a `TestChat` thread
3. Queue at least three short messages while a turn is running
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, confirm queued rows are visible above the composer
2. Let the backend drain each queued message
3. Confirm the queue panel removes each row as its queued turn starts
4. Confirm the queue panel disappears when the final queued message is submitted
5. Refresh the thread after all queued turns complete
6. Switch to dark theme and repeat the visibility check after queue drain

#### Expected Results
- Queued messages execute in order after the active turn completes
- The queue panel reflects backend queue state after `turn/started` and `turn/completed`
- No already-executed queued rows remain visible after the queue is empty
- Queue row text, actions, and composer spacing remain readable in both light theme and dark theme

#### Rollback/Cleanup
- Delete any remaining queued test messages or let the queue drain

---

### Persisted idle queue recovery

#### Feature/Change Name
Backend queued messages are retried and drained for idle threads even if the original `turn/completed` notification was missed or the server starts with persisted queue state already present.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A thread exists with queued messages persisted in `/codex-api/thread-queue-state`
3. The thread's latest turn is completed/idle
4. Light theme and dark theme are both available

#### Steps
1. In light theme, open the thread with persisted queued rows
2. Confirm the queued rows are visible above the composer
3. Wait for backend queue recovery to start the first queued message
4. Confirm the first queued row is removed and a new turn starts
5. Wait for the queued turn to complete
6. Confirm the next queued row starts automatically
7. Repeat until `/codex-api/thread-queue-state` no longer includes the thread
8. Refresh the thread and confirm all queued messages completed in order
9. Switch to dark theme and confirm the completed conversation and empty queue state remain readable

#### Expected Results
- Idle persisted queues recover without requiring a new manual message
- Queued messages do not start while the thread has an in-progress turn
- Multiple queued messages drain one at a time and complete in order
- The queue panel disappears after the final queued message is started
- The recovered turns and empty queue state are visible in both light theme and dark theme

#### Rollback/Cleanup
- Delete any remaining queued test rows or let recovery drain them
- Remove temporary test projects/threads if they are no longer needed

---

### ChatGPT auth tokens refresh for external auth

#### Feature/Change Name
Codex app-server `account/chatgptAuthTokens/refresh` requests are handled automatically from `auth.json` so expired ChatGPT access tokens can be refreshed without a manual relogin.

#### Prerequisites/Setup
1. App server is running from this repository
2. `$CODEX_HOME/auth.json` contains ChatGPT auth with a valid `refresh_token`
3. The current ChatGPT `access_token` is expired or close enough to expiry that Codex app-server asks for token refresh

#### Steps
1. Open the app with the ChatGPT-authenticated account selected
2. Trigger an account operation such as loading account rate limits or starting a normal Codex turn
3. Watch the server logs for an `account/chatgptAuthTokens/refresh` server request
4. Reopen `$CODEX_HOME/auth.json`
5. Repeat the same account operation after the refresh completes

#### Expected Results
- The refresh request is answered automatically and does not appear as a manual pending request in the UI
- `auth.json` is updated with the fresh `access_token` and any rotated `refresh_token` or `id_token`
- The account operation succeeds without showing `token_expired`
- If no refresh token is available, the operation fails with a sign-in-again message instead of silently looping

#### Rollback/Cleanup
- None, unless a test-only `$CODEX_HOME` was used

---

### Project menu permanent worktree action

#### Feature/Change Name
Project rows open the same action menu from right-click and the dots button, and can create a permanent sibling Git worktree as a new project.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Sidebar has at least one Git-backed project
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, click the project row dots button.
2. Verify the menu shows `Browse files`, `New worktree`, `Rename project`, and `Remove`.
3. Close the menu, then right-click the same project row.
4. Verify the same menu opens.
5. Click `Browse files` and confirm the local file browser opens for the project cwd.
6. Reopen the project menu, click `Rename project`, and confirm the inline project name input still works.
7. Reopen the project menu, click `New worktree`, and confirm the prompt is prefilled with `<project name>-`.
8. Enter a unique folder name such as `<project name>-manual-test`.
9. Confirm a Git worktree is created at `../<worktree name>` relative to the source repo root.
10. Run `git -C ../<worktree name> branch --show-current` and confirm it prints a branch based on the worktree folder name.
11. Confirm the new worktree is added as a project and the app opens the new-chat composer with that cwd selected.
12. Rename the project to include a slash, reopen `New worktree`, and confirm the suggested folder name replaces the slash with `-`.
13. Switch to dark theme and repeat steps 1-4, verifying menu contrast and danger styling remain readable.

#### Expected Results
- Right-click and dots button expose the same project action menu.
- `Browse files`, `Rename project`, and `Remove` remain available from that menu.
- `New worktree` creates a permanent sibling worktree folder on its own branch, registers it as a project, and opens a new chat for it.
- Invalid path separator characters are not used in the default worktree folder suggestion.
- Menu text, hover states, and the remove action remain readable in light and dark themes.

#### Rollback/Cleanup
- Remove the test worktree with `git -C <source-repo-root> worktree remove ../<worktree name>`.
- Delete the test branch with `git -C <source-repo-root> branch -D <branch name>`.
- Remove the temporary project from the sidebar if it remains listed.

---

### Sidebar thread inline delete confirmation and menu pin action

#### Feature/Change Name
Thread rows show an inline delete button that morphs to `Confirm`, while pin/unpin moves to the thread context menu.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Sidebar contains at least two disposable test threads
3. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, hover a disposable thread row and verify the left-side action shows a delete icon instead of a pin icon
2. Click the delete icon once and verify it changes to a `Confirm` button without selecting the row
3. Click a different thread row and verify the pending `Confirm` state clears
4. Hover the disposable thread row again, click delete, then click `Confirm`
5. Verify the thread is removed from the sidebar immediately and, if it was pinned, removed from the `Pinned` section too
6. Open another thread row context menu and verify it contains `Pin thread` for an unpinned thread
7. Click `Pin thread`, reopen the same thread menu, and verify it now shows `Unpin thread`
8. Switch to dark theme and repeat steps 1 through 7 with another disposable thread

#### Expected Results
- The inline row action is delete, not pin
- Delete requires two clicks: delete icon, then `Confirm`
- Confirming archives/removes the correct thread immediately from the sidebar and clears any pinned state for that thread
- Pin/unpin is available from the thread context menu and updates the `Pinned` section immediately
- Delete icon, `Confirm` button, and context menu items are readable in both light theme and dark theme

#### Rollback/Cleanup
- Delete or unpin any disposable threads created only for this test

---

### Accounts panel Codex login callback modal

#### Feature/Change Name
Accounts settings includes an always-available `Login` button that starts `codex login`, opens the returned authorization URL, shows an in-app callback modal, requests the pasted localhost callback URL from the server, and imports the completed Codex account.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. `codex` CLI available in the server process `PATH`
3. Browser can open the authorization URL returned by the server
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. Open settings and expand `Accounts`.
2. In light theme, verify `Login` appears even when an active account is already listed.
3. Click `Login`.
4. Verify a new tab opens to the OpenAI authorization URL and an in-app `Complete Codex login` modal asks for the localhost callback URL.
5. Complete authorization in the browser until it redirects to a `http://localhost:<port>/auth/callback?...` URL.
6. Paste that full localhost callback URL into the modal input and click `Complete`.
7. Verify the account list refreshes, the new or refreshed account is active, and normal thread/account data reloads.
8. Click `Login` again, close the modal, and verify the Accounts panel keeps the `Open login URL` fallback link available.
9. Switch to dark theme and repeat steps 1-4, verifying the Login button, link, modal, input, and buttons have readable contrast.

#### Expected Results
- `Login` is available regardless of current login state.
- Starting login runs `codex login` on the server and exposes the generated OpenAI authorization URL.
- Completing login uses the modal input value, only accepts local callback URLs, and uses the server to request the pasted callback.
- After completion, `$CODEX_HOME/auth.json` is imported into the Accounts list and selected as the active account.
- Completion does not remain stuck waiting for the `codex login` process after the callback has updated `auth.json`.
- Light-theme and dark-theme controls are readable and do not overlap.

#### Rollback/Cleanup
- Remove any test-only account from the Accounts panel if needed.
- If a login is abandoned, restart the dev server to clear any in-memory pending login process.

---

### Active thread switches after delete

#### Feature/Change Name
Deleting the currently open thread immediately selects the next available thread.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Sidebar contains at least three disposable test threads
3. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open the middle disposable thread
2. Click that thread's delete icon, then click `Confirm`
3. Verify the content area immediately switches to the next thread in the sidebar list
4. Open the last disposable thread
5. Delete and confirm it
6. Verify the content area immediately switches to the previous thread
7. Repeat steps 1 through 6 in dark theme

#### Expected Results
- Deleting the active thread does not leave the deleted thread selected
- The next thread is selected immediately; when there is no next thread, the previous thread is selected
- The browser route updates to the newly selected thread without waiting for a manual click
- A stale deleted-thread URL does not switch the UI back to the archived thread
- Light-theme and dark-theme sidebar selection states remain readable after the automatic switch

#### Rollback/Cleanup
- Delete any disposable threads created only for this test

---

### Thread open always autoscrolls to latest

#### Feature/Change Name
Opening a thread always scrolls the conversation to the latest messages, with no per-thread scroll restore.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least one thread with enough messages to require scrolling
3. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open a thread and scroll to the middle of its history
2. Switch to another thread
3. Open the first thread again
4. Verify the viewport opens at the bottom (latest messages), not the previous middle position
5. Refresh the browser tab, open the same thread again, and verify it still opens at the bottom
6. Repeat steps 1 through 5 in dark theme

#### Expected Results
- Opening a thread always lands on the latest messages
- Previously viewed scroll positions are not restored when revisiting a thread
- Browser refresh does not restore a previously viewed conversation scroll position
- Behavior is the same in light theme and dark theme

#### Rollback/Cleanup
- None

---

### Hide worktree controls for non-Git folders

#### Feature/Change Name
Composer runtime options and project menu worktree actions are hidden when the selected folder is not a Git repository.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. One Git-backed project and one plain local folder without a `.git` directory are available in the folder picker/sidebar
3. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, select the plain local folder in the new-thread composer.
2. Confirm the `Local project` / `New worktree` runtime toggle is not shown.
3. Confirm the first message can still be sent as a normal local-folder chat.
4. Select a Git-backed folder and confirm the runtime toggle appears again.
5. Open the project action menu for a non-Git project and confirm `New worktree` is not shown.
6. Open the project action menu for a Git-backed project and confirm `New worktree` is shown.
7. Switch to dark theme and repeat steps 1, 2, 4, 5, and 6.

#### Expected Results
- Non-Git folders do not show `Local project` or `New worktree` runtime options.
- Non-Git project menus do not show `New worktree`.
- Git-backed folders continue to expose the runtime toggle and worktree action.
- The hidden/visible states are consistent and readable in both light and dark themes.

#### Rollback/Cleanup
- Remove any disposable plain folder or test chats created for this validation.

---

### Project worktree threads under canonical project

#### Feature/Change Name
Managed worktree threads remain visible under their matching canonical workspace-root project, and path-like project tooltips expose the full path.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Codex global workspace roots include `/Users/igor/Git-projects/codex-web-local`
3. Thread history contains at least one thread whose cwd is under `/Users/igor/.codex/worktrees/*/codex-web-local`
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open the sidebar Projects section.
2. Scroll to the `codex-web-local` project.
3. Confirm the project includes the main-root thread and managed worktree threads.
4. Confirm worktree rows still show the worktree icon.
5. Confirm unrelated `.git/worktrees` rows with the same leaf folder name are not grouped into this project.
6. Hover any shortened path-like duplicate project title and confirm the tooltip shows the full project path, not only the friendly label.
7. Switch to dark theme and repeat steps 1-6.

#### Expected Results
- Managed worktree threads with the same leaf folder name are not split into hidden path-like project groups.
- Generic `.git/worktrees` rows are not treated as managed Codex worktrees for project-root grouping.
- The canonical `codex-web-local` project shows both main-root and worktree threads.
- Path-like project tooltips expose the full project path.
- Project rows and worktree icons remain readable in light and dark themes.

#### Rollback/Cleanup
- None.

---

### Local editor follows system theme and separates CJK font fallback

#### Feature/Change Name
The `/codex-local-edit/...` Ace editor follows the browser/system light or dark color scheme, keeps Latin/code glyphs on a monospace font, and renders Chinese text through the system UI CJK font fallback.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A text file containing mixed English, paths, code spans, and Chinese text is available
3. Browser or device system appearance can be switched between light and dark
4. A mobile or narrow viewport is available for checking the editor font rendering

#### Steps
1. Open the mixed-language file through a `/codex-local-edit/...` URL in light system/browser appearance.
2. Confirm the toolbar, gutter, active line, selection, and editor surface use a light theme.
3. Confirm Latin letters, numbers, punctuation, and paths continue to align as monospace text.
4. Confirm Chinese text renders with one consistent non-heavy system CJK style instead of mixed fallback glyphs.
5. Switch the browser or system appearance to dark and reload or revisit the same editor URL.
6. Confirm the page and Ace editor switch to the dark theme and remain readable.
7. In a mobile viewport, repeat steps 3 and 4.
8. Edit the file, click `Save`, and confirm the status changes to `Saved`.

#### Expected Results
- The standalone editor no longer stays fixed on the dark `tomorrow_night` theme in light system appearance.
- Light and dark system appearances both theme the surrounding toolbar and Ace editor consistently.
- Latin/code text remains monospace.
- Chinese text uses a consistent lighter CJK fallback on mobile instead of alternating with a heavy-looking font.
- Saving still writes the edited file successfully.

#### Rollback/Cleanup
- Revert any disposable text edits made during validation.

---

### Local editor copy reference button

#### Feature/Change Name
The `/codex-local-edit/...` editor includes a `Copy ref` button that copies the current file path plus the selected line range, or the current line when there is no selection.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A text file with several visible lines is available
3. Browser clipboard access is available
4. Browser or device appearance can be switched between light and dark

#### Steps
1. Open the file through a `/codex-local-edit/...` URL in light appearance.
2. Select a span covering multiple lines.
3. Click `Copy ref`.
4. Paste the clipboard contents into a text field or clipboard inspector and confirm the output is `/absolute/path/to/file:start-end`.
5. Clear the selection, place the cursor on a single line, and click `Copy ref` again.
6. Confirm the clipboard now contains `/absolute/path/to/file:line`.
7. Switch the browser or system appearance to dark and repeat steps 2-6.

#### Expected Results
- The editor shows a `Copy ref` button alongside save controls.
- Multi-line selections copy a 1-based inclusive line range.
- Single-line or collapsed selections copy the current line only.
- Light theme and dark theme both keep the toolbar and status text readable.

#### Rollback/Cleanup
- Restore any previous clipboard contents manually if needed.

---

### Chinese slash text does not become a file link

#### Feature/Change Name
Plain Chinese prose containing `/`, such as `系统浅/深色主题`, is not split into an absolute-path file link.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A TestChat thread or disposable local chat is available
3. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, send or render a message containing `本地编辑页的系统浅/深色主题、中文字体都正常。`
2. Confirm the full text `系统浅/深色主题` remains plain inline text.
3. Confirm `/深色主题` is not blue, clickable, or rendered as a `.message-file-link`.
4. Send or render a separate message containing a real absolute path such as `/tmp/example.txt`.
5. Confirm the real absolute path still renders as a file link.
6. Switch to dark theme and repeat steps 1 through 5.

#### Expected Results
- Chinese prose with an internal slash remains plain text in both light and dark themes.
- The renderer does not split off the slash tail as an absolute path.
- Real absolute paths that start at a valid boundary still render as local file links.

#### Rollback/Cleanup
- Delete any disposable validation messages or threads if needed.

---

### Local browse pages follow system theme

#### Feature/Change Name
`/codex-local-browse/...` directory pages and related local browse surfaces follow the browser or system light/dark theme instead of staying fixed on one palette.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A readable folder path such as `/root/work/my-agent-configs` is available
3. Browser or device appearance can be switched between light and dark

#### Steps
1. Open a `/codex-local-browse/...` directory page in light appearance.
2. Confirm the page background, directory rows, parent link, open button, and edit icons use the light palette.
3. Switch the browser or system appearance to dark and reload the same directory page.
4. Confirm the same elements switch to the dark palette and remain readable.
5. Repeat the check on a narrow/mobile viewport.

#### Expected Results
- Directory listings no longer use a hard-coded dark palette.
- The page responds to the browser or system theme in both light and dark modes.
- Buttons, row cards, and links remain readable on desktop and mobile widths.

#### Rollback/Cleanup
- None.

---

### Local browse entry create and delete actions

#### Feature/Change Name
`/codex-local-browse/...` directory pages can create new files and directories in the current folder and delete listed entries from the same page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A disposable writable folder exists, for example `tmp/local-browse-entry-actions`
3. Browser or device appearance can be switched between light and dark

#### Steps
1. In light appearance, open the disposable folder through `/codex-local-browse/...`.
2. Enter `draft.md` in the new-file input and click `Create file`.
3. Confirm the page opens `/codex-local-edit/.../draft.md` and the file exists on disk.
4. Return to the directory browse page.
5. Enter `docs` in the new-directory input and click `Create dir`.
6. Confirm the page refreshes and `docs/` appears as a directory row, and verify `docs` is a real directory on disk.
7. Click the delete button for `draft.md`, confirm the browser prompt, and verify the row disappears after refresh.
8. Click the delete button for `docs/`, confirm the directory delete prompt, and verify the row disappears after refresh.
9. Switch to dark appearance and reload the same directory browse page.
10. Repeat create/delete with `dark-draft.md` and `dark-docs`.

#### Expected Results
- New files are created in the currently browsed folder only.
- New directories are created as real filesystem directories, not zero-byte files.
- Newly created text files open in the local editor after creation.
- Delete removes the selected file or directory after confirmation and refreshes the listing.
- The new inputs, create buttons, status text, and delete buttons remain readable in both light and dark themes.

#### Rollback/Cleanup
- Remove the disposable folder, for example `rm -rf tmp/local-browse-entry-actions`.

---

### Local browse raw links and broken symlinks

#### Feature/Change Name
`/codex-local-browse/...` directory pages tolerate broken symlinks and expose a working raw-file action for editable files.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A readable folder with a broken symlink is available, for example `/root/.codex/skills`
3. A disposable folder with an editable text file is available
4. Browser or device appearance can be switched between light and dark

#### Steps
1. Run `pnpm exec vitest run src/server/localBrowseUi.test.ts src/server/httpServer.test.ts`.
2. Open `/codex-local-browse/root/.codex/skills` in light appearance.
3. Confirm the directory page renders instead of returning `File not found`.
4. Open the disposable folder through `/codex-local-browse/...`.
5. Click the `Open raw` icon for the editable text file.
6. Confirm the browser opens the raw file response instead of redirecting to `/codex-local-edit/...`.
7. Switch to dark appearance and repeat steps 2-6.

#### Expected Results
- Broken symlinks are skipped during directory rendering and do not make the entire directory return 404.
- Normal files, directories, and valid symlinks continue to appear in the listing.
- The regular file name link still opens editable text files in the local editor.
- The `Open raw` action opens `/codex-local-browse/...?...raw=1` and returns the raw file content.
- Directory rows and action buttons remain readable in both light and dark themes.

#### Rollback/Cleanup
- Remove disposable files or folders created for the check.

---

### Local markdown preview uses browse routes and system theme

#### Feature/Change Name
Markdown files opened through the local editor expose a preview button that renders the preview through the local browse routes and matches the browser or system theme.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A `.md` or `.markdown` file is available
3. Browser or device appearance can be switched between light and dark

#### Steps
1. Open a markdown file through `/codex-local-edit/...`.
2. Confirm a `Preview` button appears only for markdown files.
3. Click `Preview` and confirm the rendered markdown appears in the preview pane.
4. Confirm links, images, and code blocks render in the preview.
5. Switch the browser or system appearance to dark and confirm the preview page matches it.

#### Expected Results
- Markdown preview is available only for markdown files.
- The preview content renders through the local browse preview route.
- Preview surfaces stay readable in both light and dark themes.

#### Rollback/Cleanup
- Revert any disposable file edits made during validation.

### Feature: Local markdown preview restores open state on refresh

#### Prerequisites
- App server is running from this repository.
- A writable `.md` or `.markdown` file is available, preferably a disposable copy.
- Browser localStorage is available for the app origin.
- Light and dark themes are both available from the operating system or browser color-scheme setting.

#### Steps
1. Open the markdown file through `/codex-local-edit/...`.
2. Click `Preview` and confirm the rendered markdown appears in the preview pane.
3. Refresh the browser page.
4. Confirm the editor loads with preview already open and the button reads `Hide Preview`.
5. Click `Hide Preview`, refresh the browser page again, and confirm the editor loads without the preview pane.
6. Repeat steps 1-5 in dark theme.

#### Expected Results
- Preview open/closed state persists for the current markdown file across page refreshes.
- Automatically restored preview triggers the normal preview render without requiring another click.
- Closing preview persists the closed state, so the next refresh starts in editor-only mode.
- Light and dark theme preview/editor surfaces remain readable after refresh.

#### Performance Audit
- Restoring the preview state adds one localStorage read during markdown editor startup and one localStorage write when the preview toggle changes.
- No extra preview render is triggered while preview is closed; the restored open state uses the existing single preview render path.

#### Rollback/Cleanup
- Click `Hide Preview` before leaving the disposable file if you want future reloads to start editor-only, or clear localStorage key prefix `codex.localBrowse.previewVisible.v1:`.

### Feature: Local markdown preview preserves scroll on edit

#### Prerequisites
- App server is running from this repository.
- A `.md` or `.markdown` file with enough content to scroll is available.

#### Steps
1. Open a markdown file through `/codex-local-edit/...`.
2. Open preview and scroll the preview pane away from the top.
3. Edit the file so the preview rerenders.
4. Confirm the preview stays near the previous scroll position.

#### Expected Results
- The preview does not jump back to the top after rerendering.
- The preview remains readable at the same approximate scroll position.

#### Rollback/Cleanup
- Revert any disposable file edits made during validation.

### Feature: Local markdown preview synchronizes editor and preview scroll

#### Prerequisites
- App server is running from this repository.
- A `.md` or `.markdown` file with enough content to scroll is available.

#### Steps
1. Open a markdown file through `/codex-local-edit/...`.
2. Click `Preview` to show the rendered pane.
3. Scroll the editor and confirm the preview follows the matching section.
4. Scroll the preview and confirm the editor follows the corresponding source lines.
5. Edit the file while the preview is open and confirm the preview stays on the same approximate section instead of jumping back to the top.
6. Type several characters in the editor with preview open and confirm the editor viewport does not jump upward after the preview refreshes.

#### Expected Results
- Scrolling the editor keeps the preview aligned to the same content region.
- Scrolling the preview keeps the editor aligned to the corresponding source lines.
- Preview updates after edits keep the current position stable.
- Typing in the editor does not trigger a reverse preview-to-editor scroll jump.

#### Rollback/Cleanup
- Revert any disposable file edits made during validation.

### Feature: Resizable markdown preview split

#### Prerequisites
- App server is running from this repository.
- A `.md` or `.markdown` file is available.
- A mobile viewport or touch-capable browser context is available.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open a markdown file through `/codex-local-edit/...`.
2. Click `Preview` to show the rendered pane.
3. Drag the divider between editor and preview to widen the preview pane.
4. Confirm the editor and preview resize live while dragging.
5. Switch to a mobile viewport or touch-capable browser context and repeat the drag check.
6. Switch to dark theme and repeat the desktop and mobile drag checks.

#### Expected Results
- The divider between editor and preview is draggable on desktop layouts.
- The divider remains draggable on mobile or touch-capable layouts, but switches to a vertical split.
- Preview size updates immediately while dragging and persists for the next markdown editor page.
- The preview pane can be widened enough to read dense formulas or long rendered lines.
- Light and dark preview surfaces remain readable during and after resizing.

#### Rollback/Cleanup
- Close the editor or refresh the page to clear any temporary state from the local split width.

### Feature: Markdown preview double-click source jump

#### Prerequisites
- App server is running from this repository.
- A `.md` or `.markdown` file is available.

#### Steps
1. Open a markdown file through `/codex-local-edit/...`.
2. Click `Preview` to show the rendered pane.
3. Double-click a rendered heading, paragraph, list item, or code block in the preview.
4. Double-click rendered inline math and display math in the preview.
5. Confirm the editor caret jumps to the matching source line.
6. Repeat the check after editing the file so the preview rerenders.

#### Expected Results
- Double-clicking rendered markdown in the preview moves the editor to the corresponding source line.
- Double-clicking formula text also moves the editor to the corresponding source line.
- The preview keeps working after rerendering.
- Link clicks still behave like normal links when they are not double-clicked.

#### Rollback/Cleanup
- Close the editor or refresh the page to clear any temporary state.

### Feature: Local markdown preview text highlighting

#### Prerequisites
- App server is running from this repository.
- A writable `.md` or `.markdown` file is available, preferably a disposable copy.
- Light and dark themes are both available from the operating system or browser color-scheme setting.

#### Steps
1. Run `pnpm exec vitest run src/server/localBrowseUi.test.ts src/components/content/markdownRenderer.test.ts`.
2. Open the markdown file through `/codex-local-edit/<absolute-markdown-path>`.
3. Click `Preview`.
4. In the preview pane, select a short phrase from a rendered paragraph and confirm floating `Highlight`, `Mark`, and `Add comment` actions appear beside the selection.
5. Click an unrelated area in the editor, preview, or toolbar and confirm the floating selection actions disappear.
6. Select the same phrase again, click inside the selected phrase so the browser clears the selection, and confirm the floating selection actions disappear.
7. Select the preview phrase again, then click the floating `Highlight` button.
8. Confirm the editor source wraps the matching text with `==` delimiters and the preview rerenders it with a highlighted background.
9. Click the highlighted block in the preview and confirm floating `Remove highlight` and `Add comment` actions appear beside it.
10. Scroll the preview pane and confirm the floating highlight actions stay attached to the highlighted block while visible, then hide once the block leaves the preview viewport.
11. Click `Add comment`, enter comment text in the inline floating editor, save it, and confirm the source inserts `\comment{...}` after the highlighted source span or its adjacent comment, then preview renders a `cmt` comment pill.
12. Click the rendered comment pill, use `Edit comment`, edit the inline floating editor, save it, and confirm the existing comment changes in source and preview.
13. Click the rendered comment pill again, use `Remove comment`, and confirm only the selected `\comment{...}` or `\cmt{...}` command is removed.
14. Click outside the highlighted block or comment pill and confirm the floating actions disappear.
15. Click the highlighted block again, then click `Remove highlight` and confirm the editor source removes only the surrounding `==` delimiters.
16. Select text directly inside the editor and confirm the floating `Highlight` button can add `==...==` there too.
17. Click inside the preview pane so it has focus, press `Ctrl+S`, reload the editor URL, and confirm the current editor content is saved instead of the browser saving/downloading the preview page.
18. Edit the file again, then press `Ctrl+S` with focus in the editor or click `Save`, reload the editor URL, and confirm the remaining highlight edits persist.
19. Repeat the preview, floating action, dismissal, preview-focused save, removal, and highlight visibility checks in dark theme.

#### Expected Results
- Markdown preview renders `==highlighted text==` as a readable highlighted `<mark>` style.
- `Highlight`, `Mark`, and `Add comment` appear near the current editor or preview selection instead of occupying the toolbar.
- Selection, highlight, and comment actions disappear when clicking anywhere other than the floating action itself.
- Selection actions also disappear when clicking inside the selected text clears that selection.
- Clicking an existing preview highlight exposes `Remove highlight` and `Add comment`; comment editing is entered from the rendered comment pill.
- Add/edit comment uses an inline floating editor near the current preview action, not a browser prompt dialog.
- Floating preview actions track the selected/highlighted preview text during preview scrolling instead of staying at stale viewport coordinates.
- Add comment is available from text selections and clicked highlights; edit/remove comment updates only the rendered comment command selected through the comment pill.
- `Remove highlight` removes the source delimiters without deleting an adjacent comment.
- `Ctrl+S` saves the editor file whether focus is in the editor page or inside the preview iframe.
- Existing preview links, scroll sync, resize behavior, and double-click source jump continue to work.
- Highlight colors are readable in both light and dark themes.

#### Performance Audit
- Dismissal adds one constant-time pointer/mouse listener inside the preview iframe and one constant-time parent message branch.
- Preview-focused save adds one constant-time keydown listener inside the preview iframe and reuses the existing editor save `PUT`.
- No filesystem access, network requests, preview rerenders, or markdown reparsing are triggered merely by hiding the floating buttons.

#### Rollback/Cleanup
- Remove any `==...==` or `\comment{...}` markers added to a non-disposable markdown file, or discard the disposable copy.

### Feature: Markdown mark/comment annotation rendering

#### Prerequisites
- App server is running from this repository.
- A writable `.md` or `.markdown` file is available, preferably a disposable copy.
- Light and dark themes are both available from the operating system or browser color-scheme setting.

#### Steps
1. Run `pnpm exec vitest run src/components/content/markdownRenderer.test.ts src/server/localBrowseUi.test.ts`.
2. Open the markdown file through `/codex-local-edit/<absolute-markdown-path>`.
3. Add `\mark{annotated text}\comment{review this}` to a paragraph.
4. Add `\cmt{standalone note}` to another paragraph.
5. Click `Preview` and confirm the marked text renders with annotation styling and the comments render as inline `cmt` comment pills.
6. Add `prefix \mark{A}\cmt{a longer note that may wrap}` near the end of a line and confirm `A` does not get forced onto a new line before the comment.
7. Add ``\cmt{check $E = mc^2$ and `code`}`` and confirm the comment still renders as a `cmt` pill with KaTeX math and inline code inside it.
8. Add ``\mark{A}\cmt{math $x^2$ and `code`}`` and confirm the mark and rich comment both stay inline.
9. Add ``\mark{use `notebook = "."` or `notebook = "_notebooks/<path>"`}`` and confirm both inline-code spans render inside one annotation mark.
10. Add ``\comment{outer note \comment{inner note}}`` and confirm both comments render as nested `cmt` pills.
11. Click the inner `cmt` pill, choose `Edit comment`, and confirm changing it updates only the inner command in the editor source.
12. Click a `cmt` pill, choose `Add comment`, and confirm the new `\comment{...}` is appended after the outer comment command rather than nested inside it.
13. In the comment input, use `Shift+Enter` to add a newline, then press `Enter` and confirm the comment is submitted.
14. Add `` `\mark{code}\comment{raw}` `` and confirm code spans keep the literal text.
15. Repeat the preview check in dark theme.

#### Expected Results
- `\mark{...}` renders as an annotation mark without exposing the raw command syntax.
- `\comment{...}` and `\cmt{...}` render as readable inline comment notes labeled `cmt`.
- Adjacent `\mark{...}\comment{...}` renders as a paired annotation.
- Short marked text in `\mark{A}\cmt{...}` remains in the normal text flow instead of moving to the next line with the comment.
- Comment bodies can contain inline math and inline code without exposing raw `\cmt{...}` syntax.
- Mark bodies can contain inline code without exposing raw `\mark{...}` syntax.
- Comment bodies can contain nested `\comment{...}` or `\cmt{...}` commands that render as nested comment notes.
- Nested comment pills can be edited or removed independently from their outer comment.
- Adding a comment from a comment pill appends a sibling command after the comment chain instead of nesting it.
- Comment inputs submit on `Enter`; `Shift+Enter` inserts a newline.
- Code spans are not parsed as annotations.
- Annotation marks and comment notes remain readable in light and dark themes.

#### Performance Audit
- Annotation parsing runs during the existing markdown tree transform and scans only text nodes that contain annotation command prefixes or `==`, plus adjacent inline siblings when a mark or comment body spans math or code nodes.
- Nested annotation bodies reuse the same balanced-command parser on their already-isolated child nodes.
- Code, links, math, and existing ignored text ancestors are skipped as before.
- No extra filesystem access, network requests, preview iframe messages, or preview rerenders are introduced.

#### Rollback/Cleanup
- Remove the disposable `\mark{...}`, `\comment{...}`, or `\cmt{...}` examples from non-test markdown files.

### Feature: Markdown preview mark/comment editing actions

#### Prerequisites
- App server is running from this repository.
- A writable `.md` or `.markdown` file is available, preferably a disposable copy.
- Light and dark themes are both available from the operating system or browser color-scheme setting.

#### Steps
1. Run `pnpm exec vitest run src/server/localBrowseUi.test.ts src/components/content/markdownRenderer.test.ts`.
2. Open the markdown file through `/codex-local-edit/<absolute-markdown-path>`.
3. Click `Preview`.
4. Select text in the editor or preview and confirm floating `Highlight`, `Mark`, and `Add comment` buttons appear near the selection.
5. Click `Mark` and confirm the source wraps the selected text as `\mark{...}` and the preview renders marked text.
6. Click the marked text in preview and confirm floating `Unmark` and `Add comment` actions appear.
7. Add ``\mark{按 `updated` 倒序列出}``, click the rendered mark, then use `Add comment` and `Unmark`; confirm the comment is adjacent to the full mark command and unmark preserves both the text and inline-code delimiters.
8. Add ``==`git status` with $x^2$==`` and ``==[Docs](./docs/readme.md) and `version`==``; click each rendered highlight, then use `Add comment` and `Remove highlight`, confirming the matching source command alone changes.
9. Click `Add comment`, enter comment text in the inline floating editor, save it, and confirm the source inserts `\comment{...}` after the marked source span or its adjacent comment, then preview renders the comment pill.
10. Select a rendered inline code span, click `Highlight`, `Mark`, and `Add comment` in separate disposable copies; confirm each preserves the code delimiters and the comment form yields `` `git status`\comment{check command} ``.
11. Select text A in the editor and run `Mark`; then select a different text B in preview, run `Mark` and `Add comment`, and confirm only B receives the new mark/comment.
12. Click the rendered comment pill, use `Edit comment`, enter `$\sum_{i=1}^n i^2$` in the inline floating editor, save it, and confirm the source keeps readable LaTeX braces instead of becoming `$\\sum_\{i=1\}^n i^2$`.
13. Click the rendered comment pill again, use `Add comment` and `Remove comment`, and confirm the added comment is a sibling after the comment chain while removal changes only the selected `\comment{...}` portion.
14. Repeat the selection, mark action, comment action, and highlight checks in dark theme.

#### Expected Results
- Mark actions reuse the floating-selection workflow without replacing highlight behavior.
- Marking selected text writes escaped `\mark{...}` source syntax and refreshes preview.
- Clicking marked preview text exposes `Unmark` and `Add comment`; comment editing is entered from the rendered comment pill.
- Mark and highlight actions locate their original Markdown bodies even when the rendered body contains inline code, math, links, or nested annotations.
- Add/edit comment uses an inline floating editor near the current preview action, not a browser prompt dialog.
- Add comment is available from text selections, clicked marks, clicked highlights, and clicked comments; edit/remove comment updates only the selected comment command.
- Adding a comment to rendered inline code keeps its closing backtick before the new annotation command.
- A current preview selection takes precedence over an earlier editor selection for highlight, mark, and comment actions.
- Comment editing preserves readable LaTeX source for balanced math braces while still escaping unmatched annotation braces.
- Unmark removes only the mark command, preserving marked text and any adjacent comment command.
- Light and dark theme action buttons and annotation styles remain readable.

#### Performance Audit
- Mark/comment actions reuse the existing preview selection message and editor replacement flow.
- Source matching scans the current source line window first, then falls back to the full editor buffer only when needed.
- No additional filesystem reads, background network requests, or continuous observers are introduced.

#### Rollback/Cleanup
- Remove any disposable `\mark{...}` / `\comment{...}` examples from non-test markdown files, or discard the disposable copy.

### Feature: Composer markdown preview

#### Prerequisites
- App server is running from this repository.
- A thread composer is visible and editable.

#### Steps
1. Type a markdown-rich draft into the message input.
2. Click the preview toggle button in the composer controls.
3. Confirm headings, lists, links, code blocks, and math render in place.
4. Toggle the preview off and on again after editing the draft.
5. Repeat at a narrow mobile viewport and in dark theme.

#### Expected Results
- The composer shows a rendered markdown preview for the current draft.
- The preview updates as the draft changes.
- The toggle does not affect the draft content or attachments.
- The preview and toggle remain readable in light and dark themes.

#### Rollback/Cleanup
- Close the thread or refresh the page to clear temporary state.

### Feature: Assistant response original text toggle

#### Prerequisites
- App server is running from this repository.
- A thread contains an assistant response with markdown formatting such as headings, bold text, links, or fenced code.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open the thread in light theme.
2. Hover the assistant response toolbar and click `Show original`.
3. Select a partial range inside the displayed raw markdown text.
4. Click `Hide original` and confirm the raw text panel closes.
5. Confirm the existing `Copy` button still copies the full response.
6. Switch to dark theme and repeat steps 2-4.

#### Expected Results
- The raw markdown source appears below the rendered response without replacing the rendered view.
- The raw source preserves markdown markers and line breaks and can be partially selected for manual copy.
- The toggle label changes between `Show original` and `Hide original`.
- The existing full-response copy behavior is unchanged.
- Light and dark theme raw source panels and toolbar buttons remain readable.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Faster reload skips duplicate ancillary refresh

#### Prerequisites
- App server is running from this repository.
- Browser profiling dependencies are installed.
- A dev server can run on a non-conflicting port.

#### Steps
1. Start the dev server, for example `node scripts/dev.cjs --host 127.0.0.1 --port 5174`.
2. From outside the repository root, run `PROFILE_BASE_URL=http://127.0.0.1:5174 PROFILE_ROUTE='/' PROFILE_WAIT_MS=6000 node /path/to/codexUI/scripts/profile-browser-runtime.cjs`.
3. Open the generated JSON report under `output/playwright/`.
4. Inspect `duplicateCounts` for `skillsList`, `rateLimitsRead`, and `providerModels`.
5. Inspect the `apiRows` entries for `model/list`, `config/read`, `collaborationMode/list`, and `free-mode/status`.
6. Run `./node_modules/.bin/vue-tsc --noEmit --pretty false`.

#### Expected Results
- Initial `refreshAll` does not schedule an ancillary refresh when provider synchronization is about to perform the startup ancillary refresh.
- Startup profiling no longer shows two rounds of `skills/list`, `account/rateLimits/read`, `model/list`, `config/read`, and `collaborationMode/list` caused by the initialization sequence.
- Startup profiling does not fetch `/codex-api/provider-models`; full provider model discovery remains reserved for explicit provider changes.
- `free-mode/status` does not fetch the OpenRouter free-model catalog unless the active provider is OpenRouter.
- The page still loads the thread list and then synchronizes provider state.
- TypeScript check passes.

#### Rollback/Cleanup
- Stop only the temporary dev server started for this test.
- Remove generated files under `output/playwright/` if they are not needed.

### Feature: Auto-continue skips manually stopped Codex turns

#### Prerequisites
- App server is running from this repository.
- A thread has an active Codex turn that can be interrupted by the backend or by a transient browser/session reconnect.
- Debug logging is available for the local run if deeper inspection is needed.

#### Steps
1. Start a long-running turn in a thread.
2. Trigger a non-user interruption condition such as refreshing the page or switching sessions while the turn is active.
3. Wait for the app-server thread status to return to idle.
4. Confirm the bridge starts a follow-up turn with `Please continue.` automatically.
5. Start another long-running turn and click the UI stop button.
6. Confirm the stopped turn does not auto-continue.
7. Run `./node_modules/.bin/vitest run src/server/codexAppServerBridge.inlinePayload.test.ts src/api/normalizers/v2.test.ts`.

#### Expected Results
- Latest interrupted turns on idle threads are detected from `thread/read` snapshots.
- Interruptions caused by `turn/interrupt` are recorded as intentional stops and skipped.
- Unexpected interruptions still resume the thread before calling `turn/start` with `Please continue.`.
- Explicitly queued user messages can still start after a manually stopped interrupted idle turn.
- The targeted Vitest suite passes.

#### Rollback/Cleanup
- Stop any disposable test turn from the UI if it is still running.
- Remove only temporary test threads if they were created solely for validation.

### Feature: Provider-scoped app-server runtime pool

#### Prerequisites
- App server is running from this repository.
- At least two providers are configurable from the sidebar, such as Codex plus OpenRouter, Moon Bridge, OpenCode Zen, or a custom endpoint.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Start the dev server on a non-conflicting port, for example `node scripts/dev.cjs --host 127.0.0.1 --port 5174`.
2. Connect to `/codex-api/ws` and confirm it receives the `ready` notification without crashing the Vite dev server.
3. In light theme, start a long-running turn with provider A.
4. While the turn is active, switch the sidebar provider to provider B.
5. Switch sessions or refresh the page, then return to the active thread.
6. Confirm new turns use provider B while the provider A turn can continue delivering events.
7. Repeat steps 3-6 in dark theme.
8. Run `./node_modules/.bin/vitest run src/server/codexAppServerBridge.inlinePayload.test.ts`.
9. Run `./node_modules/.bin/vue-tsc --noEmit --pretty false`.

#### Expected Results
- Opening the WebSocket no longer throws `Cannot read properties of undefined (reading 'onNotification')`.
- Switching providers does not dispose the previous provider's app-server process.
- Notifications from existing provider runtimes continue to reach SSE/WebSocket subscribers.
- User-initiated stops are still recorded against the active runtime's queue processor.
- Provider switching controls remain readable and usable in light and dark themes.
- The targeted Vitest suite and TypeScript check pass.

#### Rollback/Cleanup
- Stop only the temporary dev server started for this test.
- Switch the sidebar provider back to the preferred default after testing.

### Feature: Expanded command rows show full command text

#### Prerequisites
- App server is running from this repository.
- A thread contains at least one `commandExecution` item with a long command that is visibly truncated in the collapsed row.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open the thread in light theme.
2. Click the command row to expand its output.
3. Confirm the expanded panel shows a `Command` block with the full command text, not just the truncated row label.
4. Confirm the `Command` block shows line numbers for each command line.
5. Confirm the `Output` block shows line numbers for each output line.
6. Confirm long command and output lines wrap inside their blocks and scroll vertically when they exceed the block heights.
7. Click inside the `Command` block and press `Ctrl+A` or `Cmd+A`.
8. Confirm only the command block contents are selected, not the rest of the thread.
9. Click inside the `Output` block and press `Ctrl+A` or `Cmd+A`.
10. Confirm only the output block contents are selected, not the rest of the thread.
11. Hover the collapsed command label and confirm the full command is exposed via the tooltip.
12. Switch to dark theme and repeat steps 2-11.

#### Expected Results
- Expanded command rows show the complete command string above the output.
- The command and output blocks show non-selectable line numbers close to the left edge.
- The output content remains visible and unchanged in its own line-numbered block below the command block.
- The command and output blocks wrap long lines and scroll vertically when the wrapped content is taller than the block.
- Select-all while focused inside either block selects only that block's text area.
- The collapsed row still uses compact truncation for the inline label, but the full command is available on hover.
- Both light and dark themes keep the command and output blocks readable.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Disabled interrupted-turn auto-recovery and provider runtime isolation

#### Prerequisites
- App server is running from this repository.
- Moon Bridge catalog exists at the default catalog path or `CODEXUI_MOONBRIDGE_MODEL_CATALOG` points to a test catalog.
- `codex-moon` is available in `PATH` or `CODEXUI_CODEX_MOON_COMMAND` points to an executable command.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/server/codexAppServerBridge.inlinePayload.test.ts src/server/freeMode.test.ts`.
2. Run `./node_modules/.bin/vue-tsc --noEmit --pretty false`.
3. Start the dev server with `pnpm run dev --host 127.0.0.1 --port 4173`.
4. In light theme, open the provider dropdown and select `Moon Bridge`.
5. Confirm `/codex-api/moonbridge/models` and `/codex-api/moonbridge/model-metadata` return the local Moon Bridge catalog.
6. Select a Moon Bridge model, switch to another session, refresh the page, and switch back.
7. Confirm the provider remains `Moon Bridge` and the selected Moon Bridge model is not reset to another provider's model.
8. Start a long-running turn, refresh or switch sessions while it is active, and confirm an unexpected `interrupted` idle turn auto-starts `Please continue.`.
9. Start another long-running turn and click the UI stop button.
10. Confirm the user-stopped turn does not auto-continue.
11. Repeat steps 4-10 in dark theme.
12. POST a sample payload to `/codex-api/debug-log` and confirm it returns `{ "ok": true }`.

#### Expected Results
- Provider changes persist to `webui-free-mode.json` without disposing the previous provider runtime.
- Moon Bridge uses the `codex-moon` app-server command and exposes only Moon Bridge catalog models.
- Switching providers creates or reuses provider-scoped runtimes; existing provider turns can still emit notifications.
- Unexpected interrupted idle turns are resumed with a follow-up `Please continue.` turn.
- User-initiated `turn/interrupt` calls are recorded and skipped by auto-continue.
- Debug logging accepts frontend diagnostic posts and app-server interruption logs remain best-effort.
- Provider controls remain readable and usable in both light and dark themes.

#### Rollback/Cleanup
- Stop only the temporary dev server started for this test.
- Restore the preferred provider and model after manual verification.
- Remove any temporary Moon Bridge catalog created only for testing.

### Feature: Cursor CLI provider catalog and tool-call execution

#### Prerequisites
- App server is running from this repository.
- `codex-cursor`, `cursor-local-server`, and Cursor CLI `agent` are available in `PATH`.
- Cursor model catalog exists at `~/.local/share/my-agent-configs/cursor/codex/models_catalog.json` or `CODEXUI_CURSOR_MODEL_CATALOG` points to a test catalog.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/server/freeMode.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts`.
2. Run `./node_modules/.bin/vue-tsc --noEmit`.
3. Run `cargo fmt --check && cargo test` from `tooling/cursor-codex-proxy`.
4. Open Settings in light theme and select `Cursor CLI` from the provider dropdown.
5. Confirm `/codex-api/free-mode/status` returns `provider: "cursor"`, `currentModel` from the Cursor catalog, and Cursor catalog models such as `auto`.
6. Confirm `/codex-api/provider-models` returns `{ exclusive: true, source: "cursor" }` with only Cursor catalog model ids.
7. Start a new Cursor CLI thread from a workspace outside the `repos/codexUI` server directory and send `please use shell to run pwd, then only reply with the output path`.
8. Confirm the conversation renders the Cursor shell tool call as a command execution card, not as raw `[cursor tool_call ...]` JSON text.
9. Confirm the command card shows the shell command, thread workspace, exit status, and `stdout`, and the final assistant message contains the output path.
10. Run a Cursor shell command that exits non-zero after writing stdout, such as `printf 'cursor failure stdout\n'; false`, and confirm the command card is marked failed while still showing stdout.
11. Refresh the thread and confirm the persisted history still shows a single command card rather than separate started/completed raw text messages.
12. From an existing Cursor CLI session, send a follow-up prompt and confirm the outgoing `turn/start` request carries `modelProvider: "cursor"` rather than falling back to the configured Codex provider.
13. Open or create a Cursor CLI turn that emits compact `Calling Cursor tool`, `Called Cursor tool`, `Running \`...\``, or `Ran \`...\`` commentary and confirm these messages normalize into tool or command cards.
14. Switch to dark theme and repeat the command-card and Settings provider/model dropdown checks.

#### Expected Results
- Cursor CLI provider does not inherit stale OpenRouter model ids such as `openrouter/free`.
- Cursor model dropdown is clickable and populated from the Cursor catalog.
- Cursor runtime uses `codex-cursor app-server` and starts `cursor-local-server` on demand.
- Cursor shell tool calls are not rejected by Cursor's own approval layer during provider execution.
- Cursor shell tool calls run in the thread workspace, not the `repos/codexUI` server launch directory.
- Cursor shell tool-call started/completed commentary is normalized into the existing command execution UI without losing command, cwd, exit code, or output details.
- Cursor proxy `Calling`/`Called` and `Running`/`Ran` commentary formats normalize into the same tool and command cards.
- Cursor shell tool-call `failure` payloads preserve stdout/stderr in the command card even when the command exits non-zero.
- Follow-up turns on existing Cursor sessions preserve the explicit Cursor provider on `turn/start`.
- Provider controls and model dropdown remain readable in both light and dark themes.

#### Performance Audit
- Cursor model selection reads the existing local model catalog once per status/provider-model request and does not add network calls.
- `/codex-api/free-mode/status` now uses the same local catalog selection logic as `/codex-api/provider-models`, avoiding stale model fallback and duplicate provider discovery.
- `cursor-local-server` still starts only through the provider runtime wrapper; no always-on local daemon was added.
- Cursor tool-call display normalization runs only while normalizing a single agent message or completed realtime item; it adds no extra API requests and does not scan full session logs.
- Explicit turn provider propagation adds one scalar field to existing `turn/start` RPC payloads and does not add extra RPCs.
- No browser profile was captured for this server-side/provider-runtime fix; use `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser` if a later UI-rendering change touches the provider settings surface.

#### Rollback/Cleanup
- Archive any manual Cursor CLI smoke-test threads created during verification.
- Stop only the temporary dev server started for this test.
- Switch provider back to the preferred default after manual verification.

### Feature: Cursor CLI context overflow triggers Codex compaction

#### Prerequisites
- App server is running from this repository.
- `codex-cursor`, `cursor-local-server`, and Cursor CLI `agent` are available in `PATH`.
- A Cursor CLI thread can be driven close to or beyond the selected model context window, or a test app-server fixture can emit a failed `turn/completed` notification with `codexErrorInfo: "contextWindowExceeded"`.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/server/codexAppServerBridge.inlinePayload.test.ts`.
2. Open Settings in light theme and select `Cursor CLI` from the provider dropdown.
3. Open a Cursor CLI thread and trigger a context-window failure, or use a local fixture that emits `turn/completed` for the Cursor runtime with `status: "failed"` and `codexErrorInfo: "contextWindowExceeded"`.
4. Confirm the bridge sends `thread/compact/start` for the same `threadId` after the failed turn.
5. Confirm the same failed turn does not trigger repeated compact requests within the short cooldown window.
6. Switch to dark theme and confirm the provider/model controls and thread error state remain readable while the compaction item is shown.

#### Expected Results
- Cursor runtime context overflow failures trigger Codex-side `thread/compact/start`.
- Non-Cursor runtimes do not auto-trigger this Cursor-specific compaction path.
- Queued follow-up turns are not immediately drained ahead of the compaction request that was just started.
- Existing thread rendering remains readable in both light and dark themes.

#### Performance Audit
- The trigger runs only on `turn/completed` notifications in Cursor runtimes and performs one bounded RPC, `thread/compact/start`, per overflow turn.
- A per-thread cooldown prevents repeated compact request loops if the provider emits multiple overflow failures.
- No browser profile was captured for this backend notification-handling change; use `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser` if later UI changes are added to this flow.

#### Rollback/Cleanup
- Archive any manual Cursor CLI overflow test threads created during verification.
- Stop only the temporary dev server or fixture process started for this test.
- Switch provider back to the preferred default after manual verification.

### Feature: Composer @ search keeps folders and symlinks

#### Prerequisites
- App server is running from this repository.
- The workspace contains at least one folder and one symlink accessible from the composer search scope.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/server/composerFileSearch.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts src/api/codexGateway.test.ts`.
2. Open the composer in light theme and type `@` followed by a folder name.
3. Confirm the suggestion list shows the folder with a folder-style icon.
4. Type `@` followed by a symlink path or symlink target name.
5. Confirm the suggestion list shows the symlink badge and keeps the correct path metadata.
6. Repeat steps 2-5 in dark theme.

#### Expected Results
- `@` search returns files, folders, and symlinks from the workspace.
- Folder results use the folder icon instead of a file icon.
- Symlink results show the symlink badge and preserve the metadata returned by the server.
- Composer mention text and helper behavior remain readable in both light and dark themes.

#### Rollback/Cleanup
- Stop only the temporary dev server started for this test.
- Remove any temporary workspace used for composer mention checks.

### Feature: Intentional stop guard and Codex new-session default

#### Prerequisites
- App server is running from this repository.
- Moon Bridge or another non-Codex provider is available for provider switching.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/server/codexAppServerBridge.inlinePayload.test.ts src/composables/useDesktopState.test.ts`.
2. Run `./node_modules/.bin/vue-tsc --noEmit --pretty false`.
3. Start a long-running turn in light theme and click the UI stop button.
4. Confirm no automatic `Please continue.` turn is created after the stop.
5. Switch the new-session composer provider to `Moon Bridge`, refresh the page, then return to the new-session composer.
6. Confirm the new-session provider resets to `Codex` instead of inheriting `Moon Bridge`.
7. Repeat steps 3-6 in dark theme.

#### Expected Results
- A user `turn/interrupt` recorded before the delayed interrupted-turn check prevents auto-continue.
- Unexpected interrupted completions still auto-continue after the delay.
- New-session provider state is cleared when the empty composer context is selected.
- Provider controls remain readable and usable in both light and dark themes.

#### Rollback/Cleanup
- Stop only the temporary dev server started for this test.
- Restore the preferred provider and model after manual verification.

### Feature: Codex provider keeps shared model selections

#### Prerequisites
- App server is running from this repository.
- Moon Bridge is configured and exposes at least one model id that also appears in the Codex model list.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/composables/useDesktopState.test.ts`.
2. In Settings, switch Provider to `Codex`.
3. Open the composer model dropdown and choose a model id that also exists in the Moon Bridge catalog, such as `gpt-5.5` when available.
4. Reopen Settings and confirm Provider still shows `Codex`.
5. Switch to dark theme and repeat steps 2-4.

#### Expected Results
- The model dropdown updates to the selected model.
- Choosing a shared model while Provider is `Codex` does not silently switch the new-thread provider to Moon Bridge.
- Provider and model controls remain readable and usable in both light and dark themes.

#### Rollback/Cleanup
- Restore the preferred provider and model after manual verification.

### Feature: Conversation GitHub-style code block highlighting

#### Prerequisites
- App server is running from this repository.
- A chat thread or composer preview can render a fenced code block with a language tag such as `ts`, `js`, `py`, or `rs`.
- Light and dark themes are both available from Settings.

#### Steps
1. Open a thread containing a fenced code block in light theme.
2. Confirm the code block uses a GitHub-like light surface with distinct keyword, string, comment, number, function, tag, and diff colors.
3. Switch to dark theme and confirm the same code block uses GitHub dark syntax colors.
4. Open composer Markdown preview with a fenced code block and repeat the light and dark checks.
5. Confirm plan-card Markdown code blocks, when present, use the same colors as regular conversation code blocks.

#### Expected Results
- Conversation code blocks use GitHub-style light and dark highlighting rather than the old always-dark slate block.
- Code block language labels, borders, foreground text, and syntax colors remain readable in both themes.
- Composer preview and plan-card Markdown code blocks match the conversation code block styling.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Conversation code block copy button

#### Prerequisites
- App server is running from this repository.
- A chat thread contains a fenced code block with multiple lines.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the thread in light theme.
2. Confirm each rendered conversation code block shows a compact copy icon button in the upper-right corner.
3. Click the code block copy button and paste into a scratch editor.
4. Confirm only the code text is pasted, without the language label or copy button text.
5. Switch to dark theme and repeat steps 2-4.
6. Confirm image preview clicks and response-level copy buttons still work normally.

#### Expected Results
- The code block button uses a classic overlapping-squares copy icon.
- Clicking it copies the exact code block content.
- The button remains readable and aligned in both light and dark themes.
- Copy success briefly changes the button state without shifting the code block layout.
- Pressing Ctrl+A or Cmd+A while focused inside a conversation code block selects only that code block's code text.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Command code box copy button

#### Prerequisites
- App server is running from this repository.
- A chat thread contains a command execution card with command and output code boxes.
- Light and dark themes are both available from Settings.

#### Steps
1. Open the thread in light theme.
2. Confirm each command and output code box shows a compact copy icon button in the upper-right corner.
3. Click the command code box copy button and paste into a scratch editor.
4. Click the output code box copy button and paste into a scratch editor.
5. Confirm Ctrl+A or Cmd+A while focused inside a command code box still selects only that box's lines.
6. Switch to dark theme and repeat steps 2-5.

#### Expected Results
- Command and output code boxes use the same classic copy icon affordance as conversation code blocks.
- Copying command/output boxes copies only the visible box text, without line numbers or button text.
- Existing command box scoped select-all behavior still works.
- Copy buttons stay inside the command box bounds and remain readable in both themes.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Mobile pending tool calls render in the conversation

#### Prerequisites
- App server is running from this repository.
- A mobile-width viewport is available, for example 375x812.
- A thread can trigger a pending request such as command approval, MCP elicitation, `item/tool/requestUserInput`, or `item/tool/call`.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Open the target thread in a mobile-width viewport in light theme.
2. Trigger a pending tool call or approval request.
3. Confirm the pending request panel appears at the bottom of the conversation timeline.
4. Confirm the bottom composer area does not show a second duplicate pending request panel.
5. Use the action controls in the in-conversation panel and confirm the request is submitted normally.
6. Repeat steps 1-5 in dark theme.
7. Repeat with a desktop-width viewport and confirm the pending request panel still appears only in the bottom composer area.

#### Expected Results
- Mobile users can see and answer pending tool calls directly in the conversation timeline.
- The same request is not duplicated between the conversation and composer areas.
- Desktop behavior remains unchanged.
- The pending request panel remains readable and actionable in light and dark themes.

#### Rollback/Cleanup
- Decline, cancel, or complete any disposable pending request created for the check.

### Feature: Mobile persisted tool-call cards render in the conversation

#### Prerequisites
- App server is running from this repository.
- A mobile-width viewport is available, for example 375x812.
- A thread contains persisted `mcpToolCall`, `collabAgentToolCall`, or `webSearch` items.
- Light theme and dark theme are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/api/normalizers/v2.test.ts`.
2. Open the target thread in a mobile-width viewport in light theme.
3. Confirm each persisted tool call appears as a compact row in the conversation timeline.
4. Tap a tool-call row and confirm progress, input, output, and error details expand when present.
5. Switch to dark theme and repeat steps 2-4.
6. Repeat with a desktop-width viewport and confirm the same tool-call rows remain visible.

#### Expected Results
- Persisted MCP, collaboration-agent, and web-search tool calls are not dropped from the conversation.
- Tool-call rows fit mobile width without horizontal page overflow.
- Expanded details remain readable in both light and dark themes.
- Desktop conversation rendering still shows the same tool-call information.

#### Rollback/Cleanup
- No persistent cleanup is needed beyond closing any disposable test thread.

### Feature: New-session Moon Bridge provider/model first message

#### Prerequisites
- App server is running from this repository.
- Moon Bridge is configured and exposes `ark-code-latest`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/composables/useDesktopState.test.ts`.
2. Open a new chat composer in light theme.
3. In Settings, switch Provider to `Moon Bridge`.
4. In the composer model dropdown, choose `ark-code-latest`.
5. Send the first message in that new chat.
6. Confirm the created thread keeps Provider as `Moon Bridge` and Model as `ark-code-latest`.
7. Repeat steps 2-6 in dark theme.

#### Expected Results
- New-chat provider selection is stored in the new-session provider context and is not cleared by opening the composer.
- The first message request starts with Moon Bridge rather than falling back to Codex.
- The composer cannot submit while the provider runtime switch is still loading.
- Provider and model controls remain readable and usable in both light and dark themes.

#### Rollback/Cleanup
- Restore the preferred provider and model after manual verification.

### Feature: Session switch preserves composer model context

#### Prerequisites
- App server is running from this repository.
- At least one existing Moon Bridge session uses Provider `Moon Bridge`, Model `ark-code-latest`, and a non-default reasoning effort.
- At least one existing Codex session uses a different model/reasoning effort.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/composables/useDesktopState.test.ts src/api/codexGateway.test.ts`.
2. Open the Moon Bridge session in light theme.
3. Confirm the composer shows Provider `Moon Bridge`, Model `ark-code-latest`, and that session's reasoning effort.
4. Switch to the Codex session and confirm the composer changes to that session's own model/reasoning effort.
5. Switch back to the Moon Bridge session and confirm the composer does not flash or reset to `gpt-5.5` and `None`.
6. Send a follow-up message in the Moon Bridge session.
7. Repeat steps 2-6 in dark theme.

#### Expected Results
- Existing sessions do not inherit the new-session model fallback.
- `thread/resume` metadata hydrates the session's model, provider, and reasoning effort before the composer is used.
- Background provider/model refresh does not overwrite an existing session with the current global config.
- The next turn in the Moon Bridge session still uses `ark-code-latest`.

#### Rollback/Cleanup
- Restore the preferred provider, model, and reasoning effort after manual verification.

### Feature: Stop refreshes active turn id before interrupt

#### Prerequisites
- App server is running from this repository.
- A thread can start a long-running turn.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open a thread in light theme and start a long-running turn.
4. Before the turn finishes, click the composer stop button.
5. Start another long-running turn in the same thread and click stop again quickly, especially after a notification or refresh delay.
6. Repeat steps 3-5 in dark theme.

#### Expected Results
- Stop calls `turn/interrupt` with the currently active turn id from `thread/read`, not a stale cached id.
- If the active turn changes between the refresh and interrupt RPC, stop refreshes once and retries with the newer active turn id.
- No error appears like `expected active turn id ... but found ...`.
- The thread exits in-progress state and the stop control returns to idle in both light and dark themes.

#### Performance Audit
- Stop adds one targeted `thread/read` only when the user clicks the stop button.
- No polling interval, startup request, or background thread-list fanout is changed.
- Retry is bounded to one additional refresh and one additional interrupt attempt.

#### Rollback/Cleanup
- No persistent cleanup is required beyond closing any disposable test thread.

### Feature: Cursor CLI shell payload recovery

#### Prerequisites
- App server is running from this repository.
- A Cursor CLI backed Codex session exists with shell tool payload files under `.codex/cursor-tool-payloads/`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/server/codexAppServerBridge.inlinePayload.test.ts src/api/normalizers/v2.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open a Cursor CLI session that contains shell commands, for example session `019e6342-76cd-7e41-aece-413a748935ae`.
4. Confirm entries such as `ssh -V` and `ls -la "$HOME/.ssh"` appear as command execution cards rather than raw `Ran ... payload: ...` assistant text.
5. Expand at least one successful command card and one failed command card, if present.
6. Switch to dark theme and repeat steps 3-5.

#### Expected Results
- Historical Cursor CLI shell payload references are recovered into `commandExecution` items.
- Paired `Running` and `Ran` session records produce one command card, not duplicate cards.
- Command cards preserve command text, cwd, exit code, status, duration, and output from the payload JSON.
- Non-shell Cursor tool payloads continue to render as Cursor tool call cards.
- Command and tool cards remain readable in both light and dark themes.

#### Performance Audit
- Payload JSON files are only read while recovering turns from the already-loaded session JSONL.
- Recovery caches payload reads by absolute path, so paired `Running`/`Ran` records do not reread the same JSON file repeatedly.
- No browser-side requests or polling cadence are added.

#### Rollback/Cleanup
- No persistent cleanup is required beyond closing the verification session.

### Feature: File-link click path picker

#### Prerequisites
- App server is running from this repository.
- A TestChat workspace root is registered in the app.
- The TestChat workspace contains a file fixture such as `context/src/utils/fileLinkResolver.ts`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/api/codexGateway.test.ts src/components/content/markdownRenderer.test.ts src/composables/useDesktopState.test.ts`.
2. Run `pnpm run build:frontend`.
3. Start the dev server and run the TestChat CJS Playwright verification for file-link picking.
4. In a TestChat thread, send or locate a message containing `[fileLinkResolver.ts](src/utils/fileLinkResolver.ts:1-5)` and inline code `` `src/utils/fileLinkResolver.ts:1-5` ``.
5. Click the rendered file link.
6. Confirm a path picker opens near the clicked link, with the search input prefilled from the linked path.
7. Select the matching `context/src/utils/fileLinkResolver.ts` result.
8. Confirm the browser opens the local browse/editor route for the selected absolute path and preserves the `line=1-5` range.
9. Repeat the picker interaction in light and dark themes.
10. Run `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser`.

#### Expected Results
- File links do not navigate immediately on left click.
- Clicking a file link opens a keyboard-usable path picker instead.
- The picker searches the linked path text across the current cwd and registered workspace roots.
- Choosing a candidate opens that candidate's absolute local path.
- Existing markdown parsing behavior remains intact for inline code paths, directory paths, `~/` paths, and false `/Codex` tail links.
- The picker is readable and usable in both light and dark themes.
- Startup profiling does not show duplicate API requests or warnings.

#### Rollback/Cleanup
- Delete disposable TestChat messages and fixture files created for the check.

### Feature: Absolute file-link direct navigation

#### Prerequisites
- App server is running from this repository.
- A TestChat workspace is available.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/components/content/markdownRenderer.test.ts`.
2. Open a TestChat thread in light theme.
3. Send or locate messages containing `[absolute](/root/work/TestChat/context/src/utils/fileLinkResolver.ts:1-5)` and `` `~/work/TestChat/context/src/utils/fileLinkResolver.ts:1-5` ``.
4. Click each rendered file link.
5. Confirm the path picker does not open and the browser navigates directly to the local browse/editor route for that absolute path, preserving `line=1-5`.
6. Send or locate a relative link such as `[relative](src/utils/fileLinkResolver.ts:1-5)`.
7. Click the relative link and confirm the path picker still opens.
8. Repeat steps 3-7 in dark theme.

#### Expected Results
- File links whose source path starts with `/`, `~/`, `file://`, or a Windows drive prefix navigate directly.
- Relative file links still open the path picker so the user can choose the intended matching file.
- Direct navigation and picker surfaces remain readable in both light and dark themes.

#### Rollback/Cleanup
- Delete disposable TestChat messages created for the check.

### Feature: Session switch restores persisted model state

#### Prerequisites
- App server is running from this repository.
- At least one session has persisted `turn_context` data with Provider `Moon Bridge`, Model `ark-code-latest`, and a non-default reasoning effort.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts src/api/codexGateway.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the target session in light theme.
4. Switch to a different session, then switch back to the target session.
5. Confirm the composer still shows Provider `Moon Bridge`, Model `ark-code-latest`, and the persisted reasoning effort instead of resetting to `gpt-5.5` and `None`.
6. Send a follow-up message and confirm the next turn uses the same model state.
7. Switch the same session to Provider `Codex` and Model `gpt-5.5`, then send another follow-up message.
8. Confirm the composer and the running turn stay on Provider `Codex` and Model `gpt-5.5`.
9. While a Moon Bridge turn is running, queue a follow-up message and confirm the queued turn keeps Provider `Moon Bridge`, Model `ark-code-latest`, and the selected reasoning effort when it starts.
10. Interrupt a Moon Bridge turn in a way that triggers automatic `Please continue.` recovery and confirm the recovery turn keeps `ark-code-latest`.
11. Repeat steps 3-10 in dark theme.

#### Expected Results
- Session switches hydrate `model`, `modelProvider`, and `reasoningEffort` from persisted session data.
- The composer no longer flashes back to the current global config when a session is selected.
- The follow-up turn keeps using the persisted Moon Bridge session state.
- Explicitly switching an existing Moon Bridge session to Codex sends the next turn through `openai` and does not get overwritten by older session metadata.
- Queued and automatic recovery turns preserve the session's Moon Bridge model state instead of falling back to the global config.
- The behavior stays consistent in both light and dark themes.

#### Performance Audit
- Session switching still uses the existing `thread/read` or `thread/resume` flow; this change does not add browser-side network requests.
- Explicit provider/model changes invalidate only that thread's cached resume state, adding one `thread/resume` before the next send so app-server provider state is updated.
- Queue persistence stores three scalar fields with each queued message and does not change the queue drain polling cadence.
- Automatic recovery reads model state through the existing cached session JSONL helper and passes it into the already-required `thread/resume`; no extra app-server RPC is added for the recovery turn.

#### Rollback/Cleanup
- Restore the preferred provider, model, and reasoning effort after manual verification.

### Feature: Moon Bridge new-session model picker

#### Prerequisites
- App server is running from this repository.
- Moon Bridge model catalog is available at `~/.local/share/my-agent-configs/moonbridge/codex/models_catalog.json` or through `CODEXUI_MOONBRIDGE_MODEL_CATALOG`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the home/new-session composer in light theme.
4. In Settings, change Provider to `Moon Bridge`.
5. Open the Model dropdown in the new-session composer.
6. Confirm the dropdown lists Moon Bridge catalog models and does not show Codex-only models from `model/list`.
7. Select a Moon Bridge model and start a new session.
8. Confirm the new session starts with Provider `Moon Bridge` and the selected model.
9. Repeat steps 3-8 in dark theme.

#### Expected Results
- The new-session composer uses the explicit UI-selected provider when refreshing model choices.
- If `config/read` still reports Codex while Moon Bridge is selected, the model picker remains scoped to Moon Bridge.
- The selected Moon Bridge model is persisted under the Moon Bridge provider-scoped new-session model key.
- Codex model choices remain unchanged when Provider is `Codex`.

#### Performance Audit
- Provider refresh still uses the existing `refreshAncillaryState` path and does not add new API calls.
- The added provider check is an O(1) localStorage-backed map lookup during model preference refresh.
- Startup background refresh still calls model discovery with `includeProviderModels: false`; full provider discovery remains limited to explicit provider changes or awaited ancillary refreshes.

#### Rollback/Cleanup
- Switch Provider back to the preferred default after manual verification.

### Feature: Cursor tool call grouping and compact payload summaries

#### Prerequisites
- App server is running from this repository with Provider set to `Cursor CLI`.
- A thread is available where Cursor CLI can make two or more consecutive non-shell tool calls.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/api/normalizers/v2.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the Cursor CLI thread in light theme.
4. Trigger or open a turn containing consecutive Cursor tool call cards, such as multiple `read`/`edit` calls with no assistant text between them.
5. Confirm the consecutive Cursor tool calls are represented by one compact grouped row.
6. Expand the grouped row and confirm each individual tool call can still be expanded.
7. Confirm long tool input/output appears as a shortened preview in the message body while the `payload: ...json` path remains present for full payload recovery.
8. Confirm the payload reference is compact, using `<session>/<short-file>.json` rather than an absolute `.codex/cursor-tool-payloads/...` path with the full raw call id.
9. Repeat steps 3-8 in dark theme.

#### Expected Results
- Consecutive Cursor CLI tool calls group into one collapsible row, matching consecutive shell command behavior.
- Expanding the group reveals each original tool call in order.
- Long Cursor tool arguments and output are shortened in visible commentary instead of flooding the timeline.
- The compact payload path remains available so server-side inline payload recovery can hydrate complete tool call details.
- Light and dark theme grouped tool call rows remain readable.

#### Performance Audit
- Grouping is computed with one linear pass over the already-normalized message list.
- Hidden grouped tool call IDs are stored in a `Set`, keeping row visibility checks O(1).
- The proxy still writes one payload file per Cursor tool call and avoids embedding long command/output text in streaming messages.

#### Rollback/Cleanup
- No cleanup is required.

### Feature: Moon Bridge existing-session provider switch

#### Prerequisites
- App server is running from this repository.
- Moon Bridge model catalog contains `ark-code-latest`.
- Existing session `019e6342-76cd-7e41-aece-413a748935ae` is available, or another session currently using a Codex/Cursor model is available.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts src/commandResolution.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Restart the app server so it loads the latest server-side command resolver.
4. Open session `019e6342-76cd-7e41-aece-413a748935ae` in light theme.
5. Change Provider to `Moon Bridge`.
6. Open the Model dropdown.
7. Confirm the dropdown contains `ark-code-latest` and other Moon Bridge catalog models.
8. Confirm the previous Codex/Cursor-only model is not kept as the active selected model when it is not in the Moon Bridge catalog.
9. Repeat steps 4-8 in dark theme.

#### Expected Results
- Switching an existing session to Provider `Moon Bridge` refreshes the model picker to the Moon Bridge catalog.
- If the prior selected model is not in the Moon Bridge catalog, the composer selects the first Moon Bridge model, currently `ark-code-latest`.
- Existing session restores preserve persisted model state only when the model belongs to the active provider catalog.
- A reloaded session that already has Provider `Moon Bridge` but still stores an old Codex/Cursor model is repaired to `ark-code-latest`.

#### Performance Audit
- Explicit provider changes reuse the existing ancillary refresh path and do not add new API calls.
- Existing-session model replacement is an O(1) membership check against the already-fetched model list.

#### Rollback/Cleanup
- Switch the session back to the preferred provider/model after manual verification.

### Feature: Moon Bridge model picker when Codex RPC is slow

#### Prerequisites
- App server is running from this repository.
- Existing session `019e6342-76cd-7e41-aece-413a748935ae` is available, or another Cursor/Codex-backed session is available.
- Moon Bridge model catalog contains `ark-code-latest`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts src/api/codexGateway.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the existing session in light theme while it is using a Cursor/Codex model such as `gpt-5.5`.
4. Change Provider to `Moon Bridge`.
5. Confirm `/codex-api/free-mode/status` returns `provider: "moon"` and `currentModel: "ark-code-latest"`.
6. Open the Model dropdown.
7. Confirm the dropdown shows only Moon Bridge catalog models, including `ark-code-latest`, `deepseek-v3.2`, and `moonbridge`.
8. Confirm Codex/Cursor models such as `gpt-5.5`, `auto`, and `composer-2` are not listed.
9. Refresh the same route with local storage already containing Provider `Moon Bridge` and a stale model such as `gpt-5.5`.
10. Confirm the model picker still repairs the selected model to `ark-code-latest` before the stale model can be submitted.
11. Repeat steps 3-10 in dark theme.

#### Expected Results
- Provider-backed model discovery reads `/codex-api/provider-models` before `model/list` when provider models are required.
- A slow or stuck `config/read` RPC does not prevent the Moon Bridge model picker from refreshing.
- Startup provider/model refresh is kicked off before thread list or resume RPCs can block the route.
- The existing session's stale model is replaced with `ark-code-latest` when the previous model is not in the Moon Bridge catalog.

#### Performance Audit
- The provider-model request count stays the same for explicit provider changes.
- The UI no longer blocks indefinitely on provider-backed `config/read`, `model/list`, or ancillary RPCs before updating the model picker.
- The fallback config path is a short timeout and does not add polling.

#### Rollback/Cleanup
- Switch the session back to the preferred provider/model after manual verification.

### Feature: Moon Bridge command resolution

#### Prerequisites
- `codex-moon` is installed or `CODEXUI_CODEX_MOON_COMMAND` points to the Moon Bridge wrapper.
- Moon Bridge model catalog contains `ark-code-latest`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/commandResolution.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Start or restart the app server so it loads the updated resolver.
4. Open the app in light theme and switch Provider to `Moon Bridge`.
5. Confirm no `Codex Moon Bridge CLI is not available` error appears.
6. Open the Model dropdown and confirm `ark-code-latest` appears.
7. Repeat steps 4-6 in dark theme.

#### Expected Results
- Moon Bridge command resolution accepts an installed executable even when `codex-moon --version` exits non-zero.
- Switching to Provider `Moon Bridge` updates `/codex-api/provider-models` to the Moon Bridge catalog.
- The model picker includes `ark-code-latest`.

#### Performance Audit
- The resolver now uses PATH/executable checks for `codex-moon`; it no longer starts the Moon Bridge wrapper during availability detection.
- The change removes the previous `--version` startup probe and does not add browser requests.

#### Rollback/Cleanup
- Switch Provider back to the preferred default after manual verification.

### Feature: Goal slash command workflow

#### Prerequisites
- App server is running from this repository against a Codex build that exposes `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`.
- At least one existing thread is available.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm vitest run src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts`.
2. Run `pnpm run build:frontend`.
3. Open an existing thread in light theme.
4. Submit `/goal Ship goal slash-command support`.
5. Confirm no normal user prompt is appended and no new turn starts.
6. Confirm the live overlay shows `Goal active` and includes `Ship goal slash-command support`.
7. Submit `/goal $planning-with-files Track goal slash-command support`.
8. Confirm the command still routes to the goal workflow, the live overlay shows `Goal active`, and no normal turn starts even though a skill is attached.
9. Submit `/goal`.
10. Confirm the current goal is shown without starting or steering a turn.
11. Submit `/goal pause`, then confirm the overlay shows `Goal paused`.
12. Submit `/goal unpause`, then confirm the overlay returns to `Goal active`.
13. Submit `/goal clear`, then confirm the goal overlay disappears without showing a success notice.
14. From the new-thread composer, submit `/goal Validate new-thread goal setup`.
15. Confirm a new thread is created, the goal notice appears, and no normal turn is started.
16. From the new-thread composer, submit `/goal $planning-with-files Validate new-thread goal setup`.
17. Confirm a new thread is created, the skill mention does not start a normal turn, and the goal notice appears.
18. Repeat steps 3-17 in dark theme.

#### Expected Results
- `/goal <objective>` routes to `thread/goal/set` with `status: active`.
- `/goal` routes to `thread/goal/get`.
- `/goal pause` and `/goal unpause` route to `thread/goal/set` status updates.
- `/goal clear` routes to `thread/goal/clear`.
- Goal commands do not call `turn/start` or `turn/steer`.
- Goal commands that include skill mentions still route to goal RPCs instead of normal turns.
- New-thread `/goal <objective>` creates the thread, sets the goal, and does not show an interrupt-pending state.
- Light and dark theme overlays remain readable.

#### Performance Audit
- Normal prompt submission does not add goal RPCs; command parsing is a single local string check before the existing turn path.
- Goal submissions perform exactly one goal RPC after the thread id exists, except new-thread goal setup which first creates the thread.
- Skill mentions on goal commands do not add network calls because the goal branch ignores attachments after local slash-command detection.
- Goal notices are stored in a per-thread map and pruned with other thread-scoped state.

#### Rollback/Cleanup
- Use `/goal clear` on test threads after manual verification.

### Feature: Provider runtime routing for existing threads

#### Prerequisites
- `codex-moon` and `codex-cursor` are installed or configured through `CODEXUI_CODEX_MOON_COMMAND` and `CODEXUI_CODEX_CURSOR_COMMAND`.
- An existing thread that previously ran with Provider `Moon Bridge` is available.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm vitest run src/server/codexAppServerBridge.inlinePayload.test.ts src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts`.
2. Run `pnpm run build:cli`.
3. Open the existing Moon Bridge thread in light theme.
4. Switch Provider to `Cursor CLI`.
5. Confirm the model dropdown switches to Cursor CLI models.
6. Send a short prompt and inspect the `turn/start` RPC payload.
7. Confirm the payload contains `modelProvider: "cursor"` and the backend request is handled by the Cursor runtime, not the Moon Bridge runtime.
8. Start a long-running Moon Bridge turn, then switch Provider to `Cursor CLI` while it is running.
9. Send an in-progress steering prompt and confirm the `turn/steer` RPC still routes to the active Moon Bridge runtime.
10. Interrupt the active Moon Bridge turn and confirm the `turn/interrupt` RPC routes to the active Moon Bridge runtime.
11. Queue a follow-up message after switching to Cursor CLI.
12. Let the active Moon Bridge turn finish and confirm the queued follow-up starts through Cursor runtime.
13. Repeat steps 3-12 in dark theme.

#### Expected Results
- Explicit `modelProvider: "cursor"` RPCs route to the Cursor wrapper runtime even if the active global runtime was previously Moon Bridge.
- In-progress steer and interrupt operations use the provider captured for the active turn.
- Queued follow-up turns keep their captured provider and are drained by the matching wrapper runtime.
- Existing Moon Bridge sessions no longer keep sending follow-up turns through the Moon Bridge URL after switching to Cursor CLI.
- Light and dark theme provider controls remain readable while switching providers.

#### Performance Audit
- Runtime routing is a constant-time check on RPC method and `modelProvider`; it does not add extra network requests.
- Existing app-server runtimes are reused by signature, so switching does not create duplicate runtime processes for the same provider.
- Thread search caches are only invalidated when persisted free-mode state changes, preserving the existing cache behavior for per-RPC routing.

#### Rollback/Cleanup
- Switch Provider back to the preferred runtime after manual verification.

### Feature: Ark Coding Plan provider runtime

#### Prerequisites
- `codex-ark` is installed or `CODEXUI_CODEX_ARK_COMMAND` points to the Ark wrapper.
- `ARK_API_KEY` is set for the wrapper process.
- The Ark model catalog exists at `CODEXUI_ARK_MODEL_CATALOG`, `CODEX_ARK_MODEL_CATALOG`, or `~/.local/share/my-agent-configs/ark/codex/models_catalog.json`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/commandResolution.test.ts src/server/freeMode.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts src/composables/useDesktopState.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Start or restart the app server so it loads the updated resolver.
4. Open the app in light theme and switch Provider to `Ark Coding Plan`.
5. Confirm no `Codex Ark CLI is not available` error appears.
6. Open the Model dropdown and confirm Ark Coding Plan models from the Ark catalog appear, such as `doubao-seed-2-0-code-preview-260215`.
7. Send a short prompt and inspect the backend command/RPC path.
8. Confirm the app-server runtime command is `codex-ark` and the `turn/start` payload carries `modelProvider: "ark"`.
9. Repeat steps 4-8 in dark theme.

#### Expected Results
- Provider `Ark Coding Plan` appears alongside Codex, OpenRouter, OpenCode Zen, Moon Bridge, Cursor CLI, and Custom endpoint.
- Switching to Ark persists free-mode provider state with `provider: "ark"` and no provider API key.
- Ark model discovery reads the Ark catalog and scopes the model picker to Ark models.
- Active Ark turns run through `codex-ark app-server`, not the default Codex command and not the Moon Bridge or Cursor CLI wrappers.
- Light and dark theme provider controls remain readable while switching providers.

#### Performance Audit
- Ark catalog reads reuse the existing local catalog pattern used by Moon Bridge and Cursor CLI.
- Provider switching adds no polling and no remote model-list request; the model picker reads local catalog data through the existing provider-models endpoint.
- Runtime routing remains a constant-time provider check and reuses app-server runtimes by signature.

#### Rollback/Cleanup
- Switch Provider back to the preferred runtime after manual verification.

### Feature: Rebind wrapper runtime before provider-switched turns

#### Prerequisites
- `codex-cursor` is installed or configured through `CODEXUI_CODEX_CURSOR_COMMAND`.
- An existing Codex/default-provider thread is available, preferably one whose session metadata shows a non-Cursor default provider such as `rustcat`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm vitest run src/api/codexGateway.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts src/composables/useDesktopState.test.ts`.
2. Run `pnpm run build:cli`.
3. Open the existing Codex/default-provider thread in light theme.
4. Switch Provider to `Cursor CLI`.
5. Send a new prompt after the previous turn is idle.
6. Confirm the backend handles `thread/resume` with `modelProvider: "cursor"` on the Cursor runtime before handling `turn/start`.
7. Inspect the latest session JSONL `turn_context` for that prompt and confirm `collaboration_mode.settings.model_provider` is `cursor`.
8. On the same idle thread, switch between Codex/default, Moon Bridge, and Cursor CLI, sending one prompt after each switch.
9. Confirm each switch triggers a fresh `thread/resume` using the selected provider before the next `turn/start`.
10. Reload the app and reopen the same thread.
11. Confirm provider recovery does not fall back to the old session-level provider.
12. Repeat steps 3-11 in dark theme.

#### Expected Results
- New Cursor turns on an older Codex/default-provider session are rebound with `thread/resume(modelProvider: "cursor")` before `turn/start`.
- `turn/start` runs through the Cursor runtime even when the session originally recorded `session_meta.model_provider` as a Codex/default provider.
- The latest provider-specific turn persists `collaboration_mode.settings.model_provider`, so future `thread/read` recovery overrides stale session-level metadata.
- Already-loaded sessions are re-resumed after Codex/default, Moon Bridge, and Cursor CLI provider switches instead of reusing the previous provider's resume state.
- Explicit Moon Bridge and Cursor CLI `turn/start` RPCs route to the matching wrapper runtime even when the active global runtime is the other wrapper.
- Queued and auto-continued turns keep using their explicit provider-specific runtime.
- Light and dark theme provider controls remain readable while switching providers.

#### Performance Audit
- Provider-switched wrapper `turn/start` adds one local app-server `thread/resume` on the selected runtime before starting the turn.
- The extra resume is scoped to explicit wrapper providers (`Moon Bridge`/`Cursor CLI`) and reuses runtime instances by signature.
- No extra model-list fetches or runtime processes are introduced.

#### Rollback/Cleanup
- Switch Provider back to the preferred runtime after manual verification.

### Feature: Cursor shell command newline escape rendering

#### Prerequisites
- `codex-cursor` is installed or configured through `CODEXUI_CODEX_CURSOR_COMMAND`.
- A Cursor CLI thread is available.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/api/normalizers/v2.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts src/components/content/markdownRenderer.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the Cursor CLI thread in light theme.
4. Run or inspect a Cursor shell command shaped like `printf '%s\n' "$HOME"`.
5. Expand the command execution row.
6. Confirm the command line displays the literal `\n` sequence inside the printf format string.
7. Confirm the command is not split into multiple lines at that sequence and does not display `\\n`.
8. Repeat steps 3-7 in dark theme.

#### Expected Results
- Cursor shell command preview parsing keeps `printf '%s\n' "$HOME"` as a single command line.
- The command card preserves the literal newline escape as `\n`, while command output still renders real newlines normally.
- Light and dark theme command rows remain readable.

#### Performance Audit
- The normalization is a constant-time string replacement on the parsed `command`/`cmd` fields from Cursor preview lines.
- Hidden payload parsing remains unchanged and no additional filesystem reads or network requests are introduced.

#### Rollback/Cleanup
- No persistent cleanup is required beyond deleting any temporary test thread if one was created.

### Feature: Composer file mention simple-path ranking

#### Prerequisites
- A project with duplicate matching path names at different depths, such as `SeedKernelBench` plus `.worktrees/.../SeedKernelBench` or `_workspace.tmp/.../SeedKernelBench`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts`.
2. Open the project in light theme.
3. Focus the composer and type `@SeedKernelBench`.
4. Confirm the shallow `SeedKernelBench` directory appears before deeper duplicate matches.
5. Select the shallow result and confirm the composer inserts `./SeedKernelBench`.
6. Repeat steps 2-5 in dark theme.

#### Expected Results
- File mention search still ranks by match quality first.
- When match quality ties, shorter and shallower paths appear before deeply nested paths.
- `SeedKernelBench` appears before `.worktrees/.../SeedKernelBench` and `_workspace.tmp/.../SeedKernelBench`.
- Light and dark theme suggestion rows remain readable.

#### Performance Audit
- Sorting precomputes path segment and length metadata once per candidate, then uses constant-time numeric comparisons.
- The filesystem scan remains the existing single `rg --files` process; no extra I/O, network requests, or candidate fanout are introduced.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Composer file mention shallow-directory fuzzy search

#### Prerequisites
- App server is running from this repository.
- Open a project that has an empty or uninitialized shallow subdirectory such as `repos/opencode`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts src/components/content/composerFileMentions.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the composer in light theme.
4. Type `@repoopecod`.
5. Confirm the suggestion list includes `repos/opencode`.
6. Switch to dark theme and repeat steps 3-5.

#### Expected Results
- Empty shallow directories can be matched by fzf-style path-spanning fuzzy queries.
- `repos/opencode` ranks ahead of weaker file matches such as unrelated `codex` or `opencode-input` files.
- Light and dark theme suggestion rows remain readable.

#### Performance Audit
- The backend only scans direct children of top-level directories for this directory candidate pass.
- The pass skips symlinked top-level directories and excluded names such as `.git` and `node_modules`.
- When a shallow directory match exists, the backend does not wait for the cold fuzzy file-index budget before returning useful results.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Dynamic Codex UI provider config

#### Prerequisites
- App server can run from this repository.
- Light and dark themes are both available from Settings.
- Use a temporary `CODEX_HOME` or back up the existing `config.toml` before editing provider config.

#### Steps
1. Run `pnpm exec vue-tsc --noEmit`.
2. Run `pnpm exec vitest run src/server/codexUiProviders.test.ts src/server/freeMode.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts src/composables/useDesktopState.test.ts src/api/codexGateway.test.ts`.
3. Add a user-level provider config with both `[model_providers.example]` and `[codex_ui.providers.example]`, including `model_catalog_json` and `default_model`.
4. Start the app and open Settings in light theme.
5. Confirm the Provider select shows the configured provider label.
6. Select the configured provider and confirm the model list uses the configured catalog when present.
7. Repeat steps 4-6 in dark theme.
8. Remove `executable` from `[codex_ui.providers.example]` and confirm the backend uses plain `codex` with `model_provider="example"`.
9. Add an executable wrapper command and confirm the backend uses that executable without shell expansion.
10. Add only `[model_providers.example2]` without `codex_ui.providers.example2` and confirm the provider appears and uses plain `codex`.

#### Expected Results
- Custom provider IDs appear in the Provider select without editing frontend source.
- Built-in external providers do not appear unless declared in user `config.toml`.
- `model_catalog_json` drives the UI model list and is injected into Codex startup args.
- `executable` switches runtime launch to the configured command.
- Existing Moon, Ark, and Cursor selections still work when no `codex_ui` override is configured.
- Project-level `.codex/config.toml` cannot introduce an executable launcher.
- Provider controls remain readable in light and dark themes.

#### Performance Audit
- Provider descriptors are read from user `config.toml` only on provider status, model list, and runtime construction paths.
- Catalog reads are local JSON file reads and avoid network calls when valid models are present.
- `/models` fetches are bounded by an 8 second timeout and only used after catalog fallback.

#### Rollback/Cleanup
- Restore the original `config.toml` or remove the temporary `CODEX_HOME`.
- Stop any wrapper process started during manual verification.

### Feature: Missing persisted thread selection fallback

#### Prerequisites
- App server is running from this repository.
- Browser devtools Application or Storage panel is available for editing localStorage.
- At least one local thread exists in the sidebar.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts -t "thread selection persistence"`.
2. In light theme, set `codex-web-local.selected-thread-id.v1` in localStorage to a thread id that does not exist.
3. Reload the app after the full sidebar thread list can load.
4. Confirm the app selects the first available thread and updates `codex-web-local.selected-thread-id.v1` to that thread id.
5. Repeat steps 2-4 in dark theme.
6. For a paginated thread list that has not loaded all pages yet, repeat the reload with a missing stored thread id.

#### Expected Results
- Once all thread pages are loaded, a missing persisted selected thread is replaced by the first available thread.
- While thread pagination is incomplete, the missing persisted selected thread is preserved so an older thread can still be selected when later pages load.
- Sidebar selection remains readable in both light and dark themes.

#### Performance Audit
- The selection fallback only scans the already-loaded flat thread list once during the existing refresh path.
- The change adds no extra thread API calls, filesystem reads, or pagination requests.

#### Rollback/Cleanup
- Restore or remove the edited `codex-web-local.selected-thread-id.v1` localStorage value after manual verification.

### Feature: Cursor CLI first turn no-rollout recovery

#### Prerequisites
- `codex-cursor` is installed or configured through `CODEXUI_CODEX_CURSOR_COMMAND`.
- Cursor CLI provider is available in Settings.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/server/codexAppServerBridge.inlinePayload.test.ts`.
2. Run `pnpm run build:cli`.
3. Open the app in light theme.
4. Switch Provider to `Cursor CLI`.
5. Start a new session from the home composer and send a first message such as `hi`.
6. Confirm the first turn starts instead of showing `RPC turn/start failed with HTTP 502: no rollout found for thread id ...`.
7. Repeat steps 3-6 in dark theme.

#### Expected Results
- New Cursor CLI sessions can send their first message successfully.
- The bridge may attempt a wrapper-runtime `thread/resume`, but a pre-turn `no rollout found` response does not block the immediate `turn/start`.
- Existing non-Cursor providers and existing Cursor sessions continue to route through their selected provider runtimes.
- Light and dark themes have no visual regression because the change is server-side.

#### Performance Audit
- The change adds only a constant-time error-string check on the existing wrapper-provider preflight resume path.
- It does not add network calls, filesystem scans, model-list fetches, or additional app-server processes.

#### Rollback/Cleanup
- Switch Provider back to the preferred runtime after manual verification.

### Feature: Composer mention keyboard auto-scroll

#### Prerequisites
- A project whose `@` path search returns more rows than fit in the mention dropdown.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vue-tsc --noEmit`.
2. Open the project in light theme.
3. Focus the composer and type an `@` query with enough path matches to overflow the dropdown.
4. Press ArrowDown until the active row moves past the visible bottom of the dropdown.
5. Confirm the dropdown scrolls to keep the active row visible.
6. Press ArrowUp until the active row moves past the visible top of the dropdown.
7. Confirm the dropdown scrolls back to keep the active row visible.
8. Repeat steps 2-7 for `$` skill suggestions.
9. Repeat steps 2-8 in dark theme.

#### Expected Results
- ArrowUp and ArrowDown keep the highlighted mention row visible without moving focus out of the composer.
- New `@` and `$` suggestion result sets reset the dropdown scroll position to the top.
- Light and dark theme suggestion rows remain readable while scrolling.

#### Performance Audit
- Keyboard navigation adds one `nextTick` and a single active-row query per ArrowUp or ArrowDown press.
- New suggestion result sets only reset the dropdown `scrollTop`; no extra search request, filesystem scan, or network request is introduced.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Dev server repairs missing direct dependencies

#### Prerequisites
- The repository has a `node_modules` directory that may be incomplete.
- `pnpm`, `corepack`, or `npm` is available on PATH.

#### Steps
1. Run `node -c scripts/dev.cjs`.
2. Run `timeout 8s node scripts/dev.cjs --port 5274`.
3. In a local smoke environment with a deliberately missing direct dependency symlink, run `codex-ui-dev --port 5273`.

#### Expected Results
- The dev wrapper starts Vite when direct dependencies are present.
- If a direct dependency such as `rehype-raw` is missing while `vite` still exists, the wrapper runs `pnpm install` before launching Vite.
- Startup does not fail with `ERR_MODULE_NOT_FOUND` for direct package dependencies imported by Vite config or app code.

#### Performance Audit
- The startup check reads `package.json` once and checks direct dependency package files with bounded `existsSync` calls.
- No recursive filesystem scan is added.

#### Rollback/Cleanup
- Stop the temporary dev server after the smoke check.

### Feature: Composer file mentions for home and absolute paths

#### Prerequisites
- A project is open with cwd `/root/work/my-notebook` or another project outside `/root/work/my-agent-configs`.
- The path `/root/work/my-agent-configs/repos/codexUI` exists on the machine.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/components/content/composerFileMentions.test.ts src/server/composerFileSearch.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts -t "composer file search|composerFileMentions|searchComposerPaths"`.
2. Open the project in light theme, including the launch-path form `~/work/my-notebook` if available.
3. Focus the composer and type bare `@`.
4. Confirm the file mention dropdown opens with path suggestions instead of doing nothing.
5. Type full-width `＠` with a Chinese input method and confirm it also opens file mention state.
6. Type `@~/work/my-agent-configs/repos/codexUI`.
7. Confirm the mention dropdown can resolve the path, select the result, and confirm the inserted mention starts with `@/root/work/my-agent-configs/repos/codexUI` or preserves an equivalent absolute path.
8. Send a short prompt containing that mention.
9. Confirm the generated request includes `codexUI` under `# Files mentioned by the user` and does not rewrite it under the current project cwd.
10. Repeat steps 2-9 in dark theme.

#### Expected Results
- `@/src/...` style project-relative searches still behave as project-relative paths.
- Bare `@` opens the dropdown when the active cwd came from `~/work/my-notebook`.
- Full-width `＠` opens and extracts file mentions the same way as ASCII `@`.
- `@~/...` and `@/root/...` paths resolve to the real filesystem path instead of becoming `<cwd>/~/...` or `<cwd>/root/...`.
- Absolute path suggestions insert as `@` mentions so inline attachment extraction still sees them.
- Light and dark theme suggestion rows remain readable.

#### Performance Audit
- Home and absolute path searches first try exact stat-based resolution, then search only the nearest existing parent directory for partial path completion.
- The change avoids falling back to a full cwd scan for home or absolute queries that do not resolve.
- Home-prefixed cwd normalization is a constant-time string check before the existing filesystem validation.
- Bare `@` empty-query search reads only the current directory's top-level entries, avoiding a full recursive `rg --files` scan of large notebook caches.
- Relative mention searches with top-level prefix matches return from the same top-level listing instead of waiting for a recursive scan.
- Fuzzy relative searches that need the full tree continue to use one `rg --files` scan, cached per cwd for short follow-up queries while the user keeps typing.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Faster fzf-style composer file mention search

#### Prerequisites
- App server is running from this repository.
- The active project contains several files with similar acronym or subsequence matches, for example `ThreadComposer.vue` and `tests/cache.txt`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `./node_modules/.bin/vitest run src/server/composerFileSearch.test.ts src/components/content/composerFileMentions.test.ts`.
2. Run `./node_modules/.bin/vue-tsc --noEmit`.
3. Start a disposable server with `pnpm run dev --host 127.0.0.1 --port 4173`.
4. POST `/codex-api/composer-file-search` with `cwd=/root/work/my-notebook`, `query=sec_string`, and `limit=20`.
5. Confirm the first response item is `_notebooks/byte/sec_string.txt`, not an earlier fuzzy match such as `sec_token_string.txt`.
6. Repeat the POST after the cache is warm and confirm it remains well below the previous second-level response time.
7. Open a thread in light theme and focus the composer.
8. Type `@` and confirm top-level path suggestions appear immediately.
9. Continue typing `sec_string` quickly.
10. Confirm suggestions update from the locally cached result list while typing instead of waiting for a network request after every keypress.
11. Confirm `_notebooks/byte/sec_string.txt` appears ahead of loose deep matches once it is in the cached result list.
12. Type an acronym-style query such as `tc`.
13. Confirm basename acronym matches such as `ThreadComposer.vue` rank ahead of loose path-spanning matches such as `tests/cache.txt`.
14. Select a suggestion and confirm the inserted inline mention still uses the existing `./path` or `@/path` format.
15. Repeat steps 7-14 in dark theme.

#### Expected Results
- File mention suggestions update from the most recent local candidate cache while the user types.
- Backend file search is no longer canceled and restarted for every keystroke.
- The client fetches up to 100 backend candidates, displays the best 20, and locally re-filters that cached candidate set between backend refreshes.
- Backend refreshes happen quickly when there is no reusable cache or no local match, and otherwise wait for an idle pause.
- Bare `@` opens the top-level suggestion list and starts warming one streaming recursive path cache in the background.
- Follow-up keystrokes reuse the same in-progress cache instead of spawning duplicate `rg --files` scans.
- Cold relative searches wait for a literal/exact path match before returning early, so early fuzzy matches cannot outrank a later exact basename hit.
- Fuzzy results prefer fzf-like compact, boundary, and camel-case acronym matches.
- Existing relative, home-prefixed, absolute, directory, file, and symlink suggestion metadata behavior remains unchanged.
- Light and dark theme suggestion rows remain readable.

#### Performance Audit
- Empty-query mention search still returns from one top-level `readdir`, then warms the existing 30-second `rg --files` cache asynchronously for follow-up fuzzy queries.
- Frontend mention filtering is O(cached result count) over at most 100 cached rows, avoiding one backend request per typed character in the common case.
- Backend search requests are coalesced behind one in-flight request; if the query changes while a request is running, the completed result is cached and filtered against the current query before any idle refresh is scheduled.
- Cold relative fuzzy searches start or reuse one streaming cache per cwd, wait only until a matching row appears or the short budget expires, and avoid launching one `rg` process per keystroke.
- Hot literal searches such as `sec_string` run a literal-first pass and skip full fuzzy scoring when enough high-quality substring matches exist.
- Recursive candidate ranking no longer expands ancestors for every path in large repositories; it ranks file paths first, then expands ancestors only for the bounded top file matches.
- On `/root/work/my-notebook` with about 196k indexed paths, cold `sec_string` returned `_notebooks/byte/sec_string.txt` first in about 34ms; `sec` was about 25ms on the same disposable 4173 server.
- Fuzzy scoring is O(path length + query length) per prefiltered candidate and does not add extra filesystem reads.
- Symlink checks still run only for the final returned candidates.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Consecutive tool-call rows group like command rows

#### Prerequisites
- App server is running from this repository.
- A thread is available with two or more consecutive `mcpToolCall`, `collabAgentToolCall`, `webSearch`, or Cursor non-shell tool-call cards.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/components/content/threadConversationGrouping.test.ts src/api/normalizers/v2.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the thread in light theme.
4. Find a turn with consecutive tool-call rows and confirm they render as one compact grouped row.
5. Expand the grouped row and confirm every original tool call appears in order and can still be expanded individually.
6. Confirm a normal assistant/user message between tool calls starts a new group instead of merging across the text.
7. Repeat steps 3-6 in dark theme.

#### Expected Results
- Consecutive tool calls of any supported kind group into one collapsible row, matching consecutive shell command behavior.
- Expanding the group reveals each original tool call in chronological order.
- Group status text uses the latest tool call status and remains readable in light and dark themes.

#### Performance Audit
- Tool-call grouping is computed with one linear pass over the already-normalized message list.
- Hidden grouped tool-call IDs remain stored in a `Set`, keeping per-row visibility checks O(1).
- The change adds no network calls, filesystem reads, or session-log scans.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Current thread conversation search

#### Prerequisites
- App server is running from this repository.
- A thread exists with visible recent messages and older messages that require loading or direct navigation.
- The thread includes at least one unique search term in an older persisted turn.
- A thread can run a prompt long enough to produce live assistant output, or an existing in-progress test thread is available.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/utils/threadMessageSearch.test.ts src/api/codexGateway.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts -t "thread message search|searchThreadMessages"`.
2. Run `pnpm run build:frontend`.
3. Open the target thread in light theme.
4. Click the search icon in the content header.
5. Search for text in a currently visible message.
6. Press Enter and Shift+Enter to move between results.
7. Search for the unique older-message term that is not currently rendered.
8. Confirm the app navigates to the older message without manually pressing "Load earlier messages".
9. Start a turn that streams assistant text, search for text from the live output, and confirm the live result can be selected.
10. Search for text that does not exist.
11. Switch to dark theme and repeat steps 4-10.

#### Expected Results
- The header search control opens only on thread routes and remains independent from sidebar thread filtering.
- Visible-message searches show a count and scroll to the matching message with a short highlight.
- Results are ordered newest-first so the initial selection is the latest matching message in the conversation.
- Older persisted matches are found through backend search and revealed through a bounded turn window.
- Live-only matches are included without duplicating persisted backend results.
- Enter moves to the next result and Shift+Enter moves to the previous result.
- No-result and error states are shown inline in the header search control.
- Light and dark theme search controls, snippets, navigation buttons, and highlighted messages remain readable.

#### Performance Audit
- Typing is debounced before calling `/codex-api/thread-message-search`.
- Backend search scans only the current thread and caps returned results.
- Jumping to older results calls `/codex-api/thread-turn-window` for a bounded window around the target turn instead of walking older pages.
- Conversation rendering remains windowed; reveal expands only enough to include the selected message.

#### Rollback/Cleanup
- Stop any disposable live test turn if it is still running, then close the header search control.

### Feature: Markdown preview code-block copy buttons

#### Prerequisites
- App server is running from this repository.
- A local Markdown file is available with at least one fenced code block.
- Light and dark color schemes are available from the operating system or browser.

#### Steps
1. Run `pnpm exec vitest run src/server/localBrowseUi.test.ts -t "markdown preview HTML"`.
2. Open the Markdown file through the local edit route.
3. Click `Preview`.
4. In light theme, hover a fenced code block and click the copy button in its top-right corner.
5. Paste into a scratch field and confirm the copied text matches only the code block content.
6. Confirm the copy button changes to the copied state briefly and then returns to `Copy code`.
7. Switch to dark theme, reload or reopen preview, and repeat steps 4-6.
8. Open the standalone `/codex-local-preview/<path>` route for the same file and repeat one copy check.

#### Expected Results
- Each rendered code block in local Markdown preview has one top-right copy button.
- Clicking the button copies the code text without the language header or surrounding Markdown.
- The button remains readable and the copied state is visible in light and dark themes.
- Existing preview interactions still work: image browse links open, annotation/highlight clicks still show their controls, and double-clicking non-interactive preview content still jumps to the editor line.

#### Performance Audit
- Copy buttons are inserted with one bounded string replacement pass over the already-rendered preview HTML.
- The click handler uses event delegation on the preview document, so rendering many code blocks does not add per-block listeners.
- Clipboard work runs only after a user click and adds no network, filesystem, or preview refresh work.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Composer file mention directory-prefix expansion

#### Prerequisites
- App server is running from this repository.
- Open a project that has a top-level `.cookies/` directory containing at least one file, such as `.cookies/cloud.bytedance.net.json`.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts src/components/content/composerFileMentions.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the composer in light theme.
4. Type `@.cookie`.
5. Confirm the suggestion list shows both `.cookies` and `.cookies/cloud.bytedance.net.json`.
6. Switch to dark theme and repeat steps 4-5.

#### Expected Results
- A top-level directory prefix match remains visible as the first suggestion.
- Direct children of that matched directory are also visible, so users can select a file inside the directory without typing the full directory path.
- Existing basename-first ranking for deep file matches remains unchanged.
- Light and dark theme suggestion rows remain readable.

#### Performance Audit
- Prefix expansion is limited to direct children of already-matched top-level directories.
- The change does not start a full recursive `rg --files` scan when a top-level prefix match is enough.
- Expansion stops at the backend result limit and skips `.git` and `node_modules` directory names.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Composer file mention empty shallow directory match

#### Prerequisites
- App server is running from this repository.
- Working directory has at least one empty second-level directory whose name is
  itself the query (for example an uninitialized `repos/opencode` submodule).

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts src/components/content/composerFileMentions.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the composer.
4. Type `@opencode`.
5. Confirm the suggestion list contains `repos/opencode` near the top.
6. Type `@repoopecod` and confirm `repos/opencode` is still the first suggestion.

#### Expected Results
- Empty second-level directories that would be invisible to `rg --files`
  still appear in `@` mention suggestions when their name fuzzy-matches the query.
- Ranking against file-based candidates prefers exact directory basename matches.

#### Performance Audit
- Second-level directory candidates are computed once per cwd and cached with
  the same TTL as the ripgrep path index.
- The expansion is bounded by `COMPOSER_SHALLOW_DIRECTORY_CANDIDATE_LIMIT` and
  skips `.git` and `node_modules` names.
- No additional recursive scanning is performed per query.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Composer file mention fzf-backed ranking

#### Prerequisites
- The system `fzf` binary is on `PATH`, or `CODEXUI_FZF_COMMAND` points at one.
- App server is running from this repository.

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts src/components/content/composerFileMentions.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the composer and type queries such as `@opencode`, `@repoopecod`, `@sec_string`, `@.cookie`, `@tc`, `@KernelBench`.
4. Compare the ordering with `printf ... | fzf --filter=<query> --scheme=path --tiebreak=length,index` on the same candidate list.

#### Expected Results
- The composer suggestion order matches `fzf` (basename hits first, compact matches ranked above sparser ones).
- Empty second-level directories such as `repos/opencode` still appear.
- When `fzf` is missing, the previous heuristic keeps working as a fallback.

#### Performance Audit
- Candidate pool = top-level entries + cached shallow directories + cached `rg --files` paths.
- Ranking is delegated to a single `fzf --filter` process per query rather than to per-candidate JS scoring.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Composer file mention warm start

#### Prerequisites
- App server is running from this repository.
- The composer receives a valid `cwd` prop when a thread is opened.

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts src/components/content/composerFileMentions.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open a fresh session and, before typing anything, wait a few seconds.
4. Type `@codexui` and observe the mention suggestion latency.

#### Expected Results
- The `composerFileMentions` module chunk is fetched during the composer mount, so the first `@` keystroke does not have to wait for it.
- The backend `composer-file-search` cache for the current `cwd` is warm, so the first query returns quickly (comparable to the hot p50, around 30-40ms locally).
- Behavior with unset `cwd` or with unreachable servers is unchanged; warmup errors are swallowed.

#### Performance Audit
- Warmup uses one best-effort backend call per `cwd` change and one dynamic module import; no polling.
- No new caches, only the existing 30s server-side path cache is being primed.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: Lazy full-history loading on session switch

#### Prerequisites
- App server is running from this repository (`pnpm run dev --host 127.0.0.1 --port 4173`).
- At least two threads with many historical turns (e.g. 50+ user messages each), one of which has `hasMoreOlder === true` (older turns beyond the initial `thread/read` page).

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open thread A (large history) in the browser, then switch to thread B (large history) and back to A repeatedly.
4. While viewing a large thread, click the user-message navigation toggle (the badge above the message list) to open the dropdown.
5. Repeat steps 3-4 in both light and dark theme.

#### Expected Results
- Switching between large threads is noticeably faster and no longer blocks the UI while the complete message history is parsed. The main thread is not stalled by a large `thread-message-history` JSON parse + normalization on every switch.
- The user-message navigation badge shows the authoritative total count immediately (warmed from the lightweight `thread-user-message-count` endpoint), even before the full history is loaded.
- Opening the navigation dropdown triggers the full-history load on demand (`ensureFullHistoryLoaded`), so the list eventually populates with every user message, not just the most recent `thread/read` page.
- Scrolling up in the main view still loads older turns via the paged `thread-turn-page` endpoint; jumping to a specific message via `ensureMessageLoaded` still loads full history on demand.
- Light theme and dark theme render the dropdown and badge identically (no theme-specific surface issues).

#### Performance Audit
- Before: `loadMessages` fired `void loadFullHistoryMessages(threadId)` on every thread switch whenever `detail.hasMoreOlder === true`, synchronously blocking the main thread with a large JSON parse (`thread-message-history`) plus `normalizeThreadMessagesV2` over the entire history, even when the message navigation dropdown was never opened.
- After: `loadMessages` only sets `fullHistoryMessages` when there is no older history (`hasMoreOlder !== true`); full history loads lazily when the dropdown opens via the restored `:ensure-full-history-loaded="loadFullHistoryMessages"` binding. The lightweight `thread-user-message-count` endpoint (session-file scan with size/mtime cache) supplies the badge total without pulling the full payload.
- No profiling run was executed in this session because no large real thread was available; the optimization is grounded in code-path analysis of the removed eager fetch + parse. Next measurement: run `PROFILE_ROUTE='#/thread/<large-thread-id>' pnpm run profile:browser` before/after to confirm the `thread-message-history` request and its parse cost no longer appear on the switch path.

#### Rollback/Cleanup
- No persistent cleanup is required. Reverting the `loadMessages` change restores the eager full-history load; reverting the `App.vue` binding removal restores the dropdown on-demand load.

### Feature: Non-blocking session switch

#### Prerequisites
- App server is running from this repository.
- Two threads whose message history has not yet been loaded in this browser tab (e.g. large sessions freshly opened after a hard refresh).

#### Steps
1. Run `pnpm exec vitest run src/composables/useDesktopState.test.ts`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Hard-refresh the app, then in the sidebar click thread A.
4. Before A's spinner disappears, immediately click thread B.
5. Click back to A while B is still fetching.
6. Repeat steps 3-5 in both light and dark theme.

#### Expected Results
- Clicking B while A is still loading switches the main conversation pane to B immediately; the sidebar highlight, header, composer, and message list stop showing A's state.
- If B was previously loaded (cache hit), B's messages render on the first frame with no spinner.
- If B was never loaded (cache miss), B shows its own `Loading messages...` state; A's spinner does not linger over B's content.
- Clicking back to A while B is still loading swaps the pane to A instantly; both fetches finish in the background and each writes only into its own thread's cache (`persistedMessagesByThreadId[threadId]`).
- Light theme and dark theme render identical layouts in both loading and loaded states.

#### Performance Audit
- Before: `syncThreadSelectionWithRoute` did `await selectThread(threadId)` which itself did `await Promise.all([loadMessages, processQueuedMessages])`, followed by `await applySelectedProviderState()`. A second click while the first `loadMessages` was in flight only set `hasPendingRouteSync = true` and had to wait for the entire chain to resolve, blocking the visible switch on network latency.
- After: `selectThread` fires `loadMessages`, `processQueuedMessages`, and `refreshSkills` as background work and returns immediately after `setSelectedThreadId`. `syncThreadSelectionWithRoute` no longer awaits `applySelectedProviderState`. `isLoadingMessages` becomes a per-thread computed backed by `loadingMessagesByThreadId`, so the spinner is scoped to whichever thread is currently loading rather than to the last click. Existing per-thread caches (`persistedMessagesByThreadId`, `fullHistoryMessagesByThreadId`, `loadedMessagesByThreadId`) already deduplicate concurrent fetches via `loadMessagePromiseByThreadId`, so late writes cannot corrupt whichever thread the user has since switched to.
- No profiling run was executed in this session because reproducing the interactive stall requires two large uncached sessions and human clicks. The optimization is grounded in code-path analysis of the removed `await` chain in `syncThreadSelectionWithRoute`. Next measurement: capture a DevTools performance trace of switching A→B→A on a fresh tab and confirm there are no long tasks blocking the pointer/click handler between the two clicks.

#### Rollback/Cleanup
- No persistent cleanup is required. Reverting the change makes `selectThread` await `loadMessages` again, restoring the previous serialized behavior.

### Feature: Tighter eager turn window with lazy backfill

#### Prerequisites
- App server is running from this repository.
- A thread with 10+ turns worth of history so the backfill path is exercised.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Hard-refresh the app, open a large thread, and confirm only ~3 latest turns render initially. Scroll up briefly and confirm the surrounding turns fill in without a spinner (background backfill has already extended the window to ~7 turns).
4. Open the user-message navigation dropdown and jump to a mid-thread user message. Confirm the surrounding turns render without pulling the full history payload.
5. Scroll to the top of the conversation and confirm the "load earlier" pagination still works (10 turns per page).
6. Repeat steps 3-4 in both light and dark theme.

#### Expected Results
- Initial thread render only materializes 3 turns (eager window). The main pane is quicker to become interactive on large threads.
- Within a few hundred milliseconds after render, up to 4 additional older turns arrive via `/codex-api/thread-turn-page` and merge into the persisted list, extending the visible window to 7 turns silently (no spinner).
- Jumping to a mid-thread user message pulls a 3-before/3-after window via `/codex-api/thread-turn-window` and merges it into the persisted list. The full history is only fetched when the user opens the navigation dropdown for the total count, and it no longer floods the main pane.
- Manual "load earlier" (scroll to top) still requests 10 turns per page.
- Light and dark theme render both loading and loaded states identically.

#### Performance Audit
- Server side: `THREAD_RESPONSE_TURN_LIMIT` dropped from 10 to 3. This trims every `thread/read`, `thread/resume`, `thread/fork`, and `thread/rollback` response to the last 3 turns before it hits the wire.
- Client side: after `loadMessages` persists the eager window it fires `backfillOlderTurnsInBackground(threadId)`, which uses the existing `/thread-turn-page` endpoint to fetch just enough older turns to reach 7 distinct turns in `persistedMessagesByThreadId[threadId]`. The backfill is guarded by `backgroundOlderBackfillByThreadId` to prevent duplicate work and cancels itself when `hasMoreOlder === false`.
- User-message navigation jumps prefer `loadThreadMessageWindow(threadId, turnId)` (before=3, after=3) over the previous "merge full history into persisted" path. The full-history fetch remains restricted to the dropdown open action so the badge total can be shown.
- Manual `loadOlderMessages` still asks the gateway for the default 10-turn page since users triggering scroll-up expect a bigger jump.
- No profiling run was executed in this session because a large real thread is needed to observe the payload delta. Next measurement: capture a network waterfall on a fresh switch to a 100-turn thread and confirm `thread/read` returns ~3 turns while `thread-turn-page` fires once with `limit=4` in the background.

#### Rollback/Cleanup
- Revert `THREAD_RESPONSE_TURN_LIMIT` back to 10 and drop `backfillOlderTurnsInBackground`, `loadThreadTurnWindow` prop, plus the `turnId` field on `UserMessageNavigationItem` to restore the previous behavior.

### Feature: Thread cache keep-warm and cached-first render

#### Prerequisites
- App server is running from this repository.
- Several threads are available in the sidebar; at least one has enough turns that a fresh load is visibly slower than a cached one.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open thread A, wait for it to load, then switch to thread B and back to A. Confirm the switch back to A shows the messages immediately without a loading spinner.
4. Load enough threads (or scroll / filter the sidebar) so that thread A pages out of `projectGroups` (e.g. use workspace root filtering to hide its project). Trigger a sidebar refresh (`Cmd/Ctrl+R` or via the refresh button) so `pruneThreadScopedState` runs.
5. Re-select thread A from any navigation entry point (URL, breadcrumb, or after re-adding its workspace root). Confirm the persisted messages are still there instantly, without hitting `thread/read` synchronously.
6. Switch the active provider (e.g. `codex` → moon) so `invalidateAppServerRuntimeState` runs. Re-open a previously visited thread. Confirm the messages appear immediately and a `thread/resume` fires silently in the background (Network tab shows no blocking wait).
7. Reload the tab, then re-open a thread that was in the LRU list before the reload. Confirm the LRU list itself was restored from `localStorage` (`codex-web-local.recently-visited-thread-ids.v1`), though the messages will need to be fetched once because in-memory caches do not persist.
8. Repeat step 3 in both light and dark theme.

#### Expected Results
- Repeated switches between recently visited threads render messages synchronously — `isLoadingMessages` stays `false` and no spinner appears.
- Threads that were paged out of the sidebar retain their persisted messages when they had been visited recently, up to `RECENT_THREAD_LRU_LIMIT` (30 threads).
- After provider switches or other resume-invalidation events, cached messages remain visible; the background `thread/resume` + `thread/read` refresh reconciles quietly.
- The recently-visited thread list is persisted across page reloads via `localStorage`; visiting the same thread multiple times moves it back to the front instead of appending duplicates.
- Light and dark theme render identically.

#### Performance Audit
- `setSelectedThreadId` now calls `recordRecentlyVisitedThreadId`, which maintains a de-duplicated LRU array of up to 30 entries and persists it to `codex-web-local.recently-visited-thread-ids.v1`. The write happens only on selection changes.
- `pruneThreadScopedState` merges `recentlyVisitedThreadIds.value` into `activeThreadIds` before filtering the per-thread maps. This adds an O(N=30) union but avoids the O(K) rebuild of persisted/loaded/turn/live caches that used to trigger a full reload on subsequent visits.
- `loadMessages` accepts a new `preferCached` option. When cached messages exist, are not force-reloaded, and no turn is in progress, it returns synchronously after `markThreadAsRead` and fires a silent `loadMessages(..., { silent: true })` in the background. The background call goes through the normal path (respecting the `loadMessagePromiseByThreadId` guard) so `thread/resume` + `thread/read` still reconcile server state without blocking the caller.
- `selectThread` opts into `preferCached`, so user-driven session switches no longer pay for a `thread/resume` round-trip when the messages are already in memory. Programmatic callers (`forkThreadById`, `refreshDesktopState`, `ensureThreadMessagesLoaded`, silent refreshes) keep the previous behavior because they omit the flag.
- No profiling run was executed in this session because the LRU + preferCached gains are only visible on repeated switches to threads that had been paged out or invalidated. Next measurement: sample `performance.now()` around `selectThread` on a large thread before/after provider switch and confirm the synchronous path (~<5ms) stays flat while the background resume still fires.

#### Rollback/Cleanup
- Remove `recordRecentlyVisitedThreadId`, the `recentlyVisitedThreadIds` ref, the LRU load/save helpers, and drop the LRU union from `pruneThreadScopedState`.
- Drop the `preferCached` branch in `loadMessages` and revert `selectThread` to pass no options.
- Delete `RECENT_THREAD_LRU_STORAGE_KEY` and `RECENT_THREAD_LRU_LIMIT` constants.

## 本地文件编辑器 Git Diff

### 前置条件

- 使用一个已有 Git 历史的项目目录打开本地文件浏览器。
- 选择一个文本文件，并准备至少一个历史提交；可额外创建 staged 与 unstaged 修改。

### 操作步骤

1. 在本地文件浏览器中打开该文本文件，进入文件编辑器。
2. 点击工具栏的 **Git diff**。
3. 确认默认比较为 `Staged (index)` 到 `Unstaged (working tree)`，并检查补丁中的新增与删除行。
4. 确认 Diff 替换编辑器主体为两个独立只读版本编辑器：左侧 **From**、右侧 **To**。两侧各自显示所选版本的完整文件内容（而非合并补丁）；Markdown 文件打开 Diff 时，确认 Markdown 预览自动关闭。
5. 在任一版本编辑器中选中一行或多行，点击 Diff 工具栏的 **Copy ref**，确认剪贴板得到与编辑器一致的 `${文件绝对路径}:${行号}` 或 `${文件绝对路径}:${起始行}-${结束行}`。
7. 关闭 Diff 后，在编辑器内选择跨多行文本，点击编辑器工具栏的 **Copy ref**，确认复制同样的起止行范围。
8. 点击 **Wrap lines** 切换换行模式：关闭时，编辑器与 Diff 长文本均可水平滚动；开启时，两者均自动换行。刷新后确认选择状态按文件保留。
9. 拖动编辑器与 Diff 之间的分隔条，确认分栏大小调整正常；在手机/窄屏下确认其变为上下布局。
10. 分别在 **From** 与 **To** 下拉框中选择 `Unstaged (working tree)`、`Staged (index)` 及任一带提交短 SHA 的历史版本。
11. 验证每次变更选择后，差异内容更新，并点击 **Close** 回到仅编辑器视图。
12. 将系统切换为浅色主题，重复步骤 2–11，检查新增行与删除行的可读性。
13. 将系统切换为深色主题，重复步骤 2–11，检查差异面板、下拉框和新增/删除行均使用深色配色且清晰可读。
14. 在非 Git 目录打开一个文本文件并点击 **Git diff**，确认显示“not inside a Git repository”提示且编辑器仍可正常使用。
15. 通过 `pnpm run dev` 启动开发服务器后重复步骤 2，确认 Git diff 正常加载；若服务端版本不匹配，显示重启 CodexUI 的可操作提示，而非浏览器的 `JSON.parse` 异常。

### 预期结果

- 可比较同一文件的工作区（unstaged）、暂存区（staged）及最近 30 个历史提交版本。
- 版本差异仅供查看，不会改写工作区、暂存区或 Git 历史。
- 没有差异时显示明确的无差异提示；超过 2 MB 的版本会显示安全限制提示。

### 清理 / 回滚

- 关闭差异面板即可继续编辑；功能本身不会创建 Git 改动。
- 如为手动测试创建了 staged 或 unstaged 修改，可按项目惯例执行 `git restore` 或 `git restore --staged` 清理。

### 回归：Git Diff 初始化

- 编辑器初始化必须先建立 `lineWrapEnabled` 等状态，再调用 Ace 的 `setUseWrapMode`；否则 JavaScript 的 temporal dead zone 会中断整个内联脚本，导致包括 **Git diff** 在内的全部工具栏事件没有绑定。
- 已在 `http://localhost:5373/codex-local-edit/root/work/my-notebook/_notebooks/byte/inbox/aiter-rmsnorm-dual-smoothquant-mr.md` 实测：点击 **Git diff** 后右侧分栏显示，接口渲染 158 行，浏览器控制台无错误。

### Git Diff 视觉高亮

- 两个只读版本编辑器保留完整文件内容，但用红色标记 **From** 侧被删除/替换的行、绿色标记 **To** 侧被新增/替换的行，并在 gutter 显示同色边条。
- 对发生变更的 hunk 滚动到对应区域，确认可见行具有底色高亮；对于很长的文件，Ace 只渲染可见行，滚动到变化区域后标记会出现。

### Git Diff 垂直滚动同步

- 在任一版本编辑器滚动，另一侧应按相同的垂直像素位置跟随；使用防回环保护，避免滚动事件相互触发。
- 两侧的横向滚动保持独立，便于查看行宽不同的版本内容。

### Git Diff 中编辑 Unstaged

- 将任一版本下拉框选择为 `Unstaged (working tree)`；该侧标题应显示 `(editable)`，另一个 staged 或历史版本编辑器保持只读。
- 修改工作区侧内容后，使用 `Ctrl/Cmd+S` 或工具栏 **Save** 保存。确认文件被写回工作区、两个版本编辑器重新加载，且行级红/绿高亮随最新 Diff 更新。
- 选中非 `Unstaged` 的版本后触发保存，确认不会改写 Git 历史或暂存区，并提示只能保存工作区版本。

### Git Diff 对齐空泡

- 删除行的对面（右侧）应显示斜线纹理空泡占位，新增行的对面（左侧）同样显示空泡。
- 两侧行数相同，垂直滚动同步，改动行红/绿高亮，上下文行对齐。
- 在 Unstaged 侧编辑后保存，空泡行被正确剥离，文件内容不含多余空行，尾换行保留。

### Feature: Sticky bottom scroll while the agent streams

#### Prerequisites
- App server is running from this repository.
- A thread where Codex can run a multi-step turn that streams assistant text, runs commands, and keeps producing output for several seconds.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Send a prompt that keeps the agent working for a while (e.g. a multi-file refactor or a long shell pipeline).
4. While the turn is streaming, scroll all the way down to the bottom of the conversation. Confirm the view stays pinned to the latest output (live overlay + streamed text) instead of snapping back to the top of the in-progress turn.
5. Scroll up a little to read earlier output, then scroll back down to the bottom. Confirm auto-follow re-engages and the view catches up to the latest message.
6. While still streaming, click the "jump to latest" button (arrow button in the lower-right). Confirm it lands on the live overlay at the very bottom, with no "Load later messages" button and no empty command-only gap.
7. Let the turn finish. Confirm the final persisted messages remain visible at the bottom without a jump.
8. Repeat steps 3-7 in both light and dark theme.

#### Expected Results
- While streaming, scrolling to the bottom keeps the view pinned to the newest output; it no longer snaps back to the top of the in-progress turn.
- The live overlay (activity label / reasoning / streamed assistant text) stays visible while pinned to the bottom, because `isRenderingLatest` stays `true`.
- The "jump to latest" button lands on the live overlay at the very bottom; the spurious "Load later messages" button no longer appears mid-stream, and there is no empty command-only segment with both "Load earlier" and "Load later" buttons.
- Scrolling up disables auto-follow (jump-to-latest button appears); scrolling back to the bottom re-engages it.
- Light and dark theme render identically.

#### Performance Audit
- Root cause: `onConversationScroll` used `autoFollowOutput = isRenderingLatest && isAtBottom`. While the agent streams, `props.messages` grows every frame but `renderWindowEnd` is reconciled asynchronously by the `watch(() => props.messages)` handler, so `isRenderingLatest` (`renderWindowEnd >= messages.length`) was transiently `false`. A scroll event during that gap flipped `autoFollowOutput` off; the watcher then ran `clampRenderWindowToMessages` (clamp only, no advance), freezing the window below the latest messages. That surfaced `hasMoreBelow` ("Load later messages"), hid the live overlay (`v-if="isRenderingLatest && liveOverlay"`), and made `jumpToLatest` re-fail because the same race re-disabled auto-follow on the next scroll.
- Fix: `onConversationScroll` now calls `resolveAutoFollowAfterScroll(currentAutoFollow, atBottom, isRenderingLatest)` (pure helper in `src/components/content/threadConversationScroll.ts`). Auto-follow is only disabled when the user has genuinely scrolled away from the bottom (`!atBottom`). When at the bottom but the window is transiently behind (`isRenderingLatest` false), the previous value is kept so the watcher can catch up; once it does, `isRenderingLatest` flips true and the next scroll re-affirms auto-follow.
- No new per-frame work is added: the helper runs only inside the existing scroll handler. `scheduleBottomLock` and the `watch(() => props.liveOverlay)` bottom-lock续命 logic are unchanged and now reliably keep the view pinned because auto-follow no longer gets toggled off mid-stream.
- No profiling run was executed in this session because the regression is a scroll/event-timing race rather than a throughput issue. Next measurement: during a long streaming turn, log `autoFollowOutput` and `isRenderingLatest` on each scroll event and confirm `autoFollowOutput` never flips to `false` while `isAtBottom` is `true`.

#### Rollback/Cleanup
- Revert `onConversationScroll` to `autoFollowOutput.value = isRenderingLatest.value && isAtBottom(container)` and delete `src/components/content/threadConversationScroll.ts` plus its test file.

### Feature: Render window covers the whole latest turn

#### Prerequisites
- App server is running from this repository.
- A thread where a single turn runs many commands (100+) so the turn spans more messages than the previous fixed render window (50, capped at 110). Example session: `019f3351-b08d-7850-8843-30a1d358cba1` (turns with 200+ `function_call` items).
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Start a turn that streams assistant text and then runs a long sequence of commands (a multi-file refactor or a long shell pipeline works well).
4. While the turn is streaming, scroll to the bottom. Confirm the streaming text and the latest command output are visible together, and the view stays pinned to the newest output instead of snapping back to the top of the turn.
5. Click the "jump to latest" button while streaming. Confirm it lands on the live overlay at the very bottom, with the assistant text still visible above the command list and no empty command-only gap. There should be no "Load later messages" button (the window already reaches the latest message).
6. Scroll up to read the assistant text, then scroll back down to the bottom. Confirm the latest command output comes back into view together with the text, instead of the text being sliced off when the commands appear.
7. Click "Load earlier messages" while near the bottom of a large streaming turn. Confirm earlier messages load above without slicing the streaming text / latest command off the bottom.
8. Let the turn finish. Confirm the just-completed turn's text and commands remain visible together at the bottom (the window still covers the latest turn), then scroll up into older history and back.
9. Repeat steps 3-8 in both light and dark theme.

#### Expected Results
- While streaming, the render window covers the entire latest turn (plus a small context buffer of `RENDER_WINDOW_SIZE` messages before it), so the assistant text and the latest command output are on screen at the same time. The view no longer snaps back to the turn top when scrolling to the bottom.
- The "jump to latest" button lands on the live overlay at the very bottom; the spurious "Load later messages" button no longer appears, and there is no empty command-only segment with both "Load earlier" and "Load later" buttons.
- Scrolling the assistant text down to the following commands no longer slices the text out of the window; both stay visible because they are inside the same latest-turn window.
- "Load earlier messages" grows the window upward without shrinking the end past the latest turn, so streaming output is not sliced off while paging up.
- After the turn completes, the latest turn stays covered (text + commands together); older history remains virtualized behind "Load earlier messages".
- Light and dark theme render identically.

#### Performance Audit
- Root cause: `RENDER_WINDOW_SIZE = 50` / `MAX_RENDER_WINDOW_SIZE = 110` sliced `props.messages` by raw message count. A single turn can emit hundreds of command messages (each `commandExecution` is its own `UiMessage`); the example session has turns with 200+ `function_call` items. The fixed window therefore sliced the turn in half: the assistant text and the latest command were always more than 110 messages apart and could never be on screen together. While streaming, `setRenderWindowToLatest` re-anchored the window to the last 50 messages (all commands) every frame, so scrolling to the bottom showed only commands and "Load earlier" paginated through more commands without ever reaching the text.
- Fix: `latestTurnStartIndex` (computed) finds the first message of the latest turn by scanning backward from the tail until the `turnId` changes (every persisted and live message carries a `turnId`). `setRenderWindowToLatest` now calls `resolveLatestRenderWindow(messageCount, latestTurnStartIndex, RENDER_WINDOW_SIZE)` (pure helper in `src/components/content/threadConversationScroll.ts`): when a latest turn is known, the window starts `RENDER_WINDOW_SIZE` messages before the turn and ends at the very last message, so the whole turn stays in view. When no `turnId` is available it falls back to the previous trailing-50 behavior.
- `loadMoreAbove` widens its size cap by the latest turn size (`MAX_RENDER_WINDOW_SIZE + latestTurnSize`) so paging upward never shrinks the end past the latest turn and slices off streaming output. `clampRenderWindowToMessages` (used when auto-follow is off, e.g. the user is reading history) is unchanged, so reading older history while the agent streams still keeps the view stable.
- Rendering cost: commands are grouped/collapsed in the view (`groupedCommandsByLatestId` / `hiddenGroupedCommandIds`), so a turn with hundreds of commands produces only a handful of DOM nodes. `visibleMessages` and the grouping computables are O(turn size) per `props.messages` change, which is acceptable for turns up to a few thousand messages.
- No profiling run was executed in this session because the regression is a window-slicing correctness issue, not a throughput issue. Next measurement: on the example session, log `latestTurnStartIndex`, `renderWindowStart`, `renderWindowEnd`, and `props.messages.length` during a streaming turn and confirm the window spans `[latestTurnStart - 50, messages.length]` and that `hasMoreBelow` stays `false` while pinned to the bottom.

#### Rollback/Cleanup
- Revert `setRenderWindowToLatest` to `setRenderWindow(Math.max(0, messageCount - RENDER_WINDOW_SIZE), messageCount)`, revert the `loadMoreAbove` cap to `MAX_RENDER_WINDOW_SIZE`, delete the `latestTurnStartIndex` computed, and drop `resolveLatestRenderWindow` from `src/components/content/threadConversationScroll.ts` and its tests.

### Feature: Render window only expands during in-progress turns

#### Prerequisites
- App server is running from this repository.
- A thread whose latest completed turn ran many commands (100+) so the turn spans more messages than the fixed render window (50).

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Run a turn that emits 100+ commands, then let it finish.
4. Switch away to another session and back to the finished session. Confirm the latest messages (this round's user + assistant messages) appear promptly, without the brief freeze that rendering the whole large completed turn would cause.
5. Start another long streaming turn on the same session and confirm the in-progress behavior from "Render window covers the whole latest turn" still applies (text + latest command visible together while streaming).
6. Repeat in both light and dark theme.

#### Expected Results
- Re-entering a finished session renders only the fixed trailing window (~50 messages) so it is as fast as before the turn-expansion change; there is no freeze while collapsed command messages for a large completed turn are materialized.
- While a turn is in progress, the window still expands to cover the whole latest turn (text + latest command together), preserving the streaming fix.
- Light and dark theme render identically.

#### Performance Audit
- Regression cause: `latestTurnStartIndex` (added in "Render window covers the whole latest turn") returned the latest turn start unconditionally, so `setRenderWindowToLatest` covered the whole latest turn even after it completed. Re-entering a finished session whose latest turn had 200+ command messages had to slice/group/render all of them up front, causing a brief freeze that did not happen with the previous fixed 50-message window.
- Fix: `ThreadConversation` now receives an `isThreadInProgress` prop (App.vue passes `isSelectedThreadInProgress`, which is backed by `inProgressById`). `latestTurnStartIndex` returns -1 unless `isThreadInProgress` is true, so the expansion to cover the whole turn only happens while the turn is actively running. `loadMoreAbove`'s `latestTurnSize` therefore collapses to 0 for finished turns and the cap reverts to `MAX_RENDER_WINDOW_SIZE`.
- `inProgressById` is the same signal that drives `selectedLiveOverlay`, so it stays stable across command boundaries within a turn (no window flicker between commands) and flips off exactly when the turn completes.
- No profiling run was executed in this session. Next measurement: time `setRenderWindowToLatest` on re-entry to a finished 200+ command turn and confirm it is back to the pre-expansion cost (a single 50-message slice).

#### Rollback/Cleanup
- Drop the `isThreadInProgress` prop from `ThreadConversation`, remove the `:is-thread-in-progress` binding in `App.vue`, and revert the `if (props.isThreadInProgress !== true) return -1` guard in `latestTurnStartIndex` to restore unconditional turn expansion.

### Feature: Optimistic user message on send

#### Prerequisites
- App server is running from this repository.
- An existing thread the user can send prompts to.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. In an existing thread, send a prompt. Confirm the user's message appears in the conversation immediately, before the agent starts replying (no waiting on the app-server round-trip).
4. Send a prompt while a turn is already in progress (steer). Confirm the steered user message also appears immediately.
5. Simulate a send failure (e.g. stop the app server or break the connection, then send a prompt). Confirm the user's message still appears, alongside the error state, so the user can see what they sent and retry.
6. After a successful send, once the agent's reply streams in and the persisted messages refresh, confirm the optimistic message is replaced by the real persisted user message (no duplicate user bubble).
7. Repeat in both light and dark theme.

#### Expected Results
- The sent prompt renders instantly as a user message (with a temporary `optimistic-user-*` id) without waiting for `thread/turn/start` + `syncFromNotifications` to round-trip.
- A steer prompt also renders instantly while a turn is in progress.
- If `startThreadTurn` / `steerThreadTurn` fails, the optimistic user message remains visible so the user can see what they sent; it is not lost.
- Once `loadMessages` refreshes and the persisted messages contain a matching user message (same normalized text), the optimistic placeholder is dropped and only the real persisted user message remains (no duplicate).
- Light and dark theme render identically.

#### Performance Audit
- Root cause: `startTurnForThread` / `steerActiveTurnForThread` only revealed the user message after `startThreadTurn`/`steerThreadTurn` succeeded and `syncFromNotifications` re-read the thread. So the user bubble was gated on a full app-server round-trip, and if the round-trip errored (e.g. connection error) the message never appeared at all. (The delay was additionally amplified when a `preferCached` background `loadMessages` was still in flight, because `syncFromNotifications`'s `loadMessages` would `await` the existing load promise and return without refreshing.)
- Fix: `sendMessageToThread` now calls `setOptimisticUserMessage(threadId, text, imageUrls, fileAttachments)` on both the steer and the new-turn paths before kicking off the RPC. The optimistic message lives in `optimisticUserMessageByThreadId` and is injected by the `messages` computed right after the persisted messages (and before the live overlay messages) **only when** the persisted messages do not already contain a matching user message (matched by normalized text). `loadMessages` calls `clearOptimisticUserMessageIfPersisted` after it persists fresh messages, so once the real user message arrives the placeholder is removed. On RPC failure the placeholder is intentionally left in place.
- Cost: one extra `Record<string, UiMessage>` ref and an O(persisted) text match inside the `messages` computed only while an optimistic message exists for the selected thread. No extra network calls.
- No profiling run was executed in this session; the change is a latency/correctness fix, not a throughput change. Next measurement: instrument the time between the send click and the first render of the user bubble and confirm it is now ~0ms (synchronous) instead of the previous round-trip latency.

#### Rollback/Cleanup
- Remove `setOptimisticUserMessage` / `clearOptimisticUserMessage` / `clearOptimisticUserMessageIfPersisted`, the `optimisticUserMessageByThreadId` ref, its injection in the `messages` computed, the two `setOptimisticUserMessage` calls in `sendMessageToThread`, the `clearOptimisticUserMessageIfPersisted` call in `loadMessages`, and the prune/reset lines.

### Feature: Composer file mention full-index fzf ranking

#### Prerequisites
- System `fzf` is available.
- Project cwd can be large (for example a notebook workspace with symlinked caches).

#### Steps
1. Run `pnpm exec vitest run src/server/composerFileSearch.test.ts`.
2. Open a large project and type a compact fuzzy query such as `@w4a4de`.
3. Confirm the first hits match `rg --files | fzf --filter=w4a4de --scheme=path`.

#### Expected Results
- Search waits for the full path index before ranking, instead of ranking a partial early scan.
- Real compact basename matches are not buried under deep sparse subsequence noise.
- Candidate pool is top-level entries + shallow directories + file paths, without exploding every ancestor directory into the pool.

#### Performance Audit
- Cold search cost is roughly one full `rg --files` plus one `fzf --filter` over the path list.
- Path cache TTL is 5 minutes; warm searches reuse the index.

#### Rollback/Cleanup
- No persistent cleanup is required.

### Feature: File mention search shows the final query without flashing stale results

#### Prerequisites
- App server is running from this repository.
- The workspace has nested directories that fuzzy-match a prefix of a deeper path, e.g. `_notebooks/byte/` and `_notebooks/byte/cradle/`, so typing `@bytecra` should rank `_notebooks/byte/cradle/` first.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. In the composer, type `@` then quickly type `bytecra` in one go (with brief pauses that can let an intermediate query like `@byte` dispatch a search).
4. Confirm the suggestion list jumps straight to the `@bytecra` ranking (with `_notebooks/byte/cradle/` at the top) instead of first showing `_notebooks/byte/` at the top and then flashing/refreshing to `cradle/`.
5. Type a few more characters and confirm the list updates to the latest query without lingering on an earlier query's results.
6. Repeat in both light and dark theme.

#### Expected Results
- The suggestion list reflects the current `@<query>` only; an earlier, shorter query's in-flight result is discarded (token mismatch) rather than flashed before the final query refreshes.
- Once a previous in-flight search settles, the final query is re-fetched immediately (no extra ~320ms idle debounce), so the correct ranking appears as soon as the network allows.
- Light and dark theme render identically.

#### Performance Audit
- Root cause: `queueFileMentionSearch` only bumped `fileMentionSearchToken` on close/clear, not per query. If an intermediate query (e.g. `@byte`) won the 80ms debounce and dispatched a fetch while the user kept typing to `@bytecra`, that fetch's result still matched the current token and was displayed (`_notebooks/byte/` on top). The final `@bytecra` result only arrived via `refreshFileMentionSuggestionsAfterInFlight`, which additionally waited `FILE_MENTION_IDLE_REFRESH_DELAY_MS` (320ms) before re-fetching, so users saw the stale `byte/` list for a noticeable moment before it refreshed to `cradle/`.
- Fix: `queueFileMentionSearch` now bumps `fileMentionSearchToken` on every query, so a stale intermediate fetch's result is discarded by the `token !== fileMentionSearchToken` guard in `refreshFileMentionSuggestionsFromServer`. `refreshFileMentionSuggestionsAfterInFlight` now re-fetches immediately (clearing any pending debounce timer) instead of waiting the idle debounce, so the final query's result shows as soon as the previous in-flight fetch settles.
- No extra network calls in the common case: the in-flight guard (`fileMentionBackendInFlight`) still serializes fetches, and the cached-query check skips re-fetch when the query has not changed.
- No profiling run was executed in this session; the change is a latency/correctness fix on the client dispatch path. Next measurement: instrument the gap between the last keystroke and the final suggestion list settling and confirm it no longer includes the stale-result flash plus the 320ms idle debounce.

#### Rollback/Cleanup
- Revert the `fileMentionSearchToken += 1` in `queueFileMentionSearch` and restore the `setTimeout(..., FILE_MENTION_IDLE_REFRESH_DELAY_MS)` in `refreshFileMentionSuggestionsAfterInFlight`.

### Feature: Downward scroll reaches the latest reply without bouncing back

#### Prerequisites
- App server is running from this repository.
- A thread whose latest turn ran many commands (100+) so the turn spans more messages than the render window cap, e.g. session `019f8278-14d6-7c91-8e40-5b7a854e7592` (a turn with 200+ tool calls).
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run`.
2. Run `pnpm exec vue-tsc --noEmit`.
3. Open the thread and scroll/locate the last user message (top of the latest turn).
4. Scroll downward toward the agent's reply / latest command output. Confirm the view keeps scrolling down and reaches the very bottom instead of snapping back up to the user message.
5. Continue scrolling up and down through the large turn; confirm no bounce/loop between loadMoreAbove and loadMoreBelow.
6. Repeat in both light and dark theme.

#### Expected Results
- Scrolling down from the last user message reaches the latest reply at the bottom; the view no longer snaps back up to the user message.
- No loadMoreAbove <-> loadMoreBelow bounce loop while paging through a large turn.
- Light and dark theme render identically.

#### Performance Audit
- Root cause: `loadMoreBelow` computed `nextStart = max(renderWindowStart, nextEnd - MAX_RENDER_WINDOW_SIZE)`, so extending the end also trimmed the start once the window reached the 110-message cap. `restoreMessageAnchor` then snapped `scrollTop` back to the first visible message (near the top of the turn, e.g. the user's last message). The reduced `scrollTop` could re-trigger `loadMoreAbove` (which re-extended the start), looping the user back up whenever they tried to scroll down toward the latest reply.
- Fix: `loadMoreBelow` now keeps `renderWindowStart` fixed and only grows `renderWindowEnd`, so paginating downward never slices off the top of the turn and `restoreMessageAnchor` becomes a no-op (the top of the window is unchanged). The window grows downward until it reaches the latest message; commands are grouped/collapsed so a larger window stays cheap to render.
- `loadMoreAbove` is unchanged (it still caps the end via `MAX_RENDER_WINDOW_SIZE + latestTurnSize`), which is fine because paging upward is the direction where trimming the tail is acceptable.
- No profiling run was executed in this session; the change is a scroll-correctness fix. Next measurement: on the example session, scroll down from the last user message and confirm `scrollTop` monotonically increases to the bottom with no `[DEBUG:switch-lag] setRenderWindow` oscillation between two window ranges.

#### Rollback/Cleanup
- Restore `const nextStart = Math.max(renderWindowStart.value, nextEnd - MAX_RENDER_WINDOW_SIZE)` and `setRenderWindow(nextStart, nextEnd)` in `loadMoreBelow`.

### Feature: Mermaid diagrams in Markdown previews and messages

#### Prerequisites
- App server is running from this repository.
- A thread is available for sending a test message.
- Light and dark themes are both available from Settings.

#### Steps
1. Run `pnpm exec vitest run src/components/content/markdownRenderer.test.ts`.
2. In the composer, enter a Mermaid fence such as:

   ````markdown
   ```mermaid
   flowchart LR
     A[Start] --> B[Finish]
   ```
   ````

3. Open the composer Markdown preview and confirm the fence is replaced by a rendered SVG flowchart.
4. Send the same text to the thread and confirm the rendered message replaces the Mermaid fence with the same SVG diagram after the message renderer loads.
5. Enter an invalid Mermaid fence, open preview, and send it; confirm both locations retain readable Mermaid source instead of an empty or broken diagram.
6. Switch to dark theme, wait for the visible diagrams to redraw, and repeat steps 3-5.

#### Expected Results
- Fenced blocks labeled `mermaid` render as scalable SVG diagrams in both composer preview and message content.
- Other fenced code blocks keep their existing highlighted, copyable code-block behavior.
- Invalid Mermaid source remains visible as source code.
- Light and dark diagrams have readable fills, text, and borders after a theme switch.

#### Performance Audit
- The common Markdown renderer only emits a lightweight placeholder; it neither imports Mermaid nor parses diagrams synchronously.
- Mermaid is dynamically loaded only when a visible preview or rendered message contains a Mermaid placeholder. Production output keeps the Mermaid core in a separate on-demand chunk (about 635 KB), while the primary conversation chunk remains about 120 KB.
- Render calls are serialized because Mermaid has module-global configuration. The DOM scan is limited to visible preview/message roots and only pending or theme-stale diagrams are processed.
- No API calls, filesystem work, or cache invalidation are added for ordinary Markdown messages without Mermaid blocks.

#### Rollback/Cleanup
- Delete the disposable Mermaid test message or close the test thread. No persistent application data is created by rendering.

## 保持同一 turn 内文本与命令的事件顺序

- **前置条件：** 启动 CodexUI，并打开一个可执行命令的线程；准备一个会在回复过程中交替输出文本和命令的提示词。
- **步骤：**
  1. 发送提示词，使 agent 依次输出文本、运行一个命令、继续输出文本、连续运行两个命令、再输出文本并运行最后一个命令。
  2. 在 turn 进行中观察对话列表；展开连续两个命令形成的折叠块。
  3. 等待 turn 完成，并刷新线程以确认落盘消息。
  4. 分别切换浅色主题和深色主题，重复观察上述顺序和折叠块。
- **预期结果：** 文本和命令按 app-server 事件到达顺序交错显示；只有相邻的命令会合并为同一个折叠块。文本会把命令块分隔开，不会出现“所有文本在前、所有命令集中在后”的情况。浅色和深色主题下命令块、文本及展开内容均清晰可读。
- **回滚/清理：** 无需清理；可删除测试线程。

## 同一 turn 的 command 唯一渲染与交接去重

- **前置条件：** 启动 CodexUI，打开一个会连续执行多个 command 并在最后输出 agent 回复的线程。
- **步骤：**
  1. 发送会让 agent 连续执行多条 command 的请求；等待 command 区域折叠为一个相邻 command block。
  2. 等待最终 assistant 文本出现，并在 turn 刚完成、以及随后线程自动刷新后各观察一次。
  3. 确认 `Worked for …` 状态行不会展开或重放任何 command。
  4. 刷新页面并重新打开该线程，确认 command 仍按源 item 顺序只显示一次。
  5. 分别在浅色主题和深色主题重复步骤 1–4。
- **预期结果：** 每个 command item 仅有一个卡片；persisted history 与 live overlay 交接期间不出现第二份 command block；连续 command 只形成一个 collapse block，最终 assistant 回复不会前后各附加重复块；`Worked for …` 只显示时长状态。浅色和深色主题下状态行、command block 与最终回复均清晰可读。
- **回滚/清理：** 删除用于验证的测试线程即可；无持久设置需要清理。

## 会话链接收集下拉列表（Thread Links Dropdown）

- **前置条件：** 启动 CodexUI，打开一个包含较多消息的线程（user 与 agent 消息中混合出现网页 URL、绝对/相对文件路径、反引号路径、`file://` URI 等）。确保该线程有更早的历史消息尚未在主视图窗口内加载。
- **步骤：**
  1. 进入该线程后，观察内容头部 ContentHeader actions 区的链接触发按钮：链子图标 + 计数。首次进入时按钮显示 `…`，表示正在拉取完整历史；待完整历史加载完成后，计数变为该会话全部消息中去重后的链接总数（而非仅当前可见窗口内的链接）。
  2. 点击触发按钮展开下拉面板。面板分为两组：上方 `Links` 区列出网页 URL，下方 `Files` 区列出文件路径；两组各自按字典序排列，`Links` 区在前。
  3. 在搜索框输入关键字（如 `app`、`htps`），确认 fzf 风格模糊匹配（按字符先后顺序的 subsequence 匹配、大小写不敏感），命中字符高亮显示；`Links` 与 `Files` 两组分别过滤。
  4. 点击一条 web 链接，确认在新标签页打开；点击一条文件路径，确认跳转 `/codex-local-browse` 路由；点击文件行的复制按钮，确认路径已复制到剪贴板。
  5. 点击面板外部或按 `Esc` 关闭面板。
  6. 切换浅色主题重复步骤 1–5；再切换深色主题重复步骤 1–5。
- **预期结果：** 触发计数基于完整历史而非当前窗口（同一线程切换回来时计数稳定，不会因滚动加载更多消息而变化）；网页 URL 集中在 `Links` 区、位于 `Files` 之前；`Links` 与 `Files` 两组分别按字典序排列；搜索为 fzf 模糊匹配（subsequence、大小写不敏感）并高亮命中字符；相同 URL/路径只出现一次；`file://` URI 与行号后缀被规范化为纯路径；纯数字、版本号、端口号、代码标识符等非路径 token 不被收录；复制可用。浅色主题下面板为白底浅边框，深色主题下面板为 zinc-900 底、zinc-700 边框，目录/文件图标与文字清晰可读。
- **回滚/清理：** 无需清理；下拉列表为纯前端实时计算，加载的完整历史仅缓存在内存中，不写入持久数据。

## 当前目录文件浏览器（Cwd Explorer Dropdown）

- **前置条件：** 启动 CodexUI，打开任意线程（或新建线程并选定 cwd）。线程的 `cwd` 必须是一个可访问的本地绝对路径。
- **步骤：**
  1. 在内容头部 ContentHeader actions 区找到文件夹图标的触发按钮（位于会话链接下拉按钮旁），`title` 为 `Browse <cwd>`。
  3. 面板顶部 `cwd` 行右侧有一个眼睛图标按钮（显式隐藏文件开关），默认开启（显示以 `.` 开头的文件/目录）；点击切换为隐藏，已展开目录会按新设置重新拉取；再次点击恢复显示。
  3. 点击触发按钮展开下拉面板。面板顶部显示当前 `cwd` 完整路径，下方为该目录的文件树。
  4. 确认根目录条目按“目录在前、文件在后、字母序”排列；点击一个目录行，确认其展开并懒加载子条目（首次展开时通过 `/codex-local-entries` 拉取，已加载的目录再次展开即时显示）。
  5. 点击一个文件行，确认在新标签页打开 `/codex-local-browse` 查看文件内容。
  6. 点击一个目录名，确认在新标签页打开该目录的 `/codex-local-browse` 列表；点击目录前的箭头符号，确认仅折叠/展开子树、不打开新标签页。
  7. 再次点击已展开目录的箭头符号，确认折叠其子树。
  8. 切换线程，确认浏览器自动重置为新区段的 `cwd` 并清空已缓存目录。
  8. 切换浅色主题重复步骤 1–6；再切换深色主题重复步骤 1–6。
- **预期结果：** 触发按钮在 `cwd` 为空时禁用；面板顶部显示 `cwd` 路径；目录懒加载、可展开/折叠（chevron 旋转）；默认隐藏以 `.` 开头的条目，可通过眼睛开关显式切换；文件点击在新标签页打开 local-browse；目录名点击在新标签页打开该目录，目录前箭头符号负责折叠/展开；目录切换时缓存清空、重新加载。浅色主题下面板为白底浅边框，深色主题下面板为 zinc-900 底、zinc-700 边框，目录/文件图标与文字清晰可读。
- **回滚/清理：** 无需清理；浏览器为纯前端实时读取本地文件系统，不写入任何持久数据。

## 本地浏览页面目录树（/codex-local-browse explorer）

- **前置条件：** 启动 CodexUI，在任一能访问的本地目录上打开 `/codex-local-browse/<绝对路径>`（例如从会话链接或 cwd 浏览器点击文件/目录后在新标签页打开）。
- **步骤：**
  1. 打开 `/codex-local-browse/<dir>` 页面，确认目录列表中每个子目录行左侧有一个展开箭头，文件行左侧是占位空白。
  2. 点击一个目录行的展开箭头，确认其懒加载子条目并按缩进嵌套显示（首次通过 `/codex-local-entries` 拉取）；箭头旋转 90°。
  3. 再次点击该箭头，确认子树被移除、箭头复原。
  4. 展开一个目录后，对其子目录行再次点击展开箭头，确认可递归加载更深层级（缩进随深度增加）。
  5. 确认原有的 Raw、Delete、Create file/dir、Open folder/Create project 等操作仍可用；展开/折叠操作不会触发页面跳转。
  6. 在系统深色模式下打开该页面，确认配色自动切换为深色。
- **预期结果：** 目录行可展开/折叠，子条目懒加载、按深度缩进；文件/目录名链接、Raw、Delete 等既有功能不受影响；深色配色正确。
- **回滚/清理：** 无需清理；页面为实时读取本地文件系统，不写入持久数据。

---

### Feature: Drag to reorder pinned sidebar threads

#### Prerequisites
- App is running from this repository.
- At least two pinned threads exist in the sidebar `Pinned` section.
- Sidebar search is empty (reorder is disabled while searching).

#### Steps
1. Open the app in light theme and expand the `Pinned` section.
2. Drag a pinned thread title onto another pinned thread.
3. Confirm the list order updates immediately after drop.
4. Refresh the page and confirm the new pin order is restored.
5. Switch to dark theme and repeat a drag reorder.
6. Confirm the dragged row fades and the drop target row highlights in both themes.
7. Confirm click-to-select, delete, and the thread menu still work on pinned rows.

#### Expected Results
- Pinned threads can be manually reordered by dragging the title.
- Order persists via `PUT /codex-api/thread-pins` / `thread-pinned-ids`.
- Light and dark themes both show clear dragging/drop-target feedback.
- Search mode does not allow pinned reordering.

#### Rollback/Cleanup
- Unpin or re-pin test threads if needed.

### Feature: Resume historical thread provider and model

#### Prerequisites
- App server is running from this repository.
- A historical thread exists whose rollout was created with a non-default provider, such as `cursor`, and a model different from the currently active provider's default.
- Light and dark themes are both available from Settings.

#### Steps
1. In browser localStorage, seed this historical thread's `codex-web-local.selected-model-by-context.v1` / `codex-web-local.provider-by-context.v1` entries with a stale Ark Coding Plan model/provider, then reload the app.
2. Open a historical thread whose latest provider is represented by `thread_settings_applied` while its subsequent `turn_context` omits a provider, then confirm its model/provider reflect those latest persisted settings rather than the stale Ark cache, the session's initial provider, or the active runtime default.
3. Switch to a provider deliberately in the composer and send a message; confirm that intentional selection is used for that send.
4. While a turn is running in the restored thread, submit a follow-up using `Steer`.
5. Confirm the follow-up remains on the restored provider/model and does not insert a model-switch message.
6. Repeat steps 2-5 in light theme and dark theme.

#### Expected Results
- Navigation-time resume does not replay browser-cached model/provider arguments; it performs one metadata-only `thread/read`, then resumes with the recovered model and provider.
- Provider recovery uses the latest `thread_settings_applied` record when the rollout's `turn_context` does not repeat its provider.
- Recovered non-empty provider state replaces a stale per-thread browser cache entry, so Ark Coding Plan cannot become sticky after a provider switch.
- A deliberate composer selection still supplies its chosen provider/model when sending.
- `Steer` reuses the provider recovered by resume.
- Light and dark theme rendering is unchanged.

#### Performance Audit
- Each required navigation/runtime resume adds one bounded, metadata-only `thread/read` with `includeTurns: false` before its existing `thread/resume`; cached-first rendering still returns the current thread view immediately and performs the synchronization in the background.
- Profile baseline recorded on July 30, 2026 for a local historical-thread route: 8.57 s total, 248.4 KB API payload, one `thread/resume`, and eight `thread/read` requests. The changed path contributes exactly the single pre-resume metadata read; the other reads come from the existing thread/history/index loading paths. There is no pre-change profile artifact for that route, so the count is recorded for follow-up rather than claimed as an improvement.
- The read result is enriched from the rollout by the bridge's bounded session-state cache, so recovery does not load full turns or add an unbounded fanout.
- Reading `thread_settings_applied` adds constant-time field extraction to the existing one-pass, cached session-log parse; it adds no extra RPCs beyond the one metadata read, filesystem reads, or cache invalidations.

#### Rollback/Cleanup
- Restore the two localStorage entries or reload the app after completing the check.

### Feature: Persistent Markdown comment editor

#### Prerequisites
- App server is running from this repository.
- Open a Markdown file in the local editor and enable `Preview`.
- The file contains selectable text and at least one `\\mark{...}` or `\\comment{...}` annotation.

#### Steps
1. In light theme, select text in the preview and choose `Add comment`, or click an existing annotation and choose `Edit comment`.
2. Enter text in the comment editor, then click ordinary preview content, the editor surface, and a different annotation without using the editor controls.
3. Confirm the editor stays visible and its text is unchanged. Confirm new selection/annotation action controls do not replace the active editor.
4. Press `Escape` inside the editor and confirm it remains open.
5. Press `Shift+Enter` to add a line break, then press `Enter` to submit; confirm the comment is inserted or updated and the editor closes after the successful submit.
6. Open the editor again, enter draft text, click `Cancel`, and confirm the editor closes without applying the draft.
7. Repeat steps 1-6 in dark theme.

#### Expected Results
- A visible add-comment or edit-comment editor remains open while users click outside it, including in the preview iframe.
- Only explicit cancellation discards a draft; successful submission closes the editor after applying the comment.
- The active editor is not redirected from its original annotation by subsequent preview selections.
- Light and dark themes retain readable editor controls and annotation content.

#### Performance Audit
- The change only adds constant-time visibility checks to existing local event handlers. It performs no additional rendering passes, network requests, filesystem requests, or persistent storage work.

#### Rollback/Cleanup
- Use `Cancel` to discard any manual-test draft. Remove any test annotation inserted during the verification if it should not remain in the file.

### Feature: Queued messages recover the current thread provider

#### Prerequisites
- App server is running from this repository.
- A historical thread exists whose latest rollout settings use a non-default provider/model, and browser localStorage or an older queued item contains a different stale provider/model snapshot.
- The thread can run a long enough turn to add a follow-up to the queue.
- Light and dark themes are both available from Settings.

#### Steps
1. In light theme, open the historical thread and start a long-running turn on its restored provider.
2. While it is running, submit a follow-up with the composer configured for Queue without deliberately changing the provider or model.
3. Let the active turn finish and wait for the queued message to start automatically.
4. Confirm the queued turn remains on the provider/model recovered from the thread's latest persisted settings, rather than changing to the stale queued snapshot.
5. Start another long-running turn, deliberately choose a different provider/model in the composer, queue a follow-up, and let it drain.
6. Confirm this deliberate selection is honored for the queued follow-up.
7. Switch to dark theme and repeat steps 1-6; confirm the queue rows, composer controls, and resulting conversation remain readable.

#### Expected Results
- Legacy queued messages without an explicit selection marker recover the current thread provider, model, and reasoning effort before `thread/resume` and `turn/start`.
- A queued message changes provider only when the user deliberately changed the composer configuration before queueing it.
- Queue order, automatic draining, and queued-message persistence continue to work in both light and dark themes.

#### Performance Audit
- The queue processor reuses its existing single `thread/read` eligibility check and enriches that response through the bounded session-model cache; it adds no RPC, polling loop, unbounded fanout, or browser payload.
- The cache reads a session JSONL file only when its size or mtime changes. Once warm, provider recovery is an in-memory lookup plus constant-size field selection.
- Browser profile on July 31, 2026 (`browser-runtime-profile-home-2026-07-31T04-53-04-640Z.json`) recorded 8.43 s total and 167.5 KB API payload. It reports seven existing `thread/read` calls during home-page startup, below the eight-call historical-thread baseline recorded above; the queued-drain path was not invoked by that startup profile and adds no independent read.

#### Rollback/Cleanup
- Delete any disposable queued messages or archive the manual-test thread. No browser-cache cleanup is required.

### Feature: Max reasoning effort

#### Prerequisites
- App server is running from this repository with a Codex model that supports `max`, such as `gpt-5.6-terra-max`.
- Light and dark themes are both available from Settings.

#### Steps
1. In light theme, select the `gpt-5.6-terra-max` model in the composer and choose `Max` from the thinking dropdown.
2. Send a short prompt, then confirm the composer still displays `Max` while the turn is running and after it finishes.
3. Reload the page and reopen the thread; confirm the recovered model and thinking level remain `gpt-5.6-terra-max` and `Max`.
4. Switch to dark theme and repeat steps 1-3.

#### Expected Results
- The thinking dropdown includes `Max` after `Extra high`.
- New turns send `effort: "max"`, and persisted thread state restores `max` without falling back to another level.
- Light and dark themes render the dropdown and selected value legibly.

#### Performance Audit
- This change only extends existing constant-size effort allowlists and dropdown options. It adds no requests, timers, filesystem reads, cache invalidations, or payload fields.

#### Rollback/Cleanup
- Delete the disposable test thread if it is no longer needed. No additional browser storage cleanup is required.

### Feature: Arknights-inspired light and dark visual theme

#### Prerequisites
- App server is running from this repository.
- A thread exists that contains ordinary messages, a command group, and at least one tool call or file-change summary.
- Settings is available in the sidebar so Appearance can be switched between Light and Dark.

#### Steps
1. In Light appearance, open the home screen and a populated thread. Confirm the PRTS information-cell `#f8f9fa` canvas uses the subtle grid texture, square panel edges, bright-cyan primary rules, and fixed blue-gray structural accents while the existing sidebar, composer, and conversation layout stay in place.
2. Confirm the desktop sidebar and its resize handle retain their normal border treatment. In the conversation view, confirm the message list has no full-height gray guide line to the right of the avatar column.
3. Inspect the sidebar, settings panel, thread header, dropdowns, and new-thread cards. Confirm that box-like controls use square edges, the header keeps its cyan accent rule above a neutral gray divider, selected/primary actions use cyan without obscuring text, all header action controls use the same 28px height with symmetric top and bottom spacing, and the terminal dropdown icon has no empty bordered inner box.
4. In the thread, inspect assistant and user messages, code fences, plan cards, Markdown tables, command groups, tool-call cards, and file-change summaries. Confirm Markdown tables use a square 1px frame, muted-gray header, centered compact middle-aligned cells, a darker outer/horizontal rule, and a lighter vertical rule; expand and collapse commands/tool details and verify every control remains usable, the latest command in the group summary remains monospace, and the expanded command/output frames are square.
5. Open the composer, its attachment menu, and a model or skills dropdown. Confirm the command-desk styling, focus outline, chips, and send/queue actions remain readable and clickable. With a queued message present, confirm the queue container, queue rows, and its action controls are square.
6. In a conversation long enough to display its vertical scrollbar, confirm the composer shell's left and right edges align with the centered message column rather than shifting right by half the scrollbar gutter.
7. Select ordinary text in the conversation and composer. Confirm the browser's default selection colors apply, without a theme-defined selection override.
8. Switch Appearance to Dark and repeat steps 1-7. Confirm all panels become the charcoal variant, bright-cyan and blue-gray accents retain contrast, and no light surface remains on the dark app shell.
9. Visit the password page and a local directory-browser route in both operating-system light and dark color schemes. Confirm they use the same Fira font stacks, compact border radius, bright-cyan actions, blue-gray leading accents, and readable form controls.

#### Expected Results
- The existing System / Light / Dark appearance cycle still controls the application without changing layout, routing, thread behavior, or saved preferences.
- The application uses CSS-only texture and palette rules; no character art, logos, remote images, or remote fonts are requested.
- Both themes use the shared Ark palette: charcoal or pale-gray canvas, bright-cyan primary accents, fixed blue-gray structural accents, readable low-contrast secondary text, and restrained borders/shadows.
- Box-like controls, cards, menus, dropdowns, dialogs, labels, and command/tool containers use square corners; avatars, loading rings, and toggle thumbs retain their non-box shapes.
- Conversation, command, tool, composer, settings, login, and local-browse surfaces stay legible and interactive in both themes.

#### Performance Audit
- `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser` recorded a 7.43 s home-route baseline with 219.0 KB API payload. The profiler reported existing `threadRead=10`, `skillsList=2`, and `rateLimitsRead=2` warnings; the slowest row is `thread/read` at 2866.8 ms (about 1.0 KB response), with no added theme request or payload.
- `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_ROUTE="#/thread/019da7c0-4e12-7a91-837c-f7c11cc8ab6c" PROFILE_WAIT_MS=7000 pnpm run profile:thread` recorded a 7.43 s direct-thread baseline with 182.3 KB API payload. It reported existing `threadRead=11` and `rateLimitsRead=2` warnings; the slowest row was `thread/read` at 2833.7 ms. The styling change adds no request or payload.
- The theme is CSS-only: it adds no JavaScript state, polling, API request, asset request, filesystem read, or cache invalidation path.

#### Rollback/Cleanup
- Cycle Appearance back to the preferred mode. No data or browser storage cleanup is required.

### Fix: Interrupted turn status continuity

#### Prerequisites
- App server is running from this repository with interrupted-turn auto-continuation enabled (the default).
- A thread can produce an unintentional `interrupted` turn that the bridge resumes automatically.
- Light and dark themes are both available from Settings.

#### Steps
1. In light theme, open the affected thread and let an unintentional interruption trigger automatic continuation.
2. Watch the sidebar running indicator and the conversation activity state during the interruption and the resumed command.
3. Confirm the thread remains displayed as running until the next command or response arrives.
4. Deliberately use Stop on a separate active thread and confirm it reaches the normal stopped state rather than being resumed.
5. Switch to dark theme and repeat steps 1-4; confirm status indicators and Stop controls retain normal contrast.

#### Expected Results
- A turn that the bridge automatically resumes never flashes as stopped between the interrupted completion and the synthetic running event.
- An intentional Stop remains terminal and its interrupted completion is not hidden or auto-continued.
- Light and dark themes preserve existing running and stopped state presentation.

#### Performance Audit
- The bridge continues to use the existing debounced 250 ms interrupted-turn inspection and one `thread/read` check. Deferred notifications are stored only per affected thread and are released or discarded once, adding no polling loop, duplicate RPC, payload growth, or browser request.

#### Rollback/Cleanup
- Use Stop on any disposable verification turn. No configuration or browser-storage cleanup is required.
