#include "wav.h"

#include <cstring>
#include <utility>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace okengine {

namespace {

uint16_t readU16(const uint8_t* p) {
    uint16_t value = 0;
    std::memcpy(&value, p, 2);
    return value;
}

uint32_t readU32(const uint8_t* p) {
    uint32_t value = 0;
    std::memcpy(&value, p, 4);
    return value;
}

bool isPcmGuid(const uint8_t* guid, uint16_t format) {
    const uint8_t tail[14] = {0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
    return readU16(guid) == format && std::memcmp(guid + 2, tail, 14) == 0;
}

}

bool parseWav(const uint8_t* bytes, size_t size, PcmView& out, std::string& error) {
    out = {};
    if (bytes == nullptr || size < 12) {
        error = "short";
        return false;
    }
    if (std::memcmp(bytes, "RIFF", 4) != 0 && std::memcmp(bytes, "RF64", 4) != 0) {
        error = "not-riff";
        return false;
    }
    if (std::memcmp(bytes + 8, "WAVE", 4) != 0) {
        error = "not-wave";
        return false;
    }
    const uint8_t* fmt = nullptr;
    uint32_t fmtSize = 0;
    const uint8_t* data = nullptr;
    uint32_t dataSize = 0;
    size_t offset = 12;
    while (offset + 8 <= size) {
        const uint32_t chunk = readU32(bytes + offset + 4);
        const size_t body = offset + 8;
        if (body + chunk > size) break;
        if (std::memcmp(bytes + offset, "fmt ", 4) == 0) {
            fmt = bytes + body;
            fmtSize = chunk;
        } else if (std::memcmp(bytes + offset, "data", 4) == 0) {
            data = bytes + body;
            dataSize = chunk;
        }
        offset = body + chunk + (chunk & 1u);
    }
    if (fmt == nullptr || fmtSize < 16 || data == nullptr) {
        error = "missing-chunk";
        return false;
    }
    uint16_t format = readU16(fmt);
    const uint16_t channels = readU16(fmt + 2);
    const uint32_t rate = readU32(fmt + 4);
    const uint16_t block = readU16(fmt + 12);
    uint16_t bits = readU16(fmt + 14);
    if (format == 0xFFFE) {
        if (fmtSize < 40) {
            error = "extensible";
            return false;
        }
        const uint8_t* guid = fmt + 24;
        if (isPcmGuid(guid, 1)) format = 1;
        else if (isPcmGuid(guid, 3)) format = 3;
        else {
            error = "subtype";
            return false;
        }
    }
    if ((format != 1 && format != 3) || rate == 0 || (channels != 1 && channels != 2)) {
        error = "format";
        return false;
    }
    if (format == 3 && bits != 32) {
        error = "float-width";
        return false;
    }
    if (format == 1 && bits != 16 && bits != 24 && bits != 32) {
        error = "pcm-width";
        return false;
    }
    if (block == 0 || block < channels * (bits / 8u)) {
        error = "align";
        return false;
    }
    const uint32_t frames = dataSize / block;
    if (frames == 0) {
        error = "empty";
        return false;
    }
    out.data = data;
    out.frames = frames;
    out.rate = rate;
    out.channels = channels;
    out.bits = bits;
    out.format = format;
    out.blockAlign = block;
    out.present = true;
    return true;
}

WavMap::WavMap(WavMap&& other) noexcept { *this = std::move(other); }

WavMap& WavMap::operator=(WavMap&& other) noexcept {
    if (this != &other) {
        close();
        view_ = other.view_;
        mapping_ = other.mapping_;
        size_ = other.size_;
#ifdef _WIN32
        file_ = other.file_;
        map_ = other.map_;
        other.file_ = nullptr;
        other.map_ = nullptr;
#else
        fd_ = other.fd_;
        other.fd_ = -1;
#endif
        other.view_ = {};
        other.mapping_ = nullptr;
        other.size_ = 0;
    }
    return *this;
}

WavMap::~WavMap() { close(); }

void WavMap::close() {
#ifdef _WIN32
    if (mapping_ != nullptr) UnmapViewOfFile(mapping_);
    if (map_ != nullptr) CloseHandle(map_);
    if (file_ != nullptr) CloseHandle(file_);
    file_ = nullptr;
    map_ = nullptr;
#else
    if (mapping_ != nullptr && size_ > 0) munmap(mapping_, size_);
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
#endif
    mapping_ = nullptr;
    size_ = 0;
    view_ = {};
}

bool WavMap::open(const std::string& utf8Path, std::string& error) {
    close();
#ifdef _WIN32
    const int wideCount = MultiByteToWideChar(CP_UTF8, 0, utf8Path.c_str(), -1, nullptr, 0);
    if (wideCount <= 0) {
        error = "path";
        return false;
    }
    std::wstring wide(static_cast<size_t>(wideCount), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8Path.c_str(), -1, wide.data(), wideCount);
    file_ = CreateFileW(wide.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) {
        file_ = nullptr;
        error = "open";
        return false;
    }
    LARGE_INTEGER length{};
    if (!GetFileSizeEx(file_, &length) || length.QuadPart <= 0) {
        error = "size";
        close();
        return false;
    }
    size_ = static_cast<size_t>(length.QuadPart);
    map_ = CreateFileMappingW(file_, nullptr, PAGE_READONLY, 0, 0, nullptr);
    if (map_ == nullptr) {
        error = "map";
        close();
        return false;
    }
    mapping_ = MapViewOfFile(map_, FILE_MAP_READ, 0, 0, 0);
    if (mapping_ == nullptr) {
        error = "view";
        close();
        return false;
    }
#else
    fd_ = ::open(utf8Path.c_str(), O_RDONLY);
    if (fd_ < 0) {
        error = "open";
        return false;
    }
    struct stat st {};
    if (fstat(fd_, &st) != 0 || st.st_size <= 0) {
        error = "size";
        close();
        return false;
    }
    size_ = static_cast<size_t>(st.st_size);
    mapping_ = mmap(nullptr, size_, PROT_READ, MAP_PRIVATE, fd_, 0);
    if (mapping_ == MAP_FAILED) {
        mapping_ = nullptr;
        error = "map";
        close();
        return false;
    }
#endif
    if (!parseWav(static_cast<const uint8_t*>(mapping_), size_, view_, error)) {
        close();
        return false;
    }
    return true;
}

}
