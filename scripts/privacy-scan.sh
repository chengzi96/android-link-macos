#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$ROOT" <<'PY'
import re, sys
from pathlib import Path
root=Path(sys.argv[1])
email=re.compile(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',re.I)
home=re.compile(r'/Users/[A-Za-z0-9._-]+')
credential=re.compile(r'''(?i)(password|passwd|api[_-]?key|authorization|bearer)\s*[:=]\s*["']([^"']{8,})["']''')
problems=[]
for p in root.rglob('*'):
    if not p.is_file(): continue
    if any(part in {'.git','dist','build'} for part in p.parts): continue
    if p.name=='privacy-scan.sh': continue
    try: text=p.read_text(encoding='utf-8')
    except Exception: continue
    if m:=home.search(text): problems.append((p,'absolute home path',m.group(0)))
    for m in email.finditer(text):
        v=m.group(0).lower()
        if v.endswith('@example.test') or v.endswith('@users.noreply.github.com'): continue
        problems.append((p,'email-like value',m.group(0)))
    if m:=credential.search(text): problems.append((p,'possible embedded credential',m.group(0)[:80]))
if problems:
    for p,kind,value in problems: print(f'[privacy-scan] {kind}: {p}: {value}',file=sys.stderr)
    raise SystemExit(1)
print('[privacy-scan] OK')
PY
