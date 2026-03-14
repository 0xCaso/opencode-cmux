import type { Plugin } from "@opencode-ai/plugin"
import { notify, setStatus, clearStatus, log } from "./cmux.js"

const plugin: Plugin = async ({ client, $ }) => {
  // Track pending user-input requests so that session.status "idle" events
  // (which fire while the model is not generating) don't prematurely clear
  // the sidebar or send spurious "Done" notifications.
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()

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

      // Handle session status changes (busy/idle/retry)
      if (e.type === "session.status") {
        const { sessionID, status } = e.properties

        if (status.type === "busy") {
          // Only set "working" if we're not already waiting for user input;
          // the more-specific waiting/question status should take priority.
          if (!isWaitingForInput()) {
            await setStatus($, "opencode", "working", {
              icon: "terminal",
              color: "#f59e0b",
            })
          }
          return
        }

        if (status.type === "idle") {
          // If we're waiting for user input (permission prompt or question),
          // the session goes idle because the model is not generating — but
          // we are NOT done. Keep the current sidebar status and skip the
          // "Done" notification.
          if (isWaitingForInput()) {
            return
          }

          const session = await fetchSession(sessionID)
          const title = session?.title ?? sessionID

          if (!session?.parentID) {
            // Primary session
            await notify($, { title: `Done: ${title}` })
            await log($, `Done: ${title}`, { level: "success", source: "opencode" })
            await clearStatus($, "opencode")
          } else {
            // Subagent session — log only, no notify/clearStatus to avoid spam
            await log($, `Subagent finished: ${title}`, {
              level: "info",
              source: "opencode",
            })
          }
          return
        }
      }

      // Handle session errors
      if (e.type === "session.error") {
        // Clear any pending state — the session errored out
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
        return
      }

      // Handle permission events (belt-and-suspenders with the permission.ask hook)
      // v2: "permission.asked", v1: "permission.updated"
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
          // No more pending input — restore "working" since the session will
          // resume, or let the next idle event handle cleanup.
          await setStatus($, "opencode", "working", {
            icon: "terminal",
            color: "#f59e0b",
          })
        }
        return
      }

      // Handle question events
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
      // The hook fires synchronously in the permission pipeline, before the
      // event. Record it eagerly so the idle-suppression logic is already
      // active when session.status arrives.
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
      // Return undefined — do not block the permission
    },
  }
}

export default plugin
