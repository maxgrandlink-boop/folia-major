// src/types/cover.ts —— W1 契约 v1.0
import type { CommonErrorCode, WorkLyricsFormat } from './multitrack';

export type CoverErrorCode =
    | CommonErrorCode
    | 'GPU_UNSUPPORTED' | 'COMPONENT_MISSING' | 'COMPONENT_CORRUPT'
    | 'DOWNLOAD_FAILED' | 'CHECKSUM_MISMATCH' | 'DISK_FULL' | 'INSTALL_CANCELLED'
    | 'DIALOG_CANCELLED' | 'MODEL_INVALID' | 'MODEL_NOT_FOUND'
    | 'SOURCE_UNREADABLE' | 'OUTPUT_ROOT_MISSING'
    | 'JOB_NOT_FOUND' | 'JOB_FAILED' | 'JOB_CANCELLED'
    | 'CUDA_OOM';                // 后端报 "CUDA out of memory" / "cudaMalloc" / "CUDA error"（豆苞 _is_cuda_runtime_error，L2675）

export interface CoverComponentStatus {
    state: 'absent' | 'installing' | 'installed' | 'corrupt';
    version: string | null;
    downloadBytes: number;      // 安装前就显示（M7）
    installedBytes: number;
    installRoot: string | null; // 装在哪个目录；未装为 null。默认 %LOCALAPPDATA%\okchang\cover-runtime，安装前可用 pickInstallDir 换盘
                                // （豆苞对应 component_install.json 的 install_root，SM §2.4）。目录须可写：后端运行时往自己目录里写 tmp/ 和模型副本
    gpu: { ok: boolean; name: string | null; reason?: 'no-nvidia' | 'driver-too-old' };
}

export interface CoverInstallProgress {
    phase: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error' | 'cancelled';
    receivedBytes: number;
    totalBytes: number;
    errorCode: CoverErrorCode | null;
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
                             // 伴奏、和声由 ok唱歌 入库时用组件自带 ffmpeg 的 rubberband 变（后端不变伴奏，process_pipeline.py:349；命令照 SM §2.5）；原声不变
}

/**
 * 阶段按 msst-rvc 后端代码里看得到的边界定（python-backend/process_pipeline.py:688-837），由 okcover 入口挂钩上报（设计稿 4.4）：
 *   preparing   导入 torch、清临时目录、转 WAV（:59-135, 749-759），progress 0–0.05
 *   separating  MSST 分离（:765-778）。走内置流程时按 demix 分块进度给确定进度（msst/utils.py:118）；
 *               走 msst-native 预设时没有进度，indeterminate = true（native_msst_bridge.py:190-245）。progress 0.05–0.60
 *   converting  RVC 转换（:789-821），后端没有进度，indeterminate = true，progress 停在 0.60
 *   ingesting   ok唱歌 自己做：变调（有 keySemitones 时）、重采样、对齐、写 cs.json / manifest.json / 标记，progress 0.85–0.99
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
}
