#include "selftest.h"

#include "device.h"
#include "engine.h"
#include "json.h"
#include "mixer.h"
#include "wav.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#else
#include <fstream>
#endif

namespace {

struct Tracks {
    std::string vocal;
    std::string instrumental;
    std::string original;
    std::string harmony;
};

std::string lower(std::string text) {
    for (char& c : text) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return text;
}

bool hasToken(const std::string& name, const char* token) {
    return name.find(token) != std::string::npos;
}

bool audioFile(const std::filesystem::path& path) {
    const std::string ext = lower(path.extension().string());
    return ext == ".wav" || ext == ".mp3" || ext == ".flac" || ext == ".m4a" || ext == ".ogg" || ext == ".aac" || ext == ".wma" || ext == ".opus" || ext == ".webm" || ext == ".m4p";
}

void classify(const std::filesystem::path& path, Tracks& tracks) {
    const std::string name = lower(path.filename().string());
    std::string* slot = nullptr;
    if (hasToken(name, "和声") || hasToken(name, "harmony")) slot = &tracks.harmony;
    else if (hasToken(name, "伴奏") || hasToken(name, "backing") || hasToken(name, "instrumental")) slot = &tracks.instrumental;
    else if (hasToken(name, "原声") || hasToken(name, "原唱") || hasToken(name, "original")) slot = &tracks.original;
    else if ((hasToken(name, "人声") || hasToken(name, "vocal")) && !hasToken(name, "original")) slot = &tracks.vocal;
    if (slot != nullptr && slot->empty()) *slot = path.string();
}

Tracks tracksIn(const std::filesystem::path& dir) {
    Tracks tracks;
    std::error_code ec;
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
        if (entry.is_regular_file() && audioFile(entry.path())) files.push_back(entry.path());
    }
    std::sort(files.begin(), files.end());
    for (const auto& file : files) classify(file, tracks);
    return tracks;
}

bool usable(const Tracks& tracks) { return !tracks.vocal.empty() || !tracks.instrumental.empty(); }

Tracks findWork(const std::filesystem::path& root) {
    if (std::filesystem::is_regular_file(root)) return {};
    Tracks here = tracksIn(root);
    if (usable(here)) return here;
    std::error_code ec;
    std::vector<std::filesystem::path> dirs;
    for (const auto& entry : std::filesystem::directory_iterator(root, ec)) {
        if (entry.is_directory()) dirs.push_back(entry.path());
    }
    std::sort(dirs.begin(), dirs.end());
    for (const auto& dir : dirs) {
        Tracks tracks = tracksIn(dir);
        if (usable(tracks)) return tracks;
        for (const auto& child : std::filesystem::directory_iterator(dir, ec)) {
            if (!child.is_directory()) continue;
            tracks = tracksIn(child.path());
            if (usable(tracks)) return tracks;
        }
    }
    return {};
}

void writeTone(const std::filesystem::path& path, uint32_t rate, int64_t frames, int role) {
    std::ofstream out(path, std::ios::binary);
    const uint32_t dataBytes = static_cast<uint32_t>(frames * 4);
    const uint32_t riff = 36u + dataBytes;
    const uint16_t channels = 2;
    const uint16_t bits = 16;
    const uint16_t block = 4;
    const uint32_t byteRate = rate * block;
    const uint32_t fmt = 16;
    const uint16_t format = 1;
    char header[44] = {};
    std::memcpy(header, "RIFF", 4);
    std::memcpy(header + 4, &riff, 4);
    std::memcpy(header + 8, "WAVE", 4);
    std::memcpy(header + 12, "fmt ", 4);
    std::memcpy(header + 16, &fmt, 4);
    std::memcpy(header + 20, &format, 2);
    std::memcpy(header + 22, &channels, 2);
    std::memcpy(header + 24, &rate, 4);
    std::memcpy(header + 28, &byteRate, 4);
    std::memcpy(header + 32, &block, 2);
    std::memcpy(header + 34, &bits, 2);
    std::memcpy(header + 36, "data", 4);
    std::memcpy(header + 40, &dataBytes, 4);
    out.write(header, 44);
    std::vector<int16_t> samples(4096 * 2);
    int64_t done = 0;
    while (done < frames) {
        const int64_t count = std::min<int64_t>(4096, frames - done);
        for (int64_t i = 0; i < count; ++i) {
            const uint32_t n = static_cast<uint32_t>(done + i) * 17u + static_cast<uint32_t>(role) * 97u;
            samples[static_cast<size_t>(i) * 2] = static_cast<int16_t>((n * 13u) & 0x7fff);
            samples[static_cast<size_t>(i) * 2 + 1] = static_cast<int16_t>((n * 29u) & 0x7fff);
        }
        out.write(reinterpret_cast<const char*>(samples.data()), static_cast<std::streamsize>(count * 4));
        done += count;
    }
}

