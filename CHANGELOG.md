# Changelog

## Unreleased

- **feat: `captureContent` option (`OPENCODE_CAPTURE_CONTENT`).** Controls whether prompt text and
  tool input/output reach exported spans: `full` (the default, unchanged behaviour — bodies after
  `redactSecrets`), `metadata` (no bodies, only `input.length` / `output.length` character counts),
  or `off` (neither). The `user_prompt` log's prompt text now also requires `full`. An unrecognised
  value fails closed to `metadata`. A host that must not export repository content — for example a
  reviewer running untrusted pull requests — can now keep the LLM/tool span structure while
  withholding the bodies.
- **feat: `disabledMetrics: ["all"]` (or `"*"`) silences every metric**, matching `disabledTraces`.
  Useful when the backend bills OTLP metrics separately and only traces are wanted.
- **feat: `gen_ai.cost.estimated_total` on LLM step spans**, next to `llm.cost.total`.
  Datadog LLM Observability reads estimated cost from the `gen_ai.cost.*` namespace and
  showed no cost for OpenCode sessions without it.
- verify: `verify/content.ts` asserts which bodies reach spans and logs in each mode.

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
