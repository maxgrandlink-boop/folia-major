#include "engine.h"
#include "selftest.h"

#include <cstdlib>
#include <iostream>
#include <string>

// stdin 上每行一条 JSON 命令，stdout 回一行结果或事件。stdin 读到 EOF 就退出。

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--self-test") return runSelfTest(argc, argv);
    }
    const bool software = std::getenv("OK_ENGINE_SOFTWARE") != nullptr;
    okengine::Engine engine({[](const std::string& line) {
        std::cout << line << "\n" << std::flush;
    }}, software);
    std::ios::sync_with_stdio(false);
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        const std::string response = engine.handleLine(line);
        if (!response.empty()) std::cout << response << "\n" << std::flush;
    }
    engine.shutdown();
    return 0;
}
