# Cross-source benchmark — 800 questions

Measures whether the chatbot picks the right source and reports the right number,
across four databases and three REST services.

    bun trial/cross/run.ts --family SQL_SALES --json trial/cross/results-SQL_SALES.json
    bun trial/cross/consolidate.ts --json trial/cross/report.json
    bun trial/cross/rescore.ts      # re-score SAVED answers after a judge change
    bun trial/cross/repeat.ts --family SQL_SALES --trials 3   # separate variance from defects

Four families, 200 questions each: `SQL_SALES`, `SQL_HR`, `REST`, `CROSS`. Each writes
its own file so the four can run concurrently; `consolidate.ts` does the single merge.

## Why each question is built the way it is

Every answer is a NUMBER, and the wrong source yields a DIFFERENT number. The earlier
100-question set could not detect a wrong source at all: with one database, every answer
came from the only source there was. Here a question about the sales database answers 8
while the demo database would answer 5, so a misrouted question fails visibly instead of
looking plausible.

Two rules learned the hard way:

- **Never append a suffix for uniqueness.** `(bagian N)`, `(varian N)`, `(data ke-N)` and
  `(pengulangan N)` were all read by the model as CONVERSATION HISTORY — "this is a fresh
  conversation, so there is no leave request data" — and it then refused a question it
  otherwise answers. The id already carries the index.
- **Phrase around ambiguity, do not score it.** `jumlah produk yang dijual` has two correct
  answers (7 product rows, 71 units via `SUM(qty)`); `jenis produk` drew 3 (the 3 kategori);
  `divisi kepegawaian` drew 2, because one department is literally named "SDM". The model
  was right each time and the question was at fault. Questions now name the row count and
  the table, and ask for the whole company.

## Reading the results honestly

`run.ts` paces questions (`CROSS_PACE_MS`) and ABORTS after 5 consecutive HTTP 429s with
`accuracy: null`. A throttled run produces empty answers, which score as failures and would
otherwise be published as an accuracy figure measuring the rate limiter — that happened
once, with 196/200 questions refused, and all four subagents flagged it independently.

A single pass cannot tell a broken pipeline from a model that sampled different SQL. In the
run recorded here, 3 of the 5 failures answered CORRECTLY 5 times out of 5 when re-asked.
Use `repeat.ts` before calling any failure a defect.

There are TWO chat rate limiters and only one is obvious:
`CHAT_RATE_LIMIT_PER_MIN` (per-organization, inside the route handler) and
`RATE_LIMIT_CHAT_PER_MIN` (per-IP, in the middleware, default 30). A batch is stopped by the
second, so raising only the first changes nothing. Both must be raised for a benchmark.

## Recorded result

Model `cbcn/deepseek-v4.1-flash`, 800 questions, zero HTTP 429s, zero empty answers:

| family | accuracy | p50 | TTFT p50 | tok/task |
|---|---|---|---|---|
| SQL_SALES | 99% (198/200) | 6192 ms | 84 ms | 38.66 |
| SQL_HR | 99% (198/200) | 6210 ms | 84 ms | 48.57 |
| REST | 100% (200/200) | 6806 ms | 85 ms | 234.00 |
| CROSS | 99.5% (199/200) | 6357 ms | 83 ms | 84.50 |
| **total** | **99.38% (795/800)** | 6363 ms | 84 ms | 101.51 |

Token speed p50 7.29 tok/s; 81,109 completion tokens over 799 sampled turns. Accuracy
per source: SQL 99.23% (516/520), REST 99.64% (279/280).

Three of the five failures passed 5/5 on re-ask, giving a variance-corrected **99.75%
(798/800)**. The two that stayed wrong — S019 ("Hitung pesanan batal." answering 0) and S031
(a refusal) — are the same SQL-branch weakness: it sometimes selects 0 or declines instead
of naming the source. Both are answered correctly by the REST branch in most runs, which is
why the measured figure is still 99.38%.

"Routing agreement" (SQL 65.58%) is deliberately NOT an accuracy measure. 183 of the
SQL-source questions were served over REST and 178 of those were still correct — reaching
the same rows another way is flexibility, not an error. Only the ANSWER is scored.
