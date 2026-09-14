# Measurement against a REAL provider

Earlier rounds reported accuracy, token speed and tokens/task as **not measurable**,
because BYOK means no provider ships with the product. That was honest but unhelpful,
and a real provider turned out to be reachable on this machine. These scripts do the
measurement through the **production HTTP path**, so the numbers cover the whole
stack (tenant resolution, intent pipeline, routing, SSE transport, the model) rather
than a hand-written call.

## What is measured, and what is NOT

Measured against a live OpenAI-compatible gateway:

| Quantity | Result | How |
|---|---|---|
| Accuracy | **78/78 = 100.00%** (3 trials x 26 questions) | `measure.ts` |
| Token speed | **median 234 tok/s** (range 214–267, 8/8 samples) | `token-speed.ts` |
| Tokens/task | **92 tokens of OUR prompt**; 2,002 are the gateway's preamble | `prompt-size.ts` |
| Latency | p50 5.2 s, p90 7.4 s end-to-end | `measure.ts` |

NOT measured, and not claimed:
- **Retrieval or SQL correctness.** Those need org data the dev database does not
  have. The question set is deliberately factual/arithmetic/reasoning/format, which a
  bare model answers without any org data.
- **Token speed under load.** One client, sequential requests.
- **Anything about a specific customer's gateway.** The numbers describe the model
  reached here, not the product's ceiling or floor.

## Running it

```bash
bun trial/live/setup.ts <baseUrl> <model> <apiKeyFile>   # point LlmConfig at the provider
bun trial/live/measure.ts --trials 3 --json out.json     # accuracy + latency
bun trial/live/token-speed.ts                            # token speed
bun trial/live/prompt-size.ts                            # our prompt vs gateway overhead
bun trial/live/setup.ts --restore                        # put the original config back
```

`setup.ts` changes only `baseUrl`, `model` and the encrypted API key, and writes a
backup first. **Always run `--restore`** so a live key is not left in the database.

The server must be running with the provider host allowlisted, which is what
`LLM_ALLOWED_HOSTS` is for:

```bash
LLM_ALLOWED_HOSTS=localhost bun run dev
```

That env var must NOT be set in `.env`: the blocklist tests assert that
`localhost` is blocked by default, so putting it in `.env` makes them fail. The
allowlist is a runtime decision for the deployment, not a repo default.

## Why token speed is reported differently now

An earlier round reported 403.2 then 278.9 tok/s and flagged both as untrustworthy,
because they divided completion tokens by `total - TTFT` and MEASURED that 5 of 6
runs had that window under 50 ms -- the provider delivers the answer in one burst,
so the denominator approached zero and produced 0 and 34000 tok/s in the same series.

`token-speed.ts` divides by the **generation window** (`total - TTFT`) but only
records a rate when that window is at least 500 ms, and prints every raw sample so a
reader can check the denominator instead of trusting a summary. All 8 samples
qualified, with windows of 1.0–1.2 s and a tight range.
