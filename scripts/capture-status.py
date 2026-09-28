#!/usr/bin/env python3
"""Print compact, read-only capture progress."""
import json
from pathlib import Path
from datetime import datetime, timezone

root = Path(__file__).resolve().parent.parent
folder = root / 'recordings' / 'Fall’26 Section Parts for LCC'
entries = json.loads((folder / 'capture-manifest.json').read_text())
stream_log = root / '.capture-cache' / 'stream-export.log'
stream_mode = stream_log.exists()
complete = [t for t in entries if t['status'] == 'complete' and (not stream_mode or t.get('method'))]
lines = (stream_log if stream_mode else root / '.capture-cache' / 'capture.log').read_text().splitlines()
last_start = next((i for i in range(len(lines)-1, -1, -1) if ' START ' in lines[i]), 0)
marker = ' EXPORT ' if stream_mode else ' RECORD '
current = next((line for line in reversed(lines[last_start:]) if marker in line), '')
last = lines[-1]
usage = sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())
elapsed = 0
if current:
    start = datetime.fromisoformat(current.split()[0].replace('Z', '+00:00'))
    elapsed = int((datetime.now(timezone.utc) - start).total_seconds())
print(json.dumps({
    'complete': len(complete), 'total': len(entries),
    'saved_minutes': round(sum(t.get('recordedDuration', 0) for t in complete)/60, 1),
    'disk_MB': round(usage/1e6, 1),
    'current': current.split(marker, 1)[-1],
    'current_elapsed_seconds': elapsed,
    'last_event': last,
}, ensure_ascii=False))
