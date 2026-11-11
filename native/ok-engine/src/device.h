#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace okengine {

struct DeviceInfo {
    std::string id;
    std::string name;
    bool isDefault = false;
};

class AudioOutput {
public:
    using Render = void (*)(void* user, float* interleaved, int frames);

    AudioOutput();
    ~AudioOutput();
    AudioOutput(const AudioOutput&) = delete;
    AudioOutput& operator=(const AudioOutput&) = delete;

    std::vector<DeviceInfo> enumerate();
    std::string defaultId();
    bool open(uint32_t sampleRate, const std::string& deviceId, Render render, void* user);
    void close();
    bool start();
    void stop();
    int latencyFrames() const;
    bool opened() const;

private:
    static void dataCallback(void* device, void* output, const void* input, unsigned int frameCount);
    struct Impl;
    Impl* impl_;
};

}
