// src/types/multitrack.ts —— W1 契约 v1.0。主进程（electron/works、electron/okEngine）与渲染端共用。
export const OK_CONTRACT_VERSION = '1.0';

/** 所有 ok-* 命令的返回。命令从不 reject；detail 只进日志，界面文案按 code 取 i18n 键 ok.errors.<code>。 */
export type Result<T, C extends string> =
    | { ok: true; value: T }
    | { ok: false; code: C; detail?: string };

export type CommonErrorCode = 'IPC_TIMEOUT' | 'INVALID_REQUEST' | 'UNKNOWN';

// ---------------- 作品 ----------------
export type TrackRole = 'vocal' | 'instrumental' | 'original' | 'harmony';
export const TRACK_ROLES: readonly TrackRole[] = ['vocal', 'instrumental', 'original', 'harmony'];

export type WorksRootKind =
    | 'doubao-data'       // 选中的目录下有 豆苞数据/ 或 哆哆AI数据/
    | 'collection-root'   // 选中的就是 豆苞数据/ 或 哆哆AI数据/
    | 'works-dir';        // 直属子文件夹各是一首（ok唱歌 翻唱输出根也是这种）

export interface WorksRoot {
    id: string;
    displayPath: string;     // 只给界面显示；渲染端从不把路径交回主进程
    kind: WorksRootKind;
    addedAt: number;         // epoch ms
    available: boolean;      // 目录当前能否读取
    isCoverOutput: boolean;  // 是否为 AI 翻唱输出根（自动登记，不能移除）
}

/** 角色是从哪里认出来的。顺序照豆苞 audio_loader.scan_collection_tracks（audio_loader.py:1018-1145）：
 *  manifest.json 的 tracks > cs.json 的 files > 文件名关键字 > 旧版固定命名。 */
export type WorkTrackSource = 'manifest' | 'cs-json' | 'name-rule' | 'legacy-name';

export interface WorkTrack {
    role: TrackRole;
    source: WorkTrackSource;
    fileName: string;          // 作品文件夹内的文件名。manifest 依次试 source_path、std_path、file；绝对路径须在本文件夹内，否则取文件名在本文件夹找（audio_loader.py:810-840, 921-933）
    sizeBytes: number;
    mtimeMs: number;
    durationSec: number | null;   // WAV 读头得到；其他格式 null，载入后见 EngineLoaded
}

export type WorkLyricsFormat = 'lrc' | 'krc' | 'vtt' | 'ttml' | 'yrc' | 'qrc';
export interface WorkLyrics { fileName: string; format: WorkLyricsFormat; content: string }

/** manifest.json 里能直接用的元数据（样本：song_id、created_at、sample_rate 44100、channels 2）。没有 manifest 时为 null。 */
export interface WorkManifestMeta { songId: string | null; createdAt: string | null; sampleRate: number | null; channels: number | null }

export type WorkParseWarning =
    | 'duplicate-role' | 'lyrics-unreadable' | 'volume-json-invalid'
    | 'manifest-invalid' | 'cs-json-invalid' | 'manifest-file-missing'    // manifest 指向的文件在文件夹里不存在
    | 'track-name-mismatch'      // 轨文件名不含歌名 token，按豆苞做法忽略该轨（audio_loader.py:950-975）
    | 'legacy-ready';            // 没有 .complete/.cover_done，但有 manifest.json 和音频，按豆苞旧版规则收录（audio_loader.py:787-807）

export interface Work {
    id: string;              // hash(rootId + relPath)，稳定
    rootId: string;
    relPath: string;         // 相对根目录
    baseName: string;        // 文件夹名
    title: string;
    artist: string | null;
    tracks: WorkTrack[];     // 至少有 vocal 或 instrumental
    lyrics: WorkLyrics | null;
    hasCover: boolean;       // 文件夹内 cover.jpg 等
    completedAtMs: number;   // .cover_done 的修改时间（旧版作品用 manifest.json 的），曲库按它倒序（文件内容 "at: <ISO 时间>" 不带时区，不用）
    signature: string;       // 相关文件 name:size:mtime 的 hash
    meta: WorkManifestMeta | null;
    warnings: WorkParseWarning[];
}

export type WorkSkipReason = 'hidden' | 'processing' | 'not-complete' | 'no-tracks' | 'unreadable';
export interface WorkSkip { relPath: string; reason: WorkSkipReason }

