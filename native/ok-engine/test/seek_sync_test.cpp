#include "mixer.h"
#include "wav.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

int gFailed = 0;

void check(bool ok, const char* expr, const char* file, int line) {
    if (ok) return;
    if (gFailed < 20) std::cerr << "FAIL " << file << ":" << line << " " << expr << "\n";
    ++gFailed;
}

#define CHECK(expr) check(static_cast<bool>(expr), #expr, __FILE__, __LINE__)

int16_t tone(int64_t frame, int channel, int role) {
    uint32_t n = static_cast<uint32_t>(frame) * (channel ? 29u : 13u) + static_cast<uint32_t>(role) * 10007u;
    n = n * 1103515245u + 12345u;
    return static_cast<int16_t>(n >> 16);
}

void writeWav(const std::filesystem::path& path, uint32_t rate, int64_t frames, int role) {
    std::ofstream out(path, std::ios::binary);
    const uint32_t dataBytes = static_cast<uint32_t>(frames * 4);
    const uint32_t riffSize = 36u + dataBytes;
    const uint16_t channels = 2;
    const uint16_t bits = 16;
    const uint16_t block = 4;
    const uint32_t byteRate = rate * block;
    char header[44] = {};
    std::memcpy(header, "RIFF", 4);
    std::memcpy(header + 4, &riffSize, 4);
    std::memcpy(header + 8, "WAVE", 4);
    std::memcpy(header + 12, "fmt ", 4);
    const uint32_t fmtSize = 16;
    std::memcpy(header + 16, &fmtSize, 4);
    const uint16_t format = 1;
    std::memcpy(header + 20, &format, 2);
    std::memcpy(header + 22, &channels, 2);
    std::memcpy(header + 24, &rate, 4);
    std::memcpy(header + 28, &byteRate, 4);
    std::memcpy(header + 32, &block, 2);
    std::memcpy(header + 34, &bits, 2);
    std::memcpy(header + 36, "data", 4);
    std::memcpy(header + 40, &dataBytes, 4);
    out.write(header, 44);
    std::vector<int16_t> blockSamples(4096 * 2);
    int64_t done = 0;
    while (done < frames) {
        const int64_t count = std::min<int64_t>(4096, frames - done);
        for (int64_t i = 0; i < count; ++i) {
            blockSamples[static_cast<size_t>(i) * 2] = tone(done + i, 0, role);
            blockSamples[static_cast<size_t>(i) * 2 + 1] = tone(done + i, 1, role);
        }
        out.write(reinterpret_cast<const char*>(blockSamples.data()), static_cast<std::streamsize>(count * 4));
        done += count;
    }
}

okengine::MixLoad loadOf(const okengine::PcmView& vocal, const okengine::PcmView& instrumental, const okengine::PcmView& original) {
    okengine::MixLoad load;
    load.tracks[0] = vocal;
    load.tracks[1] = instrumental;
    load.tracks[2] = original;
    load.gains[0] = {1.f, false};
    load.gains[1] = {0.5f, false};
    load.gains[2] = {0.25f, false};
    load.gains[3] = {1.f, false};
    load.master = 1.f;
    return load;
}

void expectMix(const okengine::Mixer& mixer, const okengine::MixLoad& load, int64_t master, float left, float right) {
    float expectL = 0.f;
    float expectR = 0.f;
    const float gains[4] = {1.f, 0.5f, 0.25f, 0.f};
    for (int i = 0; i < 3; ++i) {
        const auto sampleL = okengine::sampleAtMaster(load.tracks[static_cast<size_t>(i)], master, 0, mixer.sampleRate(), mixer.durationFrames());
        const auto sampleR = okengine::sampleAtMaster(load.tracks[static_cast<size_t>(i)], master, 1, mixer.sampleRate(), mixer.durationFrames());
        expectL += sampleL.value * gains[i];
        expectR += sampleR.value * gains[i];
    }
    CHECK(std::fabs(left - expectL) < 1e-5f);
    CHECK(std::fabs(right - expectR) < 1e-5f);
}

int64_t gDeviation = 0;

void noteDeviation(int64_t frames) {
    if (frames < 0) frames = -frames;
    if (frames > gDeviation) gDeviation = frames;
}

