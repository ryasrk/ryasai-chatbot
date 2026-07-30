import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Counter, Trend } from 'k6/metrics'

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
    'checks{group:::db health}': ['rate>0.99'],
    'checks{group:::redis health}': ['rate>0.95'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:3000'

const dbLatency = new Trend('db_latency_ms')
const redisLatency = new Trend('redis_latency_ms')
const degraded = new Counter('health_degraded')

export default function () {
  group('db health', function () {
    const res = http.get(`${BASE}/api/health`)
    check(res, {
      'status 200 or 503': (r) => r.status === 200 || r.status === 503,
      'has checks.db': (r) => r.json('checks.db') !== undefined,
    })
    if (res.status === 200) {
      const dbMs = res.json('checks.db.latencyMs')
      if (typeof dbMs === 'number') dbLatency.add(dbMs)
      const redis = res.json('checks.redis')
      if (redis && typeof redis.latencyMs === 'number') redisLatency.add(redis.latencyMs)
      if (redis && redis.ok === false) degraded.add(1)
    }
  })

  sleep(1)
}
