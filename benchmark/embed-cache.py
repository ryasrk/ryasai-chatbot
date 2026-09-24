#!/usr/bin/env python3
"""
Precompute an offline embedding cache for the cognee retrieval benchmark.

WHY A CACHE
-----------
The retrieval arms in `benchmark/` compare ranking strategies over the same 1200
documents. Embedding against a live endpoint per arm would make the arms
incomparable (each run could hit a different model revision) and would need
network access during the benchmark. This script embeds the corpus once, from the
model snapshot already in the local Hugging Face cache, and writes a deterministic
JSON file the benchmark reads directly.

DIMENSIONS
----------
`paraphrase-multilingual-MiniLM-L12-v2` emits 384 dims. The app's DB column is
fixed at `vector(1536)`, so `uat/fixtures/embedding-server-real.py` zero-pads to
1536. That padding is pointless here: this cache never touches the DB, and
zero-padding changes neither the dot product nor the norms. Raw 384-dim vectors
are stored, and `dimensions: 384` is recorded so the width cannot be mistaken.

Vectors are L2-normalised, so cosine similarity is a plain dot product, and are
rounded to 6 decimals to keep the file size sane (rounding perturbs each norm by
~1e-6, far below the 1e-3 tolerance `embed-cache.test.ts` asserts).

QUERY VECTORS
-------------
`Arm.rank(question, ctx, budget)` receives the question as a STRING, so a vector
arm cannot compute cosine top-k from document vectors alone — and embedding the
question inside `rank()` would put a model call inside the timed region, making
the latency budget meaningless. Question vectors are therefore precomputed here
too, by the SAME model instance (the model is loaded once, not twice).

The questions file is JSONL, one object per line with a `question` string, and the
cache is keyed by the EXACT question text because that is what the harness looks
up. Duplicate texts collapse to one entry by design; the summary reports how many
rows collapsed so a count below the line count is never silent. The two outputs
are independent: the question pass never perturbs the document vectors, which stay
byte-identical across runs.

NO NETWORK: the model loads with `local_files_only=True` under `HF_HUB_OFFLINE=1`
/ `TRANSFORMERS_OFFLINE=1`. A missing snapshot is a hard error — this script never
falls back to a hashed or random embedding.

Usage:
    python3 benchmark/embed-cache.py
    python3 benchmark/embed-cache.py --corpus <path> --out <path>
    python3 benchmark/embed-cache.py --skip-questions
"""
import argparse
import json
import os
import sys
import time

MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
DIMENSIONS = 384
BATCH_SIZE = 32
PROGRESS_EVERY = 200


def load_model():
    """Load the real model from the local cache, or die trying."""
    # Belt and braces: these env vars make any library that still reaches for the
    # network fail rather than download, even if `local_files_only` is dropped.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    from sentence_transformers import SentenceTransformer

    print(f"loading {MODEL_ID} (offline, local cache only) ...", flush=True)
    started = time.time()
    try:
        model = SentenceTransformer(MODEL_ID, local_files_only=True)
    except TypeError:
        # Older sentence-transformers has no `local_files_only` kwarg; the
        # offline env vars above are the equivalent enforcement.
        model = SentenceTransformer(MODEL_ID)
    # `get_sentence_embedding_dimension` is the pre-6.0 name and now warns.
    get_dim = getattr(model, "get_embedding_dimension", None) or \
        model.get_sentence_embedding_dimension
    dim = int(get_dim())
    if dim != DIMENSIONS:
        raise SystemExit(f"FAIL: {MODEL_ID} emits {dim} dims, expected {DIMENSIONS}")
    print(f"model ready in {time.time() - started:.2f}s (dim={dim})", flush=True)
    return model


def embed_texts(model, texts):
    """Unit-norm, 6-dp-rounded vectors for `texts`, batched on the progress interval."""
    vectors = {}
    for start in range(0, len(texts), PROGRESS_EVERY):
        chunk = texts[start:start + PROGRESS_EVERY]
        # normalize_embeddings=True => unit L2 norm => cosine == dot product.
        embs = model.encode(chunk, normalize_embeddings=True,
                            batch_size=BATCH_SIZE, show_progress_bar=False)
        for text, emb in zip(chunk, embs):
            vec = [round(float(x), 6) for x in emb]
            if len(vec) != DIMENSIONS:
                raise SystemExit(f"FAIL: {text[:60]!r} got {len(vec)} dims")
            vectors[text] = vec
        print(f"  embedded {min(start + PROGRESS_EVERY, len(texts))}/{len(texts)}", flush=True)
    return vectors


