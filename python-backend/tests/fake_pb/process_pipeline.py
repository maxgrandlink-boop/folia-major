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
        return {}

    def _save_msst_outputs(self, msst_results, msst_method):
        return None

    def _run_svc(self, input_vocal_paths, svc_config):
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
        self._run_svc(['tmp/vocal.wav'], {})
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
