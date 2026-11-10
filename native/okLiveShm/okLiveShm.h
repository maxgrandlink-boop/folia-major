// native/okLiveShm/okLiveShm.h —— W1 契约，ABI 1.0。ok-engine.exe 与 okLive.vst3 共用的唯一真源。
// 与豆苞 DuoAi 插件不做二进制兼容。语义按豆苞对齐，依据是解码后的 utils/shared_memory_manager.py：
//   豆苞主映射 Local\DuoAi_SharedMemory，magic 0x44414F44，version 10，结构体 DuoAiSharedData（:136-191），后接人声环、伴奏环
//   各 8192 帧 × 2 声道 float32（:39, 210-212）；目标积压 3072 帧、低水位 768、高水位 5600、插件传输延迟 768 帧（:40, 50-54）；
//   客户端每 20 ms 写 clientHeartbeat（:566-576），插件心跳停 ≥ 1.5 s 判离线（poll_plugin_alive，:506-564）；
//   四轨音量另开映射 Local\DuoAi_TrackVolumes（:18-20, 194-204）；另有三个命名事件 RealtimeVolume / Update / Volume（:46-48），本头不用，插件轮询。
// 字段对应：
//   vocalWriteFrame / instWriteFrame → 本头 EngineSide::writeIndex（豆苞人声、伴奏各一个环、各一个写指针；本头合成一个 4 声道环）
//   ringReadFrame → PluginSide::readIndex        ringFrameCapacity → kRingFrames
//   transportEpoch → EngineSide::transportGen     transportActive → EngineSide::playing
//   clientHeartbeat → EngineSide::heartbeat       pluginHeartbeat → PluginSide::heartbeat
//   audioSampleRate → EngineSide::ringSampleRate  playbackCommandSeq / playbackAckSeq → ControlBlock::seq / PluginSide::appliedControlSeq
//   activePlaybackEnabled / playbackState / playbackPositionSec（豆苞 ActivePlayback：插件自己推进播放并回报秒数，
//   audio_gap_monitor.py:251-254 在该模式下改看 playbackPositionSec、playbackState==3 视为在播）→ v1 不采用：
//   引擎是唯一时钟，插件只消费，位置用 PluginSide::outputSongFrame 回报。
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace oklive {

// ---------- 名字、版本 ----------
constexpr wchar_t  kMappingName[] = L"Local\\okchang.live.v1";  // 会话内命名对象；ABI 主版本变则名字变（.v2）
constexpr uint32_t kMagic    = 0x48434B4F;                        // "OKCH"
constexpr uint16_t kAbiMajor = 1;                                 // 不兼容改动 +1
constexpr uint16_t kAbiMinor = 0;                                 // 只在结构末尾追加字段时 +1
// 映射的安全描述符（双方创建时都用）："D:(A;;GA;;;OW)(A;;GA;;;SY)S:(ML;;NW;;;LW)"
// 让同一用户下不同完整性级别的进程（机架以管理员运行、ok唱歌 以普通权限运行）都能打开。

// ---------- 环 ----------
constexpr uint32_t kRingFrames   = 16384;   // 2 的幂；48 kHz 下 341 ms
constexpr uint32_t kRingChannels = 4;       // 交错 float32：[人声L, 人声R, 伴奏L, 伴奏R]；原唱永不进环
constexpr uint32_t kTargetFillMs = 60;      // 引擎维持的积压，允许 40–90 ms
// 四轨音量对齐豆苞：普通说话、混响说话、AI 人声、AI 伴奏，各一个 dB 值（plugin_track_volume.py:6-23），见 Control::trackVolumeDb*。

// ---------- 心跳 ----------
constexpr uint32_t kEngineBeatMs            = 10;
constexpr uint32_t kPluginSeesEngineStaleMs = 500;    // 插件判引擎离线 → 麦克风直通
constexpr uint32_t kEngineSeesPluginStaleMs = 1500;   // 引擎判插件离线 → route 回 local；与豆苞一致：MW:2164-2420 的 1.5 s、
                                                       // audio_gap_monitor.py:256 插件心跳 ≥ 1.5 s 记 plugin-heartbeat-stalled
constexpr uint32_t kClaimStealMs            = 1500;   // 认领者心跳停这么久，新实例可以接管
// 有的机架在滤镜停用或无输入时不调 process()，所以引擎侧阈值放宽到 1.5 s。豆苞插件侧阈值未核实，v1 按上面定。

enum class Mode : uint32_t { NormalSpeech = 0, AiFollow = 1, AiSing = 2, ReverbSpeech = 3 };
enum class VocalControl : uint32_t { Threshold = 0, Monitor = 1 };
enum class LinkState : uint32_t { Idle = 0, Ok = 1, AbiMismatch = 2, Duplicate = 3 };

struct alignas(64) Header {                    // 创建者最后 store magic（release）
    std::atomic<uint32_t> magic;
    uint16_t abiMajor;
    uint16_t abiMinor;
    uint32_t totalBytes;                       // sizeof(Layout)；打开者要求 ≥ 自己认识的大小
    uint32_t ringFrames;
    uint32_t ringChannels;
    uint32_t creatorPid;
};

struct alignas(64) EngineSide {                // 只有引擎写
    std::atomic<uint64_t> heartbeat;           // 每 10 ms +1
    std::atomic<int64_t>  heartbeatQpc;        // QueryPerformanceCounter；判活只看它
    std::atomic<uint32_t> enginePid;
    std::atomic<uint32_t> playing;             // 0：不写环，插件把 AI 人声和伴奏静音、不计欠载
    std::atomic<uint32_t> transportGen;        // 新一代 +1（见协议 5）
    std::atomic<uint32_t> ringSampleRate;      // 环里数据的采样率 = 插件 hostSampleRate
    std::atomic<uint64_t> genStartRingIndex;   // 本代第一帧在环里的绝对序号
    std::atomic<int64_t>  genStartSongFrame;   // 本代第一帧对应的歌曲帧（按 ringSampleRate）
    std::atomic<uint64_t> writeIndex;          // 单调递增，取模 kRingFrames
};

struct alignas(64) PluginSide {                // 只有插件写
    std::atomic<uint64_t> heartbeat;           // 每个 process 块 +1
    std::atomic<int64_t>  heartbeatQpc;
    std::atomic<uint64_t> instanceId;          // CAS 认领：0 → 本实例随机 id
    std::atomic<uint32_t> pluginPid;
    std::atomic<uint32_t> pluginBuild;
    std::atomic<uint32_t> hostSampleRate;
    std::atomic<uint32_t> maxBlockFrames;
    std::atomic<uint32_t> configSeq;           // 采样率或块大小变了 +1
    std::atomic<uint32_t> ackTransportGen;
    std::atomic<uint64_t> readIndex;
    std::atomic<int64_t>  outputSongFrame;     // 本块第一帧的歌曲帧，引擎据此算延迟
    std::atomic<float>    micRmsDb;            // 10 ms 窗
    std::atomic<float>    aiGateGain;          // 跟唱门当前增益 0–1
    std::atomic<uint32_t> appliedControlSeq;
    std::atomic<uint32_t> underruns;
    std::atomic<uint32_t> rejectedInstances;
    std::atomic<uint32_t> linkState;           // LinkState
};

struct Control {                               // 引擎写，插件每块读一次
    Mode mode;
    uint32_t karaoke;                          // 1：伴奏增益 0
    VocalControl vocalControl;
    float thresholdDb;                         // 默认 −40，−80–0
    float fadeInSec;                           // 默认 0，0–2
    float fadeOutSec;                          // 默认 0.10，0.10–2
    float monitorFloorDb;                      // −48 → 增益 0（MW:14718-14866）
    float monitorCeilDb;                       // −10 → 增益 1，中间 smoothstep
    float aiVocalCap;                          // AI 人声上限 0–1
    float trackVolumeDbNormal, trackVolumeDbReverb, trackVolumeDbAiVoice, trackVolumeDbAiAccomp;   // 四轨音量 dB，−60–+12，默认 0
                                               // 豆苞放在独立映射 Local\DuoAi_TrackVolumes（magic "DVAT"，shared_memory_manager.py:18-20, 194-204）；本头并进控制块
    float switchFadeMs;                        // 默认 20
    float leaveAiGapMs;                        // 默认 280（D10），离开 AI 后两路都静音的时长（MW:7948）
    float reverbRoom, reverbDamp, reverbWet;   // 插件内混响参数，v1 由引擎写固定默认值，界面不调（豆苞共享内存里没有对应字段）
    // 豆苞下发的监控参数 noise_gate 0、volume_gain 0.5、release 0.96（MW:14611-14640）在 DuoAi 插件里怎么用未核实；
    // v1 监控模式只用 monitorFloorDb / monitorCeilDb / aiVocalCap，不复刻那三个参数。
};

struct alignas(64) ControlBlock {
    std::atomic<uint32_t> seq;                 // seqlock：奇数 = 正在写
    Control c;
};

struct Layout {
    Header h;
    EngineSide e;
    PluginSide p;
    ControlBlock ctl;
    alignas(64) float ring[kRingFrames * kRingChannels];   // 256 KiB
};

static_assert(std::atomic<uint32_t>::is_always_lock_free, "atomics must be lock-free");
static_assert(std::atomic<uint64_t>::is_always_lock_free, "atomics must be lock-free");
static_assert(std::atomic<int64_t>::is_always_lock_free,  "atomics must be lock-free");
static_assert(std::atomic<float>::is_always_lock_free,    "atomics must be lock-free");
static_assert(sizeof(Header) == 64, "Header is one cache line");
static_assert(offsetof(Layout, e) % 64 == 0 && offsetof(Layout, p) % 64 == 0, "sides on own cache lines");
static_assert(offsetof(Layout, ctl) % 64 == 0 && offsetof(Layout, ring) % 64 == 0, "aligned");
static_assert((kRingFrames & (kRingFrames - 1)) == 0, "ring frames must be a power of two");

// ======================== 协议 ========================
// 1 建立映射：双方都 CreateFileMappingW(kMappingName, sizeof(Layout))。GetLastError()≠ERROR_ALREADY_EXISTS 的一方是创建者：
//   清零 → 写 Header 其余字段 → magic.store(kMagic, release)。打开者在非实时线程（插件 setActive、引擎启动）等 magic，最多 200 ms；
//   超时视为对方崩在初始化中途，自己按创建者流程重写 Header。magic 对而 abiMajor 不等、或 totalBytes 小于自己认识的大小 → 不连：
//   插件 linkState=AbiMismatch 并麦克风直通；引擎上报 connection='abi-mismatch'。
// 2 认领（只插件）：instanceId CAS 0→本实例 id。失败且认领者心跳新鲜 → linkState=Duplicate，直通，rejectedInstances++；
//   认领者心跳已停 ≥ kClaimStealMs → 允许 CAS 旧 id→新 id。setActive(false) 时 CAS 自己→0。
// 3 配置：插件在 setupProcessing 写 hostSampleRate、maxBlockFrames，再 configSeq++（release）。引擎见 configSeq 变 → 按新采样率
//   重建重采样器 → 开新一代（5）。
// 4 心跳：引擎每 10 ms heartbeat++ 并写 heartbeatQpc；插件每个 process 块一次。判活只比较 heartbeatQpc 与本机 QPC 的差。
// 5 新一代：载入、seek、换采样率、插件重新上线时，引擎 a) 停写环；b) genStartRingIndex = writeIndex，genStartSongFrame = 新起点；
//   c) transportGen.fetch_add(1, release)；d) 预填 kTargetFillMs 后继续。插件每块开头 acquire 读 transportGen，
//   与 ackTransportGen 不等 → readIndex = genStartRingIndex（丢掉旧代），ackTransportGen = transportGen。
// 6 写环（只引擎，单生产者）：可写 = kRingFrames − (writeIndex − readIndex)；写完 writeIndex.store(+n, release)。
//   积压维持在 kTargetFillMs 附近，偏差用重采样率 ±0.1% 拉回（两块声卡的时钟漂移在这里吸收）。
// 7 读环（只插件，单消费者，实时线程，不加锁、不分配、不做系统调用）：avail = writeIndex.load(acquire) − readIndex；
//   取 min(avail, 块长)，不足补 0，playing==1 时才 underruns++；readIndex.store(+取到的帧, release)；
//   outputSongFrame = genStartSongFrame + (readIndex − genStartRingIndex)。
// 8 控制块：引擎 seq++（变奇）→ 写 Control → seq++（变偶，release）。插件读 s1（acquire）→ 拷贝 → 读 s2；
//   s1 为奇或 s1≠s2 → 沿用上一份，不重试；应用后写 appliedControlSeq = s1。
// 9 模式切换（插件内，按样本）：旧路淡出 switchFadeMs → 静音间隔（离开 AiFollow/AiSing 时 leaveAiGapMs，其余 0）→ 新路淡入 switchFadeMs。
//   任何时刻 AI 人声与麦克风不同时有声；伴奏增益不参与切换。
// 10 断连：插件见引擎心跳停 ≥ 500 ms → 输出麦克风原声（无混响），不读环；引擎回来开新一代后恢复。
//    豆苞 app 正常退出时 force_stop_vst_playback：transportActive=0、清两个环、connected=0、aiSing=aiFollowSing=0（shared_memory_manager.py:451-473）；
//    插件自己判客户端离线后输出什么，在插件 C++ 里，材料里没有，未核实。本头按上句定。
//    引擎见插件心跳停 ≥ 1500 ms → connection='absent'，route 回 local；插件回来 → 新一代，从当前 heardFrame 续传（M13）。
//    映射随最后一个句柄关闭而消失，不需要清理。
// 11 暂停：playing=0 时引擎不写环；插件 AI 人声和伴奏静音（不计欠载），麦克风按当前模式照常输出。
//    与豆苞一致：暂停时 transportActive=0，“插件在 transportActive=0 时已静音输出”，再清环、transportEpoch+1
//    （shared_memory_manager.py:743-780, 811-830）。豆苞插件暂停时麦克风那几路怎么出，在插件 C++ 里，未核实。

}  // namespace oklive
