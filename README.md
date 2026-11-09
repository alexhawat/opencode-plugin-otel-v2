# opencode-plugin-otel-v2

OpenTelemetry telemetry for **OpenCode V2**. Exports session, LLM-step and tool spans, plus
token/cost/cache metrics and structured logs, to any OTLP endpoint (gRPC or HTTP).

This plugin began as a port of [`@devtheops/opencode-plugin-otel`](https://github.com/DEVtheOPS/opencode-plugin-otel).
Both projects now support OpenCode V2. This fork was verified against OpenCode **2.0.15**.

## Features

| Area | What this plugin exports or controls |
| --- | --- |
| Traces | One root span per turn, LLM spans per step, and named tool spans with input, output, duration, and error status. Subagent sessions can nest under their dispatch tool. Spans carry OpenInference and GenAI attributes. |
| Usage and timing | Counters for sessions, messages, model usage, tokens, cost, cache reads and writes, and retries. Histograms for tool duration, session duration, and session token and cost totals. Tool timing and model metrics also work when their spans are disabled. |
| Structured logs | Session creation, success, interruption, failure, and observed idle events. The first LLM step emits a `user_prompt` log linked to the active turn span when available. Prompt text in logs is opt-in. |
| Content and redaction | Choose full bodies, metadata only, or no bodies for prompts, tool payloads, and errors. Full capture redacts recognized credential patterns, secret environment values, and configured literals by default. Concurrent locations use the strictest active capture mode. |
| Project and run attributes | Filter telemetry by project name, directory, and stable directory-derived ID. Set resource or span attributes in config, or load per-location tags such as `run.id` and `build.id` from `.opencode/attributes.json`. |
| Trace propagation | Attach turn roots to an incoming W3C `traceparent` and optional `tracestate`. For selected providers, propagate an active LLM step’s context through the `model.request` hook. |
| OTLP export | Send traces, metrics, and logs over gRPC, HTTP/protobuf, or HTTP/JSON. Supply static headers or a helper that refreshes credentials and retries an export after an authentication failure. |
| Signal controls | Set the metric prefix, metric and log export intervals, and delta, cumulative, or low-memory aggregation. Disable logs, individual metrics, or session, LLM, and tool traces independently. |
| Multiple locations and diagnostics | Compatible locations share exporters and deduplicate events by ID. Final teardown flushes pending telemetry and releases the providers. A startup probe checks collector reachability. Set `OPENCODE_OTEL_DIAG_LOG` to choose the diagnostic log path. |

## Comparison with the upstream V2 plugin

Both packages support OpenCode V2 and register the plugin ID `devtheops.otel`. Configure one package per installation. This table compares [this fork on `main` at `91463c9`](https://github.com/alexhawat/opencode-plugin-otel-v2/tree/91463c9f17343d12a670765a6ee8d16b8c3cda55) with [DEVtheOPS v2.0.1](https://github.com/DEVtheOPS/opencode-plugin-otel/tree/v2.0.1).

| Behavior | This fork · `opencode-plugin-otel-v2` | Upstream · `@devtheops/opencode-plugin-otel` |
| --- | --- | --- |
| Prompt and tool content | `captureContent` selects `full`, `metadata`, or `off`. The default is `full` with best-effort secret redaction. | Enabled spans can carry prompt and tool bodies. `capturePromptInLogs` controls prompt text in logs only. |
| Model inputs and outputs | The turn span captures the admitted prompt according to the content policy. LLM spans record model, usage, cost, and finish reason. | LLM spans can include completed assistant text. Optional `captureModelContext` adds a bounded preview of the system and conversation text visible to the model. |
| Project attribution | Directory-derived `project.id`, human-readable project name and directory, and per-location JSON attributes. | Uses OpenCode’s project ID and configured common attributes. |
| Metrics export | Defaults to delta. Idle intervals produce no new metric exports. | Defaults to cumulative. Set `metricsTemporality` to `delta` for delta export. |
| Token dashboards | `opencode.token.usage` adds input, output, and reasoning into one value per step. Cache token quantities appear on LLM spans. | `opencode.token.usage` has separate `type` series for input, output, reasoning, cache reads, and cache writes. |
| Retries and activity | Counts retry status notifications. Emits turn outcome and prompt logs. | Counts durable `session.retry.scheduled` events. Also emits permission decisions, API request/error logs, tool-result logs, and commit activity inferred from shell commands. |
| Outbound trace headers | Injects headers through `model.request` for matching active steps. | Also supports the experimental WebSocket handshake hook for selected providers. |
| Changing exporters | After the last location closes, the next setup can use a new endpoint or credentials. | Keeps the shared providers after the last location closes. Changing their configuration requires a process restart. |

When switching packages, check dashboards that group tokens by `type` or filter on `project.id`. Both the available token series and the source of the project ID change.

## Requirements

- OpenCode **2.0.x**
- An OTLP endpoint (e.g. Logfire, Grafana, Honeycomb, a local collector)

## Install

### npm

```sh
opencode plugin add opencode-plugin-otel-v2
```

### Git

```sh
opencode plugin add github:alexhawat/opencode-plugin-otel-v2
```

### Local directory

Clone the repo and point the config at the directory (V2 requires a **directory**, not a file).
Don't clone it into `~/.config/opencode/plugins/` or `.opencode/plugins/`: OpenCode V2
auto-loads those folders, so together with the config entry the plugin loads twice
(duplicate spans and metrics). Use a path such as `~/.local/share/opencode-plugins/`:

```jsonc
{ "plugins": [{ "package": "/absolute/path/to/opencode-plugin-otel-v2" }] }
```

Then add the plugin entry (see [`examples/opencode.jsonc`](./examples/opencode.jsonc)) to
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-plugin-otel-v2",
      "options": {
        "enabled": true,
        "endpoint": "https://logfire-eu.pydantic.dev",
        "protocol": "http/protobuf",
        "otlpHeaders": "Authorization={env:LOGFIRE_TOKEN}",
        "resourceAttributes": "service.name=my-service,deployment.environment=dev"
      }
    }
  ]
}
```

Set the token in the environment (never in the file):

```sh
export LOGFIRE_TOKEN=...
```

Verify:

```sh
opencode plugin list   # expect: devtheops.otel
```

## Options

Set options in the plugin configuration. Where an environment variable is listed, an explicit
option takes precedence over that variable and the built-in default.

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `OPENCODE_ENABLE_TELEMETRY` | Master switch. |
| `endpoint` | `OPENCODE_OTLP_ENDPOINT` / `http://localhost:4317` | OTLP endpoint. |
| `protocol` | `OPENCODE_OTLP_PROTOCOL` / `grpc` | `grpc`, `http/protobuf`, or `http/json`. |
| `otlpHeaders` | `OPENCODE_OTLP_HEADERS` | e.g. `Authorization={env:LOGFIRE_TOKEN}`. |
| `otlpHeadersHelper` | `OPENCODE_OTLP_HEADERS_HELPER` | Command that prints refreshed headers. |
| `resourceAttributes` | `OPENCODE_RESOURCE_ATTRIBUTES` | `key=value,...` resource attributes. |
| `spanAttributes` | `OPENCODE_SPAN_ATTRIBUTES` | `key=value,...` added to every span/log. |
| `metricsInterval` / `logsInterval` | `60000` / `5000` | Export intervals (ms). |
| `metricsTemporality` | `OPENCODE_OTLP_METRICS_TEMPORALITY` / `delta` | `delta`, `cumulative`, or `lowmemory`. Keep `delta` for long-lived hosts: it reports only changes, so an idle process exports nothing. |
| `metricPrefix` | `OPENCODE_METRIC_PREFIX` / `opencode.` | Metric name prefix. |
| `logsEnabled` | `!OPENCODE_DISABLE_LOGS` | Emit OTLP log records. |
| `capturePromptInLogs` | `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | Put the prompt text on the `user_prompt` log. Only honoured when `captureContent` is `full`. |
| `captureContent` | `OPENCODE_CAPTURE_CONTENT` / `full` | Prompt, tool and error bodies on spans and logs: `full` (redacted bodies), `metadata` (character counts only — `input.length`, `output.length` — and the error type without its message), or `off`. When several plugin instances share a process (one per location), all apply the strictest mode any of them sets. An unrecognised value falls back to `metadata`. |
| `redactSecrets` | `true` (`!OPENCODE_NO_REDACT`) | Mask credential-shaped strings and known secrets. |
| `redactValues` | — | Exact values to mask verbatim. |
| `locationAttributes` | `OPENCODE_LOCATION_ATTRIBUTES` / `.opencode/attributes.json` | Location-relative JSON file of per-session attributes. |
| `disabledMetrics` / `disabledTraces` | `OPENCODE_DISABLE_METRICS` / `OPENCODE_DISABLE_TRACES` | Silence by name (`session`, `llm`, `tool` for traces); `all` or `*` silences every metric or trace. |
| `traceparent` / `tracestate` | `OPENCODE_TRACEPARENT` / `OPENCODE_TRACESTATE` | W3C parent for the root. |
| `tracePropagationProviders` | `OPENCODE_TRACE_PROPAGATION_PROVIDERS` | Providers to inject W3C headers into (`*` = all). |

## Metrics temporality

Metrics default to **delta**. Cumulative snapshots are re-exported every interval for the lifetime
of the process — even when every session is idle — and the payload grows with each new session and
attribute set, which can exhaust a backend's ingest quota while OpenCode is not being used. Delta
reports only the change since the last collection: active periods export, idle periods export
nothing at all (the SDK skips empty collections). Logfire's metric ingest expects delta.

Override with `metricsTemporality`, `OPENCODE_OTLP_METRICS_TEMPORALITY`, or the standard
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` (in that order of precedence). Only choose
`cumulative` for short-lived processes. The e2e verification harness asserts that no metric
exports happen while idle.

