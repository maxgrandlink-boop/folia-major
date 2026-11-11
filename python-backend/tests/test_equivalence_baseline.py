import inspect
import json
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from okcover import finalize
from okcover.classify import judge
from okcover.config import (
    F0_METHODS,
    NEVER_KEYS,
    _CHILD_ENV,
    _SCRUB_ENV,
    find_ffmpeg,
    index_rate_from_formant_shift,
    index_rate_from_formant_slider,
    load,
    scrub_network_env,
    write_backend,
)
from okcover.equivalence import (
    D11_MACHINE,
    D11_STATUS,
    NATIVE_PRESET_STEPS,
    PB_PAREN_NAMES,
    POINTS,
    PROGRESS_STAGES,
    WORKBENCH_PROGRESS_POINTS,
    point,
)
from okcover.finalize import track_filenames

# 分析 v4 §8 的 24 条等价点，每条一个测试。

PKG = Path(__file__).resolve().parents[1] / 'okcover'


def _sources():
    parts = []
    for path in sorted(PKG.glob('*.py')):
        if path.name == 'equivalence.py':
            continue
        parts.append(path.read_text(encoding='utf-8'))
    return '\n'.join(parts)


def _wav(path):
    with wave.open(path, 'w') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(44100)
        handle.writeframes(b'\x00\x00' * 8)


def _raw(vocal, inst, extra_svc=()):
    return {
        'status': 'success',
        'msst_outputs': {'song': {'伴奏': inst, '原唱': inst}},
        'svc_outputs': [{'status': 'success', 'svc_output_path': vocal}, *extra_svc],
    }


