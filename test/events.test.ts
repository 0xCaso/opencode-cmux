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
const statuses = (calls: string[][]) => calls.filter((c) => c[0] === "set-status")

// The states cmux uses for its own Claude Code and Codex integrations.
const runningStatus = ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"]
const idleStatus = ["set-status", "opencode", "Idle", "--icon", "pause.circle.fill", "--color", "#8E8E93"]
const needsInputStatus = ["set-status", "opencode", "Needs input", "--icon", "bell.fill", "--color", "#4C8DFF"]

const assistant = (id: string, session = sessionID) => ({
  type: "message.updated",
  properties: { sessionID: session, info: { id, sessionID: session, role: "assistant" } },
})
const text = (messageID: string, id: string, value: string, session = sessionID) => ({
  type: "message.part.updated",
  properties: { sessionID: session, part: { id, sessionID: session, messageID, type: "text", text: value } },
})

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
  expect(calls.at(-1)).toEqual(idleStatus)
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

test("statuses match cmux's Running, Idle and Needs input", async () => {
  const retry = { type: "session.status", properties: { sessionID, status: { type: "retry", attempt: 1 } } }
  const calls = await run([busy, retry, idle])
  expect(statuses(calls)).toEqual([runningStatus, runningStatus, idleStatus])
  expect(calls).not.toContainEqual(["clear-status", "opencode"])
})

test("Needs input stays until every permission and question is answered", async () => {
  const calls = await run([
    busy,
    { type: "permission.asked", properties: { id: "per_1", sessionID, permission: "bash", patterns: ["ls"] } },
    { type: "question.asked", properties: { id: "que_1", sessionID, questions: [{ header: "Pick one" }] } },
    { type: "permission.replied", properties: { sessionID, requestID: "per_1", reply: "once" } },
    { type: "question.replied", properties: { id: "que_1", sessionID } },
  ])
  expect(statuses(calls)).toEqual([runningStatus, needsInputStatus, needsInputStatus, runningStatus])
})

test("Done shows the final assistant response", async () => {
  const user = { type: "message.updated", properties: { sessionID, info: { id: "msg_u", sessionID, role: "user" } } }
  const calls = await run([
    busy,
    user,
    text("msg_u", "prt_u", "the prompt"),
    assistant("msg_a1"),
    text("msg_a1", "prt_1", "Looking at the files."),
    assistant("msg_a2"),
    text("msg_a2", "prt_2", ""),
    text("msg_a2", "prt_2", " All\n  tests pass. "),
    text("msg_a2", "prt_3", "Done."),
    idle,
  ])
  expect(notifications(calls)[0]).toMatchObject({
    title: "Done: Titolo di prova",
    body: "All tests pass. Done.",
  })
})

test("a long response is cut at 200 characters without splitting an emoji", async () => {
  const family = "👨‍👩‍👧‍👦"
  const calls = await run([busy, assistant("msg_a"), text("msg_a", "prt_1", `${"a".repeat(198)}${family}more`), idle])
  expect(notifications(calls)[0].body).toBe(`${"a".repeat(198)}${family}…`)
})

test("an errored turn's response does not show in the next Done", async () => {
  const error = { type: "session.error", properties: { sessionID, error: { name: "APIError" } } }
  const calls = await run([busy, assistant("msg_a"), text("msg_a", "prt_1", "half an answer"), error, idle, busy, idle])
  expect(notifications(calls).map((n) => n.body)).toEqual(["", ""])
  expect(statuses(calls)).toEqual([runningStatus, idleStatus, runningStatus, idleStatus])
})

test("a subagent finishing leaves the status alone", async () => {
  const { $, calls } = recordingShell()
  const client = {
    session: { get: async () => ({ data: { id: "ses_child", title: "Child", parentID: sessionID } }) },
  }
  const hooks = await (plugin as any).server({ client, $ })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } } })
  expect(notifications(calls)).toEqual([])
  expect(statuses(calls)).toEqual([])
})
