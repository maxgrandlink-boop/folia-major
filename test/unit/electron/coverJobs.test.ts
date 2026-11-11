import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverJobEvent } from '../../../src/types/cover';

// 真 handler：排队、进度单调、移入输出根、CUDA / 没有结果行、取消后进程树和 .processing 都清掉。

const require = createRequire(import.meta.url);
const { registerCoverIpc } = require('../../../electron/cover/coverIpc.cjs') as {
    registerCoverIpc: (ipcMain: { handle: (channel: string, handler: Handler) => void }, deps: Deps, options: Record<string, unknown>) => {
        jobs: { ready: Promise<void>; shutdown: () => Promise<unknown> | null };
    };
};
const { registerOkIpc } = require('../../../electron/okIpc.cjs') as {
    registerOkIpc: (options: Record<string, unknown>) => { cover: { jobs: { shutdown: () => Promise<unknown> | null } } };
};

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type Deps = {
    userDataDir: string;
    getOutputRoot: () => string | null;
    getBackendDir: () => string | null;
    works: { rescan: () => Promise<void>; notifyChanged: (ids: string[]) => void };
    send: (channel: string, payload: unknown) => void;
    onQuit: (cb: () => Promise<unknown> | null) => void;
};

const FAKE = path.resolve('test/fixtures/cover/fakeCoverBackend.mjs');
const roots: string[] = [];
const groups: number[] = [];

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('timed out');
}

function request(overrides: Record<string, unknown> = {}) {
    return {
        sourceSongId: 'local-1',
        source: { fileName: 'song.mp3', bytes: Uint8Array.from([1, 2, 3, 4]).buffer },
        lyrics: { content: '[00:01.00]一句', format: 'lrc' },
        modelId: 'm-demo',
        title: '夜航',
        artist: '示例',
        keySemitones: 3,
        ...overrides,
    };
}

function createHarness(prepare?: (paths: { root: string; outputRoot: string }) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okcover-jobs-'));
    roots.push(root);
    const outputRoot = path.join(root, 'out');
    const backendDir = path.join(root, 'cover-runtime', '1', 'msst-rvc', 'python-backend');
    const userData = path.join(root, 'user');
    const modelDir = path.join(userData, 'rvc-models', 'm-demo');
    fs.mkdirSync(backendDir, { recursive: true });
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'm-demo.pth'), 'weights');
    prepare?.({ root, outputRoot });
    const events: CoverJobEvent[] = [];
    const trace: string[] = [];
    let mode = 'success';
    let quit: (() => Promise<unknown> | null) | null = null;
    let backend: string | null = backendDir;
    const deps: Deps = {
        userDataDir: userData,
        getOutputRoot: () => outputRoot,
        getBackendDir: () => backend,
        works: {
            async rescan() { trace.push('rescan'); },
            notifyChanged(ids) { trace.push(`notify:${ids.join(',')}`); },
        },
        send(channel, payload) {
            if (channel === 'ok-cover:job') events.push(payload as CoverJobEvent);
        },
        onQuit(cb) { quit = cb; },
    };
    const handlers = new Map<string, Handler>();
    const registered = registerCoverIpc({ handle: (channel, handler) => { handlers.set(channel, handler); } }, deps, {
        isTrusted: () => true,
        jobs: {
            graceMs: 200,
            checkGpu: async () => ({ ok: true, name: 'Fake GPU' }),
            commandFor: (spec: { jobId: string; jobDir: string }) => ({
                command: process.execPath,
                args: [
                    FAKE,
                    '--mode', mode,
                    '--config', path.join(spec.jobDir, 'okc_config.json'),
                    '--probe-out', path.join(root, `${spec.jobId}.json`),
                ],
            }),
        },
    });
    return {
        root,
        outputRoot,
        events,
        trace,
        handlers,
        jobs: registered.jobs,
        setMode(next: string) { mode = next; },
        setBackend(next: string | null) { backend = next; },
        invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: 1 }, ...args),
        async shutdown() {
            if (quit) await quit();
        },
    };
}

