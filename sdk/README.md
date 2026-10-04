# @ryasai/chatbot-sdk

Type-safe helpers for building [ryasai Chatbot](https://github.com/ryasai/Chatbot) plugin tools.

## Install

This private package is distributed with the repository. Build it before installing it into another project:

```bash
cd /path/to/ryasai-chatbot/sdk
bun run build
cd /path/to/plugin-project
bun add /path/to/ryasai-chatbot/sdk
```

## Build a webhook plugin

```ts
import { createManifest, wrapFetchHandler } from '@ryasai/chatbot-sdk'

// 1. Declare the manifest (validated at startup).
const manifest = createManifest({
  endpoint: 'https://my-tool.example.com/run',
  method: 'POST',
  authType: 'BEARER',
  authCredentials: process.env.MY_TOOL_TOKEN!,
  description: 'Looks up a customer by email.',
  paramDescription: '{ "email": "user@example.com" }',
})

// 2. Implement a Fetch API handler (Next.js App Router).
export const POST = wrapFetchHandler(async (req) => {
  const { email } = JSON.parse(req.input)
  return { ok: true, output: JSON.stringify(await lookup(email)) }
})
```

Build the portable JavaScript and TypeScript declarations with `cd sdk && bun run build`. The emitted entrypoint runs under Node or Bun.

For Express and Next.js Pages API routes, use `wrapHandler` with a request/response pair.

## Register with ryasai

Admin → Settings → Plugins → New. Paste `JSON.stringify(manifest)` into the
manifest field and enable.

## API

- `PluginManifest` — mirrors the registry's manifest schema.
- `PluginRequest` / `PluginResponse` — handler I/O shapes.
- `createManifest(partial)` — validate + fill defaults (throws on invalid).
- `wrapFetchHandler(fn)` — adapt a handler to an HTTP webhook.

License: UNLICENSED (proprietary).
