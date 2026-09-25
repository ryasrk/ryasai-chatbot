#!/usr/bin/env bash
# Patch cognee's markdown-fence handling inside the running sidecar.
#
# WHY THIS EXISTS
#
# cognee's own `_strip_json_fence` (native_adapter.py) removes a wrapping markdown
# fence — but its regex is anchored to the WHOLE response:
#
#     \A\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*\Z
#
# So it only fires when the fence is the entire message. A model that writes a sentence
# before or after the block — which is the common case, and what this deployment's
# endpoint actually does — falls through, pydantic sees a backtick, and the extraction is
# rejected. MEASURED against this deployment's sidecar: 24 such rejections in one
# container's log, of the shapes
#
#     '```json\n{\n  "nodes": [...all values to strings'
#     'Fixed the field names (```json\n{\n ... \n```'
#
# Each costs a retry ("litellm_native validation retry 1/3", "Retrying … in 16.5
# seconds") and one write against a FRESH dataset measured 228 seconds.
#
# Note the model is not at fault: this endpoint DOES emit clean JSON when asked for
# `response_format: {"type": "json_object"}` (verified directly, returns `{"a":1}` with no
# fence). It is only the `json_schema` path that comes back fenced — and the upstream
# fence-stripper that exists for exactly this case cannot see the fence.
#
# WHAT IT DOES
#
# Replaces the anchored regex with an unanchored one, so a fence is found anywhere in the
# response. Semantics are otherwise identical: if no fence is present, the text is returned
# unchanged, so a model that already returns clean JSON is unaffected.
#
# THIS IS A PATCH TO A VENDORED IMAGE, NOT A FIX WE CONTROL.
#
# It is applied at container start, so it does not persist in the image and is visible
# here rather than hiding in a Dockerfile layer. It should be removed the moment upstream
# widens the regex (check with `python3 -c` below, or by grepping for CLO-596, the ticket
# the existing helper references). Until then the alternative is a known 24-in-one-log
# failure rate that surfaces to the user as "memory sometimes forgets".
#
# Usage (inside the cognee container, as root):
#   /patch-fence-strip.sh          # apply
#   /patch-fence-strip.sh --check   # report whether it is applied
set -euo pipefail

# BOTH copies must be patched, and this is not defensive tidiness: the image ships the
# package twice (`/app/cognee` and `/app/.venv/lib/python3.12/site-packages/cognee`), and
# which one a process imports depends on how it was started. Patching one and testing the
# other is how a fix looks applied and behaves unpatched.
ADAPTERS=(
  /app/cognee/infrastructure/llm/structured_output_framework/litellm_native/native_adapter.py
  /app/.venv/lib/python3.12/site-packages/cognee/infrastructure/llm/structured_output_framework/litellm_native/native_adapter.py
)

PRESENT=()
for a in "${ADAPTERS[@]}"; do [ -f "$a" ] && PRESENT+=("$a"); done
if [ ${#PRESENT[@]} -eq 0 ]; then
  echo "[patch-fence] no adapter found at any known path — cognee layout changed; update this script." >&2
  exit 2
fi

ALL_APPLIED=1
for a in "${PRESENT[@]}"; do
  grep -q 'UNANCHORED-BEGIN' "$a" || ALL_APPLIED=0
done
if [ "${1:-}" = "--check" ]; then
  [ "$ALL_APPLIED" = 1 ] && { echo "[patch-fence] applied (${#PRESENT[@]} copies)"; exit 0; }
  echo "[patch-fence] NOT applied"; exit 1
fi
[ "$ALL_APPLIED" = 1 ] && { echo "[patch-fence] already applied"; exit 0; }

for ADAPTER in "${PRESENT[@]}"; do
python3 - "$ADAPTER" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# The upstream pattern, matched by its distinctive anchors rather than by exact text so a
# whitespace or comment change upstream does not silently skip the patch.
# Match by LINE, not by a regex over the whole expression: the literal contains `\A`,
# `\s*` and a triple-backtick run, and any pattern trying to describe it precisely is
# fragile in exactly the way that would leave the patch silently unapplied. One line, one
# assignment, replaced wholesale.
old_literal = None
for line in src.splitlines():
    if line.startswith('_JSON_FENCE_RE = re.compile('):
        old_literal = line
        break
if old_literal is None:
    print("[patch-fence] could not find the _JSON_FENCE_RE assignment — upstream changed; inspect before patching", file=sys.stderr)
    sys.exit(3)
if '\\A' not in old_literal:
    print(f"[patch-fence] the pattern no longer looks anchored ({old_literal!r}); upstream may have fixed this — refusing to patch", file=sys.stderr)
    sys.exit(3)

new_literal = (
    '_JSON_FENCE_RE = re.compile(r"```(?:json)?\\s*\\n?(.*?)\\n?\\s*```", re.DOTALL)'
    '  # UNANCHORED-BEGIN: find a fence ANYWHERE, not only when it wraps the whole reply.'
    ' Upstream anchors to \\A...\\Z, so a model that writes a sentence before or after the'
    ' block is not stripped and the extraction is rejected. See patch-fence-strip.sh.'
)

src = src.replace(old_literal, new_literal, 1)

# The widened pattern is useless while the CALL still anchors to the start of the string:
# `_JSON_FENCE_RE.match(text)` only looks at position 0, so prose BEFORE the fence is never
# seen. MEASURED on this deployment's own rejections, where the model wrote
# "Fixed the field names (" and then the block. `.search()` finds the fence anywhere, which
# is the whole point of removing the anchors.
if '_JSON_FENCE_RE.search(text)' not in src:
    if '_JSON_FENCE_RE.match(text)' not in src:
        print("[patch-fence] neither .match() nor .search() call found — upstream changed; inspect", file=sys.stderr)
        sys.exit(4)
    src = src.replace('_JSON_FENCE_RE.match(text)', '_JSON_FENCE_RE.search(text)', 1)

# Guard: the helper must still return the ORIGINAL text when there is no fence, otherwise a
# clean-JSON model would start returning "None".
if 'return match.group(1) if match else text' not in src:
    print("[patch-fence] expected _strip_json_fence body changed — refusing to patch", file=sys.stderr)
    sys.exit(5)

open(path, "w", encoding="utf-8").write(src)
print("[patch-fence] regex widened; fences are now found anywhere in the response")
PY

# Compile-check the result. A syntax error here would take the whole memory backend down,
# which is a far worse outcome than the fences we are fixing.
python3 -c "import ast,sys; ast.parse(open('$ADAPTER', encoding='utf-8').read())" \
  || { echo "[patch-fence] patched file does not parse: $ADAPTER" >&2; exit 6; }

# Behavioural check, not just a syntax check: exercise the four shapes on the file we just
# wrote. MEASURED before the fix: only the "fence wraps everything" case passed; prose before
# or after the block — the shapes this deployment actually produces — fell through.
python3 - "$ADAPTER" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("patched_adapter", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
cases = {
    "fence wraps all":      '```json\n{"a":1}\n```',
    "prose after fence":    '```json\n{"a":1}\n```\nHope this helps!',
    "prose before fence":   'Here you go:\n```json\n{"a":1}\n```',
    "clean json (no fence)": '{"a":1}',
}
bad = [k for k, v in cases.items() if not mod._strip_json_fence(v).startswith("{")]
if bad:
    print(f"[patch-fence] behaviour check failed for {bad} in {sys.argv[1]}", file=sys.stderr)
    sys.exit(7)
print(f"[patch-fence] behaviour verified: {len(cases)}/{len(cases)} shapes")
PYEOF

echo "[patch-fence] applied to $ADAPTER"
done
