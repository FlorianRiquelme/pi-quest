# Dashboard Follow-Up: Full-Screen Layout + Shortcut Fix

## Context

UAT of `dashboard-polish-001` surfaced two UX issues that need fixing.

## Issues Found

### 1. Dashboard should be full-screen

**Current behavior:** Dashboard opens as a centered 85% width overlay. The right pane (70% of the overlay) is cramped for showing quest details, and the markdown viewer (artifact reading) is especially tight.

**Expected behavior:** Dashboard should use the full terminal screen. This is a modal context switch — the user isn't reading terminal output while browsing quests, so there's no value in preserving partial visibility of the underlying chat.

**Change:** In `extensions/ui/dashboard-opener.ts`, change overlay options from `width: "85%", maxHeight: "85%", anchor: "center"` to full-screen covering.

### 2. Shortcut `alt+g` blocked on Mac

**Current behavior:** `alt+g` (Option+G on Mac) opens the dashboard. On Mac terminals, Option+letter is intercepted by the terminal to produce special characters (Option+G → ©). The key never reaches pi.

**Expected behavior:** A shortcut that works cross-platform without terminal interference.

**Change:** Replace `alt+g` with `ctrl+shift+g` in `extensions/index.ts`. `ctrl+shift+g` is unbound in pi and unlikely to be intercepted by terminals.

## Acceptance Criteria

- [ ] Dashboard opens full-screen (100% width, 100% height, no margins)
- [ ] Markdown viewer benefits from full width — no separate change needed
- [ ] `ctrl+shift+g` opens dashboard on Mac, Linux, and Windows
- [ ] `alt+g` registration removed (avoid confusion)
- [ ] `/quest dashboard` continues to work as fallback
- [ ] All existing tests pass

## Files to Touch

- `extensions/ui/dashboard-opener.ts` — overlay options
- `extensions/index.ts` — shortcut registration

## Constraints

- Keep existing split-pane layout (left list, right detail)
- No changes to dashboard internal rendering logic
- No mouse support
