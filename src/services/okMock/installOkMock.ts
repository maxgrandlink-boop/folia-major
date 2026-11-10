import type { OkBridge, Unsubscribe } from '../../types/okBridge';
import type {
    EngineClock, EngineEnded, EngineErrorCode, EngineErrorEvent, EngineLoadRequest, EngineLoaded,
    EngineLooped, EngineState, EngineStatus, OutputDevice, OutputDevicesEvent, OutputRoute, Result,
    TrackRole, Work, WorkMix, WorkSettings, WorkTrack, WorksChangedEvent, WorksErrorCode,
} from '../../types/multitrack';
import type { CoverComponentStatus, CoverErrorCode, CoverInstallProgress, CoverJobEvent, CoverJobPhase, CoverJobRequest, CoverMode, CoverPartId, CoverSeparator, RvcModel } from '../../types/cover';
import { COVER_MODE_TRACKS } from '../../types/cover';
import type { FollowConfig, LiveMode, LiveModeSource, LiveStatus, PluginConnection, PluginGains, SmartReverbConfig } from '../../types/live';
import { OK_CONTRACT_VERSION, DEFAULT_WORK_MIX } from '../../types/multitrack';
import { DEFAULT_LIVE_SETTINGS, PLUGIN_TRACK_VOLUME_DB_MAX, PLUGIN_TRACK_VOLUME_DB_MIN } from '../../types/live';
import { MOCK_COVER_ROOT, MOCK_DEVICES, MOCK_MODELS, MOCK_ROOT, MOCK_SILENT_RANGES, MOCK_SKIPPED, MOCK_WORKS } from './fixtures';

// src/services/okMock/installOkMock.ts
// W1 mock。只在开发构建且 VITE_OK_MOCK=true 时由 bootstrap 调用；这里的定时器在 uninstall 时全部清掉。

export interface OkMockOptions {
    latencyMs?: number;
    pluginConnected?: boolean;
    componentInstalled?: boolean;
    enhanceInstalled?: boolean;
    msstNativeInstalled?: boolean;
    works?: Work[];
}

export interface OkMockHandle {
    bridge: OkBridge;
    uninstall(): void;
    failNext(command: string, code: string): void;
    disconnectPlugin(): void;
    reconnectPlugin(): void;
    setPluginAbiMismatch(): void;
    setPluginDuplicate(): void;
    crashEngine(): void;
    breakWork(workId: string): void;
    failCoverJob(code: CoverErrorCode, atPhase?: CoverJobPhase): void;
    setClockRate(rate: number): void;
}

declare global {
    interface Window {
        __okMock?: OkMockHandle;
    }
}

const PART_ORDER: readonly CoverPartId[] = ['torch-cuda', 'runtime', 'base-models', 'enhance-models', 'msst-native'];
const REQUIRED_PARTS: readonly CoverPartId[] = ['torch-cuda', 'runtime', 'base-models'];
const PART_BYTES: Record<CoverPartId, number> = {
    'torch-cuda': 5_814_173_571,
    runtime: 1_994_686_114,
    'base-models': 1_283_799_081,
    'enhance-models': 1_826_204_379,
    'msst-native': 1_902_601_117,
};
const REQUIRED_BYTES = REQUIRED_PARTS.reduce((sum, id) => sum + PART_BYTES[id], 0);
const ENCRYPTED_EXTENSIONS = ['.ncm', '.qmc0', '.qmc3', '.qmcflac', '.qmcogg', '.mflac', '.mgg', '.kgm', '.kgma', '.kwm', '.m4p'];
const TRACK_LABEL: Record<'vocal' | 'instrumental' | 'original', string> = {
    vocal: '人声',
    instrumental: '伴奏',
    original: '原声',
};
const DEFAULT_INSTALL_ROOT = 'C:\\Users\\demo\\AppData\\Local\\okchang\\cover-runtime';
const PICKED_INSTALL_DIR = 'D:\\ok唱歌翻唱组件';
const PLUGIN_INSTALL_DIR = 'C:\\Program Files\\Common Files\\VST3';
const LIVE_MODES: readonly LiveMode[] = ['speech', 'reverb-speech', 'ai-follow', 'ai-sing'];
const LIVE_SOURCES: readonly LiveModeSource[] = ['ui', 'hotkey', 'restore'];
const MSST_MESSAGES = [
    'MSST Stage 1: 分离人声和伴奏...',
    'MSST Stage 2 (Normal): 人声去混响...',
];
const COVER_STEPS: ReadonlyArray<{ delay: number; phase: CoverJobPhase; progress: number; indeterminate?: boolean; message?: string }> = [
    { delay: 500, phase: 'preparing', progress: 0.02 },
    { delay: 500, phase: 'preparing', progress: 0.05 },
    { delay: 500, phase: 'separating', progress: 0.16, message: MSST_MESSAGES[0] },
    { delay: 500, phase: 'separating', progress: 0.27, message: MSST_MESSAGES[1] },
    { delay: 500, phase: 'separating', progress: 0.38, message: MSST_MESSAGES[0] },
    { delay: 500, phase: 'separating', progress: 0.49, message: MSST_MESSAGES[1] },
    { delay: 500, phase: 'separating', progress: 0.60, message: MSST_MESSAGES[0] },
    { delay: 1000, phase: 'converting', progress: 0.60, indeterminate: true },
    { delay: 1000, phase: 'converting', progress: 0.60, indeterminate: true },
    { delay: 1000, phase: 'converting', progress: 0.60, indeterminate: true },
    { delay: 500, phase: 'ingesting', progress: 0.85 },
    { delay: 500, phase: 'ingesting', progress: 0.92 },
    { delay: 500, phase: 'ingesting', progress: 0.99 },
];

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface MockJob {
    id: string;
    title: string;
    artist: string | null;
    lyrics: CoverJobRequest['lyrics'];
    phase: CoverJobPhase;
    progress: number;
    finished: boolean;
    started: boolean;
    settled: boolean;
    token: number;
    latest: CoverJobEvent;
    mode: CoverMode;
    separator: CoverSeparator;
    reachedSeparating: boolean;
}

interface EngineRuntime {
    loaded: boolean;
    attempt: number;
    workId: string | null;
    status: EngineStatus;
    durationSec: number;
    route: OutputRoute;
    outputDeviceId: string | null;
    karaoke: boolean;
    harmony: boolean;
    loopOne: boolean;
    basePosition: number;
    baseNow: number;
    playing: boolean;
    seq: number;
    master: { volume: number; muted: boolean };
    mix: WorkMix;
}

