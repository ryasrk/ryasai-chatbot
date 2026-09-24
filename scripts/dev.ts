// Cross-platform `bun run dev`: Bun auto-loads .env, so no shell sourcing is needed.
// Mirrors the old `next dev ... | tee dev.log` behaviour.
import { createWriteStream } from 'node:fs'

const port = process.env.PORT || '3000'
const log = createWriteStream('dev.log')

const proc = Bun.spawn(['bun', 'run', 'next', 'dev', '-p', port], {
  stdout: 'pipe',
  stderr: 'pipe',
  env: process.env,
})

async function pump(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) {
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    sink.write(chunk)
    log.write(chunk)
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => proc.kill())
}

await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)])
log.end()
process.exit(await proc.exited)
