import { test, expect } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attachCommand, shell, toV1Event, v1Client } from "../src/v2"

// Payloads below are copied from events captured on OpenCode 2.0.24.
const sessionID = "ses_eef536077ffe3wRmuATt2MFiqA"

test("execution events become v1 session.status / session.error", () => {
  expect(toV1Event({ type: "session.execution.started", data: { sessionID } })).toEqual({
    type: "session.status",
    properties: { sessionID, status: { type: "busy" } },
  })
  expect(toV1Event({ type: "session.execution.succeeded", data: { sessionID } })).toEqual({
    type: "session.status",
    properties: { sessionID, status: { type: "idle" } },
  })
  expect(
    toV1Event({ type: "session.execution.interrupted", data: { sessionID, reason: "user" } }),
  ).toEqual({
    type: "session.error",
    properties: { sessionID, error: { name: "MessageAbortedError" } },
  })
  expect(
    toV1Event({ type: "session.execution.failed", data: { sessionID, error: { type: "x" } } }),
  ).toEqual({ type: "session.error", properties: { sessionID, error: { type: "x" } } })
})

test("v2 session.status is dropped so a turn is not handled twice", () => {
  expect(
    toV1Event({ type: "session.status", data: { sessionID, status: { type: "idle" } } }),
  ).toBeUndefined()
  expect(toV1Event({ type: "session.text.delta", data: { sessionID } })).toBeUndefined()
  expect(toV1Event({ type: "integration.updated", data: {} })).toBeUndefined()
  expect(toV1Event({ type: "session.created" })).toBeUndefined()
})

test("assistant steps and text become v1 message events", () => {
  expect(
    toV1Event({
      type: "session.step.started",
      data: { sessionID, assistantMessageID: "msg_1", agent: "build" },
    }),
  ).toEqual({
    type: "message.updated",
    properties: { info: { id: "msg_1", sessionID, role: "assistant" } },
  })
  expect(
    toV1Event({
      type: "session.text.ended",
      data: { sessionID, assistantMessageID: "msg_1", ordinal: 2, text: "Hi" },
    }),
  ).toEqual({
    type: "message.part.updated",
    properties: {
      part: { id: "text:2", sessionID, messageID: "msg_1", type: "text", text: "Hi" },
    },
  })
})

test("session lifecycle events carry v1 info", () => {
  expect(
    toV1Event({
      type: "session.created",
      data: { sessionID, parentID: "ses_parent", title: "sub", slug: "s" },
    }),
  ).toEqual({
    type: "session.created",
    properties: { info: { id: sessionID, parentID: "ses_parent", title: "sub" } },
  })
  expect(toV1Event({ type: "session.deleted", data: { sessionID } })).toEqual({
    type: "session.deleted",
    properties: { info: { id: sessionID } },
  })
})

test("permission events keep the request id", () => {
  expect(
    toV1Event({
      type: "permission.asked",
      data: {
        id: "per_110acabda0010YPWu8M5kABYVd",
        sessionID,
        action: "shell",
        resources: ["echo hi > /tmp/oc-proj/x.txt"],
        save: ["echo *"],
      },
    }),
  ).toEqual({
    type: "permission.asked",
    properties: {
      id: "per_110acabda0010YPWu8M5kABYVd",
      sessionID,
      permission: "shell",
      patterns: ["echo hi > /tmp/oc-proj/x.txt"],
    },
  })
  const replied = { sessionID, requestID: "per_110acabda0010YPWu8M5kABYVd", reply: "reject" }
  expect(toV1Event({ type: "permission.replied", data: replied })).toEqual({
    type: "permission.replied",
    properties: replied,
  })
})

