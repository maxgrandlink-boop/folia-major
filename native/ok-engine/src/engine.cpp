#include "engine.h"

#include "device.h"
#include "json.h"
#include "shm.h"
#include "transcode.h"
#include "wav.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace okengine {

namespace {

const char* roleName(int role) {
    if (role == 0) return "vocal";
    if (role == 1) return "instrumental";
    if (role == 2) return "original";
    return "harmony";
}

bool gainField(const Json& mix, const char* key, TrackGain& gain) {
    const Json* item = mix.find(key);
    if (item == nullptr || item->type != Json::Type::Object) return false;
    const Json* raw = item->find("gain");
    if (raw == nullptr || raw->type != Json::Type::Number || !raw->integral) return false;
    if (raw->i < 0 || raw->i > 100) return false;
    gain.linear = static_cast<float>(raw->i) / 100.f;
    gain.muted = item->boolean("muted", false);
    return true;
}

std::string trackPath(const Json& tracks, const char* key) {
    const Json* value = tracks.find(key);
    if (value == nullptr || value->type != Json::Type::String) return {};
    return value->s;
}

}

struct Engine::Impl {
    Handlers handlers;
    bool software = false;
    std::atomic<bool> run{true};
    std::mutex mu;
    std::mutex deviceMu;
    std::mutex emitMu;
    AudioOutput output;
    LiveLink link;
    std::array<WavMap, 4> maps{};
    std::array<bool, 4> transcoded{};
    Mixer mixer;
    MixInfo info{};
    bool loaded = false;
    uint32_t attempt = 0;
    std::string workId;
    bool karaoke = false;
    bool harmony = false;
    bool loopOne = false;
    bool followDefault = true;
    std::string deviceId;
    std::string cacheDir;
    std::string ffmpeg;
    int seq = 0;
    std::string errorStatus;
    bool suspend = false;
    SwitchStats stats;
    std::thread worker;
    std::vector<float> scratch;

    explicit Impl(Handlers h, bool softwareClock) : handlers(std::move(h)), software(softwareClock) {
        link.open();
        worker = std::thread([this] { loop(); });
    }

    ~Impl() { shutdown(); }

    void shutdown() {
        if (!run.exchange(false)) return;
        if (worker.joinable()) worker.join();
        std::lock_guard<std::mutex> devices(deviceMu);
        output.close();
        link.close();
    }

    void emit(const std::string& line) {
        if (!handlers.emit) return;
        std::lock_guard<std::mutex> lock(emitMu);
        handlers.emit(line);
    }

    const char* status() const {
        if (!errorStatus.empty()) return errorStatus.c_str();
        if (!loaded) return "idle";
        return mixer.status();
    }

    double positionSec() {
        if (!loaded || mixer.sampleRate() == 0) return 0;
        int64_t heard = mixer.masterFrame();
        if (std::strcmp(mixer.status(), "playing") == 0 && !software) {
            const int latency = output.latencyFrames();
            heard = heard > latency ? heard - latency : 0;
        }
        return static_cast<double>(heard) / static_cast<double>(mixer.sampleRate());
    }

    std::string stateJson() {
        std::string device = followDefault ? "null" : "\"" + jsonEscape(deviceId) + "\"";
        std::string id = loaded ? "\"" + jsonEscape(workId) + "\"" : "null";
        return std::string("{\"event\":\"state\",\"attempt\":") + std::to_string(attempt)
            + ",\"workId\":" + id
            + ",\"status\":\"" + status() + "\""
            + ",\"durationSec\":" + std::to_string(loaded ? info.durationSec : 0)
            + ",\"route\":\"" + (link.pluginFresh() ? "live" : "local") + "\""
            + ",\"outputDeviceId\":" + device
            + ",\"karaoke\":" + (karaoke ? "true" : "false")
            + ",\"harmony\":" + (harmony ? "true" : "false")
            + ",\"loopOne\":" + (loopOne ? "true" : "false") + "}";
    }

