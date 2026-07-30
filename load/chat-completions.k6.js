import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  scenarios: {
    smoke: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 5 },
        { duration: '20s', target: 5 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.05'],
  },
}

const BASE = __ENV.BASE_URL || 'http://localhost:3000'
const API_KEY = __ENV.API_KEY || 'rk_test_0000000000000000000'

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
}

const PAYLOAD = JSON.stringify({
  model: 'default',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  stream: false,
})

export default function () {
  const res = http.post(`${BASE}/api/v1/chat/completions`, PAYLOAD, { headers })
  check(res, {
    'status 200 or 429': (r) => r.status === 200 || r.status === 429,
    'rate limit has headers': (r) => r.status !== 429 || r.headers['X-RateLimit-Remaining'] !== undefined,
  })
  if (res.status === 200) {
    check(res, {
      'has answer': (r) => r.json('answer') !== undefined,
    })
  }
  sleep(2)
}
