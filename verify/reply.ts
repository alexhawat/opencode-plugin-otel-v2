// Verifies that the assistant's reply text reaches the LLM step span, under captureContent.
//   bun run verify/reply.ts full       redacted text in output.value and llm.output_messages
//   bun run verify/reply.ts metadata   output.length only
//   bun run verify/reply.ts off        nothing
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
process.env.OPENCODE_OTEL_DIAG_LOG = "/tmp/otel-verify-diag.log";

const mode = (process.argv[2] ?? "full") as "full" | "metadata" | "off";
const bodies: { path: string; body: string }[] = [];
const server = Bun.serve({
  port: 4325,
  async fetch(req) {
    const u = new URL(req.url);
    bodies.push({ path: u.pathname, body: await req.text() });
    return new Response("", { status: 200 });
  },
});

const SECRET = "sk-verifyreplysecret0123456789abcdef";
const opts = {
  enabled: true,
  endpoint: "http://127.0.0.1:4325",
  protocol: "http/json",
  metricsInterval: 1000,
  logsInterval: 500,
  logsEnabled: true,
  metricPrefix: "opencode.",
  captureContent: mode,
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
    get: async () => ({ agent: "build", model: { id: "m", providerID: "p" } }),
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
const S = "ses_reply";
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
const step = (id: string) => ({ type: "session.step.started", created: now(), data: { sessionID: S, assistantMessageID: id, agent: "build", model: { id: "m", providerID: "p" } } });
const end = (id: string) => ({ type: "session.step.ended", created: now(), data: { sessionID: S, assistantMessageID: id, finish: "stop", cost: 0, tokens } });
const text = (id: string, ordinal: number, t: string) => ({ type: "session.text.ended", created: now(), data: { sessionID: S, assistantMessageID: id, ordinal, text: t } });

await hooks.prompt({ sessionID: S, messageID: "m_user", prompt: { text: "go" } });
events.push(
  { type: "session.execution.started", created: now(), data: { sessionID: S } },
  // Step 1: two segments arriving out of order, one holding a secret.
  step("m_1"),
  text("m_1", 1, `Dispatching the W5 executor with ${SECRET}.`),
  text("m_1", 0, "The state is clear."),
  end("m_1"),
  // Step 2: tool-only step, no text.
  step("m_2"),
  end("m_2"),
  // A segment for a step that is not open is dropped, and must not land on step 3.
  text("m_gone", 0, "stray segment"),
  // Step 3: a very long reply.
  step("m_3"),
  text("m_3", 0, "y".repeat(70_000)),
  end("m_3"),
  { type: "session.execution.succeeded", created: now(), data: { sessionID: S } },
);
await sleep(800);
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
const llm = spans.filter((s) => s.name === "opencode.llm").sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`   ${cond ? "ok  " : "FAIL"} [${mode}] ${msg}`);
  if (!cond) failures++;
}

console.log(`\nllm spans=${llm.length}`);
check(llm.length === 3, "three llm step spans were exported");
const [one, two, three] = llm.map(attr);
const everything = JSON.stringify(spans);
check(!everything.includes(SECRET), "a secret in a reply is never exported");
check(!everything.includes("stray segment"), "a segment for a step that is not open is dropped");
check(two?.["output.value"] === undefined && two?.["output.length"] === undefined, "a step without text has no output attributes");

if (mode === "full") {
  const value = String(one?.["output.value"] ?? "");
  check(value.startsWith("The state is clear.\nDispatching the W5 executor with "), "segments are joined in order, whatever order they arrived in");
  check(one?.["output.mime_type"] === "text/plain", "the reply is marked as plain text");
  const messages = JSON.parse(String(one?.["llm.output_messages"] ?? "[]"));
  check(messages[0]?.role === "assistant" && messages[0]?.content === value, "llm.output_messages holds the same assistant message");
  check(String(three?.["output.value"] ?? "").length === 64_000, "a very long reply is capped at 64,000 characters");
  check(String(one?.["logfire.msg"]).startsWith("llm m: The state is clear. Dispatching the W5 executor"), "the step's label shows the start of the reply on one line");
  check(two?.["logfire.msg"] === "llm m", "a step without text keeps the plain label");
  check(String(three?.["logfire.msg"]).length <= 110, "a long reply is truncated in the label");
} else if (mode === "metadata") {
  check(one?.["output.value"] === undefined && one?.["llm.output_messages"] === undefined, "no reply text outside full capture");
  check(Number(one?.["output.length"]) > 40, "the reply's length is recorded instead");
  check(one?.["logfire.msg"] === "llm m", "the label carries no reply text outside full capture");
} else {
  check(llm.every((s) => attr(s)["output.value"] === undefined && attr(s)["output.length"] === undefined && attr(s)["llm.output_messages"] === undefined), "nothing about the reply is exported when capture is off");
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
