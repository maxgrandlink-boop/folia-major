import os
import sys

from okcover.classify import from_exception, judge
from okcover.config import check_paths, load, scrub_network_env, write_backend
from okcover.errors import OkcError
from okcover.hooks import HookState, install
from okcover.model_guard import check_model
from okcover.protocol import emit, hello_payload, result_error, result_success
from okcover.watchdog import Gate, kill_descendants, start

# 跑一个任务：校验 schema v2、翻译、安全读模型、挂钩、按成功判据收口。finalize 在 P3。


def run(proto, config_path, backend_dir):
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
    state = None
    try:
        cfg = load(config_path)
        ctx['mode'] = cfg['mode']
        ctx['separator'] = cfg['separator']
        check_paths(cfg, backend_dir)
        check_model(cfg, backend_dir)
        backend_path = write_backend(cfg, config_path)
        module = _import_pipeline()
        state = HookState(cfg['separator'])
        install(module, proto, state)
        raw = module.ProcessPipeline().process(backend_path)
    except OkcError as exc:
        _emit(proto, gate, result_error(ctx['mode'], exc.code, exc.message, separator=ctx['separator']))
        return 1
    except Exception as exc:
        verdict = from_exception(exc)
        _emit(proto, gate, result_error(ctx['mode'], verdict.code, verdict.message, separator=ctx['separator']))
        return 1
    if state is not None:
        ctx['separator'] = state.separator
    verdict = judge(raw, None if state is None else state.svc_exc)
    if not verdict.ok:
        _emit(proto, gate, result_error(
            ctx['mode'], verdict.code, verdict.message, raw=raw, separator=ctx['separator'], reverb=verdict.reverb,
        ))
        return 1
    _emit(proto, gate, result_success(
        ctx['mode'], ctx['separator'], raw, reverb=verdict.reverb,
    ))
    return 0


def _emit(proto, gate, payload):
    gate.finish(lambda: emit(proto, payload), 0 if payload.get('status') == 'success' else 1)


def _import_pipeline():
    extra = os.environ.get('OKCOVER_PB_PATH')
    if extra and extra not in sys.path:
        sys.path.insert(0, extra)
    import process_pipeline
    return process_pipeline
