// Verifies span parent/child linking and that the user_prompt log shares the turn's trace.
// Covers single-instance and cross-instance (prompt hook on A, events delivered to B).
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
process.env.OPENCODE_OTEL_DIAG_LOG = "/tmp/otel-verify-diag.log";

const bodies: { path: string; body: string }[] = [];
const server = Bun.serve({
  port: 4320,
  async fetch(req) {
    const u = new URL(req.url);
    bodies.push({ path: u.pathname, body: await req.text() });
    return new Response("", { status: 200 });
  },
});

const opts = {
  enabled: true,
  endpoint: "http://127.0.0.1:4320",
  protocol: "http/json",
  metricsInterval: 1000,
  logsInterval: 500,
  logsEnabled: true,
  metricPrefix: "opencode.",
};

function makeCtx() {
  const hooks: Record<string, Function> = {};
  const events: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ctx: any = {
    options: opts,
    location: { directory: process.cwd(), project: { id: "verify", canonical: process.cwd() } },
    session: {
      hook: async (n: string, c: Function) => { hooks[n] = c; return { dispose: async () => {} }; },
      get: async () => ({ agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } }),
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () { await gate; for (const e of events) yield e; } }) },
  };
  return { ctx, hooks, events, release: () => release() };
}

function turn(sessionID: string, asstMsg: string, callId: string) {
  return [
    { type: "session.execution.started", created: Date.now(), data: { sessionID } },
    { type: "session.step.started", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, agent: "build", model: { id: "m", providerID: "p" }, started: Date.now() } },
    { type: "session.tool.input.started", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, id: callId, name: "shell" } },
    { type: "session.tool.called", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, id: callId, input: { command: "x" }, executed: false } },
    { type: "session.tool.success", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, id: callId, content: [{ type: "text", text: "ok" }] } },
    { type: "session.step.ended", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, finish: "stop", cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { type: "session.execution.succeeded", created: Date.now(), data: { sessionID } },
  ];
}

const mod: any = await import("../src/index.ts");

// Test 1: single instance.
{
  const a = makeCtx();
  const cleanup = await mod.default.setup(a.ctx);
  await a.hooks.prompt({ sessionID: "ses_single", messageID: "msg_user_1", prompt: { text: "hi" } });
  a.events.push(...turn("ses_single", "msg_asst_1", "call_1"));
  a.release();
  await new Promise((r) => setTimeout(r, 1500));
  await cleanup();
}

// Test 2: prompt hook on A, events on B.
{
  const a = makeCtx();
  const b = makeCtx();
  const ca = await mod.default.setup(a.ctx);
  const cb = await mod.default.setup(b.ctx);
  await a.hooks.prompt({ sessionID: "ses_multi", messageID: "msg_user_2", prompt: { text: "hi" } });
  b.events.push(...turn("ses_multi", "msg_asst_2", "call_2"));
  b.release();
  await new Promise((r) => setTimeout(r, 1500));
  await ca();
  await cb();
}

await new Promise((r) => setTimeout(r, 800));
server.stop(true);

const spans: any[] = [];
const logs: any[] = [];
for (const { path, body } of bodies) {
  if (path === "/v1/traces") {
    const j = JSON.parse(body);
    for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push(sp);
  } else if (path === "/v1/logs") {
    const j = JSON.parse(body);
    for (const rl of j.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const lr of sl.logRecords ?? []) logs.push(lr);
  }
}

for (const sessionID of ["ses_single", "ses_multi"]) {
  const mine = spans.filter((s) => JSON.stringify(s.attributes).includes(sessionID));
  const traces = new Set(mine.map((s) => s.traceId));
  console.log(`\n${sessionID}: spans=${mine.length} distinct_traces=${traces.size}`);
  const rootTrace = mine.find((s) => s.name === "opencode.session")?.traceId;
  for (const s of mine) {
    const parent = mine.find((p) => p.spanId === s.parentSpanId);
    console.log(`   ${s.name}  parent=${parent ? parent.name : s.parentSpanId ? "(external)" : "(root)"}`);
  }
  const promptLog = logs.find((l) => JSON.stringify(l.attributes ?? {}).includes(sessionID) && (l.body?.stringValue === "user_prompt"));
  const logTrace = promptLog?.traceId;
  console.log(`   run_span_trace=${rootTrace?.slice(0, 12)}  user_prompt_log_trace=${logTrace?.slice(0, 12)}  linked=${!!logTrace && logTrace === rootTrace}`);
  const attrs = Object.fromEntries((promptLog?.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue]));
  console.log(`   user_prompt agent=${attrs.agent ?? "?"} model=${attrs.model ?? "?"}`);
}
