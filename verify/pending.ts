// Verifies pending-span placeholders against a local OTLP receiver:
//   1. a turn that is still running has already exported a placeholder for its root span,
//      and for an open LLM step, in Logfire's pending-span shape;
//   2. when the turn ends, the real spans arrive under the ids the placeholders pointed at;
//   3. `pendingSpans: "auto"` is on only for a Pydantic Logfire endpoint.
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
process.env.OPENCODE_OTEL_DIAG_LOG = "/tmp/otel-verify-diag.log";
delete process.env.OPENCODE_PENDING_SPANS;

const bodies: { path: string; body: string }[] = [];
const server = Bun.serve({
  port: 4323,
  async fetch(req) {
    const u = new URL(req.url);
    bodies.push({ path: u.pathname, body: await req.text() });
    return new Response("", { status: 200 });
  },
});

const opts = {
  enabled: true,
  endpoint: "http://127.0.0.1:4323",
  protocol: "http/json",
  metricsInterval: 1000,
  logsInterval: 500,
  logsEnabled: true,
  metricPrefix: "opencode.",
  pendingSpans: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeCtx() {
  const hooks: Record<string, Function> = {};
  const events: any[] = [];
  let closed = false;
  const ctx: any = {
    options: opts,
    location: { directory: process.cwd(), project: { id: "verify", canonical: process.cwd() } },
    session: {
      hook: async (n: string, c: Function) => {
        hooks[n] = c;
        return { dispose: async () => {} };
      },
      get: async () => ({ agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } }),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: async () => {
              while (i >= events.length) {
                if (closed || signal.aborted) return { done: true, value: undefined };
                await sleep(10);
              }
              return { done: false, value: events[i++] };
            },
          };
        },
      }),
    },
  };
  return { ctx, hooks, push: (...e: any[]) => events.push(...e), close: () => (closed = true) };
}

