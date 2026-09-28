"""Offline timing analysis utilities; never edits source recordings."""
from pathlib import Path
import os
import json
import subprocess
import hashlib
import shutil
import numpy as np
from scipy import signal, ndimage, fft

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / '.audio-work'
WORK.mkdir(exist_ok=True)
FFMPEG = os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg') or '/Applications/Screen Studio.app/Contents/Resources/app.asar.unpacked/bin/ffmpeg-darwin-arm64'
SR = 16000
HOP = 160
DT = HOP / SR

def decode(path, sr=SR):
    path = Path(path)
    key = hashlib.sha256((str(path)+str(path.stat().st_mtime_ns)+str(sr)).encode()).hexdigest()[:20]
    cache = WORK / (key + '.npy')
    if cache.exists():
        return np.load(cache)
    raw = subprocess.check_output([FFMPEG, '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'])
    x = np.frombuffer(raw, dtype='<f4').copy()
    np.save(cache, x)
    return x

def features(x):
    import librosa
    S = np.abs(librosa.stft(x, n_fft=1024, hop_length=HOP))**2
    mel = librosa.feature.melspectrogram(S=S, sr=SR, n_mels=40, fmin=100, fmax=7500)
    logmel = np.log(np.maximum(mel, 1e-8))
    # Broad spectral envelopes capture consonants/vowels without forcing
    # different harmony pitches to match note-for-note.
    cep = fft.dct(logmel, type=2, axis=0, norm='ortho')[1:9]
    cep = (cep - np.mean(cep, axis=1, keepdims=True)) / (np.std(cep, axis=1, keepdims=True)+1e-6)
    cep = ndimage.gaussian_filter1d(cep, 1.5, axis=1)
    env = .5*np.log(np.maximum(np.sum(S, axis=0), 1e-8))
    env = ndimage.gaussian_filter1d(env, 1.5)
    env = (env-np.median(env))/(np.percentile(env,90)-np.percentile(env,10)+1e-6)
    env = np.clip(env, -2, 2)
    bands = np.stack([np.log(np.maximum(S[a:b].sum(axis=0), 1e-8)) for a,b in [(6,32),(32,80),(80,192),(192,480)]])
    bands = ndimage.gaussian_filter1d(bands, 1.5, axis=1)
    bands = (bands-bands.mean(axis=1,keepdims=True))/(bands.std(axis=1,keepdims=True)+1e-6)
    return {'env':env, 'cep':cep, 'bands':bands, 'logmel':logmel}

def get_song(song_id):
    manifest=json.loads((ROOT/'public/manifest.json').read_text())
    song=next(s for s in manifest['songs'] if s['id']==song_id)
    return song

def raw_audio(song):
    return {p:decode(ROOT/'public'/f.get('rawPath', f['path'])) for p,f in song['singing'].items()}

def get_features(song, raw=True):
    result={}
    for p,f in song['singing'].items():
        path=ROOT/'public'/(f.get('rawPath',f['path']) if raw else f['path'])
        key=hashlib.sha256((str(path)+str(path.stat().st_mtime_ns)).encode()).hexdigest()[:20]
        cache=WORK/(key+'.features.npz')
        if cache.exists(): result[p]=dict(np.load(cache))
        else:
            result[p]=features(decode(path)); np.savez(cache,**result[p])
    return result

def old_map(recipe, part, t):
    c=recipe['parts'][part]
    return c['sourceOffset']+c['tempo']*t

def at(feature, times):
    grid=np.arange(feature.shape[-1])*DT
    if feature.ndim==1: return np.interp(times,grid,feature,left=feature[0],right=feature[-1])
    return np.stack([np.interp(times,grid,row,left=row[0],right=row[-1]) for row in feature])

def plot_song(song_id, maps=None, out=None, before=False):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    song=get_song(song_id)
    recipe_file='audio-alignment-baseline.json' if before else 'audio-alignment.json'
    recipe=json.loads((ROOT/'scripts'/recipe_file).read_text())['songs'][song_id]
    feat=get_features(song,raw=before or maps is not None)
    duration=recipe['duration']
    n=int(np.ceil(duration/18))
    fig,axes=plt.subplots(n,1,figsize=(18,3.1*n),squeeze=False)
    colors={'high':'#7755cc','mid':'#0095ba','low':'#d77410'}
    for k,ax in enumerate(axes[:,0]):
        t=np.arange(k*18,min(duration,(k+1)*18),DT)
        for i,p in enumerate(['high','mid','low']):
            tt=(old_map(recipe,p,t) if before else t) if maps is None else np.interp(t,*np.array(maps[p]).T)
            env=at(feat[p]['env'],tt)
            ax.plot(t,env*.38+2-i,color=colors[p],lw=1,label=p)
        ax.set_yticks([0,1,2],['Low','Mid','High']);ax.set_xlim(t[0],t[-1]);ax.set_xticks(np.arange(np.ceil(t[0]),t[-1]+.1,1));ax.grid(alpha=.25)
    fig.suptitle(song['title']);fig.tight_layout()
    dest=Path(out) if out else WORK/(song_id+('-before.png' if before else '-rendered.png'))
    fig.savefig(dest,dpi=110);plt.close(fig)
    return str(dest)

if __name__=='__main__':
    import sys
    for sid in [s for s in sys.argv[1:] if s!='--before']: print(plot_song(sid,before='--before' in sys.argv),flush=True)
