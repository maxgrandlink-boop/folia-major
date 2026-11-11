#pragma once

#include "pcm.h"

#include <string>

namespace okengine {

class WavMap {
public:
    WavMap() = default;
    WavMap(const WavMap&) = delete;
    WavMap& operator=(const WavMap&) = delete;
    WavMap(WavMap&& other) noexcept;
    WavMap& operator=(WavMap&& other) noexcept;
    ~WavMap();

    bool open(const std::string& utf8Path, std::string& error);
    void close();
    const PcmView& view() const { return view_; }

private:
    PcmView view_;
    void* mapping_ = nullptr;
    size_t size_ = 0;
#ifdef _WIN32
    void* file_ = nullptr;
    void* map_ = nullptr;
#else
    int fd_ = -1;
#endif
};

bool parseWav(const uint8_t* bytes, size_t size, PcmView& out, std::string& error);

}