const attr = (s: any) => Object.fromEntries((s.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue]));
function exported(): any[] {
  const spans: any[] = [];
  for (const { path, body } of bodies) {
    if (path !== "/v1/traces") continue;
    const j = JSON.parse(body);
    for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push(sp);
  }
  return spans;
}
const isPending = (s: any) => attr(s)["logfire.span_type"] === "pending_span";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`   ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

const mod: any = await import("../src/index.ts");
const a = makeCtx();
const cleanup = (await mod.default.setup(a.ctx)) ?? (async () => {});
const S = "ses_pending";

// The turn starts, an LLM step opens and one tool call completes. Nothing has ended the turn.
await a.hooks.prompt({ sessionID: S, messageID: "msg_user", prompt: { text: "work for a long time" } });
a.push(
  { type: "session.execution.started", created: Date.now(), data: { sessionID: S } },
  { type: "session.step.started", created: Date.now(), data: { sessionID: S, assistantMessageID: "msg_asst", agent: "build", model: { id: "m", providerID: "p" } } },
  { type: "session.tool.input.started", created: Date.now(), data: { sessionID: S, assistantMessageID: "msg_asst", id: "call_1", name: "read" } },
  { type: "session.tool.called", created: Date.now(), data: { sessionID: S, assistantMessageID: "msg_asst", id: "call_1", input: { filePath: "x" }, executed: false } },
  { type: "session.tool.success", created: Date.now(), data: { sessionID: S, assistantMessageID: "msg_asst", id: "call_1", content: [{ type: "text", text: "ok" }] } },
);
// Longer than the batch processor's 5 s schedule, so anything queued has been exported.
await sleep(6000);

const during = exported().filter((s) => attr(s)["session.id"] === S);
console.log(`\nwhile the turn is running: spans=${during.length}`);
const rootPending = during.find((s) => s.name === "opencode.session" && isPending(s));
const rootReal = during.find((s) => s.name === "opencode.session" && !isPending(s));
const llmPending = during.find((s) => s.name === "opencode.llm" && isPending(s));
const toolReal = during.find((s) => s.name === "opencode.tool.read" && !isPending(s));
check(!!rootPending, "a placeholder for the run span is exported before the turn ends");
check(!rootReal, "the real run span is not exported yet");
check(!!rootPending && attr(rootPending)["logfire.pending_parent_id"] === "0000000000000000", "the root placeholder records that the run span has no parent");
check(!!rootPending && rootPending.startTimeUnixNano === rootPending.endTimeUnixNano, "a placeholder has zero length");
check(!!rootPending && !!rootPending.parentSpanId && rootPending.parentSpanId !== rootPending.spanId, "a placeholder has its own id and the real span as parent");
check(!!rootPending && attr(rootPending)["session.id"] === S, "a placeholder carries the span's start attributes");
check(!!toolReal && toolReal.parentSpanId === rootPending?.parentSpanId, "a finished tool span points at the run span the placeholder announced");
check(!!llmPending && attr(llmPending)["logfire.pending_parent_id"] === rootPending?.parentSpanId, "the open llm step's placeholder names the run span as its real parent");
check(during.every((s) => s.traceId === rootPending?.traceId), "placeholders and real spans share one trace");

a.push(
  { type: "session.step.ended", created: Date.now(), data: { sessionID: S, assistantMessageID: "msg_asst", finish: "stop", cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  { type: "session.execution.succeeded", created: Date.now(), data: { sessionID: S } },
);
await sleep(600);
a.close();
await cleanup();
server.stop(true);

const after = exported().filter((s) => attr(s)["session.id"] === S);
console.log(`\nafter the turn ended: spans=${after.length}`);
const realRoot = after.find((s) => s.name === "opencode.session" && !isPending(s));
const realLlm = after.find((s) => s.name === "opencode.llm" && !isPending(s));
check(!!realRoot && realRoot.spanId === rootPending?.parentSpanId, "the real run span arrives under the id its placeholder pointed at");
check(!!realRoot && !realRoot.parentSpanId, "the real run span is the trace root");
check(!!realLlm && realLlm.spanId === llmPending?.parentSpanId, "the real llm span arrives under the id its placeholder pointed at");
check(after.filter((s) => !isPending(s)).every((s) => attr(s)["logfire.pending_parent_id"] === undefined), "real spans carry no placeholder attributes");
check(after.filter(isPending).length === after.filter((s) => !isPending(s)).length, "every span has exactly one placeholder");

const logs: any[] = [];
for (const { path, body } of bodies) {
  if (path !== "/v1/logs") continue;
  const j = JSON.parse(body);
  for (const rl of j.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const lr of sl.logRecords ?? []) logs.push(lr);
}
const outcome = logs.find((l) => l.body?.stringValue === "session.execution.succeeded" && attr(l)["session.id"] === S);
check(!!outcome && outcome.traceId === realRoot?.traceId, "the turn's outcome log is in the turn's trace");
check(!!outcome && outcome.spanId === realRoot?.spanId, "the turn's outcome log hangs under the run span");

console.log("\nauto mode");
const { loadConfig } = await import("../src/config.ts");
const base = { enabled: true, protocol: "http/json" as const };
check(loadConfig({ ...base, endpoint: "https://logfire-eu.pydantic.dev" }).pendingSpans === true, "on for logfire-eu.pydantic.dev");
check(loadConfig({ ...base, endpoint: "https://logfire-us.pydantic.dev" }).pendingSpans === true, "on for logfire-us.pydantic.dev");
check(loadConfig({ ...base, endpoint: "http://localhost:4317" }).pendingSpans === false, "off for a local collector");
check(loadConfig({ ...base, endpoint: "https://otlp.example.com" }).pendingSpans === false, "off for another backend");
check(loadConfig({ ...base, endpoint: "https://logfire-eu.pydantic.dev.example.com" }).pendingSpans === false, "off for a look-alike host");
check(loadConfig({ ...base, endpoint: "https://logfire-eu.pydantic.dev", pendingSpans: false }).pendingSpans === false, "an explicit false wins over auto");
check(loadConfig({ ...base, endpoint: "https://otlp.example.com", pendingSpans: true }).pendingSpans === true, "an explicit true wins over auto");
process.env.OPENCODE_PENDING_SPANS = "off";
check(loadConfig({ ...base, endpoint: "https://logfire-eu.pydantic.dev" }).pendingSpans === false, "OPENCODE_PENDING_SPANS=off turns it off");
delete process.env.OPENCODE_PENDING_SPANS;

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
