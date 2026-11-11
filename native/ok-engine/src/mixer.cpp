#include "mixer.h"

#include <algorithm>
#include <cmath>

namespace okengine {

namespace {

constexpr int kReady = 0;
constexpr int kPlaying = 1;
constexpr int kPaused = 2;
constexpr int kEnded = 3;

int fadeSamples(uint32_t rate) {
    const int count = static_cast<int>(std::llround(0.010 * static_cast<double>(rate)));
    return count > 0 ? count : 1;
}

}

const char* Mixer::status() const {
    if (status_ == kPlaying) return "playing";
    if (status_ == kPaused) return "paused";
    if (status_ == kEnded) return "ended";
    return "ready";
}

bool Mixer::takeLooped() {
    const bool value = looped_;
    looped_ = false;
    return value;
}

bool Mixer::takeEnded() {
    const bool value = ended_;
    ended_ = false;
    return value;
}

MixError Mixer::load(const MixLoad& request, MixInfo& info) {
    info = {};
    int reference = -1;
    if (request.tracks[0].present) reference = 0;
    else if (request.tracks[1].present) reference = 1;
    else if (request.tracks[2].present) reference = 2;
    else if (request.tracks[3].present) reference = 3;
    if (reference < 0) return MixError::NoTracks;
    const uint32_t rate = request.tracks[static_cast<size_t>(reference)].rate;
    if (rate == 0) return MixError::BadRate;

    int timeline = -1;
    if (request.tracks[1].present) timeline = 1;
    else if (request.tracks[2].present) timeline = 2;
    else if (request.tracks[0].present) timeline = 0;
    else timeline = 3;
    const PcmView& axis = request.tracks[static_cast<size_t>(timeline)];
    if (axis.rate == 0 || axis.frames <= 0) return MixError::BadRate;
    const int64_t duration = (axis.frames * static_cast<int64_t>(rate)) / static_cast<int64_t>(axis.rate);
    if (duration <= 0) return MixError::BadRate;

    tracks_ = request.tracks;
    gains_ = request.gains;
    karaoke_ = request.karaoke;
    harmony_ = request.harmony;
    masterGain_ = request.master;
    masterMuted_ = request.masterMuted;
    loopOne_ = request.loopOne;
    rate_ = rate;
    duration_ = duration;
    master_ = frameForSeconds(request.startSec, rate_, duration_);
    status_ = master_ >= duration_ ? kEnded : kReady;
    fade_ = Fade::None;
    fadeLeft_ = 0;
    fadeTotal_ = fadeSamples(rate_);
    seekTo_ = master_;
    landing_ = master_;
    looped_ = false;
    ended_ = false;
    hold_ = false;
    lastEnv_ = 1.f;
    last_ = {};
    for (int i = 0; i < 4; ++i) {
        applied_[static_cast<size_t>(i)] = targetGain(i);
        const PcmView& track = tracks_[static_cast<size_t>(i)];
        TrackAlign& align = info.tracks[static_cast<size_t>(i)];
        align.present = track.present;
        if (!track.present || track.rate == 0) continue;
        align.durationSec = static_cast<double>(track.frames) / static_cast<double>(track.rate);
        const int64_t atRef = (track.frames * static_cast<int64_t>(rate_)) / static_cast<int64_t>(track.rate);
        align.padded = atRef < duration_;
        align.trimmed = atRef > duration_;
    }
    info.durationSec = static_cast<double>(duration_) / static_cast<double>(rate_);
    info.sampleRate = rate_;
    info.durationFrames = duration_;
    return MixError::Ok;
}

float Mixer::targetGain(int role) const {
    if (role == static_cast<int>(Role::Harmony)) return 0.f;
    const TrackGain& gain = gains_[static_cast<size_t>(role)];
    if (gain.muted) return 0.f;
    if (karaoke_ && role == static_cast<int>(Role::Instrumental)) return 0.f;
    if (gain.linear <= 0.f) return 0.f;
    return gain.linear;
}

void Mixer::setGain(Role role, TrackGain gain) {
    if (static_cast<int>(role) > 3) return;
    gains_[static_cast<int>(role)] = gain;
}

void Mixer::setKaraoke(bool on) { karaoke_ = on; }
void Mixer::setHarmony(bool on) { harmony_ = on; }
void Mixer::setMaster(float volume, bool muted) {
    masterGain_ = volume;
    masterMuted_ = muted;
}
void Mixer::setLoopOne(bool on) { loopOne_ = on; }

void Mixer::play() {
    if (rate_ == 0) return;
    if (status_ == kEnded || master_ >= duration_) master_ = 0;
    status_ = kPlaying;
    hold_ = false;
    fade_ = Fade::In;
    fadeTotal_ = fadeSamples(rate_);
    fadeLeft_ = fadeTotal_;
    lastEnv_ = 0.f;
}

void Mixer::pause() {
    if (status_ != kPlaying) return;
    fade_ = Fade::OutPause;
    fadeTotal_ = fadeSamples(rate_);
    fadeLeft_ = fadeTotal_;
}

void Mixer::stop() {
    if (rate_ == 0) return;
    if (status_ != kPlaying) {
        master_ = 0;
        status_ = kReady;
        fade_ = Fade::None;
        hold_ = false;
        landing_ = 0;
        return;
    }
    fade_ = Fade::OutStop;
    fadeTotal_ = fadeSamples(rate_);
    fadeLeft_ = fadeTotal_;
}

void Mixer::seek(double seconds) {
    if (rate_ == 0) return;
    const int64_t target = frameForSeconds(seconds, rate_, duration_);
    if (status_ != kPlaying) {
        master_ = target;
        landing_ = target;
        hold_ = false;
        fade_ = Fade::None;
        status_ = target >= duration_ ? kEnded : (status_ == kReady ? kReady : kPaused);
        if (status_ == kEnded) ended_ = true;
        return;
    }
    seekTo_ = target;
    landing_ = -1;
    fade_ = Fade::OutSeek;
    fadeTotal_ = fadeSamples(rate_);
    fadeLeft_ = fadeTotal_;
}

void Mixer::finishFade() {
    if (fade_ == Fade::OutSeek) {
        master_ = seekTo_;
        landing_ = master_;
        hold_ = false;
        if (master_ >= duration_) {
            status_ = kEnded;
            ended_ = true;
            fade_ = Fade::None;
            return;
        }
        fade_ = Fade::In;
        fadeTotal_ = fadeSamples(rate_);
        fadeLeft_ = fadeTotal_;
        return;
    }
    if (fade_ == Fade::OutPause) {
        status_ = kPaused;
        fade_ = Fade::None;
        hold_ = false;
        return;
    }
    if (fade_ == Fade::OutStop) {
        master_ = 0;
        landing_ = 0;
        status_ = kReady;
        fade_ = Fade::None;
        hold_ = false;
        return;
    }
    fade_ = Fade::None;
}

void Mixer::noteEnd() {
    if (loopOne_ && fade_ != Fade::OutSeek && fade_ != Fade::OutPause && fade_ != Fade::OutStop) {
        master_ = 0;
        looped_ = true;
        hold_ = false;
        return;
    }
    if (fade_ == Fade::OutSeek || fade_ == Fade::OutPause || fade_ == Fade::OutStop) {
        hold_ = true;
        master_ = duration_;
        return;
    }
    status_ = kEnded;
    ended_ = true;
    hold_ = false;
    fade_ = Fade::None;
}

void Mixer::mixFrame(float& left, float& right) {
    const float step = 1.f / (0.020f * static_cast<float>(rate_));
    for (int i = 0; i < 4; ++i) {
        const float target = targetGain(i);
        const float applied = applied_[static_cast<size_t>(i)];
        if (applied < target) applied_[static_cast<size_t>(i)] = std::min(target, applied + step);
        else if (applied > target) applied_[static_cast<size_t>(i)] = std::max(target, applied - step);
    }
    const float instrumental = applied_[static_cast<int>(Role::Instrumental)];
    last_.master = master_;
    last_.mixed = true;
    left = 0.f;
    right = 0.f;
    for (int i = 0; i < 4; ++i) {
        const MappedSample sampleL = sampleAtMaster(tracks_[static_cast<size_t>(i)], master_, 0, rate_, duration_);
        const MappedSample sampleR = sampleAtMaster(tracks_[static_cast<size_t>(i)], master_, 1, rate_, duration_);
        last_.sourceFrame[static_cast<size_t>(i)] = sampleL.source;
        float gain = applied_[static_cast<size_t>(i)];
        if (i == static_cast<int>(Role::Harmony)) gain = harmony_ ? instrumental : 0.f;
        if (gain == 0.f) continue;
        left += sampleL.value * gain;
        right += sampleR.value * gain;
    }
}

int Mixer::render(float* interleavedStereo, int frames) {
    if (interleavedStereo == nullptr || frames <= 0 || rate_ == 0) return 0;
    for (int i = 0; i < frames; ++i) {
        if (fadeLeft_ == 0 && (fade_ == Fade::OutSeek || fade_ == Fade::OutPause || fade_ == Fade::OutStop)) finishFade();
        float env = 1.f;
        if (fade_ == Fade::In && fadeTotal_ > 0) env = 1.f - static_cast<float>(fadeLeft_) / static_cast<float>(fadeTotal_);
        if ((fade_ == Fade::OutSeek || fade_ == Fade::OutPause || fade_ == Fade::OutStop) && fadeTotal_ > 0) {
            env = static_cast<float>(fadeLeft_) / static_cast<float>(fadeTotal_);
        }
        float left = 0.f;
        float right = 0.f;
        const bool audible = status_ == kPlaying && !hold_ && master_ < duration_;
        if (audible) {
            mixFrame(left, right);
            const float master = masterMuted_ ? 0.f : masterGain_;
            left *= env * master;
            right *= env * master;
            lastEnv_ = env;
            ++master_;
            if (master_ >= duration_) noteEnd();
        } else {
            last_.master = master_;
            last_.mixed = false;
            last_.sourceFrame = {-1, -1, -1, -1};
            lastEnv_ = 0.f;
        }
        interleavedStereo[static_cast<size_t>(i) * 2] = left;
        interleavedStereo[static_cast<size_t>(i) * 2 + 1] = right;
        if (fadeLeft_ > 0) {
            --fadeLeft_;
            if (fadeLeft_ == 0 && fade_ == Fade::In) fade_ = Fade::None;
        }
    }
    return frames;
}

}
