// Verifies trace structure end to end against a local OTLP receiver:
//   1. single instance — spans link into one trace
//   2. cross-instance — prompt hook on A, events on B
//   3. subagent — child session nests under the parent's dispatch tool span, one trace
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
      subscribe: () => ({
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: async () => {
              while (i >= events.length) {
                if (closed) return { done: true, value: undefined };
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

const mod: any = await import("../src/index.ts");

function turn(sessionID: string, asstMsg: string, callId: string) {
  return [
    { type: "session.execution.started", created: Date.now(), data: { sessionID } },
    { type: "session.step.started", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, agent: "build", model: { id: "m", providerID: "p" }, started: Date.now() } },
    { type: "session.tool.input.started", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, id: callId, name: "read" } },
    { type: "session.tool.called", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, id: callId, input: { filePath: "x" }, executed: false } },
    { type: "session.tool.success", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, id: callId, content: [{ type: "text", text: "ok" }] } },
    { type: "session.step.ended", created: Date.now(), data: { sessionID, assistantMessageID: asstMsg, finish: "stop", cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { type: "session.execution.succeeded", created: Date.now(), data: { sessionID } },
  ];
}

const cleanups: Array<() => Promise<void>> = [];

// Test 1: single instance.
{
  const a = makeCtx();
  cleanups.push((await mod.default.setup(a.ctx)) ?? (async () => {}));
  await a.hooks.prompt({ sessionID: "ses_single", messageID: "msg_user_1", prompt: { text: "hi" } });
  a.push(...turn("ses_single", "msg_asst_1", "call_1"));
  a.close();
  await sleep(1200);
}

// Test 2: prompt hook on A, events on B.
{
  const a = makeCtx();
  const b = makeCtx();
  cleanups.push((await mod.default.setup(a.ctx)) ?? (async () => {}));
  cleanups.push((await mod.default.setup(b.ctx)) ?? (async () => {}));
  await a.hooks.prompt({ sessionID: "ses_multi", messageID: "msg_user_2", prompt: { text: "hi" } });
  b.push(...turn("ses_multi", "msg_asst_2", "call_2"));
  b.close();
  await sleep(1200);
}

// Test 3: subagent dispatch nests the child session under the parent's tool.subagent span.
{
  const a = makeCtx();
  cleanups.push((await mod.default.setup(a.ctx)) ?? (async () => {}));
  await a.hooks.prompt({ sessionID: "ses_p", messageID: "msg_p_user", prompt: { text: "run the wave" } });
  a.push(
    { type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_p" } },
    { type: "session.tool.input.started", created: Date.now(), data: { sessionID: "ses_p", assistantMessageID: "msg_p_asst", id: "call_sub", name: "subagent" } },
    { type: "session.tool.called", created: Date.now(), data: { sessionID: "ses_p", assistantMessageID: "msg_p_asst", id: "call_sub", input: { agent: "explore" }, executed: true } },
    { type: "session.created", created: Date.now(), data: { sessionID: "ses_c", parentID: "ses_p", agent: "explore" } },
  );
  await sleep(120);
  await a.hooks.prompt({ sessionID: "ses_c", messageID: "msg_c_user", prompt: { text: "list files" } });
  a.push(...turn("ses_c", "msg_c_asst", "call_c1"));
  await sleep(400);
  a.push(
    { type: "session.tool.success", created: Date.now(), data: { sessionID: "ses_p", assistantMessageID: "msg_p_asst", id: "call_sub", content: [{ type: "text", text: "done" }] } },
    { type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_p" } },
  );
  await sleep(600);
  a.close();
}

await sleep(600);
for (const c of cleanups) await c();
await sleep(600);
server.stop(true);

const spans: any[] = [];
const attr = (s: any) => Object.fromEntries((s.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue]));
for (const { path, body } of bodies) {
  if (path !== "/v1/traces") continue;
  const j = JSON.parse(body);
  for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push(sp);
}

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`   ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

for (const sessionID of ["ses_single", "ses_multi"]) {
  const mine = spans.filter((s) => attr(s)["session.id"] === sessionID);
  const traces = new Set(mine.map((s) => s.traceId));
  console.log(`\n${sessionID}: spans=${mine.length} distinct_traces=${traces.size}`);
  check(traces.size === 1, "all spans share one trace");
  const run = mine.find((s) => s.name === "opencode.session");
  check(!!run && !run.parentSpanId, "run span is the trace root");
  check(mine.some((s) => s.name === "opencode.llm" && s.parentSpanId === run?.spanId), "llm span is a child of the run span");
  check(mine.some((s) => s.name === "opencode.tool.read" && s.parentSpanId === run?.spanId), "tool span is a child of the run span");
}

{
  const parentSpans = spans.filter((s) => attr(s)["session.id"] === "ses_p");
  const childSpans = spans.filter((s) => attr(s)["session.id"] === "ses_c");
  const all = [...parentSpans, ...childSpans];
  const traces = new Set(all.map((s) => s.traceId));
  console.log(`\nsubagent: parent_spans=${parentSpans.length} child_spans=${childSpans.length} distinct_traces=${traces.size}`);
  check(traces.size === 1, "parent and subagent share one trace");
  const dispatch = parentSpans.find((s) => s.name === "opencode.tool.subagent");
  const childSessionSpans = childSpans.filter((s) => s.name === "opencode.session");
  const childSession = childSessionSpans.find((s) => s.parentSpanId === dispatch?.spanId);
  const childRun = childSessionSpans.find((s) => s.parentSpanId === childSession?.spanId);
  const childLlm = childSpans.find((s) => s.name === "opencode.llm");
  const childTool = childSpans.find((s) => s.name === "opencode.tool.read");
  check(!!dispatch, "parent has an opencode.tool.subagent span");
  check(childSessionSpans.length > 0 && childSessionSpans.every((s) => !!s.parentSpanId), "no orphan root session span for the subagent");
  check(!!childSession, "child session span nests under the dispatch tool span");
  check(!!childRun, "subagent run span nests under the child session span");
  check(!!childLlm && childLlm.parentSpanId === childRun?.spanId, "child llm span nests under the subagent run span");
  check(!!childTool && childTool.parentSpanId === childRun?.spanId, "child tool span nests under the subagent run span");
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
