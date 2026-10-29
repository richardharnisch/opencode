### Issue for this PR

Fixes #60215

### Type of change

- [x] Bug fix
- [ ] New feature
- [ ] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

Hide the host terminal cursor when its cell is covered by a toast. The cursor is separate from the TUI's painted cells, so drawing the toast last does not cover it.

Check the toast's current bounds after painting and suppress only a visible, covered cursor. Keep terminal focus and input unchanged. The focused renderable restores its cursor state on subsequent frames; application-hidden cursors stay hidden.

### How did you verify your code works?

- Toast tests: 80 passes across 10 repeat runs; five regression cases fail without the fix.
- `bun run check`, TUI `typecheck:tsc`, and formatting checks pass.
- Full TUI suite: 1569 pass, 2 skip, 1 fail. Unchanged `dev` has the same `go-upsell-art.test.tsx` failure (1563 pass, 2 skip, 1 fail).
- Real TUI: `/terminal`, mouse copy, expiry/restoration, resizing, and shell input in an isolated synthetic-data sandbox.

### Visual

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72" viewBox="0 0 240 72" role="img" aria-label="Terminal cursor stays behind notifications">
  <style>
    @media (prefers-reduced-motion: no-preference) {
      .cursor { animation: cursor 4s steps(1, end) infinite; }
      @keyframes cursor {
        0%, 20%, 80%, 100% { transform: translateX(0); opacity: 1; }
        25%, 75% { transform: translateX(140px); opacity: 0; }
      }
    }
  </style>
  <rect x="4" y="6" width="232" height="60" rx="5" fill="none" stroke="currentColor" opacity=".3"/>
  <text x="16" y="34" fill="currentColor" font-family="monospace" font-size="16">$</text>
  <rect class="cursor" x="31" y="21" width="7" height="16" fill="currentColor"/>
  <rect x="110" y="14" width="114" height="36" rx="3" fill="currentColor" opacity=".12"/>
  <path d="M110 14v36m114-36v36" stroke="currentColor" opacity=".7"/>
  <text x="125" y="36" fill="currentColor" font-family="monospace" font-size="13">Copied</text>
</svg>
```

### Screenshots / recordings

Before (2.2.1) and after (this branch), captured from the full TUI:

![Before: cursor drawn over the toast](https://raw.githubusercontent.com/richardharnisch/opencode/toast-cursor-evidence/before-detail.png)

![After: toast covers the cursor](https://raw.githubusercontent.com/richardharnisch/opencode/toast-cursor-evidence/after-detail.png)

[Full screenshots, reproduction steps, and verification details](https://github.com/richardharnisch/opencode/tree/toast-cursor-evidence)

### Checklist

- [x] I have tested my changes locally
- [x] I have not included unrelated changes in this PR
