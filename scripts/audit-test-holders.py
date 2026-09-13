"""Cari holder test yang default-nya TIDAK PERNAH dipakai, atau yang default-nya
mengembalikan kosong sehingga test yang bergantung padanya tidak menguji apa pun.

Metode: untuk tiap holder `let X`, hitung berapa kali di-SET di test body. Bila nol,
holder itu hanya memakai default — dan default yang kosong adalah risiko.
"""
import re, sys, os, glob
for path in sorted(glob.glob('src/lib/*.test.ts')):
    src = open(path).read().split('\n')
    holders = {}
    for i, line in enumerate(src, 1):
        m = re.match(r'^\s*let (\w+)\s*[:=]', line)
        if m:
            holders[m.group(1)] = i
    for name, decl in holders.items():
        # hitung assignment di luar deklarasi (pola "name = ")
        assigns = [i for i, l in enumerate(src, 1)
                   if i != decl and re.match(rf'^\s*{re.escape(name)}\s*=', l)]
        if not assigns:
            print(f'{path}:{decl}  {name}  -> TIDAK PERNAH di-set ulang (hanya default)')
