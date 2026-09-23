import { diag, DiagConsoleLogger, DiagLogLevel, trace } from "@opentelemetry/api";
const errors: string[] = [];
diag.setLogger({
  error: (...a: unknown[]) => { errors.push("ERROR " + a.map(String).join(" ")); },
  warn: (...a: unknown[]) => { errors.push("WARN " + a.map(String).join(" ")); },
  info: () => {}, debug: () => {}, verbose: () => {},
}, DiagLogLevel.WARN);
const token = process.env.LOGFIRE_TOKEN;
const { setupOtel } = await import("../src/otel.ts");
const p = await setupOtel("https://logfire-eu.pydantic.dev", "http/protobuf", 1000, 500, "2.0.0-v2-port-verify", `Authorization=${token}`);
const t = trace.getTracer("verify");
const s = t.startSpan("logfire-verify-span", { attributes: { "verify.source": "opencode-plugin-otel-v2", "session.id": "ses_verify" } });
s.end();
await p.tracerProvider.forceFlush();
await new Promise((r) => setTimeout(r, 2500));
await p.meterProvider.forceFlush();
await p.loggerProvider.forceFlush();
await new Promise((r) => setTimeout(r, 1000));
console.log("export diag errors:", errors.length ? errors : "(none)");
