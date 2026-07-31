/**
 * OpenTelemetry — tracer API with lazy SDK initialization.
 * ----------------------------------------------------------------------------
 * ponytail: only @opentelemetry/api is a hard dep. SDK/exporter packages are
 * dynamically imported — no-op tracer when not installed or OTEL_ENABLED != true.
 */
import { trace, SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api'

let _initialized = false

export async function initOtel(): Promise<void> {
  if (_initialized) return
  const enabled = process.env.OTEL_ENABLED === 'true' || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!enabled) return
  _initialized = true

  // ponytail: hide import paths from the bundler's static analyzer — these
  // packages are optional and may not be installed. The try/catch handles
  // the runtime "module not found" gracefully. Turbopack/webpack can't
  // resolve a dynamic string, so it skips bundling these.
  const dynImport = (pkg: string) => import(/* @vite-ignore */ pkg as never)

  try {
    const { NodeSDK } = await dynImport('@opentelemetry/sdk-node')
    const { resourceFromAttributes } = await dynImport('@opentelemetry/resources')
    const { attrServiceName, attrServiceVersion } = await dynImport('@opentelemetry/semantic-conventions')
    const { HttpInstrumentation } = await dynImport('@opentelemetry/instrumentation-http')
    const { FetchInstrumentation } = await dynImport('@opentelemetry/instrumentation-fetch')

    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    let traceExporter: unknown
    if (otlpEndpoint) {
      const { OTLPTraceExporter } = await dynImport('@opentelemetry/exporter-trace-otlp-http')
      traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
    } else {
      const { ConsoleSpanExporter } = await dynImport('@opentelemetry/sdk-trace-base')
      traceExporter = new ConsoleSpanExporter()
    }

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [attrServiceName]: 'ryasai-chatbot',
        [attrServiceVersion]: process.env.npm_package_version ?? '0.4.0',
      }),
      traceExporter: traceExporter as never,
      instrumentations: [new HttpInstrumentation(), new FetchInstrumentation()],
    })

    sdk.start()
    console.log('[otel] OpenTelemetry SDK started')
  } catch {
    console.warn('[otel] OTel SDK packages not installed — using no-op tracer')
  }
}

export function getTracer(): Tracer {
  return trace.getTracer('ryasai-chatbot')
}

export function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    try {
      return await fn(span)
    } catch (e) {
      span.recordException(e as Error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw e
    } finally {
      span.end()
    }
  })
}

export function resetOtel(): void {
  _initialized = false
}