struct Argv {
    std::string mode;
    std::string root;
    Tracks tracks;
    int watchSec = 0;
};

Argv parse(int argc, char** argv) {
    Argv out;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&]() { return i + 1 < argc ? argv[++i] : ""; };
        if (arg == "--self-test") out.mode = next();
        else if (arg == "--root") out.root = next();
        else if (arg == "--vocal") out.tracks.vocal = next();
        else if (arg == "--instrumental") out.tracks.instrumental = next();
        else if (arg == "--original") out.tracks.original = next();
        else if (arg == "--harmony") out.tracks.harmony = next();
        else if (arg == "--watch") out.watchSec = std::atoi(next());
    }
    if (out.root.empty()) {
#ifdef _WIN32
        out.root = "D:\\okchang-test";
#else
        out.root = "/tmp/okchang-test";
#endif
    }
    if (!usable(out.tracks) && std::filesystem::is_directory(out.root)) out.tracks = findWork(out.root);
    return out;
}

bool openTracks(const Tracks& tracks, okengine::WavMap maps[3], okengine::MixLoad& load, std::string& error) {
    const std::string* paths[3] = {&tracks.vocal, &tracks.instrumental, &tracks.original};
    for (int i = 0; i < 3; ++i) {
        if (paths[i]->empty()) continue;
        if (!maps[i].open(*paths[i], error)) return false;
        load.tracks[static_cast<size_t>(i)] = maps[i].view();
    }
    load.gains[0] = {1.f, false};
    load.gains[1] = {0.5f, false};
    load.gains[2] = {0.25f, false};
    load.master = 1.f;
    return true;
}

void memoryOf(uint64_t& current, uint64_t& peak, uint64_t& privateBytes) {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS_EX counters{};
    counters.cb = sizeof(counters);
    if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters))) {
        current = counters.WorkingSetSize;
        peak = counters.PeakWorkingSetSize;
        privateBytes = counters.PrivateUsage;
    }
#else
    std::ifstream status("/proc/self/status");
    std::string line;
    while (std::getline(status, line)) {
        if (line.compare(0, 6, "VmRSS:") == 0) current = std::strtoull(line.c_str() + 6, nullptr, 10) * 1024ull;
        if (line.compare(0, 6, "VmHWM:") == 0) peak = std::strtoull(line.c_str() + 6, nullptr, 10) * 1024ull;
    }
    privateBytes = current;
#endif
}

