import json
import sys

# stdout 协议行（设计稿 4.4，schema / protocol 2）。一行一个 JSON，UTF-8。

PROTOCOL = 2


def emit(stream, payload):
    stream.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    stream.flush()


def hello_payload():
    torch_ver = None
    cuda = False
    gpu = None
    try:
        import torch
    except Exception:
        torch = None
    if torch is not None:
        torch_ver = getattr(torch, '__version__', None)
        try:
            cuda = bool(torch.cuda.is_available())
            if cuda:
                gpu = torch.cuda.get_device_name(0)
        except Exception:
            cuda = False
            gpu = None
    return {
        'type': 'hello',
        'protocol': PROTOCOL,
        'python': sys.version.split()[0],
        'torch': torch_ver,
        'cuda': cuda,
        'gpu': gpu,
    }


def _raw(raw, status):
    if isinstance(raw, dict):
        return {
            'status': raw.get('status', status),
            'svc_outputs': raw.get('svc_outputs'),
            'msst_outputs': raw.get('msst_outputs'),
        }
    return {'status': status, 'svc_outputs': None, 'msst_outputs': None}


def result_success(mode, separator, raw, work_dir=None, tracks=None, reverb=None):
    return {
        'type': 'result',
        'schema_version': PROTOCOL,
        'status': 'success',
        'mode': mode,
        'separator': separator,
        'work_dir': work_dir,
        'tracks': tracks,
        'dropped': {'reverb': reverb},
        'raw': _raw(raw, 'success'),
    }


def result_error(mode, code, message, raw=None, separator=None, reverb=None):
    body = {
        'type': 'result',
        'schema_version': PROTOCOL,
        'status': 'error',
        'error_code': code,
        'error': message,
        'mode': mode,
        'work_dir': None,
        'tracks': None,
        'dropped': {'reverb': reverb},
        'raw': _raw(raw, 'error'),
    }
    if separator is not None:
        body['separator'] = separator
    return body
