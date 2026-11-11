#include <iostream>
#include <string>

// 控制面占位：stdin 读到 EOF 就退出。命令在后面的提交里接上。

int main() {
    std::ios::sync_with_stdio(false);
    std::string line;
    while (std::getline(std::cin, line)) {}
    return 0;
}
