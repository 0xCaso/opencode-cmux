import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LSOF_LISTEN_RE } from "./lsof.js"
import { attachCommand, shell, toV1Event, v1Client } from "./v2.js"
import {
  notify,
  setStatus,
  log,
  createSplit,
  closeSurface,
  focusSurface,
  sendToSurface,
  sendKeyToSurface,
  type SplitDirection,
} from "./cmux.js"

type AttachCommand = (url: string, sessionID: string) => string | null

// The states cmux shows for its own Claude Code and Codex integrations (0.65).
const RUNNING = { icon: "bolt.fill", color: "#4C8DFF" }
const IDLE = { icon: "pause.circle.fill", color: "#8E8E93" }
const NEEDS_INPUT = { icon: "bell.fill", color: "#4C8DFF" }

const SUMMARY_LENGTH = 200
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Keeps per-message maps from growing for the whole life of the server.
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > 300) map.delete(map.keys().next().value as K)
}

const createPlugin = (attachCommand: AttachCommand): Plugin => async ({ client, $ }) => {
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()
  // Sessions whose turn ended in an error or abort. OpenCode still sends idle
  // afterwards (1.18 sends it twice), which must not become a Done.
  const failedSessions = new Set<string>()
  // The latest assistant message of each session, shown in the Done popup.
  const assistantMessages = new Map<string, string>()
  const responses = new Map<string, { messageID: string; parts: Map<string, string> }>()

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

  const showRunning = () => setStatus($, "opencode", "Running", RUNNING)
  const showIdle = () => setStatus($, "opencode", "Idle", IDLE)
  const showNeedsInput = () => setStatus($, "opencode", "Needs input", NEEDS_INPUT)

  function trackMessage(e: any): void {
    if (e.type === "message.updated") {
      const info = e.properties?.info
      if (info?.role !== "assistant" || typeof info.id !== "string") return
      if (typeof info.sessionID !== "string") return
      remember(assistantMessages, info.id, info.sessionID)
      if (responses.get(info.sessionID)?.messageID !== info.id)
        remember(responses, info.sessionID, { messageID: info.id, parts: new Map() })
      return
    }

    const part = e.properties?.part
    if (part?.type !== "text" || typeof part.id !== "string") return
    const sessionID = assistantMessages.get(part.messageID)
    const response = sessionID ? responses.get(sessionID) : undefined
    if (!response || response.messageID !== part.messageID) return
    const text = typeof part.text === "string" ? part.text.replace(/\s+/g, " ").trim() : ""
    response.parts.set(part.id, text)
  }

  // Takes the summary out, so a later turn never shows a stale response.
  function takeSummary(sessionID: string): string | undefined {
    const response = responses.get(sessionID)
    responses.delete(sessionID)
    const text = response ? [...response.parts.values()].filter(Boolean).join(" ") : ""
    if (!text) return undefined
    const chars = Array.from(graphemes.segment(text), ({ segment }) => segment)
    return chars.length > SUMMARY_LENGTH
      ? `${chars.slice(0, SUMMARY_LENGTH - 1).join("")}…`
      : text
  }

  function getPermissionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID ?? source.permissionID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  // OpenCode 1.18 sends the command as `patterns` with no `title`.
  function getPermissionTitle(source: any): string {
    if (typeof source?.title === "string" && source.title.trim() !== "") return source.title
    const name = source?.permission ?? source?.type ?? "command"
    const patterns = Array.isArray(source?.patterns) ? source.patterns : []
    return patterns.length > 0 ? `${name}: ${patterns.join(", ")}` : name
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
          const command = url ? attachCommand(url, info.id) : null
          if (command) {
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

              await sendToSurface($, surfaceId, command)
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
          failedSessions.delete(info.id)
          responses.delete(info.id)
          removeAndClose(info.id)
        }
        return
      }

      if (e.type === "session.status") {
        const { sessionID, status } = e.properties

        if (status.type === "busy" || status.type === "retry") {
          failedSessions.delete(sessionID)
          if (!isWaitingForInput()) await showRunning()
          return
        }

        if (status.type === "idle") {
          if (failedSessions.has(sessionID) || isWaitingForInput()) {
            return
          }

          const session = await fetchSession(sessionID)
          const title = session?.title || sessionID

          const summary = takeSummary(sessionID)

          if (!session?.parentID) {
            if (notifyOn.done)
              await notify($, {
                title: session?.title ? `Done: ${title}` : "Done",
                body: summary,
              })
            await log($, `Done: ${title}`, { level: "success", source: "opencode" })
            await showIdle()
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
        if (sessionID) {
          failedSessions.add(sessionID)
          responses.delete(sessionID)
        }

        // Esc in the TUI: the user is at the terminal, so no popup.
        const error = e.properties.error
        if (error?.name === "MessageAbortedError") {
          await showIdle()
          if (sessionID) removeAndClose(sessionID)
          return
        }

        const sessionTitle = sessionID ? (await fetchSession(sessionID))?.title : undefined
        const title = sessionTitle || sessionID || "unknown session"
        const message = error?.data?.message ?? error?.message
        const detail = typeof message === "string" && message !== "" ? message : undefined

        if (notifyOn.error)
          await notify($, {
            title: sessionTitle ? `Error: ${sessionTitle}` : "Error",
            subtitle: detail,
          })
        await log($, `Error in session: ${title}${detail ? `: ${detail}` : ""}`, {
          level: "error",
          source: "opencode",
        })
        await showIdle()

        if (sessionID) removeAndClose(sessionID)
        return
      }

      if (e.type === "permission.asked" || e.type === "permission.updated") {
        const id = getPermissionRequestID(e.properties)
        if (id && !pendingPermissions.has(id)) {
          pendingPermissions.add(id)
          const title = getPermissionTitle(e.properties)
          await showNeedsInput()
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

        if (!isWaitingForInput()) await showRunning()
        return
      }

      if (e.type === "question.asked") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.add(id)
        }

        const header = e.properties.questions?.[0]?.header ?? "Question"
        await showNeedsInput()
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

        if (!isWaitingForInput()) await showRunning()
        return
      }
    },

    async "permission.ask"(input) {
      const id = getPermissionRequestID(input as any)
      if (id) {
        pendingPermissions.add(id)
      }

      const title = getPermissionTitle(input)
      await showNeedsInput()
      if (notifyOn.permission)
        await notify($, { title: "Needs your permission", subtitle: title })
      await log($, `Permission requested: ${title}`, {
        level: "info",
        source: "opencode",
      })
    },
  }
}

const v1Plugin = createPlugin((url, sessionID) => `opencode attach ${url} --session ${sessionID}`)
const v2Plugin = createPlugin(attachCommand)

// OpenCode 1.18 calls both server() and setup(); only server() then delivers
// events, so setup() stays quiet to avoid a second set of notifications.
let serverStarted = false

// The default export is an object: v1 calls server(), v2 calls setup().
// Checked on OpenCode 1.17.8, 1.18.34 and 2.0.24.
export default {
  id: "opencode-cmux",
  server: ((input) => {
    serverStarted = true
    return v1Plugin(input)
  }) as Plugin,
  async setup(ctx: any) {
    const hooks = await v2Plugin({ client: v1Client(ctx.session), $: shell() } as any)

    // No permission hook: v2's "evaluate" runs for every tool call, including
    // allowed ones. permission.asked fires only when the user is prompted.
    const controller = new AbortController()
    void (async () => {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const event = toV1Event(raw)
        if (!event || !hooks.event || serverStarted) continue
        await hooks.event({ event } as any).catch(() => undefined)
      }
    })().catch(() => undefined)
    return () => controller.abort()
  },
}