## What it emits

| Signal | Source |
| --- | --- |
| `opencode.session` run span (AGENT, turn root) | `session.execution.started` → `session.execution.succeeded/failed/interrupted` |
| Session count + `session.created` log | `session.created`, or lazily on first sight |
| `session.duration`, `session.token.total`, `session.cost.total` | `session.usage.updated`, turn end |
| `opencode.llm` step span (LLM) + token/cost/cache/model metrics | `session.step.started/ended/failed` |
| `opencode.tool.<name>` span (TOOL) + `tool.duration` | `session.tool.input.started`, `called`, `success`/`failed` |
| `retry.count` | `session.status` (retry) |
| `user_prompt` log (linked to the run span) | first step of each turn |
| `session.execution.interrupted` log + interrupted span outcome | `session.execution.interrupted` |
| `session.error` log + error span status | `session.execution.failed` |
| W3C trace-context header injection | `model.request` hook |

Every span, log and metric also carries a human-readable **`project.name`** and **`project.directory`**,
derived from the session location at startup (no per-repo file). When the event supplies a working directory,
its basename becomes `project.name` and its path becomes `project.directory`.

`cache.count` counts steps with cache activity separately for `type=cacheRead` and
`type=cacheCreation`. Prior versions added cached token quantities to this request counter.