int seekOn(okengine::Mixer& mixer, const okengine::MixLoad& load) {
    mixer.play();
    const int fade = static_cast<int>(std::llround(0.010 * mixer.sampleRate())) + 2;
    std::vector<float> scratch(static_cast<size_t>(fade) * 2);
    mixer.render(scratch.data(), fade);
    uint32_t rng = 0x4F4B4348u;
    int64_t deviation = 0;
    int checked = 0;
    const double span = std::max(0.0, mixer.durationFrames() / static_cast<double>(mixer.sampleRate()) - 1.0);
    for (int n = 0; n < 100; ++n) {
        rng = rng * 1664525u + 1013904223u;
        const double seconds = n == 0 ? 0 : (static_cast<double>(rng) / 4294967296.0) * span;
        const int64_t target = okengine::frameForSeconds(seconds, mixer.sampleRate(), mixer.durationFrames());
        mixer.seek(seconds);
        int64_t expect = -1;
        for (int i = 0; i < static_cast<int>(mixer.sampleRate()) && checked < (n + 1) * 32; ++i) {
            float out[2] = {};
            mixer.render(out, 1);
            const okengine::MixRead read = mixer.lastRead();
            if (expect < 0) {
                if (!(mixer.landingFrame() == target && read.mixed && read.master == target)) continue;
                expect = target;
            }
            if (read.master != expect) deviation = std::max(deviation, static_cast<int64_t>(std::llabs(read.master - expect)));
            for (int role = 0; role < 3; ++role) {
                const auto sample = okengine::sampleAtMaster(load.tracks[static_cast<size_t>(role)], expect, 0, mixer.sampleRate(), mixer.durationFrames());
                if (sample.source != read.sourceFrame[static_cast<size_t>(role)]) deviation = std::max<int64_t>(deviation, 1);
            }
            if (mixer.outputEnv() >= 0.999f) ++checked;
            ++expect;
            if (checked >= (n + 1) * 32) break;
        }
    }
    std::cout << "{\"kind\":\"seek\",\"seeks\":100,\"maxDeviationFrames\":" << deviation << ",\"checkedFrames\":" << checked
              << ",\"durationSec\":" << (mixer.durationFrames() / static_cast<double>(mixer.sampleRate()))
              << ",\"sampleRate\":" << mixer.sampleRate() << "}\n";
    return deviation == 0 && checked == 3200 ? 0 : 1;
}

}

