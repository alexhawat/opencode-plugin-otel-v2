// Content-capture verification: drive the plugin under one `captureContent` mode and
// assert which prompt/tool bodies reach the exported spans and logs.
//
//   bun run verify/content.ts full|metadata|off
//
// One mode per process: the plugin shares its OTel providers on `globalThis`, so a
// second setup in the same process would reuse the first mode's exporters.
import { contentAttrs, isMetricEnabled } from "../src/util.ts";
import { loadConfig } from "../src/config.ts";

const mode = process.argv[2] as "full" | "metadata" | "off";
if (!["full", "metadata", "off"].includes(mode)) {
  console.error("usage: bun run verify/content.ts full|metadata|off");
  process.exit(2);
}

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: [${mode}] ${label}`);
  if (!ok) failures.push(label);
};

// --- config + helper ---------------------------------------------------------------
const upper = (text: string) => text.toUpperCase();
const build = (text: string) => ({ "input.value": text });
const expected = { full: { "input.value": "ABC" }, metadata: { "input.length": 3 }, off: {} }[mode];
check(JSON.stringify(contentAttrs(mode, upper, "abc", "input.length", build)) === JSON.stringify(expected), "contentAttrs shape");
check(JSON.stringify(contentAttrs(mode, upper, "", "input.length", build)) === "{}", "empty body adds nothing");
check(loadConfig({ captureContent: mode }).captureContent === mode, "option resolves");
check(loadConfig({}).captureContent === "full", "default is full");
check(loadConfig({ captureContent: "everything" as never }).captureContent === "metadata", "invalid value fails closed to metadata");
for (const all of ["all", "*"]) {
  const disabled = loadConfig({ disabledMetrics: [all] }).disabledMetrics;
  check(!isMetricEnabled("token.usage", { disabledMetrics: disabled }), `disabledMetrics ["${all}"] disables every metric`);
}
check(isMetricEnabled("token.usage", loadConfig({ disabledMetrics: ["cost.usage"] })), "named disable leaves others on");
process.env.OPENCODE_CAPTURE_CONTENT = mode;
check(loadConfig({}).captureContent === mode, "OPENCODE_CAPTURE_CONTENT resolves");
delete process.env.OPENCODE_CAPTURE_CONTENT;

// --- end to end --------------------------------------------------------------------
const PROMPT = "verify-prompt-body-7f3a";
const TOOL_INPUT = "verify-tool-input-91c2";
const TOOL_OUTPUT = "verify-tool-output-c0d4";
// Error messages can carry commands, stderr or repository text: the same cap applies.
const ERROR_TEXT = "verify-error-message-e55a";
const bodies: { path: string; body: string }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push({ path: new URL(req.url).pathname, body: await req.text() });
    return new Response("", { status: 200 });
  },
});

const events: any[] = [];
let streamDone = false;
const hooks: Record<string, Function> = {};
const ctx: any = {
  options: {
    enabled: true,
    endpoint: `http://127.0.0.1:${server.port}`,
    protocol: "http/json",
    metricsInterval: 1000,
    logsInterval: 500,
    logsEnabled: true,
    capturePromptInLogs: true,
    captureContent: mode,
  },
  location: { directory: process.cwd(), project: { id: "verify-proj", canonical: process.cwd() } },
  session: {
    hook: async (name: string, cb: Function) => {
      hooks[name] = cb;
      return { dispose: async () => {} };
    },
  },
  event: {
    // A live queue: events pushed after setup (once the prompt hook has run) still flow.
    subscribe: () => ({
      [Symbol.asyncIterator]: async function* () {
        for (let i = 0; !(streamDone && i >= events.length); ) {
          if (i < events.length) yield events[i++];
          else await new Promise((r) => setTimeout(r, 20));
        }
      },
    }),
  },
};

const ses = "ses_content";
const model = { id: "deepseek-v4.1-flash", providerID: "opencode-go" };
events.push({ type: "session.created", created: Date.now(), data: { sessionID: ses, agent: "build", model, title: "content" } });

const mod: any = await import("../src/index.ts");
const cleanup = await mod.default.setup(ctx);
await new Promise((r) => setTimeout(r, 200));
if (hooks.prompt) await hooks.prompt({ sessionID: ses, messageID: "msg_user", prompt: { text: PROMPT } });

