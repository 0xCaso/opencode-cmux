import { existsSync } from "node:fs"
import type { PluginInput } from "@opencode-ai/plugin"

type Shell = PluginInput["$"]

const CMUX = ((): string => {
  const fromEnv = process.env.CMUX_BUNDLED_CLI_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  return "cmux"
})()

export function isInCmux(): boolean {
  return (
    existsSync(process.env.CMUX_SOCKET_PATH ?? "/tmp/cmux.sock") ||
    !!process.env.CMUX_WORKSPACE_ID
  )
}

/**
 * Which cmux workspace sidebar entries and notifications are addressed to.
 *
 * `id` is set when the workspace was resolved for the session; when it is
 * absent cmux falls back to the workspace recorded in the server environment.
 * `fromEnv` marks that fallback: only then is it safe to also pin the pane
 * surface, because a resolved workspace's surface usually lives in another tab.
 * `unmatched` marks a session whose directory belongs to no open workspace:
 * there is no right tab to point at, so the delivery is skipped entirely
 * instead of ringing the tab that started the service.
 */
export interface WorkspaceTarget {
  id?: string
  fromEnv: boolean
  unmatched?: boolean
}

/** The env-based target used when no workspace could be resolved. */
export function envWorkspaceTarget(): WorkspaceTarget {
  return { id: process.env.CMUX_WORKSPACE_ID || undefined, fromEnv: true }
}

interface WorkspaceInfo {
  id: string
  current_directory?: string
}

/** Parse the `cmux list-workspaces --json` output. */
function parseWorkspaces(output: string): WorkspaceInfo[] {
  const data = JSON.parse(output)
  return Array.isArray(data?.workspaces) ? data.workspaces : []
}

/** Parse the `cmux list-panels --json` output. */
function parsePanels(output: string): { title?: string }[] {
  const data = JSON.parse(output)
  return Array.isArray(data?.surfaces) ? data.surfaces : []
}

export async function listWorkspaces($: Shell): Promise<WorkspaceInfo[]> {
  if (!isInCmux()) return []
  try {
    const result = await $`${CMUX} list-workspaces --json`.quiet().nothrow()
    if (result.exitCode !== 0) return []
    return parseWorkspaces(String(result.stdout ?? ""))
  } catch {
    return []
  }
}

export async function listPanels(
  $: Shell,
  workspaceId: string,
): Promise<{ title?: string }[]> {
  if (!isInCmux()) return []
  try {
    const result =
      await $`${CMUX} list-panels --workspace ${workspaceId} --json`.quiet().nothrow()
    if (result.exitCode !== 0) return []
    return parsePanels(String(result.stdout ?? ""))
  } catch {
    return []
  }
}

/**
 * Resolve the cmux workspace that owns a session directory.
 *
 * With OpenCode's shared background service the plugin's environment holds the
 * cmux variables of whichever tab started the service, so notifications from
 * other tabs would target the first tab. Matching the session's working
 * directory against the open workspaces gives the right tab without needing
 * `opencode --standalone`. When several workspaces share a directory, prefer
 * the one that actually runs an OpenCode TUI (the TUI titles its pane "OC | …").
 */
export async function resolveWorkspaceByDirectory(
  $: Shell,
  directory: string,
): Promise<WorkspaceTarget> {
  try {
    const workspaces = await listWorkspaces($)
    const dirs = workspaces.filter(
      (w): w is WorkspaceInfo & { current_directory: string } =>
        typeof w.current_directory === "string",
    )
    // Prefer an exact match, then the longest prefix: with workspaces at
    // /repo and /repo/pkg, a session in /repo/pkg belongs to the latter.
    let candidates = dirs.filter((w) => w.current_directory === directory)
    if (candidates.length === 0) {
      const prefixed = dirs.filter((w) =>
        directory.startsWith(w.current_directory + "/"),
      )
      const longest = prefixed.reduce(
        (n, w) => Math.max(n, w.current_directory.length),
        0,
      )
      candidates = prefixed.filter(
        (w) => w.current_directory.length === longest,
      )
    }
    if (candidates.length === 1) {
      return { id: candidates[0].id, fromEnv: false }
    }
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        const panels = await listPanels($, candidate.id)
        // Only the TUI's own "OC | …" title counts: a pane whose title merely
        // mentions "opencode" (e.g. a shell in this repo) is not a TUI.
        const runsOpenCode = panels.some(
          (p) => typeof p.title === "string" && /^\s*OC\s*\|/.test(p.title),
        )
        if (runsOpenCode) return { id: candidate.id, fromEnv: false }
      }
      return { id: candidates[0].id, fromEnv: false }
    }
    // The session runs outside every open workspace (e.g. a temp directory).
    // Ringing the tab that started the service would be wrong, so skip.
    return { id: undefined, fromEnv: true, unmatched: true }
  } catch {
    // fall through to the env target
  }
  return envWorkspaceTarget()
}

