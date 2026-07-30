import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:3000'

export default function () {
  const res = http.get(`${BASE}/api/v1/health`)
  check(res, {
    'status 200': (r) => r.status === 200,
    'has ok field': (r) => r.json('ok') === true,
    'has version': (r) => r.json('version') !== undefined,
  })
  sleep(0.5)
}
