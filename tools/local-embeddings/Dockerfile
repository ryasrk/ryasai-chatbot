# Local embedding server, shipped with the production install.
#
# WHY A DOCKERFILE AT ALL: the install cannot assume a working `python3 -m venv`
# with pip on the host — the target VPS has a minimal python3 with NO pip. Baking
# the deps into an image is the only reliable path, and it also pins them.
#
# WHY torch FROM THE CPU INDEX (this is the whole point of the file):
# a plain `pip install sentence-transformers` pulls torch WITH CUDA, which drags
# in the nvidia-* wheels. MEASURED on the lab host: that image was 9.55 GB, larger
# than the entire install it was meant to accompany. Installing torch from
# download.pytorch.org/whl/cpu instead produced 1.99 GB with IDENTICAL output —
# 384 dims, byte-for-byte the same model. There is no GPU in the supported
# deployment, so the CUDA build was pure waste.
FROM python:3.12-slim

WORKDIR /app

# torch FIRST and from the CPU wheel index; a later plain `pip install` would
# otherwise satisfy `sentence-transformers`'s torch dependency from PyPI and
# silently reintroduce the CUDA build.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir sentence-transformers fastapi uvicorn

COPY server.py /app/server.py

# Bound to 0.0.0.0 INSIDE the container only. The default in server.py is
# 127.0.0.1, which a published port cannot reach — MEASURED: that produced
# `curl: (56) Recv failure: Connection reset by peer` with the server logging
# nothing, because the listener was never reachable from the port forward.
# Exposure is controlled by the compose `ports:` mapping, which binds to the
# host's loopback only.
ENV EMBEDDING_HOST=0.0.0.0
ENV EMBEDDING_PORT=8081

EXPOSE 8081

CMD ["python", "server.py"]
