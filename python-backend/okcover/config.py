import os

from okcover.errors import OkcError

# schema v2 → PB 键。只写翻译表里的键；prepare_pipeline_config 不调用。

_NETWORK_ENV = (
    'DUOAI_RVC_PARAMS',
    'DUOAI_BACKEND_URL',
    'BACKEND_URL',
    'YZG_BACKEND_URL',
    'DUOAI_MSST2_DIR',
)


def scrub_network_env():
    for key in _NETWORK_ENV:
        os.environ.pop(key, None)


MODES = ('library', 'normal', 'aggressive')
SEPARATORS = ('builtin', 'msst-native')
F0_METHODS = ('rmvpe', 'harvest', 'crepe', 'pm')
# 翻唱契约把这些扩展名定为加密格式。OkcErrorCode 没有 SOURCE_ENCRYPTED，入口不解密，回 SOURCE_UNREADABLE。
ENCRYPTED_SUFFIXES = (
    '.ncm', '.qmc0', '.qmc3', '.qmcflac', '.qmcogg', '.mflac', '.mgg',
    '.kgm', '.kgma', '.kwm', '.m4p',
)
NEVER_KEYS = (
    'formant_shift_key', 'vol_ratio', 'mute_ratio', 'threhold', 'method', 'target_spk_id',
    'infer_step', 'engine', 'engine_key', 'model_ref', 'index_ref', 'model', 'model_name',
    'rvc_model', 'index_name', 'rvc_index', 'f0_min', 'f0_max', 'high_protect_enabled',
    'app_base_dir', 'base_dir', 'task_id',
)
DEEP_SLIDERS = (
    'retrieval_softness', 'pitch_naturalness', 'breath_preservation',
    'vibrato_preserve', 'voice_similarity', 'articulation_clarity',
)
# deep 为 null 时这 7 个键都不写，否则 process_pipeline.py 会自动打开深度调参。
DEEP_KEYS = ('humanize',) + DEEP_SLIDERS


def find_ffmpeg(backend_dir):
    bindir = os.path.join(backend_dir, 'ffmpeg', 'bin')
    for name in ('ffmpeg.exe', 'ffmpeg'):
        path = os.path.join(bindir, name)
        if os.path.isfile(path):
            return path
    return None


def load(path):
    """读 OkcConfigV2。不合法抛 OkcError(CONFIG_INVALID)。不读模型、不写文件。"""
    import json
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise OkcError('CONFIG_INVALID', '配置文件不存在') from exc
    except json.JSONDecodeError as exc:
        raise OkcError('CONFIG_INVALID', '配置不是 JSON') from exc
    if not isinstance(data, dict) or data.get('schema_version') != 2:
        raise OkcError('CONFIG_INVALID', 'schema_version 必须是 2')
    separate = _dict(data.get('separate'), 'separate')
    mode = separate.get('mode')
    separator = separate.get('separator')
    if mode not in ('library', 'normal'):
        raise OkcError('CONFIG_INVALID', 'v1 不接受的 separate.mode：%s' % mode)
    if separator not in SEPARATORS:
        raise OkcError('CONFIG_INVALID', 'separate.separator 不合法')
    inputs = data.get('input_files')
    if not isinstance(inputs, list) or len(inputs) != 1 or not isinstance(inputs[0], str) or not inputs[0]:
        raise OkcError('CONFIG_INVALID', 'input_files 必须是恰好一个路径')
    output_dir = data.get('output_dir')
    if not isinstance(output_dir, str) or not output_dir:
        raise OkcError('CONFIG_INVALID', 'output_dir 不合法')
    if data.get('device') != 'cuda':
        raise OkcError('CONFIG_INVALID', 'v1 的 device 只能是 cuda')
    convert = _dict(data.get('convert'), 'convert')
    model_path = convert.get('model_path')
    model_sha = convert.get('model_sha256')
    if not isinstance(model_path, str) or not model_path:
        raise OkcError('CONFIG_INVALID', 'model_path 不合法')
    if not isinstance(model_sha, str) or len(model_sha) != 64:
        raise OkcError('CONFIG_INVALID', 'model_sha256 不合法')
    index_path = convert.get('index_path', None)
    if index_path is not None and (not isinstance(index_path, str) or not index_path):
        raise OkcError('CONFIG_INVALID', 'index_path 只能是字符串或 null')
    key = convert.get('key')
    if type(key) is not int or key < -12 or key > 12:
        raise OkcError('CONFIG_INVALID', 'key 必须是 −12…12 的整数')
    f0_method = convert.get('f0_method')
    if f0_method == 'fcpe' or f0_method not in F0_METHODS:
        raise OkcError('CONFIG_INVALID', 'f0_method 不支持：%s' % f0_method)
    rvc = _rvc(convert.get('rvc'))
    deep = _deep(convert.get('deep', None))
    finalize = _finalize(data.get('finalize'))
    return {
        'mode': mode,
        'separator': separator,
        'input_file': inputs[0],
        'output_dir': output_dir,
        'model_path': model_path,
        'model_sha256': model_sha,
        'index_path': index_path,
        'key': key,
        'f0_method': f0_method,
        'rvc': rvc,
        'deep': deep,
        'finalize': finalize,
    }


