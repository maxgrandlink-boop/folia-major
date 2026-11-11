#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace okengine {

struct Json {
    enum class Type { Null, Bool, Number, String, Array, Object };
    Type type = Type::Null;
    bool b = false;
    double n = 0;
    bool integral = false;
    int64_t i = 0;
    std::string s;
    std::vector<Json> a;
    std::vector<std::pair<std::string, Json>> o;

    const Json* find(const std::string& key) const;
    bool has(const std::string& key) const;
    std::string str(const std::string& key, const std::string& fallback = {}) const;
    double num(const std::string& key, double fallback = 0) const;
    int64_t integer(const std::string& key, int64_t fallback = 0) const;
    bool boolean(const std::string& key, bool fallback = false) const;
    bool isNull(const std::string& key) const;
};

bool parseJson(const std::string& text, Json& out);
std::string jsonEscape(const std::string& text);

}
