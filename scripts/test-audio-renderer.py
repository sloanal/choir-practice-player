"""Small DSP regressions, independent of the choir recordings."""
import importlib.util
import unittest
import numpy as np
from pathlib import Path

spec=importlib.util.spec_from_file_location('renderer',Path(__file__).with_name('render-aligned-audio.py'))
renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)

class RendererTests(unittest.TestCase):
    def test_identity_does_not_modify_samples(self):
        x=np.random.default_rng(0).uniform(-.1,.1,(2,44100)).astype(np.float32)
        frames=np.array([0,44100])
        np.testing.assert_array_equal(renderer.stretch(x,frames,frames,renderer.library()),x)

    def test_non_linear_timing_does_not_shift_pitch(self):
        rate=renderer.RATE;t=np.arange(rate*3)/rate
        x=np.stack([.2*np.sin(2*np.pi*440*t)]*2).astype(np.float32)
        a=np.array([0,rate,2*rate,3*rate]);b=np.array([0,int(.8*rate),int(2.2*rate),3*rate])
        y=renderer.stretch(x,a,b,renderer.library())
        self.assertEqual(y.shape,x.shape)
        for lo,hi in [(.2,.6),(1.1,1.8),(2.5,2.9)]:
            segment=y[0,int(lo*rate):int(hi*rate)]
            power=np.abs(np.fft.rfft(segment*np.hanning(len(segment))))
            freq=np.fft.rfftfreq(len(segment),1/rate)[np.argmax(power)]
            self.assertAlmostEqual(freq,440,delta=3)

    def test_calibrated_map_places_musical_attacks(self):
        rate=renderer.RATE;t=np.arange(rate*5)/rate
        beats=np.array([.4,.9,1.5,2.1,2.7,3.3,3.9,4.5])
        envelope=sum(np.exp(-((t-beat)/.04)**2) for beat in beats)
        x=np.stack([.3*envelope*np.sin(2*np.pi*440*t)]*2).astype(np.float32)
        a=np.rint(np.array([0,1,2,3,4,5])*rate).astype(int)
        b=np.rint(np.array([0,.9,2.15,2.8,4.1,5])*rate).astype(int)
        y=renderer.calibrated_stretch(x,a,b,renderer.library())
        block=441;energy=np.mean(y[0,:len(y[0])//block*block].reshape(-1,block)**2,axis=1)
        for expected in np.interp(beats*rate,a,b)/rate:
            lo=int((expected-.12)*100);hi=int((expected+.12)*100)
            actual=(lo+np.argmax(energy[lo:hi]))*.01+.005
            self.assertAlmostEqual(actual,expected,delta=.04)

if __name__=='__main__':unittest.main()
