"""Audit ENCODED files, not just equal container durations or the intended maps.

Own-source comparisons verify renderer accuracy; cross-voice windows are only
diagnostics. Distinct harmony rhythms make a single 'perfect sync' score invalid.
"""
import json
import sys
import numpy as np
from scipy import ndimage
from audio_lab import ROOT, WORK, DT, at, get_song, get_features

def match(a,b,t,max_lag=.15):
    lags=np.arange(-max_lag,max_lag+.001,.01)
    aa=at(a,t);aa-=aa.mean();norm=np.linalg.norm(aa)
    if norm<.1: return None
    scores=[]
    for lag in lags:
        bb=at(b,t+lag);bb-=bb.mean()
        scores.append(float(np.dot(aa,bb)/(norm*np.linalg.norm(bb)+1e-9)))
    k=int(np.argmax(scores))
    return float(lags[k]),scores[k],k not in (0,len(lags)-1)

def audit(sid,recipe):
    song=get_song(sid);raw=get_features(song);made=get_features(song,raw=False)
    row={'song':sid,'render':{},'crossVoiceDiagnostics':{}}
    for p,c in recipe['parts'].items():
        residuals=[];scores=[]
        for s in c['sections']:
            anchors=np.array(s['anchors']);start=s['outputStart'];end=start+anchors[-1,0]
            grid=np.arange(0,recipe['duration']+.02,DT)
            source_times=np.interp(grid-start,*anchors.T)
            expected=at(raw[p]['env'],source_times)
            for center in np.arange(start+1,end-.8,1):
                src=float(np.interp(center-start,*anchors.T))
                if any(a-1<src<b+1 for a,b in c.get('muteSourceRanges',[])): continue
                t=np.arange(center-.6,center+.6,DT)
                result=match(expected,made[p]['env'],t)
                if result and result[1]>.85 and result[2]:
                    residuals.append(abs(result[0]));scores.append(result[1])
        row['render'][p]={'matchedWindows':len(residuals),
            'medianErrorMs':round(float(np.median(residuals))*1000,1) if residuals else None,
            'p95ErrorMs':round(float(np.percentile(residuals,95))*1000,1) if residuals else None,
            'medianCorrelation':round(float(np.median(scores)),3) if scores else None}
    ref=recipe['referencePart']
    for p in ['high','mid','low']:
        if p==ref:continue
        residuals=[];total=0
        # Held-out derivative of the encoded RMS envelope, not the analysis cost.
        a=ndimage.gaussian_filter1d(made[ref]['env'],2,order=1)
        b=ndimage.gaussian_filter1d(made[p]['env'],2,order=1)
        for s in recipe['parts'][ref]['sections']:
            start=s['outputStart'];end=start+s['anchors'][-1][0]
            for center in np.arange(start+1,end-1,1.5):
                total+=1;t=np.arange(center-.7,center+.7,DT)
                result=match(a,b,t,.5)
                if result and result[1]>.65 and result[2]:residuals.append(abs(result[0]))
        row['crossVoiceDiagnostics'][p]={'confidentWindows':len(residuals),'totalWindows':total,
            'medianLagMs':round(float(np.median(residuals))*1000,1) if residuals else None,
            'p90LagMs':round(float(np.percentile(residuals,90))*1000,1) if residuals else None}
    return row

if __name__=='__main__':
    recipes=json.loads((ROOT/'scripts/audio-alignment.json').read_text())
    rows=[]
    for sid in sys.argv[1:] or recipes['songs']:
        row=audit(sid,recipes['songs'][sid]);rows.append(row);print(json.dumps(row),flush=True)
    failures=[f"{r['song']}/{p}: rendered envelope misses timing map" for r in rows
              for p,v in r['render'].items() if v['matchedWindows']<3 or v['p95ErrorMs']>70]
    report={'version':recipes['version'],'songs':rows,'failures':failures,
            'caveat':'Cross-voice diagnostics cover only confident shared attacks, not every note or intentional harmony entrance.'}
    (WORK/'timing-audit.json').write_text(json.dumps(report,indent=2)+'\n')
    if failures: print('\n'.join(failures));sys.exit(1)
