"""Optional local-only phrase inventory for reviewing ambiguous takes."""
from audio_lab import ROOT, WORK, FFMPEG
from pathlib import Path
import subprocess, json, concurrent.futures

WHISPER='/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/whisper-darwin-arm64'
def transcribe(job):
    sid, part, path=job
    dest=WORK/'transcripts'/f'{sid}-{part}'
    dest.parent.mkdir(exist_ok=True)
    if dest.with_suffix('.csv').exists(): return f'{sid}/{part} cached'
    wav=dest.with_suffix('.wav')
    subprocess.run([FFMPEG,'-v','error','-y','-i',str(path),'-ac','1','-ar','16000',str(wav)],check=True)
    r=subprocess.run([WHISPER,'-m',str(WORK/'tools/ggml-small.en.bin'),'-f',str(wav),'-t','4','-ml','1','-sow','-ocsv','-of',str(dest)],capture_output=True,text=True,check=True)
    dest.with_suffix('.log').write_text(r.stdout+'\n'+r.stderr)
    return f'{sid}/{part} transcribed'

if __name__=='__main__':
    import sys
    manifest=json.loads((ROOT/'public/manifest.json').read_text())
    jobs=[(s['id'],p,ROOT/'public'/f.get('rawPath',f['path'])) for s in manifest['songs'] for p,f in s['singing'].items() if not sys.argv[1:] or s['id'] in sys.argv[1:]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(transcribe,jobs): print(result,flush=True)
