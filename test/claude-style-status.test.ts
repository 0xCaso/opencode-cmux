import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

type Call = string[]

const originalEnv = {
  CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
  TMUX_PANE: process.env.TMUX_PANE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
}

let configHome = ""

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), "opencode-cmux-status-"))
  mkdirSync(join(configHome, "opencode"))
  writeFileSync(
    join(configHome, "opencode", "opencode-cmux.json"),
    JSON.stringify({ notifications: { done: true, permission: true, question: true } }),
  )
  process.env.CMUX_WORKSPACE_ID = "test-workspace"
  delete process.env.TMUX_PANE
  process.env.XDG_CONFIG_HOME = configHome
})

afterAll(() => {
  if (originalEnv.CMUX_WORKSPACE_ID === undefined) delete process.env.CMUX_WORKSPACE_ID
  else process.env.CMUX_WORKSPACE_ID = originalEnv.CMUX_WORKSPACE_ID
  if (originalEnv.TMUX_PANE === undefined) delete process.env.TMUX_PANE
  else process.env.TMUX_PANE = originalEnv.TMUX_PANE
  if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME
  rmSync(configHome, { recursive: true, force: true })
})

function shellFor(calls: Call[]) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const argv: string[] = []
    const addStatic = (value: string) => {
      const tokens = value.trim().split(/\s+/).filter(Boolean)
      argv.push(...tokens)
    }

    addStatic(strings[0] ?? "")
    values.forEach((value, index) => {
      if (Array.isArray(value)) argv.push(...value.map(String))
      else argv.push(String(value))
      addStatic(strings[index + 1] ?? "")
    })

    calls.push(argv)
    return {
      quiet() {
        return this
      },
      nothrow: async () => ({
        exitCode: 0,
        stdout: Buffer.from(""),
        text: () => "",
      }),
    }
  }) as any
}

function clientFor(sessions: Record<string, { title: string; parentID?: string }>) {
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: sessions[path.id] }),
    },
  }
}

async function createHooks(
  calls: Call[],
  sessions: Record<string, { title: string; parentID?: string }> = {},
) {
  return plugin({ client: clientFor(sessions), $: shellFor(calls) } as any)
}

async function emit(hooks: any, event: unknown) {
  await hooks.event({ event })
}

function statusCommands(calls: Call[]) {
  return calls.filter((call) => call[1] === "set-status").map((call) => call.slice(1))
}

test("uses the exact Running and persistent Idle cmux styles for busy, retry, and idle", async () => {
  const calls: Call[] = []
  const hooks = await createHooks(calls, { primary: { title: "Primary" } })

  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "busy" } },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "retry", attempt: 1 } },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })

  expect(statusCommands(calls)).toEqual([
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    [
      "set-status",
      "opencode",
      "Idle",
      "--icon",
      "pause.circle.fill",
      "--color",
      "#8E8E93",
    ],
  ])
  expect(calls.some((call) => call[1] === "clear-status")).toBe(false)
})

test("keeps overlapping permission and question requests at Needs input until all replies resolve", async () => {
  const calls: Call[] = []
  const hooks = await createHooks(calls)

  await emit(hooks, {
    type: "permission.asked",
    properties: { id: "permission-event", title: "Run command" },
  })
  await hooks["permission.ask"]({ id: "permission-hook", title: "Write file" }, {})
  await emit(hooks, {
    type: "question.asked",
    properties: {
      id: "question-event",
      questions: [{ header: "Choose a branch" }],
    },
  })

  await emit(hooks, {
    type: "permission.replied",
    properties: { id: "permission-event" },
  })
  await emit(hooks, {
    type: "question.rejected",
    properties: { id: "question-event" },
  })
  await emit(hooks, {
    type: "permission.replied",
    properties: { id: "permission-hook" },
  })

  expect(statusCommands(calls)).toEqual([
    ["set-status", "opencode", "Needs input", "--icon", "bell.fill", "--color", "#4C8DFF"],
    ["set-status", "opencode", "Needs input", "--icon", "bell.fill", "--color", "#4C8DFF"],
    ["set-status", "opencode", "Needs input", "--icon", "bell.fill", "--color", "#4C8DFF"],
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
  ])
})

test("notifies with the latest normalized assistant response and leaves child completion status alone", async () => {
  const calls: Call[] = []
  const hooks = await createHooks(calls, {
    primary: { title: "Primary" },
    child: { title: "Child", parentID: "primary" },
  })

  await emit(hooks, {
    type: "message.updated",
    properties: { info: { id: "stale", sessionID: "primary", role: "assistant" } },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: { id: "stale-part", type: "text", messageID: "stale", text: " stale response " },
    },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "busy" } },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })

  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "busy" } },
  })
  await emit(hooks, {
    type: "message.updated",
    properties: { info: { id: "final", sessionID: "primary", role: "assistant" } },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: { id: "first-part", type: "text", messageID: "final", text: " initial " },
    },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "second-part",
        type: "text",
        messageID: "final",
        text: ` second ${"x".repeat(300)} `,
      },
    },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "first-part",
        type: "text",
        messageID: "final",
        text: " final\n response ",
      },
    },
  })
  await emit(hooks, {
    type: "message.updated",
    properties: { info: { id: "child-message", sessionID: "child", role: "assistant" } },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: { id: "child-part", type: "text", messageID: "child-message", text: "child response" },
    },
  })

  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "child", status: { type: "idle" } },
  })

  const notifications = calls.filter((call) => call[1] === "rpc")
  const normalizedFinalText = `final response second ${"x".repeat(300)}`
  const expectedSummary = `${normalizedFinalText.slice(0, 199)}…`
  expect(JSON.parse(notifications[0]![3]!)).toEqual({
    title: "Done: Primary",
    body: "",
  })
  expect(JSON.parse(notifications[1]![3]!)).toEqual({
    title: "Done: Primary",
    body: expectedSummary,
  })
  expect(calls.map((call) => call.slice(1))).toContainEqual([
    "log",
    "--level",
    "info",
    "--source",
    "opencode",
    "--",
    "Subagent finished: Child",
  ])
  expect(statusCommands(calls)).toEqual([
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    [
      "set-status",
      "opencode",
      "Idle",
      "--icon",
      "pause.circle.fill",
      "--color",
      "#8E8E93",
    ],
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    [
      "set-status",
      "opencode",
      "Idle",
      "--icon",
      "pause.circle.fill",
      "--color",
      "#8E8E93",
    ],
  ])
})

