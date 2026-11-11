import { create } from 'zustand';
import { DEFAULT_HARMONY_ENABLED } from '../types/multitrack';
import {
    DEFAULT_LIVE_SETTINGS,
    PLUGIN_TRACK_VOLUME_DB_MAX,
    PLUGIN_TRACK_VOLUME_DB_MIN,
    type FollowConfig,
    type LiveMode,
    type LiveSettings,
    type PluginGains,
    type SmartReverbConfig,
    type VocalControl,
} from '../types/live';

// src/stores/useLiveSettingsStore.ts
// 直播设置，外加分轨面板上的清唱和和声。和声不是 LiveSettings 的字段，跟清唱一起放在同一个键里，
// 避免再开一个存储键。功能性设置，不进外观导入导出。

const OK_LIVE_SETTINGS_KEY = 'ok_live_settings';

export interface OkLivePersisted extends LiveSettings {
    harmony: boolean;
    karaoke: boolean;
}

const FALLBACK: OkLivePersisted = {
    ...DEFAULT_LIVE_SETTINGS,
    follow: { ...DEFAULT_LIVE_SETTINGS.follow },
    smartReverb: { ...DEFAULT_LIVE_SETTINGS.smartReverb },
    gains: { ...DEFAULT_LIVE_SETTINGS.gains },
    harmony: DEFAULT_HARMONY_ENABLED,
    karaoke: false,
};

function clone(value: OkLivePersisted): OkLivePersisted {
    return {
        ...value,
        follow: { ...value.follow },
        smartReverb: { ...value.smartReverb },
        gains: { ...value.gains },
    };
}

function inRange(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function readFollow(value: unknown): FollowConfig | null {
    if (!value || typeof value !== 'object') return null;
    const follow = value as FollowConfig;
    const control: VocalControl | null = follow.control === 'threshold' || follow.control === 'monitor' ? follow.control : null;
    if (!control || !inRange(follow.thresholdDb, -80, 0) || !inRange(follow.fadeInSec, 0, 2) || !inRange(follow.fadeOutSec, 0.1, 2) || !inRange(follow.vocalCap, 0, 1)) {
        return null;
    }
    return { control, thresholdDb: follow.thresholdDb, fadeInSec: follow.fadeInSec, fadeOutSec: follow.fadeOutSec, vocalCap: follow.vocalCap };
}

function readReverb(value: unknown): SmartReverbConfig | null {
    if (!value || typeof value !== 'object') return null;
    const reverb = value as SmartReverbConfig;
    const returnMode = reverb.returnMode === 'ai-follow' || reverb.returnMode === 'ai-sing' ? reverb.returnMode : null;
    if (typeof reverb.enabled !== 'boolean' || !returnMode || !inRange(reverb.silenceSec, 0.1, 5) || !inRange(reverb.earlyReturnSec, 0.1, 5)) {
        return null;
    }
    return { enabled: reverb.enabled, silenceSec: reverb.silenceSec, earlyReturnSec: reverb.earlyReturnSec, returnMode };
}

function readGains(value: unknown): PluginGains | null {
    if (!value || typeof value !== 'object') return null;
    const gains = value as PluginGains;
    if (!inRange(gains.normalSpeechDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)
        || !inRange(gains.reverbSpeechDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)
        || !inRange(gains.aiVoiceDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)
        || !inRange(gains.aiAccompDb, PLUGIN_TRACK_VOLUME_DB_MIN, PLUGIN_TRACK_VOLUME_DB_MAX)) {
        return null;
    }
    return { ...gains };
}

const MODES: readonly LiveMode[] = ['speech', 'reverb-speech', 'ai-follow', 'ai-sing'];

function readPersisted(): OkLivePersisted {
    if (typeof localStorage === 'undefined') return clone(FALLBACK);
    try {
        const raw = localStorage.getItem(OK_LIVE_SETTINGS_KEY);
        if (!raw) return clone(FALLBACK);
        const parsed = JSON.parse(raw) as Partial<OkLivePersisted>;
        const mode = MODES.includes(parsed.mode as LiveMode) ? parsed.mode as LiveMode : FALLBACK.mode;
        const follow = readFollow(parsed.follow) ?? { ...FALLBACK.follow };
        const smartReverb = readReverb(parsed.smartReverb) ?? { ...FALLBACK.smartReverb };
        const gains = readGains(parsed.gains) ?? { ...FALLBACK.gains };
        const leaveAiGapMs = inRange(parsed.leaveAiGapMs, 0, 1000) ? parsed.leaveAiGapMs : FALLBACK.leaveAiGapMs;
        return {
            mode,
            follow,
            smartReverb,
            gains,
            leaveAiGapMs,
            harmony: typeof parsed.harmony === 'boolean' ? parsed.harmony : FALLBACK.harmony,
            karaoke: typeof parsed.karaoke === 'boolean' ? parsed.karaoke : FALLBACK.karaoke,
        };
    } catch (error) {
        console.warn('[ok] live settings unreadable, using defaults', error);
        return clone(FALLBACK);
    }
}

function writePersisted(value: OkLivePersisted): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(OK_LIVE_SETTINGS_KEY, JSON.stringify(value));
}

export interface LiveSettingsState extends OkLivePersisted {
    setMode: (mode: LiveMode) => void;
    setFollow: (follow: FollowConfig) => void;
    setSmartReverb: (smartReverb: SmartReverbConfig) => void;
    setGains: (gains: PluginGains) => void;
    setLeaveAiGapMs: (leaveAiGapMs: number) => void;
    setHarmony: (harmony: boolean) => void;
    setKaraoke: (karaoke: boolean) => void;
    reset: () => void;
}

function dataOf(state: OkLivePersisted): OkLivePersisted {
    return {
        mode: state.mode,
        follow: state.follow,
        smartReverb: state.smartReverb,
        gains: state.gains,
        leaveAiGapMs: state.leaveAiGapMs,
        harmony: state.harmony,
        karaoke: state.karaoke,
    };
}

function commit(next: OkLivePersisted): OkLivePersisted {
    const stored = clone(next);
    writePersisted(stored);
    return stored;
}

export const useLiveSettingsStore = create<LiveSettingsState>((set) => ({
    ...readPersisted(),
    setMode: (mode) => set(state => commit({ ...dataOf(state), mode })),
    setFollow: (follow) => set(state => commit({ ...dataOf(state), follow })),
    setSmartReverb: (smartReverb) => set(state => commit({ ...dataOf(state), smartReverb })),
    setGains: (gains) => set(state => commit({ ...dataOf(state), gains })),
    setLeaveAiGapMs: (leaveAiGapMs) => set(state => commit({ ...dataOf(state), leaveAiGapMs })),
    setHarmony: (harmony) => set(state => commit({ ...dataOf(state), harmony })),
    setKaraoke: (karaoke) => set(state => commit({ ...dataOf(state), karaoke })),
    reset: () => set(commit(clone(FALLBACK))),
}));

/** 起播时带上的主音量。调用方传入 0–1。 */
export function clampMasterVolume(volume: number): number {
    if (!Number.isFinite(volume)) return 1;
    return Math.min(1, Math.max(0, volume));
}
