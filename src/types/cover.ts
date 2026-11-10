// src/types/cover.ts —— W1 契约 v1.0
import type { CommonErrorCode, WorkLyricsFormat, TrackRole } from './multitrack';

export type CoverErrorCode =
    | CommonErrorCode
    | 'GPU_UNSUPPORTED' | 'COMPONENT_MISSING' | 'COMPONENT_CORRUPT'
    | 'DOWNLOAD_FAILED' | 'CHECKSUM_MISMATCH' | 'DISK_FULL' | 'INSTALL_CANCELLED'
    | 'DIALOG_CANCELLED' | 'MODEL_INVALID' | 'MODEL_NOT_FOUND'
    | 'SOURCE_UNREADABLE' | 'OUTPUT_ROOT_MISSING'
    | 'JOB_NOT_FOUND' | 'JOB_FAILED' | 'JOB_CANCELLED'
    | 'CUDA_OOM'                 // 后端报 "CUDA out of memory" / "cudaMalloc" / "CUDA error"（豆苞 _is_cuda_runtime_error，L2675）
    | 'SOURCE_ENCRYPTED'         // v3.5：QQ 音乐、网易云等加密格式（扩展名或文件头命中，见设计稿 4.1「不做」），不解密、不转换（Max 已定）
    | 'MODEL_UNSAFE'             // v3.5：模型用 torch.load(weights_only=True) 读不出，即含任意 Python 对象；拒绝导入（设计稿 4.7 先修 #7）
    | 'DOWNLOAD_UNAVAILABLE'     // v3.5：v1 不做下载托管（Max 已定），installComponent 一律回这个码；装组件走 locateComponent
    | 'MODE_UNAVAILABLE';        // v3.5：所选档位或分离流程缺包，或 v1 不开放；原因见 CoverComponentStatus.modes

/**
 * v3.5：组件按层分 5 个包（设计稿 4.5；SM v3 §5.2）。字节数一律是整数字节；界面按 1024³ 换算，显示单位写 GB（同 Windows 资源管理器）。
 *   torch-cuda      torch 2.7.1+cu128、torchaudio 2.7.1、torchvision 0.22.1                       必装
 *   runtime         Python 3.10.13 与其余依赖、python-backend 代码、ffmpeg、msst-native 代码与预设、okcover   必装
 *   base-models     内置 Kim 分离模型、hubert_base、rmvpe：library 档                             必装
 *   enhance-models  去混响（anvuew）、karaoke（aufr33-viperx）：normal、aggressive 档              可选，默认装
 *   msst-native     big_beta5e、5_HP-Karaoke-UVR、VR 配置、msst-native 自带 ffmpeg：msst-native 分离流程   可选，v1 标「实验」
 * 用户私有模型一律不进任何包（设计稿 4.1「不做」）。
 */
export type CoverPartId = 'torch-cuda' | 'runtime' | 'base-models' | 'enhance-models' | 'msst-native';
export interface CoverPartStatus {
    id: CoverPartId;
    required: boolean;           // torch-cuda、runtime、base-models 为 true
    state: 'absent' | 'installing' | 'installed' | 'corrupt';
    downloadBytes: number;       // v1 没有下载，等于 installedBytes（包是不压缩的归档）
    installedBytes: number;
}

/** v3.5：档位 = 后端 msst_method（python-backend/process_pipeline.py:767-777）；分离流程 = 内置 Kim 或 msst-native（:355-377）。 */
export type CoverMode = 'library' | 'normal' | 'aggressive';
export type CoverSeparator = 'builtin' | 'msst-native';
/** 翻唱作品里会有的轨。没有 harmony：后端的「和声」是混响成分，不入库（设计稿 4.7 先修 #5）。 */
export type CoverOutputRole = Exclude<TrackRole, 'harmony'>;
/**
 * 每档入库后的轨（设计稿 4.6 档位表）。两种分离流程入库结果相同：
 *   library     人声（RVC）、伴奏、原声（未去混响）
 *   normal      人声（RVC）、伴奏、原声（去混响）。内置流程另出混响轨、msst-native 不出，都不入库
 *   aggressive  同 normal，原声另去了伴唱；v1 不开放
 */
export const COVER_MODE_TRACKS: Record<CoverMode, readonly CoverOutputRole[]> = {
    library: ['vocal', 'instrumental', 'original'],
    normal: ['vocal', 'instrumental', 'original'],
    aggressive: ['vocal', 'instrumental', 'original'],
};
export interface CoverModeStatus {
    mode: CoverMode;
    separator: CoverSeparator;
    available: boolean;
    reason?: 'missing-part' | 'not-in-v1';   // available 为 false 时给；界面据此灰掉并写原因
    missingParts: CoverPartId[];             // reason 为 missing-part 时列出缺的包
    tracks: readonly CoverOutputRole[];      // = COVER_MODE_TRACKS[mode]
}

