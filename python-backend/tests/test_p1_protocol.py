import hashlib
import json
import os
import pickle
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from okcover.protocol import hello_payload
from okcover.watchdog import is_alive, list_descendants

# P1：假 ProcessPipeline 的协议行必须和快照一致，cancel 后 1 秒内子孙进程退出。

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'okcover_entry.py'
FAKE = Path(__file__).resolve().parent / 'fake_pb'
SNAP = Path(__file__).resolve().parent / 'snapshots' / 'p1_happy.jsonl'


def _config(path, mode='library', separator='builtin', model='model.pth', sha='a' * 64, src='in.wav', key=0, f0='rmvpe', deep=None, index=None, suffix='.wav'):
    source = src if suffix == '.wav' else str(Path(src).with_suffix(suffix))
    if suffix != '.wav':
        Path(source).write_bytes(Path(src).read_bytes() if Path(src).exists() else b'x')
    body = {
        'schema_version': 2,
        'input_files': [source],
        'output_dir': str(Path(path).parent / 'pb-out'),
        'device': 'cuda',
        'separate': {'mode': mode, 'separator': separator},
        'convert': {
            'model_path': model,
            'model_sha256': sha,
            'index_path': index,
            'key': key,
            'f0_method': f0,
            'rvc': {'index_rate': 0.72, 'rms_mix_rate': 0.5, 'protect': 0.28, 'filter_radius': 4},
            'deep': deep,
        },
        'finalize': {
            'work_dir': str(Path(path).parent / 'work' / '示例 - 夜航'),
            'title': '夜航',
            'artist': '示例',
            'lyrics_path': None,
            'source_song_id': 'song',
            'model_id': 'model',
        },
    }
    path.write_text(json.dumps(body), encoding='utf-8')
    return body


def _ready(tmp, **overrides):
    root = Path(tmp)
    model = root / 'model.pth'
    with open(model, 'wb') as handle:
        pickle.dump({'weight': {'n': 1}, 'config': [320, 32]}, handle)
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    src = root / 'in.wav'
    src.write_bytes(b'present')
    ffmpeg = root / 'ffmpeg' / 'bin' / 'ffmpeg'
    ffmpeg.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg.write_bytes(b'')
    cfg = root / 'okc_config.json'
    _config(cfg, model=str(model), sha=digest, src=str(src), **overrides)
    return cfg


