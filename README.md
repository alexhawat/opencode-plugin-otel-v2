# opencode-plugin-otel-v2

OpenTelemetry telemetry for **OpenCode V2**. Exports session, LLM-step and tool spans, plus
token/cost/cache metrics and structured logs, to any OTLP endpoint (gRPC or HTTP).

This is a **V2 port** of [`@devtheops/opencode-plugin-otel`](https://github.com/DEVtheOPS/opencode-plugin-otel)
(upstream is V1-only — [issue #128](https://github.com/DEVtheOPS/opencode-plugin-otel/issues/128)).
The V1 plugin's handlers targeted events that no longer exist in V2, so the handlers were
re-architected onto V2's granular event stream. See [Compatibility](#v2-compatibility-notes).

Ported and verified against OpenCode **2.0.15**.

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

Clone the repo and point the config at the directory (V2 requires a **directory**, not a file):

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

Every option can also be set via an `OPENCODE_*` environment variable; an option wins over the
environment variable, which wins over the default.

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
| `metricPrefix` | `OPENCODE_METRIC_PREFIX` / `opencode.` | Metric name prefix. |
| `logsEnabled` | `!OPENCODE_DISABLE_LOGS` | Emit OTLP log records. |
| `capturePromptInLogs` | `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | Put the prompt text on the `user_prompt` log. |
| `redactSecrets` | `true` (`!OPENCODE_NO_REDACT`) | Mask credential-shaped strings and known secrets. |
| `redactValues` | — | Exact values to mask verbatim. |
| `disabledMetrics` / `disabledTraces` | `OPENCODE_DISABLE_METRICS` / `OPENCODE_DISABLE_TRACES` | Silence by name (`session`, `llm`, `tool` for traces). |
| `traceparent` / `tracestate` | `OPENCODE_TRACEPARENT` / `OPENCODE_TRACESTATE` | W3C parent for the root. |
| `tracePropagationProviders` | `OPENCODE_TRACE_PROPAGATION_PROVIDERS` | Providers to inject W3C headers into (`*` = all). |

## What it emits

| Signal | Source |
| --- | --- |
| `opencode.session` run span (AGENT, turn root) | `prompt` hook → `session.execution.succeeded/failed/interrupted` |
| Session count + `session.created` log | `session.created`, or lazily on first sight |
| `session.duration`, `session.token.total`, `session.cost.total` | `session.usage.updated`, turn end |
| `opencode.llm` step span (LLM) + token/cost/cache/model metrics | `session.step.started/ended/failed` |
| `opencode.tool.<name>` span (TOOL) + `tool.duration` | `session.tool.input.started`, `called`, `success`/`failed` |
| `retry.count` | `session.status` (retry) |
| `user_prompt` log (linked to the run span) | first step of each turn |
| `session.error` log + error span status | `session.execution.failed` |
| W3C trace-context header injection | `model.request` hook |

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

The V1 handlers for `message.updated`, `message.part.updated`, `permission.*`,
`command.executed`, and `session.diff` have no V2 equivalent and are **not** ported:
message/part spans, permission telemetry, command events, and lines-of-code/commit metrics.
Everything else above is implemented.

## V2 compatibility notes

- V2 evaluates a global plugin **once per location** and delivers every event to **every**
  instance. This plugin therefore keeps its OTel providers and tracing state on `globalThis`
  (one shared instance, flushed but never shut down) and **dedupes events by `event.id`**.
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