def write_cache(path, vectors):
    payload = {
        "model": MODEL_NAME,
        "dimensions": DIMENSIONS,
        "count": len(vectors),
        "vectors": vectors,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    return payload


def load_questions(path):
    """Exact question strings from a JSONL file, in order, duplicates preserved."""
    questions = []
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"FAIL: {path}:{lineno} is not valid JSON: {exc}")
            if not isinstance(rec.get("question"), str) or not rec["question"].strip():
                raise SystemExit(f"FAIL: {path}:{lineno} has no usable `question` string")
            questions.append(rec["question"])
    if not questions:
        raise SystemExit(f"FAIL: no questions in {path}")
    return questions


def main():
    ap = argparse.ArgumentParser(description="Embed the benchmark corpus into a JSON cache.")
    ap.add_argument("--corpus", default="benchmark/data/cognee-1000-corpus.json")
    ap.add_argument("--out", default="benchmark/data/cognee-1000-embeddings.json")
    ap.add_argument("--questions", default="benchmark/data/cognee-1000-questions.jsonl")
    ap.add_argument("--out-questions",
                    default="benchmark/data/cognee-1000-question-embeddings.json")
    ap.add_argument("--skip-questions", action="store_true",
                    help="only write the document cache")
    args = ap.parse_args()

    started = time.time()
    with open(args.corpus, encoding="utf-8") as fh:
        corpus = json.load(fh)
    docs = corpus["docs"]
    if not docs:
        raise SystemExit(f"FAIL: no documents in {args.corpus}")
    print(f"corpus: {args.corpus} ({len(docs)} docs)", flush=True)

    # Read the questions UP FRONT so a malformed file fails in milliseconds rather
    # than after a full document embed that then gets thrown away.
    questions = [] if args.skip_questions else load_questions(args.questions)

    # ONE model instance serves both passes.
    model = load_model()

    texts = [d["text"] for d in docs]
    if len(set(texts)) != len(texts):
        # The doc cache is keyed by id, not text, so duplicates are harmless there —
        # but a silently keyed-by-text cache would drop them, so say what happened.
        print(f"  note: {len(texts) - len(set(texts))} documents share text with another "
              f"document (cache is keyed by id, so all {len(docs)} are kept)", flush=True)
    embs = embed_texts(model, texts)
    vectors = {doc["id"]: embs[text] for doc, text in zip(docs, texts)}
    if len(vectors) != len(docs):
        # Duplicate ids would silently drop documents from the cache.
        raise SystemExit(f"FAIL: {len(docs)} docs but {len(vectors)} distinct ids in {args.corpus}")
    payload = write_cache(args.out, vectors)
    print(f"wrote {args.out}: {payload['count']} vectors x {DIMENSIONS} dims "
          f"in {time.time() - started:.1f}s", flush=True)

    if args.skip_questions:
        print("skipping question cache (--skip-questions)", flush=True)
        return 0

    # ---- question vectors, same model instance ----
    q_started = time.time()
    distinct = list(dict.fromkeys(questions))  # preserve file order, drop repeats
    collapsed = len(questions) - len(distinct)
    print(f"questions: {args.questions} ({len(questions)} lines, {len(distinct)} distinct)",
          flush=True)

    q_embs = embed_texts(model, distinct)
    # Keys are the exact question text, so two identical texts cannot produce two
    # entries; assert the map matches the distinct count rather than the line count.
    if len(q_embs) != len(distinct):
        raise SystemExit(f"FAIL: expected {len(distinct)} distinct question vectors, "
                         f"got {len(q_embs)}")
    q_payload = write_cache(args.out_questions, q_embs)
    print(f"wrote {args.out_questions}: {q_payload['count']} vectors x {DIMENSIONS} dims "
          f"in {time.time() - q_started:.1f}s", flush=True)
    print(f"question summary: {len(questions)} lines -> {q_payload['count']} distinct vectors; "
          f"{collapsed} duplicate line(s) collapsed onto an identical question text "
          f"({len(q_payload['vectors'])} == count OK)", flush=True)
    print(f"total elapsed {time.time() - started:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