function ok<T>(value: T): { ok: true; value: T } {
    return { ok: true, value };
}

function fail<C extends string>(code: C): { ok: false; code: C } {
    return { ok: false, code };
}

function cloneMix(mix: WorkMix): WorkMix {
    return {
        vocal: { ...mix.vocal },
        instrumental: { ...mix.instrumental },
        original: { ...mix.original },
    };
}

function cloneWork(work: Work): Work {
    return {
        ...work,
        tracks: work.tracks.map(track => ({ ...track })),
        lyrics: work.lyrics ? { ...work.lyrics } : null,
        meta: work.meta ? { ...work.meta } : null,
        warnings: [...work.warnings],
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function inRange(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isTrackMix(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const mix = value as { gain?: unknown; muted?: unknown };
    return typeof mix.gain === 'number' && Number.isInteger(mix.gain) && mix.gain >= 0 && mix.gain <= 100 && typeof mix.muted === 'boolean';
}

function isWorkMix(value: unknown): value is WorkMix {
    if (!value || typeof value !== 'object') return false;
    const mix = value as WorkMix;
    return isTrackMix(mix.vocal) && isTrackMix(mix.instrumental) && isTrackMix(mix.original);
}

function isFollow(value: unknown): value is FollowConfig {
    if (!value || typeof value !== 'object') return false;
    const config = value as FollowConfig;
    return (config.control === 'threshold' || config.control === 'monitor')
        && inRange(config.thresholdDb, -80, 0)
        && inRange(config.fadeInSec, 0, 2)
        && inRange(config.fadeOutSec, 0.1, 2)
        && inRange(config.vocalCap, 0, 1);
}

function isSmartReverb(value: unknown): value is SmartReverbConfig {
    if (!value || typeof value !== 'object') return false;
    const config = value as SmartReverbConfig;
    return typeof config.enabled === 'boolean'
        && inRange(config.silenceSec, 0.1, 5)
        && inRange(config.earlyReturnSec, 0.1, 5)
        && (config.returnMode === 'ai-follow' || config.returnMode === 'ai-sing');
}

function isGains(value: unknown): value is PluginGains {
    if (!value || typeof value !== 'object') return false;
    const gains = value as PluginGains;
    return inRange(gains.normalSpeechDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)
        && inRange(gains.reverbSpeechDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)
        && inRange(gains.aiVoiceDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)
        && inRange(gains.aiAccompDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX);
}

function isLoadRequest(value: unknown): value is EngineLoadRequest {
    if (!value || typeof value !== 'object') return false;
    const req = value as EngineLoadRequest;
    return typeof req.attempt === 'number' && Number.isFinite(req.attempt)
        && typeof req.workId === 'string' && req.workId.length > 0
        && isWorkMix(req.mix)
        && typeof req.karaoke === 'boolean'
        && typeof req.harmony === 'boolean'
        && req.master !== null && typeof req.master === 'object'
        && inRange(req.master.volume, 0, 1)
        && typeof req.master.muted === 'boolean'
        && typeof req.startSec === 'number' && Number.isFinite(req.startSec)
        && typeof req.autoplay === 'boolean'
        && typeof req.loopOne === 'boolean';
}

function validKey(value: number): boolean {
    return Number.isInteger(value) && value >= -12 && value <= 12;
}

function isCoverMode(value: CoverMode | undefined): boolean {
    return value === undefined || value === 'library' || value === 'normal' || value === 'aggressive';
}

function isCoverSeparator(value: CoverSeparator | undefined): boolean {
    return value === undefined || value === 'builtin' || value === 'msst-native';
}

function isEncryptedSource(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return ENCRYPTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function isSubmitRequest(value: unknown): value is CoverJobRequest {
    if (!value || typeof value !== 'object') return false;
    const req = value as CoverJobRequest;
    if (typeof req.sourceSongId !== 'string' || req.sourceSongId.length === 0) return false;
    if (!req.source || typeof req.source.fileName !== 'string' || !(req.source.bytes instanceof ArrayBuffer)) return false;
    if (typeof req.modelId !== 'string' || typeof req.title !== 'string') return false;
    if (req.artist !== null && typeof req.artist !== 'string') return false;
    if (req.lyrics !== null) {
        if (!req.lyrics || typeof req.lyrics.content !== 'string' || typeof req.lyrics.format !== 'string') return false;
    }
    if (req.keySemitones !== undefined && (typeof req.keySemitones !== 'number' || !validKey(req.keySemitones))) return false;
    return true;
}

function coverPng(): ArrayBuffer {
    const bytes = Buffer.from(PNG_1X1_BASE64, 'base64');
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function timelineSec(work: Work): number {
    const duration = (role: TrackRole) => work.tracks.find(track => track.role === role)?.durationSec ?? null;
    return duration('instrumental') ?? duration('original') ?? duration('vocal') ?? 0;
}

function trackInfo(work: Work, timeline: number): EngineLoaded['tracks'] {
    return work.tracks.map(track => {
        const duration = track.durationSec ?? 0;
        return {
            role: track.role,
            durationSec: duration,
            padded: duration < timeline - 1e-6,
            trimmed: duration > timeline + 1e-6,
            transcoded: false,
        };
    });
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

export function installOkMock(options?: OkMockOptions): OkMockHandle {
    const latencyMs = options?.latencyMs ?? 20;
    let alive = true;
    let clockRate = 1;
    let connection: PluginConnection = options?.pluginConnected === false ? 'absent' : 'connected';
    let userMode: LiveMode = DEFAULT_LIVE_SETTINGS.mode;
    let effectiveMode: LiveMode = DEFAULT_LIVE_SETTINGS.mode;
    let switching = false;
    let smartReverbActive = false;
    let follow: FollowConfig = { ...DEFAULT_LIVE_SETTINGS.follow };
    let smart: SmartReverbConfig = { ...DEFAULT_LIVE_SETTINGS.smartReverb };
    let gains: PluginGains = { ...DEFAULT_LIVE_SETTINGS.gains };
    let leaveAiGapMs = DEFAULT_LIVE_SETTINGS.leaveAiGapMs;
    let modeToken = 0;
    let levelsWanted = false;
    let aiGate = 0;
    let lastLevelAt = 0;
    let engineDown = false;
    let circuitOpen = false;
    let pendingAttempt = 0;
    let crashToken = 0;
    const crashTimes: number[] = [];
    let installToken = 0;
    let jobSeq = 0;
    let coverSeq = 0;
    let extraModels = 0;
    let addRootCount = 0;
    let active: MockJob | null = null;
    let failArm: { code: CoverErrorCode; atPhase: CoverJobPhase } | null = null;
    let reverbRangeKey: string | null = null;
    let reverbEnteredAt = 0;
    const failNext = new Map<string, string>();
    const breakIds = new Set<string>();
    const extraSkipped = new Map<string, { relPath: string; reason: 'unreadable' }>();
    const settings = new Map<string, WorkSettings>();
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const listeners = new Map<string, Set<(payload: never) => void>>();
    let clockTimer: ReturnType<typeof setInterval> | null = null;
    let levelTimer: ReturnType<typeof setInterval> | null = null;

    let works = (options?.works ?? MOCK_WORKS).map(cloneWork);
    const roots = [cloneRoot(MOCK_ROOT), cloneRoot(MOCK_COVER_ROOT)];
    const models: RvcModel[] = MOCK_MODELS.map(model => ({ ...model }));
    const queue: MockJob[] = [];
    const jobs: MockJob[] = [];
    const partInstalled: Record<CoverPartId, boolean> = {
        'torch-cuda': options?.componentInstalled === true,
        runtime: options?.componentInstalled === true,
        'base-models': options?.componentInstalled === true,
        'enhance-models': options?.enhanceInstalled !== false,
        'msst-native': options?.msstNativeInstalled === true,
    };
    let installRoot: string | null = options?.componentInstalled === true ? DEFAULT_INSTALL_ROOT : null;
    let verifying = false;
    let locateSettle: ((result: Result<CoverComponentStatus, CoverErrorCode>) => void) | null = null;
    const engine: EngineRuntime = {
        loaded: false,
        attempt: 0,
        workId: null,
        status: 'idle',
        durationSec: 0,
        route: connection === 'connected' ? 'live' : 'local',
        outputDeviceId: null,
        karaoke: false,
        harmony: false,
        loopOne: false,
        basePosition: 0,
        baseNow: 0,
        playing: false,
        seq: 0,
        master: { volume: 1, muted: false },
        mix: cloneMix(DEFAULT_WORK_MIX),
    };

    function later(ms: number, fn: () => void): void {
        const id = setTimeout(() => {
            timeouts.delete(id);
            if (!alive) return;
            fn();
        }, ms);
        timeouts.add(id);
    }

    function every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
        const id = setInterval(() => {
            if (!alive) return;
            fn();
        }, ms);
        intervals.add(id);
        return id;
    }

    function on<T>(name: string, cb: (payload: T) => void): Unsubscribe {
        let set = listeners.get(name);
        if (!set) {
            set = new Set();
            listeners.set(name, set);
        }
        set.add(cb as (payload: never) => void);
        return () => set!.delete(cb as (payload: never) => void);
    }

    function emit<T>(name: string, payload: T): void {
        const set = listeners.get(name);
        if (!set) return;
        for (const cb of [...set]) (cb as (payload: T) => void)(payload);
    }

    function run<T, C extends string>(name: string, exec: () => Result<T, C>): Promise<Result<T, C>> {
        const fixed: Record<string, number> = {
            'works.addRoot': 300,
            'works.rescan': 500,
            'engine.load': 150,
            'cover.pickInstallDir': 400,
            'cover.addModel': 400,
        };
        const ms = fixed[name] ?? latencyMs;
        return new Promise(resolve => {
            later(ms, () => {
                const armed = failNext.get(name);
                if (armed !== undefined) {
                    failNext.delete(name);
                    resolve({ ok: false, code: armed as C });
                    return;
                }
                resolve(exec());
            });
        });
    }

    function done<C extends string>(): Result<void, C> {
        return { ok: true, value: undefined as void };
    }

    function snapshotState(): EngineState {
        return {
            attempt: engine.attempt,
            workId: engine.workId,
            status: engine.status,
            durationSec: engine.durationSec,
            route: engine.route,
            outputDeviceId: engine.outputDeviceId,
            karaoke: engine.karaoke,
            harmony: engine.harmony,
            loopOne: engine.loopOne,
        };
    }

    function emitState(): void {
        emit('engine.state', snapshotState());
    }

    function positionSec(): number {
        if (!engine.playing) return engine.basePosition;
        return engine.basePosition + ((performance.now() - engine.baseNow) / 1000) * clockRate;
    }

    function emitClock(): void {
        engine.seq += 1;
        const clock: EngineClock = {
            attempt: engine.attempt,
            positionSec: engine.playing ? positionSec() : engine.basePosition,
            playing: engine.playing,
            seq: engine.seq,
        };
        emit('engine.clock', clock);
    }

    function stopClock(): void {
        if (clockTimer === null) return;
        clearInterval(clockTimer);
        intervals.delete(clockTimer);
        clockTimer = null;
    }

    function startClock(): void {
        if (clockTimer !== null || !engine.playing) return;
        clockTimer = every(100, onClockTick);
    }

    function reachEnd(): void {
        if (engine.loopOne) {
            engine.basePosition = 0;
            engine.baseNow = performance.now();
            reverbRangeKey = null;
            const looped: EngineLooped = { attempt: engine.attempt };
            emit('engine.looped', looped);
            emitClock();
            updateSmartReverb(0);
            return;
        }
        engine.basePosition = engine.durationSec;
        engine.baseNow = performance.now();
        engine.playing = false;
        engine.status = 'ended';
        stopClock();
        const ended: EngineEnded = { attempt: engine.attempt };
        emit('engine.ended', ended);
        emitState();
        emitClock();
        updateSmartReverb(engine.durationSec);
    }

    function onClockTick(): void {
        if (!engine.playing) return;
        if (engine.durationSec > 0 && positionSec() >= engine.durationSec - 1e-6) {
            reachEnd();
            return;
        }
        emitClock();
        updateSmartReverb(positionSec());
    }

    function buildStatus(): LiveStatus {
        return {
            connection,
            route: connection === 'connected' ? 'live' : 'local',
            userMode,
            effectiveMode,
            switching,
            smartReverbActive,
            karaoke: engine.karaoke,
            hostSampleRate: null,
            latencyMs: null,
            underruns: 0,
            pluginBuild: null,
        };
    }

    function emitStatus(): void {
        emit('live.status', buildStatus());
    }

    function applyRoute(next: OutputRoute, alsoClock: boolean): void {
        engine.route = next;
        if (!engine.loaded) return;
        emitState();
        if (alsoClock) emitClock();
    }

    function setConnection(next: PluginConnection, alsoClock: boolean): void {
        connection = next;
        emitStatus();
        applyRoute(next === 'connected' ? 'live' : 'local', alsoClock);
        if (next === 'connected' && levelsWanted) startLevels();
        else stopLevels();
    }

    function updateSmartReverb(position: number): void {
        if (switching) return;
        const ai = userMode === 'ai-follow' || userMode === 'ai-sing';
        const ranges = engine.workId ? MOCK_SILENT_RANGES[engine.workId] ?? [] : [];
        const range = smart.enabled && engine.playing && ai
            ? ranges.find(([start, end]) => position >= start && position < end) ?? null
            : null;
        if (!range) {
            reverbRangeKey = null;
            if (smartReverbActive || effectiveMode !== userMode) {
                smartReverbActive = false;
                effectiveMode = userMode;
                emitStatus();
            }
            return;
        }
        const key = `${range[0]}:${range[1]}`;
        if (reverbRangeKey !== key) {
            reverbRangeKey = key;
            reverbEnteredAt = position;
        }
        if (position >= range[1] - smart.earlyReturnSec - 1e-4) {
            if (smartReverbActive || effectiveMode !== smart.returnMode) {
                smartReverbActive = false;
                effectiveMode = smart.returnMode;
                emitStatus();
            }
            return;
        }
        if (position - reverbEnteredAt >= smart.silenceSec - 1e-4) {
            if (!smartReverbActive || effectiveMode !== 'reverb-speech') {
                smartReverbActive = true;
                effectiveMode = 'reverb-speech';
                emitStatus();
            }
        }
    }

    function requireEngine(attempt: number): { ok: false; code: 'NOT_LOADED' | 'SUPERSEDED' } | null {
        if (!engine.loaded) return fail('NOT_LOADED');
        if (attempt !== engine.attempt) return fail('SUPERSEDED');
        return null;
    }

    function findWork(workId: string): Work | undefined {
        return works.find(work => work.id === workId);
    }

    function changed(rootId: string, added: Work[], removedIds: string[]): void {
        const event: WorksChangedEvent = { rootId, added, updated: [], removedIds };
        emit('works.changed', event);
    }

    function requiredReady(): boolean {
        return REQUIRED_PARTS.every(id => partInstalled[id]);
    }

    function neededParts(mode: CoverMode, separator: CoverSeparator): CoverPartId[] {
        const parts: CoverPartId[] = [...REQUIRED_PARTS];
        if (mode === 'normal' || mode === 'aggressive') parts.push('enhance-models');
        if (separator === 'msst-native') parts.push('msst-native');
        return parts;
    }

    function buildComponent(): CoverComponentStatus {
        const ready = requiredReady();
        const parts = PART_ORDER.map(id => ({
            id,
            required: REQUIRED_PARTS.includes(id),
            state: partInstalled[id] ? 'installed' as const : 'absent' as const,
            downloadBytes: PART_BYTES[id],
            installedBytes: PART_BYTES[id],
        }));
        const modes = (['library', 'normal', 'aggressive'] as const).flatMap(mode => (
            (['builtin', 'msst-native'] as const).map(separator => {
                const tracks = COVER_MODE_TRACKS[mode];
                if (mode === 'aggressive') {
                    return { mode, separator, available: false, reason: 'not-in-v1' as const, missingParts: [], tracks };
                }
                const missing = neededParts(mode, separator).filter(id => !partInstalled[id]);
                if (!ready || missing.length > 0) {
                    return {
                        mode,
                        separator,
                        available: false,
                        reason: 'missing-part' as const,
                        missingParts: missing.length > 0 ? missing : [...REQUIRED_PARTS],
                        tracks,
                    };
                }
                return { mode, separator, available: true, missingParts: [], tracks };
            })
        ));
        return {
            state: ready ? 'installed' : 'absent',
            version: ready ? '1.0.0' : null,
            downloadBytes: REQUIRED_BYTES,
            installedBytes: ready ? REQUIRED_BYTES : 0,
            installRoot: ready ? installRoot : null,
            gpu: { ok: true, name: 'NVIDIA 示例显卡' },
            parts,
            modes,
            defaultMode: partInstalled['enhance-models'] ? 'normal' : 'library',
            defaultSeparator: 'builtin',
        };
    }

    function jobEvent(job: MockJob, patch: Partial<CoverJobEvent> & Pick<CoverJobEvent, 'phase' | 'progress'>): void {
        if (patch.phase === 'separating') job.reachedSeparating = true;
        const withSeparator = job.reachedSeparating && (
            patch.phase === 'separating' || patch.phase === 'converting' || patch.phase === 'ingesting'
            || patch.phase === 'done' || patch.phase === 'failed' || patch.phase === 'cancelled'
        );
        const event: CoverJobEvent = {
            jobId: job.id,
            indeterminate: false,
            title: job.title,
            ...patch,
            ...(withSeparator ? { separator: job.separator } : {}),
        };
        job.phase = event.phase;
        job.progress = event.progress;
        job.latest = event;
        emit('cover.job', { ...event });
    }

    function settle(job: MockJob): void {
        if (job.settled) return;
        job.settled = true;
        if (active === job) active = null;
        pump();
    }

    function failJob(job: MockJob, code: CoverErrorCode): void {
        if (job.finished) return;
        job.finished = true;
        job.token += 1;
        jobEvent(job, { phase: 'failed', progress: job.progress, indeterminate: false, errorCode: code });
        settle(job);
    }

    function completeJob(job: MockJob): void {
        if (job.finished) return;
        coverSeq += 1;
        const track = (role: TrackRole, label: string): WorkTrack => ({
            role,
            source: 'manifest',
            fileName: `${job.title}${label}.wav`,
            sizeBytes: 176400 * 180,
            mtimeMs: 1793900000000,
            durationSec: 180,
        });
        const work: Work = {
            id: `w-cover-${coverSeq}`,
            rootId: 'root-cover',
            relPath: job.title,
            baseName: job.title,
            title: job.title,
            artist: job.artist,
            tracks: COVER_MODE_TRACKS[job.mode].map(role => track(role, TRACK_LABEL[role])),
            lyrics: job.lyrics ? { fileName: 'lyrics.lrc', format: job.lyrics.format, content: job.lyrics.content } : null,
            hasCover: false,
            completedAtMs: 1793900000000 + coverSeq,
            signature: `sig-cover-${coverSeq}`,
            meta: null,
            warnings: [],
        };
        works.push(work);
        changed('root-cover', [cloneWork(work)], []);
        job.finished = true;
        jobEvent(job, { phase: 'done', progress: 1, indeterminate: false, workId: work.id });
        settle(job);
    }

    function schedule(job: MockJob): void {
        const token = job.token;
        const rate = Math.max(clockRate, 1e-6);
        let at = 0;
        COVER_STEPS.forEach((step, index) => {
            at += step.delay;
            const when = at / rate;
            const last = index === COVER_STEPS.length - 1;
            later(when, () => {
                if (!alive || job.token !== token || job.finished) return;
                if (failArm && failArm.atPhase === step.phase) {
                    const arm = failArm;
                    failArm = null;
                    failJob(job, arm.code);
                    return;
                }
                jobEvent(job, {
                    phase: step.phase,
                    progress: step.progress,
                    indeterminate: step.indeterminate === true,
                    ...(step.message ? { message: step.message } : {}),
                });
                if (last) completeJob(job);
            });
        });
    }

    function pump(): void {
        if (active) return;
        const next = queue.find(job => !job.finished && !job.started);
        if (!next) return;
        next.started = true;
        active = next;
        schedule(next);
    }

    function claimParts(): CoverPartId[] {
        const parts: CoverPartId[] = [...REQUIRED_PARTS, 'enhance-models'];
        if (partInstalled['msst-native']) parts.push('msst-native');
        return parts;
    }

    function finishLocate(result: Result<CoverComponentStatus, CoverErrorCode>): void {
        const settleLocate = locateSettle;
        locateSettle = null;
        verifying = false;
        settleLocate?.(result);
    }

    function beginVerify(dir: string): void {
        const token = ++installToken;
        verifying = true;
        const parts = claimParts();
        const total = parts.reduce((sum, id) => sum + PART_BYTES[id], 0);
        const scaled = (ms: number) => ms / Math.max(clockRate, 1e-6);
        const send = (progress: CoverInstallProgress) => {
            if (token !== installToken) return;
            emit('cover.install', progress);
        };
        for (let i = 1; i <= 10; i += 1) {
            const partId = parts[(i - 1) % parts.length];
            const received = total * i / 10;
            later(scaled(i * 200), () => send({
                phase: 'verifying', receivedBytes: received, totalBytes: total, errorCode: null, partId,
            }));
        }
        later(scaled(2000), () => {
            if (token !== installToken) return;
            for (const id of REQUIRED_PARTS) partInstalled[id] = true;
            partInstalled['enhance-models'] = true;
            installRoot = dir;
            emit('cover.install', { phase: 'done', receivedBytes: total, totalBytes: total, errorCode: null, partId: null });
            finishLocate(ok(buildComponent()));
        });
    }

    function stopLevels(): void {
        if (levelTimer === null) return;
        clearInterval(levelTimer);
        intervals.delete(levelTimer);
        levelTimer = null;
    }

    function tickLevels(): void {
        const now = performance.now();
        const dt = Math.max(0, (now - lastLevelAt) / 1000);
        lastLevelAt = now;
        const micDb = -35 + 15 * Math.sin((2 * Math.PI * (now / 1000)) / 3);
        const target = follow.control === 'threshold'
            ? (micDb > follow.thresholdDb ? 1 : 0)
            : smoothstep(-48, -10, micDb);
        const fade = target > aiGate ? follow.fadeInSec : follow.fadeOutSec;
        if (!(fade > 0)) aiGate = target;
        else aiGate += (target - aiGate) * Math.min(1, dt / fade);
        emit('live.levels', { micDb, aiGate });
    }

    function startLevels(): void {
        if (levelTimer !== null || !levelsWanted || connection !== 'connected') return;
        lastLevelAt = performance.now();
        levelTimer = every(1000 / 15, tickLevels);
    }

    function emitDevices(): void {
        const devices: OutputDevice[] = MOCK_DEVICES.map(device => ({ ...device }));
        const event: OutputDevicesEvent = {
            devices,
            defaultId: devices.find(device => device.isDefault)?.id ?? null,
        };
        emit('engine.devices', event);
    }

    const bridge: OkBridge = {
        contractVersion: OK_CONTRACT_VERSION,
        works: {
            listRoots: () => run<typeof roots, WorksErrorCode>('works.listRoots', () => ok(roots.map(root => ({ ...root })))),
            addRoot: () => run('works.addRoot', () => {
                if (addRootCount >= 1) return fail('ROOT_DUPLICATE');
                addRootCount += 1;
                const source = MOCK_WORKS.find(work => work.id === 'w-lianxi');
                if (!source) return fail('UNKNOWN');
                const extra = cloneWork(source);
                extra.id = 'w-extra';
                extra.rootId = 'root-extra';
                const root = {
                    id: 'root-extra',
                    displayPath: 'E:\\Doubao-Lite-Customer-Test\\_internal\\豆苞数据\\导入',
                    kind: 'works-dir' as const,
                    addedAt: 1793808100000,
                    available: true,
                    isCoverOutput: false,
                };
                roots.push(root);
                works.push(extra);
                changed(root.id, [cloneWork(extra)], []);
                return ok({
                    root: { ...root },
                    summary: { added: 1, updated: 0, removed: 0, skipped: [] },
                });
            }),
            removeRoot: (rootId) => run('works.removeRoot', () => {
                if (rootId === 'root-cover') return fail('ROOT_PROTECTED');
                const index = roots.findIndex(root => root.id === rootId);
                if (index < 0) return fail('ROOT_NOT_FOUND');
                const removed = works.filter(work => work.rootId === rootId);
                roots.splice(index, 1);
                works = works.filter(work => work.rootId !== rootId);
                for (const work of removed) settings.delete(work.id);
                changed(rootId, [], removed.map(work => work.id));
                return done();
            }),
            rescan: (rootId) => run('works.rescan', () => {
                if (rootId !== undefined && !roots.some(root => root.id === rootId)) return fail('ROOT_NOT_FOUND');
                const removed = works.filter(work => breakIds.has(work.id) && (rootId === undefined || work.rootId === rootId));
                if (removed.length > 0) {
                    const ids = new Set(removed.map(work => work.id));
                    works = works.filter(work => !ids.has(work.id));
                    for (const work of removed) {
                        breakIds.delete(work.id);
                        extraSkipped.set(work.relPath, { relPath: work.relPath, reason: 'unreadable' });
                        settings.delete(work.id);
                    }
                    const byRoot = new Map<string, string[]>();
                    for (const work of removed) {
                        const list = byRoot.get(work.rootId) ?? [];
                        list.push(work.id);
                        byRoot.set(work.rootId, list);
                    }
                    for (const [id, removedIds] of byRoot) changed(id, [], removedIds);
                }
                return ok({
                    added: 0,
                    updated: 0,
                    removed: removed.length,
                    skipped: [...MOCK_SKIPPED.map(skip => ({ ...skip })), ...extraSkipped.values()],
                });
            }),
            list: (rootId) => run('works.list', () => {
                if (rootId !== undefined && !roots.some(root => root.id === rootId)) return fail('ROOT_NOT_FOUND');
                const list = works
                    .filter(work => rootId === undefined || work.rootId === rootId)
                    .sort((a, b) => b.completedAtMs - a.completedAtMs)
                    .map(cloneWork);
                return ok(list);
            }),
            readSettings: (workId) => run('works.readSettings', () => {
                if (!findWork(workId)) return fail('WORK_NOT_FOUND');
                const stored = settings.get(workId);
                return ok(stored
                    ? { mix: cloneMix(stored.mix), lyricsOffsetMs: stored.lyricsOffsetMs }
                    : { mix: cloneMix(DEFAULT_WORK_MIX), lyricsOffsetMs: 0 });
            }),
            writeSettings: (workId, next) => run('works.writeSettings', () => {
                if (!findWork(workId)) return fail('WORK_NOT_FOUND');
                if (!next || !isWorkMix(next.mix) || typeof next.lyricsOffsetMs !== 'number' || !Number.isFinite(next.lyricsOffsetMs)) {
                    return fail('INVALID_REQUEST');
                }
                settings.set(workId, { mix: cloneMix(next.mix), lyricsOffsetMs: next.lyricsOffsetMs });
                return done();
            }),
            readCover: (workId) => run('works.readCover', () => {
                const work = findWork(workId);
                if (!work) return fail('WORK_NOT_FOUND');
                return ok(work.hasCover ? coverPng() : null);
            }),
            reveal: (workId) => run('works.reveal', () => findWork(workId) ? done() : fail('WORK_NOT_FOUND')),
            onChanged: (cb) => on<WorksChangedEvent>('works.changed', cb),
        },
        engine: {
            load: (req) => {
                const valid = isLoadRequest(req);
                if (valid) pendingAttempt = req.attempt;
                return run('engine.load', () => {
                    if (!valid) return fail('INVALID_REQUEST');
                    if (req.attempt !== pendingAttempt) return fail('SUPERSEDED');
                    if (circuitOpen) return fail('CIRCUIT_OPEN');
                    const work = findWork(req.workId);
                    if (!work) return fail('WORK_NOT_FOUND');
                    if (work.id === 'w-broken' || breakIds.has(work.id)) return fail('TRACK_UNREADABLE');
                    const duration = timelineSec(work);
                    const start = clamp(req.startSec, 0, duration);
                    engine.loaded = true;
                    engine.attempt = req.attempt;
                    engine.workId = work.id;
                    engine.durationSec = duration;
                    engine.status = 'loading';
                    engine.karaoke = req.karaoke;
                    engine.harmony = req.harmony;
                    engine.loopOne = req.loopOne;
                    engine.mix = cloneMix(req.mix);
                    engine.master = { volume: req.master.volume, muted: req.master.muted };
                    engine.basePosition = start;
                    engine.baseNow = performance.now();
                    engine.playing = false;
                    engine.route = connection === 'connected' ? 'live' : 'local';
                    stopClock();
                    reverbRangeKey = null;
                    emitState();
                    engine.status = 'ready';
                    emitState();
                    if (req.autoplay) {
                        engine.status = 'playing';
                        engine.playing = true;
                        engine.baseNow = performance.now();
                        emitState();
                    }
                    emitClock();
                    updateSmartReverb(start);
                    if (engine.playing) startClock();
                    const loaded: EngineLoaded = {
                        attempt: req.attempt,
                        workId: work.id,
                        durationSec: duration,
                        sampleRate: work.id === 'w-anhao' ? 44100 : 48000,
                        tracks: trackInfo(work, duration),
                    };
                    return ok(loaded);
                });
            },
            play: (attempt) => run('engine.play', () => {
                const gate = requireEngine(attempt);
                if (gate) return gate;
                engine.playing = true;
                engine.status = 'playing';
                engine.baseNow = performance.now();
                emitState();
                emitClock();
                if (engine.basePosition >= engine.durationSec - 1e-6) reachEnd();
                if (engine.playing) startClock();
                return done();
            }),
            pause: (attempt) => run('engine.pause', () => {
                const gate = requireEngine(attempt);
                if (gate) return gate;
                engine.basePosition = clamp(positionSec(), 0, engine.durationSec);
                engine.baseNow = performance.now();
                engine.playing = false;
                engine.status = 'paused';
                stopClock();
                emitState();
                emitClock();
                return done();
            }),
            stop: (attempt) => run('engine.stop', () => {
                const gate = requireEngine(attempt);
                if (gate) return gate;
                engine.basePosition = 0;
                engine.baseNow = performance.now();
                engine.playing = false;
                engine.status = 'paused';
                stopClock();
                reverbRangeKey = null;
                emitState();
                emitClock();
                return done();
            }),
            seek: (attempt, sec) => run('engine.seek', () => {
                const gate = requireEngine(attempt);
                if (gate) return gate;
                if (typeof sec !== 'number' || !Number.isFinite(sec)) return fail('INVALID_REQUEST');
                const position = clamp(sec, 0, engine.durationSec);
                engine.basePosition = position;
                engine.baseNow = performance.now();
                reverbRangeKey = null;
                emitClock();
                updateSmartReverb(position);
                if (engine.playing && position >= engine.durationSec - 1e-6) reachEnd();
                return ok({ positionSec: position });
            }),
            setMix: (attempt, mix) => run('engine.setMix', () => {
                const gate = requireEngine(attempt);
                if (gate) return gate;
                if (!isWorkMix(mix)) return fail('INVALID_REQUEST');
                engine.mix = cloneMix(mix);
                return done();
            }),
            setKaraoke: (onKaraoke) => run('engine.setKaraoke', () => {
                if (typeof onKaraoke !== 'boolean') return fail('INVALID_REQUEST');
                engine.karaoke = onKaraoke;
                if (engine.loaded) emitState();
                emitStatus();
                return done();
            }),
            setHarmony: (onHarmony) => run('engine.setHarmony', () => {
                if (typeof onHarmony !== 'boolean') return fail('INVALID_REQUEST');
                const changedHarmony = engine.harmony !== onHarmony;
                engine.harmony = onHarmony;
                if (changedHarmony && engine.loaded) emitState();
                return done();
            }),
            setMaster: (volume, muted) => run('engine.setMaster', () => {
                if (!inRange(volume, 0, 1) || typeof muted !== 'boolean') return fail('INVALID_REQUEST');
                engine.master = { volume, muted };
                return done();
            }),
            setLoopOne: (onLoop) => run('engine.setLoopOne', () => {
                if (typeof onLoop !== 'boolean') return fail('INVALID_REQUEST');
                engine.loopOne = onLoop;
                if (engine.loaded) emitState();
                return done();
            }),
            listDevices: () => run('engine.listDevices', () => ok(MOCK_DEVICES.map(device => ({ ...device })))),
            setOutputDevice: (id) => run('engine.setOutputDevice', () => {
                if (id !== null && typeof id !== 'string') return fail('INVALID_REQUEST');
                if (id === 'dev-missing') return fail('DEVICE_UNAVAILABLE');
                const changedId = engine.outputDeviceId !== id;
                engine.outputDeviceId = id;
                if (changedId && engine.loaded) {
                    emitState();
                    emitDevices();
                }
                return done();
            }),
            getSnapshot: () => run('engine.getSnapshot', () => {
                if (!engine.loaded) return ok(null);
                return ok({
                    state: snapshotState(),
                    clock: {
                        attempt: engine.attempt,
                        positionSec: engine.playing ? positionSec() : engine.basePosition,
                        playing: engine.playing,
                        seq: engine.seq,
                    },
                });
            }),
            onState: (cb) => on<EngineState>('engine.state', cb),
            onClock: (cb) => on<EngineClock>('engine.clock', cb),
            onEnded: (cb) => on<EngineEnded>('engine.ended', cb),
            onLooped: (cb) => on<EngineLooped>('engine.looped', cb),
            onError: (cb) => on<EngineErrorEvent>('engine.error', cb),
            onDevices: (cb) => on<OutputDevicesEvent>('engine.devices', cb),
        },
        live: {
            getStatus: () => run('live.getStatus', () => engineDown ? fail('ENGINE_NOT_RUNNING') : ok(buildStatus())),
            setMode: (mode, source) => run('live.setMode', () => {
                if (!LIVE_MODES.includes(mode) || !LIVE_SOURCES.includes(source)) return fail('INVALID_REQUEST');
                const from = userMode;
                userMode = mode;
                effectiveMode = mode;
                smartReverbActive = false;
                switching = true;
                reverbRangeKey = null;
                emitStatus();
                const leavingAi = (from === 'ai-follow' || from === 'ai-sing') && from !== mode;
                const gap = leavingAi ? leaveAiGapMs : 0;
                const token = ++modeToken;
                later(20 + gap + 20, () => {
                    if (token !== modeToken) return;
                    switching = false;
                    effectiveMode = userMode;
                    emitStatus();
                    updateSmartReverb(engine.playing ? positionSec() : engine.basePosition);
                });
                return ok(buildStatus());
            }),
            setFollowConfig: (config) => run('live.setFollowConfig', () => {
                if (!isFollow(config)) return fail('INVALID_REQUEST');
                follow = { ...config };
                return done();
            }),
            setSmartReverb: (config) => run('live.setSmartReverb', () => {
                if (!isSmartReverb(config)) return fail('INVALID_REQUEST');
                smart = { ...config };
                return done();
            }),
            setPluginGains: (next) => run('live.setPluginGains', () => {
                if (!isGains(next)) return fail('INVALID_REQUEST');
                gains = { ...next };
                return done();
            }),
            setLeaveAiGap: (ms) => run('live.setLeaveAiGap', () => {
                if (!inRange(ms, 0, 1000)) return fail('INVALID_REQUEST');
                leaveAiGapMs = ms;
                return done();
            }),
            setLevelsSubscribed: (subscribed) => run('live.setLevelsSubscribed', () => {
                if (typeof subscribed !== 'boolean') return fail('INVALID_REQUEST');
                levelsWanted = subscribed;
                if (subscribed) startLevels();
                else stopLevels();
                return done();
            }),
            getPluginInfo: () => run('live.getPluginInfo', () => ok({
                bundledVersion: '1.0.0',
                installedVersion: connection === 'connected' ? '1.0.0' : null,
                installDir: PLUGIN_INSTALL_DIR,
            })),
            openPluginFolder: () => run('live.openPluginFolder', () => done()),
            onStatus: (cb) => on<LiveStatus>('live.status', cb),
            onLevels: (cb) => on('live.levels', cb),
        },
        cover: {
            getComponent: () => run('cover.getComponent', () => ok(buildComponent())),
            pickInstallDir: () => run('cover.pickInstallDir', () => ok({ dir: PICKED_INSTALL_DIR, freeBytes: 50_000_000_000 })),
            installComponent: () => run('cover.installComponent', () => fail('DOWNLOAD_UNAVAILABLE')),
            locateComponent: (dir) => new Promise(resolve => {
                later(latencyMs, () => {
                    const armed = failNext.get('cover.locateComponent');
                    if (armed !== undefined) {
                        failNext.delete('cover.locateComponent');
                        resolve({ ok: false, code: armed as CoverErrorCode });
                        return;
                    }
                    if (typeof dir !== 'string' || dir.length === 0) {
                        resolve(fail('INVALID_REQUEST'));
                        return;
                    }
                    if (dir.startsWith('X:')) {
                        resolve(fail('COMPONENT_MISSING'));
                        return;
                    }
                    if (!dir.startsWith('D:\\okchang-test')) {
                        resolve(fail('CHECKSUM_MISMATCH'));
                        return;
                    }
                    if (locateSettle) finishLocate(ok(buildComponent()));
                    locateSettle = resolve;
                    beginVerify(dir);
                });
            }),
            cancelInstall: () => run('cover.cancelInstall', () => {
                if (!verifying) return done();
                installToken += 1;
                emit('cover.install', {
                    phase: 'cancelled', receivedBytes: 0, totalBytes: 0, errorCode: null, partId: null,
                });
                finishLocate(ok(buildComponent()));
                return done();
            }),
            removeComponent: (opts) => run('cover.removeComponent', () => {
                if (verifying) {
                    installToken += 1;
                    finishLocate(ok(buildComponent()));
                }
                const ids = opts?.parts;
                if (ids !== undefined) {
                    if (!Array.isArray(ids) || ids.some(id => !PART_ORDER.includes(id))) return fail('INVALID_REQUEST');
                    for (const id of ids) partInstalled[id] = false;
                } else {
                    for (const id of PART_ORDER) partInstalled[id] = false;
                }
                if (!requiredReady()) installRoot = null;
                return done();
            }),
            listModels: () => run('cover.listModels', () => ok(models.map(model => ({ ...model })))),
            addModel: () => run('cover.addModel', () => {
                extraModels += 1;
                const model: RvcModel = {
                    id: `m-extra-${extraModels}`,
                    name: `示例音色 ${extraModels + 1}`,
                    hasIndex: true,
                    addedAt: 1793808000000 + extraModels,
                };
                models.push(model);
                return ok({ ...model });
            }),
            removeModel: (modelId) => run('cover.removeModel', () => {
                const index = models.findIndex(model => model.id === modelId);
                if (index < 0) return fail('MODEL_NOT_FOUND');
                models.splice(index, 1);
                return done();
            }),
            submit: (req) => run('cover.submit', () => {
                if (!isSubmitRequest(req)) return fail('INVALID_REQUEST');
                const status = buildComponent();
                if (status.state !== 'installed') return fail('COMPONENT_MISSING');
                if (!models.some(model => model.id === req.modelId)) return fail('MODEL_INVALID');
                if (isEncryptedSource(req.source.fileName)) return fail('SOURCE_ENCRYPTED');
                if (!isCoverMode(req.mode) || !isCoverSeparator(req.separator)) return fail('INVALID_REQUEST');
                const mode = req.mode ?? status.defaultMode;
                const separator = req.separator ?? 'builtin';
                const chosen = status.modes.find(item => item.mode === mode && item.separator === separator);
                if (!chosen?.available) return fail('MODE_UNAVAILABLE');
                jobSeq += 1;
                const job: MockJob = {
                    id: `job-${jobSeq}`,
                    title: req.title,
                    artist: req.artist,
                    lyrics: req.lyrics,
                    phase: 'queued',
                    progress: 0,
                    finished: false,
                    started: false,
                    settled: false,
                    token: 1,
                    mode,
                    separator,
                    reachedSeparating: false,
                    latest: {
                        jobId: `job-${jobSeq}`,
                        phase: 'queued',
                        progress: 0,
                        indeterminate: false,
                        title: req.title,
                    },
                };
                jobs.push(job);
                queue.push(job);
                jobEvent(job, { phase: 'queued', progress: 0, indeterminate: false });
                pump();
                return ok({ jobId: job.id });
            }),
            cancel: (jobId) => run('cover.cancel', () => {
                const job = jobs.find(item => item.id === jobId);
                if (!job) return fail('JOB_NOT_FOUND');
                if (!job.finished) {
                    job.finished = true;
                    job.token += 1;
                    jobEvent(job, { phase: 'cancelled', progress: job.progress, indeterminate: false });
                    settle(job);
                }
                return done();
            }),
            listJobs: () => run('cover.listJobs', () => ok(jobs.map(job => ({ ...job.latest })))),
            onInstallProgress: (cb) => on<CoverInstallProgress>('cover.install', cb),
            onJob: (cb) => on<CoverJobEvent>('cover.job', cb),
        },
    };

    function attach(next: OkMockHandle): () => void {
        // 单测在 node 里没有 window。不把空对象断言成 DOM 的 Window，只挂契约要用的两个字段。
        type Host = { electron?: { ok?: OkBridge }; __okMock?: OkMockHandle };
        const g = globalThis as unknown as { window?: Host };
        const createdWindow = g.window === undefined;
        if (g.window === undefined) g.window = {};
        const host = g.window;
        const createdElectron = host.electron === undefined;
        if (host.electron === undefined) host.electron = {};
        host.electron.ok = bridge;
        host.__okMock = next;
        return () => {
            if (host.electron) delete host.electron.ok;
            if (createdElectron) delete host.electron;
            if (host.__okMock === next) delete host.__okMock;
            if (createdWindow) delete g.window;
        };
    }

    let detach = (): void => {};
    const handle: OkMockHandle = {
        bridge,
        uninstall: () => {
            if (!alive) return;
            alive = false;
            for (const id of timeouts) clearTimeout(id);
            timeouts.clear();
            for (const id of intervals) clearInterval(id);
            intervals.clear();
            clockTimer = null;
            levelTimer = null;
            detach();
            console.info('[okMock] uninstalled');
        },
        failNext: (command, code) => {
            failNext.set(command, code);
        },
        disconnectPlugin: () => setConnection('absent', false),
        reconnectPlugin: () => setConnection('connected', true),
        setPluginAbiMismatch: () => setConnection('abi-mismatch', false),
        setPluginDuplicate: () => setConnection('duplicate', false),
        crashEngine: () => {
            const now = performance.now();
            while (crashTimes.length > 0 && now - crashTimes[0] > 60_000) crashTimes.shift();
            crashTimes.push(now);
            if (crashTimes.length >= 3) circuitOpen = true;
            engineDown = true;
            engine.playing = false;
            stopClock();
            engine.status = 'error';
            const error: EngineErrorEvent = {
                attempt: engine.loaded ? engine.attempt : null,
                code: 'ENGINE_CRASHED',
                fatal: true,
            };
            emit('engine.error', error);
            emitState();
            const token = ++crashToken;
            later(1000, () => {
                if (token !== crashToken) return;
                engineDown = false;
                engine.loaded = false;
                engine.workId = null;
                engine.status = 'idle';
                engine.playing = false;
                engine.basePosition = 0;
                emitState();
            });
        },
        breakWork: (workId) => {
            breakIds.add(workId);
        },
        failCoverJob: (code, atPhase = 'converting') => {
            if (active && !active.finished && active.phase === atPhase) {
                failJob(active, code);
                return;
            }
            failArm = { code, atPhase };
        },
        setClockRate: (rate) => {
            if (!Number.isFinite(rate) || rate <= 0) return;
            if (engine.loaded) {
                engine.basePosition = clamp(positionSec(), 0, engine.durationSec || Number.POSITIVE_INFINITY);
                engine.baseNow = performance.now();
            }
            clockRate = rate;
        },
    };

    detach = attach(handle);
    console.info('[okMock] installed');
    return handle;
}

function cloneRoot<T extends { id: string }>(root: T): T {
    return { ...root };
}