    std::string clockJson() {
        const bool playing = loaded && std::strcmp(mixer.status(), "playing") == 0;
        return std::string("{\"event\":\"clock\",\"attempt\":") + std::to_string(attempt)
            + ",\"positionSec\":" + std::to_string(positionSec())
            + ",\"playing\":" + (playing ? "true" : "false")
            + ",\"seq\":" + std::to_string(++seq) + "}";
    }

    void queueTransport(std::vector<std::string>& events) {
        if (mixer.takeLooped()) events.push_back(std::string("{\"event\":\"looped\",\"attempt\":") + std::to_string(attempt) + "}");
        if (mixer.takeEnded()) {
            events.push_back(std::string("{\"event\":\"ended\",\"attempt\":") + std::to_string(attempt) + "}");
            events.push_back(stateJson());
        }
    }

    bool reopen(const std::string& method) {
        if (software || !loaded) return false;
        const auto started = std::chrono::steady_clock::now();
        int64_t before = 0;
        uint32_t rate = 0;
        bool playing = false;
        std::string id;
        {
            std::lock_guard<std::mutex> lock(mu);
            before = mixer.masterFrame();
            rate = mixer.sampleRate();
            playing = std::strcmp(mixer.status(), "playing") == 0;
            id = followDefault ? std::string{} : deviceId;
        }
        bool ok = false;
        {
            std::lock_guard<std::mutex> devices(deviceMu);
            output.stop();
            output.close();
            ok = rate != 0 && output.open(rate, id, &Impl::renderThunk, this);
            if (ok && playing) ok = output.start();
        }
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        std::vector<std::string> events;
        {
            std::lock_guard<std::mutex> lock(mu);
            const int64_t after = mixer.masterFrame();
            const int64_t consumed = after > before ? after - before : 0;
            if (consumed > 0) mixer.rewind(consumed);
            stats.recoveryMs = ms;
            stats.deviationFrames = consumed;
            stats.ran = ok;
            stats.method = method;
            if (!ok) {
                errorStatus = "error";
                events.push_back(std::string("{\"event\":\"error\",\"attempt\":") + std::to_string(attempt) + ",\"code\":\"DEVICE_UNAVAILABLE\",\"fatal\":false}");
            }
            events.push_back(stateJson());
            events.push_back(clockJson());
        }
        for (const std::string& line : events) emit(line);
        return ok;
    }

    static void renderThunk(void* user, float* interleaved, int frames) {
        auto* self = static_cast<Impl*>(user);
        std::vector<std::string> events;
        {
            std::lock_guard<std::mutex> lock(self->mu);
            self->mixer.render(interleaved, frames);
            self->queueTransport(events);
        }
        for (const std::string& line : events) self->emit(line);
    }

