/**
 * Lightweight Prometheus-compatible metrics — no external deps.
 * ponytail: in-memory counters/histograms, same pattern as observability.ts.
 * Prometheus scrapes /api/metrics every 15s. Lost on restart — fine for
 * production debugging, persistent storage is Prometheus's job.
 */

interface CounterMetric {
  type: 'counter'
  name: string
  help: string
  value: number
  labels: Map<string, number>
}

interface GaugeMetric {
  type: 'gauge'
  name: string
  help: string
  value: number
  labels: Map<string, number>
}

interface HistogramMetric {
  type: 'histogram'
  name: string
  help: string
  buckets: number[]
  counts: number[]
  sum: number
  count: number
  labels: Map<string, { counts: number[]; sum: number; count: number }>
}

type Metric = CounterMetric | GaugeMetric | HistogramMetric

const metrics = new Map<string, Metric>()

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

function labelKey(labels?: Record<string, string>): string {
  if (!labels) return ''
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')
}

export function counter(name: string, help: string): CounterMetric {
  let m = metrics.get(name)
  if (m && m.type === 'counter') return m
  m = { type: 'counter', name, help, value: 0, labels: new Map() }
  metrics.set(name, m)
  return m
}

export function gauge(name: string, help: string): GaugeMetric {
  let m = metrics.get(name)
  if (m && m.type === 'gauge') return m
  m = { type: 'gauge', name, help, value: 0, labels: new Map() }
  metrics.set(name, m)
  return m
}

export function histogram(name: string, help: string, buckets?: number[]): HistogramMetric {
  let m = metrics.get(name)
  if (m && m.type === 'histogram') return m
  const b = buckets ?? DEFAULT_BUCKETS
  m = {
    type: 'histogram',
    name,
    help,
    buckets: b,
    counts: new Array(b.length + 1).fill(0),
    sum: 0,
    count: 0,
    labels: new Map(),
  }
  metrics.set(name, m)
  return m
}

export function inc(name: string, labels?: Record<string, string>, value = 1): void {
  const m = metrics.get(name)
  if (!m || m.type !== 'counter') return
  const key = labelKey(labels)
  if (key) {
    m.labels.set(key, (m.labels.get(key) ?? 0) + value)
  }
  m.value += value
}

export function set(name: string, value: number, labels?: Record<string, string>): void {
  const m = metrics.get(name)
  if (!m || m.type !== 'gauge') return
  const key = labelKey(labels)
  if (key) {
    m.labels.set(key, value)
  }
  m.value = value
}

export function observe(name: string, value: number, labels?: Record<string, string>): void {
  const m = metrics.get(name)
  if (!m || m.type !== 'histogram') return
  const key = labelKey(labels)
  if (key) {
    let labeled = m.labels.get(key)
    if (!labeled) {
      labeled = { counts: new Array(m.buckets.length + 1).fill(0), sum: 0, count: 0 }
      m.labels.set(key, labeled)
    }
    recordHistogram(labeled, value, m.buckets)
  }
  recordHistogram(m, value, m.buckets)
}

function recordHistogram(
  target: { counts: number[]; sum: number; count: number },
  value: number,
  buckets: number[],
): void {
  target.sum += value
  target.count++
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]) {
      target.counts[i]++
      return
    }
  }
  target.counts[buckets.length]++
}

export function prometheusText(): string {
  const lines: string[] = []
  for (const m of metrics.values()) {
    lines.push(`# HELP ${m.name} ${m.help}`)
    lines.push(`# TYPE ${m.name} ${m.type}`)

    if (m.type === 'counter') {
      if (m.labels.size > 0) {
        for (const [key, val] of m.labels) {
          lines.push(`${m.name}{${key}} ${val}`)
        }
      } else {
        lines.push(`${m.name} ${m.value}`)
      }
    } else if (m.type === 'gauge') {
      if (m.labels.size > 0) {
        for (const [key, val] of m.labels) {
          lines.push(`${m.name}{${key}} ${val}`)
        }
      } else {
        lines.push(`${m.name} ${m.value}`)
      }
    } else if (m.type === 'histogram') {
      const emitHist = (
        prefix: string,
        counts: number[],
        sum: number,
        count: number,
        buckets: number[],
      ) => {
        let cumulative = 0
        for (let i = 0; i < buckets.length; i++) {
          cumulative += counts[i]
          const le = buckets[i]
          lines.push(`${prefix}_bucket{le="${le}"} ${cumulative}`)
        }
        cumulative += counts[buckets.length]
        lines.push(`${prefix}_bucket{le="+Inf"} ${cumulative}`)
        lines.push(`${prefix}_sum ${sum}`)
        lines.push(`${prefix}_count ${count}`)
      }
      if (m.labels.size > 0) {
        for (const [key, labeled] of m.labels) {
          let cumulative = 0
          for (let i = 0; i < m.buckets.length; i++) {
            cumulative += labeled.counts[i]
            const le = m.buckets[i]
            lines.push(`${m.name}_bucket{${key},le="${le}"} ${cumulative}`)
          }
          cumulative += labeled.counts[m.buckets.length]
          lines.push(`${m.name}_bucket{${key},le="+Inf"} ${cumulative}`)
          lines.push(`${m.name}_sum{${key}} ${labeled.sum}`)
          lines.push(`${m.name}_count{${key}} ${labeled.count}`)
        }
      } else {
        emitHist(m.name, m.counts, m.sum, m.count, m.buckets)
      }
    }
  }
  return lines.join('\n') + '\n'
}

export function resetMetrics(): void {
  metrics.clear()
}

export function initMetrics(): void {
  counter('http_requests_total', 'Total HTTP requests')
  counter('http_request_errors_total', 'Total HTTP request errors')
  histogram('http_request_duration_seconds', 'HTTP request duration in seconds', [
    0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10,
  ])
  counter('llm_calls_total', 'Total LLM API calls')
  histogram('llm_duration_seconds', 'LLM call duration in seconds')
  counter('llm_tokens_total', 'Total LLM tokens consumed')
  counter('tool_runs_total', 'Total tool executions')
  counter('tool_errors_total', 'Total tool execution errors')
  gauge('active_sessions', 'Active chat sessions')
  counter('rag_queries_total', 'Total RAG queries')
  counter('sql_queries_total', 'Total SQL queries executed')
  counter('guardrail_blocks_total', 'Total SQL guardrail blocks')
}
