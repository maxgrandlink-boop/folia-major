#pragma once

#include "okLiveShm.h"

#include <cstdint>

namespace okengine {

class LiveLink {
public:
    LiveLink() = default;
    ~LiveLink();
    LiveLink(const LiveLink&) = delete;
    LiveLink& operator=(const LiveLink&) = delete;

    bool open();
    void close();
    bool ready() const { return layout_ != nullptr; }
    void beat();
    void setPlaying(bool playing);
    void setKaraoke(bool karaoke);
    void beginGeneration(int64_t songFrame);
    int write(const float* interleaved4, int frames);
    bool pluginFresh(uint32_t staleMs = oklive::kEngineSeesPluginStaleMs) const;
    uint32_t hostRate() const;
    uint32_t configSeq() const;
    int64_t outputSongFrame() const;
    uint64_t readIndex() const;
    uint64_t writeIndex() const;
    oklive::Layout* layout() const { return layout_; }

private:
    oklive::Layout* layout_ = nullptr;
    bool ownedHeap_ = false;
#ifdef _WIN32
    void* mapping_ = nullptr;
    void* view_ = nullptr;
#endif
};

}
