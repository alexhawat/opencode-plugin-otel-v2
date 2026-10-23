// Mixed-mode verification: two plugin instances in one process, one `full` and one
// `metadata`. OpenCode evaluates the plugin once per location; the instances share one
// event stream and dedupe events across each other, so the `full` instance can be the
// one that handles the stricter location's events. Every instance must then apply the
// strictest mode in force.
//
//   bun run verify/content-mixed.ts
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: [mixed] ${label}`);
  if (!ok) failures.push(label);
};

const PROMPT = "mixed-prompt-body-4c1e";
const TOOL_OUTPUT = "mixed-tool-output-77b0";
const bodies: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/traces" || path === "/v1/logs") bodies.push(await req.text());
    return new Response("", { status: 200 });
  },
});

function instance(captureContent: "full" | "metadata", events: any[]) {
  const hooks: Record<string, Function> = {};
  const state = { done: false };
  const ctx: any = {
    options: {
      enabled: true,
      endpoint: `http://127.0.0.1:${server.port}`,
      protocol: "http/json",
      logsEnabled: true,
      logsInterval: 500,
      capturePromptInLogs: true,
      captureContent,
    },
    location: { directory: process.cwd(), project: { id: `proj-${captureContent}`, canonical: process.cwd() } },
    session: {
      hook: async (name: string, cb: Function) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: async function* () {
          for (let i = 0; !(state.done && i >= events.length); ) {
            if (i < events.length) yield events[i++];
            else await new Promise((r) => setTimeout(r, 20));
          }
        },
      }),
    },
  };
  return { ctx, hooks, state, events };
}

const mod: any = await import("../src/index.ts");
const full = instance("full", []);
const strict = instance("metadata", []);
const cleanupFull = await mod.default.setup(full.ctx);
const cleanupStrict = await mod.default.setup(strict.ctx);
await new Promise((r) => setTimeout(r, 200));

// The strict location's prompt arrives through its own hook, but its events reach the
// `full` instance's stream (and only that one).
const ses = "ses_strict";
const model = { id: "deepseek-v4.1-flash", providerID: "opencode-go" };
full.events.push({ id: "e1", type: "session.created", created: Date.now(), data: { sessionID: ses, agent: "build", model, title: "strict" } });
if (strict.hooks.prompt) await strict.hooks.prompt({ sessionID: ses, messageID: "msg_user", prompt: { text: PROMPT } });
full.events.push(
  { id: "e2", type: "session.execution.started", created: Date.now(), data: { sessionID: ses } },
  { id: "e3", type: "session.step.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "m1", agent: "build", model, started: Date.now() } },
  { id: "e4", type: "session.tool.input.started", created: Date.now(), data: { sessionID: ses, assistantMessageID: "m1", id: "c1", name: "read" } },
  { id: "e5", type: "session.tool.called", created: Date.now(), data: { sessionID: ses, assistantMessageID: "m1", id: "c1", input: { path: "x" }, executed: false } },
  { id: "e6", type: "session.tool.success", created: Date.now(), data: { sessionID: ses, assistantMessageID: "m1", id: "c1", content: [{ type: "text", text: TOOL_OUTPUT }], executed: false } },
  { id: "e7", type: "session.step.ended", created: Date.now(), data: { sessionID: ses, assistantMessageID: "m1", finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  { id: "e8", type: "session.execution.succeeded", created: Date.now(), data: { sessionID: ses } },
);
full.state.done = true;
strict.state.done = true;
await new Promise((r) => setTimeout(r, 3000));
await cleanupStrict();
await cleanupFull();
await new Promise((r) => setTimeout(r, 500));
server.stop(true);

const exported = bodies.join("\n");
check(exported.length > 0, "spans exported");
check(!exported.includes(PROMPT), "strict location's prompt withheld by the full instance");
check(!exported.includes(TOOL_OUTPUT), "strict location's tool output withheld by the full instance");

if (failures.length) {
  console.error(`${failures.length} mixed-mode check(s) failed`);
  process.exit(1);
}
process.exit(0);
