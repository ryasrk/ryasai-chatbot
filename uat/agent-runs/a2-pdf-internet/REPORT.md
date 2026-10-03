# A2 — KNOWLEDGE (RAG) path: PDFs downloaded from the internet

Agent A2 · org `zz-agent-cross` · all uploads prefixed `a2-internet-` ·
work dir `uat/agent-runs/a2-pdf-internet/` · run of 2026-10-03 (UTC times).

**Status of this report: PARTIAL — retrieval verdicts could not be produced.**
The shared dev server wedged twice during my window (14:52:43 UTC and again 25 s after a 15:31:29 UTC
restart), so none of my uploads completed: the database contains **0 documents** whose name starts with
`a2-internet-` (verified by direct read-only query, see F7 — the only `POST /api/documents 201` entries
in the log are another agent's `.md` files). Everything in "Findings" marked **PROVEN** was verified by
running the product's own code (imported, not modified) on the downloaded bytes, or by reading the
product's own source; nothing is scored on an HTTP status code, and no retrieval claim is made at all.
See **`## Not verified`**.

---

## Environment

- App: `http://localhost:3000`, dev server, version **2.1.0** (`package.json`), `next-server v16.3.8`.
- Org: **`zz-agent-cross`** (`orgs().cross`), `userId cmusi51eb000dh8dgujc5yn5z`.
- Harness: `scripts/tmp-agent-lib.ts` (`orgs`, `api`, `apiJson`, `ask`, `uploadFile`, `uploadText`,
  `waitEmbedded`, `newSession`), read before use.
- One config prerequisite had to be satisfied before any upload was possible:
  `POST /api/documents` answered **503 `SETUP_REQUIRED`** ("Choose where the knowledge base is stored
  before uploading documents.") because `VectorStoreConfig.storageChosenAt` was null for this org.
  I set the org's default provider via `PUT /api/vector-store` `{provider:'INTERNAL'}` → 200,
  `storageChosen:true`. This is a per-org setting, not a code/guard change; it does not affect the
  other agents' `a2-internet-`-prefixed namespace. Worth noting for the run: **every fresh org must
  make this choice before its first upload**, and other agents on the shared org hit the same 503.

### Downloaded PDFs

`file(1)` and sha256 are of exactly the bytes on disk (`/tmp/a2/hashes.txt`, `filefacts.txt`).

| local name | bytes | sha256 | `file` output | source |
|---|---|---|---|---|
| `arxiv-attention.pdf` | 2,215,244 | `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697` | `PDF document, version 1.5, 5 page(s)` | `https://arxiv.org/pdf/1706.03762` |
| `rfc-9110.pdf` | 2,858,365 | `60b30efa1048900833d1758440247fe8ac85a3134f2327388dcb24e07d814c89` | `PDF document, version 1.5, 311 page(s)` | `https://www.rfc-editor.org/rfc/rfc9110.pdf` |
| `irs-w9-form.pdf` | 140,815 | `2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53` | `PDF document, version 1.7 (zip deflate encoded)` | `https://www.irs.gov/pub/irs-pdf/fw9.pdf` |
| `fr-1936-scan.pdf` | 3,256,897 | `8d77ce0271b7919147b5c879bcd3fd637b0fc576a93cdf7ddf17b092f89cd415` | `PDF document, version 1.5, 16 page(s)` | `https://www.govinfo.gov/content/pkg/FR-1936-03-14/pdf/FR-1936-03-14.pdf` |
| `commons-scan-saylah.pdf` | 457,807 | `ecf1dd44cfb79394c62749853370ef56d7597ecaf01908b3a859cd06ba30305e` | `PDF document, version 1.3, 1 page(s)` | Wikimedia Commons `Scanned_Documents_Saylah.pdf` |
| `commons-santoro-001.pdf` | 3,690,564 | `10a13bd6436b5a7beec545dc14fb52ec65ed797a3f90d29efaaa20dc1f38912c` | `PDF document, version 1.3, 1 page(s)` | Wikimedia Commons `Gaspare_Santoro_Document_001.pdf` |
| `w3c-dummy.pdf` | 5,791 | `cc4bdbb03eb561a7d4ccba8866e425c9a21a4acdebfb9fd6217cd0eb5d9c8968` | **`HTML document, ASCII text`** | requested `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` |
| `malformed-plaintext-as.pdf` | 80 | `aca037f22a4237ab69f3e77231c43e633c7f40b8cdf2973f7a51722523e2f41f` | `ASCII text` | constructed (mission step 6) |
| `malformed-truncated.pdf` | 900 | `a90c7ecdc4a0ff09161f880860295bddd84ffbe9ce9b3783bf16c3244b105ad6` | `PDF document, version 1.5` | first 900 bytes of `rfc-9110.pdf` (mission step 6) |

- **The suggested W3C URL does not serve a PDF.** It answered **HTTP 403** with a Cloudflare
  interstitial (`<title>Just a moment...</title>`, `content_type=text/html`) and curl still wrote
  5,791 bytes to the `-o` target: **a `.pdf` file that is an HTML error page**. I replaced it with
  RFC 9110 (a standards PDF) for the real-PDF set, and kept the W3C bytes as an additional
  malformed-input specimen (they are the same shape as mission step 6 and are covered as such).
- `commons-santoro-001.pdf` and `commons-scan-saylah.pdf` are **image-only**: 0 occurrences of
  `/Font` in the raw bytes, 1 page each, `pypdf` extracts **0 chars**, single `/Subtype /Image`
  `/Filter /DCTDecode` (JPEG) object × 6600×10200 px (Santoro) resp. DCTDecode + FlateDecode (Saylah).
- Reference text used to ground expectations was extracted with `pypdf` (`*.extract.txt`) — the exact
  quotes are in `questions.json` and repeated in the retrieval table.

---

## Ingestion table

**No row in this table is an HTTP result — the app never processed my files.**

The app had already been unresponsive since **14:52:43 UTC** when I started
(`dev.log` and `/tmp/agentsvc/app.log` both stop there; last lines are KG-extraction warnings).
It was restarted at **15:31:29 UTC**, and my supervisor fired immediately — but the app wedged again
about 25 s later, before my first upload returned. `POST /api/documents` appears in the fresh log only
three times, all at 15:31:46 and all belonging to another agent (confirmed in the database:
`d2-01-kebijakan-cuti.md`, `d2-02-sop-layanan-pelanggan.md`, `d2-05-kebijakan-pengadaan-barang.md`).
My first upload (`a2-internet-arxiv-attention.pdf`) sat in the TCP accept queue instead; I killed the
earlier attempt rather than let it time out inside the app, and the later attempt is still queued.
A read-only query against Postgres confirms the outcome:

```sql
select count(*) from "Document" where name like 'a2-internet-%';   -- 0
```

So `upload-log.jsonl` is **empty**, no `a2-internet-` row exists, and no
`chunkCount`/`embeddedChunkCount`/`status`/`cognifyStatus` values exist. I will not fabricate them.

What I *can* state as measured is the **predicted** ingestion, obtained by running the product's own
extraction path on the exact bytes (`scripts 05/` and direct imports of
`src/lib/document-parsers.ts` + `src/lib/rag-chunking.ts` — read-only, no product file edited):

| pdf | bytes | parser `extractPdfTextFromBuffer` | `extractFileText` → `isPlaceholder` | stored `contentText` | chunks | embedded | status | cognifyStatus | verdict (predicted) |
|---|---|---|---|---|---|---|---|---|---|
| `a2-internet-arxiv-attention.pdf` | 2,215,244 | 40,956 chars, real text | real text | real text | — | — | — | — | should ingest; unverified |
| `a2-internet-rfc-9110-http-semantics.pdf` | 2,858,365 | 148,539 chars (starts with CID control bytes) | real text | real text | — | — | — | — | should ingest; unverified |
| `a2-internet-irs-w9-form.pdf` | 140,815 | 28,731 chars, real text | real text | real text | — | — | — | — | should ingest; unverified |
| `a2-internet-fr-1936-scan.pdf` | 3,256,897 | 3,300 chars, **all CID garbage** (0 of 6 expected phrases present) | real text | garbage-as-text | — | — | — | — | **FAIL (lossy, not empty)** |
| `a2-internet-scanned-image-only.pdf` (Saylah) | 457,807 | **0 chars** | **`isPlaceholder: true`, `[Binary document: …]`** | `[Binary document: …]` (96 chars) | 1 | — | — | — | placeholder stored, but see F2 |
| `a2-internet-scanned-santoro-001.pdf` | 3,690,564 | **5,940 chars of JPEG-binary noise** | **`isPlaceholder: false`** | noise-as-text | 7 | — | — | — | **FAIL (binary noise as knowledge)** |
| `a2-internet-malformed-plaintext.pdf` | 80 | 0 chars (correct) | `isPlaceholder:false` (raw-text fallback) | plain text incl. `BANANA-7731` | — | — | — | — | **FAIL (see F4)** |
| `a2-internet-malformed-truncated.pdf` | 900 | 0 chars (correct) | `isPlaceholder:false` (raw-text fallback) | `%PDF-1.5` + binary object bytes | — | — | — | — | **FAIL (see F4)** |
| (`w3c-dummy.pdf`, not uploaded) | 5,791 | 0 chars | `isPlaceholder:false` (raw-text fallback) | Cloudflare HTML | — | — | — | — | **FAIL (see F4)** |

`chunks` in that column is the count `chunkText()` produces for the stored text (Saylah 1, Santoro 7);
`embedded`, `status`, `cognifyStatus` were **not** observable and stay blank.

---

## Retrieval table

**Empty — no question was ever asked.** `ask()` requires a live SSE endpoint; the app answered
nothing during my entire window, so no answer, verbatim or otherwise, exists. The grounded question
set is written and ready in `questions.json` (10 questions over 5 documents, each with the expected
value **and the exact PDF quote** it comes from, e.g. arXiv `"Our model achieves 28.4 BLEU on the
WMT 2014 English-to-German translation task…"`, RFC 9110 `"This document updates RFC 3864 and
obsoletes RFCs 2818, 7231, 7232, 7233, 7235, 7538, 7615, 7694, and portions of 7230."`, W-9
`"withhold and pay to the IRS 24% of such payments. This is called "backup withholding.""`,
FR 1936 `"ENLARGING CAPE ROMAIN MIGRATORY BIRD REFUGE / SOUTH CAROLINA"`), plus the
scanned-image honesty question and the `BANANA-7731` malformed-input question.

| pdf | question | expected (from the text) | actual | verdict |
|---|---|---|---|---|
| — | — | — | *(no turn completed — server unresponsive)* | **not verified** |

I deliberately did not run the answers through a fallback path, and I am not scoring anything on a
status code. If the server returns, `bun run uat/agent-runs/a2-pdf-internet/10-upload.ts` then
`20-ask.ts` then `30-verify.ts` will fill this table; a supervisor
(`/tmp/a2/supervise.sh`) was polling `/api/health` every 20 s and would have fired the upload batch
automatically on the first `200`.

---

## Findings

### F1 — PROVEN, HIGH: an image-only PDF becomes binary noise instead of an empty placeholder (violates invariant #4)

`AGENTS.md` invariant 4: *"PDF/DOCX/XLSX extraction must stay lossless-or-empty: `document-parsers.ts`
never "falls back" to dumping printable ASCII from raw bytes … Image-only PDFs return `''` so the doc
is marked a placeholder."* A real, downloaded, image-only PDF violates this.

Evidence — `commons-santoro-001.pdf` (1 page, 0 `/Font` objects, `pypdf` extracts **0 chars**):

```
$ bun run /tmp/a2/chain.ts
commons-santoro-001.pdf: parserChars=5940 -> storedContentChars=5940 chunks=7
   isPlaceholderChunk(stored chunk0)=false
   chunk0 sample="=\u0018æÔb\u0019!@4v¥\u001cP19ÅFÇµ\u0006J\u0000?ÊÒ+6ÞìÍw,A\bXú·biæ§4ÚZ;sHb…"
```

`extractPdfTextFromBuffer` returns **5,940 chars** (printable ratio 0.65); the upload route stores
them as `contentText` because `extracted.length > 0`; `chunkText()` yields **7 chunks**; and
`isPlaceholderChunk()` is **false**, so these chunks are eligible as answer evidence. That is
"binary noise chunked, embedded, and served as knowledge" — the exact failure the comment block in
`document-parsers.ts` says the extractor was written to prevent.

Root cause (measured, `why-santoro.ts` / `count.py`), a three-line chain in
`iteratePdfContentStreams`:

1. The image object is `/Subtype /Image … /Filter /DCTDecode` — not Flate — so it takes the
   `else` branch;
2. that branch calls `if (/\)\s*Tj|\]\s*TJ|>\s*TJ/.test(raw.toString('latin1')))` on the **raw JPEG
   bytes** before trying inflate. The JPEG contains exactly one accidental match,
   `]TJ` at byte offset 2,257,433 (`…Á>\x80×]TJ\x0cRð))…`), so the test passes;
3. the whole 3.68 MB JPEG is therefore taken as "a content stream", and **78 accidental
   `(...)Tj`-shaped byte runs inside it** become the "text".

The existing regression test (`document-parsers.test.ts:127`, *"never returns binary noise when a
PDF yields no text"*) cannot catch this: it feeds an 18-byte synthetic PNG magic sequence with **no
`stream` keyword and no filter dictionary**, so `sawStream` is false and the code takes the
raw-bytes fallback path. No test exercises a real `/DCTDecode` image object.

Why it is not merely theoretical for *this* file: the artifact that gets embedded is a 3.68 MB JPEG's
byte noise; it is durable (stored text, then embedded, then FTS-indexed), and a retrieval hit on it
is indistinguishable to the answer prompt from real evidence.
Reproducible: yes — deterministic; the same file gives the same 5,940 chars on every run.
Suspected fix direction (not applied): treat `/Subtype /Image` (and any non-text filter such as
`/DCTDecode`, `/JPXDecode`, `/CCITTFaxDecode`) as non-text streams, and/or require the text-operator
match to occur in a stream whose dictionary is not an image.

### F2 — PROVEN, HIGH: the placeholder detector is effectively dead code, and the guard that should replace it is bypassed

`isPlaceholderChunk()` (the predicate that keeps placeholders out of answer evidence, consumed at
`intent-pipeline.ts:459, 822, 904`) matches exactly one string, `[Empty document: …]`, produced by
`emptyDocumentContent()`. **For every case the mission exercises — and for every uncatchable PDF —
that string never reaches storage.**

The only production caller of `emptyDocumentContent` is the upload route's ternary
(`documents/route.ts:229-231`):

```ts
const contentText = extracted && extracted.length > 0 ? extracted : emptyDocumentContent(file.name)
```

and `extracted` is whatever `extractFileText` returned. `extractFileText` (read in full,
`rag-chunking.ts:287-333`) exits in five ways:

| exit | returns | `isPlaceholder` |
|---|---|---|
| txt/md success | file text | false |
| txt/md read failure | `[Text document: <name>, <n> bytes. Read failed.]` | true |
| pdf/docx/xlsx "success" | whatever the extractor returned — **including a whitespace-only string** | false |
| printable raw fallback (`ratio > 0.85`) | raw bytes as text | false |
| final fallback | `[Binary document: <name>, <n> bytes. Parsed content placeholder.]` | true |

So `emptyDocumentContent()` is only reached when an extractor returns a **zero-length** string.
I found one such case, and it is instructive rather than a rescue: a minimal XLSX whose only cell
holds a single space yields `text: ''` and `isPlaceholder: false` —

```
$ bun run /tmp/a2/xlsx.ts
raw extractor result: " " len 1
extractFileText: {"text":"","isPlaceholder":false}
```

— i.e. the marker becomes reachable, but the branch *loses the information that extraction was empty*
(the raw extractor did return `" "`, and nothing downstream records that the text was blank,
because `isPlaceholder` is false). For the cases that matter, all five exits return a **non-empty**
string, so `extracted.length > 0` holds and `[Empty document: …]` is never written. Measured on the
real `extractFileText` + route-shape path (`/tmp/a2/marker.ts`):

```
{"file":"commons-scan-saylah.pdf",  "markerKindStored":"BINARY", "isPlaceholderChunkStoredContent":false,
 "storedSample":"[Binary document: a2-internet-scanned-image-only.pdf, 457807 bytes. Parsed content placeholder.]"}
{"file":"commons-santoro-001.pdf", "markerKindStored":"REAL_TEXT", "isPlaceholderChunkStoredContent":false,
 "storedChars":5940, "storedSample":"=\u0018æÔb\u0019!@4v¥\u001cP19ÅFÇµ…"}
```

The `isPlaceholder: true` flag that `extractFileText` *does* set for the two fallback markers is used
only for the `writeAudit({... isPlaceholder ...})` detail — it is **dropped** on the way to storage;
the DB stores `contentText` and nothing else (the route never branches on `isPlaceholder` at all; the
destructured value is consumed by the audit call). Net effect: the two mechanisms intended to keep
placeholder text out of answers are disconnected by a string literal:

- the marker the detector knows (`[Empty document:`) is not produced whenever extraction returns any
  non-empty marker text — i.e. in every real failure case;
- the markers the path does produce (`[Binary document:`, `[Text document:`) are unknown to the detector.

**And the detector is the only gate there is.** Verified against the other two stages of the pipeline:

- `embedDocumentChunks` (`embeddings.ts:336-440`) selects chunks by `documentId` alone — no
  `isPlaceholderChunk`, no marker check — and issues an `UPDATE … SET "embeddingJson" …, "embedding" …
  WHERE id = …` for every chunk in the batch, so a placeholder chunk is embedded exactly like real
  content (and, when `CONTEXTUAL_RETRIEVAL=true`, is additionally fed to an LLM summariser as
  `fullText`). `grep -rn isPlaceholderChunk src/lib/rag*.ts src/lib/retrieval*.ts` returns **nothing**:
  the only consumers in the whole tree are `intent-pipeline.ts` (3 call sites) and the units' own tests.
  So there is no second line of defence behind the string match — a chunk that does not start with
  `[Empty document:` is embedded, FTS-indexed, and eligible as evidence.

This supersedes an earlier, weaker framing of this finding ("two of three markers are missed"): the
core problem is that **the guard cannot fire for the failures it was written for, and the documented
behaviour it protects is unreachable on the failure paths.** The one test that claims otherwise
(`rag-chunking.test.ts:148`, *"builder and detector agree (no marker drift)"*) only feeds
`emptyDocumentContent()`'s own output back to the detector, so it confirms the pair is internally
consistent while never exercising the producer/consumer boundary. `documents/route.test.ts`
mocks `extractFileText` to `isPlaceholder:false` and mocks `emptyDocumentContent` to an unrelated
`[placeholder: …]` string, so both halves are stubbed on either side of the real seam.

Note the design intent this defeats, quoted from the code: the placeholder exists because a
placeholder chunk reaching the answer prompt caused wrong "I don't know" answers (the `< 50 chars`
sufficiency shortcut fired without an LLM call, then a second retrieval pass injected the
"say so if the evidence doesn't contain the answer" note). Because the real marker never matches, for
a scanned PDF on the `[Binary document: …]` branch that bug is still live; and the string it stores
reads like a *fact about the file* ("457807 bytes"), which a synthesiser can paraphrase to the user
as content.

Measured on the real uploaded-shape path (`/tmp/a2/marker.ts`):

```
{"file":"commons-scan-saylah.pdf","extractFlagIsPlaceholder":true,"markerKindStored":"BINARY",
 "storedChars":96,"isPlaceholderChunkStoredContent":false,
 "storedSample":"[Binary document: a2-internet-scanned-image-only.pdf, 457807 bytes. Parsed content placeholder.]"}
```

Why this matters even though the marker is short: the documented reason `isPlaceholderChunk` exists
(comment above it and the `rag-chunking.test.ts` block at line 140) is that a placeholder reaching
the answer prompt produced wrong "I don't know" answers, because the `< 50 chars` sufficiency
shortcut fired *without an LLM call* and then a second retrieval pass injected the
"say so if the evidence doesn't contain the answer" note. The fix was to match on the **marker**, not
on length — but the binary marker never matches, so for a scanned PDF that hits this branch the
original bug is still live, and the `[Binary document: …]` line additionally *looks like a factual
statement about the file* ("457807 bytes") which the model may paraphrase to the user. The one test
that claims "builder and detector agree (no marker drift)" only compares
`emptyDocumentContent()` with the detector; it never feeds the other two producers' strings through
it, and `documents/route.test.ts` mocks `extractFileText` with `isPlaceholder:false` and mocks
`emptyDocumentContent` to an unrelated `[placeholder: …]` string.
Reproducible: yes, trivially.

### F3 — PROVEN, MEDIUM: a real OCR'd scan is ingested as CID garbage, not as empty or as its text

`fr-1936-scan.pdf` (govinfo's 1936 Federal Register) **has a text layer**: `pypdf` extracts
**125,063 chars** of legible OCR including `FEDERAL REGISTER`, `ENLARGING CAPE ROMAIN MIGRATORY BIRD
REFUGE`, `SOUTH CAROLINA`, `Migratory Bird Conservation Act (45 Stat. 1222)`, `Bull Island`.

The product parser returns **3,300 chars** and **none** of those phrases:

```
product parser chars: 3300
  contains "Cape Romain": false   contains "CAPE ROMAIN": false
  contains "Migratory Bird": false  contains "Bull Island": false
  contains "45 Stat": false
--- first 300 --- "\u0002\u0001\u0002\u0001\u0002\u0003\u0004\u0005…"
```

So retrieval over this document can only return glyph codes. The mechanism is now pinned down: the
16-page scan carries an OCR text layer whose fonts are **subset TrueType fonts with a custom
`/Differences` glyph-name array**, e.g. page 0

```
/TT1 /TrueType /TimesNewRomanPSMT Encoding= {'/BaseEncoding': '/WinAnsiEncoding',
     '/Differences': [1, '/space', '/V', '/O', ...]}  ToUnicode: absent
```

and `document-parsers.ts` contains **no** font/encoding handling at all — a grep for
`ToUnicode|Differences|Encoding|BaseFont|CMap` over that file returns nothing. Single-byte glyph codes
are therefore decoded as if they were ASCII, which is why the text becomes `\u0002\u0001\u0002…`.
A renderer-aware extractor (or a `ToUnicode` CMap lookup) recovers the real text; `pypdf` does.

The honesty rule from mission step 5 is technically satisfied (no invented content can be made from
`\u0002\u0001`), but the document is **silently unusable** rather than marked empty:
`isPlaceholderChunk()` is false again, and there is no `cognifyError`-style signal that extraction
failed to decode the font. This is the "lossy, but not detected as lossy" case — distinct from both
the pass in F5 and the noise in F1. Note the contrast with F1: F1 is noise that *looks* like text and
can be retrieved; F3 is unusable text that *looks* fine to every downstream gate.
Reproducible: yes (same bytes → same 3,300 chars). This document was downloaded from a government
site specifically because it is a scan; the fact that govinfo supplied an OCR layer makes it a *better*
test, not a worse one — a failure to consume an available text layer is a real ingest defect.

### F4 — PROVEN, MEDIUM: a `.pdf` that is not a PDF is accepted as knowledge (silent acceptance)

Mission step 6. The parser is correct — it returns `''` for all three specimens (80-byte plain text,
900-byte truncated PDF, Cloudflare HTML) — but the **route-level fallback** in `extractFileText`
(`rag-chunking.ts:325-330`) then runs on the *same bytes*:

```ts
const raw = await file.text()
const printable = (sample.match(/[\p{L}\p{N}\p{P}\s]/gu) ?? []).length
if (ratio > 0.85) return { text: raw, isPlaceholder: false }
```

and all three are ~96-100 % printable, so each is returned as **ordinary text with
`isPlaceholder:false`**:

```
{"file":"malformed-plaintext-as.pdf","extractFlagIsPlaceholder":false,"markerKindStored":"REAL_TEXT",
 "storedChars":80,"storedSample":"This file claims to be a PDF but is plain text. The secret word is BANANA-7731."}
{"file":"malformed-truncated.pdf","extractFlagIsPlaceholder":false,"markerKindStored":"REAL_TEXT",
 "storedChars":898,"storedSample":"%PDF-1.5\r%????\r\n8345 0 obj\n<</AF[8347 0 R]/Metadata 8346 0 R…"}
{"file":"w3c-dummy.pdf","extractFlagIsPlaceholder":false,"markerKindStored":"REAL_TEXT",
 "storedChars":5791,"storedSample":"<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment…"}
```

Consequences: the truncated PDF would serve its own object dictionary as "knowledge"; the HTML error
page would too; and the plain-text specimen would make the bot answer `BANANA-7731` — an answer with
`HTTP 200` that is *correct about the bytes and wrong about the document*, because no validation ever
established that a `.pdf` is a PDF. `detectDocType` (rag-chunking.ts:275) is a **filename suffix
check only** — `detectDocType('x.pdf') === 'pdf'` regardless of content, and nothing sniffs `%PDF-`.
Severity is MEDIUM rather than HIGH only because the parser itself is clean; the issue is the
fallback's scope: it is meant to salvage *text* formats mislabelled as binary, and it does not
distinguish "PDF that failed to parse" from "text that was labelled `.pdf`".
Reproducible: yes — three independent specimens, same route.

### F5 — PROVEN GOOD: the designed positive path works (report it, do not only list failures)

`commons-scan-saylah.pdf` (also image-only, also `/DCTDecode`) produced the intended result:

```
commons-scan-saylah.pdf: parserChars=0 -> storedContentChars=52 chunks=1
   isPlaceholderChunk(stored chunk0)=true
   chunk0 sample="[Empty document: a2-internet-scanned-image-only.pdf]"
```

No noise, one chunk, marker matched, excluded from evidence. **The difference between F5 and F1 is
only whether the JPEG happens to contain one `]TJ` byte sequence** — which is precisely why F1 needs
a filter/`/Subtype`-based rule rather than an opportunistic regex. Text PDFs also extracted
correctly in this pass: arXiv 40,956 chars (`1Introduction Recurrentneuralnetworks…`, real content),
W-9 28,731 chars (`Form W-9 (Rev. March 2024)…`), RFC 9110 148,539 chars.

### F6 — PROVEN, HIGH: the PDF parser is quadratic/branching on ordinary content, and it runs synchronously in the request handler

While profiling the ingestion path I measured `extractFileText(rfc-9110.pdf)` at **241,150 ms** to
extract 146 KB of text. Parse cost scales violently with file size (same file, truncated to a prefix):

| input size | parser ms | extracted chars |
|---|---|---|
| 143 KB (5 %) | 11 | 2,209 |
| 286 KB (10 %) | 1,502 | 11,372 |
| 572 KB (20 %) | 25,793 | 26,928 |
| 2,858 KB (100 %) | **241,150** | 148,469 |

Attribution (measured, not guessed). I first hypothesised ReDoS in the literal-`Tj` regex and **disproved
it** — naive adversarial inputs (`'('.repeat(n)`, long `(` runs) returned in 0–1 ms, so that hypothesis
was wrong. Instrumenting the three regexes separately per stream over a 572 KB prefix gave:

```
{"streams": 884, "tLit": 2, "tArr": 24983, "tHex": 0, "worstLit": 1}
```

i.e. **24,983 of 25,423 ms is the TJ-array regex alone**, `document-parsers.ts:60`:

```js
const arrays = [...decoded.matchAll(/\[((?:\([^()]*\)\s*|-?\d+\s*)+)\]\s*TJ/g)]
```

inflate is 24 ms total. The pattern's alternative `\([^()]*\)\s*|-?\d+\s*` is repeated inside `(...)+`
with `\]` *after* the group and no possessive/bounded form, so an unmatched `[` forces backtracking over
every partition of the following run; the real PDFs are full of legitimate-looking arrays
(`[(A)24(p)20(p)20(en)-12(d)…`, `[([)-36(R)32(F)…`) that never close with `] TJ` in the scanned window.
Cost is ~1.2–1.6 s **per unmatched bracket**: a 127-byte input
(`'[' + '(a)24'.repeat(25) + ' '`) takes **1,172 ms**, and arrays of 1k/2k/4k/8k groups in an
unterminated array all cost ~1.5–1.7 s each (flat, because the exponential is bounded by the run
length after the bracket). This is a ReDoS-class pattern on attacker-supplied bytes.

**Causal control** (same code, only the regex swapped — no product file edited):

```
product RE_ARR : {"ms":26124,"chars":145212}    // /\[((?:\([^()]*\)\s*|-?\d+\s*)+)\]\s*TJ/g
control  RE_ARR: {"ms":13,"chars":259618}       // /\[([^\[\]]{0,4000})\]\s*TJ/g
```

**26,124 ms → 13 ms (≈2,000×)**, and the control *found more text* (259,618 vs 145,212 chars), so this
is not a speed/quality trade — the product pattern is both catastrophically slow and lossier. Note the
control reclaims the `[([)-36(R)32(F)…]`-style arrays the strict pattern rejects, which matters for
F3-adjacent text recovery.

Why the *run* was affected: `extractFileText` is called **synchronously inside `POST /api/documents`**,
before anything is stored. A 2.9 MB standards PDF therefore occupies the single Node event loop for
~4 minutes, and a 50 MB upload (the route's `MAX_BYTES`) for far longer — during which the whole
app, for every tenant, stops answering. This is a plausible contributor to F7 (the 38-minute
environment-wide wedge) and, independently of F7, it means "upload this public PDF" is a
single-request denial of service. I could not attribute F7 to it conclusively (see Not verified 7),
but the two facts sit together: the wedge followed a period of document ingestion, and my own
`extractFileText` call on a 2.9 MB file blocked a full core for four minutes.
Reproducible: yes, deterministically, with the exact command in `/tmp/a2/prof.ts`, `/tmp/a2/redos2.ts`,
`/tmp/a2/causal.ts`. Suggested fix direction (not applied): bound the inner repetitions, or scan for
`] TJ` with an index walk instead of a backtracking pattern.

### F7 — OBSERVED, MEDIUM (environment): the shared dev server wedges, and it did so twice during this run

For the record, since it invalidated half the mission: `next-server` pid 2343929 (port 3000, v16.3.8)
went `R` + ~100 % CPU with **no HTTP response** from **14:52:43 UTC** onward; its accept queue grew
59 → 133 → 180 → 339 → **512/511 (full)**; `dev.log` and `/tmp/agentsvc/app.log` froze at that
timestamp; 20 Postgres connections sat `idle` (so it was not blocked on the DB). Nine agents share
this instance, so I neither restarted it nor killed it.

**The server was then restarted by someone else at 15:31:29 UTC** (new pid 2387114, `dev.log`
truncated to 90 fresh lines). It served traffic for about **25 seconds** — including my supervisor's
`GET /api/health 200` at 15:31:56 and another agent's document uploads — and then **wedged again in
the same way**: from 15:31:56 to the end of my window (15:39+) every request, including
`GET /api/health`, returned nothing (`000`), the accept queue refilled (140 → 160 …), and `dev.log`
stopped growing after its last `GET /api/health 200`.

The last thing logged before *both* freezes was the same signal: a burst of
`{"level":"warn","msg":"entity-relation extraction failed", …}` with `Unterminated string in JSON` /
`Expected ',' or '}' …`, plus `[llm] kg-extract: provider returned an EMPTY completion after 4
attempts`. That is `indexChunkKnowledgeGraph` → `extractEntitiesRelations` failing to parse the
extraction model's output while a fire-and-forget task per chunk is in flight. It is a **correlation
observed twice, not a proven cause**: I did not capture a stack or a post-mortem, and there is a
second, independently demonstrated way to consume the same single event loop for minutes (F6, whose
~4-minute synchronous parse is itself sufficient to explain an app that stops answering). Both
mechanisms are real and both are reachable from an ordinary document upload; they are listed
separately because I can prove F6's cost and can only *associate* the freezes with the KG errors.

Whatever the cause, this is reported as an environment fact for the run owner: an 8-agent run against
one dev server has no isolation between one agent's workload and every other agent's evidence, and my
mission produced **no HTTP artifact at all** because of it. The three `POST /api/documents 201`
entries that appear in the fresh log are another agent's `.md` files (`d2-01…`, `d2-05…`, visible in
the database at 15:31:46) — **not mine** — so they do not make any of my rows verifiable.

### F8 — NOTE: the suggested W3C PDF URL serves an HTML interstitial with HTTP 403

`https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` →
`http=403 bytes=5791 ctype=text/html`. `curl -o` writes the HTML to the `.pdf` path, so a mission that
"verifies each downloads and is a real PDF with `file`" catches it (it did) — but any harness that
checks only HTTP status or file existence would ingest a Cloudflare page as a PDF. Recorded as an
environmental trap for the next run, not as a product finding (it is the same class as F4's
specimen).

---

## Not verified

1. **Every HTTP ingestion outcome.** `chunkCount`, `embeddedChunkCount`, `status`, `cognifyStatus`,
   the 201 response body, and whether the embedded placeholder is excluded from retrieval — none were
   observable, because `POST /api/documents` never reached the app. The ingestion table above is
   explicitly marked as prediction, derived from the product's own extraction code, and must not be
   read as a server result.
2. **All retrieval verdicts** (mission steps 4 and 5): no answer was produced for any document. The
   10 grounded questions are ready in `questions.json`; the honesty check for the image-only PDF
   (`scan-q1`) and the `BANANA-7731` check (`mal-q1`) were never executed end to end.
3. **Whether F1's noise actually ranks as a citation for the scanned document.** I proved the noise is
   stored as non-placeholder content (7 chunks, above 50 chars), so it is *eligible*; whether hybrid
   retrieval surfaces it for a question about that document is unverified without HTTP.
4. **What the API returns for the malformed uploads** (status + exact error text). Ironically the
   predicted answer is "201 Created", since `extractFileText` flags them non-placeholder — but that
   is a prediction, and the mission asked for the recorded response.
5. **The claim that the F1 bug affects other image formats.** `/DCTDecode` is proven; `/JPXDecode`,
   `/CCITTFaxDecode`, JBIG2 and inline images were not tested.
6. **`pypdf`'s extraction as a correctness oracle.** It is the reference used to establish that both
   Commons files are image-only and that the Federal Register has real text; pypdf disagrees with the
   product parser in F3, and pypdf is not part of the product.
7. **Whether F7 (the wedge) is a product defect, and its cause.** Causal evidence was not captured (no
   stack, no post-mortem; the process was left untouched on purpose, and the restart was done by
   someone else, not by me). Two plausible mechanisms are named and one of them (F6's synchronous
   multi-minute parse) is independently proven to be reachable from an ordinary upload, but the
   *actual* trigger of either freeze is unproven. Note also that the second freeze happened within
   25 s of a restart, which is faster than a single large parse would suggest; something else may be
   involved (for example the KG-extraction task burst, or an unrelated agent's workload) — this is
   explicitly a hypothesis, not a finding.
8. **Whether my uploads would have succeeded on a healthy server.** They were never processed. The
   scripts are ready and idempotent, but the ingestion table and any retrieval verdict remain owed.

---

## Artifacts in this directory

| file | what it is |
|---|---|
| `upload-log.jsonl` | **empty** — no upload completed (F7); confirmed against Postgres: 0 rows named `a2-internet-*` |
| `questions.json` | 10 grounded questions with expected values and exact source quotes |
| `05-parser-groundtruth.ts` + `/tmp/a2/parser-gt.json` | product parser run on each downloaded file |
| `10-upload.ts`, `20-ask.ts`, `30-verify.ts` | the patient/resumable upload, ask and evidence scripts, ready to run |
| `answers.json`, `docs-snapshot.json`, `ingestion-evidence.json` | **not produced** |
| `*.extract.txt` | `pypdf` reference text for each PDF |
| `filefacts.txt`, `pdf-sha256.txt` | `file(1)` output and hashes |
| `00-probe.ts`, `01-list.ts`, `extract.py` | helpers |
| `/tmp/a2/why-santoro.ts`, `/tmp/a2/count.py`, `/tmp/a2/chain.ts`, `/tmp/a2/marker.ts`, `/tmp/a2/fr.ts`, `/tmp/a2/eft.txt`, `/tmp/a2/prof.ts`, `/tmp/a2/redos2.ts`, `/tmp/a2/causal.ts`, `/tmp/a2/scale.ts` | the F1/F2/F3/F5/F6 proofs; also summarized inline above |
| `/tmp/a2/supervise.sh` | health-watcher that auto-runs the upload batch on the first `200` (re-armed after the 15:31:56 recovery) |

No product file was edited; no guard was edited. No git command was run. The test suite and the build
were not run (the dev server wedged before my first attempt and again during it; running either would
have added load to a shared resource I do not own). The only state I changed in the product is the
per-org Knowledge-storage choice (`PUT /api/vector-store {provider:'INTERNAL'}`), which the upload
route requires before it will accept any document.
