# Changelog

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
