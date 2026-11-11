import os

# 被导入或被调用就留标记。入口不得调用 prepare_pipeline_config。

_MARKER = os.environ.get('OKCOVER_PREPARE_MARKER')
if _MARKER:
    with open(_MARKER, 'w', encoding='utf-8') as _handle:
        _handle.write('imported\n')


def prepare_pipeline_config(config_path):
    if _MARKER:
        with open(_MARKER, 'a', encoding='utf-8') as handle:
            handle.write('called %s\n' % config_path)
    raise AssertionError('prepare_pipeline_config must not be called')