class EntryProc:
    def __init__(self, args, env, cwd):
        self.lines = []
        self.err = []
        self.proc = subprocess.Popen(
            [sys.executable, '-u', '-X', 'utf8', str(ENTRY), *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
        )
        self._out = threading.Thread(target=self._read_out, daemon=True)
        self._err = threading.Thread(target=self._read_err, daemon=True)
        self._out.start()
        self._err.start()

    def _read_out(self):
        for raw in self.proc.stdout:
            self.lines.append(raw.decode('utf-8'))

    def _read_err(self):
        for raw in self.proc.stderr:
            self.err.append(raw.decode('utf-8', errors='replace'))

    def wait(self, timeout):
        code = self.proc.wait(timeout=timeout)
        self._out.join(timeout=2)
        self._err.join(timeout=2)
        self._close()
        return code

    def _close(self):
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if pipe is not None and not pipe.closed:
                pipe.close()

    def stdout_text(self):
        return ''.join(self.lines)

    def stderr_text(self):
        return ''.join(self.err)


def _env(job, **extra):
    env = os.environ.copy()
    env['OKCOVER_PB_PATH'] = str(FAKE)
    env['OKCOVER_JOB_DIR'] = job
    env['OKCOVER_BACKEND_DIR'] = job
    env['PYTHONIOENCODING'] = 'utf-8'
    env.pop('OKCOVER_FIXTURE', None)
    env.pop('OKCOVER_IMPORT_MARKER', None)
    env.update(extra)
    return env


class ProtocolTest(unittest.TestCase):
    def test_happy_path_matches_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            job = tmp
            cfg = _ready(tmp)
            marker = os.path.join(tmp, 'prepare-called')
            proc = EntryProc(
                ['--config', str(cfg)],
                _env(job, OKCOVER_PREPARE_MARKER=marker),
                tmp,
            )
            code = proc.wait(10)
            self.assertEqual(code, 0, proc.stderr_text())
            text = proc.stdout_text().replace(job, '<job>')
            lines = [line for line in text.splitlines() if line]
            self.assertTrue(lines, proc.stderr_text())
            self.assertEqual(json.loads(lines[0]), hello_payload())
            body = '\n'.join(lines[1:]) + '\n'
            if os.environ.get('OKCOVER_SNAPSHOT_UPDATE') == '1':
                SNAP.parent.mkdir(parents=True, exist_ok=True)
                SNAP.write_text(body, encoding='utf-8')
            golden = SNAP.read_text(encoding='utf-8')
            self.assertEqual(body, golden)
            err = proc.stderr_text()
            out = proc.stdout_text()
            for leak in ('PB_STDOUT_LEAK', 'PB_PRINT_LEAK', 'CHILD_FD1'):
                self.assertIn(leak, err)
                self.assertNotIn(leak, out)
            self.assertNotIn('API_RESULT_START', out)
            self.assertFalse(os.path.exists(os.path.join(tmp, 'prepare-called')))
            parsed = [json.loads(line) for line in lines]
            self.assertEqual([item['type'] for item in parsed].count('result'), 1)
            self.assertEqual(parsed[-1]['type'], 'result')
            self.assertEqual(parsed[-1]['status'], 'success')

    def test_cancel_kills_descendants_within_one_second(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp)
            proc = EntryProc(
                ['--config', str(cfg)],
                _env(tmp, OKCOVER_FIXTURE='spawn-sleep'),
                tmp,
            )
            deadline = time.monotonic() + 5
            kids = []
            while time.monotonic() < deadline:
                kids = [pid for pid in list_descendants(proc.proc.pid) if is_alive(pid)]
                if kids:
                    time.sleep(0.15)
                    kids = [pid for pid in list_descendants(proc.proc.pid) if is_alive(pid)]
                    if kids:
                        break
                time.sleep(0.02)
            self.assertTrue(kids, '假管道没有拉起子孙进程：%s' % proc.stderr_text())
            started = time.monotonic()
            proc.proc.stdin.write(b'{"type":"cancel"}\n')
            proc.proc.stdin.flush()
            gone = False
            while time.monotonic() - started < 1.0:
                alive = [pid for pid in list_descendants(proc.proc.pid) if is_alive(pid)]
                if not alive and proc.proc.poll() is not None:
                    gone = True
                    break
                time.sleep(0.02)
            elapsed = time.monotonic() - started
            code = proc.proc.poll()
            if code is None:
                proc.proc.kill()
                proc.wait(5)
            else:
                proc.wait(5)
            self.assertTrue(gone, '取消后 %.3fs 仍有子孙或入口未退出' % elapsed)
            self.assertLessEqual(elapsed, 1.0)
            self.assertEqual(code, 130)
            parsed = [json.loads(line) for line in proc.stdout_text().splitlines() if line]
            results = [item for item in parsed if item.get('type') == 'result']
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]['error_code'], 'CANCELLED')

    def test_selftest_does_not_import_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, 'imported')
            env = os.environ.copy()
            env['OKCOVER_PB_PATH'] = str(FAKE)
            env['OKCOVER_IMPORT_MARKER'] = marker
            env['PYTHONIOENCODING'] = 'utf-8'
            proc = subprocess.run(
                [sys.executable, '-u', '-X', 'utf8', str(ENTRY), '--selftest'],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertFalse(os.path.exists(marker))
            lines = [json.loads(line) for line in proc.stdout.splitlines() if line]
            self.assertEqual(lines[0]['type'], 'hello')
            self.assertEqual(lines[0]['protocol'], 2)
            self.assertEqual(lines[-1]['type'], 'result')
            self.assertEqual(lines[-1]['status'], 'error')
            self.assertEqual(lines[-1]['error_code'], 'COMPONENT_MISSING')
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn('PB_STDOUT_LEAK', proc.stdout)

    def test_pipeline_error_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _ready(tmp)
            proc = EntryProc(
                ['--config', str(cfg)],
                _env(tmp, OKCOVER_FIXTURE='error'),
                tmp,
            )
            code = proc.wait(10)
            self.assertEqual(code, 1)
            result = json.loads(proc.stdout_text().strip().splitlines()[-1])
            self.assertEqual(result['status'], 'error')
            self.assertEqual(result['error_code'], 'INTERNAL')

    def test_bad_schema_is_config_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / 'okc_config.json'
            cfg.write_text('{"schema_version": 1}', encoding='utf-8')
            proc = EntryProc(['--config', str(cfg)], _env(tmp), tmp)
            code = proc.wait(10)
            self.assertEqual(code, 1)
            result = json.loads(proc.stdout_text().strip().splitlines()[-1])
            self.assertEqual(result['error_code'], 'CONFIG_INVALID')
            self.assertFalse(os.path.exists(os.path.join(tmp, 'imported')))


if __name__ == '__main__':
    unittest.main()
