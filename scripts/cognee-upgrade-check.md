# Before upgrading `@cognee/cognee-ts` — read this

**Current version: `0.1.3`. Last evaluated: `0.2.0` on 2026-09-15 — REJECTED.**

Every claim below was measured on this machine against the real store, not read from a
changelog. Re-run the probe at the bottom before overriding this decision.

## Which upstream repo matters

Two version tracks exist and they are **not** the same lineage:

| Track | Repo | Version we care about |
|---|---|---|
| Python | [topoteretes/cognee](https://github.com/topoteretes/cognee) | v1.5.4 — **irrelevant to us**, we do not embed Python |
| Rust + TS bindings | [topoteretes/cognee-rs](https://github.com/topoteretes/cognee-rs) | v0.2.0 = npm `@cognee/cognee-ts@0.2.0` |

We ship the **TS bindings**, so `cognee-rs` is the only release feed that can change our
behaviour. Confirmed by `gitHead`/`repository` on the npm package pointing at `cognee-rs`,
and by `optionalDependencies` resolving to `@cognee/neon-*@0.2.0`.

## Why 0.2.0 is rejected — it does not just break, it corrupts

### 1. `remember()` reports success and writes nothing

```
PROBE remember OK 25ms {"status":"PipelineRunCompleted", ...}
PROBE names=org:cmsst1wd20000h8h2k8bp70s4
VEGA: 0 node    ORION: 0 node    NEBULA: 1 node   (NEBULA was written on 0.1.3)
```

25 ms is the tell: a real `cognify` runs its own LLM pipeline and takes ~15–35 s. The
`pipeline_runs` table after the write contained **only `add_pipeline` rows** — no
`cognify`. The `data` rows landed with `pipeline_status: None`.

This is strictly worse than the known `datasets.has()` bug: a wrong boolean is a nuisance,
a **false success on the write path silently loses user memory**.

### 2. The damage survives a downgrade

After reverting to 0.1.3, the same store wrote in **416 ms** and recalled nothing. The log said:

```
cognify: dataset already completed; short-circuiting (Python parity)
```

0.2.0 had marked the dataset complete, and that mark **persists in `cognee.db`**. So
cognify now refuses to process new data — and it is not a transient state. Measured:

| Store | write | recall |
|---|---|---|
| Same store, after revert to 0.1.3 | 416 ms | token **not found** |
| Fresh store, on 0.1.3 | **15142 ms** | token **found** |

Recovery required deleting the store. A dependency bump that makes a working system
unrecoverable by downgrading is not something to take casually.

### 3. It fixes neither problem that motivated looking

| | 0.1.3 | 0.2.0 |
|---|---|---|
| `datasets.has()` on a present dataset | `false` (wrong) | **`false` (still wrong)** |
| `NATURAL_LANGUAGE` on kuzu | fails | **fails, ~7 s** |
| `SUMMARIES` | OK | OK (263 ms) |
| `CHUNKS` | OK | OK (47 ms) |
| `CHUNKS_LEXICAL` | OK (41 ms) | OK (37 ms) |
| `HYBRID_COMPLETION` | not available | **OK, 1303 ms, 4542 chars** |
| `remember()` populates the graph | yes (~15–35 s) | **no** |

Proof that `has()` is still broken, i.e. our advisory-not-authoritative handling must stay:

```
PROBE names=org:cmsst1wd20000h8h2k8bp70s4   (present in datasets.list())
PROBE has=false                              (has() disagrees)
```

### 4. The one real gain is currently unusable

`HYBRID_COMPLETION` is genuinely attractive — measured 4542 chars of context vs 2055 for
`CHUNKS`, i.e. ~2.6× richer, at 1303 ms. It is worthless while `remember()` does not write,
because there is nothing to retrieve. Note also that `GRAPH_COMPLETION`, the obvious
alternative, is not a candidate: it was measured failing after **193 341 ms**.

## What to do instead (unchanged, still correct)

- Stay on `0.1.3`.
- Keep the graph-backend gate: skip `NATURAL_LANGUAGE` on kuzu, use `CHUNKS_LEXICAL` there.
  The predicate is `supportsNaturalLanguageSearch()` in `src/lib/cognee-core.ts`.
- Keep treating `datasets.has()` as **advisory only** — `false` must not suppress recall.
- For production, move the graph backend to Postgres (`COGNEE_DB_PROVIDER=postgres`).
  The kuzu path is dev-only and is where every measured graph failure occurred.

## How to re-evaluate (the probe that produced the table above)

1. Start the deps the store needs: Postgres, Redis, the router gateway, and a **live**
   embedding endpoint on `:4503`. A dead embedding server produces
   `embedding error: HTTP error: Request failed` after ~200 s and will look like a
   dependency regression when it is only a missing fixture — this cost a wrong
   intermediate conclusion once already.

2. Bump the dependency, then run a **write-then-recall** probe, reading the token from a
   *new* session so only long-term memory can supply it:

   ```ts
   enterWithOrg('<org-id>')
   await rememberChatTurn({ userMessage: `secret is TOKEN-1234`, aiMessage: 'ok',
                            toolRuns: [], sessionId: 'probe-w' })
   // a DIFFERENT session id — session memory must not be what answers
   const r = await recallContext({ query: 'what is the secret?', sessionId: 'probe-r-<unique>' })
   console.log(r.includes('TOKEN-1234'))
   ```

3. **Judge only on the recall result.** A `status: PipelineRunCompleted` response is not
   evidence of a write — that is exactly how 0.2.0 passed a superficial check while losing
   data. Cross-check with the graph itself:

   ```
   sqlite3 .cognee/system/<org>/cognee.db \
     "SELECT label FROM nodes WHERE label LIKE '%TOKEN%'; SELECT pipeline_status FROM data;"
   ```

   A write is real when the node exists and `pipeline_status` is set.

4. If any step fails, revert — and delete `.cognee/system/<org>/` before re-testing, or the
   "already completed" mark will make the reverted build look broken too.
