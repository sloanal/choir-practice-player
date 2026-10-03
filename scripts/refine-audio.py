"""Build reviewed, non-linear timing maps. Run only when deliberately reauthoring audio.

Analysis uses 20 ms frames, broadband attacks and spectral envelopes, not pitch
matching: harmony notes are intentionally different. Source ranges below exclude
spoken instructions/alternate takes. The renderer consumes the saved map, so
deployments do not rerun an approximate alignment algorithm.
"""
import json
import sys
import hashlib
import numpy as np
from scipy import ndimage, signal
from scipy.spatial.distance import cdist
from audio_lab import ROOT, WORK, DT, at, get_song, get_features

OLD = ROOT / 'scripts/audio-alignment-baseline.json'
RECIPE = ROOT / 'scripts/audio-alignment.json'
PARTS = ['high', 'mid', 'low']

# Corresponding musical sections, in seconds in the ORIGINAL recordings.
# Keep both musical passes; remove the different spoken breaks between them.
SPECIAL = {
    'clear-blue-morning': [
        {'high': [5.76, 37.7], 'mid': [4.84, 35.02], 'low': [3.31, 34.48]},
        {'high': [43.51, 75.3], 'mid': [39.57, 65.5], 'low': [36.67, 63.75]},
    ],
    'the-chain-chorus': [
        {'high': [.32, 27.5], 'mid': [3.93, 28.95], 'low': [2.77, 27.5]},
        {'high': [31.45, 69.7], 'mid': [36.21, 73.25], 'low': [34.26, 69.4]},
    ],
    'the-chain-verses': [
        {'high': [3.9, 27.7], 'mid': [3.37, 26.55], 'low': [3.01, 26.5]},
        {'high': [29.61, 65.7], 'mid': [28.14, 68.0], 'low': [28.23, 65.45]},
    ],
    # Starts at the unison entrance, after Greg's spoken context over the bridge.
    'you-belong-with-me-bridge-to-end': [
        {'high': [19.85, 66.2], 'mid': [19.8, 66.25], 'low': [19.9, 66.1]},
    ],
}
# Songs added after the baseline pass have no coarse offset/tempo map.
NEW = {'you-belong-with-me-bridge-to-end': {'title': 'You Belong with Me (Bridge to End)', 'referencePart': 'high'}}
# Reference start (includes a little pre-attack air), in the old timeline.
START = {'because-the-night': 2.02, 'blinding-lights': 1.85,
         'closer-to-fine': 2.18, 'diamonds': 2.43, 'fix-you-bridge': 2.65,
         'fix-you-chorus': 1.65, 'lay-down': 2.05,
         'lay-down-bridge': 1.6, 'the-chain-outro': 3.02,
         'you-belong-with-me': 1.68}

def descriptor(f, times):
    env = at(f['env'], times)
    bands = at(f['bands'], times)
    # Slow dynamics and spectral tilt differ between voices. Emphasize changes.
    detail = env - ndimage.gaussian_filter1d(env, 35)
    detail /= np.std(detail) + .05
    attacks = np.maximum(0, bands - np.roll(bands, 2, axis=1))
    attacks[:, :2] = 0
    attacks = ndimage.gaussian_filter1d(attacks, 1, axis=1)
    attacks /= np.std(attacks, axis=1, keepdims=True) + .05
    cep = at(f['cep'][:4], times)
    return np.vstack([detail[None]*1.3, attacks*.8, cep*.15]).T

def timing_map(reference, source, rr, sr, muted=()):
    import librosa
    rt = np.arange(rr[0], rr[1]+.001, .02)
    st = np.arange(sr[0], sr[1]+.001, .02)
    a, b = descriptor(reference, rt), descriptor(source, st)
    cost = cdist(a,b,'sqeuclidean') / a.shape[1]
    for start,end in muted:
        cost[:,(st>=start)&(st<=end)]=0
    expected = (rt-rr[0])/(rr[1]-rr[0])
    actual = (st-sr[0])/(sr[1]-sr[0])
    displacement = (expected[:,None]-actual[None,:])*(rr[1]-rr[0])
    cost += .09*displacement**2
    cost[np.abs(displacement)>1.65] = np.inf
    _, wp = librosa.sequence.dtw(C=cost, step_sizes_sigma=np.array([[1,1],[1,2],[2,1]]),
                                weights_add=np.array([0,.12,.12]), backtrack=True)
    wp = wp[::-1]
    # Collapse multi-valued DTW path and smooth only below syllable scale.
    x = np.unique(wp[:,0])
    y = np.array([np.median(wp[wp[:,0]==i,1]) for i in x])*.02+sr[0]
    y = np.interp(rt, rt[x], y)
    y = ndimage.gaussian_filter1d(y, 6, mode='nearest')
    # A 250 ms map grid keeps audible attacks, without frame-to-frame flutter.
    knots = np.r_[np.arange(rr[0],rr[1]-.1,.25), rr[1]]
    values = np.interp(knots,rt,y)
    values[0],values[-1] = sr
    # Bound local speed changes. Repeated projection limits pathological matches.
    rate=(sr[1]-sr[0])/(rr[1]-rr[0])
    for _ in range(60):
        for i in range(1,len(values)-1):
            lo=max(values[i-1]+(knots[i]-knots[i-1])*rate*.65,
                   values[i+1]-(knots[i+1]-knots[i])*rate*1.45)
            hi=min(values[i-1]+(knots[i]-knots[i-1])*rate*1.45,
                   values[i+1]-(knots[i+1]-knots[i])*rate*.65)
            values[i]=np.clip(values[i],lo,hi)
    return knots, values

