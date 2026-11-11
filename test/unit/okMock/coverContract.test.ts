import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installOkMock, type OkMockHandle } from '../../../src/services/okMock/installOkMock';
import type { CoverJobEvent, CoverJobRequest } from '../../../src/types/cover';

// 同一组翻唱契约用例跑两遍：W1 mock，以及 coverIpc 接上假后端的真 handler。

const require = createRequire(import.meta.url);
const { registerCoverIpc } = require('../../../electron/cover/coverIpc.cjs') as {
    registerCoverIpc: (ipcMain: { handle: (channel: string, handler: Handler) => void }, deps: unknown, options: unknown) => {
        jobs: { ready: Promise<void>; shutdown: () => Promise<unknown> | null };
    };
};

type Handler = (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; code?: string; value?: { jobId: string } }>;

interface Subject {
    events: CoverJobEvent[];
    submit(overrides?: Partial<CoverJobRequest> & { source?: { fileName: string; bytes: ArrayBuffer } }): Promise<{ ok: boolean; code?: string; value?: { jobId: string } }>;
    cancel(jobId: string): Promise<{ ok: boolean; code?: string }>;
    workCount(): Promise<number>;
    armFailure(): void;
    prepareCancel(): void;
    speedUp(): void;
    useSuccess(): void;
    close(): Promise<void>;
}

const FAKE = path.resolve('test/fixtures/cover/fakeCoverBackend.mjs');
const cleanup: Array<() => Promise<void>> = [];

function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
        sourceSongId: 'local-1',
        source: { fileName: 'song.flac', bytes: new ArrayBuffer(16) },
        lyrics: null,
        modelId: 'm-demo',
        title: '夜航',
        artist: '示例',
        ...overrides,
    };
}

function collapsed(events: CoverJobEvent[], jobId: string): string[] {
    const phases: string[] = [];
    for (const event of events) {
        if (event.jobId !== jobId) continue;
        if (phases[phases.length - 1] !== event.phase) phases.push(event.phase);
    }
    return phases;
}

