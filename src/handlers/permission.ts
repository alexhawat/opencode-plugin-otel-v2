import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import type { HandlerContext } from "../types.ts"
import type { V2Event } from "../v2.ts"
import { setBoundedMap } from "../util.ts"

/** Retain the action and originating span context until the request is answered. */
export function handlePermissionAsked({ data }: V2Event, ctx: HandlerContext) {
  const { id, sessionID, action } = data
  if (typeof id === "string" && typeof sessionID === "string" && typeof action === "string") {
    const runID = ctx.activeRuns.get(sessionID)
    const spanContext = runID ? ctx.runSpans.get(runID)?.spanContext() : undefined
    setBoundedMap(ctx.pendingPermissions, id, { sessionID, action: ctx.redact(action), spanContext })
  }
}

export function handlePermissionReplied({ data, created }: V2Event, ctx: HandlerContext) {
  const { requestID, sessionID, reply } = data
  if (typeof requestID !== "string" || typeof sessionID !== "string") return
  if (reply !== "always" && reply !== "once" && reply !== "reject") return

  const pending = ctx.pendingPermissions.get(requestID)
  const request = pending?.sessionID === sessionID ? pending : undefined
  if (request) ctx.pendingPermissions.delete(requestID)
  const context = request?.spanContext ? trace.setSpanContext(ROOT_CONTEXT, request.spanContext) : ROOT_CONTEXT
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: created,
    body: "tool_decision",
    attributes: {
      ...ctx.attrsFor(sessionID),
      "event.name": "tool_decision",
      "session.id": sessionID,
      "permission.action": request?.action ?? "unknown",
      "permission.reply": reply,
      decision: reply === "reject" ? "reject" : "accept",
    },
  }, context)
}
