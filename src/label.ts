import type { ContentCapture } from "./config.ts"

/**
 * Attribute a backend may show instead of the span name. Pydantic Logfire uses it as the
 * row's message; elsewhere it is an ordinary attribute. Span names stay fixed and
 * low-cardinality (`opencode.session`, `opencode.tool.read`, …) so queries can group on them.
 */
export const LABEL_KEY = "logfire.msg"

const HEAD_MAX = 60
const LABEL_MAX = 110

/** Collapses whitespace to single spaces and truncates with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/**
 * Builds the label attribute `head` or `head: detail`. `head` is structural (an agent or tool
 * name) and always allowed. `detail` is content (a prompt, a title, a command), so it is
 * redacted and only included when `captureContent` is `full`.
 */
export function spanLabel(
  mode: ContentCapture,
  redact: (text: string) => string,
  head: string,
  detail?: string,
): Record<string, string> {
  const h = oneLine(head, HEAD_MAX)
  if (!h) return {}
  if (!detail || mode !== "full") return { [LABEL_KEY]: h }
  const d = oneLine(redact(detail), LABEL_MAX - h.length - 2)
  return { [LABEL_KEY]: d ? `${h}: ${d}` : h }
}

const DETAIL_KEYS = ["filePath", "file_path", "path", "file", "command", "cmd", "pattern", "query", "url", "description"]

/** The one argument that best says what a tool call is doing, if it has one. */
export function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}