function assertMonotonic(events: CoverJobEvent[], jobId: string): void {
    let progress = 0;
    for (const event of events) {
        if (event.jobId !== jobId) continue;
        expect(event.progress).toBeGreaterThanOrEqual(progress - 1e-9);
        progress = event.progress;
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('timed out waiting for cover contract event');
}

function mockSubject(componentInstalled: boolean): Subject {
    const handle: OkMockHandle = installOkMock({ latencyMs: 0, componentInstalled });
    const events: CoverJobEvent[] = [];
    handle.bridge.cover.onJob(event => events.push(event));
    return {
        events,
        submit: (overrides) => handle.bridge.cover.submit(baseRequest(overrides) as CoverJobRequest),
        cancel: (jobId) => handle.bridge.cover.cancel(jobId),
        async workCount() {
            const listed = await handle.bridge.works.list();
            if (!listed.ok) throw new Error(listed.code);
            return listed.value.length;
        },
        armFailure: () => handle.failCoverJob('JOB_FAILED'),
        prepareCancel: () => handle.setClockRate(1),
        speedUp: () => handle.setClockRate(80),
        useSuccess: () => handle.setClockRate(80),
        close: async () => handle.uninstall(),
    };
}

function remember(subject: Subject): Subject {
    cleanup.push(() => subject.close());
    return subject;
}

function handlerSubject(componentInstalled: boolean): Subject {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okcover-contract-'));
    const outputRoot = path.join(root, 'out');
    const backendDir = path.join(root, 'backend');
    const userData = path.join(root, 'user');
    fs.mkdirSync(backendDir, { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.mkdirSync(path.join(userData, 'rvc-models', 'm-demo'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'rvc-models', 'm-demo', 'm-demo.pth'), 'weights');
    const events: CoverJobEvent[] = [];
    let mode = 'success';
    let quit: (() => Promise<unknown> | null) | null = null;
    const handlers = new Map<string, Handler>();
    registerCoverIpc({
        handle: (channel, handler) => { handlers.set(channel, handler); },
    }, {
        userDataDir: userData,
        getOutputRoot: () => outputRoot,
        getBackendDir: () => (componentInstalled ? backendDir : null),
        works: { async rescan() {}, notifyChanged() {} },
        send(_channel: string, payload: CoverJobEvent) { events.push(payload); },
        onQuit(cb: () => Promise<unknown> | null) { quit = cb; },
    }, {
        isTrusted: () => true,
        jobs: {
            graceMs: 200,
            checkGpu: async () => ({ ok: true, name: 'Fake GPU' }),
            commandFor: (spec: { jobId: string; jobDir: string }) => ({
                command: process.execPath,
                args: [FAKE, '--mode', mode, '--config', path.join(spec.jobDir, 'okc_config.json'), '--probe-out', path.join(root, `${spec.jobId}.json`)],
            }),
        },
    });
    const close = async () => {
        if (quit) await quit();
        fs.rmSync(root, { recursive: true, force: true });
    };
    cleanup.push(close);
    return {
        events,
        submit: (overrides) => handlers.get('ok-cover:submit')!({ sender: 1 }, baseRequest(overrides)),
        cancel: (jobId) => handlers.get('ok-cover:cancel')!({ sender: 1 }, jobId) as Promise<{ ok: boolean; code?: string }>,
        async workCount() {
            const names = fs.readdirSync(outputRoot).filter(name => !name.startsWith('.'));
            return names.filter(name => fs.statSync(path.join(outputRoot, name)).isDirectory()).length;
        },
        armFailure: () => { mode = 'fail'; },
        prepareCancel: () => { mode = 'wait-cancel'; },
        speedUp: () => {},
        useSuccess: () => { mode = 'success'; },
        close,
    };
}

async function runCoverContract(make: (componentInstalled: boolean) => Subject): Promise<void> {
    const missing = remember(make(false));
    try {
        const denied = await missing.submit();
        expect(denied).toMatchObject({ ok: false, code: 'COMPONENT_MISSING' });
    } finally {
        await missing.close();
    }

    const subject = remember(make(true));
    try {
        const before = await subject.workCount();
        expect((await subject.submit({ keySemitones: 1.5 }))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
        expect((await subject.submit({ modelId: 'no-such-model' }))).toMatchObject({ ok: false, code: 'MODEL_INVALID' });
        expect(await subject.workCount()).toBe(before);

        subject.armFailure();
        subject.speedUp();
        const failed = await subject.submit();
        expect(failed.ok).toBe(true);
        await waitFor(() => subject.events.some(event => event.jobId === failed.value?.jobId && event.phase === 'failed'));
        expect(subject.events.find(event => event.jobId === failed.value?.jobId && event.phase === 'failed')?.errorCode).toBe('JOB_FAILED');
        expect(await subject.workCount()).toBe(before);

        subject.prepareCancel();
        const cancelled = await subject.submit({ title: '取消这首' });
        expect(cancelled.ok).toBe(true);
        const cancelResult = await subject.cancel(cancelled.value!.jobId);
        expect(cancelResult.ok).toBe(true);
        await waitFor(() => subject.events.some(event => event.jobId === cancelled.value?.jobId && event.phase === 'cancelled'));
        expect(await subject.workCount()).toBe(before);

        subject.useSuccess();
        const first = await subject.submit({ title: '第一首' });
        const second = await subject.submit({ title: '第二首' });
        expect(first.ok && second.ok).toBe(true);
        await waitFor(() => [first.value!.jobId, second.value!.jobId].every(id => subject.events.some(event => event.jobId === id && event.phase === 'done')));
        for (const id of [first.value!.jobId, second.value!.jobId]) {
            expect(collapsed(subject.events, id)).toEqual(['queued', 'preparing', 'separating', 'converting', 'ingesting', 'done']);
            assertMonotonic(subject.events, id);
            expect(subject.events.some(event => event.jobId === id && event.phase === 'converting' && event.indeterminate)).toBe(true);
            expect(typeof subject.events.find(event => event.jobId === id && event.phase === 'done')?.workId).toBe('string');
        }
        const firstDone = subject.events.findIndex(event => event.jobId === first.value!.jobId && event.phase === 'done');
        const secondPreparing = subject.events.findIndex(event => event.jobId === second.value!.jobId && event.phase === 'preparing');
        expect(secondPreparing).toBeGreaterThan(firstDone);
        expect(await subject.workCount()).toBe(before + 2);
    } finally {
        await subject.close();
    }
}

afterEach(async () => {
    while (cleanup.length > 0) {
        const close = cleanup.pop();
        if (close) await close();
    }
});

describe('cover contract cases', () => {
    it('passes against the mock', async () => {
        await runCoverContract(installed => mockSubject(installed));
    });

    it('passes against the real handler', async () => {
        await runCoverContract(installed => handlerSubject(installed));
    });
});
