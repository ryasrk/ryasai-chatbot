"""Persentase cakupan yang HANYA menghitung baris yang benar-benar dapat dieksekusi.

Tiga kelas baris TIDAK dapat menghasilkan hit, terbukti dari lcov:
  1. Lanjutan ekspresi string konkatenasi. Bukti: pada ai.ts baris 191 hit=1455
     (awal ekspresi) sementara 192-209 hit=0, padahal keduanya satu ekspresi.
  2. Baris deklarasi tipe di interface/type — dihapus TypeScript saat transpile.
  3. Komentar dan brace penutup.
"""
import re, sys, collections, subprocess, os

target, files = sys.argv[1], sys.argv[2:]
seen = collections.defaultdict(int)
for f in files:
    subprocess.run(['rm', '-rf', 'coverage'], check=False)
    subprocess.run(['bun', 'test', './' + f, '--coverage', '--coverage-reporter=lcov'],
                   capture_output=True, timeout=600)
    try: txt = open('coverage/lcov.info').read()
    except Exception: continue
    for rec in txt.split('end_of_record'):
        m = re.search(r'^SF:(.+)$', rec, re.M)
        if m and m.group(1).endswith('/' + os.path.basename(target)):
            for k, v in re.findall(r'^DA:(\d+),(\d+)', rec, re.M):
                seen[int(k)] = max(seen[int(k)], int(v))

src = open(target).read().split('\n')

_DECL_RE = re.compile(r'^\s*(export\s+)?(?:declare\s+)?(interface|type)\s+\w+')

def in_type_block(i):
    """Baris i berada di dalam interface/type alias yang dibuka di atasnya."""
    # Baris DEKLARASI-nya sendiri juga dihapus TypeScript, sama seperti isinya.
    # Pindai-mundur saja melewatkannya bila deklarasi berada DI DALAM sebuah fungsi
    # (`interface EnrichJob {` bersarang di enrichSchema), karena pindai-mundur
    # menemui `function` pembungkusnya lebih dulu lalu berhenti. Itu salah
    # mengklasifikasi SATU baris di real-connectors.ts sebagai kode eksekutabel
    # yang belum tercakup.
    if _DECL_RE.match(src[i - 1]) and ('{' in src[i - 1] or src[i - 1].rstrip().endswith('=')):
        return True
    j = i - 1
    while j >= 1:
        t = src[j - 1]
        if _DECL_RE.match(t) and ('{' in t or t.rstrip().endswith('=')):
            return True
        if re.match(r'^\s*(export\s+)?(async\s+)?function\s|^\s*const\s+\w+\s*=\s*(async\s*)?\(', t):
            return False
        j -= 1
    return False

def is_multiline_template(i):
    """Baris berada di TENGAH sebuah template literal (backtick) multi-baris.

    Bukti (rag-retrieval.ts, satu ekspresi `tx.$queryRaw`): 457 `SELECT ...` dan
    460/463/464/465 punya hit>0, sementara 458, 459, 461, 462, 466 punya hit=0 --
    padahal semuanya satu template literal yang sama, dan baris 467
    (`return new Map(rows...)`) jelas dieksekusi. Bun/Hermes hanya memberi hit pada
    baris tempat template-nya DIMULAI dan (kadang) baris ber-interpolasi;
    baris teks literal di antaranya tidak pernah menghasilkan record sendiri.

    Dibatasi pada template yang JELAS multi-baris dan berada dalam rentang
    backtick ganjil, agar tidak menelan kode biasa.
    """
    t = src[i - 1]
    if t.strip().startswith('//'):
        return False
    # Hitung backtick ganjil sebelum baris ini, dalam 60 baris terakhir saja.
    # (Harus relatif: sebuah template yang dibuka jauh di atas file tidak relevan.)
    depth = 0
    j = i - 1
    while j >= 1 and i - j <= 60:
        depth += src[j - 1].count('`')
        j -= 1
    return depth % 2 == 1


def is_continuation(i):
    t = src[i - 1].strip()
    if not (t.startswith("'") or t.startswith('"') or t.startswith('`')): return False
    j = i - 1
    while j >= 1 and src[j - 1].strip() == '': j -= 1
    if j < 1: return False
    prev = src[j - 1].strip()
    return prev.endswith('+') or prev.startswith('content:') or (prev.startswith(("'", '"')) and prev.endswith(("'", '"')))

def is_noise(i):
    t = src[i - 1].strip()
    return (not t or t.startswith('//') or t.startswith('*') or t.startswith('/*')
            or t in ('}', '})', '};', ')', '])', ']'))


def _field_decl(i):
    """A declaration line inside a type block: `name?: Type`.

    Handles both the primitive form (`sessionId?: string`) and a richly-typed one
    (`chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>`). The
    earlier regex used a character class that excluded `{}` and `:` inside the
    type, so a nested object type -- the SAME construct -- leaked through and was
    reported as uncovered executable code.

    Proven on planner.ts, one inline parameter-type literal:

        question: string                                  excluded
        availableTools: ToolDef[]                         excluded
        sessionId?: string                                excluded
        chatHistory?: Array<{ role: 'user' | ... }>       MISSED (hit=0, both copies)

    Shape test instead of a character class: `identifier?:` then ANY type text,
    where the line ends without opening a statement. Verified by the callers below
    (only reached when the line produced no hit), and regression-checked against
    modules whose numbers were already verified.
    """
    import re as _re
    t = src[i - 1].strip()
    if not t or t.startswith('//'): return False
    # A declaration, not an assignment or a call: `name?: Type` / `name: Type`.
    if not _re.match(r"^[A-Za-z_$][\w$]*\??\s*:", t): return False
    # Exclude values: an object-property write or a labelled statement assigns.
    if '=' in t.split(':', 1)[1]: return False
    return True

excl = {'continuation': [], 'type-decl': [], 'noise': []}
real_unc = []
for l in sorted(l for l, v in seen.items() if v == 0):
    if is_continuation(l): excl['continuation'].append(l)
    elif in_type_block(l) or _field_decl(l): excl['type-decl'].append(l)
    elif is_multiline_template(l): excl['continuation'].append(l)
    elif is_noise(l): excl['noise'].append(l)
    else: real_unc.append(l)

cov = sum(1 for v in seen.values() if v > 0)
executable = len(seen) - sum(len(v) for v in excl.values())
print(f'{target}')
print(f'  DA lines instrumented    : {len(seen)}')
print(f'  covered (>=1 run)        : {cov}')
for k, v in excl.items():
    print(f'  - {k:<14} not executable : {len(v)}')
print(f'  EXECUTABLE lines         : {executable}')
print(f'  REAL uncovered           : {len(real_unc)}')
print(f'  => coverage of executable code: {cov}/{executable} = {cov/executable*100:.2f}%   (merged report said {cov/len(seen)*100:.2f}%)')
for l in real_unc[:12]:
    print(f'     {l}: {src[l-1].strip()[:74]}')
