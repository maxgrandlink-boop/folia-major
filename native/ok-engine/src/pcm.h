#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

// 一轨已映射的 PCM。data 指向交错样本，调用方保证寿命长于混音器。

namespace okengine {

enum class Role : uint8_t { Vocal = 0, Instrumental = 1, Original = 2, Harmony = 3 };

struct PcmView {
    const uint8_t* data = nullptr;
    int64_t frames = 0;
    uint32_t rate = 0;
    uint16_t channels = 0;
    uint16_t bits = 0;
    uint16_t format = 1;
    uint16_t blockAlign = 0;
    bool present = false;
};

inline float pcmSample(const PcmView& view, int64_t frame, int channel) {
    if (!view.present || frame < 0 || frame >= view.frames || view.blockAlign == 0) return 0.f;
    if (channel < 0) channel = 0;
    if (channel >= view.channels) channel = 0;
    const uint32_t width = view.bits / 8u;
    const uint8_t* p = view.data + static_cast<uint64_t>(frame) * view.blockAlign + static_cast<uint32_t>(channel) * width;
    if (view.format == 3 && view.bits == 32) {
        float value = 0.f;
        std::memcpy(&value, p, 4);
        return value;
    }
    if (view.bits == 16) {
        int16_t value = 0;
        std::memcpy(&value, p, 2);
        return static_cast<float>(value) / 32768.f;
    }
    if (view.bits == 24) {
        int32_t value = static_cast<int32_t>(p[0] | (p[1] << 8) | (p[2] << 16));
        if (value & 0x800000) value |= ~0xFFFFFF;
        return static_cast<float>(value) / 8388608.f;
    }
    if (view.bits == 32) {
        int32_t value = 0;
        std::memcpy(&value, p, 4);
        return static_cast<float>(value) / 2147483648.f;
    }
    return 0.f;
}

struct MappedSample {
    int64_t source = -1;
    float value = 0.f;
};

inline MappedSample sampleAtMaster(const PcmView& view, int64_t master, int channel, uint32_t refRate, int64_t duration) {
    MappedSample mapped;
    if (!view.present || master < 0 || master >= duration || refRate == 0 || view.rate == 0) return mapped;
    const uint64_t numerator = static_cast<uint64_t>(master) * view.rate;
    const uint64_t source = numerator / refRate;
    if (static_cast<int64_t>(source) >= view.frames) return mapped;
    mapped.source = static_cast<int64_t>(source);
    const float frac = static_cast<float>(static_cast<double>(numerator % refRate) / static_cast<double>(refRate));
    const int ch = (channel > 0 && view.channels > 1) ? 1 : 0;
    const float a = pcmSample(view, mapped.source, ch);
    if (frac == 0.f || mapped.source + 1 >= view.frames) {
        mapped.value = a;
        return mapped;
    }
    const float b = pcmSample(view, mapped.source + 1, ch);
    mapped.value = a + (b - a) * frac;
    return mapped;
}

inline int64_t frameForSeconds(double seconds, uint32_t rate, int64_t durationFrames) {
    if (!(seconds > 0.0) || rate == 0 || durationFrames <= 0) return 0;
    const double frames = seconds * static_cast<double>(rate);
    if (frames >= static_cast<double>(durationFrames)) return durationFrames;
    return static_cast<int64_t>(std::llround(frames));
}

}