export interface TrackMix { gain: number; muted: boolean }   // gain 0–100 整数，与 _volume.json 同刻度
/** 和声没有独立音量：豆苞把和声并进伴奏，同一路送插件伴奏或本机（audio_manager.py:3754-3786），开关是全局设置。 */
export type MixRole = 'vocal' | 'instrumental' | 'original';
export type WorkMix = Record<MixRole, TrackMix>;
export interface WorkSettings { mix: WorkMix; lyricsOffsetMs: number }

export const DEFAULT_WORK_MIX: WorkMix = {
    vocal:        { gain: 80, muted: false },
    instrumental: { gain: 80, muted: false },
    original:     { gain: 0,  muted: false },
};
/** 和声开关，全局，默认关（豆苞 playback_settings.py:12 harmony_enabled=False）。开时和声并入伴奏。 */
export const DEFAULT_HARMONY_ENABLED = false;

export interface RescanSummary { added: number; updated: number; removed: number; skipped: WorkSkip[] }
export interface WorksChangedEvent { rootId: string; added: Work[]; updated: Work[]; removedIds: string[] }

export type WorksErrorCode =
    | CommonErrorCode
    | 'DIALOG_CANCELLED' | 'ROOT_UNREADABLE' | 'ROOT_DUPLICATE' | 'ROOT_NOT_FOUND' | 'ROOT_PROTECTED'
    | 'WORK_NOT_FOUND' | 'WRITE_FAILED';

/** src/types.ts 的 LocalSong 只加一个可选字段：work?: LocalSongWorkRef。没有它的记录行为与今天一样。 */
export interface LocalSongWorkRef { workId: string; rootId: string; signature: string }

// ---------------- 引擎 ----------------
export type EngineErrorCode =
    | CommonErrorCode
    | 'ENGINE_NOT_FOUND' | 'ENGINE_SPAWN_FAILED' | 'ENGINE_CRASHED' | 'CIRCUIT_OPEN'
    | 'NOT_LOADED' | 'SUPERSEDED'
    | 'WORK_NOT_FOUND' | 'TRACK_UNREADABLE' | 'FORMAT_UNSUPPORTED' | 'TRANSCODE_FAILED'
    | 'DEVICE_UNAVAILABLE';

export interface EngineLoadRequest {
    attempt: number;          // 渲染端每次起播 +1；旧 attempt 的回复和事件一律丢弃
    workId: string;           // 只给 id，路径由主进程解析
    mix: WorkMix;
    karaoke: boolean;         // 清唱：静音伴奏（和声随伴奏一起静音）
    harmony: boolean;         // 和声并入伴奏
    master: { volume: number; muted: boolean };   // 应用主音量 0–1
    startSec: number;
    autoplay: boolean;
    loopOne: boolean;
}

export interface EngineTrackInfo { role: TrackRole; durationSec: number; padded: boolean; trimmed: boolean; transcoded: boolean }

export interface EngineLoaded {
    attempt: number;
    workId: string;
    durationSec: number;      // 时间轴轨的长度：伴奏 > 原声 > 人声（豆苞 audio_manager.py:1926-1936）；其余轨短的尾部补静音、长的裁尾，不在前面补
    sampleRate: number;       // 参考轨（人声，没有则伴奏）的采样率
    tracks: EngineTrackInfo[];
}

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
export type OutputRoute = 'local' | 'live';   // live：人声和伴奏进插件，原唱留本机

export interface EngineState {
    attempt: number;
    workId: string | null;
    status: EngineStatus;
    durationSec: number;
    route: OutputRoute;
    outputDeviceId: string | null;   // null = 跟随系统默认
    karaoke: boolean;
    harmony: boolean;
    loopOne: boolean;
}

export interface EngineClock {
    attempt: number;
    positionSec: number;      // 已被听到的位置 = 主时钟帧 − 输出延迟
    playing: boolean;
    seq: number;              // 单调递增；渲染端收到时按 performance.now() 外推
}

export interface EngineEnded { attempt: number }
export interface EngineLooped { attempt: number }
export interface EngineErrorEvent { attempt: number | null; code: EngineErrorCode; fatal: boolean }

export interface OutputDevice { id: string; name: string; isDefault: boolean }
export interface OutputDevicesEvent { devices: OutputDevice[]; defaultId: string | null }
export interface EngineSnapshot { state: EngineState; clock: EngineClock }
