import type { CoverComponentStatus, CoverInstallProgress, CoverJobEvent, CoverJobRequest, RvcModel } from '../../types/cover';
import { readOkBridge } from '../ok/okAccess';

// src/services/cover/coverSession.ts
// 翻唱入口用的组件状态和任务进度。完整的组件页、音色管理是后面的 F2、F3。

export interface CoverSessionSnapshot {
    component: CoverComponentStatus | null;
    models: RvcModel[];
    install: CoverInstallProgress | null;
    job: CoverJobEvent | null;
    error: string | null;
}

const listeners = new Set<() => void>();
let snapshot: CoverSessionSnapshot = { component: null, models: [], install: null, job: null, error: null };

function publish(patch: Partial<CoverSessionSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
}

export function getCoverSession(): CoverSessionSnapshot {
    return snapshot;
}

export function subscribeCoverSession(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function reload(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const [component, models, jobs] = await Promise.all([
        bridge.cover.getComponent(),
        bridge.cover.listModels(),
        bridge.cover.listJobs(),
    ]);
    publish({
        component: component.ok ? component.value : snapshot.component,
        models: models.ok ? models.value : snapshot.models,
        job: jobs.ok ? jobs.value[0] ?? snapshot.job : snapshot.job,
        error: !component.ok ? component.code : !models.ok ? models.code : null,
    });
}

export function startCoverSession(): () => void {
    const bridge = readOkBridge();
    if (!bridge) return () => {};
    const unsubs = [
        bridge.cover.onInstallProgress(install => {
            publish({ install });
            if (install.phase === 'done' || install.phase === 'error' || install.phase === 'cancelled') void reload();
        }),
        bridge.cover.onJob(job => publish({ job, error: job.errorCode ?? null })),
    ];
    void reload();
    return () => unsubs.forEach(unsub => unsub());
}

export async function installCoverComponent(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.cover.installComponent();
    if (!result.ok) {
        publish({ error: result.code });
        console.warn('[ok] install cover component', result.code);
    }
}

export async function cancelCoverInstall(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    await bridge.cover.cancelInstall();
}

export async function addCoverModel(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.cover.addModel();
    if (!result.ok) {
        publish({ error: result.code });
        return;
    }
    publish({ models: [...snapshot.models, result.value], error: null });
}

/** 入口表单收成契约请求。F2 换成真正的本地歌曲时仍走这个形状。 */
export function buildCoverRequest(input: {
    modelId: string;
    title: string;
    artist: string;
    keySemitones: number;
}): CoverJobRequest {
    return {
        sourceSongId: 'ok-cover-entry',
        source: { fileName: 'source.wav', bytes: new ArrayBuffer(8) },
        lyrics: null,
        modelId: input.modelId,
        title: input.title,
        artist: input.artist.length > 0 ? input.artist : null,
        keySemitones: input.keySemitones,
    };
}

export async function submitCoverJob(request: CoverJobRequest): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.cover.submit(request);
    if (!result.ok) {
        publish({ error: result.code });
        console.warn('[ok] cover submit', result.code);
    }
}

export async function cancelCoverJob(jobId: string): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.cover.cancel(jobId);
    if (!result.ok) publish({ error: result.code });
}
