import { trace } from "@opentelemetry/api"
import { createHash } from "node:crypto"
import { MAX_PENDING } from "./types.ts"
import type { HandlerContext, SessionAgentType } from "./types.ts"
import { ALL_METRICS, type ContentCapture } from "./config.ts"

/** Stable, deterministic project id for a directory (sha1 of the path, 40 hex chars). */
export function stableProjectId(directory: string): string {
  return createHash("sha1").update(directory).digest("hex")
}

const GEN_AI_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "amazon-bedrock": "aws.bedrock",
  azure: "azure.ai.openai",
  "azure-cognitive-services": "azure.ai.openai",
  google: "gcp.gemini",
  "google-vertex": "gcp.vertex_ai",
  "google-vertex-anthropic": "gcp.vertex_ai",
  mistral: "mistral_ai",
  xai: "x_ai",
}

/** Returns a human-readable summary string from an opencode error object. */export function errorSummary(err: { name: string; data?: unknown } | undefined): string {
  if (!err) return "unknown"
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    return `${err.name}: ${(err.data as { message: string }).message}`
  }
  return err.name
}

/** Returns the canonical OTel GenAI provider name, preserving unknown provider IDs. */
export function genAiProviderName(providerID: string): string {
  return GEN_AI_PROVIDER_NAMES[providerID] ?? providerID
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= MAX_PENDING) {
    const [firstKey] = map.keys()
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

/** Resolves a root-run context from the live span first, then from the retained ended span context. */
export function resolveRunTraceContext(runID: string, ctx: Pick<HandlerContext, "rootContext" | "runSpans" | "runSpanContexts">) {
  const baseCtx = ctx.rootContext()
  const runSpan = ctx.runSpans.get(runID)
  if (runSpan) return trace.setSpan(baseCtx, runSpan)
  const runSpanContext = ctx.runSpanContexts.get(runID)
  return runSpanContext ? trace.setSpanContext(baseCtx, runSpanContext) : baseCtx
}

/** Resolves the best available trace parent for a session event or message/tool child span. */
export function resolveSessionTraceContext(
  sessionID: string,
  ctx: HandlerContext,
  input?: { assistantMessageID?: string; runID?: string },
) {
  const baseCtx = ctx.rootContext()
  // Prefer the active turn run span so LLM/tool spans nest under it; the run span itself is
  // nested under the subagent session span by handleRunStarted.
  if (input?.runID) return resolveRunTraceContext(input.runID, ctx)
  const assistantRunID = input?.assistantMessageID
    ? ctx.assistantRuns.get(input.assistantMessageID)
    : undefined
  if (assistantRunID) return resolveRunTraceContext(assistantRunID, ctx)
  const activeRunID = ctx.activeRuns.get(sessionID)
  if (activeRunID) return resolveRunTraceContext(activeRunID, ctx)
  const sessionSpan = ctx.sessionSpans.get(sessionID)
  if (sessionSpan) return trace.setSpan(baseCtx, sessionSpan)
  const sessionSpanContext = ctx.sessionSpanContexts.get(sessionID)
  if (sessionSpanContext) return trace.setSpanContext(baseCtx, sessionSpanContext)
  return baseCtx
}

/**
 * Returns `true` if the metric name (without prefix) is not in the disabled set.
 * The `name` should be the suffix after the metric prefix, e.g. `"session.count"`.
 */
export function isMetricEnabled(name: string, ctx: { disabledMetrics: Set<string> }): boolean {
  return !ctx.disabledMetrics.has(ALL_METRICS) && !ctx.disabledMetrics.has(name)
}

/**
 * Returns `true` if the trace type is not in the disabled set.
 * Valid names are `"session"`, `"llm"`, and `"tool"`.
 */
export function isTraceEnabled(name: string, ctx: { disabledTraces: Set<string> }): boolean {
  return !ctx.disabledTraces.has(name)
}

/**
 * Accumulates token and cost totals for a session, and increments the message count.
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place.
 * No-ops silently if the session was not previously registered via `handleSessionCreated`.
 */
export function accumulateSessionTotals(
  sessionID: string,
  tokens: number,
  cost: number,
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID)
  if (!existing) return
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens + tokens,
    cost: existing.cost + cost,
    messages: existing.messages + 1,
    agent: existing.agent,
    agentType: existing.agentType,
  })
}

/** Returns the current session-scoped agent name/type, defaulting to `unknown` when unavailable. */
export function getSessionAgentMeta(
  sessionID: string,
  ctx: Pick<HandlerContext, "sessionTotals">,
): { agentName: string; agentType: SessionAgentType | "unknown" } {
  const totals = ctx.sessionTotals.get(sessionID)
  return {
    agentName: totals?.agent ?? "unknown",
    agentType: totals?.agentType ?? "unknown",
  }
}

/** Builds a consistent agent attribute set for OTLP logs, metrics, and spans. */
export function agentAttrs(agentName: string, agentType: SessionAgentType | "unknown") {
  return {
    agent: agentName,
    "agent.name": agentName,
    "agent.type": agentType,
  } as const
}

/**
 * Builds the attributes for one prompt or tool body under a `captureContent` mode:
 * `build(redact(text))` for `full`, the character count under `lengthKey` for
 * `metadata`, and nothing for `off`. An empty body adds nothing in any mode.
 */
export function contentAttrs(
  mode: ContentCapture,
  redact: (text: string) => string,
  text: string,
  lengthKey: string,
  build: (redacted: string) => Record<string, string>,
): Record<string, string | number> {
  if (!text || mode === "off") return {}
  if (mode === "metadata") return { [lengthKey]: text.length }
  return build(redact(text))
}

/** The `gen_ai.provider.name` for spans OpenCode itself produces (sessions, tools). */
export const OPENCODE_GENAI_PROVIDER = "opencode"

/**
 * OTel GenAI operation attributes alongside the OpenInference span kind. Backends that
 * key on GenAI semantic conventions (Datadog LLM Observability) flag a span that has no
 * `gen_ai.operation.name` and `gen_ai.provider.name` as unidentified instrumentation.
 */
export function genAiOperationAttrs(
  operation: "invoke_agent" | "execute_tool",
  name: string,
): Record<string, string> {
  return {
    "gen_ai.operation.name": operation,
    "gen_ai.provider.name": OPENCODE_GENAI_PROVIDER,
    [operation === "invoke_agent" ? "gen_ai.agent.name" : "gen_ai.tool.name"]: name,
  }
}

const CAPTURE_RANK: Record<ContentCapture, number> = { off: 0, metadata: 1, full: 2 }

/**
 * The most restrictive of the capture modes registered by live plugin instances.
 *
 * OpenCode evaluates the plugin once per location, and the instances share one event
 * stream and dedupe events across each other, so whichever instance sees an event first
 * exports it. A stricter location's bodies would leak through a `full` instance unless
 * every instance applies the strictest mode in force. No registered mode means `full`.
 */
export function strictestCapture(modes: Iterable<ContentCapture>): ContentCapture {
  let strictest: ContentCapture = "full"
  for (const mode of modes) if (CAPTURE_RANK[mode] < CAPTURE_RANK[strictest]) strictest = mode
  return strictest
}

/**
 * An error's text under a capture mode. Error messages can carry commands, stderr or
 * repository text, so outside `full` only the structured error type is exported; under
 * `full` the message is kept but redacted.
 */
export function errorText(
  mode: ContentCapture,
  redact: (text: string) => string,
  error: { type: string; message?: string } | undefined,
): string {
  if (!error) return "unknown"
  if (mode !== "full") return error.type
  return redact(error.message ? `${error.type}: ${error.message}` : error.type)
}
