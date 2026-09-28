"""Render pitch-preserving, continuous elastic maps using Rubber Band's R3 engine.

Only section boundaries (rests/explanations) are cuts. Timing anchors within a
section are NOT cuts: the phase-continuous stretcher follows the whole map.
"""
import argparse
import ctypes as C
import ctypes.util
import json
import os
from pathlib import Path
import subprocess
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RATE = 44100
FloatP = C.POINTER(C.c_float)
FloatPP = C.POINTER(FloatP)
UIntP = C.POINTER(C.c_uint)

def library():
    local = ROOT / ('.audio-work/tools/librubberband.dylib' if os.uname().sysname=='Darwin' else '.audio-work/tools/librubberband.so')
    path = os.environ.get('RUBBERBAND_LIBRARY') or (str(local) if local.exists() else ctypes.util.find_library('rubberband'))
    if not path:
        raise RuntimeError('Rubber Band library missing. See README audio setup (RUBBERBAND_LIBRARY).')
    lib = C.CDLL(path)
    signatures = {
        'new': ([C.c_uint,C.c_uint,C.c_int,C.c_double,C.c_double], C.c_void_p),
        'delete': ([C.c_void_p], None),
        'get_engine_version': ([C.c_void_p],C.c_int),
        'set_expected_input_duration': ([C.c_void_p,C.c_uint],None),
        'set_max_process_size': ([C.c_void_p,C.c_uint],None),
        'set_key_frame_map': ([C.c_void_p,C.c_uint,UIntP,UIntP],None),
        'study': ([C.c_void_p,FloatPP,C.c_uint,C.c_int],None),
        'process': ([C.c_void_p,FloatPP,C.c_uint,C.c_int],None),
        'available': ([C.c_void_p],C.c_int),
        'retrieve': ([C.c_void_p,FloatPP,C.c_uint],C.c_uint),
    }
    for name,(args,restype) in signatures.items():
        fn=getattr(lib,'rubberband_'+name);fn.argtypes=args;fn.restype=restype
    return lib

def pointers(x):
    return (FloatP*x.shape[0])(*(row.ctypes.data_as(FloatP) for row in x))

def stretch(x, source_frames, output_frames, lib):
    length=int(output_frames[-1]);channels=len(x)
    if np.array_equal(source_frames,output_frames): return x[:,:length].copy()
    state=lib.rubberband_new(RATE,channels,0x20000000|0x10000000|0x00010000,length/x.shape[1],1.0)
    if not state: raise RuntimeError('Could not allocate stretcher')
    try:
        if lib.rubberband_get_engine_version(state)!=3:
            raise RuntimeError('R3 (finer) engine required; install Rubber Band 3 or newer.')
        block=4096
        lib.rubberband_set_max_process_size(state,block)
        lib.rubberband_set_expected_input_duration(state,x.shape[1])
        # R3 implicitly starts at (0, 0); including it makes its initial ratio 0/0.
        a=np.ascontiguousarray(source_frames[1:],dtype=np.uint32)
        b=np.ascontiguousarray(output_frames[1:],dtype=np.uint32)
        lib.rubberband_set_key_frame_map(state,len(a),a.ctypes.data_as(UIntP),b.ctypes.data_as(UIntP))
        for i in range(0,x.shape[1],block):
            chunk=np.ascontiguousarray(x[:,i:i+block]);final=int(i+block>=x.shape[1])
            lib.rubberband_study(state,pointers(chunk),chunk.shape[1],final)
        output=[]
        def drain():
            while True:
                available=lib.rubberband_available(state)
                if available<=0: break
                y=np.empty((channels,available),dtype=np.float32)
                n=lib.rubberband_retrieve(state,pointers(y),available)
                if not n: raise RuntimeError('Stretcher did not return available frames')
                output.append(y[:,:n])
        for i in range(0,x.shape[1],block):
            chunk=np.ascontiguousarray(x[:,i:i+block]);final=int(i+block>=x.shape[1])
            lib.rubberband_process(state,pointers(chunk),chunk.shape[1],final);drain()
        drain()
        y=np.concatenate(output,axis=1)
        # Variable-map R3 may finish within two analysis windows of the requested
        # tail. Pad/trim that trailing rest only; reject larger discrepancies.
        # The separate envelope audit checks that musical timing is not shifted.
        if abs(y.shape[1]-length)>round(.15*RATE):
            raise RuntimeError(f'Render length mismatch: expected {length}, received {y.shape[1]}')
        return np.pad(y[:,:length],((0,0),(0,max(0,length-y.shape[1]))))
    finally:
        lib.rubberband_delete(state)

def timing_offsets(source, rendered, source_frames, output_frames):
    """Correct only the stretcher's measured residual, using the SAME performance.

    A harmony comparison cannot diagnose processing latency. Matching each render
    against its own authored, warped amplitude envelope can. Use many windows,
    reject weak/ambiguous matches, and search within 250 ms.
    """
    def envelope(x):
        mono=x.mean(axis=0); block=441
        mono=mono[:len(mono)//block*block].reshape(-1,block)
        return np.log(np.maximum(np.mean(mono**2,axis=1),1e-10))*.5
    raw=envelope(source);made=envelope(rendered)
    grid=np.arange(len(made))*.01
    sample_times=np.interp(grid*RATE,output_frames,source_frames)/RATE
    expected=np.interp(sample_times,np.arange(len(raw))*.01,raw)
    offsets=[];centers=[]
    for center in range(85,len(made)-85,75):
        a=expected[center-55:center+55];a=a-a.mean()
        if np.std(a)<.08: continue
        scores=[]
        for offset in range(-25,26):
            b=made[center-55+offset:center+55+offset];b=b-b.mean()
            scores.append(float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)+1e-9)))
        best=int(np.argmax(scores))
        outside=[v for k,v in enumerate(scores) if abs(k-best)>8]
        if scores[best]>.9 and best not in (0,50) and scores[best]-max(outside)>.005:
            offsets.append((best-25)*441);centers.append(center*441)
    return np.array(centers),np.array(offsets)

