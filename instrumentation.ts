/**
 * Next.js instrumentation hook — runs once on server startup.
 * Initializes OpenTelemetry SDK if @opentelemetry/api is installed.
 * ponytail: graceful no-op when OTel packages aren't installed — no hard dep.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const otelEnabled = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!otelEnabled) return

  try {
    // @ts-ignore — optional dependency, not installed by default
    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    // @ts-ignore — optional dependency
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    // @ts-ignore — optional dependency
    const { resourceFromAttributes } = await import('@opentelemetry/resources')
    // @ts-ignore — optional dependency
    const { attrServiceName, attrServiceVersion } = await import('@opentelemetry/semantic-conventions')
    // @ts-ignore — optional dependency
    const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http')
    // @ts-ignore — optional dependency
    const { FetchInstrumentation } = await import('@opentelemetry/instrumentation-fetch')

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [attrServiceName]: 'ryasai-chatbot',
        [attrServiceVersion]: process.env.npm_package_version ?? '0.4.0',
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${otelEnabled}/v1/traces`,
      }),
      instrumentations: [new HttpInstrumentation(), new FetchInstrumentation()],
    })

    sdk.start()
    console.log('[instrumentation] OpenTelemetry SDK started →', otelEnabled)
  } catch {
    console.warn('[instrumentation] OTel packages not installed — skipping. Install @opentelemetry/sdk-node to enable.')
  }
}