events.push(
  { type: "session.execution.started", created: Date.now(), data: { sessionID: ses } },
  { type: "session.step.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", agent: "build", model, started: Date.now() } },
  { type: "session.tool.input.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_1", name: "shell" } },
  { type: "session.tool.called", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_1", input: { command: TOOL_INPUT }, executed: false } },
  { type: "session.tool.success", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: TOOL_OUTPUT }], metadata: { status: "completed" }, executed: false } },
  { type: "session.tool.input.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_2", name: "shell" } },
  { type: "session.tool.called", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_2", input: { command: "false" }, executed: false } },
  { type: "session.tool.failed", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", id: "call_2", error: { type: "ToolError", message: ERROR_TEXT } } },
  // OpenCode reports input without cache and reasoning apart from output.
  { type: "session.step.ended", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_1", finish: "stop", cost: 0.001, tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 500, write: 7 } } } },
  { type: "session.step.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_2", agent: "build", model, started: Date.now() } },
  { type: "session.step.failed", created: Date.now(), data: { sessionID: ses, assistantMessageID: "msg_2", error: { type: "ProviderError", message: ERROR_TEXT } } },
  { type: "session.execution.failed", created: Date.now(), data: { sessionID: ses, error: { type: "ExecutionError", message: ERROR_TEXT } } },
);

streamDone = true;
await new Promise((r) => setTimeout(r, 4000));
await cleanup();
await new Promise((r) => setTimeout(r, 500));
server.stop(true);

const exported = bodies.filter((b) => b.path === "/v1/traces" || b.path === "/v1/logs").map((b) => b.body).join("\n");
const spanAttrKeys = new Set<string>();
for (const { path, body } of bodies) {
  if (path !== "/v1/traces") continue;
  for (const rs of JSON.parse(body).resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const span of ss.spans ?? []) for (const a of span.attributes ?? []) spanAttrKeys.add(a.key);
}

check(bodies.some((b) => b.path === "/v1/traces"), "spans exported");
const spans: { name: string; keys: Set<string>; attrs: Record<string, unknown> }[] = [];
for (const { path, body } of bodies) {
  if (path !== "/v1/traces") continue;
  for (const rs of JSON.parse(body).resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const span of ss.spans ?? []) {
        const attrs = Object.fromEntries((span.attributes ?? []).map((a: any) => [a.key, a.value?.intValue ?? a.value?.stringValue ?? a.value?.doubleValue]));
        spans.push({ name: span.name, keys: new Set(Object.keys(attrs)), attrs });
      }
}
for (const span of spans) {
  check(span.keys.has("gen_ai.operation.name") && span.keys.has("gen_ai.provider.name"), `${span.name} carries gen_ai.operation.name + gen_ai.provider.name`);
}
const bodyMarkers = [PROMPT, TOOL_INPUT, TOOL_OUTPUT];
if (mode === "full") {
  for (const marker of bodyMarkers) check(exported.includes(marker), `body ${marker} exported`);
} else {
  for (const marker of bodyMarkers) check(!exported.includes(marker), `body ${marker} withheld`);
  for (const key of ["input.value", "output.value", "llm.input_messages"]) check(!spanAttrKeys.has(key), `no ${key} attribute`);
}
const errorTypes = ["ToolError", "ProviderError", "ExecutionError"];
if (mode === "full") {
  check(exported.includes(ERROR_TEXT), "error message exported");
} else {
  check(!exported.includes(ERROR_TEXT), "error message withheld from spans and logs");
  for (const type of errorTypes) check(exported.includes(type), `error type ${type} kept`);
}
// Prompt and completion totals include their cache and reasoning breakdowns.
const step = spans.find((s) => s.name.endsWith("llm") && s.attrs["llm.token_count.prompt_details.cache_read"] !== undefined);
check(Number(step?.attrs["llm.token_count.prompt"]) === 517, "prompt tokens include cache read + write");
check(Number(step?.attrs["llm.token_count.completion"]) === 5, "completion tokens include reasoning");
check(Number(step?.attrs["llm.token_count.total"]) === 522, "total tokens = prompt + completion");
check(spanAttrKeys.has("input.length") === (mode === "metadata"), `input.length ${mode === "metadata" ? "present" : "absent"}`);
check(spanAttrKeys.has("output.length") === (mode === "metadata"), `output.length ${mode === "metadata" ? "present" : "absent"}`);

if (failures.length) {
  console.error(`${failures.length} content-capture check(s) failed in mode ${mode}`);
  process.exit(1);
}
process.exit(0);
