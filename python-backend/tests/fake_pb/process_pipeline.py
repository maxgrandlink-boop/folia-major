import logging
import os
import subprocess
import sys
import time
import wave

# 假 ProcessPipeline。导入时往 fd 1 写字并 chdir，用来证明入口在导入前做了 fd 级重定向。

os.write(1, b'PB_STDOUT_LEAK\n')
print('PB_PRINT_LEAK', flush=True)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

_MARKER = os.environ.get('OKCOVER_IMPORT_MARKER')
if _MARKER:
    with open(_MARKER, 'w', encoding='utf-8') as _handle:
        _handle.write('imported\n')


def _write_wav(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'w') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(44100)
        handle.writeframes(b'\x00\x00' * 441)


def _materialize():
    root = os.environ.get('OKCOVER_JOB_DIR')
    if not root:
        return 'out/vocal.wav', 'out/inst.wav', 'out/orig.wav'
    vocal = os.path.join(root, 'out', 'vocal.wav')
    inst = os.path.join(root, 'out', 'inst.wav')
    orig = os.path.join(root, 'out', 'orig.wav')
    for path in (vocal, inst, orig):
        _write_wav(path)
    return vocal, inst, orig


def _outputs():
    root = os.environ.get('OKCOVER_JOB_DIR')
    if not root:
        return {
            'status': 'success',
            'msst_outputs': {'song': {'伴奏': 'out/inst.wav', '原唱': 'out/orig.wav'}},
            'svc_outputs': [{
                'original_input_path': 'out/vocal.wav',
                'svc_output_path': 'out/vocal.wav',
                'status': 'success',
            }],
        }
    vocal = os.path.join(root, 'out', 'vocal.wav')
    inst = os.path.join(root, 'out', 'inst.wav')
    orig = os.path.join(root, 'out', 'orig.wav')
    for path in (vocal, inst, orig):
        _write_wav(path)
    return {
        'status': 'success',
        'msst_outputs': {'song': {'伴奏': inst, '原唱': orig}},
        'svc_outputs': [{
            'original_input_path': vocal,
            'svc_output_path': vocal,
            'status': 'success',
        }],
    }


class ProcessPipeline:
    def __init__(self):
        pass

    def _convert_to_wav(self, input_file, output_dir):
        return input_file

    def _run_msst(self, input_files, msst_method, device, key=0):
        fixture = os.environ.get('OKCOVER_FIXTURE')
        if fixture in ('report-native', 'native-fallback'):
            from native_msst_bridge import diagnose_native_msst_status, run_native_msst
            ok, msg = diagnose_native_msst_status()
            if fixture == 'report-native':
                raise RuntimeError('native:%s:%s' % (ok, msg))
            if ok:
                good, _results, message = run_native_msst()
                if not good:
                    logging.getLogger('ProcessPipeline').warning(
                        'msst2 原生预设分离失败，回退内置流程: %s' % message,
                    )
            else:
                logging.getLogger('ProcessPipeline').warning(
                    'msst2 原生不可用，回退内置 Kim 流程: %s' % msg,
                )
        return {}

    def _save_msst_outputs(self, msst_results, msst_method):
        return None

    def _run_svc(self, input_vocal_paths, svc_config):
        if os.environ.get('OKCOVER_FIXTURE') in ('raise-cuda', 'swallow-cuda'):
            raise RuntimeError('CUDA out of memory')
        return []

    def process(self, config_path):
        del config_path
        subprocess.run(
            [sys.executable, '-c', 'import os; os.write(1, b"CHILD_FD1\\n")'],
            check=False,
        )
        fixture = os.environ.get('OKCOVER_FIXTURE')
        if fixture == 'spawn-sleep':
            _spawn_sleeper()
            time.sleep(60)
        if fixture == 'error':
            return {'status': 'error', 'error': 'fixture error', 'svc_outputs': [], 'msst_outputs': {}}
        if fixture == 'raise-import':
            raise ImportError('fixture import failure')
        self._convert_to_wav('in.wav', 'tmp')
        self._run_msst(['in.wav'], 'library', 'cuda', 0)
        self._save_msst_outputs({}, 'library')
        try:
            self._run_svc(['tmp/vocal.wav'], {})
        except Exception as exc:
            if fixture == 'swallow-cuda':
                return {
                    'status': 'error',
                    'error': str(exc),
                    'svc_outputs': [],
                    'msst_outputs': {},
                }
            raise
        vocal, inst, orig = _materialize()
        if fixture == 'svc-all-error':
            return {
                'status': 'success',
                'msst_outputs': {'song': {'伴奏': inst, '原唱': orig}},
                'svc_outputs': [{
                    'original_input_path': vocal,
                    'svc_output_path': None,
                    'status': 'error',
                    'message': 'svc failed',
                }],
            }
        if fixture == 'svc-cuda':
            return {
                'status': 'success',
                'msst_outputs': {'song': {'伴奏': inst, '原唱': orig}},
                'svc_outputs': [{
                    'original_input_path': vocal,
                    'svc_output_path': None,
                    'status': 'error',
                    'message': 'CUDA out of memory. Tried to allocate 20 MiB',
                }],
            }
        if fixture == 'with-reverb':
            reverb = os.path.join(os.path.dirname(inst), 'reverb.wav')
            _write_wav(reverb)
            return {
                'status': 'success',
                'msst_outputs': {'song': {'伴奏': inst, '原唱': orig, '和声': reverb}},
                'svc_outputs': [{
                    'original_input_path': vocal,
                    'svc_output_path': vocal,
                    'status': 'success',
                }],
            }
        return _outputs()


def _spawn_sleeper():
    code = (
        'import os, time\n'
        'pid = os.fork()\n'
        'if pid == 0:\n'
        '    time.sleep(60)\n'
        '    os._exit(0)\n'
        'time.sleep(60)\n'
    )
    subprocess.Popen([sys.executable, '-c', code])
