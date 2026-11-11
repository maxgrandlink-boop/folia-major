import os

from okcover.protocol import emit, hello_payload, result_error, result_success

# --selftest：不导入 process_pipeline（它会改 torch.load 并 chdir）。失败码 COMPONENT_MISSING。

# 清单（P6）落地前的最小文件集。ffmpeg 在 Windows 叫 ffmpeg.exe，其余平台叫 ffmpeg。
_REQUIRED = ('process_pipeline.py', 'api_wrapper.py')


def run(proto, backend_dir):
    emit(proto, hello_payload())
    problems = []
    torch_mod = _import_torch()
    if torch_mod is None:
        problems.append('torch 导入失败')
    else:
        version = getattr(torch_mod, '__version__', '')
        if '2.7.1' not in version or 'cu128' not in version:
            problems.append('torch 版本不是 2.7.1+cu128：%s' % version)
        try:
            cuda_ok = bool(torch_mod.cuda.is_available())
        except Exception as exc:
            cuda_ok = False
            problems.append('CUDA 查询失败：%s' % exc)
        if not cuda_ok:
            problems.append('CUDA 不可用')
    for rel in _REQUIRED:
        path = os.path.join(backend_dir, rel)
        if not os.path.isfile(path):
            problems.append('缺少 %s' % rel)
    if _ffmpeg(backend_dir) is None:
        problems.append('缺少 ffmpeg/bin/ffmpeg')
    if problems:
        emit(proto, result_error('library', 'COMPONENT_MISSING', '; '.join(problems)))
        return 1
    emit(proto, result_success('library', 'builtin', {'status': 'success', 'svc_outputs': [], 'msst_outputs': {}}))
    return 0


def _import_torch():
    try:
        import torch
    except Exception:
        return None
    return torch


def _ffmpeg(backend_dir):
    bindir = os.path.join(backend_dir, 'ffmpeg', 'bin')
    for name in ('ffmpeg.exe', 'ffmpeg'):
        path = os.path.join(bindir, name)
        if os.path.isfile(path):
            return path
    return None
