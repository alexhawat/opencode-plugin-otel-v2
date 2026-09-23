# Changelog

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
- Per-location attributes: `<location>/.ignorelocal/wave-run.json` is read at `session.created`
  and merged into that session's spans/logs/metrics (used to tag wave runs by `run.id`).
- Not ported from V1: message/part spans, permission telemetry, `command.executed`,
  `session.diff` metrics.
