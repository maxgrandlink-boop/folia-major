'use strict';

const { spawn: defaultSpawn, execFile: defaultExecFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildChildEnv, buildSpawnPlan, classifyCoverOutput, hasCudaText, hasDiskText } = require('./coverProtocol.cjs');

// electron/cover/coverBackendRunner.cjs
// 拉起 okcover 入口：设 cwd 和离线环境，按行读 JSON，取消时先写 cancel 再杀进程树。

const CANCEL_GRACE_MS = 2000;
const LOG_TAIL_LINES = 200;
const MARKER_CARRY = 64;

function killProcessTree(pid, platform, execFileFn) {
    return new Promise(resolve => {
        if (!pid) {
            resolve();
            return;
        }
        const execFile = execFileFn || defaultExecFile;
        if ((platform || process.platform) === 'win32') {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
            return;
        }
        try {
            process.kill(-pid, 'SIGKILL');
        } catch (error) {
            if (error && error.code !== 'ESRCH') console.warn('[cover] kill process group failed', error);
        }
        try {
            process.kill(pid, 'SIGKILL');
        } catch (error) {
            if (error && error.code !== 'ESRCH') console.warn('[cover] kill process failed', error);
        }
        resolve();
    });
}

function createLineSplitter(onLine) {
    let buffer = '';
    const take = (raw) => {
        let line = raw;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const trimmed = line.trim();
        if (trimmed.length > 0) onLine(trimmed);
    };
    return {
        push(chunk) {
            buffer += chunk;
            let index = buffer.indexOf('\n');
            while (index !== -1) {
                take(buffer.slice(0, index));
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
            }
        },
        flush() {
            if (buffer.length > 0) take(buffer);
            buffer = '';
        },
    };
}

/**
 * 跑一个翻唱任务。done 在进程结束（或拉起失败）后resolve，从不 reject。
 * cancel 写入 {"type":"cancel"} 并关掉 stdin；grace 毫秒后还不退就杀掉整个进程树。
 */
function runCoverJob(spec, onLine, options = {}) {
    const platform = options.platform || process.platform;
    const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : CANCEL_GRACE_MS;
    const spawnFn = options.spawn || defaultSpawn;
    const execFileFn = options.execFile || defaultExecFile;
    const plan = typeof options.commandFor === 'function' ? options.commandFor(spec) : buildSpawnPlan(spec, platform);
    const cwd = plan.cwd || spec.backendDir;
    const env = buildChildEnv(options.env || process.env);
    const records = [];
    const tail = [];
    let nonJson = 0;
    let cudaSeen = false;
    let diskSeen = false;
    let markerCarry = '';
    let cancelRequested = false;
    let settled = false;
    let child = null;
    let log = null;

    const noteMarkers = (text) => {
        const sample = markerCarry + text;
        if (hasCudaText(sample)) cudaSeen = true;
        if (hasDiskText(sample)) diskSeen = true;
        markerCarry = sample.slice(-MARKER_CARRY);
    };

    const writeLog = (text) => {
        if (log && !log.destroyed) log.write(text);
    };

    const pushTail = (line) => {
        tail.push(line);
        if (tail.length > LOG_TAIL_LINES) tail.shift();
    };

    let resolveDone = () => {};
    const done = new Promise(resolve => {
        resolveDone = resolve;
    });

    const finish = (outcome) => {
        if (settled) return;
        settled = true;
        if (log && !log.destroyed) log.end();
        const result = {
            ...outcome,
            nonJsonLines: nonJson,
            logTail: tail.join('\n'),
        };
        if (result.status === 'error') {
            console.warn('[cover] backend finished', {
                jobId: spec.jobId,
                errorCode: result.error_code,
                exitCode: result.exitCode ?? null,
                nonJsonLines: nonJson,
            });
        } else {
            console.info('[cover] backend finished', { jobId: spec.jobId, status: 'success' });
        }
        resolveDone(result);
    };

    try {
        fs.mkdirSync(spec.jobDir, { recursive: true });
        log = fs.createWriteStream(path.join(spec.jobDir, 'backend.log'), { flags: 'a' });
        log.on('error', (error) => {
            console.warn('[cover] backend log write failed', error);
        });
    } catch (error) {
        console.warn('[cover] backend log open failed', error);
    }

    const handleStdoutLine = (line) => {
        noteMarkers(line);
        let parsed = null;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            nonJson += 1;
            records.push({ kind: 'text', text: line });
            writeLog(`[stdout] ${line}\n`);
            pushTail(`[stdout] ${line}`);
            console.warn('[cover] non-json stdout line', { jobId: spec.jobId, count: nonJson });
            return;
        }
        records.push({ kind: 'json', value: parsed });
        if (typeof onLine === 'function') {
            try {
                onLine(parsed);
            } catch (error) {
                console.warn('[cover] progress listener failed', error);
            }
        }
    };

    const stdoutSplitter = createLineSplitter(handleStdoutLine);
    const stderrSplitter = createLineSplitter((line) => {
        noteMarkers(line);
        writeLog(`${line}\n`);
        pushTail(line);
    });

    try {
        child = spawnFn(plan.command, plan.args, {
            cwd,
            env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: platform !== 'win32',
        });
    } catch (error) {
        finish(spawnFailure(error));
        return { pid: 0, done, cancel: async () => done };
    }

    if (!child || typeof child.on !== 'function') {
        finish({ status: 'error', error_code: 'INTERNAL', error: 'spawn returned no process', exitCode: null });
        return { pid: 0, done, cancel: async () => done };
    }

    console.info('[cover] spawned backend', { jobId: spec.jobId, pid: child.pid ?? 0, cwd });

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => stdoutSplitter.push(String(chunk)));
    child.stderr?.on?.('data', (chunk) => stderrSplitter.push(String(chunk)));
    child.on('error', (error) => {
        console.warn('[cover] spawn failed', error);
        finish(spawnFailure(error));
    });
    child.on('close', (code) => {
        stdoutSplitter.flush();
        stderrSplitter.flush();
        finish(classifyCoverOutput({
            records,
            exitCode: code,
            cancelRequested,
            cudaSeen,
            diskSeen,
        }));
    });

    let cancelPromise = null;
    const cancel = () => {
        if (!cancelPromise) cancelPromise = requestCancel();
        return cancelPromise;
    };

    async function requestCancel() {
        cancelRequested = true;
        console.info('[cover] cancel requested', { jobId: spec.jobId, pid: child.pid ?? 0 });
        try {
            if (child.stdin && child.stdin.writable && !child.stdin.destroyed) {
                child.stdin.write('{"type":"cancel"}\n');
                child.stdin.end();
            }
        } catch (error) {
            console.warn('[cover] cancel write failed', error);
        }
        if (settled) return done;
        const timer = setTimeout(() => {
            console.warn('[cover] cancel grace elapsed, killing process tree', { jobId: spec.jobId, pid: child.pid ?? 0 });
            void killProcessTree(child.pid, platform, execFileFn);
        }, graceMs);
        if (typeof timer.unref === 'function') timer.unref();
        try {
            return await done;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        get pid() {
            return child && child.pid ? child.pid : 0;
        },
        done,
        cancel,
    };
}

function spawnFailure(error) {
    const missing = error && error.code === 'ENOENT';
    return {
        status: 'error',
        error_code: missing ? 'COMPONENT_MISSING' : 'INTERNAL',
        error: error && typeof error.message === 'string' ? error.message : 'spawn failed',
        exitCode: null,
    };
}

module.exports = {
    runCoverJob,
    killProcessTree,
    CANCEL_GRACE_MS,
    LOG_TAIL_LINES,
};
