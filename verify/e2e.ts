// End-to-end verification: drive the ported plugin with real V2 event payloads
// and confirm OTLP HTTP export reaches a local receiver.
const received: string[] = [];
const bodies: { path: string; body: string }[] = [];

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
process.env.OPENCODE_OTEL_DIAG_LOG = "/tmp/otel-verify-diag.log";

const server = Bun.serve({
  port: 4318,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    received.push(`${req.method} ${url.pathname} bytes=${body.length}`);
    bodies.push({ path: url.pathname, body });
    return new Response("", { status: 200 });
  },
});

const events: any[] = [];
const hooks: Record<string, Function> = {};

const ctx: any = {
  options: {
    enabled: true,
    endpoint: "http://127.0.0.1:4318",
    protocol: "http/json",
    metricsInterval: 1000,
    logsInterval: 500,
    logsEnabled: true,
    metricPrefix: "opencode.",
  },
  location: { directory: process.cwd(), project: { id: "verify-proj", canonical: process.cwd() } },
  session: {
    hook: async (name: string, cb: Function) => {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
  },
  event: {
    subscribe: () => ({
      [Symbol.asyncIterator]: async function* () {
        for (const e of events) yield e;
      },
    }),
  },
};

const mod: any = await import("../src/index.ts");
console.log("plugin id:", mod.default.id, "setup:", typeof mod.default.setup);

// Simulate one user turn with a tool call (queued before setup so the
// subscription loop observes them).
const ses = "ses_verify123";
events.push(
  { type: "session.created", created: Date.now(), data: { sessionID: ses, agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" }, title: "verify" } },
  { type: "session.step.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" }, started: Date.now() } },
  { type: "session.tool.input.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_1", name: "shell" } },
  { type: "session.tool.called", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_1", input: { command: "echo hi" }, executed: false } },
  { type: "session.tool.success", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "hi" }], metadata: { status: "completed" }, executed: false } },
  { type: "session.step.ended", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", finish: "tool-calls", cost: 0.0012, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 500, write: 0 } } } },
  { type: "session.usage.updated", created: Date.now(), data: { sessionID: ses, cost: 0.0012, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 500, write: 0 } } } },
  { type: "session.idle", created: Date.now(), data: { sessionID: ses } },
);

const cleanup = await mod.default.setup(ctx);

// Exercise the prompt and model.request hooks directly.
if (hooks.prompt) await hooks.prompt({ sessionID: ses, messageID: "msg_user", prompt: { text: "hello" } });
if (hooks["model.request"]) await hooks["model.request"]({ sessionID: ses, agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" }, kind: "primary", headers: {} });

await new Promise((r) => setTimeout(r, 6000));
await cleanup();
await new Promise((r) => setTimeout(r, 500));
server.stop(true);

console.log("=== received OTLP requests ===");
for (const r of received) console.log(r);
console.log(received.length > 0 ? "PASS: telemetry exported" : "FAIL: nothing exported");

console.log("\n=== trace spans ===");
for (const { path, body } of bodies) {
  if (path !== "/v1/traces") continue;
  const json = JSON.parse(body);
  const byId = new Map<string, string>();
  for (const rs of json.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) byId.set(span.spanId, span.name);
    }
  }
  for (const rs of json.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = Object.fromEntries((span.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue ?? a.value?.boolValue]));
        const parent = span.parentSpanId ? (byId.get(span.parentSpanId) ?? span.parentSpanId) : "(root)";
        console.log(`- ${span.name}  kind=${attrs["openinference.span.kind"] ?? "?"}  trace=${span.traceId.slice(0, 12)}  parent=${parent}`);
      }
    }
  }
}
