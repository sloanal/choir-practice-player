#!/usr/bin/env python3
"""Decode all exported audio, validate duration, and write SHA-256 checksums."""
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent / 'recordings' / 'Fall’26 Section Parts for LCC'
FFMPEG = '/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/ffmpeg-darwin-arm64'
FFPROBE = '/Applications/Descript.app/Contents/Resources/app.asar.unpacked/node_modules/beamcoder/build/Release/ffprobe'
tracks = json.loads((ROOT / 'capture-manifest.json').read_text())

def verify(track):
    assert track['status'] == 'complete' and track.get('method'), 'Export is incomplete'
    relative = track.get('outputPath', str(Path(track['path']).with_suffix('.m4a')))
    path = ROOT / relative
    assert path.resolve().is_relative_to(ROOT.resolve())
    metadata = json.loads(subprocess.check_output([
        FFPROBE, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)
    ], timeout=30))
    assert len(metadata['streams']) == 1 and metadata['streams'][0]['codec_type'] == 'audio', 'Unexpected media streams'
    audio = metadata['streams'][0]
    duration = float(audio.get('duration', metadata['format']['duration']))
    delta = duration - track['sourceDuration']
    assert abs(delta) < 0.15, f'Duration mismatch: {delta}s'
    result = subprocess.run([
        FFMPEG, '-hide_banner', '-nostdin', '-nostats', '-xerror', '-err_detect', 'explode',
        '-threads', '1', '-i', str(path), '-map', '0:a:0', '-filter_threads', '1',
        '-af', 'astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples+Number_of_NaNs+Number_of_Infs',
        '-f', 'null', '-'
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=180)
    assert result.returncode == 0, result.stderr[-1500:]
    def metric(name):
        matches = re.findall(re.escape(name) + r':\s*([^\s]+)', result.stderr)
        assert matches, f'Missing metric {name}'
        return float(matches[-1])
    peak = metric('Peak level dB')
    rms = metric('RMS level dB')
    assert math.isfinite(peak) and peak > -80 and math.isfinite(rms), 'Silent or invalid audio'
    assert metric('Number of NaNs') == 0 and metric('Number of Infs') == 0, 'Invalid decoded samples'
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024*1024):
            digest.update(chunk)
    return {
        'path': relative, 'sourcePath': track['path'], 'duration': duration,
        'sourceDuration': track['sourceDuration'], 'durationDifference': delta,
        'bytes': path.stat().st_size, 'sha256': digest.hexdigest(),
        'codec': audio['codec_name'], 'sampleRate': int(audio['sample_rate']),
        'channels': audio['channels'], 'peakDB': peak, 'rmsDB': rms,
        'decodedSamples': int(metric('Number of samples')),
    }

results, failures = [], []
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(verify, t): t for t in tracks}
    for future in concurrent.futures.as_completed(futures):
        try:
            results.append(future.result())
            if len(results) % 10 == 0:
                print(f'Verified {len(results)}/{len(tracks)}', flush=True)
        except Exception as error:
            failures.append({'path': futures[future]['path'], 'error': str(error)})
results.sort(key=lambda t: t['path'])
expected = {str(Path(t['path']).with_suffix('.m4a')) for t in tracks}
actual = {str(p.relative_to(ROOT)) for p in ROOT.rglob('*.m4a')}
if actual != expected:
    failures.append({'fileSetMismatch': {'missing': sorted(expected-actual), 'extra': sorted(actual-expected)}})
report = {
    'verifiedAt': datetime.now(timezone.utc).isoformat(), 'expected': len(tracks),
    'verified': len(results), 'totalBytes': sum(t['bytes'] for t in results),
    'totalSeconds': sum(t['duration'] for t in results),
    'maximumDurationDifference': max((abs(t['durationDifference']) for t in results), default=0),
    'failures': failures, 'files': results,
}
(ROOT / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k != 'files'}, ensure_ascii=False), flush=True)
raise SystemExit(1 if failures else 0)
