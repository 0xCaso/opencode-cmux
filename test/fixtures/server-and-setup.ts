// OpenCode 1.18 calls server() and then setup(). Spawned by v2.test.ts: the
// events below go through setup() and must not reach cmux a second time.
import plugin from "../../src/index"

const sessionID = "ses_eef536077ffe3wRmuATt2MFiqA"
const client = { session: { get: async () => ({ data: { id: sessionID, title: "My session" } }) } }
await plugin.server({ client, $: Bun.$ } as any)

let finished!: () => void
const done = new Promise<void>((resolve) => (finished = resolve))
const cleanup = await plugin.setup({
  session: { get: async () => ({ id: sessionID, title: "My session" }) },
  event: {
    async *subscribe() {
      yield { type: "session.execution.started", data: { sessionID } }
      yield { type: "session.execution.succeeded", data: { sessionID } }
      finished()
    },
  },
} as any)

await done
await new Promise((resolve) => setTimeout(resolve, 100))
if (typeof cleanup === "function") await cleanup()
