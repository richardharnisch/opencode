# Terminal cursor behind toast notifications

- Issue: https://github.com/anomalyco/opencode/issues/60215
- Fix: https://github.com/richardharnisch/opencode/commit/199fb52
- PR branch: `richardharnisch:toast-cursor`, based on OpenCode `dev` at `726cf096396d5014c3b1845e231cc01efe0421ee`.

This branch contains review evidence only. The proposed source change is limited to `packages/tui/src/ui/toast.tsx` and its existing test file.

## Before and after

The reporter manually tested the fix and supplied two local screenshots taken on 2026-10-29: 15:04:56 (before) and 15:07:05 (after). These are the primary images used in the prepared PR description.

The white terminal cursor is visible over the notification before the fix and hidden afterward. The images below are crops of the notification area only, with no changes to their content. The original screenshots were not changed or published; the crops exclude the username, computer name, and paths.

### Before

![Cursor visible over the notification](local-before.png)

### After

![Notification covers the cursor](local-after.png)

## Additional verification captures

The earlier captures used the real OpenCode TUI, including `/terminal` and mouse-driven copy-on-selection, through Terminal Control 1.2.1. The baseline is the installed OpenCode 2.2.1 release. The fixed client is the source branch above. Both use OpenTUI 0.7.0. In these captures, the terminal cursor is at the same cell before and after the fix.

Additional screenshots: [before detail](before-detail.png), [after detail](after-detail.png), [full before](before.png), [full after](after.png), [after expiry, with the cursor restored](restored.png), and [88-column layout](after-narrow.png).

These additional captures used a dedicated synthetic database, isolated HOME/XDG directories, no external plugins, and no model requests. No live session data or credentials were used in that verification.

## Reproduce

1. Open a session and run `/terminal`.
2. In the side terminal, run:
   ```sh
   printf '\033[2J\033[Hselect this text\033[2;999H\033[6D'; sleep 30
   ```
3. Select `select this text` with the mouse.
4. Check the upper-right notification. Press Ctrl+C to finish the shell command.

The fix hides only a cursor whose cell is within the toast's current bounds. It does not blur the terminal, change the embedded application's cursor state, or change cursor shape/color/blinking. The focused renderable supplies its cursor state again on the next frame, so moving outside the toast or dismissing it restores the appropriate visibility.

## Verification

Linux x86_64, Bun 1.4.4, dependencies from the frozen lockfile.

| Check | Result |
| --- | --- |
| `bun run check` from the repository root | Pass, with repository warnings; zero lint/type errors |
| `bun run typecheck:tsc` from `packages/tui` | Pass |
| `bun test --timeout 30000 test/cli/tui/toast.test.tsx --rerun-each 10` | 80 pass, 0 fail |
| Regression negative control, before adding the fix | 5 fail, 3 pass |
| Prettier on both changed files and `git diff --check` | Pass |
| Full TUI suite, fixed branch | 1569 pass, 2 skip, 1 fail |
| Full TUI suite, unchanged base | 1563 pass, 2 skip, 1 fail |

Both full-suite runs fail the same existing assertion in `test/component/go-upsell-art.test.tsx`: the art is `▀▀▀▀ ▀▀▀▀`, while the test expects `█▀▀▀ █▀▀█`. The fix does not change that component. An earlier command-limited full-suite attempt timed out and reported a shell-output failure; all 18 shell-output checks passed in three repeat runs on each branch.

The six added regression cases exercise narrow/wide layouts, border coordinates, moving into/out of coverage, clean frames, focus and keyboard input, dismissal, resizing, preservation of cursor properties, and application-hidden cursors.

Live TUI checks also covered notification expiry, resizing to 88 columns, and shell input after copying. The reporter separately confirmed the fix in their local terminal and supplied the primary screenshots above. macOS, Windows, and additional terminal emulators were not tested locally. Upstream PR CI has not run because the PR has not been opened.
