import os

from okcover.errors import OkcError

# 成功判据（设计稿 4.4 先修 #3）。帧数 > 0 即通过，不看振幅：全静音夹具因此放行。

CUDA_NEEDLES = ('CUDA out of memory', 'cudaMalloc', 'CUDA error')


class Verdict:
    def __init__(self, ok, code=None, message=None, vocal=None, instrumental=None, original=None, reverb=None):
        self.ok = ok
        self.code = code
        self.message = message
        self.vocal = vocal
        self.instrumental = instrumental
        self.original = original
        self.reverb = reverb


def judge(raw, svc_exc=None):
    texts = _texts(raw, svc_exc)
    if _has_cuda(texts):
        return _fail('CUDA_OOM', 'CUDA out of memory')
    if _disk_full(svc_exc, texts):
        return _fail('DISK_FULL', 'no space left on device')
    if not isinstance(raw, dict):
        return _fail('SVC_FAILED', 'pipeline returned nothing')
    if raw.get('status') != 'success':
        return _fail(_status_code(texts), _joined(texts) or 'pipeline failed')
    instrumental, original, reverb = _msst(raw)
    if instrumental is None or original is None:
        return _fail('SEPARATE_FAILED', '没有伴奏或原唱')
    vocal = _vocal(raw)
    if vocal is None:
        return _fail('SVC_FAILED', '人声不满足成功判据')
    return Verdict(True, vocal=vocal, instrumental=instrumental, original=original, reverb=reverb)


def from_exception(exc):
    if isinstance(exc, OkcError):
        return _fail(exc.code, exc.message)
    if isinstance(exc, ImportError):
        return _fail('COMPONENT_MISSING', str(exc))
    texts = [str(exc)]
    if _has_cuda(texts):
        return _fail('CUDA_OOM', str(exc))
    if _disk_full(exc, texts):
        return _fail('DISK_FULL', str(exc))
    return _fail('INTERNAL', str(exc) or exc.__class__.__name__)


def _fail(code, message):
    return Verdict(False, code=code, message=message)


def _texts(raw, svc_exc):
    found = []
    if svc_exc is not None:
        found.append(str(svc_exc))
    if isinstance(raw, dict):
        if raw.get('error'):
            found.append(str(raw.get('error')))
        outputs = raw.get('svc_outputs') or []
        if isinstance(outputs, list):
            for item in outputs:
                if isinstance(item, dict) and item.get('message'):
                    found.append(str(item.get('message')))
    return found


def _has_cuda(texts):
    blob = '\n'.join(texts)
    return any(needle in blob for needle in CUDA_NEEDLES)


def _disk_full(exc, texts):
    if isinstance(exc, OSError) and getattr(exc, 'errno', None) == 28:
        return True
    blob = '\n'.join(texts)
    return 'No space left on device' in blob or '[Errno 28]' in blob


def _status_code(texts):
    blob = _joined(texts)
    if '模型文件不存在' in blob:
        return 'MODEL_UNAVAILABLE'
    if '输入文件不存在' in blob or '转换音频文件' in blob:
        return 'SOURCE_UNREADABLE'
    return 'INTERNAL'


def _joined(texts):
    return '\n'.join(texts)


def _msst(raw):
    outputs = raw.get('msst_outputs')
    if not isinstance(outputs, dict):
        return None, None, None
    instrumental = None
    original = None
    reverb = None
    for parts in outputs.values():
        if not isinstance(parts, dict):
            continue
        inst = parts.get('伴奏')
        orig = parts.get('原唱')
        if instrumental is None and isinstance(inst, str) and _readable(inst):
            instrumental = inst
        if original is None and isinstance(orig, str) and _readable(orig):
            original = orig
        rev = parts.get('和声')
        if reverb is None and isinstance(rev, str) and os.path.isfile(rev):
            reverb = rev
    return instrumental, original, reverb


def _vocal(raw):
    outputs = raw.get('svc_outputs')
    if outputs is None:
        return None
    if not isinstance(outputs, list):
        return None
    for item in outputs:
        if not isinstance(item, dict) or item.get('status') != 'success':
            continue
        path = item.get('svc_output_path')
        if isinstance(path, str) and _readable(path):
            return path
    return None


def _readable(path):
    if not os.path.isfile(path):
        return False
    try:
        return _frames(path) > 0
    except Exception:
        return False


def _frames(path):
    try:
        import soundfile as sf
    except ImportError:
        sf = None
    if sf is not None:
        info = sf.info(path)
        if info.frames <= 0:
            raise ValueError('no frames')
        sf.read(path, frames=1)
        return info.frames
    import wave
    with wave.open(path, 'rb') as handle:
        frames = handle.getnframes()
    if frames <= 0:
        raise ValueError('no frames')
    return frames