class BaselineTest(unittest.TestCase):
    def test_01_entry_calls_pipeline_not_api_wrapper(self):
        self.assertEqual(point(1)['choice'], 'design-4.4')
        job = (PKG / 'job.py').read_text(encoding='utf-8')
        self.assertIn('ProcessPipeline', job)
        self.assertNotIn('api_wrapper', job)

    def test_02_backend_config_stays_in_the_job_dir(self):
        self.assertEqual(point(2)['choice'], 'design-4.4')
        self.assertTrue(point(2)['warning'])
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / 'okc_config.json'
            cfg_path.write_text(json.dumps(_sample()), encoding='utf-8')
            written = write_backend(load(str(cfg_path)), str(cfg_path))
            self.assertTrue(written.endswith('okc_backend_config.json'))
            self.assertTrue(os.path.isfile(written))
            self.assertFalse((Path(tmp) / 'tmp_api_config.json').exists())
        self.assertNotIn('tmp_api_config', _sources())

    def test_03_scrub_matches_the_patch_except_path(self):
        self.assertEqual(point(3)['choice'], 'workbench')
        keys = list(_SCRUB_ENV) + list(_CHILD_ENV) + ['PATH']
        saved = {key: os.environ.get(key) for key in keys}
        os.environ['VIRTUAL_ENV'] = 'venv'
        os.environ['CONDA_PREFIX'] = 'conda'
        os.environ['QT_PLUGIN_PATH'] = 'qt'
        os.environ['PYTHONPATH'] = 'somewhere'
        try:
            scrub_network_env()
            for key in ('VIRTUAL_ENV', 'CONDA_PREFIX', 'QT_PLUGIN_PATH', 'PYTHONPATH', 'PYTHONHOME'):
                self.assertNotIn(key, os.environ)
            for key, value in _CHILD_ENV.items():
                self.assertEqual(os.environ[key], value)
            self.assertEqual(os.environ.get('PATH'), saved.get('PATH'))
            self.assertNotIn('System32', os.environ.get('PATH') or '')
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_04_missing_component_is_selftest_not_a_chinese_toast(self):
        self.assertEqual(point(4)['choice'], 'design-4.4')
        text = (PKG / 'selftest.py').read_text(encoding='utf-8')
        self.assertIn('COMPONENT_MISSING', text)
        self.assertNotIn('本地制作组件未就绪', text)
        self.assertNotIn('workenv', text)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(find_ffmpeg(tmp))

    def test_05_real_keys_and_index_rate_formulas(self):
        self.assertEqual(point(5)['choice'], 'workbench')
        self.assertEqual(index_rate_from_formant_slider(72), 0.72)
        self.assertEqual(index_rate_from_formant_slider(0), 0.0)
        self.assertEqual(index_rate_from_formant_slider(100), 1.0)
        self.assertNotEqual(index_rate_from_formant_slider(72), 72)
        self.assertEqual(index_rate_from_formant_shift(None), 0.72)
        self.assertEqual(index_rate_from_formant_shift(0.5), 0.5)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'okc_config.json'
            path.write_text(json.dumps(_sample()), encoding='utf-8')
            translated = __import__('okcover.config', fromlist=['translate']).translate(load(str(path)))
        for key in ('use_msst', 'msst_method', 'key', 'rms_mix_rate', 'index_rate', 'filter_radius', 'protect'):
            self.assertIn(key, translated)
        for key in ('vol_ratio', 'mute_ratio', 'formant_shift_key', 'formant_slider', 'formant_shift'):
            self.assertNotIn(key, translated)

    def test_06_no_api_result_block(self):
        self.assertEqual(point(6)['choice'], 'design-4.4')
        self.assertNotIn('API_RESULT_START', _sources())
        self.assertNotIn('API_RESULT_END', _sources())

    def test_07_progress_is_stage_pct_not_five_points(self):
        self.assertEqual(point(7)['choice'], 'design-4.4')
        self.assertTrue(point(7)['warning'])
        self.assertEqual(PROGRESS_STAGES, ('convert_input', 'separate', 'save', 'convert_voice', 'finalize'))
        self.assertEqual(WORKBENCH_PROGRESS_POINTS, (2, 10, 40, 70, 100))
        hooks = (PKG / 'hooks.py').read_text(encoding='utf-8')
        job = (PKG / 'job.py').read_text(encoding='utf-8')
        for stage in ('convert_input', 'separate', 'save', 'convert_voice'):
            self.assertIn("'%s'" % stage, hooks)
        self.assertIn("'finalize'", job)
        self.assertNotIn('MSST Stage', hooks + job)
        self.assertNotIn('RVC 模型加载', hooks + job)

    def test_08_every_svc_output_must_succeed(self):
        self.assertEqual(point(8)['choice'], 'workbench')
        self.assertTrue(point(8)['warning'])
        with tempfile.TemporaryDirectory() as tmp:
            first = os.path.join(tmp, 'a.wav')
            second = os.path.join(tmp, 'b.wav')
            _wav(first)
            _wav(second)
            mixed = _raw(first, first, ({
                'status': 'error',
                'message': 'second failed',
                'svc_output_path': None,
            },))
            self.assertEqual(judge(mixed).code, 'SVC_FAILED')
            both = _raw(first, first, ({'status': 'success', 'svc_output_path': second},))
            verdict = judge(both)
            self.assertTrue(verdict.ok)
            self.assertEqual(verdict.vocal, first)
            empty = _raw(first, first)
            empty['svc_outputs'] = []
            self.assertEqual(judge(empty).code, 'SVC_FAILED')

    def test_09_cancel_still_emits_a_result(self):
        self.assertEqual(point(9)['choice'], 'design-4.4')
        self.assertIn("'CANCELLED'", (PKG / 'job.py').read_text(encoding='utf-8'))
        self.assertIn('130', (PKG / 'watchdog.py').read_text(encoding='utf-8'))

    def test_10_presets_stay_in_pb_and_aggressive_is_rejected(self):
        self.assertEqual(point(10)['choice'], 'design-4.4')
        self.assertEqual(NATIVE_PRESET_STEPS['library'], ('big_beta5e',))
        self.assertEqual(NATIVE_PRESET_STEPS['normal'][0], 'big_beta5e')
        self.assertIn('dereverb', NATIVE_PRESET_STEPS['normal'])
        self.assertIn('karaoke', NATIVE_PRESET_STEPS['aggressive'])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'okc_config.json'
            body = _sample()
            body['separate']['mode'] = 'aggressive'
            path.write_text(json.dumps(body), encoding='utf-8')
            with self.assertRaises(Exception) as caught:
                load(str(path))
            self.assertEqual(caught.exception.code, 'CONFIG_INVALID')

    def test_11_reverb_is_dropped(self):
        self.assertEqual(point(11)['choice'], 'design-4.4')
        with tempfile.TemporaryDirectory() as tmp:
            vocal = os.path.join(tmp, 'v.wav')
            _wav(vocal)
            raw = _raw(vocal, vocal)
            raw['msst_outputs']['song']['和声'] = vocal
            verdict = judge(raw)
            self.assertTrue(verdict.ok)
            self.assertEqual(verdict.reverb, vocal)
        for name in track_filenames('示例 - 夜航').values():
            self.assertNotIn('和声', name)
            self.assertNotIn('(', name)

    def test_12_f0_set_and_two_index_rate_sources(self):
        self.assertEqual(point(12)['choice'], 'workbench')
        self.assertTrue(point(12)['warning'])
        self.assertEqual(F0_METHODS, ('rmvpe', 'harvest', 'crepe', 'pm'))
        self.assertNotIn('fcpe', F0_METHODS)
        self.assertIn('f0_min', NEVER_KEYS)
        self.assertIn('f0_max', NEVER_KEYS)
        self.assertEqual(index_rate_from_formant_slider(80), 0.8)
        self.assertEqual(index_rate_from_formant_shift(None), 0.72)

    def test_13_work_names_have_no_parentheses(self):
        self.assertEqual(point(13)['choice'], 'design-4.4')
        names = track_filenames('示例 - 夜航')
        self.assertEqual(names['vocal'], '示例 - 夜航人声.wav')
        for name in names.values():
            self.assertNotIn('(', name)
        for legacy in PB_PAREN_NAMES:
            self.assertIn('(', legacy)

    def test_14_tracks_come_from_dict_keys_not_filenames(self):
        self.assertEqual(point(14)['choice'], 'design-4.4')
        with tempfile.TemporaryDirectory() as tmp:
            vocal = os.path.join(tmp, 'song(伴奏).wav')
            _wav(vocal)
            raw = {
                'status': 'success',
                'msst_outputs': {'song': {'人声': vocal}},
                'svc_outputs': [{'status': 'success', 'svc_output_path': vocal}],
            }
            self.assertEqual(judge(raw).code, 'SEPARATE_FAILED')

    def test_15_pitch_is_rubberband_on_the_instrumental_only(self):
        self.assertEqual(point(15)['choice'], 'workbench')
        body = inspect.getsource(finalize.build_work)
        self.assertIn('verdict.instrumental', body)
        self.assertIn("cfg['key']", body)
        self.assertEqual(body.count(', 0)'), 2)
        pitch = inspect.getsource(finalize._pitch)
        self.assertIn('rubberband=pitch=', pitch)
        self.assertNotIn('_adjust_pitch', inspect.getsource(finalize))

    def test_16_complete_is_last_and_only_three_tracks_are_aligned(self):
        self.assertEqual(point(16)['choice'], 'workbench')
        writer = inspect.getsource(finalize._write_folder)
        self.assertLess(writer.index('.cover_done'), writer.index('.complete'))
        self.assertIn('_align(vocal', inspect.getsource(finalize.build_work))
        self.assertIn('_align(original', inspect.getsource(finalize.build_work))
        manifest = finalize._manifest(_sample_loaded(), '示例 - 夜航', track_filenames('示例 - 夜航'))
        self.assertEqual(set(manifest['tracks']), {'vocal', 'instrument', 'original'})

    def test_17_manifest_does_not_invent_lufs(self):
        self.assertEqual(point(17)['choice'], 'workbench')
        manifest = finalize._manifest(_sample_loaded(), '示例 - 夜航', track_filenames('示例 - 夜航'))
        blob = json.dumps(manifest)
        for key in ('original_lufs', 'normalized_lufs', 'gain_db', 'peak_limited'):
            self.assertNotIn(key, blob)

    def test_18_no_windows_toast(self):
        self.assertEqual(point(18)['choice'], 'out-of-scope')
        self.assertTrue(point(18)['warning'])
        text = _sources().lower()
        self.assertNotIn('powershell', text)
        self.assertNotIn('豆苞 - 制作完成', _sources())

    def test_19_no_cloud_song_making(self):
        self.assertEqual(point(19)['choice'], 'out-of-scope')
        self.assertTrue(point(19)['warning'])
        text = _sources()
        self.assertNotIn('yzg.duoai.fun', text)
        self.assertNotIn('CloudSongWorker', text)
        self.assertNotIn("POST', '/jobs'", text)

    def test_20_no_jobs_protocol(self):
        self.assertEqual(point(20)['choice'], 'out-of-scope')
        self.assertNotIn('/jobs', _sources())
        self.assertNotIn('/health', _sources())

    def test_21_work_dir_is_not_prefixed_cloud(self):
        self.assertEqual(point(21)['choice'], 'out-of-scope')
        self.assertNotIn('云端-', _sources())
        self.assertFalse(track_filenames('示例 - 夜航')['vocal'].startswith('云端-'))

    def test_22_entry_does_not_handle_window_close(self):
        self.assertEqual(point(22)['choice'], 'out-of-scope')
        self.assertNotIn('closeEvent', _sources())

    def test_23_entry_does_not_install_components(self):
        self.assertEqual(point(23)['choice'], 'out-of-scope')
        text = _sources()
        self.assertNotIn('install_finished', text)
        self.assertNotIn('component_installer', text)

    def test_24_entry_does_not_run_doubao_startup(self):
        self.assertEqual(point(24)['choice'], 'out-of-scope')
        self.assertNotIn('doubao_startup', _sources())
        self.assertEqual(len(POINTS), 24)
        self.assertEqual([item['id'] for item in POINTS], list(range(1, 25)))
        self.assertEqual([item['id'] for item in POINTS if item['warning']], [2, 3, 7, 8, 12, 18, 19])

    def test_d11_byte_compare_waits_for_the_lab_machine(self):
        self.assertEqual(D11_STATUS, 'deferred-to-j1')
        self.assertEqual(D11_MACHINE, 'D:\\okchang-test')


def _sample():
    return {
        'schema_version': 2,
        'input_files': ['/song.wav'],
        'output_dir': '/out',
        'device': 'cuda',
        'separate': {'mode': 'normal', 'separator': 'builtin'},
        'convert': {
            'model_path': '/m.pth',
            'model_sha256': 'ab' * 32,
            'index_path': None,
            'key': 3,
            'f0_method': 'rmvpe',
            'rvc': {'index_rate': 0.72, 'rms_mix_rate': 0.5, 'protect': 0.28, 'filter_radius': 4},
            'deep': None,
        },
        'finalize': {
            'work_dir': '/work/示例 - 夜航',
            'title': '夜航',
            'artist': '示例',
            'lyrics_path': None,
            'source_song_id': 'song',
            'model_id': 'model',
        },
    }


def _sample_loaded():
    return {
        'mode': 'normal',
        'separator': 'builtin',
        'key': 3,
        'finalize': _sample()['finalize'],
    }


if __name__ == '__main__':
    unittest.main()
