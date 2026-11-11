import struct

import numpy as np

# 读写 WAV。支持 16 位 PCM 和 IEEE float32，不依赖 soundfile。


def read_wav(path):
    with open(path, 'rb') as handle:
        blob = handle.read()
    if len(blob) < 12 or blob[:4] != b'RIFF' or blob[8:12] != b'WAVE':
        raise ValueError('不是 WAV')
    fmt = None
    data = None
    offset = 12
    while offset + 8 <= len(blob):
        chunk = blob[offset:offset + 4]
        size = struct.unpack_from('<I', blob, offset + 4)[0]
        body = blob[offset + 8:offset + 8 + size]
        if chunk == b'fmt ':
            fmt = body
        elif chunk == b'data':
            data = body
        offset += 8 + size + (size & 1)
    if fmt is None or data is None or len(fmt) < 16:
        raise ValueError('WAV 缺少 fmt 或 data')
    tag, channels, rate, _byte_rate, _block, bits = struct.unpack_from('<HHIIHH', fmt)
    if channels < 1 or rate < 1:
        raise ValueError('WAV 声道或采样率不合法')
    samples = _decode(tag, bits, data)
    if samples.size % channels != 0:
        raise ValueError('WAV 数据长度和声道对不上')
    frames = samples.reshape(-1, channels)
    if frames.shape[0] < 1:
        raise ValueError('WAV 没有采样')
    return frames, int(rate)


def write_s16_stereo(path, frames, rate=44100):
    if frames.ndim != 2 or frames.shape[1] != 2:
        raise ValueError('需要立体声')
    if frames.shape[0] < 1:
        raise ValueError('没有采样')
    pcm = np.clip(np.asarray(frames, dtype=np.float64), -1.0, 1.0)
    pcm = np.round(pcm * 32767.0).astype('<i2')
    payload = pcm.tobytes()
    header = _header(rate, 2, 16, len(payload))
    with open(path, 'wb') as handle:
        handle.write(header)
        handle.write(payload)


def _decode(tag, bits, data):
    if tag == 1 and bits == 16:
        return np.frombuffer(data, dtype='<i2').astype(np.float64) / 32768.0
    if tag == 1 and bits == 32:
        return np.frombuffer(data, dtype='<i4').astype(np.float64) / 2147483648.0
    if tag == 1 and bits == 8:
        return (np.frombuffer(data, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    if tag == 3 and bits == 32:
        return np.frombuffer(data, dtype='<f4').astype(np.float64)
    raise ValueError('不支持的 WAV 格式 tag=%s bits=%s' % (tag, bits))


def _header(rate, channels, bits, data_bytes):
    block = channels * bits // 8
    fmt = struct.pack('<HHIIHH', 1, channels, rate, rate * block, block, bits)
    return b''.join((
        b'RIFF',
        struct.pack('<I', 36 + data_bytes),
        b'WAVE',
        b'fmt ',
        struct.pack('<I', 16),
        fmt,
        b'data',
        struct.pack('<I', data_bytes),
    ))