int runSelfTest(int argc, char** argv) {
    const Argv args = parse(argc, argv);
    const bool generated = !usable(args.tracks);
    std::filesystem::path temp;
    Tracks tracks = args.tracks;
    if (generated) {
        temp = std::filesystem::temp_directory_path() / "ok-engine-selftest";
        std::filesystem::create_directories(temp);
        if (args.mode == "memory" || args.mode == "seek") {
            writeTone(temp / "vocal.wav", 48000, 4 * 60 * 48000, 0);
            writeTone(temp / "inst.wav", 44100, 5 * 60 * 44100, 1);
            writeTone(temp / "orig.wav", 44100, (11 * 60 * 44100) / 2, 2);
        } else {
            writeTone(temp / "vocal.wav", 48000, 48000, 0);
            writeTone(temp / "inst.wav", 48000, 48000, 1);
            writeTone(temp / "orig.wav", 48000, 48000, 2);
        }
        tracks.vocal = (temp / "vocal.wav").string();
        tracks.instrumental = (temp / "inst.wav").string();
        tracks.original = (temp / "orig.wav").string();
    }
    okengine::WavMap maps[3];
    okengine::MixLoad load;
    std::string error;
    if (!openTracks(tracks, maps, load, error)) {
        std::cout << "{\"kind\":\"" << args.mode << "\",\"ok\":false,\"detail\":\"" << error << "\"}\n";
        return 1;
    }
    okengine::Mixer mixer;
    okengine::MixInfo info;
    if (mixer.load(load, info) != okengine::MixError::Ok) {
        std::cout << "{\"kind\":\"" << args.mode << "\",\"ok\":false,\"detail\":\"no-tracks\"}\n";
        return 1;
    }
    int code = 0;
    if (args.mode == "seek") code = seekOn(mixer, load);
    else if (args.mode == "memory") {
        mixer.play();
        const int frames = static_cast<int>(std::min<int64_t>(mixer.sampleRate() * 5, mixer.durationFrames()));
        std::vector<float> block(static_cast<size_t>(mixer.sampleRate() / 10) * 2);
        int done = 0;
        uint64_t current = 0;
        uint64_t peak = 0;
        uint64_t priv = 0;
        while (done < frames) {
            const int n = std::min(static_cast<int>(mixer.sampleRate() / 10), frames - done);
            mixer.render(block.data(), n);
            done += n;
            uint64_t now = 0;
            uint64_t top = 0;
            uint64_t privateNow = 0;
            memoryOf(now, top, privateNow);
            current = std::max(current, now);
            peak = std::max(peak, top);
            priv = std::max(priv, privateNow);
        }
        std::cout << "{\"kind\":\"memory\",\"generated\":" << (generated ? "true" : "false")
                  << ",\"root\":\"" << args.root << "\",\"playedFrames\":" << done
                  << ",\"workingSetBytes\":" << current << ",\"peakWorkingSetBytes\":" << peak
                  << ",\"privateBytes\":" << priv << ",\"sampleRate\":" << mixer.sampleRate() << "}\n";
    } else if (args.mode == "device") {
        okengine::AudioOutput probe;
        const auto devices = probe.enumerate();
        if (devices.empty()) {
            std::cout << "{\"kind\":\"device\",\"ran\":false,\"reason\":\"no-endpoint\",\"endpoints\":0,\"watchSec\":" << args.watchSec << "}\n";
        } else {
            okengine::SwitchStats stats;
            okengine::Engine engine({[](const std::string&) {}}, false);
            const std::string line = std::string("{\"id\":1,\"cmd\":\"load\",\"args\":{\"attempt\":1,\"workId\":\"accept\",\"tracks\":{\"vocal\":\"")
                + okengine::jsonEscape(tracks.vocal) + "\",\"instrumental\":\"" + okengine::jsonEscape(tracks.instrumental)
                + "\",\"original\":\"" + okengine::jsonEscape(tracks.original) + "\"},\"mix\":{\"vocal\":{\"gain\":80,\"muted\":false},\"instrumental\":{\"gain\":80,\"muted\":false},\"original\":{\"gain\":0,\"muted\":false}},\"karaoke\":false,\"harmony\":false,\"master\":{\"volume\":1,\"muted\":false},\"startSec\":0,\"autoplay\":true,\"loopOne\":false}}";
            const std::string response = engine.handleLine(line);
            const bool loaded = response.find("\"ok\":true") != std::string::npos;
            if (loaded) std::this_thread::sleep_for(std::chrono::milliseconds(300));
            const bool reopened = loaded && engine.reopenOutput("reopen");
            stats = engine.lastSwitch();
            if (args.watchSec > 0) {
                std::cerr << "[ok-engine] watching " << args.watchSec << " s for a default-device change\n";
                std::this_thread::sleep_for(std::chrono::seconds(args.watchSec));
                const okengine::SwitchStats watched = engine.lastSwitch();
                if (watched.method == "default-device") stats = watched;
            }
            engine.shutdown();
            const double deviationMs = info.sampleRate == 0 ? 0 : stats.deviationFrames * 1000.0 / static_cast<double>(info.sampleRate);
            std::cout << "{\"kind\":\"device\",\"ran\":" << (stats.ran ? "true" : "false")
                      << ",\"reopened\":" << (reopened ? "true" : "false")
                      << ",\"endpoints\":" << devices.size()
                      << ",\"recoveryMs\":" << stats.recoveryMs
                      << ",\"deviationFrames\":" << stats.deviationFrames
                      << ",\"deviationMs\":" << deviationMs
                      << ",\"method\":\"" << stats.method << "\""
                      << ",\"load\":" << (response.empty() ? "\"\"" : response)
                      << ",\"watchSec\":" << args.watchSec << "}\n";
            if (stats.ran && (stats.recoveryMs >= 1000.0 || deviationMs >= 20.0)) code = 1;
        }
    } else {
        std::cerr << "[ok-engine] self-test mode is seek, memory, or device\n";
        code = 2;
    }
    for (auto& map : maps) map.close();
    if (!temp.empty()) std::filesystem::remove_all(temp);
    return code;
}
