import json
import os
import signal
import sys
import threading

# 看门狗：stdin 收到 cancel 或 EOF 时杀掉全部子孙进程，再写 CANCELLED 并退出 130。


class Gate:
    def __init__(self):
        self._lock = threading.Lock()
        self.done = False

    def finish(self, emit_fn, code):
        with self._lock:
            if self.done:
                return False
            self.done = True
        emit_fn()
        if code == 130:
            os._exit(130)
        return True


def start(on_cancel):
    def loop():
        try:
            while True:
                line = sys.stdin.readline()
                if line == '':
                    on_cancel('stdin-eof')
                    return
                text = line.strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and msg.get('type') == 'cancel':
                    on_cancel('cancel')
                    return
        except Exception:
            on_cancel('stdin-error')

    thread = threading.Thread(target=loop, name='okcover-watchdog', daemon=True)
    thread.start()
    return thread


def list_descendants(root_pid):
    try:
        import psutil
    except ImportError:
        psutil = None
    if psutil is not None:
        try:
            proc = psutil.Process(root_pid)
            return [child.pid for child in proc.children(recursive=True)]
        except Exception:
            pass
    if not os.path.isdir('/proc'):
        return []
    return _proc_descendants(root_pid)


def kill_descendants(root_pid):
    pids = list_descendants(root_pid)
    for pid in reversed(pids):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return pids


def _proc_descendants(root_pid):
    children = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        pid = int(name)
        ppid = _ppid(pid)
        if ppid is None:
            continue
        children.setdefault(ppid, []).append(pid)
    found = []
    stack = [root_pid]
    seen = {root_pid}
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            if child in seen:
                continue
            seen.add(child)
            found.append(child)
            stack.append(child)
    return found


def _ppid(pid):
    try:
        with open('/proc/%d/status' % pid, 'r', encoding='utf-8', errors='replace') as handle:
            for line in handle:
                if line.startswith('PPid:'):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


def is_alive(pid):
    """僵尸算已经退出。取消验收只要求进程不再干活。"""
    if not os.path.isdir('/proc'):
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    try:
        with open('/proc/%d/stat' % pid, 'r', encoding='utf-8', errors='replace') as handle:
            stat = handle.read()
    except OSError:
        return False
    mark = stat.rfind(')')
    if mark < 0 or mark + 2 >= len(stat):
        return False
    return stat[mark + 2] not in ('Z', 'X')
