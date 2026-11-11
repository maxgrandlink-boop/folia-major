import type { LiveLevels, LiveMode, LiveModeSource, LiveStatus } from '../../types/live';
import { useLiveSettingsStore } from '../../stores/useLiveSettingsStore';
import { readOkBridge } from '../ok/okAccess';

// src/services/live/liveSession.ts
// 直播状态。电平走单独的订阅，不进 React state。

export interface LiveSessionSnapshot {
    status: LiveStatus | null;
    error: string | null;
}

const listeners = new Set<() => void>();
const levelListeners = new Set<(levels: LiveLevels) => void>();

let snapshot: LiveSessionSnapshot = { status: null, error: null };

function publish(patch: Partial<LiveSessionSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
}

export function getLiveSession(): LiveSessionSnapshot {
    return snapshot;
}

export function subscribeLiveSession(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function subscribeLiveLevels(listener: (levels: LiveLevels) => void): () => void {
    levelListeners.add(listener);
    return () => levelListeners.delete(listener);
}

async function pushStored(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    const stored = useLiveSettingsStore.getState();
    await bridge.live.setFollowConfig(stored.follow);
    await bridge.live.setSmartReverb(stored.smartReverb);
    await bridge.live.setPluginGains(stored.gains);
    await bridge.live.setLeaveAiGap(stored.leaveAiGapMs);
    const mode = await bridge.live.setMode(stored.mode, 'restore');
    if (mode.ok) publish({ status: mode.value, error: null });
    else publish({ error: mode.code });
}

/** 订阅状态和电平，并把存着的直播设置推给桥。 */
export function startLiveSession(): () => void {
    const bridge = readOkBridge();
    if (!bridge) return () => {};
    const unsubs = [
        bridge.live.onStatus(status => publish({ status, error: null })),
        bridge.live.onLevels(levels => levelListeners.forEach(listener => listener(levels))),
    ];
    void (async () => {
        const current = await bridge.live.getStatus();
        if (current.ok) publish({ status: current.value });
        else publish({ error: current.code });
        await pushStored();
    })();
    void bridge.live.setLevelsSubscribed(true);
    return () => {
        unsubs.forEach(unsub => unsub());
        void bridge.live.setLevelsSubscribed(false);
    };
}

export async function setLiveMode(mode: LiveMode, source: LiveModeSource): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    useLiveSettingsStore.getState().setMode(mode);
    const result = await bridge.live.setMode(mode, source);
    if (!result.ok) {
        publish({ error: result.code });
        console.warn('[ok] set live mode', result.code);
        return;
    }
    publish({ status: result.value, error: null });
}
