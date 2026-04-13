# Optional Subagent Splits

**Date:** 2026-04-13
**Status:** Approved

## Problem

Subagent split panes (introduced in PR #4) activate automatically whenever
the plugin detects cmux + an HTTP server. There is no way to disable them.
Some users want the rest of the plugin (notifications, status bar, logging)
without the split management, and the feature should be opt-in rather than
automatic.

## Design

### Config file

**Location:** `~/.config/opencode/opencode-cmux.json`

**Schema:**

```json
{
  "splits": true
}
```

| Key      | Type    | Default | Description                                      |
|----------|---------|---------|--------------------------------------------------|
| `splits` | boolean | `false` | When `true`, subagent sessions create cmux splits |

- If the file does not exist, is unreadable, or contains invalid JSON, all
  options fall back to their defaults (splits disabled).
- The file is read once at plugin initialization time, not on every event.

### Why a config file instead of an env var

- The user wants the setting to be persistent and discoverable, not
  something buried in shell profiles.
- OpenCode's plugin API does not support per-plugin options in
  `opencode.json`, so a dedicated config file is the most ergonomic
  alternative.
- A global-only location (`~/.config/opencode/`) keeps it simple -- one
  file, one place to look.

### Implementation changes

**`src/index.ts`:**

1. At the top of the `Plugin` function (before returning hooks), resolve the
   config file path using `os.homedir()` and attempt to read + parse it.
   On any failure, default to `{ splits: false }`.

2. Store the result in a local `splitsEnabled` boolean.

3. In the `session.created` handler, wrap the entire split block with
   `if (splitsEnabled)` so that `resolveServerUrl()` is also skipped when
   splits are disabled. The resulting guard reads:
   `if (splitsEnabled && info?.parentID && url)`.

4. No changes needed to split cleanup handlers (`removeAndClose`,
   `session.deleted`, `session.status idle`, `session.error`) -- when
   splits are disabled, `activeSplits` is always empty, so cleanup is
   already a no-op.

**`src/cmux.ts`:** No changes.

### What stays the same

- All notification behavior (`notify`)
- All status bar behavior (`setStatus`, `clearStatus`)
- All logging behavior (`log`)
- All permission handling (`permission.asked`, `permission.replied`,
  `permission.ask`)
- The `resolveServerUrl()` logic (unchanged, just not called when splits
  are disabled since the `splitsEnabled` guard short-circuits the entire
  block)
- The grid layout algorithm (unchanged, just gated behind `splitsEnabled`)

### README update

Add a "Configuration" section documenting the config file, its location,
schema, and default behavior, with an example showing how to enable splits.

## Non-goals

- Per-project configuration (global only for now)
- Granular toggles for notifications/status/logging (out of scope)
- Changes to the OpenCode plugin API itself
