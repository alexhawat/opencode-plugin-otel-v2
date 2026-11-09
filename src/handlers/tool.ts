import { SpanStatusCode } from "@opentelemetry/api"
import {
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
} from "@arizeai/openinference-semantic-conventions"
import {
  genAiOperationAttrs,
  isMetricEnabled,
  isTraceEnabled,
  resolveSessionTraceContext,
  setBoundedMap,
} from "../util.ts"
import type { HandlerContext } from "../types.ts"
import type { V2Error, V2ToolContent } from "../v2.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const TOOL_NAME = "tool.name"
/** Tools that spawn a child (subagent) session; their span parents the subagent's tree. */
const SUBAGENT_TOOL = /^(subagent|task)$/i

type ToolCall = { sessionID: string; assistantMessageID: string; id: string }

function toolKey({ sessionID, assistantMessageID, id }: ToolCall): string {
  return JSON.stringify([sessionID, assistantMessageID, id])
}

/** Remembers the tool name for a call id, since V2 carries it only on `session.tool.input.started`. */
export function handleToolInputStarted(data: ToolCall & { name?: string }, ctx: HandlerContext) {
  if (data.name) setBoundedMap(ctx.pendingToolNames, toolKey(data), data.name)
}

/** Starts the tool span when the tool is called. */
export function handleToolCalled(
  data: ToolCall & { input?: Record<string, unknown> },
  ctx: HandlerContext,
  created = Date.now(),
) {
  const key = toolKey(data)
  const tool = ctx.pendingToolNames.get(key) ?? "unknown"
  const startMs = created
  const pending = { tool, sessionID: data.sessionID, startMs }
  if (!isTraceEnabled("tool", ctx)) {
    ctx.pendingToolSpans.set(key, pending)
    return
  }
  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}tool.${tool}`,
    {
      startTime: startMs,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        ...genAiOperationAttrs("execute_tool", tool),
        [SESSION_ID]: data.sessionID,
        [TOOL_NAME]: tool,
        ...ctx.content(JSON.stringify(data.input ?? {}), "input.length", (input) => ({
          [INPUT_VALUE]: input,
          [INPUT_MIME_TYPE]: MimeType.JSON,
        })),
        ...ctx.attrsFor(data.sessionID),
      },
    },
    resolveSessionTraceContext(data.sessionID, ctx, {
      assistantMessageID: data.assistantMessageID,
    }),
  )
  ctx.pendingToolSpans.set(key, { ...pending, span })
  // Let a subagent session created during this call nest under the dispatch span.
  if (SUBAGENT_TOOL.test(tool)) setBoundedMap(ctx.pendingSubagentSpans, data.sessionID, span)
}

/** Ends the tool span successfully and records its duration. */
export function handleToolSuccess(
  data: ToolCall & { content?: V2ToolContent[]; metadata?: Record<string, unknown> },
  ctx: HandlerContext,
  created = Date.now(),
) {
  finishTool(data, ctx, data.content, undefined, created)
}

/** Ends the tool span with an error and records its duration. */
export function handleToolFailed(
  data: ToolCall & { content?: V2ToolContent[]; error?: V2Error },
  ctx: HandlerContext,
  created = Date.now(),
) {
  finishTool(data, ctx, data.content, data.error, created)
}

function finishTool(
  data: ToolCall,
  ctx: HandlerContext,
  content: V2ToolContent[] | undefined,
  error: V2Error | undefined,
  created: number,
) {
  const { sessionID } = data
  const key = toolKey(data)
  const pending = ctx.pendingToolSpans.get(key)
  const tool = pending?.tool ?? ctx.pendingToolNames.get(key) ?? "unknown"
  const duration = pending ? Math.max(0, created - pending.startMs) : undefined

  const output = content?.map((part) => (part.type === "text" ? part.text : part.uri)).join("\n")
  if (pending?.span) {
    if (error) {
      pending.span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.errorText(error) })
      pending.span.setAttribute("error", ctx.errorText(error))
    } else {
      pending.span.setStatus({ code: SpanStatusCode.OK })
    }
    if (output) {
      pending.span.setAttributes(
        ctx.content(output, "output.length", (text) => ({ [OUTPUT_VALUE]: text, [OUTPUT_MIME_TYPE]: MimeType.TEXT })),
      )
    }
    pending.span.end(created)
  }

  if (duration !== undefined && isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(duration, {
      ...ctx.attrsFor(sessionID),
      "session.id": sessionID,
      tool,
    })
  }

  ctx.pendingToolSpans.delete(key)
  ctx.pendingToolNames.delete(key)
  if (SUBAGENT_TOOL.test(tool)) ctx.pendingSubagentSpans.delete(sessionID)
  ctx.log("debug", error ? "otel: tool.failed" : "otel: tool.success", { sessionID, tool, duration })
}
