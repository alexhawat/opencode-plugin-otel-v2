# Changelog

## Unreleased

- **feat: readable span labels (`spanLabels`, on by default).** A subagent's session and each of
  its turns were all named `opencode.session`, and nothing in a trace row said which agent or
  task it was. Every span now also carries a label in `logfire.msg`, which Pydantic Logfire shows
  as the row's message: `build turn: <prompt>`, `subagent wave-plan-executor: <title>`,
  `dispatch wave-plan-executor: <description>`, `read: src/queue.rs`, `shell: make test`,
  `llm deepseek-v4.1-flash`. Span names are unchanged. The detail after the colon is redacted,
  one line, truncated, and only present when `captureContent` is `full`. Set `spanLabels: false`
  or `OPENCODE_NO_SPAN_LABELS` to turn labels off.
- verify: `verify/labels.ts` asserts the labels in `full`, `metadata` and disabled modes,
  including that a secret in a prompt never reaches a label.
- **feat: `pendingSpans` option (`OPENCODE_PENDING_SPANS`): running turns show as a tree.** A
  span is exported when it ends, and a turn's root span can stay open for hours, so the LLM and
  tool spans of a running turn reached the backend with a parent it had never seen and were
  listed as loose rows. The plugin now also exports a zero-length placeholder for each span when
  it starts, in Pydantic Logfire's pending-span shape (`logfire.span_type=pending_span`,
  `logfire.pending_parent_id`, the real span as parent). Logfire shows the span as ongoing with
  its children nested, and replaces the placeholder when the real span arrives. The default
  `auto` enables it only for a Logfire endpoint (`logfire-*.pydantic.dev`); `true` / `false`
  force it. Real spans are unchanged.
- **fix: the turn's outcome log joins the turn's trace.** `session.execution.succeeded`,
  `session.execution.interrupted` and `session.error` were emitted after the run span ended,
  with no trace context, so each became a one-record trace of its own. They now carry the run
  span's context.
- verify: `verify/pending.ts` asserts that a running turn has already exported placeholders
  for its root span and open LLM step, that the real spans arrive under the ids the
  placeholders pointed at, that the outcome log is in the turn's trace, and the `auto` rule.
- **feat: `captureContent` option (`OPENCODE_CAPTURE_CONTENT`).** Controls whether prompt text and
  tool input/output reach exported spans: `full` (the default, unchanged behaviour — bodies after
  `redactSecrets`), `metadata` (no bodies, only `input.length` / `output.length` character counts),
  or `off` (neither). The `user_prompt` log's prompt text now also requires `full`. An unrecognised
  value fails closed to `metadata`. Outside `full`, error messages are withheld too (span status,
  `error` attribute, `session.error` log): only the error type is exported. Instances in one
  process (one per location) all apply the strictest mode any of them sets, because they share
  an event stream and any instance may handle another location's events. A host that must not
  export repository content — for example a reviewer running untrusted pull requests — can now
  keep the LLM/tool span structure while withholding the bodies.
- **feat: `disabledMetrics: ["all"]` (or `"*"`) silences every metric**, matching `disabledTraces`.
  Useful when the backend bills OTLP metrics separately and only traces are wanted.
- **feat: OTel GenAI operation on every span.** Session spans carry
  `gen_ai.operation.name=invoke_agent`, tool spans `execute_tool` (with `gen_ai.tool.name`) and
  LLM steps `chat` (with `gen_ai.request.model`), plus `gen_ai.provider.name`, next to the
  OpenInference span kind. Datadog LLM Observability flagged spans without them as
  unidentified instrumentation.
- **fix: LLM step token counts follow OpenInference totals.** OpenCode reports input without
  cached tokens and reasoning apart from output; `llm.token_count.prompt` now includes cache reads
  and writes, `llm.token_count.completion` includes reasoning, and the total is their sum. Datadog
  LLM Observability previously derived negative uncached input from these spans.
- verify: `verify/content.ts` asserts which bodies (including error messages) reach spans and logs
  in each mode, and the token totals; `verify/content-mixed.ts` covers a `full` and a `metadata`
  instance sharing one process.

## 0.3.3

- **`project.id` is now deterministic and consistent.** It is `sha1(project.directory)` (40 hex),
  derived from the same value as `project.name` / `project.directory`, instead of OpenCode's
  instance-scoped project id (which is `global` for non-git sessions and varied between plugin
  instances). Every span, log and metric for a session now shares one `project.id`.

## 0.3.2

- **fix: take `project.name` / `project.directory` / `project.id` from each event's own location.**
  OpenCode evaluates the plugin once per location and routes a session's events to whichever
  instance receives them first, so instance-level attributes could be wrong — e.g.
  `session.execution.succeeded` reporting the home directory while sibling spans reported the real
  project. The dispatch loop now derives the session's project attributes from the event's
  `location.directory` (and `projectID` at `session.created`) before the handler runs, so the
  instance that emits the record always has the correct value.

## 0.3.1

- **fix: identify the project by the session's working directory, not OpenCode's project root.**
  `project.name` / `project.directory` are now taken from the session's location directory (its
  basename) and set per session at `session.created`. A non-git folder like `~/code/test` now
  reports `test` instead of the home directory (where OpenCode's project root falls back for
  non-git directories). The instance-level attributes remain as a fallback for sessions that
  predate the plugin.

## 0.3.0

- **feat: human-readable `project.name` and `project.directory` on every span, log and metric.**
  Both are derived from the session location at startup, so no per-repo file is needed. For a git
  worktree session the repository root is used, so linked worktrees report the parent repo's name
  rather than the worktree directory. `project.id` (the existing hash) is unchanged.

## 0.2.0

- **fix: default metrics to `delta` temporality.** Under the SDK default (`cumulative`) every
  metric series was re-exported on every interval for the lifetime of the process, with no idle
  stop, and the series set grew with each session (session/run/wave attributes). In one incident
  this reached ~1.6M metric points/day while all sessions were idle and exhausted the backend's
  ingest quota. Delta reports only changes: idle periods export nothing. Override with
  `metricsTemporality`, `OPENCODE_OTLP_METRICS_TEMPORALITY`, or the standard
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`; `cumulative` remains available for
  short-lived processes. This also matches Logfire's OTLP metric ingest, which expects delta.
- verify: the e2e harness now asserts that no metric exports occur while idle.
- The "starting up" diagnostic now records the resolved metrics temporality.

## 0.1.0

Initial V2 port of [`@devtheops/opencode-plugin-otel`](https://github.com/DEVtheOPS/opencode-plugin-otel)
(V1-only; upstream issue #128). Verified against OpenCode 2.0.15.

- Re-architected the handlers onto V2's granular event stream
  (`session.step.*`, `session.tool.*`, `session.usage.*`, `session.execution.*`,
  `session.retry.scheduled`).
- Turn root span anchored on `session.execution.started` → `session.execution.succeeded` /
  `failed` / `interrupted` (`session.idle` is not emitted by V2).
- Shared OTel providers + tracing state on `globalThis` (V2 loads a global plugin per location);
  providers are flushed but never shut down.
- Event deduplication by `event.id` across plugin instances.
- `user_prompt` log emitted on the first step, linked to the run span, with resolved agent/model.
- Prompt-text capture (`capturePromptInLogs`) and best-effort secret redaction
  (`redactSecrets`, `redactValues`).
- Per-location attributes: a location-relative JSON file (`locationAttributes`, default
  `.opencode/attributes.json`) is read at `session.created` and merged into that session's
  spans/logs/metrics.
- Not ported from V1: message/part spans, permission telemetry, `command.executed`,
  `session.diff` metrics.
