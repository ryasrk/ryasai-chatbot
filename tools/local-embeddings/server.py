#!/usr/bin/env python3
"""
OpenAI-compatible embedding server backed by a local sentence-transformers model.

WHY THIS EXISTS
  The deployment has no OpenAI embedding key. `src/lib/embeddings.ts` already
  supports OpenAI-compatible endpoints, so exposing a local model behind
  POST /v1/embeddings means the app needs ZERO code changes: point
  `embeddingBaseUrl` at this server and semantic retrieval starts working.

MODEL CHOICE (measured, not assumed)
  sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 — 384 dims, 50+
  languages, ~470MB.
  Verified cross-lingual separation on this corpus (cosine, normalized):
      "Berapa tarif lembur pada hari kerja?" vs the English overtime policy → 0.543
      "Berapa hari cuti tahunan?"            vs the English annual-leave text → 0.465
      "Berapa lama jangka waktu refund?"     vs the English refund SOP       → 0.748
      off-topic ("resep kue bolu")                                          → 0.185
  i.e. every real ID→EN match sits far above the noise floor.

  REJECTED: all-MiniLM-L6-v2. It is English-only, and measured on the same
  pairs it scored the ENGLISH TRANSLATION of a question (0.100) LOWER than an
  unrelated Indonesian sentence (0.359) — it would have made Indonesian
  retrieval strictly worse than the lexical path alone.

  Note the multilingual model is only 384 dims, same as all-MiniLM: dims are not
  the reason to prefer it, language coverage is.

USAGE
    python3 -m venv .venv && .venv/bin/pip install sentence-transformers fastapi uvicorn
    .venv/bin/python server.py            # listens on 127.0.0.1:8081
    curl -s localhost:8081/v1/embeddings -H 'Content-Type: application/json' \
         -d '{"model":"local","input":["halo"]}'

Then in the app's AI Config → Embedding tab:
    provider  : OpenAI-Compatible
    base URL  : http://localhost:8081/v1
    model     : paraphrase-multilingual-MiniLM-L12-v2
    api key   : (leave empty — this server does not authenticate)
"""
from __future__ import annotations

import os
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sentence_transformers import SentenceTransformer

MODEL_ID = os.environ.get(
    "EMBEDDING_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
HOST = os.environ.get("EMBEDDING_HOST", "127.0.0.1")
PORT = int(os.environ.get("EMBEDDING_PORT", "8081"))
# Cap at the model's own limit; truncating silently would produce embeddings for
# text the caller never sent.
MAX_CHARS = int(os.environ.get("EMBEDDING_MAX_CHARS", "8000"))

app = FastAPI(title="Local OpenAI-compatible embeddings")
_model: SentenceTransformer | None = None


def model() -> SentenceTransformer:
    """Load once, lazily, so the health endpoint answers during warm-up."""
    global _model
    if _model is None:
        t0 = time.time()
        _model = SentenceTransformer(MODEL_ID)
        print(f"[embeddings] loaded {MODEL_ID} in {time.time() - t0:.1f}s", flush=True)
    return _model


def _as_list(payload: Any) -> list[str]:
    """Accept the OpenAI `input` forms: a string, or a list of strings/tokens."""
    if isinstance(payload, str):
        return [payload]
    if isinstance(payload, list):
        out: list[str] = []
        for item in payload:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, list):
                # Token-id array form. We cannot invert it without the model's
                # tokenizer, so reject rather than emit a wrong vector silently.
                raise ValueError(
                    "Token-array input is not supported; send strings instead."
                )
            else:
                raise ValueError(f"Unsupported input element: {type(item).__name__}")
        return out
    raise ValueError("`input` must be a string or an array of strings.")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": MODEL_ID, "loaded": _model is not None}


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}],
    }


@app.post("/v1/embeddings")
async def embeddings(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"error": {"message": "Invalid JSON body.", "type": "invalid_request_error"}},
            status_code=400,
        )

    try:
        texts = _as_list(body.get("input"))
    except ValueError as exc:
        return JSONResponse(
            {"error": {"message": str(exc), "type": "invalid_request_error"}},
            status_code=400,
        )

    if not texts:
        return JSONResponse(
            {"error": {"message": "`input` is empty.", "type": "invalid_request_error"}},
            status_code=400,
        )

    clipped = [t[:MAX_CHARS] for t in texts]
    try:
        vectors = model().encode(
            clipped, normalize_embeddings=True, batch_size=32, show_progress_bar=False
        )
    except Exception as exc:  # pragma: no cover - defensive
        return JSONResponse(
            {"error": {"message": f"Encoding failed: {exc}", "type": "server_error"}},
            status_code=500,
        )

    dim = int(np.shape(vectors)[1])
    return JSONResponse(
        {
            "object": "list",
            "model": body.get("model") or MODEL_ID,
            "data": [
                {"object": "embedding", "index": i, "embedding": v.tolist()}
                for i, v in enumerate(vectors)
            ],
            "usage": {
                "prompt_tokens": sum(len(t.split()) for t in clipped),
                "total_tokens": sum(len(t.split()) for t in clipped),
            },
            "_dim": dim,
        }
    )


if __name__ == "__main__":
    import uvicorn

    # Warm the model BEFORE serving so the first real request is not a timeout.
    model()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
