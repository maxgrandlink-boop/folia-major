'use strict';

const path = require('path');

// electron/cover/coverProtocol.cjs
// okcover stdio 协议的纯函数：子进程环境、命令行、进度换算、结果分类。不拉起进程。

const STRIPPED_ENV = Object.freeze([
    'DUOAI_RVC_PARAMS',
    'DUOAI_BACKEND_URL',
    'BACKEND_URL',
    'YZG_BACKEND_URL',
    'DUOAI_MSST2_DIR',
    'PYTHONPATH',
    'PYTHONHOME',
]);

const CUDA_MARKERS = Object.freeze(['CUDA out of memory', 'cudaMalloc', 'CUDA error']);
const DISK_MARKERS = Object.freeze(['No space left on device', 'ENOSPC']);

/** 设计稿 4.4：OkcErrorCode → CoverErrorCode。INTERNAL 不是契约错误码，落成 JOB_FAILED。 */
const OKC_TO_COVER = Object.freeze({
    CANCELLED: 'JOB_CANCELLED',
    CUDA_OOM: 'CUDA_OOM',
    DISK_FULL: 'DISK_FULL',
    COMPONENT_MISSING: 'COMPONENT_CORRUPT',
    FFMPEG_MISSING: 'COMPONENT_CORRUPT',
    MODEL_UNAVAILABLE: 'MODEL_NOT_FOUND',
    MODEL_CHANGED: 'MODEL_INVALID',
    MODEL_UNSAFE: 'MODEL_UNSAFE',
    MODEL_NOT_RVC: 'MODEL_INVALID',
    SOURCE_UNREADABLE: 'SOURCE_UNREADABLE',
    SEPARATE_FAILED: 'JOB_FAILED',
    SVC_FAILED: 'JOB_FAILED',
    FINALIZE_FAILED: 'JOB_FAILED',
    CONFIG_INVALID: 'JOB_FAILED',
    INTERNAL: 'JOB_FAILED',
});

const PHASE_RANK = Object.freeze({
    queued: 0,
    preparing: 1,
    separating: 2,
    converting: 3,
    ingesting: 4,
    done: 5,
    failed: 6,
    cancelled: 6,
});

const ORDINARY_AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.webm']);
const ENCRYPTED_AUDIO_EXT = new Set([
    '.ncm', '.qmc0', '.qmc3', '.qmcflac', '.qmcogg', '.mflac', '.mgg', '.kgm', '.kgma', '.kwm', '.m4p',
]);

function pathFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

function hasMarker(text, markers) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return markers.some(marker => text.includes(marker));
}

function hasCudaText(text) {
    return hasMarker(text, CUDA_MARKERS);
}

function hasDiskText(text) {
    return hasMarker(text, DISK_MARKERS);
}

/** 父进程环境去掉 7 个联网/路径变量，再钉上离线与 UTF-8。 */
function buildChildEnv(parent) {
    const env = { ...(parent && typeof parent === 'object' ? parent : {}) };
    for (const key of STRIPPED_ENV) delete env[key];
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONNOUSERSITE = '1';
    env.PIP_NO_INDEX = '1';
    env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
    return env;
}

function pythonExecutable(backendDir, platform) {
    const base = pathFor(platform);
    const name = platform === 'win32' ? 'python.exe' : 'python';
    return base.join(backendDir, 'workenv', name);
}

/** spawn 计划：cwd 是 python-backend，参数避开 RVC 能前缀匹配的缩写。 */
function buildSpawnPlan(spec, platform) {
    const base = pathFor(platform || process.platform);
    return {
        command: pythonExecutable(spec.backendDir, platform || process.platform),
        args: ['-u', '-X', 'utf8', 'okcover_entry.py', '--config', base.join(spec.jobDir, 'okc_config.json')],
        cwd: spec.backendDir,
    };
}

function clampPct(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
    return Math.min(100, Math.max(0, pct)) / 100;
}

function lineMessage(line) {
    return typeof line.msg === 'string' ? line.msg : undefined;
}

function lineSeparator(line) {
    return line.separator === 'builtin' || line.separator === 'msst-native' ? line.separator : undefined;
}

