// v2 runs plugins in Bun but passes no `$`. Bun's own `$` escapes each
// interpolated value, which the cmux helpers rely on (titles, JSON payloads).
export function shell(): any {
  const bun = (globalThis as any).Bun
  if (typeof bun?.$ === "function") return bun.$
  // Outside Bun, skip cmux calls rather than build a shell string by hand.
  const failed = { stdout: "", exitCode: 1, text: () => "" }
  const out: any = {
    quiet: () => out,
    nothrow: () => out,
    text: async () => "",
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(failed).then(onFulfilled, onRejected),
  }
  return () => out
}

// v2's session.get takes { sessionID } and returns the session directly.
// The plugin body still calls the v1 SDK shape.
export function v1Client(session: any): any {
  return {
    session: {
      get: async (args: any) => ({
        data: await session.get({ sessionID: args.path.id }),
      }),
    },
  }
}

// Translates the v2 events the plugin needs into the v1 shape. v2 reports a
// turn as session.execution.* instead of session.status, and keeps
// session.status only as a deprecated mirror, so it is dropped here to avoid
// handling a turn twice.
export function toV1Event(event: any): { type: string; properties: any } | undefined {
  const data = event?.data
  if (!data || typeof data !== "object") return
  const sessionID = data.sessionID
  switch (event.type) {
    case "session.execution.started":
      return { type: "session.status", properties: { sessionID, status: { type: "busy" } } }
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
    case "session.execution.failed":
      return { type: "session.error", properties: { sessionID, error: data.error } }
    case "session.created":
      return {
        type: "session.created",
        properties: { info: { id: sessionID, parentID: data.parentID, title: data.title } },
      }
    case "session.deleted":
      return { type: "session.deleted", properties: { info: { id: sessionID } } }
    case "permission.asked": {
      const resources = Array.isArray(data.resources) ? data.resources.join(", ") : ""
      return {
        type: "permission.asked",
        properties: {
          id: data.id,
          sessionID,
          permission: data.action,
          title: resources ? `${data.action}: ${resources}` : data.action,
        },
      }
    }
    case "permission.replied":
      return { type: "permission.replied", properties: data }
    // v2 asks the user questions through forms.
    case "form.created": {
      const form = data.form
      if (!form?.id) return
      const header = form.fields?.[0]?.title ?? form.title
      return {
        type: "question.asked",
        properties: { id: form.id, sessionID: form.sessionID, questions: [{ header }] },
      }
    }
    case "form.replied":
      return { type: "question.replied", properties: { id: data.id, sessionID } }
    case "form.cancelled":
      return { type: "question.rejected", properties: { id: data.id, sessionID } }
  }
}
