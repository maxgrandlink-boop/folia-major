import { DEFAULT_WORK_MIX, type EngineClock, type EngineErrorCode, type EngineState, type MixRole, type OutputRoute, type WorkMix } from '../../types/multitrack';
import { useLiveSettingsStore } from '../../stores/useLiveSettingsStore';
import { readOkBridge } from '../ok/okAccess';

// src/services/multitrack/workPlayback.ts
// 作品播放会话。界面不直接碰 window.electron.ok。时钟只留在这里，按 performance.now 外推，不写进 React state。

export interface WorkPlaybackError {
    code: EngineErrorCode;
    workId: string | null;
}

export interface WorkPlaybackSnapshot {
    attempt: number;
    workId: string | null;
    status: EngineState['status'];
    durationSec: number;
    route: OutputRoute;
    karaoke: boolean;
    harmony: boolean;
    mix: WorkMix;
    lyricsOffsetMs: number;
    pending: boolean;
    error: WorkPlaybackError | null;
}

export interface PlayRequest {
    master: { volume: number; muted: boolean };
    loopOne: boolean;
    startSec?: number;
}

const listeners = new Set<() => void>();

let attempt = 0;
let clock = { positionSec: 0, playing: false, atMs: 0 };
let writeTimer: ReturnType<typeof setTimeout> | null = null;

let snapshot: WorkPlaybackSnapshot = {
    attempt: 0,
    workId: null,
    status: 'idle',
    durationSec: 0,
    route: 'local',
    karaoke: false,
    harmony: false,
    mix: {
        vocal: { ...DEFAULT_WORK_MIX.vocal },
        instrumental: { ...DEFAULT_WORK_MIX.instrumental },
        original: { ...DEFAULT_WORK_MIX.original },
    },
    lyricsOffsetMs: 0,
    pending: false,
    error: null,
};

function publish(patch: Partial<WorkPlaybackSnapshot>): void {
    snapshot = {
        ...snapshot,
        ...patch,
        mix: patch.mix ? {
            vocal: { ...patch.mix.vocal },
            instrumental: { ...patch.mix.instrumental },
            original: { ...patch.mix.original },
        } : snapshot.mix,
    };
    listeners.forEach(listener => listener());
}

function cloneMix(mix: WorkMix): WorkMix {
    return {
        vocal: { ...mix.vocal },
        instrumental: { ...mix.instrumental },
        original: { ...mix.original },
    };
}

export function getWorkPlayback(): WorkPlaybackSnapshot {
    return snapshot;
}

export function subscribeWorkPlayback(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** 已听到的位置。播放中用上一拍时钟外推，不依赖下一拍事件。 */
export function readPositionSec(): number {
    const duration = snapshot.durationSec;
    if (!clock.playing) return clock.positionSec;
    const next = clock.positionSec + (performance.now() - clock.atMs) / 1000;
    if (duration > 0) return Math.min(duration, Math.max(0, next));
    return Math.max(0, next);
}

function noteClock(positionSec: number, playing: boolean): void {
    clock = { positionSec, playing, atMs: performance.now() };
}

function currentAttempt(eventAttempt: number): boolean {
    return snapshot.attempt !== 0 && eventAttempt === snapshot.attempt;
}

function onState(state: EngineState): void {
    if (!currentAttempt(state.attempt)) return;
    noteClock(readPositionSec(), state.status === 'playing');
    publish({
        status: state.status,
        durationSec: state.durationSec,
        route: state.route,
        karaoke: state.karaoke,
        harmony: state.harmony,
        workId: state.workId,
    });
}

function onClock(event: EngineClock): void {
    if (!currentAttempt(event.attempt)) return;
    noteClock(event.positionSec, event.playing);
}

export function startWorkPlayback(): () => void {
    const bridge = readOkBridge();
    if (!bridge) return () => {};
    const stored = useLiveSettingsStore.getState();
    publish({ karaoke: stored.karaoke, harmony: stored.harmony });
    void bridge.engine.setKaraoke(stored.karaoke);
    void bridge.engine.setHarmony(stored.harmony);
    const unsubs = [
        bridge.engine.onState(onState),
        bridge.engine.onClock(onClock),
        bridge.engine.onEnded(event => {
            if (!currentAttempt(event.attempt)) return;
            noteClock(snapshot.durationSec, false);
            publish({ status: 'ended' });
        }),
        bridge.engine.onError(event => {
            if (event.attempt !== null && !currentAttempt(event.attempt)) return;
            publish({ error: { code: event.code, workId: snapshot.workId }, status: event.fatal ? 'error' : snapshot.status });
            console.warn('[ok] engine error', event.code);
        }),
    ];
    return () => {
        unsubs.forEach(unsub => unsub());
        if (writeTimer !== null) clearTimeout(writeTimer);
    };
}

function fail(code: EngineErrorCode, workId: string | null): void {
    publish({ error: { code, workId } });
    console.warn('[ok] playback', code, workId);
}

/** 载入并播放一首作品。attempt 递增，旧回复丢掉。 */
export async function playWork(workId: string, request: PlayRequest): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge) return;
    attempt += 1;
    const mine = attempt;
    publish({ pending: true, error: null });
    const settings = await bridge.works.readSettings(workId);
    if (mine !== attempt) return;
    if (!settings.ok) {
        publish({ pending: false });
        fail(settings.code === 'WORK_NOT_FOUND' ? 'WORK_NOT_FOUND' : 'UNKNOWN', workId);
        return;
    }
    const stored = useLiveSettingsStore.getState();
    const mix = cloneMix(settings.value.mix);
    const loaded = await bridge.engine.load({
        attempt: mine,
        workId,
        mix,
        karaoke: stored.karaoke,
        harmony: stored.harmony,
        master: request.master,
        startSec: request.startSec ?? 0,
        autoplay: true,
        loopOne: request.loopOne,
    });
    if (mine !== attempt) return;
    if (!loaded.ok) {
        publish({ pending: false });
        fail(loaded.code, workId);
        return;
    }
    noteClock(request.startSec ?? 0, true);
    publish({
        attempt: mine,
        workId,
        status: 'playing',
        durationSec: loaded.value.durationSec,
        mix,
        lyricsOffsetMs: settings.value.lyricsOffsetMs,
        karaoke: stored.karaoke,
        harmony: stored.harmony,
        pending: false,
        error: null,
    });
}

