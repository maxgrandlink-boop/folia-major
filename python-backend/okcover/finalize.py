import json
import os
import shutil
import subprocess
import tempfile
import time

import numpy as np

from okcover.config import find_ffmpeg
from okcover.errors import OkcError
from okcover.wavio import read_wav, write_s16_stereo

# 变调、转 44.1 kHz 立体声 16 位、对齐到伴奏、写作品文件夹。只出三轨。
# 全静音（采样全是 0、但帧数 > 0）照成功判据放行，不另报错。

TARGET_RATE = 44100


def build_work(cfg, verdict, backend_dir):
    ffmpeg = find_ffmpeg(backend_dir)
    if ffmpeg is None:
        raise OkcError('FFMPEG_MISSING', 'ffmpeg/bin/ffmpeg 不在')
    try:
        instrumental = _render(ffmpeg, verdict.instrumental, cfg['key'])
        vocal = _render(ffmpeg, verdict.vocal, 0)
        original = _render(ffmpeg, verdict.original, 0)
        target = instrumental.shape[0]
        vocal = _align(vocal, target)
        original = _align(original, target)
        return _write_folder(cfg, vocal, instrumental, original)
    except OkcError:
        raise
    except OSError as exc:
        if getattr(exc, 'errno', None) == 28:
            raise OkcError('DISK_FULL', 'no space left on device') from exc
        raise OkcError('FINALIZE_FAILED', str(exc)) from exc
    except Exception as exc:
        raise OkcError('FINALIZE_FAILED', str(exc)) from exc


def _render(ffmpeg, path, semitones):
    frames, rate = read_wav(path)
    with tempfile.TemporaryDirectory(prefix='okcover-') as tmp:
        current = os.path.join(tmp, 'src.wav')
        write_s16_stereo(current, _stereo(frames), rate)
        if semitones:
            pitched = os.path.join(tmp, 'pitch.wav')
            _pitch(ffmpeg, current, pitched, semitones)
            pitched_frames, pitched_rate = read_wav(pitched)
            pitched_frames = _fit_frames(pitched_frames, frames.shape[0])
            current = os.path.join(tmp, 'pitch-fit.wav')
            write_s16_stereo(current, _stereo(pitched_frames), pitched_rate)
        rendered = os.path.join(tmp, 'out.wav')
        _resample(ffmpeg, current, rendered)
        out, out_rate = read_wav(rendered)
    if out_rate != TARGET_RATE or out.shape[1] != 2:
        raise OkcError('FINALIZE_FAILED', '转码后不是 44.1 kHz 立体声')
    return out


def _pitch(ffmpeg, src, dst, semitones):
    ratio = 2.0 ** (semitones / 12.0)
    _ffmpeg(ffmpeg, [
        '-i', src,
        '-af', 'rubberband=pitch=%.12f:tempo=1:pitchq=quality' % ratio,
        '-c:a', 'pcm_s16le',
        dst,
    ])


def _resample(ffmpeg, src, dst):
    _ffmpeg(ffmpeg, [
        '-i', src,
        '-ar', str(TARGET_RATE),
        '-ac', '2',
        '-c:a', 'pcm_s16le',
        dst,
    ])


def _ffmpeg(ffmpeg, args):
    cmd = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-y', *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except OSError as exc:
        raise OkcError('FINALIZE_FAILED', 'ffmpeg 启动失败：%s' % exc) from exc
    if proc.returncode != 0:
        err = proc.stderr.decode('utf-8', errors='replace')[-400:]
        raise OkcError('FINALIZE_FAILED', 'ffmpeg 失败：%s' % err)


def _fit_frames(frames, target):
    """rubberband 偶尔差几帧。差得不多就裁尾或补尾，差得多就失败。"""
    count = frames.shape[0]
    if abs(count - target) <= 1:
        return frames
    if abs(count - target) > 8:
        raise OkcError('FINALIZE_FAILED', '变调后帧数 %s，输入 %s' % (count, target))
    return _align(frames, target)


def _align(frames, target):
    if frames.shape[0] == target:
        return frames
    if frames.shape[0] > target:
        return frames[:target]
    pad = np.zeros((target - frames.shape[0], frames.shape[1]), dtype=frames.dtype)
    return np.concatenate([frames, pad], axis=0)


def _stereo(frames):
    if frames.shape[1] == 1:
        return np.repeat(frames, 2, axis=1)
    return np.asarray(frames[:, :2], dtype=np.float64)


def track_filenames(base):
    """作品文件名按 2.5，不带括号。PB 自己的中间文件仍是 (人声).wav 那套。"""
    return {
        'vocal': '%s人声.wav' % base,
        'instrumental': '%s伴奏.wav' % base,
        'original': '%s原声.wav' % base,
    }


def _write_folder(cfg, vocal, instrumental, original):
    work_dir = cfg['finalize']['work_dir']
    os.makedirs(work_dir, exist_ok=True)
    base = os.path.basename(os.path.normpath(work_dir))
    names = track_filenames(base)
    arrays = {'vocal': vocal, 'instrumental': instrumental, 'original': original}
    tracks = {}
    for role, name in names.items():
        path = os.path.join(work_dir, name)
        tmp = path + '.partial'
        write_s16_stereo(tmp, arrays[role], TARGET_RATE)
        os.replace(tmp, path)
        tracks[role] = path
    _write_json(os.path.join(work_dir, 'manifest.json'), _manifest(cfg, base, names))
    _write_json(os.path.join(work_dir, 'cs.json'), {
        'name': base,
        'files': {
            '人声': names['vocal'],
            '伴奏': names['instrumental'],
            '原声': names['original'],
        },
    })
    lyrics = cfg['finalize']['lyrics_path']
    if lyrics:
        shutil.copyfile(lyrics, os.path.join(work_dir, 'lyrics.lrc'))
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S')
    with open(os.path.join(work_dir, '.cover_done'), 'w', encoding='utf-8') as handle:
        handle.write('at: %s\n' % stamp)
    with open(os.path.join(work_dir, '.complete'), 'w', encoding='utf-8') as handle:
        handle.write('ok\n')
    return {'work_dir': work_dir, 'tracks': tracks}


def _manifest(cfg, base, names):
    final = cfg['finalize']
    return {
        'title': final['title'],
        'song_id': final['source_song_id'],
        'created_at': time.strftime('%Y-%m-%d %H:%M:%S'),
        'sample_rate': TARGET_RATE,
        'channels': 2,
        'okchang': {
            'source_song_id': final['source_song_id'],
            'model_id': final['model_id'],
            'mode': cfg['mode'],
            'separator': cfg['separator'],
            'key': cfg['key'],
        },
        'tracks': {
            'vocal': {'file': names['vocal'], 'source_path': names['vocal']},
            'instrument': {'file': names['instrumental'], 'source_path': names['instrumental']},
            'original': {'file': names['original'], 'source_path': names['original']},
        },
    }


def _write_json(path, payload):
    tmp = path + '.partial'
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(tmp, path)
