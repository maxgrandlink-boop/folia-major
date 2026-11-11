#include "shm.h"

#include <chrono>
#include <cstring>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <sddl.h>
#endif

namespace okengine {

namespace {

int64_t qpcNow() {
#ifdef _WIN32
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return value.QuadPart;
#else
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();
#endif
}

int64_t qpcFreq() {
#ifdef _WIN32
    LARGE_INTEGER value{};
    QueryPerformanceFrequency(&value);
    return value.QuadPart > 0 ? value.QuadPart : 1;
#else
    return 1000000000ll;
#endif
}

void publishHeader(oklive::Layout* layout) {
    std::memset(layout, 0, sizeof(*layout));
    layout->h.abiMajor = oklive::kAbiMajor;
    layout->h.abiMinor = oklive::kAbiMinor;
    layout->h.totalBytes = static_cast<uint32_t>(sizeof(oklive::Layout));
    layout->h.ringFrames = oklive::kRingFrames;
    layout->h.ringChannels = oklive::kRingChannels;
#ifdef _WIN32
    layout->h.creatorPid = GetCurrentProcessId();
    layout->e.enginePid.store(GetCurrentProcessId(), std::memory_order_relaxed);
#endif
    oklive::Control control{};
    control.mode = oklive::Mode::NormalSpeech;
    control.vocalControl = oklive::VocalControl::Monitor;
    control.thresholdDb = -40.f;
    control.fadeInSec = 0.f;
    control.fadeOutSec = 0.10f;
    control.monitorFloorDb = -48.f;
    control.monitorCeilDb = -10.f;
    control.aiVocalCap = 0.8f;
    control.switchFadeMs = 20.f;
    control.leaveAiGapMs = 280.f;
    control.reverbRoom = 0.4f;
    control.reverbDamp = 0.5f;
    control.reverbWet = 0.2f;
    layout->ctl.c = control;
    layout->ctl.seq.store(0, std::memory_order_relaxed);
    layout->h.magic.store(oklive::kMagic, std::memory_order_release);
}

}

LiveLink::~LiveLink() { close(); }

bool LiveLink::open() {
    close();
#ifdef _WIN32
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;GA;;;OW)(A;;GA;;;SY)S:(ML;;NW;;;LW)", SDDL_REVISION_1, &descriptor, nullptr);
    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.lpSecurityDescriptor = descriptor;
    mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, descriptor ? &attributes : nullptr, PAGE_READWRITE, 0, sizeof(oklive::Layout), oklive::kMappingName);
    if (descriptor) LocalFree(descriptor);
    if (mapping_ == nullptr) return false;
    const bool created = GetLastError() != ERROR_ALREADY_EXISTS;
    view_ = MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(oklive::Layout));
    if (view_ == nullptr) {
        close();
        return false;
    }
    layout_ = static_cast<oklive::Layout*>(view_);
    if (created) publishHeader(layout_);
    else {
        const auto start = std::chrono::steady_clock::now();
        while (layout_->h.magic.load(std::memory_order_acquire) != oklive::kMagic) {
            if (std::chrono::steady_clock::now() - start > std::chrono::milliseconds(200)) {
                publishHeader(layout_);
                break;
            }
            Sleep(1);
        }
        if (layout_->h.abiMajor != oklive::kAbiMajor || layout_->h.totalBytes < sizeof(oklive::Layout)) {
            close();
            return false;
        }
    }
#else
    layout_ = new oklive::Layout();
    ownedHeap_ = true;
    publishHeader(layout_);
#endif
    return layout_ != nullptr;
}

void LiveLink::close() {
#ifdef _WIN32
    if (view_ != nullptr) UnmapViewOfFile(view_);
    if (mapping_ != nullptr) CloseHandle(mapping_);
    view_ = nullptr;
    mapping_ = nullptr;
    layout_ = nullptr;
#else
    if (ownedHeap_) delete layout_;
    ownedHeap_ = false;
    layout_ = nullptr;
#endif
}

