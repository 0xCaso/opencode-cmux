// Runs the v2 entrypoint against a fake context. Spawned by v2.test.ts so the
// cmux CLI path is read from this process's environment.
import plugin from "../../src/index"

const sessionID = "ses_eef536077ffe3wRmuATt2MFiqA"
const events = [
  { type: "session.execution.started", data: { sessionID } },
  { type: "session.status", data: { sessionID, status: { type: "busy" } } },
  {
    type: "permission.asked",
    data: { id: "per_1", sessionID, action: "shell", resources: ["echo `id` $HOME"] },
  },
  { type: "permission.replied", data: { sessionID, requestID: "per_1", reply: "once" } },
  { type: "session.execution.succeeded", data: { sessionID } },
]

let finished!: () => void
const done = new Promise<void>((resolve) => (finished = resolve))

const cleanup = await plugin.setup({
  session: { get: async ({ sessionID: id }: { sessionID: string }) => ({ id, title: "My session" }) },
  event: {
    async *subscribe() {
      for (const event of events) yield event
      finished()
    },
  },
} as any)

await done
if (typeof cleanup === "function") await cleanup()
