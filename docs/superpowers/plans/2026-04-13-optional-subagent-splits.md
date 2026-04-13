# Optional Subagent Splits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagent split panes opt-in via a config file at `~/.config/opencode/opencode-cmux.json`.

**Architecture:** Read a JSON config file once at plugin init. Gate the entire split creation block behind a `splitsEnabled` boolean. Update README to document the config.

**Tech Stack:** TypeScript, Node.js `fs` and `os` modules.

**Spec:** `docs/superpowers/specs/2026-04-13-optional-subagent-splits-design.md`

---

### Task 1: Add config file reading to plugin init

**Files:**
- Modify: `src/index.ts:1-16` (imports and top of plugin function)

- [ ] **Step 1: Add imports for `readFileSync` and `homedir`**

At the top of `src/index.ts`, add the `os` import alongside the existing `node:child_process` import:

```typescript
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
```

Note: `readFileSync` replaces the existing `existsSync` import from `node:fs` — but `existsSync` is not used in `index.ts` (it's in `cmux.ts`). This is a new import for this file.

- [ ] **Step 2: Read and parse the config file at plugin init**

Inside the `plugin` function body (after `const originalSurfaceId = ...` on line 20, before the `resolveServerUrl` block), add:

```typescript
// Read plugin config (once at init)
let splitsEnabled = false
try {
  const configPath = `${homedir()}/.config/opencode/opencode-cmux.json`
  const raw = readFileSync(configPath, "utf-8")
  const config = JSON.parse(raw)
  if (config.splits === true) {
    splitsEnabled = true
  }
} catch {
  // File missing, unreadable, or invalid JSON — use defaults
}
```

- [ ] **Step 3: Gate the split creation block**

In the `session.created` handler (current line 140-188), change the guard from:

```typescript
if (e.type === "session.created") {
  const info = e.properties.info
  const url = info?.parentID ? resolveServerUrl() : null
  if (info?.parentID && url) {
```

to:

```typescript
if (e.type === "session.created") {
  const info = e.properties.info
  if (splitsEnabled && info?.parentID) {
    const url = resolveServerUrl()
    if (url) {
```

This means `resolveServerUrl()` is only called when splits are enabled AND it's a subagent session. The closing braces need adjustment — add one extra `}` to close the new `if (splitsEnabled && info?.parentID)` block.

The full rewritten block:

```typescript
if (e.type === "session.created") {
  const info = e.properties.info
  if (splitsEnabled && info?.parentID) {
    const url = resolveServerUrl()
    if (url) {
      await enqueueSplitOp(async () => {
        if (activeSplits.has(info.id)) return

        let direction: SplitDirection
        let fromSurface: string | undefined
        const n = agentCount

        if (n === 0) {
          direction = "right"
          fromSurface = originalSurfaceId
        } else if (n === 1) {
          direction = "down"
          fromSurface = rowFrontier[0]
        } else if (n === 2) {
          direction = "down"
          fromSurface = originalSurfaceId
        } else {
          const rowIdx = (n - 3) % 3
          direction = "right"
          fromSurface = rowFrontier[rowIdx]
        }

        const surfaceId = await createSplit($, direction, fromSurface)
        if (!surfaceId) return

        if (n < 3) {
          rowFrontier[n] = surfaceId
        } else {
          const rowIdx = (n - 3) % 3
          rowFrontier[rowIdx] = surfaceId
        }

        activeSplits.set(info.id, surfaceId)
        agentCount++

        const attachCmd = `opencode attach ${url} --session ${info.id}`
        await sendToSurface($, surfaceId, attachCmd)
        await sendKeyToSurface($, surfaceId, "enter")

        if (originalSurfaceId) {
          await focusSurface($, originalSurfaceId)
        }
      })
    }
  }
  return
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Verify build passes**

Run: `bun run build`
Expected: Clean build output in `dist/`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: make subagent splits opt-in via config file

Splits are now disabled by default. To enable them, create
~/.config/opencode/opencode-cmux.json with { \"splits\": true }.

All other plugin features (notifications, status, logging) are unaffected."
```

---

### Task 2: Update README

**Files:**
- Modify: `README.md:35-43` (Subagent splits section)

- [ ] **Step 1: Rewrite the Subagent splits section**

Replace the current "Subagent splits" section (lines 35-43) with:

```markdown
## Configuration

Create `~/.config/opencode/opencode-cmux.json` to customize plugin behavior:

```json
{
  "splits": true
}
```

| Option   | Type    | Default | Description                                              |
|----------|---------|---------|----------------------------------------------------------|
| `splits` | boolean | `false` | Open cmux split panes for subagent sessions              |

If the file does not exist, all options use their defaults.

## Subagent splits

When `splits` is enabled and a subagent spawns, the plugin opens a cmux split with a live `opencode attach` view. Requires `--port` to expose an HTTP server:

```bash
opencode --port 0  # binds to first available port
```

Without `--port`, splits are silently skipped even when enabled.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document config file for optional splits"
```
