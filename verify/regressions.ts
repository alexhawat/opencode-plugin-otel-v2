import assert from "node:assert/strict"
import plugin from "../src/index.ts"

function receiver() {
  const requests: { path: string; auth: string | null; payload: any }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), payload: await req.json() })
      return Response.json({})
    },
  })
  return { requests, server, endpoint: server.url.origin }
}

const first = receiver()
const second = receiver()
const sessionID = "s"
const model = { id: "m", providerID: "p" }
const step = { sessionID, assistantMessageID: "a", model, agent: "build" }
const usage = { ...step, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 100, write: 30 } } }
const tool = { sessionID, assistantMessageID: "a", id: "t", name: "read" }
const event = (type: string, data: object, created = Date.now()) => ({ type, data, created })
const samples: Record<string, string>[] = []

function attr(point: any, key: string) {
  return point.attributes.find((a: any) => a.key === key)?.value.stringValue
}

function location(endpoint: string, credential: string, disabledTraces: string[] = []) {
  const hooks = new Map<string, Function>()
  async function request() {
    const headers = {}
    await hooks.get("model.request")!({ ...step, kind: "primary", headers })
    samples.push(headers)
  }
  return {
    options: { enabled: true, endpoint, otlpHeaders: `Authorization=${credential}`, protocol: "http/json",
      tracePropagationProviders: ["p"], disabledTraces },
    session: { hook: async (name: string, callback: Function) => { hooks.set(name, callback) } },
    event: { subscribe: async function* () {
      yield event("session.execution.started", { sessionID })
      const ask = (id: string, action: string) => event("permission.asked", {
        sessionID, id, action, resources: ["private-resource"], message: "private-message",
        metadata: { command: "private-command" },
      })
      const reply = (requestID: string, decision: string) =>
        event("permission.replied", { sessionID, requestID, reply: decision })
      yield ask("a", "edit")
      yield ask("b", "bash")
      yield reply("b", "always")
      yield reply("a", "reject")
      yield reply("missed", "once")
      yield ask("unanswered", "read")
      yield event("session.status", { sessionID, status: { type: "retry", attempt: 1 } })
      const retry = { ...event("session.retry.scheduled", {
        sessionID, assistantMessageID: "a", attempt: 1, at: Date.now(), error: { type: "transient", message: "retry" },
      }), id: "retry-1" }
      yield retry
      yield retry
      yield event("session.step.started", step)
      await request()
      const now = Date.now()
      const otherSession = { ...tool, sessionID: "other", name: "edit" }
      const otherMessage = { ...tool, assistantMessageID: "c", name: "list" }
      for (const call of [tool, otherSession, otherMessage]) {
        yield event("session.tool.input.started", call, now)
      }
      yield event("session.tool.called", tool, now)
      yield event("session.tool.called", otherSession, now + 100)
      yield event("session.tool.called", otherMessage, now + 200)
      yield event("session.tool.failed", { ...otherSession, error: { type: "tool", message: "failed" } }, now + 500)
      yield event("session.tool.success", otherMessage, now + 800)
      yield event("session.tool.success", tool, now + 5000)
      yield event("session.step.ended", usage)
      await request()
      yield event("session.step.started", { ...step, assistantMessageID: "b" })
      yield event("session.execution.interrupted", { sessionID, reason: "cancelled" })
      yield event("session.execution.started", { sessionID })
      yield reply("unanswered", "once")
      await request()
      const unfinished = { ...step, sessionID: "unfinished" }
      yield event("session.created", { sessionID: unfinished.sessionID, parentID: sessionID })
      yield event("session.execution.started", unfinished)
      yield event("session.step.started", unfinished)
      yield event("session.tool.input.started", { ...tool, ...unfinished })
      yield event("session.tool.called", { ...tool, ...unfinished })
    } },
  }
}

