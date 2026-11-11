#include "json.h"

#include <cctype>
#include <cmath>
#include <cstdlib>

namespace okengine {

const Json* Json::find(const std::string& key) const {
    for (const auto& field : o) {
        if (field.first == key) return &field.second;
    }
    return nullptr;
}

bool Json::has(const std::string& key) const { return find(key) != nullptr; }

std::string Json::str(const std::string& key, const std::string& fallback) const {
    const Json* value = find(key);
    return value != nullptr && value->type == Type::String ? value->s : fallback;
}

double Json::num(const std::string& key, double fallback) const {
    const Json* value = find(key);
    return value != nullptr && value->type == Type::Number ? value->n : fallback;
}

int64_t Json::integer(const std::string& key, int64_t fallback) const {
    const Json* value = find(key);
    if (value == nullptr || value->type != Type::Number) return fallback;
    return value->integral ? value->i : static_cast<int64_t>(value->n);
}

bool Json::boolean(const std::string& key, bool fallback) const {
    const Json* value = find(key);
    return value != nullptr && value->type == Type::Bool ? value->b : fallback;
}

bool Json::isNull(const std::string& key) const {
    const Json* value = find(key);
    return value != nullptr && value->type == Type::Null;
}

namespace {

struct Parser {
    const std::string& in;
    size_t at = 0;

    void skip() {
        while (at < in.size() && std::isspace(static_cast<unsigned char>(in[at]))) ++at;
    }

    bool eat(char c) {
        skip();
        if (at < in.size() && in[at] == c) {
            ++at;
            return true;
        }
        return false;
    }

    bool literal(const char* word) {
        skip();
        const size_t n = std::char_traits<char>::length(word);
        if (in.compare(at, n, word) != 0) return false;
        at += n;
        return true;
    }

    bool parse(Json& out) {
        skip();
        if (at >= in.size()) return false;
        const char c = in[at];
        if (c == 'n') return literal("null") ? (out = Json{}, true) : false;
        if (c == 't') {
            if (!literal("true")) return false;
            out.type = Json::Type::Bool;
            out.b = true;
            return true;
        }
        if (c == 'f') {
            if (!literal("false")) return false;
            out.type = Json::Type::Bool;
            out.b = false;
            return true;
        }
        if (c == '"') return parseString(out.s) && (out.type = Json::Type::String, true);
        if (c == '[') return parseArray(out);
        if (c == '{') return parseObject(out);
        if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return parseNumber(out);
        return false;
    }

    bool parseString(std::string& out) {
        skip();
        if (!eat('"')) return false;
        out.clear();
        while (at < in.size()) {
            const char c = in[at++];
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (at >= in.size()) return false;
            const char e = in[at++];
            if (e == 'u') {
                if (at + 4 > in.size()) return false;
                int code = 0;
                for (int i = 0; i < 4; ++i) {
                    const char h = in[at++];
                    code <<= 4;
                    if (h >= '0' && h <= '9') code += h - '0';
                    else if (h >= 'a' && h <= 'f') code += h - 'a' + 10;
                    else if (h >= 'A' && h <= 'F') code += h - 'A' + 10;
                    else return false;
                }
                if (code < 0x80) out.push_back(static_cast<char>(code));
                else if (code < 0x800) {
                    out.push_back(static_cast<char>(0xC0 | (code >> 6)));
                    out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                } else {
                    out.push_back(static_cast<char>(0xE0 | (code >> 12)));
                    out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
                    out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                }
                continue;
            }
            if (e == '"' || e == '\\' || e == '/') out.push_back(e);
            else if (e == 'b') out.push_back('\b');
            else if (e == 'f') out.push_back('\f');
            else if (e == 'n') out.push_back('\n');
            else if (e == 'r') out.push_back('\r');
            else if (e == 't') out.push_back('\t');
            else return false;
        }
        return false;
    }

    bool parseNumber(Json& out) {
        skip();
        const size_t start = at;
        if (eat('-')) {}
        if (at >= in.size() || !std::isdigit(static_cast<unsigned char>(in[at]))) return false;
        while (at < in.size() && std::isdigit(static_cast<unsigned char>(in[at]))) ++at;
        const bool dotted = at < in.size() && in[at] == '.';
        if (dotted) {
            ++at;
            if (at >= in.size() || !std::isdigit(static_cast<unsigned char>(in[at]))) return false;
            while (at < in.size() && std::isdigit(static_cast<unsigned char>(in[at]))) ++at;
        }
        if (at < in.size() && (in[at] == 'e' || in[at] == 'E')) {
            ++at;
            if (at < in.size() && (in[at] == '+' || in[at] == '-')) ++at;
            if (at >= in.size() || !std::isdigit(static_cast<unsigned char>(in[at]))) return false;
            while (at < in.size() && std::isdigit(static_cast<unsigned char>(in[at]))) ++at;
        }
        const std::string token = in.substr(start, at - start);
        out.type = Json::Type::Number;
        out.n = std::strtod(token.c_str(), nullptr);
        out.integral = token.find_first_of(".eE") == std::string::npos;
        if (out.integral) out.i = std::strtoll(token.c_str(), nullptr, 10);
        return true;
    }

    bool parseArray(Json& out) {
        if (!eat('[')) return false;
        out.type = Json::Type::Array;
        skip();
        if (eat(']')) return true;
        for (;;) {
            Json item;
            if (!parse(item)) return false;
            out.a.push_back(std::move(item));
            skip();
            if (eat(']')) return true;
            if (!eat(',')) return false;
        }
    }

    bool parseObject(Json& out) {
        if (!eat('{')) return false;
        out.type = Json::Type::Object;
        skip();
        if (eat('}')) return true;
        for (;;) {
            std::string key;
            if (!parseString(key)) return false;
            if (!eat(':')) return false;
            Json item;
            if (!parse(item)) return false;
            out.o.emplace_back(std::move(key), std::move(item));
            skip();
            if (eat('}')) return true;
            if (!eat(',')) return false;
        }
    }
};

}

bool parseJson(const std::string& text, Json& out) {
    Parser parser{text, 0};
    if (!parser.parse(out)) return false;
    parser.skip();
    return parser.at == text.size();
}

std::string jsonEscape(const std::string& text) {
    std::string out;
    out.reserve(text.size() + 8);
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(static_cast<char>(c));
        } else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (c < 0x20) {
            const char hex[] = "0123456789abcdef";
            out += "\\u00";
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0xF]);
        } else out.push_back(static_cast<char>(c));
    }
    return out;
}

}