export async function toggleWorkPlayback(): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge || snapshot.attempt === 0) return;
    if (snapshot.status === 'playing') {
        const result = await bridge.engine.pause(snapshot.attempt);
        if (!result.ok) fail(result.code, snapshot.workId);
        return;
    }
    if (snapshot.status === 'ended') {
        const seeked = await bridge.engine.seek(snapshot.attempt, 0);
        if (!seeked.ok) {
            fail(seeked.code, snapshot.workId);
            return;
        }
        noteClock(seeked.value.positionSec, false);
    }
    const result = await bridge.engine.play(snapshot.attempt);
    if (!result.ok) fail(result.code, snapshot.workId);
}

export async function seekWork(sec: number): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge || snapshot.attempt === 0) return;
    const result = await bridge.engine.seek(snapshot.attempt, sec);
    if (!result.ok) {
        fail(result.code, snapshot.workId);
        return;
    }
    noteClock(result.value.positionSec, snapshot.status === 'playing');
}

export async function setMaster(volume: number, muted: boolean): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge || snapshot.attempt === 0) return;
    const result = await bridge.engine.setMaster(volume, muted);
    if (!result.ok) fail(result.code, snapshot.workId);
}

export async function setLoopOne(on: boolean): Promise<void> {
    const bridge = readOkBridge();
    if (!bridge || snapshot.attempt === 0) return;
    const result = await bridge.engine.setLoopOne(on);
    if (!result.ok) fail(result.code, snapshot.workId);
}

function scheduleWrite(): void {
    const bridge = readOkBridge();
    const workId = snapshot.workId;
    if (!bridge || !workId) return;
    if (writeTimer !== null) clearTimeout(writeTimer);
    const mix = cloneMix(snapshot.mix);
    const lyricsOffsetMs = snapshot.lyricsOffsetMs;
    writeTimer = setTimeout(() => {
        writeTimer = null;
        void bridge.works.writeSettings(workId, { mix, lyricsOffsetMs }).then(result => {
            if (!result.ok) fail(result.code === 'WRITE_FAILED' ? 'UNKNOWN' : 'UNKNOWN', workId);
        });
    }, 200);
}

async function pushMix(mix: WorkMix): Promise<void> {
    publish({ mix });
    scheduleWrite();
    const bridge = readOkBridge();
    if (!bridge || snapshot.attempt === 0 || snapshot.status === 'idle' || snapshot.status === 'error') return;
    const result = await bridge.engine.setMix(snapshot.attempt, mix);
    if (!result.ok && result.code !== 'NOT_LOADED' && result.code !== 'SUPERSEDED') fail(result.code, snapshot.workId);
}

export async function setTrackGain(role: MixRole, gain: number): Promise<void> {
    const next = Math.round(Math.min(100, Math.max(0, gain)));
    const mix = cloneMix(snapshot.mix);
    mix[role] = { ...mix[role], gain: next };
    await pushMix(mix);
}

export async function setTrackMuted(role: MixRole, muted: boolean): Promise<void> {
    const mix = cloneMix(snapshot.mix);
    mix[role] = { ...mix[role], muted };
    await pushMix(mix);
}

export async function setKaraoke(on: boolean): Promise<void> {
    useLiveSettingsStore.getState().setKaraoke(on);
    publish({ karaoke: on });
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.engine.setKaraoke(on);
    if (!result.ok) fail(result.code, snapshot.workId);
}

export async function setHarmony(on: boolean): Promise<void> {
    useLiveSettingsStore.getState().setHarmony(on);
    publish({ harmony: on });
    const bridge = readOkBridge();
    if (!bridge) return;
    const result = await bridge.engine.setHarmony(on);
    if (!result.ok) fail(result.code, snapshot.workId);
}

/** 样本「暗号」。作品库接上之前，分轨面板用它把滑杆落到一首真实结构的作品上。 */
export const SAMPLE_WORK_ID = 'w-anhao';
