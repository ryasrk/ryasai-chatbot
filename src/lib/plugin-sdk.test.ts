import { describe, expect, test } from 'bun:test'
import { wrapFetchHandler } from '../../sdk/handler'

describe('plugin SDK Fetch adapter', () => {
  test('App Router receives a Response with the plugin output', async () => {
    const handler = wrapFetchHandler(async (input) => ({ ok: true, output: input.input }))
    const response = await handler(new Request('http://plugin.test/run', {
      method: 'POST', body: JSON.stringify({ toolId: 'example', input: 'payload' }),
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ ok: true, output: 'payload' })
  })
  test('invalid JSON returns 400 before executing a plugin', async () => {
    let calls = 0
    const handler = wrapFetchHandler(() => { calls++; return { ok: true, output: '' } })
    const response = await handler(new Request('http://plugin.test/run', { method: 'POST', body: '{' }))
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })
  test('thrown exceptions cannot disclose credentials to the caller', async () => {
    const handler = wrapFetchHandler(() => { throw new Error('secret-provider-token') })
    const response = await handler(new Request('http://plugin.test/run', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret-provider-token')
  })
})
