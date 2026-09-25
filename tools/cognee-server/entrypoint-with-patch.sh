#!/bin/bash
# Wrapper entrypoint for the pinned cognee sidecar.
#
# Applies tools/cognee-server/patch-fence-strip.sh, then hands off to the image's own
# /app/entrypoint.sh unchanged. Doing it this way rather than rebuilding the image keeps the
# patch visible and easy to delete once upstream fixes the regex — see that script for the
# full account of why it exists and how to tell when it is no longer needed.
#
# FAIL-OPEN BY DESIGN. If the patch cannot be applied, the server still starts: a sidecar
# that refuses to boot is a total memory outage, while an unpatched sidecar is the
# behaviour this deployment had before the patch (slower writes, some rejected
# extractions). The failure is echoed loudly so it cannot pass unnoticed.
set -u

PATCH=/opt/cognee-patch/patch-fence-strip.sh

if [ -f "$PATCH" ]; then
  if bash "$PATCH"; then
    echo "[entrypoint] fence patch applied"
  else
    echo "[entrypoint] WARNING: fence patch FAILED (exit $?). Server will start UNPATCHED — expect" >&2
    echo "[entrypoint]          slower writes on new datasets and intermittent rejected" >&2
    echo "[entrypoint]          extractions. The patch does NOT survive an image upgrade." >&2
  fi
else
  echo "[entrypoint] WARNING: $PATCH not found — starting unpatched." >&2
fi

exec /app/entrypoint.sh "$@"
