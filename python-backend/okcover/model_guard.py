import hashlib
import os
import pickle

from okcover.errors import OkcError

# 用户模型先用 weights_only=True 读一次。读不出即 MODEL_UNSAFE，没有放宽重试。


def check_model(cfg, backend_dir):
    path = cfg['model_path']
    if not os.path.isfile(path):
        raise OkcError('MODEL_UNAVAILABLE', '模型文件不存在')
    digest = sha256_file(path)
    if digest.lower() != cfg['model_sha256'].lower():
        raise OkcError('MODEL_CHANGED', '模型 sha256 与导入时不一致')
    try:
        loaded = load_weights_only(path)
    except UnsafeModel as exc:
        raise OkcError('MODEL_UNSAFE', str(exc)) from exc
    if not _is_rvc(loaded):
        raise OkcError('MODEL_NOT_RVC', '模型没有 weight 和 config 列表')
    drop_stale_weight_copy(backend_dir, path)
    return loaded


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class UnsafeModel(Exception):
    pass


def load_weights_only(path):
    """优先 torch.load(weights_only=True)。没有 torch 时用只允许基本类型的 Unpickler。两种都不回退到 weights_only=False。"""
    torch = _import_torch()
    if torch is not None:
        try:
            return torch.load(path, map_location='cpu', weights_only=True)
        except Exception as exc:
            raise UnsafeModel('weights_only 读不出：%s' % exc) from exc
    try:
        with open(path, 'rb') as handle:
            return _Restricted(handle).load()
    except Exception as exc:
        raise UnsafeModel('weights_only 读不出：%s' % exc) from exc


def drop_stale_weight_copy(backend_dir, model_path):
    """rvc/infer.py 同名不覆盖。先删掉旧副本，PB 才会复制这次的文件。"""
    name = os.path.basename(model_path)
    targets = [os.path.join(backend_dir, 'rvc', 'rvc_webui', 'assets', 'weights', name)]
    weight_root = os.environ.get('weight_root')
    if weight_root:
        targets.append(os.path.join(weight_root, name))
    for target in targets:
        if os.path.isfile(target):
            os.remove(target)


def _is_rvc(obj):
    return isinstance(obj, dict) and 'weight' in obj and isinstance(obj.get('config'), (list, tuple))


def _import_torch():
    try:
        import torch
    except Exception:
        return None
    return torch


_SAFE = {
    'builtins': {
        'dict', 'list', 'tuple', 'set', 'frozenset', 'int', 'float', 'bool', 'str',
        'bytes', 'bytearray', 'complex',
    },
    'collections': {'OrderedDict'},
}


class _Restricted(pickle.Unpickler):
    def find_class(self, module, name):
        allowed = _SAFE.get(module)
        if allowed and name in allowed:
            if module == 'builtins':
                return getattr(__import__('builtins'), name)
            from collections import OrderedDict
            return OrderedDict
        raise pickle.UnpicklingError('refused global %s.%s' % (module, name))
