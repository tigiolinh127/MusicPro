function(msp_configure target)
  target_include_directories(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  target_compile_features(${target} PRIVATE cxx_std_20)
  target_link_libraries(${target} PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_audio_basics
    juce::juce_audio_formats
    juce::juce_audio_devices
    juce::juce_dsp
  )
  target_compile_definitions(${target} PRIVATE
    JUCE_WASAPI=1
    JUCE_WASAPI_EXCLUSIVE=0
    JUCE_DIRECTSOUND=0
    JUCE_ASIO=0
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_FLAC=0
    JUCE_USE_OGGVORBIS=0
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  if(MSVC)
    target_compile_options(${target} PRIVATE /W3 /EHsc /utf-8)
  endif()
  set_target_properties(${target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}"
  )
endfunction()

set(MSP_SOURCES
  src/Automation.cpp
  src/Recording.cpp
  src/Effects.cpp
  src/Mixer.cpp
  src/Fft.cpp
  src/Pitch.cpp
  src/PitchShift.cpp
  src/Scale.cpp
  src/NoteSegments.cpp
  src/PitchCorrect.cpp
  src/VocalQuality.cpp
  src/RealtimeDsp.cpp
  src/LivePitch.cpp
  src/LiveCorrection.cpp
  src/ProcessMemory.cpp
  src/Timeline.cpp
  src/VocalComp.cpp
  src/OnsetDetection.cpp
  src/Timing.cpp
  src/BreathSilence.cpp
  src/VocalPresets.cpp
  src/WavIO.cpp
  src/LatencyCalibration.cpp
  src/ClipStretch.cpp
  src/Crossfade.cpp
  src/SpectrumAnalyzer.cpp
  src/Loudness.cpp
  src/Project.cpp
  src/Routing.cpp
  src/Session.cpp
)

add_executable(MusicStudioEngine
  src/main.cpp
  src/Engine.cpp
  ${MSP_SOURCES}
)
msp_configure(MusicStudioEngine)

add_executable(audio_engine_tests
  tests/test_main.cpp
  tests/AllocationCounter.cpp
  ${MSP_SOURCES}
)
msp_configure(audio_engine_tests)

enable_testing()
add_test(NAME audio_engine_tests COMMAND audio_engine_tests)
