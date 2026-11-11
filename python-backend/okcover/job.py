import json
import os
import sys

from okcover.protocol import emit, hello_payload, result_error, result_success
from okcover.watchdog import Gate, kill_descendants, start

# 跑一个任务。P1 只挂钩四个阶段并发协议行；翻译表、成功判据和 finalize 在 P2、P3。

_NETWORK_ENV = (
    'DUOAI_RVC_PARAMS',
    'DUOAI_BACKEND_URL',
    'BACKEND_URL',
    'YZG_BACKEND_URL',
    'DUOAI_MSST2_DIR',
)
_MODES = ('library', 'normal', 'aggressive')
_SEPARATORS = ('builtin', 'msst-native')


def scrub_network_env():
    for key in _NETWORK_ENV:
        os.environ.pop(key, None)


def run(proto, config_path, backend_dir):
    del backend_dir  # P2 起用于 ffmpeg 与权重副本；P1 先收下，避免入口签名再改
    scrub_network_env()
    emit(proto, hello_payload())
    ctx = {'mode': 'library', 'separator': 'builtin'}
    gate = Gate()

    def on_cancel(_why):
        kill_descendants(os.getpid())

        def emit_cancel():
            emit(proto, result_error(
                ctx['mode'],
                'CANCELLED',
                'cancelled',
                raw={'status': 'cancelled', 'svc_outputs': None, 'msst_outputs': None},
                separator=ctx['separator'],
            ))

        gate.finish(emit_cancel, 130)

    start(on_cancel)
    try:
        cfg = _load(config_path)
    except _ConfigProblem as exc:
        _finish(proto, gate, 1, result_error(ctx['mode'], exc.code, exc.message, separator=ctx['separator']))
        return 1
    ctx['mode'] = cfg['mode']
    ctx['separator'] = cfg['separator']
    try:
        module = _import_pipeline()
        _install_hooks(module, proto, cfg['separator'])
        raw = module.ProcessPipeline().process(config_path)
    except Exception as exc:
        _finish(proto, gate, 1, result_error(
            ctx['mode'],
            'COMPONENT_MISSING' if isinstance(exc, ImportError) else 'INTERNAL',
            str(exc),
            separator=ctx['separator'],
        ))
        return 1
    if not isinstance(raw, dict) or raw.get('status') != 'success':
        message = raw.get('error') if isinstance(raw, dict) else 'pipeline returned no result'
        _finish(proto, gate, 1, result_error(
            ctx['mode'],
            'INTERNAL',
            message or 'pipeline failed',
            raw=raw if isinstance(raw, dict) else None,
            separator=ctx['separator'],
        ))
        return 1
    _finish(proto, gate, 0, result_success(ctx['mode'], ctx['separator'], raw))
    return 0


def _finish(proto, gate, code, payload):
    if gate.finish(lambda: emit(proto, payload), code):
        return code
    return 130


class _ConfigProblem(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _load(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise _ConfigProblem('CONFIG_INVALID', '配置文件不存在') from exc
    except json.JSONDecodeError as exc:
        raise _ConfigProblem('CONFIG_INVALID', '配置不是 JSON') from exc
    if not isinstance(data, dict) or data.get('schema_version') != 2:
        raise _ConfigProblem('CONFIG_INVALID', 'schema_version 必须是 2')
    separate = data.get('separate')
    if not isinstance(separate, dict):
        raise _ConfigProblem('CONFIG_INVALID', '缺少 separate')
    mode = separate.get('mode')
    separator = separate.get('separator')
    if mode not in _MODES or separator not in _SEPARATORS:
        raise _ConfigProblem('CONFIG_INVALID', 'separate.mode 或 separator 不合法')
    return {'mode': mode, 'separator': separator, 'data': data}


def _import_pipeline():
    extra = os.environ.get('OKCOVER_PB_PATH')
    if extra and extra not in sys.path:
        sys.path.insert(0, extra)
    import process_pipeline
    return process_pipeline


def _install_hooks(module, proto, separator):
    cls = module.ProcessPipeline
    native = separator == 'msst-native'

    def wrap(name, stage, null_pct):
        orig = getattr(cls, name, None)
        if orig is None:
            return

        def wrapped(self, *args, **kwargs):
            _progress(proto, stage, None if null_pct else 0, separator if stage != 'convert_input' else None)
            try:
                return orig(self, *args, **kwargs)
            finally:
                _progress(proto, stage, None if null_pct else 100, separator if stage != 'convert_input' else None)

        setattr(cls, name, wrapped)

    wrap('_convert_to_wav', 'convert_input', False)
    wrap('_run_msst', 'separate', native)
    wrap('_save_msst_outputs', 'save', False)
    wrap('_run_svc', 'convert_voice', True)


def _progress(proto, stage, pct, separator):
    payload = {'type': 'progress', 'stage': stage, 'pct': pct}
    if separator is not None:
        payload['separator'] = separator
    emit(proto, payload)
