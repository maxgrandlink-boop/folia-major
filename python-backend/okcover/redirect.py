import os
import sys

# 在导入 PB 之前把 fd 1 指到 stderr。PB 导入时就 print，子进程继承 fd，只改 sys.stdout 挡不住。


def install():
    """复制原始 stdout 给协议行，再让 fd 1 和 sys.stdout 都写到 stderr。"""
    try:
        sys.stdout.flush()
    except Exception:
        pass
    try:
        sys.stderr.flush()
    except Exception:
        pass
    saved = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = open(1, 'w', encoding='utf-8', errors='backslashreplace', buffering=1, closefd=False)
    return open(saved, 'w', encoding='utf-8', errors='backslashreplace', buffering=1, closefd=True)
