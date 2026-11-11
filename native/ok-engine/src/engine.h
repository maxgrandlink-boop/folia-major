#pragma once

#include "mixer.h"

#include <functional>
#include <string>

namespace okengine {

struct SwitchStats {
    double recoveryMs = -1;
    int64_t deviationFrames = 0;
    bool ran = false;
    std::string method;
};

class Engine {
public:
    struct Handlers {
        std::function<void(const std::string& line)> emit;
    };

    Engine(Handlers handlers, bool softwareClock);
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    std::string handleLine(const std::string& line);
    void shutdown();
    bool reopenOutput(const std::string& method);
    SwitchStats lastSwitch() const;

private:
    struct Impl;
    Impl* impl_;
};

}
