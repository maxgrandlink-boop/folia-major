#pragma once

#include "pcm.h"

#include <array>
#include <cstdint>

namespace okengine {

struct TrackGain {
    float linear = 1.f;
    bool muted = false;
};

struct MixLoad {
    std::array<PcmView, 4> tracks{};
    std::array<TrackGain, 4> gains{};
    bool karaoke = false;
    bool harmony = false;
    float master = 1.f;
    bool masterMuted = false;
    double startSec = 0;
    bool loopOne = false;
};

struct TrackAlign {
    bool present = false;
    double durationSec = 0;
    bool padded = false;
    bool trimmed = false;
};

struct MixInfo {
    double durationSec = 0;
    uint32_t sampleRate = 0;
    int64_t durationFrames = 0;
    std::array<TrackAlign, 4> tracks{};
};

enum class MixError { Ok, NoTracks, BadRate };

struct MixRead {
    int64_t master = -1;
    std::array<int64_t, 4> sourceFrame{{-1, -1, -1, -1}};
    bool mixed = false;
};

class Mixer {
public:
    MixError load(const MixLoad& request, MixInfo& info);
    void play();
    void pause();
    void stop();
    void seek(double seconds);
    void setGain(Role role, TrackGain gain);
    void setKaraoke(bool on);
    void setHarmony(bool on);
    void setMaster(float volume, bool muted);
    void setLoopOne(bool on);

    int render(float* interleavedStereo, int frames);
    int64_t masterFrame() const { return master_; }
    uint32_t sampleRate() const { return rate_; }
    int64_t durationFrames() const { return duration_; }
    const char* status() const;
    bool takeLooped();
    bool takeEnded();
    int64_t landingFrame() const { return landing_; }
    float outputEnv() const { return lastEnv_; }
    float appliedGain(Role role) const { return applied_[static_cast<int>(role)]; }
    MixRead lastRead() const { return last_; }
    bool trackPresent(Role role) const { return tracks_[static_cast<int>(role)].present; }

private:
    enum class Fade { None, In, OutSeek, OutPause, OutStop };

    float targetGain(int role) const;
    void mixFrame(float& left, float& right);
    void finishFade();
    void noteEnd();

    std::array<PcmView, 4> tracks_{};
    std::array<TrackGain, 4> gains_{};
    std::array<float, 4> applied_{};
    bool karaoke_ = false;
    bool harmony_ = false;
    float masterGain_ = 1.f;
    bool masterMuted_ = false;
    bool loopOne_ = false;
    uint32_t rate_ = 0;
    int64_t duration_ = 0;
    int64_t master_ = 0;
    int status_ = 0;
    Fade fade_ = Fade::None;
    int fadeLeft_ = 0;
    int fadeTotal_ = 0;
    int64_t seekTo_ = 0;
    int64_t landing_ = -1;
    bool looped_ = false;
    bool ended_ = false;
    bool hold_ = false;
    float lastEnv_ = 1.f;
    MixRead last_{};
};

}
