import hashlib
import json
import os
import pickle
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from okcover.classify import judge
from okcover.config import DEEP_KEYS, DEEP_SLIDERS, NEVER_KEYS, load, translate
from okcover.equivalence import D11_STATUS, diff_trees
from okcover.hooks import HookState, install
from test_p1_protocol import FAKE, EntryProc, _env, _ready

# P2：翻译表的「写 / 一律不写」、4.7 验收夹具、错误分类。


def _last(proc):
    lines = [json.loads(line) for line in proc.stdout_text().splitlines() if line]
    return lines[-1]


def _run(tmp, fixture=None, **overrides):
    cfg = _ready(tmp, **overrides)
    extra = {}
    if fixture:
        extra['OKCOVER_FIXTURE'] = fixture
    proc = EntryProc(['--config', str(cfg)], _env(tmp, **extra), tmp)
    code = proc.wait(10)
    return code, _last(proc), proc


class TranslateTest(unittest.TestCase):
    def _cfg(self, deep=None, index=None):
        raw = {
            'schema_version': 2,
            'input_files': ['/song.wav'],
            'output_dir': '/out',
            'device': 'cuda',
            'separate': {'mode': 'library', 'separator': 'builtin'},
            'convert': {
                'model_path': '/m.pth',
                'model_sha256': 'ab' * 32,
                'index_path': index,
                'key': 0,
                'f0_method': 'rmvpe',
                'rvc': {'index_rate': 0.72, 'rms_mix_rate': 0.5, 'protect': 0.28, 'filter_radius': 4},
                'deep': deep,
            },
            'finalize': {
                'work_dir': '/work/示例 - 夜航',
                'title': '夜航',
                'artist': '示例',
                'lyrics_path': None,
                'source_song_id': 'song',
                'model_id': 'model',
            },
            'task_id': 'TASKDEAD',
            'formant_shift_key': 0.2,
            'app_base_dir': '/should/not/copy',
        }
        return raw

    def test_null_deep_writes_only_the_allowed_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'okc_config.json'
            path.write_text(json.dumps(self._cfg()), encoding='utf-8')
            cfg = load(str(path))
            out = translate(cfg)
        self.assertEqual(out['deep_debug_enabled'], False)
        self.assertNotIn('index_path', out)
        for key in NEVER_KEYS + DEEP_KEYS:
            self.assertNotIn(key, out)
        self.assertEqual(set(out), {
            'input_files', 'output_dir', 'device', 'use_msst', 'msst_method', 'use_svc',
            'model_path', 'key', 'pitch_extractor', 'index_rate', 'rms_mix_rate', 'protect',
            'filter_radius', 'deep_debug_enabled',
        })
        self.assertEqual(out['msst_method'], 'library')
        self.assertEqual(out['pitch_extractor'], 'rmvpe')
        self.assertTrue(out['use_msst'])
        self.assertTrue(out['use_svc'])

    def test_index_and_deep_are_written_only_when_set(self):
        deep = {'humanize': False}
        for name in DEEP_SLIDERS:
            deep[name] = 0.5
        with tempfile.TemporaryDirectory() as tmp:
            index = Path(tmp) / 'm.index'
            index.write_bytes(b'idx')
            body = self._cfg(deep=deep, index=str(index))
            path = Path(tmp) / 'okc_config.json'
            path.write_text(json.dumps(body), encoding='utf-8')
            out = translate(load(str(path)))
        self.assertEqual(out['index_path'], str(index))
        self.assertEqual(out['deep_debug_enabled'], True)
        self.assertEqual(out['humanize'], False)
        for name in DEEP_SLIDERS:
            self.assertEqual(out[name], 0.5)
        for key in NEVER_KEYS:
            self.assertNotIn(key, out)

    def test_fcpe_and_aggressive_are_config_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp, f0='fcpe')
            proc = EntryProc(['--config', str(cfg)], _env(tmp), tmp)
            self.assertEqual(proc.wait(10), 1)
            self.assertEqual(_last(proc)['error_code'], 'CONFIG_INVALID')
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp, mode='aggressive')
            proc = EntryProc(['--config', str(cfg)], _env(tmp), tmp)
            self.assertEqual(proc.wait(10), 1)
            self.assertEqual(_last(proc)['error_code'], 'CONFIG_INVALID')