afterEach(async () => {
    for (const pid of groups.splice(0)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cover jobs and ipc', () => {
    it('sweeps leftover processing dirs on startup and leaves unexpected names', async () => {
        const stale = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const harness = createHarness(({ outputRoot }) => {
            fs.mkdirSync(path.join(outputRoot, '.processing', stale), { recursive: true });
            fs.writeFileSync(path.join(outputRoot, '.processing', stale, 'junk.txt'), 'x');
            fs.mkdirSync(path.join(outputRoot, '.processing', 'keep-me'), { recursive: true });
        });
        await harness.jobs.ready;
        expect(fs.existsSync(path.join(harness.outputRoot, '.processing', stale))).toBe(false);
        expect(fs.existsSync(path.join(harness.outputRoot, '.processing', 'keep-me'))).toBe(true);
        await harness.shutdown();
    });

    it('writes schema v2, keeps progress monotonic, and moves the work folder', async () => {
        const harness = createHarness();
        await harness.jobs.ready;
        harness.setMode('wait-cancel');
        const queued = await harness.invoke('ok-cover:submit', request()) as { ok: boolean; value: { jobId: string } };
        expect(queued.ok).toBe(true);
        const configPath = path.join(harness.outputRoot, '.processing', queued.value.jobId, 'okc_config.json');
        await waitFor(() => fs.existsSync(configPath));
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        expect(config.schema_version).toBe(2);
        expect(config.device).toBe('cuda');
        expect(config).not.toHaveProperty('task_id');
        expect(config).not.toHaveProperty('app_base_dir');
        expect(config).not.toHaveProperty('base_dir');
        const convert = config.convert as { key: number; f0_method: string; deep: null; model_sha256: string; index_path: null; rvc: { index_rate: number } };
        expect(convert.key).toBe(3);
        expect(convert.f0_method).toBe('rmvpe');
        expect(convert.deep).toBeNull();
        expect(convert.index_path).toBeNull();
        expect(convert.rvc.index_rate).toBe(0.72);
        expect(convert.model_sha256).toBe(createHash('sha256').update('weights').digest('hex'));
        const input = (config.input_files as string[])[0];
        expect(path.basename(input)).toBe(`okc_${queued.value.jobId.slice(0, 8)}.mp3`);
        expect(fs.readFileSync(input)).toEqual(Buffer.from([1, 2, 3, 4]));
        const finalize = config.finalize as { lyrics_path: string };
        expect(fs.readFileSync(finalize.lyrics_path, 'utf8')).toBe('[00:01.00]一句');
        await harness.invoke('ok-cover:cancel', queued.value.jobId);
        await waitFor(() => !fs.existsSync(path.join(harness.outputRoot, '.processing', queued.value.jobId)));

        harness.setMode('success');
        const done = await harness.invoke('ok-cover:submit', request()) as { ok: boolean; value: { jobId: string } };
        await waitFor(() => harness.events.some(event => event.jobId === done.value.jobId && event.phase === 'done'));
        const mine = harness.events.filter(event => event.jobId === done.value.jobId);
        let progress = 0;
        for (const event of mine) {
            expect(event.progress).toBeGreaterThanOrEqual(progress - 1e-9);
            progress = event.progress;
        }
        expect(mine.some(event => event.phase === 'converting' && event.indeterminate)).toBe(true);
        expect(mine.at(-1)).toMatchObject({ phase: 'done', progress: 1 });
        expect(typeof mine.at(-1)?.workId).toBe('string');
        const doneIndex = harness.trace.lastIndexOf('rescan');
        expect(doneIndex).toBeGreaterThanOrEqual(0);
        expect(harness.trace[doneIndex + 1]).toBe(`notify:${mine.at(-1)?.workId}`);
        const folder = path.join(harness.outputRoot, '示例 - 夜航');
        expect(fs.existsSync(path.join(folder, '夜航人声.wav'))).toBe(true);
        expect(fs.existsSync(path.join(folder, '夜航伴奏.wav'))).toBe(true);
        expect(fs.existsSync(path.join(folder, '夜航原声.wav'))).toBe(true);
        expect(fs.readdirSync(folder).some(name => name.includes('和声'))).toBe(false);
        expect(fs.existsSync(path.join(harness.outputRoot, '.processing', done.value.jobId))).toBe(false);
        const listed = await harness.invoke('ok-cover:list-jobs') as { ok: boolean; value: CoverJobEvent[] };
        expect(listed.value.find(event => event.jobId === done.value.jobId)?.phase).toBe('done');
        await harness.shutdown();
    });

    it('reports a native fallback separator and renames a colliding folder', async () => {
        const harness = createHarness();
        await harness.jobs.ready;
        fs.mkdirSync(path.join(harness.outputRoot, '示例 - 夜航'));
        harness.setMode('fallback');
        const submitted = await harness.invoke('ok-cover:submit', request()) as { ok: boolean; value: { jobId: string } };
        await waitFor(() => harness.events.some(event => event.jobId === submitted.value.jobId && event.phase === 'done'));
        const mine = harness.events.filter(event => event.jobId === submitted.value.jobId);
        const separators = mine
            .map(event => (event as CoverJobEvent & { separator?: string }).separator)
            .filter((separator): separator is string => Boolean(separator));
        expect(separators).toContain('msst-native');
        expect(separators).toContain('builtin');
        expect(fs.existsSync(path.join(harness.outputRoot, '示例 - 夜航 (2)', '夜航人声.wav'))).toBe(true);
        await harness.shutdown();
    });

    it('maps a missing result line to JOB_FAILED and CUDA text to CUDA_OOM', async () => {
        const harness = createHarness();
        await harness.jobs.ready;
        harness.setMode('no-result');
        const missing = await harness.invoke('ok-cover:submit', request()) as { ok: boolean; value: { jobId: string } };
        await waitFor(() => harness.events.some(event => event.jobId === missing.value.jobId && event.phase === 'failed'));
        expect(harness.events.find(event => event.jobId === missing.value.jobId && event.phase === 'failed')?.errorCode).toBe('JOB_FAILED');
        expect(fs.existsSync(path.join(harness.outputRoot, '.processing', missing.value.jobId))).toBe(false);

        harness.setMode('cuda-stderr');
        const cuda = await harness.invoke('ok-cover:submit', request({ title: '另一首' })) as { ok: boolean; value: { jobId: string } };
        await waitFor(() => harness.events.some(event => event.jobId === cuda.value.jobId && event.phase === 'failed'));
        expect(harness.events.find(event => event.jobId === cuda.value.jobId && event.phase === 'failed')?.errorCode).toBe('CUDA_OOM');
        expect(fs.existsSync(path.join(harness.outputRoot, '.processing', cuda.value.jobId))).toBe(false);
        expect(fs.existsSync(path.join(harness.outputRoot, '示例 - 另一首'))).toBe(false);
        await harness.shutdown();
    });

    it('kills the process tree on cancel and removes the processing dir', async () => {
        const harness = createHarness();
        await harness.jobs.ready;
        harness.setMode('hang');
        const submitted = await harness.invoke('ok-cover:submit', request()) as { ok: boolean; value: { jobId: string } };
        const probe = path.join(harness.root, `${submitted.value.jobId}.json`);
        await waitFor(() => fs.existsSync(probe));
        const info = JSON.parse(fs.readFileSync(probe, 'utf8')) as { pids: { parent: number; child: number } };
        groups.push(info.pids.parent);
        expect(alive(info.pids.parent)).toBe(true);
        expect(alive(info.pids.child)).toBe(true);
        const cancelled = await harness.invoke('ok-cover:cancel', submitted.value.jobId) as { ok: boolean };
        expect(cancelled.ok).toBe(true);
        await waitFor(() => harness.events.some(event => event.jobId === submitted.value.jobId && event.phase === 'cancelled'));
        expect(alive(info.pids.parent)).toBe(false);
        expect(alive(info.pids.child)).toBe(false);
        expect(fs.existsSync(path.join(harness.outputRoot, '.processing', submitted.value.jobId))).toBe(false);
        expect(fs.readdirSync(harness.outputRoot).filter(name => !name.startsWith('.'))).toEqual([]);
        await harness.shutdown();
    });

    it('rejects bad requests before starting a job', async () => {
        const harness = createHarness();
        await harness.jobs.ready;
        expect((await harness.invoke('ok-cover:submit', request({ keySemitones: 13 })) as { code: string }).code).toBe('INVALID_REQUEST');
        expect((await harness.invoke('ok-cover:submit', request({ source: { fileName: 'x.ncm', bytes: new ArrayBuffer(4) } })) as { code: string }).code).toBe('SOURCE_ENCRYPTED');
        expect((await harness.invoke('ok-cover:submit', request({ source: { fileName: 'notes.txt', bytes: new ArrayBuffer(4) } })) as { code: string }).code).toBe('SOURCE_UNREADABLE');
        expect((await harness.invoke('ok-cover:submit', request({ modelId: 'missing' })) as { code: string }).code).toBe('MODEL_INVALID');
        expect((await harness.invoke('ok-cover:submit', request({ mode: 'aggressive' })) as { code: string }).code).toBe('MODE_UNAVAILABLE');
        harness.setBackend(null);
        expect((await harness.invoke('ok-cover:submit', request()) as { code: string }).code).toBe('COMPONENT_MISSING');
        expect((await harness.invoke('ok-cover:install-component') as { code: string }).code).toBe('DOWNLOAD_UNAVAILABLE');
        const models = await harness.invoke('ok-cover:list-models') as { ok: boolean; value: Array<{ id: string; hasIndex: boolean }> };
        expect(models.value.map(model => model.id)).toEqual(['m-demo']);
        expect(models.value[0].hasIndex).toBe(false);
        const component = await harness.invoke('ok-cover:get-component') as { ok: boolean; value: { state: string; installRoot: string | null } };
        expect(component.value.state).toBe('absent');
        await harness.shutdown();
    });

    it('rejects an untrusted sender before the handler runs', async () => {
        const handlers = new Map<string, Handler>();
        registerCoverIpc(
            { handle: (channel, handler) => { handlers.set(channel, handler); } },
            {
                userDataDir: '',
                getOutputRoot: () => null,
                getBackendDir: () => null,
                works: { async rescan() {}, notifyChanged() {} },
                send() {},
                onQuit() {},
            },
            { isTrusted: () => false, jobs: { checkGpu: async () => ({ ok: true, name: 'Fake' }) } },
        );
        expect(() => handlers.get('ok-cover:submit')!({ sender: 9 }, request())).toThrow(/Untrusted renderer/);
    });

    it('keeps the other ok channels stubbed and answers cover from the real handler', async () => {
        const handlers = new Map<string, Handler>();
        const registered = registerOkIpc({
            ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
            isTrustedSender: () => true,
            coverOptions: { checkGpu: async () => ({ ok: true, name: 'Fake' }) },
        });
        const works = await handlers.get('ok-works:list')!({ sender: 1 }) as { ok: boolean; code: string; detail: string };
        expect(works).toEqual({ ok: false, code: 'UNKNOWN', detail: 'not implemented' });
        const submit = await handlers.get('ok-cover:submit')!({ sender: 1 }, request()) as { code: string };
        expect(submit.code).toBe('OUTPUT_ROOT_MISSING');
        expect(handlers.has('ok-cover:submit')).toBe(true);
        await registered.cover.jobs.shutdown();
    });
});
