import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LSOF_LISTEN_RE } from "./lsof.js"
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

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function addBounded(set: Set<string>, value: string): void {
  set.add(value)
  if (set.size > 300) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

const plugin: Plugin = async ({ client, $ }) => {
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()
  const messageRoles = new Map<string, { sessionID: string; role: string }>()
  const assistantResponses = new Map<string, { messageID: string; parts: Map<string, string> }>()
  const erroredSessions = new Set<string>()
  const suppressedIdleAfterError = new Set<string>()
  const runningSessions = new Set<string>()

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
    // Respect XDG_CONFIG_HOME, fall back to ~/.config per the XDG Base
    // Directory Specification (https://specifications.freedesktop.org/basedir-spec/).
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const configPath = join(configDir, "opencode", "opencode-cmux.json")
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
        const match = line.match(LSOF_LISTEN_RE)
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

  function normalizeText(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized || undefined
  }

  function getAssistantSummary(sessionID: string): string | undefined {
    const response = assistantResponses.get(sessionID)
    if (!response) return undefined

    const joined = [...response.parts.values()].filter(Boolean).join(" ")
    if (!joined) return undefined
    const characters = Array.from(graphemeSegmenter.segment(joined), ({ segment }) => segment)
    return characters.length > 200 ? `${characters.slice(0, 199).join("")}…` : joined
  }

  function clearAssistantResponse(sessionID: string): void {
    assistantResponses.delete(sessionID)
  }

  function trackMessage(e: any): void {
    if (e.type === "message.updated") {
      const info = e.properties?.info ?? e.properties?.message ?? {}
      const messageID = info.id ?? e.properties?.messageID
      const sessionID = info.sessionID ?? e.properties?.sessionID
      const role = info.role ?? e.properties?.role

      if (
        typeof messageID === "string" &&
        typeof sessionID === "string" &&
        typeof role === "string"
      ) {
        messageRoles.set(messageID, { sessionID, role })
        if (messageRoles.size > 300) {
          const oldestMessageID = messageRoles.keys().next().value
          if (oldestMessageID !== undefined) messageRoles.delete(oldestMessageID)
        }

        if (role === "assistant") {
          const response = assistantResponses.get(sessionID)
          if (!response || response.messageID !== messageID) {
            assistantResponses.set(sessionID, { messageID, parts: new Map() })
            if (assistantResponses.size > 300) {
              const oldestSessionID = assistantResponses.keys().next().value
              if (oldestSessionID !== undefined) assistantResponses.delete(oldestSessionID)
            }
          }
        }
      }
      return
    }

    if (e.type !== "message.part.updated") return

    const part = e.properties?.part
    if (
      part?.type !== "text" ||
      typeof part.messageID !== "string" ||
      typeof part.id !== "string"
    )
      return

    const message = messageRoles.get(part.messageID)
    if (message?.role !== "assistant") return

    const response = assistantResponses.get(message.sessionID)
    if (!response || response.messageID !== part.messageID) return

    response.parts.set(part.id, normalizeText(part.text || part.textDelta || part.content) ?? "")
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

      if (e.type === "message.updated" || e.type === "message.part.updated") {
        trackMessage(e)
        return
      }

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
        if (info?.id) {
          clearAssistantResponse(info.id)
          erroredSessions.delete(info.id)
          suppressedIdleAfterError.delete(info.id)
          runningSessions.delete(info.id)
          removeAndClose(info.id)
        }
        return
      }

      if (e.type === "session.status") {
        const { sessionID, status } = e.properties

        if (status.type === "busy" || status.type === "retry") {
          erroredSessions.delete(sessionID)
          suppressedIdleAfterError.delete(sessionID)
          if (!runningSessions.has(sessionID)) {
            runningSessions.add(sessionID)
            clearAssistantResponse(sessionID)
          }
          if (!isWaitingForInput()) {
            await setStatus($, "opencode", "Running", {
              icon: "bolt.fill",
              color: "#4C8DFF",
            })
          }
          return
        }

        if (status.type === "idle") {
          runningSessions.delete(sessionID)
          if (erroredSessions.has(sessionID)) {
            erroredSessions.delete(sessionID)
            addBounded(suppressedIdleAfterError, sessionID)
            clearAssistantResponse(sessionID)
            await setStatus($, "opencode", "Idle", {
              icon: "pause.circle.fill",
              color: "#8E8E93",
            })
            return
          }

          if (suppressedIdleAfterError.has(sessionID)) {
            clearAssistantResponse(sessionID)
            return
          }

          if (isWaitingForInput()) {
            return
          }

          const session = await fetchSession(sessionID)
          const title = session?.title ?? sessionID

          if (!session?.parentID) {
            if (notifyOn.done) {
              await notify($, {
                title: `Done: ${title}`,
                body: getAssistantSummary(sessionID),
              })
            }
            await log($, `Done: ${title}`, { level: "success", source: "opencode" })
            await setStatus($, "opencode", "Idle", {
              icon: "pause.circle.fill",
              color: "#8E8E93",
            })
          } else {
            await log($, `Subagent finished: ${title}`, {
              level: "info",
              source: "opencode",
            })

            removeAndClose(sessionID)
          }
          clearAssistantResponse(sessionID)
          return
        }
      }

      if (e.type === "session.error") {
        pendingPermissions.clear()
        pendingQuestions.clear()

        const sessionID = e.properties.sessionID
        if (sessionID) {
          runningSessions.delete(sessionID)
          addBounded(erroredSessions, sessionID)
          clearAssistantResponse(sessionID)
        }
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
          await setStatus($, "opencode", "Needs input", {
            icon: "bell.fill",
            color: "#4C8DFF",
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
          await setStatus($, "opencode", "Running", {
            icon: "bolt.fill",
            color: "#4C8DFF",
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
        await setStatus($, "opencode", "Needs input", {
          icon: "bell.fill",
          color: "#4C8DFF",
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
          await setStatus($, "opencode", "Running", {
            icon: "bolt.fill",
            color: "#4C8DFF",
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
      await setStatus($, "opencode", "Needs input", {
        icon: "bell.fill",
        color: "#4C8DFF",
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
