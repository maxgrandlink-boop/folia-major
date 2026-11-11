# native/ok-engine/CMakeLists.txt
# ok-engine：静态 CRT、NOMINMAX，照 native/folia-mnn。核心库不碰声卡，测试在 Linux 和 Windows 上都能链。
cmake_minimum_required(VERSION 3.24)
project(ok_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(okengine_core STATIC
    src/wav.cpp
    src/mixer.cpp
    src/json.cpp
    src/transcode.cpp
    src/shm.cpp
    src/device.cpp
    src/engine.cpp)
target_include_directories(okengine_core PUBLIC src "${CMAKE_CURRENT_SOURCE_DIR}/../okLiveShm" "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
if(MSVC)
    set_property(TARGET okengine_core PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
    target_compile_definitions(okengine_core PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
else()
    target_link_libraries(okengine_core PUBLIC pthread dl m)
endif()

add_executable(ok-engine src/main.cpp)
target_link_libraries(ok-engine PRIVATE okengine_core)
if(MSVC)
    set_property(TARGET ok-engine PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
    target_compile_definitions(ok-engine PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

add_executable(ok-engine-tests test/seek_sync_test.cpp)
target_link_libraries(ok-engine-tests PRIVATE okengine_core)
if(MSVC)
    set_property(TARGET ok-engine-tests PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
    target_compile_definitions(ok-engine-tests PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

enable_testing()
add_test(NAME seek_sync COMMAND ok-engine-tests)