test("question forms become v1 question events", () => {
  const formID = "frm_110e45fab00124NcjZ3Go06MSX"
  expect(
    toV1Event({
      type: "form.created",
      data: {
        form: {
          id: formID,
          sessionID,
          title: "Questions",
          metadata: { kind: "question" },
          fields: [{ key: "q0", title: "Colore", description: "Preferisci rosso o blu?" }],
        },
      },
    }),
  ).toEqual({
    type: "question.asked",
    properties: { id: formID, sessionID, questions: [{ header: "Colore" }] },
  })
  expect(toV1Event({ type: "form.replied", data: { id: formID, sessionID } })).toEqual({
    type: "question.replied",
    properties: { id: formID, sessionID },
  })
  expect(toV1Event({ type: "form.cancelled", data: { id: formID, sessionID } })).toEqual({
    type: "question.rejected",
    properties: { id: formID, sessionID },
  })
})

test("v1Client.session.get calls v2 with { sessionID }", async () => {
  const calls: unknown[] = []
  const client = v1Client({
    get: async (args: unknown) => {
      calls.push(args)
      return { id: sessionID, title: "t" }
    },
  })
  expect(await client.session.get({ path: { id: sessionID } })).toEqual({
    data: { id: sessionID, title: "t" },
  })
  expect(calls).toEqual([{ sessionID }])
})

test("shell passes each interpolated value as one escaped argument", async () => {
  const $ = shell()
  const payload = JSON.stringify({ title: "Done: fix `touch /tmp/pwned` $(id) it's" })
  const args = ["opencode", "Needs input", "--icon", "bell.fill"]
  const out = await $`printf '[%s]' ${payload} ${args}`.quiet().nothrow()
  expect(out.text()).toBe(
    `[${payload}][opencode][Needs input][--icon][bell.fill]`,
  )
})

test("splits join a v2 server only when its password is exported", () => {
  const saved = process.env.OPENCODE_SERVER_PASSWORD
  try {
    delete process.env.OPENCODE_SERVER_PASSWORD
    expect(attachCommand("http://localhost:4096", sessionID)).toBeNull()
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    expect(attachCommand("http://localhost:4096", sessionID)).toBe(
      `opencode --server http://localhost:4096 --session ${sessionID}`,
    )
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = saved
  }
})

// Runs a fixture against a fake cmux and returns the path of its call log.
function runFixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-cmux-v2-"))
  const fakeCmux = join(dir, "cmux")
  const callLog = join(dir, "calls.jsonl")
  writeFileSync(
    fakeCmux,
    `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")\n`,
  )
  chmodSync(fakeCmux, 0o755)

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "fixtures", name)], {
    env: {
      ...process.env,
      CMUX_BUNDLED_CLI_PATH: fakeCmux,
      CMUX_WORKSPACE_ID: "workspace:test",
      CMUX_SURFACE_ID: "surface:test",
      XDG_CONFIG_HOME: dir,
      TMUX_PANE: "",
    },
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return callLog
}

test("setup stays quiet when OpenCode 1.18 also started server()", () => {
  expect(existsSync(runFixture("server-and-setup.ts"))).toBe(false)
})

test("setup drives cmux from v2 events", () => {
  const calls = readFileSync(runFixture("v2-setup.ts"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(calls).toEqual([
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    ["set-status", "opencode", "Needs input", "--icon", "bell.fill", "--color", "#4C8DFF"],
    [
      "rpc",
      "notification.create",
      JSON.stringify({
        title: "Needs your permission",
        body: "shell: echo `id` $HOME",
        workspace_id: "workspace:test",
        surface_id: "surface:test",
      }),
    ],
    ["log", "--level", "info", "--source", "opencode", "--", "Permission requested: shell: echo `id` $HOME"],
    ["set-status", "opencode", "Running", "--icon", "bolt.fill", "--color", "#4C8DFF"],
    [
      "rpc",
      "notification.create",
      JSON.stringify({
        title: "Done: My session",
        body: "Printed the id.",
        workspace_id: "workspace:test",
        surface_id: "surface:test",
      }),
    ],
    ["log", "--level", "success", "--source", "opencode", "--", "Done: My session"],
    ["set-status", "opencode", "Idle", "--icon", "pause.circle.fill", "--color", "#8E8E93"],
  ])
})