class FixtureTest(unittest.TestCase):
    def test_svc_all_error_is_svc_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, result, _proc = _run(tmp, 'svc-all-error')
            self.assertEqual(code, 1)
            self.assertEqual(result['error_code'], 'SVC_FAILED')

    def test_cuda_message_is_cuda_oom(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, result, _proc = _run(tmp, 'svc-cuda')
            self.assertEqual(code, 1)
            self.assertEqual(result['error_code'], 'CUDA_OOM')

    def test_swallowed_cuda_exception_is_cuda_oom(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, result, _proc = _run(tmp, 'swallow-cuda')
            self.assertEqual(code, 1)
            self.assertEqual(result['error_code'], 'CUDA_OOM')

    def test_reverb_is_dropped_not_a_track(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, result, _proc = _run(tmp, 'with-reverb')
            self.assertEqual(code, 0, _proc.stderr_text())
            self.assertTrue(result['dropped']['reverb'].endswith('reverb.wav'))
            self.assertEqual(set(result['tracks']), {'vocal', 'instrumental', 'original'})
            names = os.listdir(result['work_dir'])
            self.assertFalse(any('和声' in name or 'harmony' in name for name in names))
            self.assertTrue(os.path.isfile(os.path.join(result['work_dir'], '.complete')))

    def test_malicious_pickle_does_not_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, 'pwned')
            model = Path(tmp) / 'evil.pth'

            class Boom:
                def __reduce__(self):
                    return (os.system, ('touch %s' % marker,))

            with open(model, 'wb') as handle:
                pickle.dump(Boom(), handle)
            digest = hashlib.sha256(model.read_bytes()).hexdigest()
            cfg = _ready(tmp)
            body = json.loads(cfg.read_text(encoding='utf-8'))
            body['convert']['model_path'] = str(model)
            body['convert']['model_sha256'] = digest
            cfg.write_text(json.dumps(body), encoding='utf-8')
            import_marker = os.path.join(tmp, 'imported')
            proc = EntryProc(
                ['--config', str(cfg)],
                _env(tmp, OKCOVER_IMPORT_MARKER=import_marker),
                tmp,
            )
            code = proc.wait(10)
            self.assertEqual(code, 1)
            self.assertEqual(_last(proc)['error_code'], 'MODEL_UNSAFE')
            self.assertFalse(os.path.exists(marker))
            self.assertFalse(os.path.exists(import_marker))

    def test_not_rvc_and_stale_weight_and_backend_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp)
            stale = Path(tmp) / 'rvc' / 'rvc_webui' / 'assets' / 'weights' / 'model.pth'
            stale.parent.mkdir(parents=True)
            stale.write_bytes(b'old')
            weight_root = Path(tmp) / 'weight-root'
            weight_root.mkdir()
            (weight_root / 'model.pth').write_bytes(b'old2')
            proc = EntryProc(
                ['--config', str(cfg)],
                _env(tmp, weight_root=str(weight_root)),
                tmp,
            )
            code = proc.wait(10)
            self.assertEqual(code, 0, proc.stderr_text())
            self.assertFalse(stale.exists())
            self.assertFalse((weight_root / 'model.pth').exists())
            backend = json.loads((Path(tmp) / 'okc_backend_config.json').read_text(encoding='utf-8'))
            self.assertNotIn('task_id', backend)
            self.assertEqual(backend['deep_debug_enabled'], False)
            self.assertFalse(list(Path(tmp).glob('*rvc_params.json')))

    def test_plain_dict_is_not_rvc(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / 'plain.pth'
            with open(model, 'wb') as handle:
                pickle.dump({'hello': 1}, handle)
            digest = hashlib.sha256(model.read_bytes()).hexdigest()
            cfg = _ready(tmp)
            body = json.loads(cfg.read_text(encoding='utf-8'))
            body['convert']['model_path'] = str(model)
            body['convert']['model_sha256'] = digest
            cfg.write_text(json.dumps(body), encoding='utf-8')
            proc = EntryProc(['--config', str(cfg)], _env(tmp), tmp)
            self.assertEqual(proc.wait(10), 1)
            self.assertEqual(_last(proc)['error_code'], 'MODEL_NOT_RVC')

    def test_builtin_forces_native_unavailable_without_warn(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, result, proc = _run(tmp, 'report-native', separator='builtin')
            self.assertEqual(code, 1)
            self.assertIn('okcover forced builtin', result['error'])
            self.assertNotIn('"type":"log"', proc.stdout_text())

    def test_native_fallback_warns_and_reports_builtin(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, result, proc = _run(tmp, 'native-fallback', separator='msst-native')
            self.assertEqual(code, 0, proc.stderr_text())
            self.assertEqual(result['separator'], 'builtin')
            logs = [json.loads(line) for line in proc.stdout_text().splitlines() if '"log"' in line]
            self.assertTrue(any(item.get('type') == 'log' and item.get('level') == 'warn' for item in logs))

    def test_encrypted_extension_is_source_unreadable(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp, suffix='.ncm')
            proc = EntryProc(['--config', str(cfg)], _env(tmp), tmp)
            self.assertEqual(proc.wait(10), 1)
            result = _last(proc)
            self.assertEqual(result['error_code'], 'SOURCE_UNREADABLE')

    def test_ffmpeg_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp)
            os.remove(os.path.join(tmp, 'ffmpeg', 'bin', 'ffmpeg'))
            proc = EntryProc(['--config', str(cfg)], _env(tmp), tmp)
            self.assertEqual(proc.wait(10), 1)
            self.assertEqual(_last(proc)['error_code'], 'FFMPEG_MISSING')


class ClassifyTest(unittest.TestCase):
    def test_disk_full_and_zero_frames(self):
        verdict = judge({'status': 'error', 'error': '[Errno 28] No space left on device'})
        self.assertEqual(verdict.code, 'DISK_FULL')
        with tempfile.TemporaryDirectory() as tmp:
            empty = os.path.join(tmp, 'empty.wav')
            import wave
            with wave.open(empty, 'w') as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(44100)
                handle.writeframes(b'')
            vocal = os.path.join(tmp, 'vocal.wav')
            with wave.open(vocal, 'w') as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(44100)
                handle.writeframes(b'\x00\x00' * 8)
            verdict = judge({
                'status': 'success',
                'msst_outputs': {'song': {'伴奏': vocal, '原唱': vocal}},
                'svc_outputs': [{'status': 'success', 'svc_output_path': empty}],
            })
            self.assertEqual(verdict.code, 'SVC_FAILED')


class HookTest(unittest.TestCase):
    def test_tqdm_emits_separate_progress(self):
        sys.path.insert(0, str(FAKE))
        import msst.utils as utils
        class Sink:
            def __init__(self):
                self.events = []

            def write(self, text):
                if text.strip():
                    self.events.append(json.loads(text))

            def flush(self):
                return None

        sink = Sink()

        class Pipeline:
            def _convert_to_wav(self, *_a, **_k):
                return None

            def _run_msst(self, *_a, **_k):
                bar = utils.tqdm(total=4)
                bar.update(2)

            def _save_msst_outputs(self, *_a, **_k):
                return None

            def _run_svc(self, *_a, **_k):
                return None

        module = type('M', (), {'ProcessPipeline': Pipeline})
        state = HookState('builtin')
        install(module, sink, state)
        Pipeline()._run_msst()
        pcts = [item['pct'] for item in sink.events if item['type'] == 'progress']
        self.assertEqual(pcts, [0, 50, 100])


class EquivalenceTest(unittest.TestCase):
    def test_diff_trees_and_d11_is_blocked(self):
        self.assertEqual(D11_STATUS, 'deferred-to-j1')
        with tempfile.TemporaryDirectory() as tmp:
            left = Path(tmp) / 'a'
            right = Path(tmp) / 'b'
            left.mkdir()
            right.mkdir()
            (left / 'same.wav').write_bytes(b'xyz')
            (right / 'same.wav').write_bytes(b'xyz')
            (left / 'diff.wav').write_bytes(b'1')
            (right / 'diff.wav').write_bytes(b'2')
            self.assertEqual(diff_trees(str(left), str(right)), ['diff.wav'])


if __name__ == '__main__':
    unittest.main()
