cmake_minimum_required(VERSION 3.24)
project(MusicStudioPro VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)
# JUCE 8 is dual-licensed AGPLv3 or commercial. This POC pins the maintained
# security tag and does not add a paid JUCE license. See docs/architecture.md.
FetchContent_Declare(
  juce
  URL https://github.com/juce-framework/JUCE/archive/refs/tags/8.0.17-security.tar.gz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(juce)

add_subdirectory(native/audio-engine)
