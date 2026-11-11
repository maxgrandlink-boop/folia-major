def diagnose_native_msst_status():
    return True, 'native ok'


def run_native_msst(*_args, **_kwargs):
    return False, {}, 'native boom'
