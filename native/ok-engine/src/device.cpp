#include "device.h"

#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <utility>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace okengine {

struct AudioOutput::Impl {
    ma_context context{};
    ma_device device{};
    ma_device_id chosen{};
    bool contextReady = false;
    bool deviceReady = false;
    bool started = false;
    bool useChosen = false;
    uint32_t sampleRate = 0;
    Render render = nullptr;
    void* user = nullptr;
};

namespace {

std::string wideToUtf8(const wchar_t* text) {
#ifdef _WIN32
    if (text == nullptr || text[0] == L'\0') return {};
    const int count = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (count <= 0) return {};
    std::string out(static_cast<size_t>(count - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), count, nullptr, nullptr);
    return out;
#else
    (void)text;
    return {};
#endif
}

std::string idOf(const ma_device_info& info) {
#ifdef _WIN32
    const std::string id = wideToUtf8(info.id.wasapi);
    return id.empty() ? info.name : id;
#else
    return std::string(info.name);
#endif
}

}

void AudioOutput::dataCallback(void* device, void* output, const void*, unsigned int frameCount) {
    auto* playback = static_cast<ma_device*>(device);
    auto* impl = static_cast<Impl*>(playback->pUserData);
    if (impl != nullptr && impl->render != nullptr && output != nullptr) {
        impl->render(impl->user, static_cast<float*>(output), static_cast<int>(frameCount));
    }
}

AudioOutput::AudioOutput() : impl_(new Impl) {
    ma_context_config config = ma_context_config_init();
#ifdef _WIN32
    ma_backend backends[] = {ma_backend_wasapi};
    impl_->contextReady = ma_context_init(backends, 1, &config, &impl_->context) == MA_SUCCESS;
#else
    impl_->contextReady = ma_context_init(nullptr, 0, &config, &impl_->context) == MA_SUCCESS;
#endif
}

AudioOutput::~AudioOutput() {
    close();
    if (impl_->contextReady) ma_context_uninit(&impl_->context);
    delete impl_;
}

std::vector<DeviceInfo> AudioOutput::enumerate() {
    std::vector<DeviceInfo> devices;
    if (!impl_->contextReady) return devices;
    ma_device_info* playback = nullptr;
    ma_uint32 count = 0;
    if (ma_context_get_devices(&impl_->context, &playback, &count, nullptr, nullptr) != MA_SUCCESS) return devices;
    devices.reserve(count);
    for (ma_uint32 i = 0; i < count; ++i) {
        DeviceInfo info;
        info.id = idOf(playback[i]);
        info.name = playback[i].name;
        info.isDefault = playback[i].isDefault == MA_TRUE;
        devices.push_back(std::move(info));
    }
    return devices;
}

std::string AudioOutput::defaultId() {
    for (const DeviceInfo& info : enumerate()) {
        if (info.isDefault) return info.id;
    }
    const std::vector<DeviceInfo> devices = enumerate();
    return devices.empty() ? std::string{} : devices.front().id;
}

bool AudioOutput::open(uint32_t sampleRate, const std::string& deviceId, Render render, void* user) {
    close();
    if (!impl_->contextReady || sampleRate == 0 || render == nullptr) return false;
    impl_->render = render;
    impl_->user = user;
    impl_->sampleRate = sampleRate;
    impl_->useChosen = false;
    if (!deviceId.empty()) {
        ma_device_info* playback = nullptr;
        ma_uint32 count = 0;
        if (ma_context_get_devices(&impl_->context, &playback, &count, nullptr, nullptr) != MA_SUCCESS) return false;
        bool found = false;
        for (ma_uint32 i = 0; i < count; ++i) {
            if (idOf(playback[i]) == deviceId) {
                impl_->chosen = playback[i].id;
                impl_->useChosen = true;
                found = true;
                break;
            }
        }
        if (!found) return false;
    }
    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.playback.format = ma_format_f32;
    config.playback.channels = 2;
    config.playback.shareMode = ma_share_mode_shared;
    config.sampleRate = sampleRate;
    config.periodSizeInMilliseconds = 10;
    config.periods = 2;
    config.dataCallback = [](ma_device* device, void* output, const void* input, ma_uint32 frames) {
        AudioOutput::dataCallback(device, output, input, frames);
    };
    config.pUserData = impl_;
    config.wasapi.noAutoStreamRouting = MA_TRUE;
    config.wasapi.usage = ma_wasapi_usage_pro_audio;
    if (impl_->useChosen) config.playback.pDeviceID = &impl_->chosen;
    if (ma_device_init(&impl_->context, &config, &impl_->device) != MA_SUCCESS) return false;
    impl_->deviceReady = true;
    return true;
}

void AudioOutput::close() {
    stop();
    if (impl_->deviceReady) ma_device_uninit(&impl_->device);
    impl_->deviceReady = false;
    impl_->useChosen = false;
}

bool AudioOutput::start() {
    if (!impl_->deviceReady || impl_->started) return impl_->started;
    if (ma_device_start(&impl_->device) != MA_SUCCESS) return false;
    impl_->started = true;
    return true;
}

void AudioOutput::stop() {
    if (!impl_->started) return;
    ma_device_stop(&impl_->device);
    impl_->started = false;
}

int AudioOutput::latencyFrames() const {
    if (impl_->sampleRate == 0) return 0;
    return static_cast<int>(impl_->sampleRate / 100);
}

bool AudioOutput::opened() const { return impl_->deviceReady; }

}
