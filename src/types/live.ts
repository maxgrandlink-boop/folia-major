// src/types/live.ts —— W1 契约 v1.0
import type { CommonErrorCode, OutputRoute } from './multitrack';

export type LiveMode = 'speech' | 'reverb-speech' | 'ai-follow' | 'ai-sing';
export type LiveModeSource = 'ui' | 'hotkey' | 'restore';
export type VocalControl = 'threshold' | 'monitor';

export interface FollowConfig {
    control: VocalControl;    // 默认 monitor（豆苞 ui/pages/settings_page.py:326, 2545, 2609）
    thresholdDb: number;      // −80–0，默认 −40（MW:3470-3489）
    fadeInSec: number;        // 0–2，默认 0
    fadeOutSec: number;       // 0.1–2，默认 0.1
    vocalCap: number;         // 0–1，默认 0.8，AI 人声上限（人声滑杆）
}

export interface SmartReverbConfig {
    enabled: boolean;         // 默认 false（MW:1619）
    silenceSec: number;       // 0.1–5，默认 1.0
    earlyReturnSec: number;   // 0.1–5，默认 0.3
    returnMode: 'ai-follow' | 'ai-sing';   // 默认 ai-follow（MW:1622）
}

/** 插件四轨音量，单位 dB，−60–+12，默认 0。键与豆苞一致（plugin_track_volume.py:6-23；shared_memory_manager.py:194-204, 1244-1295）：
 *  normal_speech 普通说话（麦克风原声）、reverb_speech 混响说话（麦克风混响）、ai_voice AI 人声、ai_accompaniment AI 伴奏。
 *  界面用百分比时按豆苞换算：pct = (dB + 60) / 72 × 100，0 dB ≈ 83%。 */
export const PLUGIN_TRACK_VOLUME_DB_MIN = -60;
export const PLUGIN_TRACK_VOLUME_DB_MAX = 12;
export interface PluginGains { normalSpeechDb: number; reverbSpeechDb: number; aiVoiceDb: number; aiAccompDb: number }

export interface LiveSettings {     // 渲染端 useLiveSettingsStore 持久化，localStorage 键 ok_live_settings
    mode: LiveMode;                 // 首次启动 speech（MW:1625）；退出时记、启动恢复（MW:8091-8118）
    follow: FollowConfig;
    smartReverb: SmartReverbConfig;
    gains: PluginGains;
    leaveAiGapMs: number;           // 0–1000，默认 280（D10 已定，MW:7948）
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
    mode: 'speech',
    follow: { control: 'monitor', thresholdDb: -40, fadeInSec: 0, fadeOutSec: 0.1, vocalCap: 0.8 },
    smartReverb: { enabled: false, silenceSec: 1.0, earlyReturnSec: 0.3, returnMode: 'ai-follow' },
    gains: { normalSpeechDb: 0, reverbSpeechDb: 0, aiVoiceDb: 0, aiAccompDb: 0 },
    leaveAiGapMs: 280,
};

export type PluginConnection = 'absent' | 'connected' | 'abi-mismatch' | 'duplicate';

export interface LiveStatus {
    connection: PluginConnection;
    route: OutputRoute;             // connected → live，否则 local（D6 已定）
    userMode: LiveMode;
    effectiveMode: LiveMode;        // 智能混响临时套用时与 userMode 不同
    switching: boolean;
    smartReverbActive: boolean;
    karaoke: boolean;
    hostSampleRate: number | null;
    latencyMs: number | null;
    underruns: number;
    pluginBuild: number | null;
}

export interface LiveLevels { micDb: number; aiGate: number }   // 15 Hz，订阅时才推
export interface PluginInfo { bundledVersion: string; installedVersion: string | null; installDir: string | null }

export type LiveErrorCode = CommonErrorCode | 'ENGINE_NOT_RUNNING';

// ---------------- 直播热键 ----------------
/** Folia 命令面板里的 5 个直播命令，和豆苞热键动作一一对应（豆苞键名见 MW:14140-14141、MW:14350-14356）。 */
export const LIVE_COMMAND_IDS = [
    'live-mode-ai-follow', 'live-mode-ai-sing', 'live-mode-speech', 'live-mode-reverb-speech', 'live-karaoke-toggle',
] as const;
export type LiveCommandId = typeof LIVE_COMMAND_IDS[number];
export const DOUBAO_HOTKEY_ACTION: Record<LiveCommandId, string> = {
    'live-mode-ai-follow': 'ai_follow',
    'live-mode-ai-sing': 'ai_sing',
    'live-mode-speech': 'normal_speech',
    'live-mode-reverb-speech': 'reverb_speech',
    'live-karaoke-toggle': 'karaoke_mode',
};
/**
 * 默认键位照豆苞：F1 AI跟唱、F2 AI唱歌、F3 普通说话、F4 混响说话、F5 清唱（ui/pages/settings_page.py:275-281；ui/settings_page.py:36-42 相同）。
 * 豆苞另有总开关 enabled，默认开（ui/pages/settings_page.py:1910），存 hotkeys.json。设置页“恢复默认”回到这组。
 */
export const DEFAULT_LIVE_HOTKEYS: Record<LiveCommandId, string | null> = {   // Electron accelerator 写法；null = 未绑
    'live-mode-ai-follow': 'F1', 'live-mode-ai-sing': 'F2', 'live-mode-speech': 'F3',
    'live-mode-reverb-speech': 'F4', 'live-karaoke-toggle': 'F5',
};
export const DEFAULT_LIVE_HOTKEYS_ENABLED = true;
/** 同一命令 300 ms 内只认一次：豆苞管理器 280 ms（global_hotkey_manager.py:169, 344），主窗口同键 300 ms（MW:14343），取大者。 */
export const LIVE_HOTKEY_DEBOUNCE_MS = 300;
// 允许的组合（D9 已定）：直播命令额外放行 F1–F24 单键、单个修饰键 + 数字；豆苞允许无修饰的单键（global_hotkey_manager.py:81-117 的
// _parse_key_name 修饰位可以为 0，:496 “全局单键快捷键”），v1 不放开字母单键，避免打字时误触。