void LiveLink::beat() {
    if (layout_ == nullptr) return;
    layout_->e.heartbeat.fetch_add(1, std::memory_order_relaxed);
    layout_->e.heartbeatQpc.store(qpcNow(), std::memory_order_relaxed);
}

void LiveLink::setPlaying(bool playing) {
    if (layout_ == nullptr) return;
    layout_->e.playing.store(playing ? 1u : 0u, std::memory_order_release);
}

void LiveLink::setKaraoke(bool karaoke) {
    if (layout_ == nullptr) return;
    const uint32_t seq = layout_->ctl.seq.load(std::memory_order_relaxed);
    layout_->ctl.seq.store(seq + 1, std::memory_order_relaxed);
    layout_->ctl.c.karaoke = karaoke ? 1u : 0u;
    layout_->ctl.seq.store(seq + 2, std::memory_order_release);
}

void LiveLink::beginGeneration(int64_t songFrame) {
    if (layout_ == nullptr) return;
    const uint64_t index = layout_->e.writeIndex.load(std::memory_order_relaxed);
    layout_->e.genStartRingIndex.store(index, std::memory_order_relaxed);
    layout_->e.genStartSongFrame.store(songFrame, std::memory_order_relaxed);
    layout_->e.ringSampleRate.store(hostRate() == 0 ? 48000u : hostRate(), std::memory_order_relaxed);
    layout_->e.transportGen.fetch_add(1, std::memory_order_release);
}

int LiveLink::write(const float* interleaved4, int frames) {
    if (layout_ == nullptr || interleaved4 == nullptr || frames <= 0) return 0;
    if (layout_->e.playing.load(std::memory_order_acquire) == 0) return 0;
    const uint64_t written = layout_->e.writeIndex.load(std::memory_order_relaxed);
    const uint64_t read = layout_->p.readIndex.load(std::memory_order_acquire);
    const uint64_t fill = written - read;
    if (fill >= oklive::kRingFrames) return 0;
    uint64_t space = oklive::kRingFrames - fill;
    if (static_cast<uint64_t>(frames) < space) space = static_cast<uint64_t>(frames);
    for (uint64_t i = 0; i < space; ++i) {
        float* dest = layout_->ring + ((written + i) & (oklive::kRingFrames - 1)) * oklive::kRingChannels;
        std::memcpy(dest, interleaved4 + i * oklive::kRingChannels, sizeof(float) * oklive::kRingChannels);
    }
    layout_->e.writeIndex.store(written + space, std::memory_order_release);
    return static_cast<int>(space);
}

bool LiveLink::pluginFresh(uint32_t staleMs) const {
    if (layout_ == nullptr) return false;
    const int64_t stamp = layout_->p.heartbeatQpc.load(std::memory_order_acquire);
    if (stamp == 0) return false;
    const int64_t delta = qpcNow() - stamp;
    const int64_t limit = qpcFreq() * static_cast<int64_t>(staleMs) / 1000;
    return delta >= 0 && delta < limit;
}

uint32_t LiveLink::hostRate() const {
    return layout_ == nullptr ? 0 : layout_->p.hostSampleRate.load(std::memory_order_acquire);
}

uint32_t LiveLink::configSeq() const {
    return layout_ == nullptr ? 0 : layout_->p.configSeq.load(std::memory_order_acquire);
}

int64_t LiveLink::outputSongFrame() const {
    return layout_ == nullptr ? 0 : layout_->p.outputSongFrame.load(std::memory_order_acquire);
}

uint64_t LiveLink::readIndex() const {
    return layout_ == nullptr ? 0 : layout_->p.readIndex.load(std::memory_order_acquire);
}

uint64_t LiveLink::writeIndex() const {
    return layout_ == nullptr ? 0 : layout_->e.writeIndex.load(std::memory_order_acquire);
}

}
