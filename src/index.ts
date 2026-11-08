import { createHash } from "node:crypto"
import { diag, DiagLogLevel, ROOT_CONTEXT, type Span } from "@opentelemetry/api"
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { LEVELS, type HandlerContext, type Level } from "./types.ts"
import { loadConfig, parseAttributePairs, resolveHelperPath, type ContentCapture, type OtelPluginOptions } from "./config.ts"
import { probeEndpoint } from "./probe.ts"
import { createInstruments, forceFlushOtel, setupOtel, type OtelProviders } from "./otel.ts"
import { remoteParentContext } from "./trace-context.ts"
import {
  handleExecutionEnded,
  handleExecutionStarted,
  handleSessionCreated,
  handleSessionIdle,
  handleSessionStatus,
} from "./handlers/session.ts"
import { handleStepEnded, handleStepStarted, handleUsageUpdated } from "./handlers/usage.ts"
import {
  handleToolCalled,
  handleToolFailed,
  handleToolInputStarted,
  handleToolSuccess,
} from "./handlers/tool.ts"
import { handleModelRequest } from "./handlers/chat-headers.ts"
import { contentAttrs, errorText, setBoundedMap, stableProjectId, strictestCapture } from "./util.ts"
import { redactSecrets } from "./redact.ts"
import type { V2Event } from "./v2.ts"

const PLUGIN_VERSION = "2.0.0-v2-port"

/** Append-only diagnostics for debugging the live plugin (server console output is not captured). */
const DIAG_LOG =
  process.env["OPENCODE_OTEL_DIAG_LOG"] ??
  join(homedir(), ".local", "share", "opencode", "otel-plugin-diag.log")
function diagLog(message: string) {
  try {
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    if (((statSync(DIAG_LOG, { throwIfNoEntry: false })?.size) ?? 0) > 1_000_000) writeFileSync(DIAG_LOG, "")
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* ignore */
  }
}

/** Resolves `{env:VAR}` placeholders from the process environment as a fallback to V2 config interpolation. */
function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
}

// Each location evaluates the module separately. Share one exporter and event stream
// state while locations overlap, and retire both after the last location closes.
const SHARED_KEY = "__opencode_otel_exporter_v2__"

type SharedOtel = Awaited<ReturnType<typeof startOtel>>
type ExporterLease = { key: string; ready: Promise<SharedOtel>; refs: number }
const globals = globalThis as typeof globalThis & { [SHARED_KEY]?: ExporterLease }

type TracingState = {
  seenEvents: Set<string>
  /** Capture mode per live plugin instance; every instance applies the strictest. */
  captureModes: Map<symbol, ContentCapture>
  pendingSubagentSpans: Map<string, Span>
  runPrompts: Map<string, string>
  promptEmitted: Set<string>
  pendingToolSpans: HandlerContext["pendingToolSpans"]
  pendingToolNames: HandlerContext["pendingToolNames"]
  sessionTotals: HandlerContext["sessionTotals"]
  sessionMeta: HandlerContext["sessionMeta"]
  sessionAttrs: HandlerContext["sessionAttrs"]
  runSpans: HandlerContext["runSpans"]
  runSpanContexts: HandlerContext["runSpanContexts"]
  activeRuns: HandlerContext["activeRuns"]
  assistantRuns: HandlerContext["assistantRuns"]
  sessionSpans: HandlerContext["sessionSpans"]
  sessionSpanContexts: HandlerContext["sessionSpanContexts"]
  stepSpans: HandlerContext["stepSpans"]
  llmRequestContexts: HandlerContext["llmRequestContexts"]
}

function emptyTracing(): TracingState {
  return {
    seenEvents: new Set(),
    captureModes: new Map(),
    pendingSubagentSpans: new Map(),
    runPrompts: new Map(),
    promptEmitted: new Set(),
    pendingToolSpans: new Map(),
    pendingToolNames: new Map(),
    sessionTotals: new Map(),
    sessionMeta: new Map(),
    sessionAttrs: new Map(),
    runSpans: new Map(),
    runSpanContexts: new Map(),
    activeRuns: new Map(),
    assistantRuns: new Map(),
    sessionSpans: new Map(),
    sessionSpanContexts: new Map(),
    stepSpans: new Map(),
    llmRequestContexts: new Map(),
  }
}

type ExporterOptions = Pick<ReturnType<typeof loadConfig>,
  "endpoint" | "protocol" | "metricsInterval" | "logsInterval" | "metricPrefix" |
  "resourceAttributes" | "metricsTemporality" | "otlpHeaders" | "otlpHeadersHelper"
