import os
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from okcover.finalize import build_work
from okcover.wavio import read_wav
from okcover.workscan import scan_work

# P3：合成音频验变调和对齐；RV2 的三条静音 wav 只验格式、时长和扫描。

E2E = Path(__file__).resolve().parent / 'fixtures' / 'e2e'
FFMPEG = '/usr/bin/ffmpeg'


def _backend(tmp):
    link = Path(tmp) / 'ffmpeg' / 'bin' / 'ffmpeg'
    link.parent.mkdir(parents=True)
    link.symlink_to(FFMPEG)
    return tmp


def _cfg(work, key):
    return {
        'mode': 'library',
        'separator': 'builtin',
        'key': key,
        'finalize': {
            'work_dir': work,
            'title': '夜航',
            'artist': '示例',
            'lyrics_path': None,
            'source_song_id': 'song',
            'model_id': 'model',
        },
    }


class _Tracks:
    def __init__(self, vocal, instrumental, original):
        self.vocal = vocal
        self.instrumental = instrumental
        self.original = original


def _write_mono(path, samples, rate):
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = np.round(pcm * 32767.0).astype('<i2')
    with wave.open(path, 'w') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())


def _fmt(path):
    blob = Path(path).read_bytes()
    size = struct.unpack_from('<I', blob, 16)[0]
    body = blob[20:20 + size]
    tag, channels, rate, _br, _ba, bits = struct.unpack_from('<HHIIHH', body)
    return tag, channels, rate, bits


class FinalizeTest(unittest.TestCase):
    def setUp(self):
        if not os.path.isfile(FFMPEG):
            self.skipTest('没有 /usr/bin/ffmpeg')

    def test_pitch_duration_and_alignment(self):
        rate = 44100
        seconds = np.arange(rate) / rate
        tone = 0.4 * np.sin(2 * np.pi * 440 * seconds)
        short = np.zeros(rate // 2)
        short[0] = 0.8
        long = 0.2 * np.sin(2 * np.pi * 220 * np.arange(int(rate * 1.25)) / rate)
        with tempfile.TemporaryDirectory() as tmp:
            backend = _backend(tmp)
            vocal = os.path.join(tmp, 'vocal.wav')
            inst = os.path.join(tmp, 'inst.wav')
            orig = os.path.join(tmp, 'orig.wav')
            _write_mono(vocal, short, rate)
            _write_mono(inst, tone, rate)
            _write_mono(orig, long, rate)
            flat = build_work(_cfg(os.path.join(tmp, 'flat'), 0), _Tracks(vocal, inst, orig), backend)
            sharp = build_work(_cfg(os.path.join(tmp, 'sharp'), 3), _Tracks(vocal, inst, orig), backend)
            flat_inst, flat_rate = read_wav(flat['tracks']['instrumental'])
            sharp_inst, sharp_rate = read_wav(sharp['tracks']['instrumental'])
            self.assertEqual(flat_rate, 44100)
            self.assertEqual(sharp_rate, 44100)
            self.assertLessEqual(abs(flat_inst.shape[0] - rate), 1)
            self.assertLessEqual(abs(sharp_inst.shape[0] - flat_inst.shape[0]), 1)
            for role in ('vocal', 'instrumental', 'original'):
                tag, channels, file_rate, bits = _fmt(sharp['tracks'][role])
                self.assertEqual((tag, channels, file_rate, bits), (1, 2, 44100, 16))
            spectrum = np.abs(np.fft.rfft(sharp_inst[:, 0] * np.hanning(sharp_inst.shape[0])))
            peak = np.argmax(spectrum) * 44100 / sharp_inst.shape[0]
            self.assertLess(abs(peak - 440 * (2 ** (3 / 12))), 8.0)
            left = sharp_inst[:, 0]
            right = sharp_inst[:, 1]
            self.assertLess(np.max(np.abs(left - right)), 1e-3)
            vocal_out, _rate = read_wav(sharp['tracks']['vocal'])
            self.assertEqual(vocal_out.shape[0], sharp_inst.shape[0])
            self.assertLess(int(np.argmax(np.abs(vocal_out[:, 0]))), 200)
            self.assertLess(np.max(np.abs(vocal_out[-rate // 5:, 0])), 1e-3)
            names = os.listdir(sharp['work_dir'])
            self.assertFalse(any('和声' in name or 'harmony' in name for name in names))
            scanned = scan_work(sharp['work_dir'])
            self.assertTrue(scanned['ready'])
            self.assertEqual(scanned['source'], 'manifest')
            self.assertEqual(set(scanned['tracks']), {'vocal', 'instrumental', 'original'})

    def test_e2e_silence_is_format_fixture_only(self):
        accomp = E2E / 'e2e-8s-accomp.wav'
        original = E2E / 'e2e-8s-original.wav'
        vocal = E2E / 'e2e-8s-vocal.wav'
        self.assertEqual(accomp.read_bytes(), original.read_bytes())
        vocal_frames, vocal_rate = read_wav(vocal)
        inst_frames, inst_rate = read_wav(accomp)
        self.assertEqual(vocal_frames.shape, (319200, 1))
        self.assertEqual(vocal_rate, 40000)
        self.assertEqual(inst_frames.shape, (352800, 2))
        self.assertEqual(inst_rate, 44100)
        self.assertEqual(float(np.max(np.abs(vocal_frames))), 0.0)
        self.assertEqual(float(np.max(np.abs(inst_frames))), 0.0)
        with tempfile.TemporaryDirectory() as tmp:
            backend = _backend(tmp)
            built = build_work(
                _cfg(os.path.join(tmp, '示例 - 夜航'), 0),
                _Tracks(str(vocal), str(accomp), str(original)),
                backend,
            )
            shifted = build_work(
                _cfg(os.path.join(tmp, '示例 - 夜航-up'), 3),
                _Tracks(str(vocal), str(accomp), str(original)),
                backend,
            )
            base, _rate = read_wav(built['tracks']['instrumental'])
            up, _rate = read_wav(shifted['tracks']['instrumental'])
            voice, _rate = read_wav(built['tracks']['vocal'])
            self.assertLessEqual(abs(base.shape[0] - 352800), 1)
            self.assertLessEqual(abs(up.shape[0] - base.shape[0]), 1)
            self.assertEqual(voice.shape[0], base.shape[0])
            scanned = scan_work(built['work_dir'])
            self.assertEqual(scanned['source'], 'manifest')
            self.assertEqual(set(scanned['tracks']), {'vocal', 'instrumental', 'original'})
            self.assertNotIn('harmony', scanned['tracks'])
            self.assertFalse(any('和声' in name for name in os.listdir(built['work_dir'])))


if __name__ == '__main__':
    unittest.main()
