import type { Context } from "@opentelemetry/api"
import { TraceFlags } from "@opentelemetry/api"
import { RandomIdGenerator, type ReadableSpan, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-base"

/** Marks a record as a span that has started but not yet ended. Read by Pydantic Logfire. */
export const PENDING_SPAN_TYPE_KEY = "logfire.span_type"
export const PENDING_SPAN_TYPE = "pending_span"
/** Span id of the real span's parent, or sixteen zeros for a trace root. */
export const PENDING_PARENT_ID_KEY = "logfire.pending_parent_id"
const NO_PARENT = "0000000000000000"

/**
 * Exports a zero-length placeholder for every span the moment it starts, so a backend can show
 * a long-running span, and nest its children under it, before the span itself is exported at
 * its end. A turn's root span can stay open for hours; without a placeholder every child that
 * finishes earlier arrives with a parent the backend has never seen.
 *
 * The placeholder follows Pydantic Logfire's pending-span convention: it has its own span id,
 * the real span as its parent, `logfire.span_type=pending_span`, and the real span's own parent
 * in `logfire.pending_parent_id`. Logfire replaces it with the real span when that arrives.
 * Other backends would store it as an extra zero-length span, so it is opt-in there.
 */
export class PendingSpanProcessor implements SpanProcessor {
  private readonly ids = new RandomIdGenerator()

  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext)
    try {
      const real = span.spanContext()
      if ((real.traceFlags & TraceFlags.SAMPLED) === 0) return
      const context = { ...real, spanId: this.ids.generateSpanId(), isRemote: false }
      const pending: ReadableSpan = {
        name: span.name,
        kind: span.kind,
        spanContext: () => context,
        parentSpanContext: real,
        startTime: span.startTime,
        endTime: span.startTime,
        status: span.status,
        attributes: {
          ...span.attributes,
          [PENDING_SPAN_TYPE_KEY]: PENDING_SPAN_TYPE,
          [PENDING_PARENT_ID_KEY]: span.parentSpanContext?.spanId ?? NO_PARENT,
        },
        links: span.links,
        events: [],
        duration: [0, 0],
        ended: true,
        resource: span.resource,
        instrumentationScope: span.instrumentationScope,
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
      }
      this.inner.onEnd(pending)
    } catch {
      // A placeholder is a display aid. Never let it break the real span.
    }
  }

  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(span)
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

/** True for Pydantic Logfire's OTLP hosts (`logfire-eu.pydantic.dev`, `logfire-us.pydantic.dev`, …). */
export function isLogfireEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host.endsWith(".pydantic.dev") && host.startsWith("logfire")
  } catch {
    return false
  }
}
