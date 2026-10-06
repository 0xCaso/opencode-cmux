import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

// Payloads below are copied from events captured on OpenCode 1.18.34.
const sessionID = "ses_eef020b9fffesyAQ1mSbjmikXI"

beforeAll(() => {
  process.env.CMUX_WORKSPACE_ID = "workspace:test"
  process.env.CMUX_SURFACE_ID = "surface:test"
  process.env.TMUX_PANE = ""
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "opencode-cmux-events-"))
})

// Records each cmux call as argv, minus the cmux binary.
function recordingShell() {
  const calls: string[][] = []
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const argv: string[] = []
    strings.forEach((part, i) => {
      argv.push(...part.split(/\s+/).filter(Boolean))
      if (i < values.length) {
        const value = values[i]
        if (Array.isArray(value)) argv.push(...value.map(String))
        else argv.push(String(value))
      }
    })
    calls.push(argv.slice(1))
    const result = { exitCode: 0, stdout: "", text: () => "" }
    const out: any = {
      quiet: () => out,
      nothrow: () => out,
      text: async () => "",
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return out
  }
  return { $, calls }
}

async function run(events: { type: string; properties: any }[], title?: string) {
  const { $, calls } = recordingShell()
  const client = {
    session: { get: async () => ({ data: { id: sessionID, title: title ?? "Titolo di prova" } }) },
  }
  const hooks = await (plugin as any).server({ client, $ })
  for (const event of events) await hooks.event({ event })
  return calls
}

const busy = { type: "session.status", properties: { sessionID, status: { type: "busy" } } }
const idle = { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
const notifications = (calls: string[][]) =>
  calls.filter((c) => c[1] === "notification.create").map((c) => JSON.parse(c[2]!))

test("a failed turn notifies the error once and no Done", async () => {
  const error = {
    type: "session.error",
    properties: {
      sessionID,
      error: { name: "APIError", data: { message: "mock bad request", statusCode: 400 } },
    },
  }
  // OpenCode 1.18 sends two idle events after an error.
  const calls = await run([busy, error, idle, idle])
  expect(notifications(calls)).toEqual([
    {
      title: "Error: Titolo di prova",
      body: "mock bad request",
      workspace_id: "workspace:test",
      surface_id: "surface:test",
    },
  ])
  expect(calls).toContainEqual([
    "log", "--level", "error", "--source", "opencode", "--",
    "Error in session: Titolo di prova: mock bad request",
  ])
})

test("pressing Esc clears the status without notifying", async () => {
  const permission = {
    type: "permission.asked",
    properties: { id: "per_1", sessionID, permission: "bash", patterns: ["date"] },
  }
  const aborted = {
    type: "session.error",
    properties: { sessionID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
  }
  const calls = await run([busy, permission, aborted, idle, idle])
  expect(notifications(calls).map((n) => n.title)).toEqual(["Needs your permission"])
  expect(calls.at(-1)).toEqual(["clear-status", "opencode"])
})

test("the next turn after an error still notifies Done", async () => {
  const error = { type: "session.error", properties: { sessionID, error: { name: "APIError" } } }
  const calls = await run([busy, error, idle, busy, idle])
  expect(notifications(calls).map((n) => n.title)).toEqual([
    "Error: Titolo di prova",
    "Done: Titolo di prova",
  ])
})

test("permission without a title shows the command", async () => {
  const calls = await run([
    {
      type: "permission.asked",
      properties: { id: "per_2", sessionID, permission: "bash", patterns: ["date", "ls -la"] },
    },
  ])
  expect(notifications(calls)[0]).toMatchObject({
    title: "Needs your permission",
    body: "bash: date, ls -la",
  })
})

test("permission title from OpenCode wins over the patterns", async () => {
  const calls = await run([
    {
      type: "permission.updated",
      properties: { id: "per_3", sessionID, type: "bash", title: "echo hi", pattern: "echo *" },
    },
  ])
  expect(notifications(calls)[0]).toMatchObject({ body: "echo hi" })
})

// v2 names the session after a short turn has already finished.
test("a session with no title yet is not shown by its id", async () => {
  const error = { type: "session.error", properties: { sessionID, error: { name: "APIError" } } }
  const calls = await run([busy, idle, busy, error], "")
  expect(notifications(calls).map((n) => n.title)).toEqual(["Done", "Error"])
  expect(calls).toContainEqual(["log", "--level", "success", "--source", "opencode", "--", `Done: ${sessionID}`])
})