try {
  const cleanup = await plugin.setup(location(first.endpoint, "first"))
  assert.ok(cleanup)
  await assert.rejects(plugin.setup(location(second.endpoint, "second")), /share one telemetry exporter/)
  await assert.rejects(plugin.setup(location(first.endpoint, "changed")), /share one telemetry exporter/)
  await cleanup()
  assert.match(samples[0]?.traceparent ?? "", /^00-/)
  assert.deepEqual(samples.slice(1), [{}, {}])
  const unfinishedSpans = first.requests.flatMap(r => r.payload.resourceSpans ?? [])
    .flatMap(r => r.scopeSpans).flatMap(s => s.spans)
    .filter(span => attr(span, "session.id") === "unfinished")
  assert.deepEqual(unfinishedSpans.map(span => span.name).sort(),
    ["opencode.llm", "opencode.session", "opencode.session", "opencode.tool.read"])
  assert.ok(unfinishedSpans.every(span => attr(span, "session.outcome") === "interrupted"))
  const previousExports = first.requests.length
  assert.ok(previousExports > 0)
  assert.ok(first.requests.every(r => r.auth === "first"))

  // Keep a lease with the tracing-state shape from before permission tracking.
  const quiet = location(second.endpoint, "second")
  quiet.event.subscribe = async function* () {}
  const closeOlder = await plugin.setup(quiet)
  assert.ok(closeOlder)
  const lease = (globalThis as any).__opencode_otel_exporter_v2__
  delete (await lease.ready).tracing.pendingPermissions

  const close = await plugin.setup(location(second.endpoint, "second", ["llm", "tool"]))
  assert.ok(close)
  assert.ok((await lease.ready).tracing.pendingPermissions instanceof Map)
  await closeOlder()
  await close()
  assert.equal(first.requests.length, previousExports)
  assert.ok(second.requests.every(r => r.auth === "second"))
  const logs = second.requests.flatMap(r => r.payload.resourceLogs ?? [])
    .flatMap(r => r.scopeLogs).flatMap(s => s.logRecords)
  assert.ok(logs.some(r => r.body.stringValue === "session.execution.interrupted"))
  assert.ok(!logs.some(r => r.body.stringValue === "session.execution.succeeded"))
  const decisions = logs.filter(r => r.body.stringValue === "tool_decision")
  assert.deepEqual(decisions.map(r => [attr(r, "permission.action"), attr(r, "permission.reply"), attr(r, "decision")]),
    [["bash", "always", "accept"], ["edit", "reject", "reject"], ["unknown", "once", "accept"], ["unknown", "once", "accept"]])
  const firstTurn = second.requests.flatMap(r => r.payload.resourceSpans ?? [])
    .flatMap(r => r.scopeSpans).flatMap(s => s.spans)
    .find(span => span.name === "opencode.session" && attr(span, "session.id") === sessionID)
  assert.ok(firstTurn)
  assert.equal(decisions[0].traceId, firstTurn.traceId)
  assert.equal(decisions[0].spanId, firstTurn.spanId)
  assert.equal(decisions[1].spanId, firstTurn.spanId)
  assert.ok(decisions.slice(2).every(record => !record.traceId && !record.spanId))
  assert.doesNotMatch(JSON.stringify(decisions), /private-resource|private-message|private-command/)
  const metrics = second.requests.flatMap(r => r.payload.resourceMetrics ?? [])
    .flatMap(r => r.scopeMetrics).flatMap(s => s.metrics)
  function points(name: string) {
    return metrics.filter(m => m.name === `opencode.${name}`).flatMap(m => (m.sum ?? m.histogram).dataPoints)
  }
  const count = (point: any) => Number(point.asDouble ?? point.asInt)
  assert.equal(points("retry.count").reduce((sum, p) => sum + count(p), 0), 1)
  assert.deepEqual(points("tool.duration").map(p => [attr(p, "session.id"), attr(p, "tool"), p.sum]).sort(),
    [["other", "edit", 400], ["s", "list", 600], ["s", "read", 5000]])
  assert.equal(attr(points("model.usage")[0], "model"), "m")
  assert.equal(attr(points("token.usage")[0], "model"), "p/m")
  assert.deepEqual(points("cache.count").map(p => [attr(p, "type"), count(p)]).sort(),
    [["cacheCreation", 1], ["cacheRead", 1]])
} finally {
  first.server.stop(true)
  second.server.stop(true)
}
