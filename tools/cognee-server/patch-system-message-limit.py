#!/usr/bin/env python3
"""Opt-in compatibility for endpoints that discard oversized system messages."""
import ast
import os
from pathlib import Path
import re
import sys

MARKER = '# RYASAI_BOUNDED_SYSTEM_MESSAGES'
HELPER = '''
# RYASAI_BOUNDED_SYSTEM_MESSAGES
def _bounded_system_messages(text):
    limit = int(os.environ.get("COGNEE_SYSTEM_MESSAGE_MAX_CHARS", "0"))
    if limit <= 0 or len(text) <= limit:
        return [{"role": "system", "content": text}]
    return [{"role": "system", "content": text[start:start + limit]}
            for start in range(0, len(text), limit)]

'''


def patch_source(source: str) -> str:
    if MARKER in source:
        if (HELPER.strip() in source
                and '*_bounded_system_messages(system_prompt)' in source
                and '*_bounded_system_messages(augmented_system_prompt)' in source):
            return source
        raise ValueError('existing system-message patch is incomplete')
    if 'import os\n' not in source:
        if 'import json\n' not in source:
            raise ValueError('native adapter import layout changed')
        source = source.replace('import json\n', 'import json\nimport os\n', 1)
    pattern = r'\{"role": "system", "content": (system_prompt|augmented_system_prompt)\}'
    source, count = re.subn(pattern, r'*_bounded_system_messages(\1)', source)
    if count < 2 or '*_bounded_system_messages(augmented_system_prompt)' not in source:
        raise ValueError('native adapter message layout changed')
    tree = ast.parse(source)
    anchor = next((min([node.lineno, *[d.lineno for d in node.decorator_list]])
                   for node in tree.body if isinstance(node, ast.ClassDef)), None)
    if anchor is None:
        raise ValueError('native adapter class missing')
    lines = source.splitlines(keepends=True)
    lines.insert(anchor - 1, HELPER)
    result = ''.join(lines)
    ast.parse(result)
    return result


def main() -> None:
    limit = int(os.environ.get('COGNEE_SYSTEM_MESSAGE_MAX_CHARS', '0'))
    if limit < 0:
        raise ValueError('COGNEE_SYSTEM_MESSAGE_MAX_CHARS must be non-negative')
    if limit == 0:
        print('[patch-system-limit] disabled')
        return
    paths = [Path(arg) for arg in sys.argv[1:]] or [
        Path('/app/cognee/infrastructure/llm/structured_output_framework/litellm_native/native_adapter.py'),
        Path('/app/.venv/lib/python3.12/site-packages/cognee/infrastructure/llm/structured_output_framework/litellm_native/native_adapter.py'),
    ]
    present = [path for path in paths if path.is_file()]
    if not present:
        raise ValueError('native adapter not found')
    # Validate every copy before writing any, so layout drift cannot leave half a patch.
    updates = [(path, patch_source(path.read_text())) for path in present]
    for path, source in updates:
        path.write_text(source)
    print(f'[patch-system-limit] enabled, limit={limit}, copies={len(present)}')


if __name__ == '__main__':
    main()