def build(sid, old):
    recipe=old['songs'].get(sid) or NEW[sid]
    feat=get_features(get_song(sid))
    ref=recipe['referencePart']
    ranges=SPECIAL.get(sid)
    if ranges is None:
        ranges=[{p:[max(0,c['sourceOffset']+START[sid]*c['tempo']),
                    len(feat[p]['env'])*DT-.04]
                 for p,c in recipe['parts'].items()}]
    if sid=='the-chain-outro':
        ranges[0]['low'][0]=1.87
    if sid=='fix-you-chorus':
        ranges[0]['low'][0]=8.0
        ranges[0]['low'][1]=27.95
    if sid=='lay-down':
        ranges[0]['low'][1]=31.8
    result={'title':recipe['title'],'referencePart':ref,'parts':{p:{'sections':[]} for p in PARTS}}
    out=.65
    for section in ranges:
        rr=section[ref]; duration=rr[1]-rr[0]
        for p in PARTS:
            if p==ref: rt,st=np.array(rr),np.array(rr)
            else:
                muted=[(19.9,22.22)] if sid=='the-chain-outro' and p=='low' else []
                rt,st=timing_map(feat[ref],feat[p],rr,section[p],muted)
            result['parts'][p]['sections'].append({'outputStart':round(out,4),
                'anchors':[[round(float(x-rr[0]),4),round(float(y),4)] for x,y in zip(rt,st)]})
        out+=duration+.75
    result['duration']=round(out-.45,4)
    if sid=='the-chain-outro':
        result['parts']['low']['muteSourceRanges']=[[19.9,22.22]]
    if sid=='clear-blue-morning':
        result['parts']['mid']['muteSourceRanges']=[[34.1,35.05]]
    if sid=='the-chain-verses':
        result['parts']['high']['renderIterations']=5
        result['parts']['mid']['renderIterations']=5
    song=get_song(sid)
    for p,c in result['parts'].items():
        file=song['singing'][p]
        source=ROOT/'public'/file.get('rawPath',file['path'])
        c['sourceSha256']=hashlib.sha256(source.read_bytes()).hexdigest()
    return result

def plot(sid, recipe):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    feat=get_features(get_song(sid));duration=recipe['duration']
    n=int(np.ceil(duration/15));fig,axes=plt.subplots(n,1,figsize=(18,3*n),squeeze=False)
    for k,ax in enumerate(axes[:,0]):
        for i,p in enumerate(PARTS):
            for s in recipe['parts'][p]['sections']:
                anchors=np.array(s['anchors']); t=np.arange(0,anchors[-1,0],DT)
                xx=t+s['outputStart'];keep=(xx>=k*15)&(xx<(k+1)*15)
                ax.plot(xx[keep],at(feat[p]['env'],np.interp(t[keep],*anchors.T))*.35+2-i,lw=.8)
        ax.set_xlim(k*15,min((k+1)*15,duration));ax.set_xticks(np.arange(k*15,min((k+1)*15,duration),.5));ax.tick_params(axis='x',labelsize=7)
        ax.set_yticks([0,1,2],['Low','Mid','High']);ax.grid(alpha=.3)
    fig.suptitle(sid+' elastic alignment');fig.tight_layout();fig.savefig(WORK/(sid+'-elastic.png'),dpi=110);plt.close(fig)

if __name__=='__main__':
    old=json.loads(OLD.read_text())
    dest=WORK/'alignment-candidate.json'
    result=json.loads(dest.read_text()) if dest.exists() else {'version':5,'method':'musical-section-keyframes','songs':{}}
    for sid in sys.argv[1:] or [*old['songs'], *NEW]:
        result['songs'][sid]=build(sid,old);plot(sid,result['songs'][sid])
        dest.write_text(json.dumps(result,indent=2)+'\n');print(sid,flush=True)
