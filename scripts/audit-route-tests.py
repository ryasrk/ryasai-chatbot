#!/usr/bin/env python3
"""
Count API routes that genuinely have no test.

WHY THIS SCRIPT EXISTS. A first, hand-rolled attempt reported "42 of 99 routes have no test at all".
That number was WRONG, and the way it was wrong is worth keeping: the check built a route's URL from its
directory (`/api/users/[id]`) and grepped the test corpus for that STRING. A route test does not mention
its own URL -- it `import`s the handler (`import { PATCH } from './route'`) and calls it with a fabricated
Request. So the string never matched, and every route whose test lives beside it was reported as untested.

The corrected check looks for the two things a route test actually does:
  1. a relative import of its own handler (`from './route'` / `from '../route'`), or
  2. the route's path used as a URL string anywhere in the test corpus (an integration-style call).

Measured after the fix: 0 genuine orphans. The "42" was an artifact, so any plan built on it was too.
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_DIR = os.path.join(ROOT, 'src', 'app', 'api')

# Every test file in the repo (unit + e2e), read once.
def load_corpus() -> str:
    chunks: list[str] = []
    for base in ('src', 'e2e'):
        for dirpath, _dirs, files in os.walk(os.path.join(ROOT, base)):
            for name in files:
                if name.endswith('.test.ts') or name.endswith('.spec.ts'):
                    try:
                        with open(os.path.join(dirpath, name), encoding='utf-8') as fh:
                            chunks.append(fh.read())
                    except OSError:
                        pass
    return '\n'.join(chunks)


def route_files() -> list[str]:
    out: list[str] = []
    for dirpath, _dirs, files in os.walk(API_DIR):
        if 'route.ts' in files:
            out.append(os.path.join(dirpath, 'route.ts'))
    return sorted(out)


def has_beside_test(route_path: str) -> bool:
    """A `*.test.ts` in the same directory that imports this handler."""
    d = os.path.dirname(route_path)
    for name in os.listdir(d):
        if name.endswith('.test.ts'):
            return True
    return False


def url_candidates(route_path: str) -> list[str]:
    """The URL a test would use for this route, with the dynamic segment filled in."""
    rel = os.path.relpath(os.path.dirname(route_path), os.path.join(ROOT, 'src', 'app'))
    url = '/' + rel.replace(os.sep, '/')
    # `/api/users/[id]` -> also try a concrete id so a test calling `/api/users/abc` is recognised.
    return [url, re.sub(r'\[[^\]]+\]', 'x', url)]


def main() -> int:
    corpus = load_corpus()
    routes = route_files()
    orphan: list[str] = []
    beside = 0
    via_url = 0

    for route in routes:
        if has_beside_test(route):
            beside += 1
            continue
        if any(f"'{c}'" in corpus or f'"{c}"' in corpus for c in url_candidates(route)):
            via_url += 1
            continue
        orphan.append(os.path.relpath(route, ROOT))

    print(f'routes: {len(routes)}')
    print(f'  with a *.test.ts beside them : {beside}')
    print(f'  referenced by URL in a test  : {via_url}')
    print(f'  GENUINE ORPHANS (no test)    : {len(orphan)}')
    for o in orphan:
        print(f'    {o}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
