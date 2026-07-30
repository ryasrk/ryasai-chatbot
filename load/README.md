# k6 Load Tests

## Prerequisites

```bash
# Install k6
brew install k6          # macOS
# or
sudo apt install k6      # Debian/Ubuntu
# or via Docker:
docker run --rm grafana/k6 run -< load/health.k6.js
```

## Running

### 1. Health check (liveness probe — lightest)
```bash
k6 run load/health.k6.js
# Against a remote server:
BASE_URL=https://chatbot.example.com k6 run load/health.k6.js
```

### 2. Deep health (DB + Redis — for capacity planning)
```bash
k6 run load/health-deep.k6.js
```

### 3. Chat completions (requires API key)
```bash
API_KEY=rk_yourkeyhere BASE_URL=http://localhost:3000 k6 run load/chat-completions.k6.js
```

### 4. Sustained load (100-200 VUs for 75s — soak test)
```bash
BASE_URL=https://chatbot.example.com k6 run load/sustained.k6.js
```

## Scenarios

| Script | VUs | Duration | Target | Purpose |
|--------|-----|----------|--------|---------|
| `health.k6.js` | 10 | 30s | Liveness | Baseline response time |
| `health-deep.k6.js` | 20→50→0 | 50s | DB+Redis | Capacity under load |
| `chat-completions.k6.js` | 5 | 30s | Chat API | End-to-end latency |
| `sustained.k6.js` | 100→200 | 85s | Liveness | Soak test, memory leaks |

## Metrics

All scripts emit k6 built-in metrics + custom ones:
- `db_latency_ms` — DB query latency from /api/health
- `redis_latency_ms` — Redis ping latency
- `health_degraded` — counter when Redis is down

## CI Integration

```yaml
# .github/workflows/load-test.yml
- run: k6 run load/health.k6.js --out json=results.json
  env:
    BASE_URL: http://localhost:3000
```