/** 一条协议行换成阶段进度。log / result 不产生进度。 */
function progressFromLine(line) {
    if (!line || typeof line !== 'object') return null;
    if (line.type === 'hello') {
        return { phase: 'preparing', progress: 0.02, indeterminate: false };
    }
    if (line.type !== 'progress') return null;
    const fraction = clampPct(line.pct);
    const message = lineMessage(line);
    const separator = lineSeparator(line);
    switch (line.stage) {
        case 'convert_input':
            return { phase: 'preparing', progress: 0.02 + 0.03 * (fraction ?? 0), indeterminate: false, message, separator };
        case 'separate':
            if (fraction === null) {
                return { phase: 'separating', progress: 0.05, indeterminate: true, message, separator };
            }
            return { phase: 'separating', progress: 0.05 + 0.50 * fraction, indeterminate: false, message, separator };
        case 'save':
            return { phase: 'separating', progress: 0.58, indeterminate: false, message, separator };
        case 'convert_voice':
            return { phase: 'converting', progress: 0.60, indeterminate: true, message, separator };
        case 'finalize':
            return { phase: 'ingesting', progress: 0.85 + 0.12 * (fraction ?? 0), indeterminate: false, message, separator };
        default:
            return null;
    }
}

function mapOkcError(code) {
    if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(OKC_TO_COVER, code)) {
        return OKC_TO_COVER[code];
    }
    return 'JOB_FAILED';
}

function fieldsFrom(result) {
    if (!result) return {};
    return {
        mode: result.mode,
        separator: result.separator,
        work_dir: result.work_dir ?? null,
        tracks: result.tracks ?? null,
        dropped: result.dropped,
        raw: result.raw,
        error: typeof result.error === 'string' ? result.error : undefined,
    };
}

function asResult(value) {
    if (!value || typeof value !== 'object' || value.type !== 'result') return null;
    if (value.status !== 'success' && value.status !== 'error') return null;
    return value;
}

/**
 * 进程结束后的判定。只认最后一条非空 stdout 是 type:'result'。
 * 先后：取消 > CUDA 文本 > 磁盘满 > 没有结果行（INTERNAL）> 结果行里的错误码。
 */
function classifyCoverOutput({ records, exitCode, cancelRequested, cudaSeen, diskSeen }) {
    const list = Array.isArray(records) ? records : [];
    const last = list.length > 0 ? list[list.length - 1] : null;
    const result = last && last.kind === 'json' ? asResult(last.value) : null;
    let cuda = cudaSeen === true;
    let disk = diskSeen === true;
    for (const record of list) {
        const text = record.kind === 'text' ? record.text : JSON.stringify(record.value);
        if (hasCudaText(text)) cuda = true;
        if (hasDiskText(text)) disk = true;
    }
    const extras = { exitCode: exitCode ?? null, cuda, disk };
    if (result && result.status === 'success') {
        return { status: 'success', error_code: undefined, ...fieldsFrom(result), ...extras };
    }
    if (cancelRequested === true || result?.error_code === 'CANCELLED' || exitCode === 130) {
        return { status: 'error', error_code: 'CANCELLED', ...fieldsFrom(result), ...extras };
    }
    if (cuda) {
        return { status: 'error', error_code: 'CUDA_OOM', ...fieldsFrom(result), ...extras };
    }
    if ((result && result.error_code === 'DISK_FULL') || disk) {
        return { status: 'error', error_code: 'DISK_FULL', ...fieldsFrom(result), ...extras };
    }
    if (!result) {
        return { status: 'error', error_code: 'INTERNAL', ...fieldsFrom(null), ...extras };
    }
    const code = typeof result.error_code === 'string' && result.error_code ? result.error_code : 'INTERNAL';
    return { status: 'error', error_code: code, ...fieldsFrom(result), ...extras };
}

function audioExt(fileName) {
    if (typeof fileName !== 'string') return '';
    const base = fileName.replace(/\\/g, '/').split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    return base.slice(dot).toLowerCase();
}

function isEncryptedAudio(fileName) {
    return ENCRYPTED_AUDIO_EXT.has(audioExt(fileName));
}

function isOrdinaryAudio(fileName) {
    return ORDINARY_AUDIO_EXT.has(audioExt(fileName));
}

module.exports = {
    STRIPPED_ENV,
    CUDA_MARKERS,
    OKC_TO_COVER,
    PHASE_RANK,
    ORDINARY_AUDIO_EXT,
    ENCRYPTED_AUDIO_EXT,
    buildChildEnv,
    buildSpawnPlan,
    pythonExecutable,
    progressFromLine,
    mapOkcError,
    classifyCoverOutput,
    hasCudaText,
    hasDiskText,
    isOrdinaryAudio,
    isEncryptedAudio,
    audioExt,
};
