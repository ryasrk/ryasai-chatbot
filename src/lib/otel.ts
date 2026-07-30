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

  try {
    // @ts-ignore — optional dependency, not installed by default
    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    // @ts-ignore — optional dependency
    const { resourceFromAttributes } = await import('@opentelemetry/resources')
    // @ts-ignore — optional dependency
    const { attrServiceName, attrServiceVersion } = await import('@opentelemetry/semantic-conventions')
    // @ts-ignore — optional dependency
    const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http')
    // @ts-ignore — optional dependency
    const { FetchInstrumentation } = await import('@opentelemetry/instrumentation-fetch')

    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    let traceExporter: unknown
    if (otlpEndpoint) {
      // @ts-ignore — optional dependency
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
      traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
    } else {
      // @ts-ignore — optional dependency
      const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-base')
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
