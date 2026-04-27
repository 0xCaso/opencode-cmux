import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import {
  notify,
  setStatus,
  clearStatus,
  log,
  createSplit,
  closeSurface,
  focusSurface,
  sendToSurface,
  sendKeyToSurface,
  type SplitDirection,
} from "./cmux.js"

const plugin: Plugin = async ({ client, $ }) => {
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()

  const originalSurfaceId = process.env.CMUX_SURFACE_ID

  // Read plugin config (once at init)
  let splitsEnabled = false
  const notifyOn: { done: boolean; permission: boolean; question: boolean; error: boolean } = {
    done: true,
    permission: true,
    question: true,
    error: true,
  }
  try {
    const configPath = `${homedir()}/.config/opencode/opencode-cmux.json`
    const raw = readFileSync(configPath, "utf-8")
    const config = JSON.parse(raw)
    if (config.splits === true) {
      splitsEnabled = true
    }
    if (config.notifications !== undefined) {
      if (
        typeof config.notifications === "object" &&
        config.notifications !== null &&
        !Array.isArray(config.notifications)
      ) {
        const n = config.notifications as Record<string, unknown>
        for (const key of ["done", "permission", "question", "error"] as const) {
          const v = n[key]
          if (v === undefined) continue
          if (v === false) notifyOn[key] = false
          else if (v === true) notifyOn[key] = true
          else {
            console.warn(
              `[opencode-cmux] config.notifications.${key} ignored: expected boolean, got ${typeof v}`,
            )
          }
        }
      } else {
        const got = Array.isArray(config.notifications)
          ? "array"
          : typeof config.notifications
        console.warn(
          `[opencode-cmux] config.notifications ignored: expected object, got ${got}`,
        )
      }
    }
  } catch {
    // File missing, unreadable, or invalid JSON — use defaults
  }

  // Discover the actual server URL for `opencode attach`.
  //
  // The TUI does not start an HTTP server unless --port is passed.
  // Neither the serverUrl plugin input nor the SDK client baseUrl are
  // reliable — both report http://localhost:4096 regardless of the
  // actual bound port (the SDK uses in-process fetch, not HTTP).
  //
  // We use lsof to find the TCP port this process is actually listening on.
  // Returns null when no HTTP server is running (splits are skipped).
  // See: https://github.com/anomalyco/opencode/issues/9099
  let discoveredServerUrl: string | null | undefined
  function resolveServerUrl(): string | null {
    if (discoveredServerUrl !== undefined) return discoveredServerUrl

    // 1. Env var (future-proof for when anomalyco/opencode#9099 lands)
    if (process.env.OPENCODE_SERVER_URL) {
      try {
        const parsed = new URL(process.env.OPENCODE_SERVER_URL)
        if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") {
          parsed.hostname = "localhost"
        }
        discoveredServerUrl = parsed.toString().replace(/\/$/, "")
        return discoveredServerUrl
      } catch {}
    }

    // 2. Find the TCP port this process is listening on via lsof.
    //    Use -a to AND the -p and -iTCP filters (macOS lsof ORs by default).
    try {
      const out = execSync(
        `lsof -nP -a -p ${process.pid} -iTCP -sTCP:LISTEN 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 },
      )
      for (const line of out.split("\n")) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/)
        if (match) {
          discoveredServerUrl = `http://localhost:${match[1]}`
          return discoveredServerUrl
        }
      }
    } catch {}

    discoveredServerUrl = null
    return null
  }

  const activeSplits = new Map<string, string>()

  // Rightmost surface in each of the 3 rows (top-right, bottom-right, bottom-left)
  // Used as split targets when adding new columns
  const rowFrontier: (string | undefined)[] = [undefined, undefined, undefined]
  let agentCount = 0

  let splitQueue = Promise.resolve<unknown>(undefined)
  function enqueueSplitOp<T>(fn: () => Promise<T>): Promise<T> {
    const result = splitQueue.then(fn, fn)
    splitQueue = result.then(
      () => {},
      () => {},
    )
    return result as Promise<T>
  }

  function resetGridState(): void {
    rowFrontier[0] = undefined
    rowFrontier[1] = undefined
    rowFrontier[2] = undefined
    agentCount = 0
  }

  function removeAndClose(sessionId: string): void {
    const surfaceId = activeSplits.get(sessionId)
    if (!surfaceId) return
    activeSplits.delete(sessionId)
    closeSurface($, surfaceId).catch(() => {})
    if (activeSplits.size === 0) {
      resetGridState()
    }
  }

  function isWaitingForInput(): boolean {
    return pendingPermissions.size > 0 || pendingQuestions.size > 0
  }

  function getPermissionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID ?? source.permissionID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  function getQuestionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  async function fetchSession(
    sessionID: string,
  ): Promise<{ title: string; parentID?: string } | null> {
    try {
      const result = await client.session.get({ path: { id: sessionID } })
      if (result.data) {
        return { title: result.data.title, parentID: result.data.parentID }
      }
      return null
    } catch {
      return null
    }
  }

  return {
    async event({ event }) {
      const e = event as any

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

      if (e.type === "session.deleted") {
        const info = e.properties.info
        if (info?.id) removeAndClose(info.id)
        return
      }

      if (e.type === "session.status") {
        const { sessionID, status } = e.properties

        if (status.type === "busy") {
          if (!isWaitingForInput()) {
            await setStatus($, "opencode", "working", {
              icon: "terminal",
              color: "#f59e0b",
            })
          }
          return
        }

        if (status.type === "idle") {
          if (isWaitingForInput()) {
            return
          }

          const session = await fetchSession(sessionID)
          const title = session?.title ?? sessionID

          if (!session?.parentID) {
            if (notifyOn.done) await notify($, { title: `Done: ${title}` })
            await log($, `Done: ${title}`, { level: "success", source: "opencode" })
            await clearStatus($, "opencode")
          } else {
            await log($, `Subagent finished: ${title}`, {
              level: "info",
              source: "opencode",
            })

            removeAndClose(sessionID)
          }
          return
        }
      }

      if (e.type === "session.error") {
        pendingPermissions.clear()
        pendingQuestions.clear()

        const sessionID = e.properties.sessionID
        const title = sessionID
          ? (await fetchSession(sessionID))?.title ?? sessionID
          : "unknown session"

        if (notifyOn.error) await notify($, { title: `Error: ${title}` })
        await log($, `Error in session: ${title}`, {
          level: "error",
          source: "opencode",
        })
        await clearStatus($, "opencode")

        if (sessionID) removeAndClose(sessionID)
        return
      }

      if (e.type === "permission.asked" || e.type === "permission.updated") {
        const id = getPermissionRequestID(e.properties)
        if (id && !pendingPermissions.has(id)) {
          pendingPermissions.add(id)
          const title = e.properties.title ?? e.properties.permission ?? "command"
          await setStatus($, "opencode", "waiting", {
            icon: "lock",
            color: "#ef4444",
          })
          if (notifyOn.permission)
            await notify($, { title: "Needs your permission", subtitle: title })
          await log($, `Permission requested: ${title}`, {
            level: "info",
            source: "opencode",
          })
        }
        return
      }

      if (e.type === "permission.replied") {
        const id = getPermissionRequestID(e.properties)
        if (id) {
          pendingPermissions.delete(id)
        }

        if (!isWaitingForInput()) {
          await setStatus($, "opencode", "working", {
            icon: "terminal",
            color: "#f59e0b",
          })
        }
        return
      }

      if (e.type === "question.asked") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.add(id)
        }

        const header = e.properties.questions?.[0]?.header ?? "Question"
        await setStatus($, "opencode", "question", {
          icon: "help-circle",
          color: "#a855f7",
        })
        if (notifyOn.question)
          await notify($, { title: "Has a question", subtitle: header })
        await log($, `Question: ${header}`, { level: "info", source: "opencode" })
        return
      }

      if (e.type === "question.replied" || e.type === "question.rejected") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.delete(id)
        }

        if (!isWaitingForInput()) {
          await setStatus($, "opencode", "working", {
            icon: "terminal",
            color: "#f59e0b",
          })
        }
        return
      }
    },

    async "permission.ask"(input) {
      const id = getPermissionRequestID(input as any)
      if (id) {
        pendingPermissions.add(id)
      }

      const title = (input as any).title ?? (input as any).permission ?? "command"
      await setStatus($, "opencode", "waiting", {
        icon: "lock",
        color: "#ef4444",
      })
      if (notifyOn.permission)
        await notify($, { title: "Needs your permission", subtitle: title })
      await log($, `Permission requested: ${title}`, {
        level: "info",
        source: "opencode",
      })
    },
  }
}

export default plugin