## Per-location attributes

Set `locationAttributes` to a location-relative JSON file (default `.opencode/attributes.json`) and
the plugin merges its contents — a flat string map — into each session's spans, logs, and metrics at
`session.created`. Use it to tag sessions per working copy (e.g. a run id) without changing global
config:

```jsonc
{ "locationAttributes": ".opencode/attributes.json" }
```

```json
{ "run.id": "f51a0acf-…", "build.id": "b42" }
```

Filter with `attributes->>'run.id' = '…'`. A missing or malformed file is ignored, and sessions in
other locations are unaffected.

## Secret redaction

`redactSecrets` (default on) masks credential-shaped substrings before anything is exported:
`Authorization`/`Bearer`, known token prefixes (`sk-`, `pylf_v…`, `ghp_`/`github_pat_`, `AKIA…`,
`xox…`, JWTs), and secret-looking `KEY=value` pairs. It also masks **exact values** of
secret-looking environment variables (`*_TOKEN`, `*_SECRET`, `*_API_KEY`, …) and anything in
`redactValues`, matched anywhere. Applied to prompt text, run-span input, and tool
input/output.

> Redaction is **best-effort**, not a guarantee. It cannot catch a secret it has never seen (not
> in env, no known shape, not in `redactValues`), nor obfuscated/encoded secrets. If you need
> hard assurance, only send text you are willing to store.

## V1 parity gaps

This fork uses per-step LLM spans in place of V1 message/part spans. Its current V2 handlers omit
permission decisions, shell-command and commit events, and lines-of-code metrics.

## V2 compatibility notes

- V2 evaluates a global plugin **once per location** and delivers every event to **every**
  instance. This plugin therefore keeps its OTel providers and tracing state on `globalThis`
  and **dedupes events by `event.id`**. Active locations must agree on exporter settings.
  The last location to close flushes and shuts down the private providers. A later setup can
  use a new collector or new credentials.
- V2 does not emit `session.idle`, and `session.created` is absent for pre-existing sessions,
  so the turn root span is anchored on `session.execution.*`.
- `session.tool.called/success/failed` do not carry the tool name; it is read from
  `session.tool.input.started.data.name` and correlated by call id.

## Development

```sh
npm install
npm run build      # tsc -> dist/
npm run typecheck
npm run verify     # drives real V2 payloads into a local OTLP receiver (needs bun)
```

## License

MPL-2.0, inherited from the upstream project. This is a modified fork; see `CHANGELOG.md`.