>

async function startOtel(options: ExporterOptions) {
  diag.setLogger({
    error: (...args: unknown[]) => diagLog(`OTEL ERROR ${args.map(String).join(" ")}`),
    warn: (...args: unknown[]) => diagLog(`OTEL WARN ${args.map(String).join(" ")}`),
    info: () => {}, debug: () => {}, verbose: () => {},
  }, DiagLogLevel.WARN)
  const providers = await setupOtel(options.endpoint, options.protocol, options.metricsInterval,
    options.logsInterval, PLUGIN_VERSION, options.otlpHeaders, options.otlpHeadersHelper,
    options.resourceAttributes, options.metricsTemporality)
  return {
    providers,
    instruments: createInstruments(options.metricPrefix, providers.meterProvider.getMeter("com.opencode")),
    logger: providers.loggerProvider.getLogger("com.opencode"),
    tracer: providers.tracerProvider.getTracer("com.opencode"),
    tracing: emptyTracing(),
  }
}

async function acquireOtel(options: ExporterOptions) {
  // SDK exporters also read these standard headers when they are constructed.
  const environmentHeaders = ["", "_METRICS", "_LOGS", "_TRACES"].map(
    (signal) => process.env[`OTEL_EXPORTER_OTLP${signal}_HEADERS`],
  )
  const key = createHash("sha256").update(JSON.stringify([options, environmentHeaders])).digest("hex")
  let lease = globals[SHARED_KEY]
  if (lease && lease.key !== key) {
    throw new Error("Active OpenCode locations share one telemetry exporter. Close them before changing exporter settings.")
  }
  if (!lease) {
    lease = { key, ready: startOtel(options), refs: 0 }
    globals[SHARED_KEY] = lease
  }
  lease.refs++
  try {
    return { shared: await lease.ready, lease }
  } catch (error) {
    if (globals[SHARED_KEY] === lease) delete globals[SHARED_KEY]
    throw error
  }
}

async function releaseOtel(lease: ExporterLease, shared: SharedOtel) {
  if (--lease.refs > 0) return
  delete globals[SHARED_KEY]
  const { meterProvider, loggerProvider, tracerProvider } = shared.providers
  await forceFlushOtel(shared.providers)
  await Promise.all([meterProvider.shutdown(), loggerProvider.shutdown(), tracerProvider.shutdown()])
}

/**
 * V2 port of @devtheops/opencode-plugin-otel (scoped v0.1).
 *
 * Emits session lifecycle, usage/token/cost, LLM step, tool, retry, and execution
 * telemetry from the V2 granular event stream. V1-only signals (message parts,
 * permission prompts, command execution, session diffs) are out of scope; see README.
 */