export interface CoverComponentStatus {
    state: 'absent' | 'installing' | 'installed' | 'corrupt';
    version: string | null;
    downloadBytes: number;      // 安装前就显示（M7）
    installedBytes: number;
    installRoot: string | null; // 装在哪个目录；未装为 null。默认 %LOCALAPPDATA%\okchang\cover-runtime，安装前可用 pickInstallDir 换盘
                                // （豆苞对应 component_install.json 的 install_root，SM §2.4）。目录须可写：后端运行时往自己目录里写 tmp/ 和模型副本
    gpu: { ok: boolean; name: string | null; reason?: 'no-nvidia' | 'driver-too-old' };
    parts: CoverPartStatus[];   // v3.5：固定 5 项，顺序同 CoverPartId。顶层 state / downloadBytes / installedBytes 只算 3 个必装包
    modes: CoverModeStatus[];   // v3.5：固定 6 项（3 档 × 2 种分离流程），组件未装时全部 available:false
    defaultMode: CoverMode;     // v3.5：enhance-models 已装为 normal，否则 library
    defaultSeparator: CoverSeparator;   // v3.5：v1 恒为 builtin（设计稿 W9 技术决定 1）
}

export interface CoverInstallProgress {
    phase: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error' | 'cancelled';
    receivedBytes: number;
    totalBytes: number;
    errorCode: CoverErrorCode | null;
    partId: CoverPartId | null;  // v3.5：正在处理的包；done / error / cancelled 时为 null。receivedBytes / totalBytes 是本次安装全部包的合计
}

export interface RvcModel { id: string; name: string; hasIndex: boolean; addedAt: number }

export interface CoverJobRequest {
    sourceSongId: string;                              // 曲库里的普通 LocalSong
    source: { fileName: string; bytes: ArrayBuffer };  // 渲染端用 getFileFromLocalSong 读出
    lyrics: { content: string; format: WorkLyricsFormat } | null;
    modelId: string;
    title: string;
    artist: string | null;
    keySemitones?: number;   // 变调，整数 −12…12，缺省 0；越界回 INVALID_REQUEST。人声由后端 RVC 的 key 变（python-backend/process_pipeline.py:594）；
                             // 伴奏由 ok唱歌 入库时用组件自带 ffmpeg 的 rubberband 变（后端不变伴奏，process_pipeline.py:349；命令照 SM §2.5）；原声不变。
                             // v3.5：后端的「和声」轨是去混响分出的混响成分（process_pipeline.py:458-459, 676-682），不入库，作品没有 harmony 轨
                             // source.fileName 是加密格式时回 SOURCE_ENCRYPTED
    mode?: CoverMode;               // v3.5：缺省 = CoverComponentStatus.defaultMode；不可用回 MODE_UNAVAILABLE
    separator?: CoverSeparator;     // v3.5：缺省 builtin；不可用回 MODE_UNAVAILABLE
}

/**
 * 阶段按 msst-rvc 后端代码里看得到的边界定（python-backend/process_pipeline.py:688-837），由 okcover 入口挂钩上报（设计稿 4.4，进度行 type:'progress'）：
 *   preparing   导入 torch、清临时目录、转 WAV（:59-135, 749-759），progress 0–0.05
 *   separating  MSST 分离（:765-778）。走内置流程时按 demix 分块进度给确定进度（msst/utils.py:118）；
 *               走 msst-native 预设时没有进度，indeterminate = true（native_msst_bridge.py:190-245）。progress 0.05–0.60
 *   converting  RVC 转换（:789-821），后端没有进度，indeterminate = true，progress 停在 0.60
 *   ingesting   组件进程里的 finalize 一步做：变调（有 keySemitones 时）、转 44.1 kHz 立体声 16 位、对齐、写作品文件夹；
 *               再由主进程整体移入输出根（v3.5，设计稿 W9 技术决定 4），progress 0.85–0.99
 */
export type CoverJobPhase =
    | 'queued' | 'preparing' | 'separating' | 'converting' | 'ingesting'
    | 'done' | 'failed' | 'cancelled';

export interface CoverJobEvent {
    jobId: string;
    phase: CoverJobPhase;
    progress: number;            // 0–1，整个任务，单调不减
    indeterminate: boolean;      // true：后端此阶段没有进度，界面显示不定进度条加已用时间
    message?: string;            // 后端原样文案（如“MSST Stage 1: 分离人声和伴奏...”），只显示，不拿来判断
    title: string;
    workId?: string;             // done 时给
    errorCode?: CoverErrorCode;  // failed 时给
    separator?: CoverSeparator;  // v3.5：separating 起给，实际用的分离流程；选了 msst-native 但它失败、后端回退内置时，这里如实给 builtin
}
