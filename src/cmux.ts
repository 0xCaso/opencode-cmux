import { existsSync } from "node:fs"
import type { PluginInput } from "@opencode-ai/plugin"

type Shell = PluginInput["$"]

export function isInCmux(): boolean {
  return (
    existsSync(process.env.CMUX_SOCKET_PATH ?? "/tmp/cmux.sock") ||
    !!process.env.CMUX_WORKSPACE_ID
  )
}

export async function notify(
  $: Shell,
  opts: { title: string; subtitle?: string; body?: string },
): Promise<void> {
  if (!isInCmux()) return
  try {
    const args: string[] = ["--title", opts.title]
    if (opts.subtitle !== undefined) args.push("--subtitle", opts.subtitle)
    if (opts.body !== undefined) args.push("--body", opts.body)
    await $`cmux notify ${args}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function setStatus(
  $: Shell,
  key: string,
  text: string,
  opts?: { icon?: string; color?: string },
): Promise<void> {
  if (!isInCmux()) return
  try {
    const args: string[] = [key, text]
    if (opts?.icon !== undefined) args.push("--icon", opts.icon)
    if (opts?.color !== undefined) args.push("--color", opts.color)
    await $`cmux set-status ${args}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function clearStatus($: Shell, key: string): Promise<void> {
  if (!isInCmux()) return
  try {
    await $`cmux clear-status ${key}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}

export async function log(
  $: Shell,
  message: string,
  opts?: { level?: "info" | "success" | "error" | "warn"; source?: string },
): Promise<void> {
  if (!isInCmux()) return
  try {
    const args: string[] = []
    if (opts?.level !== undefined) {
      // cmux uses "warning" but we expose "warn" for ergonomics
      const level = opts.level === "warn" ? "warning" : opts.level
      args.push("--level", level)
    }
    if (opts?.source !== undefined) args.push("--source", opts.source)
    args.push("--", message)
    await $`cmux log ${args}`.quiet().nothrow()
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
    const result = await $`cmux new-split ${args}`.quiet().nothrow()
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
    await $`cmux focus-surface --surface ${surfaceId}`.quiet().nothrow()
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
    await $`cmux send ${args}`.quiet().nothrow()
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
    await $`cmux send-key --surface ${surfaceId} ${key}`.quiet().nothrow()
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
    await $`cmux close-surface --surface ${surfaceId}`.quiet().nothrow()
  } catch {
    // swallow errors silently
  }
}