export default {
  id: "devtheops.otel",
  async setup(ctx: any) {
    const options = (ctx?.options ?? {}) as OtelPluginOptions
    const config = loadConfig(options)
    const directory: string | undefined = ctx?.location?.directory
    const worktree: string | undefined =
      ctx?.location?.project?.canonical ?? ctx?.location?.project?.directory
    const otlpHeadersHelper = resolveHelperPath(config.otlpHeadersHelper, directory, worktree)

    const minLevel: Level = "info"
    const log: HandlerContext["log"] = async (level, message, extra) => {
      diagLog(`log ${level}: ${message} ${extra ? JSON.stringify(extra) : ""}`)
      if (LEVELS[level] < LEVELS[minLevel]) return
      const line = `[opencode-plugin-otel] ${level}: ${message}`
      if (level === "error") console.error(line, extra ?? "")
      else if (level === "warn") console.warn(line, extra ?? "")
      else console.log(line, extra ?? "")
    }

    if (!config.enabled) {
      await log("info", "telemetry disabled (set OPENCODE_ENABLE_TELEMETRY to enable)")
      return
    }

    const probe = await probeEndpoint(config.endpoint)
    if (!probe.ok) {
      await log("warn", "OTLP endpoint unreachable — exports may fail", {
        endpoint: config.endpoint,
        error: probe.error,
      })
    }

    const { shared, lease } = await acquireOtel({
      endpoint: config.endpoint,
      protocol: config.protocol,
      metricsInterval: config.metricsInterval,
      logsInterval: config.logsInterval,
      metricPrefix: config.metricPrefix,
      resourceAttributes: config.resourceAttributes,
      metricsTemporality: config.metricsTemporality,
      otlpHeaders: resolveEnv(config.otlpHeaders),
      otlpHeadersHelper,
    })
    const { instruments, logger, tracer, providers, tracing } = shared

    await log("info", "starting up", {
      version: PLUGIN_VERSION,
      endpoint: config.endpoint,
      protocol: config.protocol,
      metricsInterval: config.metricsInterval,
      metricsTemporality: config.metricsTemporality,
      logsInterval: config.logsInterval,
      metricPrefix: config.metricPrefix,
      headersHelperSet: !!config.otlpHeadersHelper,
      redactSecrets: config.redactSecrets,
      redactValueCount: config.redactValues.length,
    })

    const emitLog: HandlerContext["emitLog"] = (record, context) => {
      if (!config.logsEnabled) return
      logger.emit(context ? { ...record, context } : record)
    }
    const remoteContext = remoteParentContext(config.traceparent, config.tracestate)
    const rootContext = remoteContext ? () => remoteContext : () => ROOT_CONTEXT

    // Human-readable project identity as a fallback. Prefer the working directory the session
    // runs in (its basename) — a folder like ~/code/test reports "test" even when OpenCode's
    // project root resolves elsewhere (e.g. the home dir, for a non-git folder). Sessions that
    // emit `session.created` override this per-session from their own location directory.
    const projectDirectory: string | undefined =
      directory ?? ctx?.location?.project?.canonical ?? ctx?.location?.project?.directory
    const projectName = projectDirectory ? basename(projectDirectory) : undefined

    const commonAttrs = {
      ...parseAttributePairs(config.spanAttributes),
      ...(projectName ? { "project.name": projectName } : {}),
      ...(projectDirectory
        ? { "project.directory": projectDirectory, "project.id": stableProjectId(projectDirectory) }
        : {}),
    } as const

    const redact = config.redactSecrets
      ? (text: string) => redactSecrets(text, config.redactValues)
      : (text: string) => text
    const instanceKey = Symbol("otel-plugin-instance")
    tracing.captureModes.set(instanceKey, config.captureContent)
    const capture = () => strictestCapture(tracing.captureModes.values())
    const hctx: HandlerContext = {
      log,
      emitLog,
      instruments,
      commonAttrs,
      pendingToolSpans: tracing.pendingToolSpans,
      pendingToolNames: tracing.pendingToolNames,
      pendingSubagentSpans: tracing.pendingSubagentSpans,
      sessionTotals: tracing.sessionTotals,
      sessionMeta: tracing.sessionMeta,
      sessionAttrs: tracing.sessionAttrs,
      attrsFor: (sessionID: string) => ({
        ...commonAttrs,
        ...(tracing.sessionAttrs.get(sessionID) ?? {}),
      }),
      locationAttributes: config.locationAttributes,
      disabledMetrics: config.disabledMetrics,
      disabledTraces: config.disabledTraces,
      tracer,
      tracePrefix: config.metricPrefix,
      rootContext,
      runSpans: tracing.runSpans,
      runSpanContexts: tracing.runSpanContexts,
      activeRuns: tracing.activeRuns,
      assistantRuns: tracing.assistantRuns,
      sessionSpans: tracing.sessionSpans,
      sessionSpanContexts: tracing.sessionSpanContexts,
      stepSpans: tracing.stepSpans,
      llmRequestContexts: tracing.llmRequestContexts,
      tracePropagationProviders: config.tracePropagationProviders,
      // A prompt body in logs is content too: only `full` lets it through. The mode is
      // the strictest of all live instances, read per event (see strictestCapture).
      get capturePromptInLogs() {
        return config.capturePromptInLogs && capture() === "full"
      },
      content: (text, lengthKey, build) => contentAttrs(capture(), redact, text, lengthKey, build),
      errorText: (error) => errorText(capture(), redact, error),
      redact,
      runPrompts: tracing.runPrompts,
      promptEmitted: tracing.promptEmitted,
    }

    const safe = <T extends unknown[]>(
      name: string,
      fn: (...args: T) => Promise<void> | void,
    ): ((...args: T) => Promise<void>) =>
      async (...args: T) => {
        try {
          await fn(...args)
        } catch (err) {
          await log("error", `otel: unhandled error in ${name}`, {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          })
        }
      }

    try {
      // Prompt admission: start the root run span for the user turn.
      await ctx.session.hook(
        "prompt",
        safe("prompt", async (event: any) => {
          diagLog(`hook prompt session=${event?.sessionID} msg=${event?.messageID}`)
          const sessionID = event?.sessionID
          let meta = hctx.sessionMeta.get(sessionID)
          if (!meta || meta.agent === "unknown" || meta.model === "unknown") {
            try {
              const info: any = await ctx.session.get({ sessionID })
              const s: any = info?.data ?? info
              meta = {
                agent: s?.agent ?? meta?.agent ?? "unknown",
                model: s?.model ? `${s.model.providerID}/${s.model.id}` : (meta?.model ?? "unknown"),
              }
              diagLog(
                `prompt enrich session=${sessionID} rawKeys=${Object.keys(info ?? {}).join(",")} agent=${meta.agent} model=${meta.model}`,
              )
              setBoundedMap(hctx.sessionMeta, sessionID, meta)
            } catch (err) {
              diagLog(`prompt enrich failed session=${sessionID}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          const promptText: string = event?.prompt?.text ?? ""
          // The run span is created on `session.execution.started` — an event ordered after
          // `session.created` — so a subagent's run span can nest under its session span.
          setBoundedMap(hctx.runPrompts, sessionID, promptText)
        }),
      )

      // Model request: inject W3C trace context for enabled providers.
      await ctx.session.hook(
        "model.request",
        safe("model.request", (event: any) => {
          handleModelRequest(
            {
              sessionID: event.sessionID,
              agent: event.agent,
              model: event.model,
              headers: event.headers,
            },
            hctx,
          )
        }),
      )
    } catch (error) {
      tracing.captureModes.delete(instanceKey)
      await releaseOtel(lease, shared)
      throw error
    }

    const controller = new AbortController()
    const running = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<V2Event>) {
          // V2 delivers each event to every plugin instance; process it exactly once.
          const eventID = event.id
          if (eventID) {
            if (tracing.seenEvents.has(eventID)) continue
            tracing.seenEvents.add(eventID)
            if (tracing.seenEvents.size > 5000) {
              const oldest = tracing.seenEvents.values().next().value
              if (oldest) tracing.seenEvents.delete(oldest)
            }
          }
          // Project identity must come from the event's OWN location, not the plugin instance:
          // V2 evaluates the plugin once per location and a session's events can be handled by
          // an instance whose location is elsewhere (e.g. the home dir), which previously made
          // e.g. `session.execution.succeeded` report the home folder. Set it per session here,
          // in the same instance that emits the record.
          {
            const ev = event as any
            const sid = ev?.data?.sessionID
            const dir = ev?.location?.directory
            if (sid && typeof dir === "string" && dir) {
              setBoundedMap(tracing.sessionAttrs, sid, {
                ...(tracing.sessionAttrs.get(sid) ?? {}),
                "project.name": basename(dir),
                "project.directory": dir,
                "project.id": stableProjectId(dir),
              })
            }
          }
          await safe(`event:${event.type}`, async () => {
            switch (event.type) {
              case "session.created":
                await handleSessionCreated(event.data as any, event.created, hctx)
                break
              case "session.idle":
                handleSessionIdle((event.data as any).sessionID, hctx)
                await forceFlushOtel(providers)
                break
              case "session.status":
                handleSessionStatus(event.data as any, hctx)
                break
              case "session.usage.updated":
                handleUsageUpdated(event.data as any, hctx)
                break
              case "session.step.started":
                handleStepStarted(event.data as any, hctx)
                break
              case "session.step.ended":
                handleStepEnded(event.data as any, hctx)
                break
              case "session.step.failed":
                handleStepEnded(event.data as any, hctx, (event.data as any).error)
                await forceFlushOtel(providers)
                break
              case "session.tool.input.started":
                handleToolInputStarted(event.data as any, hctx)
                break
              case "session.tool.called":
                handleToolCalled(event.data as any, hctx, event.created)
                break
              case "session.tool.success":
                handleToolSuccess(event.data as any, hctx, event.created)
                break
              case "session.tool.failed":
                handleToolFailed(event.data as any, hctx, event.created)
                break
              case "session.execution.started":
                handleExecutionStarted(event.data as any, hctx)
                break
              case "session.execution.succeeded":
                handleExecutionEnded(event.data as any, hctx)
                await forceFlushOtel(providers)
                break
              case "session.execution.failed":
                handleExecutionEnded(event.data as any, hctx, "failed")
                await forceFlushOtel(providers)
                break
              case "session.execution.interrupted":
                handleExecutionEnded(event.data as any, hctx, "interrupted")
                await forceFlushOtel(providers)
                break
            }
          })()
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          await log("error", "otel: event subscription ended", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })()

    await log("info", "plugin ready", { version: PLUGIN_VERSION })

    return async () => {
      if (controller.signal.aborted) return
      controller.abort()
      await running
      tracing.captureModes.delete(instanceKey)
      await releaseOtel(lease, shared)
    }
  },
}
