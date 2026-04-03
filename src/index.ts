import type { Plugin } from "@opencode-ai/plugin"
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

const plugin: Plugin = async (input) => {
  const { client, $ } = input
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()

  const originalSurfaceId = process.env.CMUX_SURFACE_ID

  // Resolve the server URL lazily (on each call) instead of at init time.
  // `serverUrl` is a getter on the plugin input that returns a fallback
  // (http://localhost:4096) until the HTTP server has actually bound to a
  // port.  Reading it later — when a subagent split is needed — gives the
  // getter time to return the real URL.
  // See: https://github.com/anomalyco/opencode/issues/9099
  function resolveServerUrl(): string | null {
    try {
      const raw =
        process.env.OPENCODE_SERVER_URL ?? input.serverUrl?.toString() ?? ""
      const parsed = new URL(raw)
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
      if (port === "0") return null
      if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") {
        parsed.hostname = "localhost"
      }
      return parsed.toString().replace(/\/$/, "")
    } catch {
      return null
    }
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
        const url = info?.parentID ? resolveServerUrl() : null
        if (info?.parentID && url) {
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
            await notify($, { title: `Done: ${title}` })
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

        await notify($, { title: `Error: ${title}` })
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
      await notify($, { title: "Needs your permission", subtitle: title })
      await log($, `Permission requested: ${title}`, {
        level: "info",
        source: "opencode",
      })
    },
  }
}

export default plugin
