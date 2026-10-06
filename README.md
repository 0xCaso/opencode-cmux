# opencode-cmux

[![npm](https://img.shields.io/npm/v/opencode-cmux)](https://www.npmjs.com/package/opencode-cmux)

OpenCode plugin that bridges OpenCode events to cmux notifications and sidebar metadata.

## Requirements

- OpenCode ≥ 1.0, including OpenCode 2 (`@opencode/cli`)
- [cmux](https://cmux.app) (macOS app) installed; the plugin invokes `cmux` via `$CMUX_BUNDLED_CLI_PATH` (set by cmux's shell integration), falling back to `cmux` on `$PATH`
- The plugin is a no-op when not running inside a cmux workspace

## Installation

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-cmux"]
}
```

OpenCode will download the package automatically on next start.

### Local / development

Build the package, then symlink the output directly into OpenCode's plugin directory:

```bash
ln -sf ~/path/to/opencode-cmux/dist/index.js ~/.config/opencode/plugins/cmux.js
```

Make sure `opencode-cmux` is **not** listed in `opencode.json` when using the symlink, to avoid loading it twice.

## Configuration

Create `~/.config/opencode/opencode-cmux.json` to customize plugin behavior:

```json
{
  "splits": true,
  "notifications": {
    "done": false
  }
}
```

| Option                     | Type    | Default | Description                                              |
|----------------------------|---------|---------|----------------------------------------------------------|
| `splits`                   | boolean | `false` | Open cmux split panes for subagent sessions              |
| `notifications.done`       | boolean | `true`  | Show a popup when a session finishes                     |
| `notifications.permission` | boolean | `true`  | Show a popup when OpenCode requests a permission         |
| `notifications.question`   | boolean | `true`  | Show a popup when OpenCode asks a clarifying question    |
| `notifications.error`      | boolean | `true`  | Show a popup when a session errors                       |

If the file does not exist or any key is omitted, defaults are used. Each notification type can be toggled independently — useful when running multiple agents in parallel and per-turn `Done` popups become noisy.

## Subagent splits

When `splits` is enabled and a subagent spawns, the plugin opens a cmux split with a live `opencode attach` view. Requires `--port` to expose an HTTP server:

```bash
opencode --port 0  # binds to first available port
```

Without `--port`, splits are silently skipped even when enabled.

OpenCode 2 has no `opencode attach` and every server asks for a password. The split runs `opencode --server <url> --session <id>`, so it works only when `OPENCODE_SERVER_PASSWORD` is exported in your shell profile, where both OpenCode and the new pane can read it. Without it, splits are skipped.

## cmux's own OpenCode integration

cmux 0.65 can install its own OpenCode plugins with `cmux hooks setup` (or `cmux hooks opencode install`). They go in `~/.config/opencode/plugins/cmux-session.js` and `cmux-feed.js`. With those and this plugin both loaded, every finished turn shows two notifications. Keep one of them: remove cmux's with `cmux hooks opencode uninstall`, or remove `opencode-cmux` from `opencode.json`.

## OpenCode 2 background service

By default OpenCode 2 runs sessions in one shared background service, and plugins run inside it. The service keeps the cmux variables of the tab that started it, so notifications from other tabs open that first tab. Start OpenCode with `--standalone` to give each tab its own server and the right notification target.

## What it does

The sidebar uses the same states cmux shows for Claude Code and Codex.

| Event | cmux action |
|---|---|
| Session starts working or retries | Sidebar status: "Running" (blue, `bolt.fill`) |
| Session completes (primary) | Desktop notification with the start of the final response + log + sidebar status: "Idle" (gray, `pause.circle.fill`) |
| Session completes (subagent) | Log only (no notification spam) |
| Session error | Desktop notification with the error message + log + "Idle" |
| Session interrupted (Esc) | "Idle" (no notification) |
| Permission requested | Desktop notification + sidebar status: "Needs input" (blue, `bell.fill`) |
| AI has a question (`question` tool) | Desktop notification + "Needs input" |

"Needs input" stays until every pending permission and question is answered.

## How it works

The plugin responds to OpenCode lifecycle events by firing cmux CLI commands (`cmux rpc notification.create`, `cmux set-status`, etc.). Each action targets the current cmux workspace, providing ambient awareness of what OpenCode is doing without requiring you to switch context. All commands are no-ops when cmux is not running.

## License

MIT
