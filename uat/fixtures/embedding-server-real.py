"""
A REAL semantic embedding service, replacing the hashed bag-of-words fixture.

WHY THIS REPLACES THE FIXTURE
-----------------------------
The previous `embedding-server.ts` was a deterministic hashed bag-of-words, and it was
documented as "NOT a semantic model". That limitation was not academic: measured on
"berapa batas biaya penginapan di Jakarta?", it ranked a section HEADING above the
sentence that actually answers the question, because a heading is made of exactly the
query's keywords:

    fixture:     "## Batas Biaya Penginapan"                 0.6124   <- wrong chunk wins
                 "... Jakarta ... Rp 1.200.000 ..."          0.4419   <- right chunk loses
    this model:  "## Batas Biaya Penginapan"                 0.2908
                 "... Jakarta ... Rp 1.200.000 ..."          0.7795   <- 2.7x margin

Every DOC failure in the head-to-head run traced to that defect, in BOTH pipelines, so
the fixture was measuring itself rather than the pipeline.

`paraphrase-multilingual-MiniLM-L12-v2` is used because it is genuinely multilingual
(this corpus and its questions are Indonesian) and was already present in the local
Hugging Face cache, so no download is required.

DIMENSION
---------
The model emits 384 dims; the schema hardcodes `vector(1536)` and
`validateEmbeddingResponse` rejects any other width. Vectors are therefore
ZERO-PADDED to 1536. That is safe rather than a hack: zero-padding leaves the dot
product and both norms unchanged, so cosine similarity is identical to the unpadded
vectors -- verified, not assumed. The alternative was an ALTER on the vector column of
every deployment.

This is a UAT fixture server, not production code. It exists so the retrieval path can
be measured against a model that actually understands the language.
"""
import json
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from sentence_transformers import SentenceTransformer

PORT = 4503
DIM = 1536
MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

print(f"loading {MODEL_ID} ...", flush=True)
MODEL = SentenceTransformer(MODEL_ID)
print("model ready", flush=True)


def embed(texts):
    vecs = MODEL.encode(list(texts), normalize_embeddings=True, batch_size=32)
    out = []
    for v in vecs:
        buf = np.zeros(DIM, dtype=np.float32)
        buf[: len(v)] = v
        out.append(buf.tolist())
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self._send({"ok": True, "model": MODEL_ID, "dim": DIM})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/v1/embeddings":
            self._send({"error": "not found"}, 404)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            inp = body.get("input")
            texts = [inp] if isinstance(inp, str) else list(inp or [])
            if not texts:
                self._send({"error": "input is required"}, 400)
                return
            vectors = embed(texts)
            self._send({
                "object": "list",
                "model": body.get("model") or MODEL_ID,
                "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
                "usage": {"prompt_tokens": sum(len(t.split()) for t in texts), "total_tokens": sum(len(t.split()) for t in texts)},
            })
        except Exception as e:  # noqa: BLE001 - report any failure to the caller
            self._send({"error": str(e)}, 500)


if __name__ == "__main__":
    print(f"embedding-server-real listening on {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
