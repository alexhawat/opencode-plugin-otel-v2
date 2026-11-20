// Verifies the readable span labels (`logfire.msg`) against a local OTLP receiver.
//   bun run verify/labels.ts full       labels carry redacted, one-line detail
//   bun run verify/labels.ts metadata   labels carry the structural head only
//   bun run verify/labels.ts off        (spanLabels: false) no label attribute at all
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
process.env.OPENCODE_OTEL_DIAG_LOG = "/tmp/otel-verify-diag.log";

const mode = (process.argv[2] ?? "full") as "full" | "metadata" | "off";
const bodies: { path: string; body: string }[] = [];
const server = Bun.serve({
  port: 4324,
  async fetch(req) {
    const u = new URL(req.url);
    bodies.push({ path: u.pathname, body: await req.text() });
    return new Response("", { status: 200 });
  },
});

const SECRET = "sk-verifylabelsecret0123456789abcdef";
const opts = {
  enabled: true,
  endpoint: "http://127.0.0.1:4324",
  protocol: "http/json",
  metricsInterval: 1000,
  logsInterval: 500,
  logsEnabled: true,
  metricPrefix: "opencode.",
  captureContent: mode === "metadata" ? "metadata" : "full",
  spanLabels: mode !== "off",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    get: async ({ sessionID }: { sessionID: string }) => ({
      // OpenCode often cannot name the agent when a turn starts.
      agent: sessionID === "ses_label_late" ? undefined : sessionID === "ses_label_child" ? "wave-plan-executor" : "build",
      model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" },
    }),
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

const mod: any = await import("../src/index.ts");
const cleanup = (await mod.default.setup(ctx)) ?? (async () => {});
const now = () => Date.now();
const P = "ses_label_parent";
const C = "ses_label_child";
const LONG_PROMPT = `Execute the wave plan\n  wave by wave.   Token ${SECRET} must not leak. ` + "x".repeat(300);

await hooks.prompt({ sessionID: P, messageID: "m_user", prompt: { text: LONG_PROMPT } });
events.push(
  { type: "session.execution.started", created: now(), data: { sessionID: P } },
  { type: "session.step.started", created: now(), data: { sessionID: P, assistantMessageID: "m_a", agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } } },
  { type: "session.tool.input.started", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_read", name: "read" } },
  { type: "session.tool.called", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_read", input: { filePath: "src/queue.rs" }, executed: false } },
  { type: "session.tool.success", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_read", content: [{ type: "text", text: "ok" }] } },
  { type: "session.tool.input.started", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_sh", name: "shell" } },
  { type: "session.tool.called", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_sh", input: { command: "make test\n  TEST_ARGS=--test queue" }, executed: false } },
  { type: "session.tool.success", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_sh", content: [{ type: "text", text: "ok" }] } },
  { type: "session.tool.input.started", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_sub", name: "subagent" } },
  { type: "session.tool.called", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_sub", input: { agent: "wave-plan-executor", description: "Execute W5 queue leases responses", prompt: "long brief" }, executed: false } },
  { type: "session.created", created: now(), data: { sessionID: C, parentID: P, agent: "wave-plan-executor", title: "Execute W5 queue leases responses" } },
);
await sleep(150);
await hooks.prompt({ sessionID: C, messageID: "m_c_user", prompt: { text: "Run wave W5." } });
events.push(
  { type: "session.execution.started", created: now(), data: { sessionID: C } },
  { type: "session.step.started", created: now(), data: { sessionID: C, assistantMessageID: "m_c_a", agent: "wave-plan-executor", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } } },
  { type: "session.step.ended", created: now(), data: { sessionID: C, assistantMessageID: "m_c_a", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  { type: "session.execution.succeeded", created: now(), data: { sessionID: C } },
);
await sleep(300);
events.push(
  { type: "session.tool.success", created: now(), data: { sessionID: P, assistantMessageID: "m_a", id: "c_sub", content: [{ type: "text", text: "done" }] } },
  { type: "session.step.ended", created: now(), data: { sessionID: P, assistantMessageID: "m_a", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  { type: "session.execution.succeeded", created: now(), data: { sessionID: P } },
);
await sleep(600);

// A turn whose agent is unknown at the start and only named by its first step.
const L = "ses_label_late";
await hooks.prompt({ sessionID: L, messageID: "m_l_user", prompt: { text: "Late agent." } });
events.push(
  { type: "session.execution.started", created: now(), data: { sessionID: L } },
  { type: "session.step.started", created: now(), data: { sessionID: L, assistantMessageID: "m_l_a", agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } } },
  { type: "session.step.ended", created: now(), data: { sessionID: L, assistantMessageID: "m_l_a", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  { type: "session.execution.succeeded", created: now(), data: { sessionID: L } },
);
await sleep(500);
closed = true;
await cleanup();
server.stop(true);

const spans: any[] = [];
const attr = (s: any) => Object.fromEntries((s.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue]));
for (const { path, body } of bodies) {
  if (path !== "/v1/traces") continue;
  const j = JSON.parse(body);
  for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push(sp);
}
const label = (s: any) => attr(s)["logfire.msg"] as string | undefined;
const find = (name: string, session: string, extra: (s: any) => boolean = () => true) =>
  spans.find((s) => s.name === name && attr(s)["session.id"] === session && extra(s));

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`   ${cond ? "ok  " : "FAIL"} [${mode}] ${msg}`);
  if (!cond) failures++;
}

const parentTurn = find("opencode.session", P);
const read = find("opencode.tool.read", P);
const shell = find("opencode.tool.shell", P);
const dispatch = find("opencode.tool.subagent", P);
const childSession = find("opencode.session", C, (s) => s.parentSpanId === dispatch?.spanId);
const childTurn = find("opencode.session", C, (s) => s.parentSpanId === childSession?.spanId);
const llm = find("opencode.llm", P);

console.log(`\nspans=${spans.length}`);
check(!!parentTurn && !!read && !!shell && !!dispatch && !!childSession && !!childTurn && !!llm, "all expected spans were exported");
check(spans.every((s) => /^opencode\.(session|llm|tool\.[a-z]+)$/.test(s.name)), "span names are unchanged and low-cardinality");

if (mode === "off") {
  check(spans.every((s) => label(s) === undefined), "no span carries a label when spanLabels is false");
} else {
  check(label(llm) === "llm deepseek-v4.1-flash", "llm step is labelled with its model");
  check(label(childSession)?.startsWith("subagent wave-plan-executor") === true, "subagent session is labelled with its agent");
  check(label(dispatch)?.startsWith("dispatch wave-plan-executor") === true, "dispatch is labelled with the agent it starts");
  check(label(parentTurn)?.startsWith("build turn") === true, "turn is labelled with its agent");
  check(label(childTurn)?.startsWith("wave-plan-executor turn") === true, "subagent turn is labelled with its agent");
  check(label(childSession) !== label(childTurn), "a subagent's session and its turn have different labels");
  const late = find("opencode.session", "ses_label_late");
  check(!!late && !(label(late) ?? "").includes("unknown"), "a turn is never labelled with an unknown agent");
  check(label(late)?.startsWith("build turn") === true, "a turn is relabelled once its agent is known");
  if (mode === "full") {
    check(label(read) === "read: src/queue.rs", "read is labelled with its path");
    check(label(shell) === "shell: make test TEST_ARGS=--test queue", "a multi-line command becomes one line");
    check(label(dispatch) === "dispatch wave-plan-executor: Execute W5 queue leases responses", "dispatch carries the description");
    check(label(childSession) === "subagent wave-plan-executor: Execute W5 queue leases responses", "subagent session carries its title");
    check(label(childTurn) === "wave-plan-executor turn: Run wave W5.", "subagent turn carries its prompt");
    const l = label(parentTurn) ?? "";
    check(l.startsWith("build turn: Execute the wave plan wave by wave."), "turn carries the start of its prompt on one line");
check(l.length <= 110 && l.endsWith("…"), "a long prompt is truncated");
    check(spans.every((s) => !(label(s) ?? "").includes(SECRET)), "a secret in the prompt never reaches a label");
  } else {
    check(label(read) === "read", "tool label has no argument outside full capture");
    check(label(shell) === "shell", "shell label has no command outside full capture");
    check(label(dispatch) === "dispatch wave-plan-executor", "dispatch label has no description outside full capture");
    check(label(childSession) === "subagent wave-plan-executor", "subagent label has no title outside full capture");
    check(label(parentTurn) === "build turn", "turn label has no prompt outside full capture");
  }
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
