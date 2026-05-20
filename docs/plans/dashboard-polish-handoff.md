# Dashboard & Widget Stability Polish

## Context

We just landed a major UI/UX enhancement for pi-quest: a persistent **widget** above the editor and an interactive **dashboard** overlay (`alt+g`). Both are functional but have stability gaps that need closing before they feel production-ready.

## Current State

### What's working
- **Widget**: 2-line display showing active quest title, status, running count, and done/total work items. Appears on session start and after `/quest intake` or `/quest select`.
- **Dashboard**: Split-pane overlay. Left = quest list with selection. Right = quest detail (header, stage pipeline, artifacts checklist, work items, recent runs). Number keys `1–7` open artifacts in a markdown viewer. Auto-refreshes every 2s via `setInterval`.
- **Shortcut**: `alt+g` opens dashboard. `/quest dashboard` also works.

### What's fragile

#### 1. Widget does NOT live-update when background runs change
The widget only refreshes on `session_start`, `/quest intake`, and `/quest select`. When `quest_run_work_item` starts a background agent or when a run completes, the widget stays stale until the user runs another command.

**Expected**: Hook into `tool_execution_end` events to invalidate and re-render the widget when any quest-related tool finishes.

#### 2. Dashboard panes have no scroll handling
Both the left quest list and the right detail pane render all content unconditionally. If there are many quests or a long implementation plan, content overflows the overlay viewport with no way to scroll.

**Expected**: Add scroll offset tracking (↑/↓ scroll the active pane, or page-based scrolling). The left pane should scroll independently of the right pane.

#### 3. No graceful handling of corrupted/missing quest data
If a `workflow.json` is malformed or a quest directory is deleted while the dashboard is open, `getQuestDetail` returns `undefined` and the right pane shows "Quest data missing" but doesn't recover when data is restored.

**Expected**: Defensive reads with `try/catch` around JSON parsing. If a quest disappears, refresh the list and select the next available quest.

#### 4. Widget shows stale hint when no quest is active
When `currentQuestId` is unset, the widget disappears entirely. There's no friendly hint like "No active quest — run /quest intake".

**Expected**: Show a compact one-line hint instead of hiding completely.

#### 5. Dashboard markdown viewer re-parses on every render
`renderMarkdownView` creates a new `Markdown` component instance every time `render()` is called. This is wasteful and could cause flicker.

**Expected**: Cache the `Markdown` component instance when entering markdown view, invalidate only when the viewed artifact changes.

#### 6. Date formatting is raw ISO strings
The dashboard shows `Updated: 2024-05-19T18:05:52.123Z`. This is hard to read.

**Expected**: Show relative time (e.g., "Updated 2h ago") with a fallback to locale date string.

## Acceptance Criteria

- [ ] Widget updates within 1 second of any `quest_run_work_item`, `quest_rescue`, or `quest_work_item_status` tool completing
- [ ] Dashboard left pane scrolls independently when quest count exceeds visible rows
- [ ] Dashboard right pane scrolls when content exceeds visible height
- [ ] Corrupted `workflow.json` is handled gracefully (log warning, skip quest, don't crash)
- [ ] When no quest is active, widget shows a one-line hint instead of vanishing
- [ ] Markdown viewer caches its `Markdown` component across renders
- [ ] All timestamps in dashboard use relative formatting
- [ ] All existing tests pass; new tests added for scroll logic and live-update hooks

## Files to Touch

- `extensions/index.ts` — add `tool_execution_end` event hook for widget invalidation
- `extensions/ui/widget.ts` — expose `invalidate()` or rebuild function for external triggers
- `extensions/ui/dashboard.ts` — add scroll offsets, pane focus, defensive data reads, relative dates, markdown cache
- `extensions/ui/data.ts` — add `try/catch` around `loadQuestWorkflow` and JSON parsing
- `extensions/ui/dashboard-opener.ts` — pass visible height for scroll bounds

## Constraints

- Keep the widget single-responsibility: data only, no scroll, no interactivity
- Don't add mouse support yet — keyboard-only keeps scope tight
- Preserve existing color/styling logic (theme-aware)
- The dashboard overlay options (`width: "85%"`, `anchor: "center"`, etc.) should not change
