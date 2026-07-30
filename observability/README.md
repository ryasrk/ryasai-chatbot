# Observability

## Architecture (zero external deps)

```
App code → metrics.ts (in-memory) → /api/metrics → Prometheus scrape → Grafana
         ↘ observability.ts (ring buffer) → Langfuse/Helicone (optional)
         ↘ instrumentation.ts → OpenTelemetry Collector (optional)
```

## Metrics Endpoint

`GET /api/metrics` — Prometheus text format. Scrape every 15s.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: ryasai-chatbot
    scrape_interval: 15s
    static_configs:
      - targets: ['chatbot:3000']
    metrics_path: /api/metrics
```

## Grafana Dashboard

Import `observability/grafana/dashboard.json` into Grafana:
1. Dashboards → New → Import
2. Upload the JSON file
3. Select Prometheus datasource

Panels: request rate, latency p95, LLM calls, token consumption, guardrail blocks, HTTP errors, LLM errors, LLM latency by purpose.

## OpenTelemetry (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable distributed tracing:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

Install OTel packages when ready:
```bash
bun add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-fetch
```

`instrumentation.ts` auto-initializes on server start. Graceful no-op when packages aren't installed.

## Available Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `http_requests_total` | counter | method, path, status | Total HTTP requests |
| `http_request_errors_total` | counter | path | HTTP errors |
| `http_request_duration_seconds` | histogram | path | Request latency |
| `llm_calls_total` | counter | provider, purpose | LLM API calls |
| `llm_duration_seconds` | histogram | purpose | LLM call latency |
| `llm_tokens_total` | counter | provider | Token consumption |
| `llm_errors_total` | counter | provider | LLM call failures |
| `tool_runs_total` | counter | — | Tool executions |
| `tool_errors_total` | counter | — | Tool failures |
| `rag_queries_total` | counter | — | RAG queries |
| `sql_queries_total` | counter | — | SQL queries |
| `guardrail_blocks_total` | counter | type | Guardrail blocks |
| `active_sessions` | gauge | — | Active chat sessions |

## Alerting (Prometheus rules)

```yaml
groups:
  - name: ryasai
    rules:
      - alert: HighErrorRate
        expr: rate(http_request_errors_total[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Error rate >5% for 5 minutes"

      - alert: LLMProviderDown
        expr: rate(llm_errors_total[5m]) > 0
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "LLM provider errors for 10 minutes"

      - alert: HighLatency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "p95 latency >2s for 5 minutes"

      - alert: GuardrailSpikes
        expr: rate(guardrail_blocks_total[5m]) > 1
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Guardrail blocks >1/s — possible injection attempts"
```