int checkSeek(okengine::Mixer& mixer, const okengine::MixLoad& load, double seconds, int sampleFrames) {
    const int64_t target = okengine::frameForSeconds(seconds, mixer.sampleRate(), mixer.durationFrames());
    mixer.seek(seconds);
    if (mixer.status() != std::string("playing")) {
        CHECK(mixer.masterFrame() == target);
        return 0;
    }
    int64_t expect = -1;
    int checked = 0;
    const int guard = static_cast<int>(mixer.sampleRate());
    for (int n = 0; n < guard && checked < sampleFrames; ++n) {
        float out[2] = {};
        mixer.render(out, 1);
        const okengine::MixRead read = mixer.lastRead();
        if (expect < 0) {
            if (!(mixer.landingFrame() == target && read.mixed && read.master == target)) continue;
            expect = target;
        }
        if (!read.mixed) {
            noteDeviation(std::llabs(read.master - expect));
            CHECK(false);
            return checked;
        }
        if (read.master != expect) noteDeviation(std::llabs(read.master - expect));
        CHECK(read.master == expect);
        for (int i = 0; i < 3; ++i) {
            const auto sample = okengine::sampleAtMaster(load.tracks[static_cast<size_t>(i)], expect, 0, mixer.sampleRate(), mixer.durationFrames());
            if (read.sourceFrame[static_cast<size_t>(i)] != sample.source) noteDeviation(1);
            CHECK(read.sourceFrame[static_cast<size_t>(i)] == sample.source);
        }
        if (mixer.outputEnv() >= 0.999f) {
            expectMix(mixer, load, expect, out[0], out[1]);
            ++checked;
        }
        ++expect;
    }
    CHECK(expect >= 0);
    CHECK(checked == sampleFrames);
    return checked;
}

void settle(okengine::Mixer& mixer) {
    const int frames = static_cast<int>(std::llround(0.010 * static_cast<double>(mixer.sampleRate()))) + 2;
    std::vector<float> junk(static_cast<size_t>(frames) * 2);
    mixer.render(junk.data(), frames);
}

}

