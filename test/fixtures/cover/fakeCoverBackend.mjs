import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 假 okcover 入口。只按设计稿 4.4 的 JSON 行说话，用来测主进程拉起、环境和取消。不是 python-backend/okcover_entry.py。

const args = process.argv.slice(2);

function flag(name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
}

const mode = flag('--mode') || 'success';
const configPath = flag('--config');
const probeOut = flag('--probe-out');

function readConfig() {
    if (!configPath || !fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function writeProbe(extra = {}) {
    if (!probeOut) return;
    fs.mkdirSync(path.dirname(probeOut), { recursive: true });
    const payload = {
        cwd: process.cwd(),
        argv: process.argv,
        env: {
            PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? null,
            PYTHONNOUSERSITE: process.env.PYTHONNOUSERSITE ?? null,
            PIP_NO_INDEX: process.env.PIP_NO_INDEX ?? null,
            PIP_DISABLE_PIP_VERSION_CHECK: process.env.PIP_DISABLE_PIP_VERSION_CHECK ?? null,
            DUOAI_RVC_PARAMS: process.env.DUOAI_RVC_PARAMS ?? null,
            DUOAI_BACKEND_URL: process.env.DUOAI_BACKEND_URL ?? null,
            BACKEND_URL: process.env.BACKEND_URL ?? null,
            YZG_BACKEND_URL: process.env.YZG_BACKEND_URL ?? null,
            DUOAI_MSST2_DIR: process.env.DUOAI_MSST2_DIR ?? null,
            PYTHONPATH: process.env.PYTHONPATH ?? null,
            PYTHONHOME: process.env.PYTHONHOME ?? null,
        },
        ...extra,
    };
    fs.writeFileSync(probeOut, JSON.stringify(payload));
}

function say(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

const hello = {
    type: 'hello',
    protocol: 2,
    python: '3.10.13',
    torch: '2.7.1+cu128',
    cuda: true,
    gpu: 'Fake GPU',
};

function successResult(config) {
    const workDir = config?.finalize?.work_dir ?? null;
    if (workDir) {
        fs.mkdirSync(workDir, { recursive: true });
        const title = config.finalize.title || 'track';
        for (const role of ['人声', '伴奏', '原声']) {
            fs.writeFileSync(path.join(workDir, `${title}${role}.wav`), 'RIFF');
        }
        fs.writeFileSync(path.join(workDir, 'manifest.json'), '{}\n');
        fs.writeFileSync(path.join(workDir, 'cs.json'), '{}\n');
        fs.writeFileSync(path.join(workDir, '.complete'), 'ok\n');
        fs.writeFileSync(path.join(workDir, '.cover_done'), 'ok\n');
    }
    return {
        type: 'result',
        schema_version: 2,
        status: 'success',
        mode: config?.separate?.mode || 'library',
        separator: 'builtin',
        work_dir: workDir,
        tracks: workDir ? {
            vocal: 'vocal.wav',
            instrumental: 'instrumental.wav',
            original: 'original.wav',
        } : null,
        dropped: { reverb: null },
        raw: { status: 'success', svc_outputs: [], msst_outputs: {} },
    };
}

function errorResult(code, error, raw) {
    return {
        type: 'result',
        schema_version: 2,
        status: 'error',
        error_code: code,
        error,
        mode: 'library',
        work_dir: null,
        tracks: null,
        dropped: { reverb: null },
        raw: raw || { status: 'error', svc_outputs: [], msst_outputs: {} },
    };
}

function standardProgress() {
    say(hello);
    say({ type: 'progress', stage: 'convert_input', pct: 100 });
    say({
        type: 'progress',
        stage: 'separate',
        pct: 40,
        msg: 'MSST Stage 1: 分离人声和伴奏...',
        separator: 'builtin',
    });
    say({ type: 'progress', stage: 'separate', pct: 10, separator: 'builtin' });
    say({ type: 'progress', stage: 'save', pct: 100, separator: 'builtin' });
    say({ type: 'progress', stage: 'convert_voice', pct: null });
    say({ type: 'progress', stage: 'finalize', pct: 50 });
}

if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    writeProbe({ pids: { parent: process.pid, child: child.pid } });
    say(hello);
    say({ type: 'progress', stage: 'separate', pct: null, separator: 'builtin', msg: 'hang' });
    setInterval(() => {}, 1e9);
} else if (mode === 'wait-cancel') {
    writeProbe();
    say(hello);
    say({ type: 'progress', stage: 'separate', pct: 20, separator: 'builtin', msg: 'waiting' });
    const finish = () => {
        say(errorResult('CANCELLED', 'cancelled'));
        process.exit(130);
    };
    process.stdin.on('data', (chunk) => {
        if (String(chunk).includes('cancel')) finish();
    });
    process.stdin.on('end', finish);
} else if (mode === 'no-result') {
    writeProbe();
    say(hello);
    say({ type: 'progress', stage: 'convert_voice', pct: null });
    process.exit(0);
} else if (mode === 'not-last') {
    writeProbe();
    say(successResult(readConfig()));
    say({ type: 'progress', stage: 'finalize', pct: 1 });
    process.exit(0);
} else if (mode === 'cuda-stderr') {
    writeProbe();
    say(hello);
    say(errorResult('SVC_FAILED', 'svc failed', {
        status: 'error',
        svc_outputs: [{ status: 'error', message: 'CUDA out of memory. Tried to allocate 2.00 GiB' }],
        msst_outputs: {},
    }));
    process.stderr.write('CUDA out of memory. Tried to allocate 2.00 GiB\n');
    process.exit(1);
} else if (mode === 'cuda-stdout') {
    writeProbe();
    say(hello);
    process.stdout.write('RuntimeError: CUDA error: out of memory\n');
    process.exit(1);
} else if (mode === 'cuda-and-cancel') {
    writeProbe();
    say(hello);
    process.stderr.write('cudaMalloc failed\n');
    const finish = () => {
        say(errorResult('SVC_FAILED', 'CUDA out of memory'));
        process.exit(130);
    };
    process.stdin.on('data', (chunk) => {
        if (String(chunk).includes('cancel')) finish();
    });
    process.stdin.on('end', finish);
    setTimeout(finish, 30000);
} else if (mode === 'fallback') {
    writeProbe();
    const config = readConfig();
    say(hello);
    say({ type: 'progress', stage: 'separate', pct: 30, separator: 'msst-native', msg: 'native' });
    say({ type: 'log', level: 'warn', text: 'native failed, built-in separator' });
    say({ type: 'progress', stage: 'separate', pct: 80, separator: 'builtin', msg: 'builtin' });
    say({ type: 'progress', stage: 'convert_voice', pct: null, separator: 'builtin' });
    say({ type: 'progress', stage: 'finalize', pct: 100, separator: 'builtin' });
    say({ ...successResult(config), separator: 'builtin' });
    process.exit(0);
} else if (mode === 'fail') {
    writeProbe();
    standardProgress();
    say(errorResult('SVC_FAILED', 'svc failed'));
    process.exit(1);
} else if (mode === 'probe') {
    writeProbe();
    say(hello);
    say(successResult(null));
    process.exit(0);
} else {
    writeProbe();
    const config = readConfig();
    standardProgress();
    say(successResult(config));
    process.exit(0);
}