    void loop() {
        std::string seenDefault;
        bool haveDefault = false;
        auto nextClock = std::chrono::steady_clock::now();
        while (run.load()) {
            link.beat();
            std::vector<std::string> events;
            {
                std::lock_guard<std::mutex> lock(mu);
                if (!suspend && software && loaded && std::strcmp(mixer.status(), "playing") == 0 && mixer.sampleRate() > 0) {
                    const int frames = std::max(1, static_cast<int>(mixer.sampleRate() / 100));
                    scratch.resize(static_cast<size_t>(frames) * 2);
                    mixer.render(scratch.data(), frames);
                    queueTransport(events);
                }
                const auto now = std::chrono::steady_clock::now();
                if (loaded && now >= nextClock) {
                    events.push_back(clockJson());
                    nextClock = now + std::chrono::milliseconds(100);
                }
            }
            for (const std::string& line : events) emit(line);
            if (!software && followDefault && output.opened()) {
                const std::string id = output.defaultId();
                if (haveDefault && !id.empty() && id != seenDefault) reopen("default-device");
                if (!id.empty()) {
                    seenDefault = id;
                    haveDefault = true;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }

    bool ensureOutput(uint32_t rate, std::vector<std::string>& events) {
        if (software) return true;
        std::lock_guard<std::mutex> devices(deviceMu);
        if (!output.opened()) {
            const std::string id = followDefault ? std::string{} : deviceId;
            if (rate == 0 || !output.open(rate, id, &Impl::renderThunk, this)) {
                errorStatus = "error";
                events.push_back(std::string("{\"event\":\"error\",\"attempt\":") + std::to_string(attempt) + ",\"code\":\"DEVICE_UNAVAILABLE\",\"fatal\":false}");
                return false;
            }
        }
        if (!output.start()) {
            errorStatus = "error";
            events.push_back(std::string("{\"event\":\"error\",\"attempt\":") + std::to_string(attempt) + ",\"code\":\"DEVICE_UNAVAILABLE\",\"fatal\":false}");
            return false;
        }
        errorStatus.clear();
        return true;
    }

    std::string fail(int64_t id, const char* code, const std::string& detail = {}) {
        std::string line = std::string("{\"id\":") + std::to_string(id) + ",\"ok\":false,\"code\":\"" + code + "\"";
        if (!detail.empty()) line += ",\"detail\":\"" + jsonEscape(detail) + "\"";
        line += "}";
        return line;
    }

    std::string ok(int64_t id, const std::string& value) {
        return std::string("{\"id\":") + std::to_string(id) + ",\"ok\":true,\"value\":" + value + "}";
    }

    std::string handle(const std::string& line) {
        Json root;
        if (!parseJson(line, root) || root.type != Json::Type::Object || !root.find("id") || !root.find("cmd")) {
            return fail(root.integer("id", 0), "INVALID_REQUEST");
        }
        const int64_t id = root.integer("id", 0);
        const std::string cmd = root.str("cmd");
        const Json* args = root.find("args");
        const Json empty;
        const Json& a = args != nullptr && args->type == Json::Type::Object ? *args : empty;
        std::vector<std::string> events;
        std::string response;
        if (cmd == "load") response = load(id, a, events);
        else if (cmd == "play") response = transport(id, a, events, 1);
        else if (cmd == "pause") response = transport(id, a, events, 2);
        else if (cmd == "stop") response = transport(id, a, events, 3);
        else if (cmd == "seek") response = seek(id, a, events);
        else if (cmd == "setMix") response = setMix(id, a, events);
        else if (cmd == "setKaraoke") response = flag(id, a, events, 1);
        else if (cmd == "setHarmony") response = flag(id, a, events, 2);
        else if (cmd == "setMaster") response = setMaster(id, a, events);
        else if (cmd == "setLoopOne") response = flag(id, a, events, 3);
        else if (cmd == "listDevices") response = listDevices(id, events);
        else if (cmd == "setOutputDevice") response = setDevice(id, a, events);
        else if (cmd == "getSnapshot") response = snapshot(id);
        else response = fail(id, "INVALID_REQUEST");
        for (const std::string& event : events) emit(event);
        return response;
    }

    bool attemptOk(int64_t id, const Json& args, std::string& response) {
        if (!loaded) {
            response = fail(id, "NOT_LOADED");
            return false;
        }
        const Json* raw = args.find("attempt");
        if (raw == nullptr || raw->type != Json::Type::Number) {
            response = fail(id, "INVALID_REQUEST");
            return false;
        }
        if (static_cast<uint32_t>(raw->integral ? raw->i : static_cast<int64_t>(raw->n)) != attempt) {
            response = fail(id, "SUPERSEDED");
            return false;
        }
        return true;
    }

    std::string load(int64_t id, const Json& args, std::vector<std::string>& events) {
        const Json* attemptValue = args.find("attempt");
        const Json* tracks = args.find("tracks");
        if (attemptValue == nullptr || tracks == nullptr || tracks->type != Json::Type::Object) return fail(id, "INVALID_REQUEST");
        std::array<TrackGain, 4> gains{};
        const Json* mix = args.find("mix");
        if (mix == nullptr || mix->type != Json::Type::Object) return fail(id, "INVALID_REQUEST");
        if (!gainField(*mix, "vocal", gains[0]) || !gainField(*mix, "instrumental", gains[1]) || !gainField(*mix, "original", gains[2])) {
            return fail(id, "INVALID_REQUEST");
        }
        gains[3] = gains[1];
        const Json* master = args.find("master");
        if (master == nullptr || master->type != Json::Type::Object) return fail(id, "INVALID_REQUEST");
        const double volume = master->num("volume", -1);
        if (!(volume >= 0 && volume <= 1)) return fail(id, "INVALID_REQUEST");
        {
            std::lock_guard<std::mutex> devices(deviceMu);
            output.stop();
            output.close();
        }
        {
            std::lock_guard<std::mutex> lock(mu);
            suspend = true;
            if (loaded && std::strcmp(mixer.status(), "playing") == 0) mixer.stop();
        }
        std::array<std::string, 4> paths{
            trackPath(*tracks, "vocal"),
            trackPath(*tracks, "instrumental"),
            trackPath(*tracks, "original"),
            trackPath(*tracks, "harmony"),
        };
        cacheDir = args.str("cacheDir");
        ffmpeg = args.str("ffmpeg");
        uint32_t reference = 0;
        for (int i : {0, 1, 2, 3}) {
            if (!paths[static_cast<size_t>(i)].empty() && readableWav(paths[static_cast<size_t>(i)])) {
                WavMap probe;
                std::string error;
                if (probe.open(paths[static_cast<size_t>(i)], error)) {
                    reference = probe.view().rate;
                    break;
                }
            }
        }
        if (reference == 0) {
            for (int i : {0, 1, 2, 3}) {
                if (paths[static_cast<size_t>(i)].empty()) continue;
                reference = probeSampleRate(paths[static_cast<size_t>(i)], ffmpeg);
                if (reference != 0) break;
            }
        }
        if (reference == 0) reference = 48000;
        std::array<PcmView, 4> views{};
        {
            std::lock_guard<std::mutex> lock(mu);
            for (auto& map : maps) map.close();
            transcoded = {};
        }
        for (int i = 0; i < 4; ++i) {
            if (paths[static_cast<size_t>(i)].empty()) continue;
            std::string path = paths[static_cast<size_t>(i)];
            bool converted = false;
            if (!readableWav(path)) {
                std::string output;
                std::string error;
                if (cacheDir.empty() || !transcodeToWav(path, ffmpeg, reference, cacheDir, output, error)) {
                    std::lock_guard<std::mutex> lock(mu);
                    suspend = false;
                    return fail(id, ffmpeg.empty() ? "FORMAT_UNSUPPORTED" : "TRANSCODE_FAILED", error);
                }
                path = output;
                converted = true;
            }
            std::string error;
            if (!maps[static_cast<size_t>(i)].open(path, error)) {
                std::lock_guard<std::mutex> lock(mu);
                suspend = false;
                return fail(id, "TRACK_UNREADABLE", error);
            }
            views[static_cast<size_t>(i)] = maps[static_cast<size_t>(i)].view();
            transcoded[static_cast<size_t>(i)] = converted;
        }
        MixLoad request;
        request.tracks = views;
        request.gains = gains;
        request.karaoke = args.boolean("karaoke", false);
        request.harmony = args.boolean("harmony", false);
        request.master = static_cast<float>(volume);
        request.masterMuted = master->boolean("muted", false);
        request.startSec = args.num("startSec", 0);
        request.loopOne = args.boolean("loopOne", false);
        MixInfo loadedInfo;
        const bool autoplay = args.boolean("autoplay", false);
        {
            std::lock_guard<std::mutex> lock(mu);
            if (mixer.load(request, loadedInfo) != MixError::Ok) {
                suspend = false;
                return fail(id, "TRACK_UNREADABLE", "no-tracks");
            }
            loaded = true;
            suspend = false;
            errorStatus.clear();
            attempt = static_cast<uint32_t>(attemptValue->integral ? attemptValue->i : static_cast<int64_t>(attemptValue->n));
            workId = args.str("workId");
            info = loadedInfo;
            karaoke = request.karaoke;
            harmony = request.harmony;
            loopOne = request.loopOne;
        }
        link.setKaraoke(karaoke);
        link.beginGeneration(0);
        if (autoplay) {
            if (!ensureOutput(loadedInfo.sampleRate, events)) {
                std::lock_guard<std::mutex> lock(mu);
                events.push_back(stateJson());
                return fail(id, "DEVICE_UNAVAILABLE");
            }
            std::lock_guard<std::mutex> lock(mu);
            mixer.play();
            link.setPlaying(true);
        }
        {
            std::lock_guard<std::mutex> lock(mu);
            events.push_back(stateJson());
            events.push_back(clockJson());
        }
        std::string tracksJson = "[";
        for (int i = 0; i < 4; ++i) {
            if (!info.tracks[static_cast<size_t>(i)].present) continue;
            if (tracksJson.size() > 1) tracksJson += ",";
            tracksJson += std::string("{\"role\":\"") + roleName(i) + "\",\"durationSec\":" + std::to_string(info.tracks[static_cast<size_t>(i)].durationSec)
                + ",\"padded\":" + (info.tracks[static_cast<size_t>(i)].padded ? "true" : "false")
                + ",\"trimmed\":" + (info.tracks[static_cast<size_t>(i)].trimmed ? "true" : "false")
                + ",\"transcoded\":" + (transcoded[static_cast<size_t>(i)] ? "true" : "false") + "}";
        }
        tracksJson += "]";
        return ok(id, std::string("{\"attempt\":") + std::to_string(attempt)
            + ",\"workId\":\"" + jsonEscape(workId) + "\""
            + ",\"durationSec\":" + std::to_string(info.durationSec)
            + ",\"sampleRate\":" + std::to_string(info.sampleRate)
            + ",\"tracks\":" + tracksJson + "}");
    }

    std::string transport(int64_t id, const Json& args, std::vector<std::string>& events, int kind) {
        uint32_t rate = 0;
        {
            std::lock_guard<std::mutex> lock(mu);
            std::string response;
            if (!attemptOk(id, args, response)) return response;
            rate = mixer.sampleRate();
            if (kind != 1) {
                if (kind == 2) mixer.pause();
                else {
                    mixer.stop();
                    link.setPlaying(false);
                }
                events.push_back(stateJson());
                events.push_back(clockJson());
                return ok(id, "null");
            }
        }
        if (!ensureOutput(rate, events)) {
            std::lock_guard<std::mutex> lock(mu);
            events.push_back(stateJson());
            return fail(id, "DEVICE_UNAVAILABLE");
        }
        std::lock_guard<std::mutex> lock(mu);
        mixer.play();
        link.setPlaying(true);
        events.push_back(stateJson());
        events.push_back(clockJson());
        return ok(id, "null");
    }

    std::string seek(int64_t id, const Json& args, std::vector<std::string>& events) {
        std::lock_guard<std::mutex> lock(mu);
        std::string response;
        if (!attemptOk(id, args, response)) return response;
        if (!args.find("sec")) return fail(id, "INVALID_REQUEST");
        mixer.seek(args.num("sec", 0));
        link.beginGeneration(mixer.masterFrame());
        events.push_back(stateJson());
        events.push_back(clockJson());
        return ok(id, std::string("{\"positionSec\":") + std::to_string(positionSec()) + "}");
    }

    std::string setMix(int64_t id, const Json& args, std::vector<std::string>& events) {
        std::lock_guard<std::mutex> lock(mu);
        std::string response;
        if (!attemptOk(id, args, response)) return response;
        const Json* mix = args.find("mix");
        if (mix == nullptr) return fail(id, "INVALID_REQUEST");
        TrackGain vocal;
        TrackGain instrumental;
        TrackGain original;
        if (!gainField(*mix, "vocal", vocal) || !gainField(*mix, "instrumental", instrumental) || !gainField(*mix, "original", original)) {
            return fail(id, "INVALID_REQUEST");
        }
        mixer.setGain(Role::Vocal, vocal);
        mixer.setGain(Role::Instrumental, instrumental);
        mixer.setGain(Role::Original, original);
        mixer.setGain(Role::Harmony, instrumental);
        events.push_back(stateJson());
        return ok(id, "null");
    }

    std::string flag(int64_t id, const Json& args, std::vector<std::string>& events, int kind) {
        std::lock_guard<std::mutex> lock(mu);
        if (!loaded) return fail(id, "NOT_LOADED");
        if (kind == 1) {
            karaoke = args.boolean("on", false);
            mixer.setKaraoke(karaoke);
            link.setKaraoke(karaoke);
        } else if (kind == 2) {
            harmony = args.boolean("on", false);
            mixer.setHarmony(harmony);
        } else {
            loopOne = args.boolean("on", false);
            mixer.setLoopOne(loopOne);
        }
        events.push_back(stateJson());
        return ok(id, "null");
    }

    std::string setMaster(int64_t id, const Json& args, std::vector<std::string>& events) {
        std::lock_guard<std::mutex> lock(mu);
        if (!loaded) return fail(id, "NOT_LOADED");
        const double volume = args.num("volume", -1);
        if (!(volume >= 0 && volume <= 1)) return fail(id, "INVALID_REQUEST");
        mixer.setMaster(static_cast<float>(volume), args.boolean("muted", false));
        events.push_back(stateJson());
        return ok(id, "null");
    }

    std::string listDevices(int64_t id, std::vector<std::string>& events) {
        const std::vector<DeviceInfo> devices = output.enumerate();
        std::string value = "[";
        std::string event = "{\"event\":\"devices\",\"devices\":[";
        std::string defaultId = "null";
        for (size_t i = 0; i < devices.size(); ++i) {
            const std::string item = std::string("{\"id\":\"") + jsonEscape(devices[i].id) + "\",\"name\":\"" + jsonEscape(devices[i].name)
                + "\",\"isDefault\":" + (devices[i].isDefault ? "true" : "false") + "}";
            if (i != 0) {
                value += ",";
                event += ",";
            }
            value += item;
            event += item;
            if (devices[i].isDefault) defaultId = "\"" + jsonEscape(devices[i].id) + "\"";
        }
        value += "]";
        event += "],\"defaultId\":" + defaultId + "}";
        events.push_back(event);
        return ok(id, value);
    }

    std::string setDevice(int64_t id, const Json& args, std::vector<std::string>& events) {
        bool active = false;
        {
            std::lock_guard<std::mutex> lock(mu);
            if (args.isNull("id")) followDefault = true;
            else if (args.find("id") && args.find("id")->type == Json::Type::String) {
                followDefault = false;
                deviceId = args.str("id");
            } else return fail(id, "INVALID_REQUEST");
            active = loaded;
            events.push_back(stateJson());
        }
        if (!software && active && !reopen("set-device")) return fail(id, "DEVICE_UNAVAILABLE");
        return ok(id, "null");
    }

    std::string snapshot(int64_t id) {
        std::lock_guard<std::mutex> lock(mu);
        if (!loaded) return ok(id, "null");
        std::string state = stateJson();
        const auto event = state.find("\"event\":\"state\",");
        if (event != std::string::npos) state.erase(event, std::strlen("\"event\":\"state\","));
        std::string clock = clockJson();
        const auto clockEvent = clock.find("\"event\":\"clock\",");
        if (clockEvent != std::string::npos) clock.erase(clockEvent, std::strlen("\"event\":\"clock\","));
        return ok(id, std::string("{\"state\":") + state + ",\"clock\":" + clock + "}");
    }
};

Engine::Engine(Handlers handlers, bool softwareClock) : impl_(new Impl(std::move(handlers), softwareClock)) {}

Engine::~Engine() {
    shutdown();
    delete impl_;
    impl_ = nullptr;
}

std::string Engine::handleLine(const std::string& line) {
    if (impl_ == nullptr) return {};
    return impl_->handle(line);
}

void Engine::shutdown() {
    if (impl_ != nullptr) impl_->shutdown();
}

bool Engine::reopenOutput(const std::string& method) {
    return impl_ != nullptr && impl_->reopen(method);
}

SwitchStats Engine::lastSwitch() const {
    return impl_ == nullptr ? SwitchStats{} : impl_->stats;
}

}
