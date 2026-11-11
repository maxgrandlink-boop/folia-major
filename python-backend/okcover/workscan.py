import json
import os

# 按契约 0.1 认轨，给 finalize 产物做验收。完整扫描器在 W2（B2），这里只实现认轨需要的部分。

_ROLE = {
    'vocal': 'vocal',
    'backing': 'instrumental',
    'instrument': 'instrumental',
    'original_vocal': 'original',
    'original': 'original',
    'harmony': 'harmony',
}
_CS = {'人声': 'vocal', '伴奏': 'instrumental', '原唱': 'original', '原声': 'original', '和声': 'harmony'}


def scan_work(folder):
    folder = os.path.abspath(folder)
    ready = os.path.isfile(os.path.join(folder, '.complete')) and os.path.isfile(os.path.join(folder, '.cover_done'))
    manifest = _read_json(os.path.join(folder, 'manifest.json'))
    cs = _read_json(os.path.join(folder, 'cs.json'))
    tokens = _tokens(folder, manifest, cs)
    tracks, source = _from_manifest(folder, manifest, tokens)
    if tracks:
        return {'ready': ready, 'source': source, 'tracks': tracks}
    tracks = _from_cs(folder, cs, tokens)
    if tracks:
        return {'ready': ready, 'source': 'cs-json', 'tracks': tracks}
    return {'ready': ready, 'source': None, 'tracks': {}}


def _from_manifest(folder, manifest, tokens):
    if not isinstance(manifest, dict):
        return {}, None
    raw = manifest.get('tracks')
    found = {}
    if isinstance(raw, dict):
        items = raw.items()
    elif isinstance(raw, list):
        items = []
        for entry in raw:
            if isinstance(entry, dict) and entry.get('role'):
                items.append((entry.get('role'), entry))
    else:
        return {}, None
    for key, entry in items:
        role = _ROLE.get(key)
        if role is None or role in found:
            continue
        name = _track_file(folder, entry, tokens)
        if name:
            found[role] = name
    if not found:
        return {}, None
    return found, 'manifest'


def _from_cs(folder, cs, tokens):
    if not isinstance(cs, dict) or not isinstance(cs.get('files'), dict):
        return {}
    found = {}
    for key, value in cs['files'].items():
        role = _CS.get(key)
        if role is None or role in found or not isinstance(value, str):
            continue
        name = _named(folder, value, tokens)
        if name:
            found[role] = name
    return found


def _track_file(folder, entry, tokens):
    if isinstance(entry, str):
        return _named(folder, entry, tokens)
    if not isinstance(entry, dict):
        return None
    for key in ('source_path', 'std_path', 'file'):
        name = _named(folder, entry.get(key), tokens)
        if name:
            return name
    return None


def _named(folder, raw, tokens):
    if not isinstance(raw, str) or not raw:
        return None
    name = _resolve(folder, raw)
    if name is None:
        return None
    if '改词' in name:
        return None
    if tokens and not any(token in name for token in tokens):
        return None
    return name


def _resolve(folder, raw):
    candidate = raw if os.path.isabs(raw) else os.path.normpath(os.path.join(folder, raw))
    if _inside(folder, candidate) and os.path.isfile(candidate):
        return os.path.basename(candidate)
    name = os.path.basename(raw)
    alt = os.path.join(folder, name)
    if os.path.isfile(alt):
        return name
    return None


def _inside(folder, path):
    folder = os.path.abspath(folder)
    path = os.path.abspath(path)
    return path == folder or path.startswith(folder + os.sep)


def _tokens(folder, manifest, cs):
    bits = [os.path.basename(folder)]
    if isinstance(manifest, dict) and isinstance(manifest.get('title'), str):
        bits.append(manifest['title'])
    if isinstance(cs, dict) and isinstance(cs.get('name'), str):
        bits.append(cs['name'])
    tokens = []
    for bit in bits:
        tokens.append(bit)
        tokens.extend(part for part in bit.split(' - ') if part)
    return [token for token in tokens if len(token) >= 2]


def _read_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None
