#include "transcode.h"

#include "wav.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace okengine {

namespace {

uint64_t hashText(const std::string& text) {
    uint64_t hash = 1469598103934665603ull;
    for (unsigned char c : text) {
        hash ^= c;
        hash *= 1099511628211ull;
    }
    return hash;
}

std::string runCapture(const std::string& exe, const std::vector<std::string>& args, int& code) {
#ifdef _WIN32
    std::wstring cmd = L"\"";
    const int exeCount = MultiByteToWideChar(CP_UTF8, 0, exe.c_str(), -1, nullptr, 0);
    std::wstring wide(static_cast<size_t>(exeCount), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, exe.c_str(), -1, wide.data(), exeCount);
    if (!wide.empty() && wide.back() == L'\0') wide.pop_back();
    cmd += wide + L"\"";
    for (const std::string& arg : args) {
        const int n = MultiByteToWideChar(CP_UTF8, 0, arg.c_str(), -1, nullptr, 0);
        std::wstring warg(static_cast<size_t>(n), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, arg.c_str(), -1, warg.data(), n);
        if (!warg.empty() && warg.back() == L'\0') warg.pop_back();
        cmd += L" \"" + warg + L"\"";
    }
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE read = nullptr;
    HANDLE write = nullptr;
    if (!CreatePipe(&read, &write, &sa, 0)) {
        code = -1;
        return {};
    }
    SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = write;
    si.hStdError = write;
    si.hStdInput = nullptr;
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> mutableCmd(cmd.begin(), cmd.end());
    mutableCmd.push_back(L'\0');
    if (!CreateProcessW(nullptr, mutableCmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        CloseHandle(read);
        CloseHandle(write);
        code = -1;
        return {};
    }
    CloseHandle(write);
    std::string output;
    char buf[1024];
    DWORD got = 0;
    while (ReadFile(read, buf, sizeof(buf), &got, nullptr) && got > 0) output.append(buf, buf + got);
    WaitForSingleObject(pi.hProcess, 120000);
    DWORD status = 1;
    GetExitCodeProcess(pi.hProcess, &status);
    code = static_cast<int>(status);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(read);
    return output;
#else
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        code = -1;
        return {};
    }
    const pid_t pid = fork();
    if (pid < 0) {
        code = -1;
        return {};
    }
    if (pid == 0) {
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[0]);
        close(pipefd[1]);
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(exe.c_str()));
        for (const std::string& arg : args) argv.push_back(const_cast<char*>(arg.c_str()));
        argv.push_back(nullptr);
        execv(exe.c_str(), argv.data());
        _exit(127);
    }
    close(pipefd[1]);
    std::string output;
    char buf[1024];
    ssize_t got = 0;
    while ((got = ::read(pipefd[0], buf, sizeof(buf))) > 0) output.append(buf, buf + got);
    close(pipefd[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    return output;
#endif
}

uint32_t probeRate(const std::string& input, const std::string& ffmpeg) {
    int code = 0;
    const std::string text = runCapture(ffmpeg, {"-hide_banner", "-i", input}, code);
    const auto hz = text.find(" Hz");
    if (hz == std::string::npos) return 0;
    size_t end = hz;
    size_t start = end;
    while (start > 0 && std::isdigit(static_cast<unsigned char>(text[start - 1]))) --start;
    if (start == end) return 0;
    return static_cast<uint32_t>(std::strtoul(text.c_str() + start, nullptr, 10));
}

}

uint32_t probeSampleRate(const std::string& input, const std::string& ffmpeg) { return probeRate(input, ffmpeg); }

bool readableWav(const std::string& utf8Path) {
    WavMap map;
    std::string error;
    return map.open(utf8Path, error);
}

bool transcodeToWav(const std::string& input, const std::string& ffmpeg, uint32_t sampleRate, const std::string& cacheDir, std::string& output, std::string& error) {
    if (ffmpeg.empty() || sampleRate == 0) {
        error = "no-ffmpeg";
        return false;
    }
    std::error_code ec;
    const auto stamp = std::filesystem::last_write_time(input, ec);
    const uintmax_t size = std::filesystem::file_size(input, ec);
    std::ostringstream key;
    key << input << '|' << size << '|' << stamp.time_since_epoch().count() << '|' << sampleRate;
    const uint64_t hash = hashText(key.str());
    std::ostringstream name;
    name << std::hex << hash << ".wav";
    const std::filesystem::path dir(cacheDir);
    std::filesystem::create_directories(dir, ec);
    const std::filesystem::path dest = dir / name.str();
    output = dest.string();
    if (readableWav(output)) {
        pruneCache(cacheDir, 2ull << 30);
        return true;
    }
    const std::filesystem::path temp = dir / (name.str() + ".part");
    int code = 0;
    runCapture(ffmpeg, {"-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ac", "2", "-ar", std::to_string(sampleRate), "-c:a", "pcm_s16le", temp.string()}, code);
    if (code != 0 || !readableWav(temp.string())) {
        std::filesystem::remove(temp, ec);
        error = "ffmpeg";
        return false;
    }
    std::filesystem::rename(temp, dest, ec);
    if (ec) {
        error = "rename";
        return false;
    }
    output = dest.string();
    pruneCache(cacheDir, 2ull << 30);
    return true;
}

void pruneCache(const std::string& cacheDir, uint64_t maxBytes) {
    std::error_code ec;
    const std::filesystem::path dir(cacheDir);
    if (!std::filesystem::is_directory(dir, ec)) return;
    struct Item { std::filesystem::path path; uint64_t bytes; std::filesystem::file_time_type when; };
    std::vector<Item> items;
    uint64_t total = 0;
    for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file()) continue;
        Item item;
        item.path = entry.path();
        item.bytes = entry.file_size();
        item.when = entry.last_write_time();
        total += item.bytes;
        items.push_back(item);
    }
    std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.when < b.when; });
    for (const Item& item : items) {
        if (total <= maxBytes) break;
        std::filesystem::remove(item.path, ec);
        if (!ec && total >= item.bytes) total -= item.bytes;
    }
}

}