test("truncates assistant summaries at 200 grapheme clusters without splitting emoji", async () => {
  const calls: Call[] = []
  const hooks = await createHooks(calls, { primary: { title: "Primary" } })
  const family = "👨‍👩‍👧‍👦"
  const combining = "e\u0301"
  const response = `${"a".repeat(197)}${family}${combining}ZQ`
  const expectedSummary = `${"a".repeat(197)}${family}${combining}…`

  await emit(hooks, {
    type: "message.updated",
    properties: { info: { id: "grapheme-message", sessionID: "primary", role: "assistant" } },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: { id: "grapheme-part", type: "text", messageID: "grapheme-message", text: response },
    },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })

  const notification = calls.find((call) => call[1] === "rpc")
  const body = JSON.parse(notification![3]!).body as string
  expect(body).toBe(expectedSummary)
  expect(
    Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(body),
    ),
  ).toHaveLength(200)
  expect(body).toContain(family)
  expect(body).toContain(combining)
})

test("preserves the response across duplicate busy and same-message retry events", async () => {
  const calls: Call[] = []
  const hooks = await createHooks(calls, {
    duplicate: { title: "Duplicate" },
    retry: { title: "Retry" },
  })

  for (const cycle of [
    { sessionID: "duplicate", repeatedStatus: "busy", messageID: "duplicate-message", text: "duplicate busy response" },
    { sessionID: "retry", repeatedStatus: "retry", messageID: "retry-message", text: "same message retry response" },
  ]) {
    await emit(hooks, {
      type: "session.status",
      properties: { sessionID: cycle.sessionID, status: { type: "busy" } },
    })
    await emit(hooks, {
      type: "message.updated",
      properties: {
        info: { id: cycle.messageID, sessionID: cycle.sessionID, role: "assistant" },
      },
    })
    await emit(hooks, {
      type: "session.status",
      properties: { sessionID: cycle.sessionID, status: { type: cycle.repeatedStatus } },
    })
    await emit(hooks, {
      type: "message.part.updated",
      properties: {
        part: { id: "response-part", type: "text", messageID: cycle.messageID, text: cycle.text },
      },
    })
    await emit(hooks, {
      type: "session.status",
      properties: { sessionID: cycle.sessionID, status: { type: "idle" } },
    })
  }

  expect(
    calls
      .filter((call) => call[1] === "rpc")
      .map((call) => JSON.parse(call[3]!).body),
  ).toEqual(["duplicate busy response", "same message retry response"])
})

test("suppresses every idle event after an error until a new cycle starts", async () => {
  const calls: Call[] = []
  const hooks = await createHooks(calls, { primary: { title: "Primary" } })

  await emit(hooks, {
    type: "message.updated",
    properties: { info: { id: "errored-message", sessionID: "primary", role: "assistant" } },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: { id: "errored-part", type: "text", messageID: "errored-message", text: "stale" },
    },
  })
  await emit(hooks, {
    type: "session.error",
    properties: { sessionID: "primary" },
  })

  const afterError = calls.length
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })

  expect(calls.length).toBe(afterError + 1)
  expect(statusCommands(calls)).toEqual([
    [
      "set-status",
      "opencode",
      "Idle",
      "--icon",
      "pause.circle.fill",
      "--color",
      "#8E8E93",
    ],
  ])
  expect(calls.filter((call) => call[1] === "rpc").length).toBe(1)
  expect(calls.map((call) => call.slice(1))).not.toContainEqual([
    "log",
    "--level",
    "success",
    "--source",
    "opencode",
    "--",
    "Done: Primary",
  ])

  const afterFirstIdle = calls.length
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })
  expect(calls.length).toBe(afterFirstIdle)
  expect(calls.map((call) => call.slice(1))).toContainEqual([
    "clear-status",
    "opencode",
  ])
  expect(calls.map((call) => call.slice(1))).toContainEqual([
    "log",
    "--level",
    "error",
    "--source",
    "opencode",
    "--",
    "Error in session: Primary",
  ])
  expect(statusCommands(calls)).toHaveLength(1)
  expect(calls.filter((call) => call[1] === "rpc").length).toBe(1)

  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "busy" } },
  })
  await emit(hooks, {
    type: "message.updated",
    properties: { info: { id: "recovered-message", sessionID: "primary", role: "assistant" } },
  })
  await emit(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "recovered-part",
        type: "text",
        messageID: "recovered-message",
        text: " recovered response ",
      },
    },
  })
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "primary", status: { type: "idle" } },
  })

  const notifications = calls.filter((call) => call[1] === "rpc")
  expect(JSON.parse(notifications[1]![3]!)).toEqual({
    title: "Done: Primary",
    body: "recovered response",
  })
  expect(statusCommands(calls)).toEqual([
    [
      "set-status",
      "opencode",
      "Idle",
      "--icon",
      "pause.circle.fill",
      "--color",
      "#8E8E93",
    ],
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    [
      "set-status",
      "opencode",
      "Idle",
      "--icon",
      "pause.circle.fill",
      "--color",
      "#8E8E93",
    ],
  ])
})
