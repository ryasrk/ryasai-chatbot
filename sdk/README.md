# @ryasai/chatbot-sdk

Type-safe helpers for building [ryasai Chatbot](https://github.com/ryasai/Chatbot) plugin tools.

## Install

```bash
bun add @ryasai/chatbot-sdk
```

## Build a webhook plugin

```ts
import { createManifest, wrapHandler } from '@ryasai/chatbot-sdk'

// 1. Declare the manifest (validated at startup).
const manifest = createManifest({
  endpoint: 'https://my-tool.example.com/run',
  method: 'POST',
  authType: 'BEARER',
  authCredentials: process.env.MY_TOOL_TOKEN!,
  description: 'Looks up a customer by email.',
  paramDescription: '{ "email": "user@example.com" }',
})

// 2. Implement the handler (Express / Next.js / Node http compatible).
export const POST = wrapHandler(async (req) => {
  const { email } = JSON.parse(req.input)
  return { ok: true, output: JSON.stringify(await lookup(email)) }
})
```

## Register with ryasai

Admin → Settings → Plugins → New. Paste `JSON.stringify(manifest)` into the
manifest field and enable.

## API

- `PluginManifest` — mirrors the registry's manifest schema.
- `PluginRequest` / `PluginResponse` — handler I/O shapes.
- `createManifest(partial)` — validate + fill defaults (throws on invalid).
- `wrapHandler(fn)` — adapt a handler to an HTTP webhook.

License: UNLICENSED (proprietary).
