import { trace } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import type { HandlerContext } from "../types.ts"
import type { V2Event } from "../v2.ts"
import { setBoundedMap } from "../util.ts"

/** Keep only the action needed to label the eventual reply. */
export function handlePermissionAsked({ data }: V2Event, ctx: HandlerContext) {
  const { id, sessionID, action } = data
  if (typeof id === "string" && typeof sessionID === "string" && typeof action === "string") {
    setBoundedMap(ctx.pendingPermissions, id, { sessionID, action: ctx.redact(action) })
  }
}

export function handlePermissionReplied({ data, created }: V2Event, ctx: HandlerContext) {
  const { requestID, sessionID, reply } = data
  if (typeof requestID !== "string" || typeof sessionID !== "string") return
  if (reply !== "always" && reply !== "once" && reply !== "reject") return

  const pending = ctx.pendingPermissions.get(requestID)
  const action = pending?.sessionID === sessionID ? pending.action : undefined
  if (action !== undefined) ctx.pendingPermissions.delete(requestID)
  const runID = ctx.activeRuns.get(sessionID)
  const span = runID ? ctx.runSpans.get(runID) : undefined
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: created,
    body: "tool_decision",
    attributes: {
      ...ctx.attrsFor(sessionID),
      "event.name": "tool_decision",
      "session.id": sessionID,
      "permission.action": action ?? "unknown",
      "permission.reply": reply,
      decision: reply === "reject" ? "reject" : "accept",
    },
  }, span ? trace.setSpan(ctx.rootContext(), span) : undefined)
}
