/**
 * @ryasai/chatbot-sdk — type-safe helpers for building plugin tools.
 *
 * Quick start:
 *   import { createManifest, wrapHandler } from '@ryasai/chatbot-sdk'
 *
 *   const manifest = createManifest({
 *     endpoint: 'https://my-tool.example.com/run',
 *     method: 'POST',
 *     authType: 'BEARER',
 *     authCredentials: process.env.MY_TOOL_TOKEN!,
 *     description: 'Looks up a customer by email.',
 *     paramDescription: '{ "email": "user@example.com" }',
 *   })
 *
 *   export const POST = wrapHandler(async (req) => {
 *     const { email } = JSON.parse(req.input)
 *     return { ok: true, output: JSON.stringify(await lookup(email)) }
 *   })
 */
export type {
  PluginManifest,
  PluginAuthType,
  PluginMethod,
  PluginExecutorType,
  PluginRequest,
  PluginResponse,
  HttpLikeRequest,
  HttpLikeResponse,
} from './types'

export { createManifest } from './manifest'
export { wrapHandler } from './handler'
