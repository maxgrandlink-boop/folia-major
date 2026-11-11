#pragma once

#include <cstdint>
#include <string>

namespace okengine {

bool readableWav(const std::string& utf8Path);
uint32_t probeSampleRate(const std::string& input, const std::string& ffmpeg);
bool transcodeToWav(const std::string& input, const std::string& ffmpeg, uint32_t sampleRate, const std::string& cacheDir, std::string& output, std::string& error);
void pruneCache(const std::string& cacheDir, uint64_t maxBytes);

}