async function getPaneLabel($: Shell): Promise<string> {
  const tmuxPane = process.env.TMUX_PANE
  if (!tmuxPane) return ""
  try {
    const result =
      await $`tmux display-message -p -t ${tmuxPane} -F '#{session_name}:#{window_index} #{pane_id}'`
        .quiet()
        .nothrow()
    if (result.exitCode === 0) {
      const text = result.stdout?.toString?.()?.trim?.()
      if (text) return `[${text}]`
    }
  } catch {}
  return `[${tmuxPane}]`
}

export async function notify(
  $: Shell,
  opts: { title: string; subtitle?: string; body?: string },
  workspace?: WorkspaceTarget,
): Promise<void> {
  if (!isInCmux() || workspace?.unmatched) return
  try {
    const prefix = await getPaneLabel($)
    const bodyParts: string[] = []
    if (opts.subtitle !== undefined) bodyParts.push(opts.subtitle)
    if (opts.body !== undefined) bodyParts.push(opts.body)
    const baseBody = bodyParts.join(" — ")
    const body = prefix
      ? baseBody
        ? `${prefix} ${baseBody}`
        : prefix
      : baseBody
    // Without a target cmux attaches the notification to whatever tab is
    // focused when it fires, so clicking it opens the wrong tab.
    // Only pin the pane surface for the env-based target: a resolved
    // workspace's original surface usually lives in another tab.
    const payload = JSON.stringify({
      title: opts.title,
      body,
      workspace_id: (workspace?.id || process.env.CMUX_WORKSPACE_ID) || undefined,
      surface_id:
        workspace && !workspace.fromEnv
          ? undefined
          : process.env.CMUX_SURFACE_ID || undefined,
    })
    await $`${CMUX} rpc notification.create ${payload}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function setStatus(
  $: Shell,
  key: string,
  text: string,
  opts?: { icon?: string; color?: string },
  workspace?: WorkspaceTarget,
): Promise<void> {
  if (!isInCmux() || workspace?.unmatched) return
  try {
    const args: string[] = [key, text]
    if (opts?.icon !== undefined) args.push("--icon", opts.icon)
    if (opts?.color !== undefined) args.push("--color", opts.color)
    // Only resolved workspaces need explicit addressing; the env target is
    // already cmux's default, so keep the argv unchanged for it.
    if (workspace && !workspace.fromEnv && workspace.id)
      args.push("--workspace", workspace.id)
    await $`${CMUX} set-status ${args}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function clearStatus($: Shell, key: string): Promise<void> {
  if (!isInCmux()) return
  try {
    await $`${CMUX} clear-status ${key}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function log(
  $: Shell,
  message: string,
  opts?: { level?: "info" | "success" | "error" | "warn"; source?: string },
  workspace?: WorkspaceTarget,
): Promise<void> {
  if (!isInCmux() || workspace?.unmatched) return
  try {
    const args: string[] = []
    if (opts?.level !== undefined) {
      // cmux uses "warning" but we expose "warn" for ergonomics
      const level = opts.level === "warn" ? "warning" : opts.level
      args.push("--level", level)
    }
    if (opts?.source !== undefined) args.push("--source", opts.source)
    // Only resolved workspaces need explicit addressing; the env target is
    // already cmux's default, so keep the argv unchanged for it.
    if (workspace && !workspace.fromEnv && workspace.id)
      args.push("--workspace", workspace.id)
    args.push("--", message)
    await $`${CMUX} log ${args}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export type SplitDirection = "right" | "down"

/**
 * Create a new split pane. Returns the new surface ref (e.g. "surface:5"),
 * or `null` on failure. When `fromSurface` is provided the split is created
 * relative to that surface instead of the currently focused one.
 */
export async function createSplit(
  $: Shell,
  direction: SplitDirection,
  fromSurface?: string,
): Promise<string | null> {
  if (!isInCmux()) return null
  try {
    const args: string[] = [direction]
    if (fromSurface) args.push("--surface", fromSurface)
    const result = await $`${CMUX} new-split ${args}`.quiet().nothrow()
    const text = result.text().trim()
    if (!text) return null
    // Output format: "OK surface:<n> workspace:<n>"
    const match = text.match(/surface:\S+/)
    return match ? match[0] : null
  } catch {
    return null
  }
}

export async function focusSurface(
  $: Shell,
  surfaceId: string,
): Promise<void> {
  if (!isInCmux()) return
  try {
    await $`${CMUX} focus-surface --surface ${surfaceId}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function sendToSurface(
  $: Shell,
  surfaceId: string,
  text: string,
): Promise<void> {
  if (!isInCmux()) return
  try {
    const args = ["--surface", surfaceId, text]
    await $`${CMUX} send ${args}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function sendKeyToSurface(
  $: Shell,
  surfaceId: string,
  key: string,
): Promise<void> {
  if (!isInCmux()) return
  try {
    await $`${CMUX} send-key --surface ${surfaceId} ${key}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function closeSurface(
  $: Shell,
  surfaceId: string,
): Promise<void> {
  if (!isInCmux()) return
  try {
    await $`${CMUX} close-surface --surface ${surfaceId}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}
