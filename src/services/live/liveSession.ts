import type { FollowConfig, LiveLevels, LiveMode, LiveModeSource, LiveStatus, PluginGains, PluginInfo, SmartReverbConfig } from '../../types/live';
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

async function push<T>(write: () => void, send: () => Promise<{ ok: true; value: T } | { ok: false; code: string }>): Promise<string | null> {
    write();
    const bridge = readOkBridge();
    if (!bridge) return null;
    const result = await send();
    if (!result.ok) {
        publish({ error: result.code });
        console.warn('[ok] live settings', result.code);
        return result.code;
    }
    publish({ error: null });
    return null;
}

export function pushFollow(follow: FollowConfig): Promise<string | null> {
    return push(() => useLiveSettingsStore.getState().setFollow(follow), () => readOkBridge()!.live.setFollowConfig(follow));
}

export function pushSmartReverb(smartReverb: SmartReverbConfig): Promise<string | null> {
    return push(() => useLiveSettingsStore.getState().setSmartReverb(smartReverb), () => readOkBridge()!.live.setSmartReverb(smartReverb));
}

export function pushPluginGains(gains: PluginGains): Promise<string | null> {
    return push(() => useLiveSettingsStore.getState().setGains(gains), () => readOkBridge()!.live.setPluginGains(gains));
}

export function pushLeaveAiGap(ms: number): Promise<string | null> {
    return push(() => useLiveSettingsStore.getState().setLeaveAiGapMs(ms), () => readOkBridge()!.live.setLeaveAiGap(ms));
}

export async function readPluginInfo(): Promise<PluginInfo | null> {
    const bridge = readOkBridge();
    if (!bridge) return null;
    const result = await bridge.live.getPluginInfo();
    if (!result.ok) {
        publish({ error: result.code });
        return null;
    }
    return result.value;
}

export async function openPluginFolder(): Promise<string | null> {
    const bridge = readOkBridge();
    if (!bridge) return null;
    const result = await bridge.live.openPluginFolder();
    return result.ok ? null : result.code;
}

/** 0 dB ≈ 83%。界面百分比用豆苞的换算。 */
export function pluginGainPercent(db: number): number {
    return Math.round((db + 60) / 72 * 100);
}