def check_paths(cfg, backend_dir):
    """文件是否在、ffmpeg 是否在。模型内容由 model_guard 查。"""
    if find_ffmpeg(backend_dir) is None:
        raise OkcError('FFMPEG_MISSING', 'ffmpeg/bin/ffmpeg 不在')
    src = cfg['input_file']
    if not os.path.isfile(src):
        raise OkcError('SOURCE_UNREADABLE', '输入文件不存在')
    suffix = os.path.splitext(src)[1].lower()
    if suffix in ENCRYPTED_SUFFIXES:
        raise OkcError('SOURCE_UNREADABLE', '不解密加密格式：%s' % suffix)
    if cfg['index_path'] is not None and not os.path.isfile(cfg['index_path']):
        raise OkcError('CONFIG_INVALID', 'index_path 指向的文件不存在')
    lyrics = cfg['finalize']['lyrics_path']
    if lyrics is not None and not os.path.isfile(lyrics):
        raise OkcError('CONFIG_INVALID', 'lyrics_path 指向的文件不存在')


def translate(cfg):
    """翻成 PB 键。返回新 dict，不包含「一律不写」的键。"""
    out = {
        'input_files': [cfg['input_file']],
        'output_dir': cfg['output_dir'],
        'device': 'cuda',
        'use_msst': True,
        'msst_method': cfg['mode'],
        'use_svc': True,
        'model_path': cfg['model_path'],
        'key': cfg['key'],
        'pitch_extractor': cfg['f0_method'],
        'index_rate': cfg['rvc']['index_rate'],
        'rms_mix_rate': cfg['rvc']['rms_mix_rate'],
        'protect': cfg['rvc']['protect'],
        'filter_radius': cfg['rvc']['filter_radius'],
    }
    if cfg['index_path']:
        out['index_path'] = cfg['index_path']
    deep = cfg['deep']
    if deep is None:
        out['deep_debug_enabled'] = False
    else:
        out['deep_debug_enabled'] = True
        out['humanize'] = deep['humanize']
        for name in DEEP_SLIDERS:
            out[name] = deep[name]
    leaked = NEVER_KEYS if deep is not None else NEVER_KEYS + DEEP_KEYS
    for key in leaked:
        if key in out:
            raise OkcError('INTERNAL', '翻译表把禁止键写出去了：%s' % key)
    return out


def write_backend(cfg, config_path):
    import json
    path = os.path.join(os.path.dirname(os.path.abspath(config_path)), 'okc_backend_config.json')
    payload = translate(cfg)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'))
        handle.write('\n')
    return path


def _dict(value, name):
    if not isinstance(value, dict):
        raise OkcError('CONFIG_INVALID', '缺少 %s' % name)
    return value


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OkcError('CONFIG_INVALID', '%s 必须是数字' % name)
    return value


def _rvc(value):
    raw = _dict(value, 'convert.rvc')
    radius = raw.get('filter_radius')
    if type(radius) is not int or radius < 0:
        raise OkcError('CONFIG_INVALID', 'filter_radius 必须是非负整数')
    return {
        'index_rate': _number(raw.get('index_rate'), 'index_rate'),
        'rms_mix_rate': _number(raw.get('rms_mix_rate'), 'rms_mix_rate'),
        'protect': _number(raw.get('protect'), 'protect'),
        'filter_radius': radius,
    }


def _deep(value):
    if value is None:
        return None
    raw = _dict(value, 'convert.deep')
    if not isinstance(raw.get('humanize'), bool):
        raise OkcError('CONFIG_INVALID', 'deep.humanize 必须是布尔')
    out = {'humanize': raw['humanize']}
    for name in DEEP_SLIDERS:
        number = _number(raw.get(name), name)
        if number < 0 or number > 1:
            raise OkcError('CONFIG_INVALID', '%s 必须在 0–1' % name)
        out[name] = number
    return out


def _finalize(value):
    raw = _dict(value, 'finalize')
    work_dir = raw.get('work_dir')
    title = raw.get('title')
    if not isinstance(work_dir, str) or not work_dir:
        raise OkcError('CONFIG_INVALID', 'finalize.work_dir 不合法')
    if not isinstance(title, str) or not title:
        raise OkcError('CONFIG_INVALID', 'finalize.title 不合法')
    artist = raw.get('artist', None)
    if artist is not None and not isinstance(artist, str):
        raise OkcError('CONFIG_INVALID', 'finalize.artist 不合法')
    lyrics = raw.get('lyrics_path', None)
    if lyrics is not None and not isinstance(lyrics, str):
        raise OkcError('CONFIG_INVALID', 'finalize.lyrics_path 不合法')
    for name in ('source_song_id', 'model_id'):
        if not isinstance(raw.get(name), str) or not raw.get(name):
            raise OkcError('CONFIG_INVALID', 'finalize.%s 不合法' % name)
    return {
        'work_dir': work_dir,
        'title': title,
        'artist': artist,
        'lyrics_path': lyrics,
        'source_song_id': raw['source_song_id'],
        'model_id': raw['model_id'],
    }