int main() {
    const auto dir = std::filesystem::temp_directory_path() / "ok-engine-seek";
    std::filesystem::create_directories(dir);
    const auto vocalPath = dir / "vocal.wav";
    const auto instPath = dir / "inst.wav";
    const auto origPath = dir / "orig.wav";
    writeWav(vocalPath, 48000, 480, 0);
    writeWav(instPath, 44100, 882, 1);
    writeWav(origPath, 44100, 1764, 2);
    okengine::WavMap vocal;
    okengine::WavMap inst;
    okengine::WavMap orig;
    std::string error;
    CHECK(vocal.open(vocalPath.string(), error));
    CHECK(inst.open(instPath.string(), error));
    CHECK(orig.open(origPath.string(), error));
    okengine::Mixer mixer;
    okengine::MixInfo info;
    auto load = loadOf(vocal.view(), inst.view(), orig.view());
    CHECK(mixer.load(load, info) == okengine::MixError::Ok);
    CHECK(info.sampleRate == 48000);
    CHECK(info.durationFrames == 960);
    CHECK(info.tracks[0].padded);
    CHECK(!info.tracks[0].trimmed);
    CHECK(!info.tracks[1].padded);
    CHECK(!info.tracks[1].trimmed);
    CHECK(info.tracks[2].trimmed);
    mixer.play();
    settle(mixer);
    CHECK(std::string(mixer.status()) == "playing");
    CHECK(mixer.outputEnv() >= 0.999f);
    const int shortChecked = checkSeek(mixer, load, 0.002, 32);
    CHECK(shortChecked == 32);

    vocal.close();
    inst.close();
    orig.close();
    writeWav(vocalPath, 44100, 8000, 0);
    writeWav(instPath, 44100, 16000, 1);
    writeWav(origPath, 44100, 24000, 2);
    CHECK(vocal.open(vocalPath.string(), error));
    CHECK(inst.open(instPath.string(), error));
    CHECK(orig.open(origPath.string(), error));
    load = loadOf(vocal.view(), inst.view(), orig.view());
    CHECK(mixer.load(load, info) == okengine::MixError::Ok);
    CHECK(info.durationFrames == 16000);
    CHECK(info.tracks[0].padded);
    CHECK(info.tracks[2].trimmed);
    mixer.play();
    settle(mixer);
    checkSeek(mixer, load, 50.0 / 44100.0, 16);
    checkSeek(mixer, load, 9000.0 / 44100.0, 16);

    load.harmony = true;
    load.tracks[3] = orig.view();
    CHECK(mixer.load(load, info) == okengine::MixError::Ok);
    mixer.setHarmony(true);
    mixer.play();
    settle(mixer);
    const int64_t harmonyAt = okengine::frameForSeconds(10.0 / 44100.0, mixer.sampleRate(), mixer.durationFrames());
    mixer.seek(10.0 / 44100.0);
    float heard[2] = {};
    for (int i = 0; i < 44100 && !(mixer.landingFrame() == harmonyAt && mixer.outputEnv() == 1.f); ++i) mixer.render(heard, 1);
    mixer.render(heard, 1);
    const int64_t at = mixer.lastRead().master;
    float withHarmony = 0.f;
    {
        const auto v = okengine::sampleAtMaster(load.tracks[0], at, 0, mixer.sampleRate(), mixer.durationFrames());
        const auto b = okengine::sampleAtMaster(load.tracks[1], at, 0, mixer.sampleRate(), mixer.durationFrames());
        const auto o = okengine::sampleAtMaster(load.tracks[2], at, 0, mixer.sampleRate(), mixer.durationFrames());
        const auto h = okengine::sampleAtMaster(load.tracks[3], at, 0, mixer.sampleRate(), mixer.durationFrames());
        withHarmony = v.value + b.value * 0.5f + o.value * 0.25f + h.value * 0.5f;
    }
    CHECK(std::fabs(heard[0] - withHarmony) < 1e-4f);
    mixer.setHarmony(false);
    mixer.render(heard, 1);
    const auto v = okengine::sampleAtMaster(load.tracks[0], mixer.lastRead().master, 0, mixer.sampleRate(), mixer.durationFrames());
    const auto b = okengine::sampleAtMaster(load.tracks[1], mixer.lastRead().master, 0, mixer.sampleRate(), mixer.durationFrames());
    const auto o = okengine::sampleAtMaster(load.tracks[2], mixer.lastRead().master, 0, mixer.sampleRate(), mixer.durationFrames());
    CHECK(std::fabs(heard[0] - (v.value + b.value * 0.5f + o.value * 0.25f)) < 1e-4f);

    load.harmony = false;
    load.loopOne = true;
    load.tracks[3] = {};
    CHECK(mixer.load(load, info) == okengine::MixError::Ok);
    mixer.play();
    settle(mixer);
    std::vector<float> loopBuf(static_cast<size_t>(info.durationFrames) * 4 + 64);
    mixer.render(loopBuf.data(), info.durationFrames + 8);
    if (gFailed != 0) return 1;
    CHECK(mixer.takeLooped());
    CHECK(mixer.masterFrame() < info.durationFrames);

    load.loopOne = false;
    CHECK(mixer.load(load, info) == okengine::MixError::Ok);
    mixer.play();
    mixer.render(loopBuf.data(), static_cast<int>(info.durationFrames + 8));
    CHECK(std::string(mixer.status()) == "ended");
    CHECK(mixer.takeEnded());
    vocal.close();
    inst.close();
    orig.close();

    const int64_t vocalFrames = 4 * 60 * 48000;
    const int64_t instFrames = 5 * 60 * 44100;
    const int64_t origFrames = (11 * 60 * 44100) / 2;
    std::cout << "[ok-engine-test] writing 5-minute tracks\n" << std::flush;
    writeWav(vocalPath, 48000, vocalFrames, 0);
    writeWav(instPath, 44100, instFrames, 1);
    writeWav(origPath, 44100, origFrames, 2);
    CHECK(vocal.open(vocalPath.string(), error));
    CHECK(inst.open(instPath.string(), error));
    CHECK(orig.open(origPath.string(), error));
    load = loadOf(vocal.view(), inst.view(), orig.view());
    CHECK(mixer.load(load, info) == okengine::MixError::Ok);
    CHECK(info.sampleRate == 48000);
    CHECK(info.durationFrames == 5 * 60 * 48000);
    CHECK(info.tracks[0].padded);
    CHECK(info.tracks[2].trimmed);
    mixer.play();
    settle(mixer);
    uint32_t rng = 0x4F4B4348u;
    int checked = 0;
    for (int i = 0; i < 100; ++i) {
        double seconds = 0;
        if (i == 0) seconds = 0;
        else if (i == 1) seconds = 1.0;
        else if (i == 2) seconds = 150.0;
        else if (i == 3) seconds = 270.0;
        else if (i == 4) seconds = info.durationSec - 1.0;
        else {
            rng = rng * 1664525u + 1013904223u;
            const double span = info.durationSec - 1.0;
            seconds = (static_cast<double>(rng) / 4294967296.0) * span;
        }
        checked += checkSeek(mixer, load, seconds, 32);
    }
    std::cout << "{\"seeks\":100,\"maxDeviationFrames\":" << gDeviation
              << ",\"checkedFrames\":" << checked
              << ",\"durationSec\":" << info.durationSec
              << ",\"sampleRate\":" << info.sampleRate
              << ",\"rates\":[48000,44100,44100]"
              << ",\"paddedVocal\":true,\"trimmedOriginal\":true}\n";
    CHECK(checked == 100 * 32);
    CHECK(gDeviation == 0);
    vocal.close();
    inst.close();
    orig.close();
    std::filesystem::remove_all(dir);
    if (gFailed != 0) {
        std::cerr << gFailed << " checks failed\n";
        return 1;
    }
    std::cout << "[ok-engine-test] ok\n";
    return 0;
}
