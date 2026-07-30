import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  stages: [
    { duration: '15s', target: 100 },
    { duration: '30s', target: 100 },
    { duration: '10s', target: 200 },
    { duration: '20s', target: 200 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.001'],
    'checks{group:::liveness}': ['rate>0.9999'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:3000'

export default function () {
  const res = http.get(`${BASE}/api/v1/health`)
  check(res, {
    'liveness 200': (r) => r.status === 200,
    'fast <200ms': (r) => r.timings.duration < 200,
  })
  sleep(0.1)
}
