import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

// 假后端夹具对 coverBackendRunner：环境、cwd、没有结果行、CUDA 文本、取消后的进程树。

const require = createRequire(import.meta.url);
const protocol = require('../../../electron/cover/coverProtocol.cjs') as {
    buildChildEnv: (parent: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    buildSpawnPlan: (spec: { backendDir: string; jobDir: string }, platform: string) => { command: string; args: string[]; cwd: string };
    progressFromLine: (line: unknown) => { phase: string; progress: number; indeterminate: boolean } | null;
    classifyCoverOutput: (input: Record<string, unknown>) => { status: string; error_code?: string };
    mapOkcError: (code: string) => string;
};
const runner = require('../../../electron/cover/coverBackendRunner.cjs') as {
    runCoverJob: (spec: { jobId: string; jobDir: string; backendDir: string }, onLine: (line: unknown) => void, options: Record<string, unknown>) => {
        pid: number;
        done: Promise<{ status: string; error_code?: string; nonJsonLines: number }>;
        cancel: () => Promise<unknown>;
    };
};

const FAKE = path.resolve('test/fixtures/cover/fakeCoverBackend.mjs');
const SECRET = 'super-secret-token-cover';
const roots: string[] = [];
const groups: number[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okcover-runner-'));
    roots.push(dir);
    return dir;
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function waitForFile(file: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 4000) {
        if (fs.existsSync(file)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${file}`);
}

function commandFor(mode: string, probeOut: string, configPath: string) {
    return () => ({
        command: process.execPath,
        args: [FAKE, '--mode', mode, '--probe-out', probeOut, '--config', configPath],
    });
}

afterEach(() => {
    delete process.env.DUOAI_RVC_PARAMS;
    delete process.env.DUOAI_BACKEND_URL;
    delete process.env.BACKEND_URL;
    delete process.env.YZG_BACKEND_URL;
    delete process.env.DUOAI_MSST2_DIR;
    delete process.env.PYTHONPATH;
    delete process.env.PYTHONHOME;
    for (const pid of groups.splice(0)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of roots.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('cover protocol', () => {
    it('builds the Windows command and strips networked env', () => {
        const plan = protocol.buildSpawnPlan({
            backendDir: 'D:\\okchang-test\\cover-runtime\\1\\msst-rvc\\python-backend',
            jobDir: 'D:\\out\\.processing\\job',
        }, 'win32');
        expect(plan.command).toBe('D:\\okchang-test\\cover-runtime\\1\\msst-rvc\\python-backend\\workenv\\python.exe');
        expect(plan.args).toEqual([
            '-u', '-X', 'utf8', 'okcover_entry.py', '--config', 'D:\\out\\.processing\\job\\okc_config.json',
        ]);
        expect(plan.cwd).toBe('D:\\okchang-test\\cover-runtime\\1\\msst-rvc\\python-backend');
        const env = protocol.buildChildEnv({
            PATH: '/usr/bin',
            DUOAI_RVC_PARAMS: SECRET,
            DUOAI_BACKEND_URL: 'https://yzg.duoai.fun',
            BACKEND_URL: 'https://example.invalid',
            YZG_BACKEND_URL: 'https://example.invalid',
            DUOAI_MSST2_DIR: '/tmp/msst',
            PYTHONPATH: '/tmp/not-for-child',
            PYTHONHOME: '/tmp/pyhome',
            PYTHONIOENCODING: 'gbk',
        });
        expect(env.PATH).toBe('/usr/bin');
        expect(env.DUOAI_RVC_PARAMS).toBeUndefined();
        expect(env.DUOAI_BACKEND_URL).toBeUndefined();
        expect(env.BACKEND_URL).toBeUndefined();
        expect(env.YZG_BACKEND_URL).toBeUndefined();
        expect(env.DUOAI_MSST2_DIR).toBeUndefined();
        expect(env.PYTHONPATH).toBeUndefined();
        expect(env.PYTHONHOME).toBeUndefined();
        expect(env.PYTHONIOENCODING).toBe('utf-8');
        expect(env.PYTHONNOUSERSITE).toBe('1');
        expect(env.PIP_NO_INDEX).toBe('1');
        expect(env.PIP_DISABLE_PIP_VERSION_CHECK).toBe('1');
        expect(JSON.stringify(env)).not.toContain(SECRET);
    });

    it('maps progress stages and classifies the last result line', () => {
        expect(protocol.progressFromLine({ type: 'hello' })).toMatchObject({ phase: 'preparing', progress: 0.02 });
        expect(protocol.progressFromLine({ type: 'progress', stage: 'convert_input', pct: 100 })?.progress).toBeCloseTo(0.05);
        expect(protocol.progressFromLine({ type: 'progress', stage: 'separate', pct: 50 })).toMatchObject({
            phase: 'separating', progress: 0.3, indeterminate: false,
        });
        expect(protocol.progressFromLine({ type: 'progress', stage: 'separate', pct: null })).toMatchObject({
            phase: 'separating', progress: 0.05, indeterminate: true,
        });
        expect(protocol.progressFromLine({ type: 'progress', stage: 'save' })).toMatchObject({ progress: 0.58 });
        expect(protocol.progressFromLine({ type: 'progress', stage: 'convert_voice', pct: null })).toMatchObject({
            phase: 'converting', progress: 0.6, indeterminate: true,
        });
        expect(protocol.progressFromLine({ type: 'progress', stage: 'finalize', pct: 100 })?.progress).toBeCloseTo(0.97);
        expect(protocol.mapOkcError('INTERNAL')).toBe('JOB_FAILED');
        expect(protocol.mapOkcError('CUDA_OOM')).toBe('CUDA_OOM');
        expect(protocol.classifyCoverOutput({
            records: [
                { kind: 'json', value: { type: 'result', status: 'success' } },
                { kind: 'json', value: { type: 'progress', stage: 'finalize', pct: 1 } },
            ],
            exitCode: 0,
            cancelRequested: false,
        }).error_code).toBe('INTERNAL');
        expect(protocol.classifyCoverOutput({
            records: [{ kind: 'text', text: 'CUDA error: out of memory' }],
            exitCode: 1,
            cancelRequested: false,
            cudaSeen: true,
        }).error_code).toBe('CUDA_OOM');
    });
});

describe('coverBackendRunner against the fake backend', () => {
    it('passes cwd and stripped env, and pipes stdio with windowsHide', async () => {
        const root = tempDir();
        const backendDir = path.join(root, 'python-backend');
        const jobDir = path.join(root, 'job');
        fs.mkdirSync(backendDir, { recursive: true });
        const probe = path.join(root, 'probe.json');
        const seen: Array<{ windowsHide?: boolean; stdio?: string[]; detached?: boolean; cwd?: string }> = [];
        process.env.DUOAI_RVC_PARAMS = SECRET;
        process.env.PYTHONPATH = '/tmp/not-for-child';
        process.env.BACKEND_URL = 'https://example.invalid';
        const realSpawn = require('node:child_process').spawn as typeof import('node:child_process').spawn;
        const handle = runner.runCoverJob(
            { jobId: 'job-env', jobDir, backendDir },
            () => {},
            {
                commandFor: commandFor('probe', probe, path.join(jobDir, 'okc_config.json')),
                env: process.env,
                spawn: (command: string, args: string[], options: { windowsHide?: boolean; stdio?: string[]; detached?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }) => {
                    seen.push(options);
                    expect(options.env?.DUOAI_RVC_PARAMS).toBeUndefined();
                    expect(options.env?.PYTHONPATH).toBeUndefined();
                    expect(options.env?.BACKEND_URL).toBeUndefined();
                    expect(options.env?.PYTHONIOENCODING).toBe('utf-8');
                    expect(options.env?.PIP_NO_INDEX).toBe('1');
                    expect(JSON.stringify(options.env)).not.toContain(SECRET);
                    return realSpawn(command, args, options as import('node:child_process').SpawnOptions);
                },
            },
        );
        const outcome = await handle.done;
        expect(outcome.status).toBe('success');
        expect(seen[0]).toMatchObject({
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: backendDir,
        });
        expect(seen[0].detached).toBe(process.platform !== 'win32');
        const recorded = JSON.parse(fs.readFileSync(probe, 'utf8')) as { cwd: string; env: Record<string, string | null> };
        expect(recorded.cwd).toBe(backendDir);
        expect(recorded.env.PYTHONIOENCODING).toBe('utf-8');
        expect(recorded.env.PYTHONNOUSERSITE).toBe('1');
        expect(recorded.env.PIP_NO_INDEX).toBe('1');
        expect(recorded.env.PIP_DISABLE_PIP_VERSION_CHECK).toBe('1');
        expect(recorded.env.DUOAI_RVC_PARAMS).toBeNull();
        expect(recorded.env.PYTHONPATH).toBeNull();
        expect(recorded.env.BACKEND_URL).toBeNull();
        const log = fs.readFileSync(path.join(jobDir, 'backend.log'), 'utf8');
        expect(log).not.toContain(SECRET);
    });

    it('returns INTERNAL when the process exits without a trailing result line', async () => {
        const root = tempDir();
        const jobDir = path.join(root, 'job');
        const outcome = await runner.runCoverJob(
            { jobId: 'job-internal', jobDir, backendDir: root },
            () => {},
            { commandFor: commandFor('no-result', path.join(root, 'probe.json'), path.join(jobDir, 'missing.json')) },
        ).done;
        expect(outcome.status).toBe('error');
        expect(outcome.error_code).toBe('INTERNAL');
    });

    it('returns INTERNAL when a result line is not the last stdout line', async () => {
        const root = tempDir();
        const jobDir = path.join(root, 'job');
        const outcome = await runner.runCoverJob(
            { jobId: 'job-not-last', jobDir, backendDir: root },
            () => {},
            { commandFor: commandFor('not-last', path.join(root, 'probe.json'), path.join(jobDir, 'missing.json')) },
        ).done;
        expect(outcome.error_code).toBe('INTERNAL');
    });

    it('returns CUDA_OOM when CUDA text shows up in stderr or a non-json stdout line', async () => {
        const root = tempDir();
        const stderrJob = path.join(root, 'stderr-job');
        const stderrOutcome = await runner.runCoverJob(
            { jobId: 'job-cuda-err', jobDir: stderrJob, backendDir: root },
            () => {},
            { commandFor: commandFor('cuda-stderr', path.join(root, 'probe-stderr.json'), path.join(stderrJob, 'missing.json')) },
        ).done;
        expect(stderrOutcome.error_code).toBe('CUDA_OOM');

        const stdoutJob = path.join(root, 'stdout-job');
        const stdoutOutcome = await runner.runCoverJob(
            { jobId: 'job-cuda-out', jobDir: stdoutJob, backendDir: root },
            () => {},
            { commandFor: commandFor('cuda-stdout', path.join(root, 'probe-stdout.json'), path.join(stdoutJob, 'missing.json')) },
        ).done;
        expect(stdoutOutcome.error_code).toBe('CUDA_OOM');
        expect(stdoutOutcome.nonJsonLines).toBe(1);
    });

    it('kills the process tree when cancel is ignored', async () => {
        const root = tempDir();
        const jobDir = path.join(root, 'job');
        const probe = path.join(root, 'probe.json');
        const handle = runner.runCoverJob(
            { jobId: 'job-kill', jobDir, backendDir: root },
            () => {},
            {
                graceMs: 200,
                commandFor: commandFor('hang', probe, path.join(jobDir, 'missing.json')),
            },
        );
        await waitForFile(probe);
        const info = JSON.parse(fs.readFileSync(probe, 'utf8')) as { pids: { parent: number; child: number } };
        groups.push(info.pids.parent);
        expect(alive(info.pids.parent)).toBe(true);
        expect(alive(info.pids.child)).toBe(true);
        const outcome = await handle.cancel() as { error_code?: string };
        expect(outcome.error_code).toBe('CANCELLED');
        expect(alive(info.pids.parent)).toBe(false);
        expect(alive(info.pids.child)).toBe(false);
    });
});

describe('spawn failure', () => {
    it('reports COMPONENT_MISSING when the executable does not exist', async () => {
        const root = tempDir();
        const child = new EventEmitter() as EventEmitter & { pid?: number; stdout?: EventEmitter; stderr?: EventEmitter; stdin?: { writable: boolean; destroyed: boolean; write: () => void; end: () => void } };
        const outcome = await runner.runCoverJob(
            { jobId: 'job-missing', jobDir: path.join(root, 'job'), backendDir: root },
            () => {},
            {
                spawn: () => {
                    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
                    return child;
                },
            },
        ).done;
        expect(outcome.error_code).toBe('COMPONENT_MISSING');
    });
});
