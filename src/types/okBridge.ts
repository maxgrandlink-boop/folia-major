// src/types/okBridge.ts —— W1 契约 v1.0。src/vite-env.d.ts 的 electron 类型加 `ok?: OkBridge`（网页版没有）
import type {
    Result, WorksRoot, Work, WorkSettings, RescanSummary, WorksChangedEvent, WorksErrorCode,
    EngineLoadRequest, EngineLoaded, EngineState, EngineClock, EngineEnded, EngineLooped, EngineErrorEvent,
    EngineErrorCode, EngineSnapshot, OutputDevice, OutputDevicesEvent, WorkMix,
} from './multitrack';
import type { LiveMode, LiveModeSource, FollowConfig, SmartReverbConfig, PluginGains, LiveStatus, LiveLevels, PluginInfo, LiveErrorCode } from './live';
import type { CoverComponentStatus, CoverInstallProgress, RvcModel, CoverJobRequest, CoverJobEvent, CoverErrorCode } from './cover';

export type Unsubscribe = () => void;
type R<T, C extends string> = Promise<Result<T, C>>;

export interface OkBridge {
    contractVersion: string;   // 常量，等于 OK_CONTRACT_VERSION；不等则前端不启用 ok 功能并记日志

    works: {
        listRoots(): R<WorksRoot[], WorksErrorCode>;                                     // ok-works:list-roots
        addRoot(): R<{ root: WorksRoot; summary: RescanSummary }, WorksErrorCode>;      // ok-works:add-root（主进程开文件夹框）
        removeRoot(rootId: string): R<void, WorksErrorCode>;                             // ok-works:remove-root（只删记录）
        rescan(rootId?: string): R<RescanSummary, WorksErrorCode>;                       // ok-works:rescan
        list(rootId?: string): R<Work[], WorksErrorCode>;                                // ok-works:list
        readSettings(workId: string): R<WorkSettings, WorksErrorCode>;                   // ok-works:read-settings
        writeSettings(workId: string, settings: WorkSettings): R<void, WorksErrorCode>;  // ok-works:write-settings
        readCover(workId: string): R<ArrayBuffer | null, WorksErrorCode>;                // ok-works:read-cover
        reveal(workId: string): R<void, WorksErrorCode>;                                 // ok-works:reveal
        onChanged(cb: (e: WorksChangedEvent) => void): Unsubscribe;                      // 事件 ok-works:changed
    };

    engine: {
        load(req: EngineLoadRequest): R<EngineLoaded, EngineErrorCode>;                  // ok-engine:load
        play(attempt: number): R<void, EngineErrorCode>;                                 // ok-engine:play
        pause(attempt: number): R<void, EngineErrorCode>;                                // ok-engine:pause
        stop(attempt: number): R<void, EngineErrorCode>;                                 // ok-engine:stop
        seek(attempt: number, sec: number): R<{ positionSec: number }, EngineErrorCode>; // ok-engine:seek
        setMix(attempt: number, mix: WorkMix): R<void, EngineErrorCode>;                 // ok-engine:set-mix（20 ms 斜坡）
        setKaraoke(on: boolean): R<void, EngineErrorCode>;                               // ok-engine:set-karaoke
        setHarmony(on: boolean): R<void, EngineErrorCode>;                               // ok-engine:set-harmony（和声并入伴奏，播放中即时生效）
        setMaster(volume: number, muted: boolean): R<void, EngineErrorCode>;             // ok-engine:set-master
        setLoopOne(on: boolean): R<void, EngineErrorCode>;                               // ok-engine:set-loop-one
        listDevices(): R<OutputDevice[], EngineErrorCode>;                               // ok-engine:list-devices
        setOutputDevice(id: string | null): R<void, EngineErrorCode>;                    // ok-engine:set-output-device
        getSnapshot(): R<EngineSnapshot | null, EngineErrorCode>;                        // ok-engine:get-snapshot
        onState(cb: (s: EngineState) => void): Unsubscribe;                              // 事件 ok-engine:state
        onClock(cb: (c: EngineClock) => void): Unsubscribe;                              // 事件 ok-engine:clock（10 Hz + seek/状态变化时）
        onEnded(cb: (e: EngineEnded) => void): Unsubscribe;                              // 事件 ok-engine:ended
        onLooped(cb: (e: EngineLooped) => void): Unsubscribe;                            // 事件 ok-engine:looped
        onError(cb: (e: EngineErrorEvent) => void): Unsubscribe;                         // 事件 ok-engine:error
        onDevices(cb: (e: OutputDevicesEvent) => void): Unsubscribe;                     // 事件 ok-engine:devices
    };

    live: {
        getStatus(): R<LiveStatus, LiveErrorCode>;                                       // ok-live:get-status
        setMode(mode: LiveMode, source: LiveModeSource): R<LiveStatus, LiveErrorCode>;  // ok-live:set-mode（插件未连接不算错）
        setFollowConfig(c: FollowConfig): R<void, LiveErrorCode>;                        // ok-live:set-follow-config
        setSmartReverb(c: SmartReverbConfig): R<void, LiveErrorCode>;                    // ok-live:set-smart-reverb
        setPluginGains(g: PluginGains): R<void, LiveErrorCode>;                          // ok-live:set-plugin-gains
        setLeaveAiGap(ms: number): R<void, LiveErrorCode>;                               // ok-live:set-leave-ai-gap
        setLevelsSubscribed(on: boolean): R<void, LiveErrorCode>;                        // ok-live:set-levels-subscribed
        getPluginInfo(): R<PluginInfo, LiveErrorCode>;                                   // ok-live:get-plugin-info
        openPluginFolder(): R<void, LiveErrorCode>;                                      // ok-live:open-plugin-folder
        onStatus(cb: (s: LiveStatus) => void): Unsubscribe;                              // 事件 ok-live:status
        onLevels(cb: (l: LiveLevels) => void): Unsubscribe;                              // 事件 ok-live:levels
    };

    cover: {
        getComponent(): R<CoverComponentStatus, CoverErrorCode>;                         // ok-cover:get-component
        pickInstallDir(): R<{ dir: string; freeBytes: number }, CoverErrorCode>;          // ok-cover:pick-install-dir（主进程开目录框；取消回 DIALOG_CANCELLED）
        installComponent(opts?: { parentDir?: string }): R<void, CoverErrorCode>;         // ok-cover:install-component（进度走事件；不给 parentDir 用默认位置；空间不足回 DISK_FULL）
        cancelInstall(): R<void, CoverErrorCode>;                                        // ok-cover:cancel-install
        removeComponent(): R<void, CoverErrorCode>;                                      // ok-cover:remove-component
        listModels(): R<RvcModel[], CoverErrorCode>;                                     // ok-cover:list-models
        addModel(): R<RvcModel, CoverErrorCode>;                                         // ok-cover:add-model（主进程开文件框）
        removeModel(modelId: string): R<void, CoverErrorCode>;                           // ok-cover:remove-model
        submit(req: CoverJobRequest): R<{ jobId: string }, CoverErrorCode>;              // ok-cover:submit
        cancel(jobId: string): R<void, CoverErrorCode>;                                  // ok-cover:cancel
        listJobs(): R<CoverJobEvent[], CoverErrorCode>;                                  // ok-cover:list-jobs（各任务最新一条）
        onInstallProgress(cb: (p: CoverInstallProgress) => void): Unsubscribe;           // 事件 ok-cover:install-progress
        onJob(cb: (e: CoverJobEvent) => void): Unsubscribe;                              // 事件 ok-cover:job
    };
}
