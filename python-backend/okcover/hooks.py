import logging
import sys
import types

from okcover.protocol import emit

# 包一层 PB 的四个阶段。builtin 时把 native 诊断挂成不可用；native 回退时改报 separator。


class HookState:
    def __init__(self, separator):
        self.separator = separator
        self.forced_builtin = separator == 'builtin'
        self.svc_exc = None
        self.fallback_notes = []


def install(module, proto, state):
    if state.forced_builtin:
        _force_builtin()
    _watch_fallback(state)
    _install_tqdm(proto, state)
    cls = module.ProcessPipeline

    def wrap(name, stage):
        orig = getattr(cls, name, None)
        if orig is None:
            return

        def wrapped(self, *args, **kwargs):
            _progress(proto, stage, _pct(stage, state, 0), _sep(stage, state))
            try:
                return orig(self, *args, **kwargs)
            except Exception as exc:
                if stage == 'convert_voice':
                    state.svc_exc = exc
                raise
            finally:
                if stage == 'separate':
                    _flush_fallback(proto, state)
                _progress(proto, stage, _pct(stage, state, 100), _sep(stage, state))

        setattr(cls, name, wrapped)

    wrap('_convert_to_wav', 'convert_input')
    wrap('_run_msst', 'separate')
    wrap('_save_msst_outputs', 'save')
    wrap('_run_svc', 'convert_voice')


def _sep(stage, state):
    if stage == 'convert_input':
        return None
    return state.separator


def _pct(stage, state, done):
    # RVC 没有进度。native 分离在回退成 builtin 之前也没有进度。
    if stage == 'convert_voice':
        return None
    if stage == 'separate' and state.separator == 'msst-native':
        return None
    return done


def _progress(proto, stage, pct, separator):
    payload = {'type': 'progress', 'stage': stage, 'pct': pct}
    if separator is not None:
        payload['separator'] = separator
    emit(proto, payload)


def _force_builtin():
    mod = types.ModuleType('native_msst_bridge')

    def diagnose_native_msst_status():
        return False, 'okcover forced builtin'

    def run_native_msst(*_args, **_kwargs):
        return False, {}, 'okcover forced builtin'

    mod.diagnose_native_msst_status = diagnose_native_msst_status
    mod.run_native_msst = run_native_msst
    sys.modules['native_msst_bridge'] = mod


class _FallbackHandler(logging.Handler):
    def __init__(self, state):
        super().__init__()
        self.state = state

    def emit(self, record):
        message = record.getMessage()
        if '回退内置' in message:
            self.state.fallback_notes.append(message)


def _watch_fallback(state):
    logger = logging.getLogger('ProcessPipeline')
    logger.addHandler(_FallbackHandler(state))


def _flush_fallback(proto, state):
    if state.forced_builtin or not state.fallback_notes:
        state.fallback_notes.clear()
        return
    note = state.fallback_notes[-1]
    state.fallback_notes.clear()
    state.separator = 'builtin'
    emit(proto, {'type': 'log', 'level': 'warn', 'text': note})


def _install_tqdm(proto, state):
    try:
        import msst.utils as utils
    except Exception:
        return
    orig = getattr(utils, 'tqdm', None)
    if not isinstance(orig, type):
        return

    class _OkcTqdm(orig):
        def update(self, n=1):
            super().update(n)
            total = getattr(self, 'total', None)
            done = getattr(self, 'n', None)
            if not total or done is None:
                return
            pct = int(100 * done / total)
            if pct < 0:
                pct = 0
            if pct > 100:
                pct = 100
            payload = {
                'type': 'progress',
                'stage': 'separate',
                'pct': pct,
                'separator': state.separator,
            }
            emit(proto, payload)

    utils.tqdm = _OkcTqdm
