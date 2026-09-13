import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { getTracer, withSpan, initOtel, resetOtel } from './otel'

beforeEach(() => resetOtel())
afterEach(() => {
  resetOtel()
  delete process.env.OTEL_ENABLED
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
})

describe('getTracer', () => {
  test('returns a tracer object', () => {
    const tracer = getTracer()
    expect(tracer).toBeDefined()
    expect(typeof tracer.startActiveSpan).toBe('function')
    expect(typeof tracer.startSpan).toBe('function')
  })

  test('returns the same tracer name on repeated calls', () => {
    const t1 = getTracer()
    const t2 = getTracer()
    expect(t1).toBeDefined()
    expect(t2).toBeDefined()
  })
})

describe('withSpan', () => {
  test('executes fn and returns its result', async () => {
    const result = await withSpan('test-op', async () => 42)
    expect(result).toBe(42)
  })

  test('passes span to fn', async () => {
    const spanName = await withSpan('test-span', async (span) => {
      expect(span).toBeDefined()
      expect(typeof span.end).toBe('function')
      return span.recordException
    })
    expect(typeof spanName).toBe('function')
  })

  test('propagates errors from fn', async () => {
    await expect(
      withSpan('failing-op', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  test('returns complex objects', async () => {
    const data = { a: 1, b: 'hello', nested: { c: true } }
    const result = await withSpan('complex', async () => data)
    expect(result).toEqual(data)
  })
})

describe('initOtel', () => {
  test('no-op when OTEL_ENABLED not set', async () => {
    await initOtel()
    // no throw, no crash
  })

  test('a MISSING SDK package degrades to a no-op instead of throwing', async () => {
    // The catch at lines 51-52. This used to pass because the packages were simply
    // not installed -- but once this file mocks them (required to reach the success
    // path), the mock RESCUES the import and the catch never runs. Verified by
    // instrumenting the catch body: it executed zero times after the mocks landed.
    // So it is re-created deliberately by making one import fail, which is the real
    // production scenario (an optional package left out of a deployment).
    process.env.OTEL_ENABLED = 'true'
    await withBrokenSdk(async () => {
      // No throw, and nothing was started.
      await expect(initOtel()).resolves.toBeUndefined()
    })
    expect(startedSdks.filter((s) => s.started === true)).toHaveLength(0)
  })

  test('idempotent — second call is a no-op', async () => {
    process.env.OTEL_ENABLED = 'true'
    await initOtel()
    await initOtel()
  })
})

// ===========================================================================
// initOtel — the SUCCESS path and the OTLP exporter selection
// ===========================================================================
//
// The existing tests only reach the failure branch (the SDK packages are not
// installed), so lines 33-49 -- the OTLP-vs-Console exporter choice, the resource
// attributes and `sdk.start()` -- ran in no test. They are mocked here so the
// wiring is verified without the packages.

const startedSdks: Array<Record<string, unknown>> = []
const otlpExporters: Array<{ url: string }> = []
const consoleExporters: number[] = []

mock.module('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    private readonly opts: Record<string, unknown>
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      startedSdks.push(opts)
    }
    start() { startedSdks.push({ started: true, opts: this.opts }) }
  },
}))
mock.module('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attrs: Record<string, unknown>) => ({ attrs }),
}))
mock.module('@opentelemetry/semantic-conventions', () => ({
  attrServiceName: 'service.name',
  attrServiceVersion: 'service.version',
}))
mock.module('@opentelemetry/instrumentation-http', () => ({ HttpInstrumentation: class {} }))
mock.module('@opentelemetry/instrumentation-fetch', () => ({ FetchInstrumentation: class {} }))
mock.module('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(opts: { url: string }) { otlpExporters.push(opts) }
  },
}))
mock.module('@opentelemetry/sdk-trace-base', () => ({
  ConsoleSpanExporter: class { constructor() { consoleExporters.push(1) } },
}))

describe('initOtel — with the SDK packages available', () => {
  beforeEach(() => {
    startedSdks.length = 0
    otlpExporters.length = 0
    consoleExporters.length = 0
  })

  test('an OTLP endpoint selects the OTLP exporter with /v1/traces appended', async () => {
    // The URL path is part of the OTLP HTTP spec; dropping or duplicating it makes
    // the collector reject every batch, and tracing silently stops.
    process.env.OTEL_ENABLED = 'true'
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318'
    await initOtel()
    expect(otlpExporters).toEqual([{ url: 'http://collector:4318/v1/traces' }])
    // And NOT the console exporter, so the two branches are distinguishable.
    expect(consoleExporters).toHaveLength(0)
  })

  test('NO endpoint falls back to the Console exporter', async () => {
    // The local-development path: spans go to stdout rather than disappearing.
    process.env.OTEL_ENABLED = 'true'
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    await initOtel()
    expect(consoleExporters).toHaveLength(1)
    expect(otlpExporters).toHaveLength(0)
  })

  test('an ENDPOINT ALONE enables tracing, without OTEL_ENABLED', async () => {
    // `enabled` is an OR: setting the endpoint is enough. A user who supplies a
    // collector but forgets the flag should still get traces.
    delete process.env.OTEL_ENABLED
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318'
    await initOtel()
    expect(otlpExporters).toHaveLength(1)
  })

  test('the SDK is STARTED and carries the service resource', async () => {
    // A constructed-but-unstarted SDK is the classic silent failure: no exporter
    // ever receives a span and nothing errors.
    process.env.OTEL_ENABLED = 'true'
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318'
    await initOtel()
    const started = startedSdks.find((s) => s.started === true)
    expect(started).toBeDefined()
    const opts = started!.opts as { resource: { attrs: Record<string, string> } }
    expect(opts.resource.attrs['service.name']).toBe('ryasai-chatbot')
    // The version comes from npm_package_version, with a hard-coded fallback.
    expect(opts.resource.attrs['service.version']).toBeDefined()
  })

  test('the SDK is started exactly ONCE even when init is called repeatedly', async () => {
    // _initialized guards it; starting twice double-reports every span.
    process.env.OTEL_ENABLED = 'true'
    await initOtel()
    await initOtel()
    await initOtel()
    expect(startedSdks.filter((s) => s.started === true)).toHaveLength(1)
  })

  test('OTEL_ENABLED must be exactly "true" — "1"/"yes" do NOT enable it', async () => {
    // Pinned as MEASURED: the check is `=== 'true'`, so a truthy-looking value is
    // ignored. Worth knowing before assuming tracing is on in an environment.
    process.env.OTEL_ENABLED = '1'
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    await initOtel()
    expect(startedSdks).toHaveLength(0)
    expect(otlpExporters).toHaveLength(0)
    expect(consoleExporters).toHaveLength(0)
  })
})

// A helper that makes the FIRST dynamic import fail, so the catch path is reachable
// even though this file mocks every OTel package. It re-registers the module with a
// throwing factory, then restores the working mock afterwards.
async function withBrokenSdk(fn: () => Promise<void>): Promise<void> {
  mock.module('@opentelemetry/sdk-node', () => {
    throw new Error("Cannot find module '@opentelemetry/sdk-node'")
  })
  try {
    await fn()
  } finally {
    mock.module('@opentelemetry/sdk-node', () => ({
      NodeSDK: class {
        private readonly opts: Record<string, unknown>
        constructor(opts: Record<string, unknown>) { this.opts = opts }
        start() { startedSdks.push({ started: true, opts: this.opts }) }
      },
    }))
  }
}
