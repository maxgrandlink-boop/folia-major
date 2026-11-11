import type { Work, WorkSkip, WorksRoot } from '../../types/multitrack';
import { readOkBridge } from '../ok/okAccess';

// src/services/multitrack/worksLibrary.ts
// 作品库。已跳过的目录只在 rescan 的结果里，所以打开时扫一次。

export interface WorksLibrarySnapshot {
    roots: WorksRoot[];
    works: Work[];
    skipped: WorkSkip[];
    error: string | null;
}

const listeners = new Set<() => void>();
let snapshot: WorksLibrarySnapshot = { roots: [], works: [], skipped: [], error: null };

function publish(patch: Partial<WorksLibrarySnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
}

export function getWorksLibrary(): WorksLibrarySnapshot {
    return snapshot;
}

export function subscribeWorksLibrary(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function workById(workId: string | null): Work | null {
    if (!workId) return null;
    return snapshot.works.find(work => work.id === workId) ?? null;
}

async function reload(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const [roots, works, scan] = await Promise.all([
        bridge.works.listRoots(),
        bridge.works.list(),
        bridge.works.rescan(),
    ]);
    if (!roots.ok || !works.ok) {
        publish({ error: (!roots.ok ? roots.code : !works.ok ? works.code : 'UNKNOWN') });
        return;
    }
    publish({
        roots: roots.value,
        works: works.value,
        skipped: scan.ok ? scan.value.skipped : snapshot.skipped,
        error: scan.ok ? null : scan.code,
    });
}

/** 订阅作品变化，并先拉一份列表和跳过原因。 */
export function startWorksLibrary(): () => void {
    const bridge = readOkBridge();
    if (!bridge) return () => {};
    const unsub = bridge.works.onChanged(() => { void reload(); });
    void reload();
    return unsub;
}

export async function addWorksRoot(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.works.addRoot();
    if (!result.ok) {
        publish({ error: result.code });
        console.warn('[ok] add works root', result.code);
        return;
    }
    await reload();
}

export async function removeWorksRoot(rootId: string): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.works.removeRoot(rootId);
    if (!result.ok) {
        publish({ error: result.code });
        console.warn('[ok] remove works root', result.code);
        return;
    }
    await reload();
}

export async function rescanWorks(): Promise<void> {
    await reload();
}