def calibrated_stretch(source, source_frames, output_frames, lib, iterations=3):
    """Measure, compensate and re-render from the ORIGINAL PCM, never a cascade.

    Variable-ratio synthesis can accumulate tens of ms of rounding drift. Two
    closed-loop passes correct that measured drift while keeping pitch at 1.0.
    """
    rendered=stretch(source,source_frames,output_frames,lib)
    requested=output_frames.copy()
    best_render=rendered;best_error=float('inf')
    for attempt in range(iterations):
        times,offsets=timing_offsets(source,rendered,source_frames,output_frames)
        if len(offsets)<3: break
        error=float(np.percentile(np.abs(offsets),95))
        if error<best_error:best_render=rendered;best_error=error
        if error<=441 or attempt==iterations-1: break
        # Median smooth bad single-window matches; interpolate slowly varying
        # synthesis error, not syllable-level musical differences.
        smoothed=np.array([np.median(offsets[max(0,i-1):i+2]) for i in range(len(offsets))])
        adjustment=np.interp(output_frames,times,smoothed)
        requested=np.rint(requested-adjustment).astype(int)
        requested[0]=0;requested[-1]=output_frames[-1]
        # Compensation is at most 250 ms and must never invert the time map.
        for i in range(1,len(requested)-1):
            requested[i]=max(requested[i],requested[i-1]+220)
        for i in range(len(requested)-2,0,-1):
            requested[i]=min(requested[i],requested[i+1]-220)
        rendered=stretch(source,source_frames,requested,lib)
    rendered=best_render
    _,offsets=timing_offsets(source,rendered,source_frames,output_frames)
    if len(offsets)<3:return rendered
    delay=-int(np.clip(round(float(np.median(offsets))),-RATE*.15,RATE*.15))
    if delay>0: rendered=np.pad(rendered,((0,0),(delay,0)))[:,:rendered.shape[1]]
    elif delay<0: rendered=np.pad(rendered[:,-delay:],((0,0),(0,-delay)))
    return rendered

def render(input_path, output_path, correction, duration, ffmpeg):
    raw=subprocess.check_output([ffmpeg,'-v','error','-i',str(input_path),'-ac','2','-ar',str(RATE),'-f','f32le','-'])
    original=np.frombuffer(raw,dtype='<f4').reshape(-1,2).T.copy()
    for start,end in correction.get('muteSourceRanges',[]):
        a,b=round(start*RATE),round(end*RATE);fade=min(882,(b-a)//2)
        original[:,a:a+fade]*=np.linspace(1,0,fade)
        original[:,a+fade:b-fade]=0
        original[:,b-fade:b]*=np.linspace(0,1,fade)
    output=np.zeros((2,round(duration*RATE)),dtype=np.float32)
    lib=library()
    last_end=0
    for section in correction['sections']:
        anchors=np.array(section['anchors'])
        if len(anchors)<2 or anchors[0,0]!=0 or np.any(np.diff(anchors,axis=0)<=0):
            raise ValueError('Timing anchors must be strictly monotonic and start at output time zero')
        start,end=np.rint(anchors[[0,-1],1]*RATE).astype(int)
        if start<0 or end>original.shape[1]+1: raise ValueError('Source section exceeds recording')
        x=np.ascontiguousarray(original[:,start:end])
        source_frames=np.rint(anchors[:,1]*RATE).astype(int)-start
        target_frames=np.rint(anchors[:,0]*RATE).astype(int)
        y=stretch(x,source_frames,target_frames,lib) if np.array_equal(source_frames,target_frames) else calibrated_stretch(x,source_frames,target_frames,lib,correction.get('renderIterations',3))
        # Very short edge fades only in the pre-attack air / trailing rest.
        fade=min(round(.008*RATE),y.shape[1]//2)
        y[:,:fade]*=np.linspace(0,1,fade);y[:,-fade:]*=np.linspace(1,0,fade)
        offset=round(section['outputStart']*RATE)
        if offset<last_end or offset+y.shape[1]>output.shape[1]: raise ValueError('Overlapping/out-of-bounds output sections')
        output[:,offset:offset+y.shape[1]]=y;last_end=offset+y.shape[1]
    if not np.all(np.isfinite(output)): raise RuntimeError('Non-finite audio generated')
    # Do not clip time-stretch overshoots; use a single constant trim if needed.
    peak=np.max(np.abs(output))
    if peak>.98: output*=.98/peak
    subprocess.run([ffmpeg,'-v','error','-y','-f','f32le','-ar',str(RATE),'-ac','2','-i','-',
                    '-c:a','aac','-b:a','192k','-movflags','+faststart',str(output_path)],
                   input=np.ascontiguousarray(output.T).tobytes(),check=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--song',required=True);parser.add_argument('--part',required=True);parser.add_argument('--ffmpeg',required=True)
    parser.add_argument('--recipes',default=str(ROOT/'scripts/audio-alignment.json'))
    args=parser.parse_args();recipe=json.loads(Path(args.recipes).read_text())['songs'][args.song]
    render(args.input,args.output,recipe['parts'][args.part],recipe['duration'],args.ffmpeg)
