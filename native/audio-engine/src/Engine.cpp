#include "msp/Engine.h"
#include "msp/ClipStretch.h"
#include "msp/Crossfade.h"
#include "msp/ProcessMemory.h"
#include "msp/WavIO.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <thread>
#include <utility>

namespace msp {
namespace {
juce::String modeName(TransportMode mode) {
    switch (mode) {
        case TransportMode::playing: return "playing";
        case TransportMode::paused: return "paused";
        case TransportMode::stopped: return "stopped";
    }
    return "stopped";
}

TransportMode modeFromInt(int value) {
    if (value == static_cast<int>(TransportMode::playing))
        return TransportMode::playing;
    if (value == static_cast<int>(TransportMode::paused))
        return TransportMode::paused;
    return TransportMode::stopped;
}

bool isNumber(const juce::var& value) {
    return value.isDouble() || value.isInt() || value.isInt64();
}

void raisePeak(std::atomic<float>& slot, float value) {
    float current = slot.load(std::memory_order_relaxed);
    while (value > current && !slot.compare_exchange_weak(current, value, std::memory_order_relaxed)) {
    }
}

void addAtomicFloat(std::atomic<float>& slot, float value) {
    float current = slot.load(std::memory_order_relaxed);
    while (!slot.compare_exchange_weak(current, current + value, std::memory_order_relaxed)) {
    }
}

juce::var stringArray(const juce::StringArray& values) {
    juce::Array<juce::var> out;
    for (const auto& value : values)
        out.add(value);
    return out;
}

juce::var numberArray(const juce::Array<double>& values) {
    juce::Array<juce::var> out;
    for (const auto value : values)
        out.add(value);
    return out;
}

juce::var intArray(const juce::Array<int>& values) {
    juce::Array<juce::var> out;
    for (const auto value : values)
        out.add(value);
    return out;
}

juce::var effectsVar(const std::vector<ProjectEffect>& effects) {
    juce::Array<juce::var> list;
    for (const auto& effect : effects) {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", juce::String::fromUTF8(effect.id.c_str()));
        item->setProperty("type", effectTypeName(effect.type));
        item->setProperty("enabled", effect.enabled);
        auto* params = new juce::DynamicObject();
        const auto& spec = effectSpec(effect.type);
        for (int i = 0; i < spec.paramCount; ++i)
            params->setProperty(spec.params[i].name, static_cast<double>(effect.params[static_cast<size_t>(i)]));
        item->setProperty("params", juce::var(params));
        list.add(juce::var(item));
    }
    return list;
}

juce::var automationVar(const std::vector<AutomationLane>& lanes, double rate) {
    juce::Array<juce::var> list;
    for (const auto& lane : lanes) {
        auto* item = new juce::DynamicObject();
        item->setProperty("param", juce::String::fromUTF8(lane.param.c_str()));
        item->setProperty("enabled", lane.enabled);
        item->setProperty("active", automationActive(lane));
        juce::Array<juce::var> points;
        for (const auto& point : lane.points) {
            auto* pointObj = new juce::DynamicObject();
            pointObj->setProperty("time", static_cast<double>(point.time) / rate);
            pointObj->setProperty("timeSamples", static_cast<juce::int64>(point.time));
            pointObj->setProperty("value", point.value);
            pointObj->setProperty("interpolation", point.step ? "step" : "linear");
            points.add(juce::var(pointObj));
        }
        item->setProperty("points", points);
        list.add(juce::var(item));
    }
    return list;
}

// Reads {time (seconds), value, interpolation?}. `hasInterpolation` (optional) reports whether
// interpolation was given; otherwise a missing one means linear.
juce::String readPoint(const juce::var& item, double rate, AutomationPoint& point, bool* hasInterpolation = nullptr) {
    const auto time = item.getProperty("time", {});
    const auto value = item.getProperty("value", {});
    if (!item.isObject() || !isNumber(time) || !isNumber(value))
        return "An automation point needs a time in seconds and a numeric value.";
    const double seconds = static_cast<double>(time);
    if (!std::isfinite(seconds) || seconds < 0.0 || seconds > 24.0 * 3600.0)
        return "An automation point time must be between 0 and 24 hours.";
    point.time = std::llround(seconds * rate);
    point.value = static_cast<double>(value);
    const auto interpolation = item.getProperty("interpolation", {});
    if (hasInterpolation != nullptr)
        *hasInterpolation = !interpolation.isVoid();
    if (interpolation.isVoid()) {
        point.step = false;
    } else if (interpolation.toString() == "linear" || interpolation.toString() == "step") {
        point.step = interpolation.toString() == "step";
    } else {
        return "Automation interpolation must be \"linear\" or \"step\".";
    }
    return {};
}

juce::String sanitizeFileName(const std::string& name) {
    auto text = juce::File::createLegalFileName(juce::String::fromUTF8(name.c_str())).trim();
    return text.isEmpty() ? juce::String("Track") : text;
}

constexpr int kMaxInputBlock = 8192;
constexpr double kPitchMaxSeconds = 600.0;
constexpr int64_t kPitchMaxFrames = 200000;
constexpr int64_t kPitchShiftContext = 16384;   // source samples processed on each side of a clip

// Commands that leave a pitch preview playing. Everything else ends it first, so clip edits,
// undo, loading and device changes always see the clip's real audio.
bool keepsPitchPreview(const juce::String& op) {
    static const char* const ops[] = {
        "ping", "getState", "listDevices", "transport", "getMeters", "waveform", "setMaster", "setTrack",
        "setMonitor", "setInputGain", "setRecordingOffset", "getRecordingLatency", "resetRecordingOffset",
        "estimateRecordingLatency", "applyRecordingLatencyEstimate",
        "saveProject", "renderPlayback", "startCapture", "stopCapture",
        "analyzePitch", "cancelPitchAnalysis", "processPitch", "cancelPitchProcess", "previewPitch",
        "applyPitch", "setProcessedFolder", "getPitchMapping", "setPitchMapping", "setNoteTarget", "resetNoteTarget",
        "clearNoteTargets", "processAutoCorrection",
        // exportWav intentionally omitted: previews must end so export matches committed playback.
    };
    for (const auto* name : ops)
        if (op == name)
            return true;
    return false;
}

juce::String shiftLabel(int semitones, double cents) {
    auto text = (semitones >= 0 ? "+" : "") + juce::String(semitones) + " st";
    if (cents != 0.0)
        text << " " << (cents > 0.0 ? "+" : "") << juce::String(cents, cents == std::floor(cents) ? 0 : 1) << " c";
    return text;
}

// Optional vocal quality fields of processPitch and processAutoCorrection. Omitted fields keep the
// Phase 2.4.4 processing (formants follow the pitch, standard quality, no attack protection).
juce::String parseVocalQuality(const juce::var& options, VocalQuality& quality) {
    const auto preserveVar = options.getProperty("preserveFormants", {});
    const auto shiftVar = options.getProperty("formantShift", {});
    const auto qualityVar = options.getProperty("quality", {});
    const auto transientVar = options.getProperty("protectTransients", {});
    if ((!preserveVar.isVoid() && !preserveVar.isBool()) || (!transientVar.isVoid() && !transientVar.isBool()))
        return "preserveFormants and protectTransients must be true or false.";
    if (!shiftVar.isVoid() && !isNumber(shiftVar))
        return "formantShift must be a number of semitones between -12 and +12.";
    if (!qualityVar.isVoid() && (!qualityVar.isString() || (qualityVar.toString() != "standard" && qualityVar.toString() != "high")))
        return "quality must be \"standard\" or \"high\".";
    quality.preserveFormants = !preserveVar.isVoid() && static_cast<bool>(preserveVar);
    quality.formantShiftSemitones = shiftVar.isVoid() ? 0.0 : static_cast<double>(shiftVar);
    quality.high = !qualityVar.isVoid() && qualityVar.toString() == "high";
    quality.protectTransients = !transientVar.isVoid() && static_cast<bool>(transientVar);
    const auto error = checkVocalQuality(quality);
    return juce::String::fromUTF8(error.c_str());
}

juce::String vocalLabel(const VocalQuality& quality) {
    juce::String text;
    const double shift = quality.formantShiftSemitones;
    const auto shiftText = (shift > 0.0 ? "+" : "") + juce::String(shift, shift == std::floor(shift) ? 0 : 1) + " st";
    if (quality.preserveFormants)
        text << (shift == 0.0 ? ", formants kept" : ", formants " + shiftText);
    else if (shift != 0.0)
        text << ", formants follow pitch " << shiftText;
    if (quality.high)
        text << ", High quality";
    return text;
}

void setVocalQuality(juce::DynamicObject& object, const VocalQuality& quality) {
    object.setProperty("preserveFormants", quality.preserveFormants);
    object.setProperty("formantShift", quality.formantShiftSemitones);
    object.setProperty("quality", quality.high ? "high" : "standard");
    object.setProperty("protectTransients", quality.protectTransients);
}

// Median f0 of the voiced YIN frames (0 when fewer than three frames are voiced).
double medianPitch(const float* left, const float* right, int64_t frames, double rate,
                   const std::atomic<bool>* cancel, int& voicedFrames) {
    voicedFrames = 0;
    std::vector<float> mixed;
    if (right != nullptr) {
        mixed.resize(static_cast<size_t>(frames));
        for (int64_t i = 0; i < frames; ++i)
            mixed[static_cast<size_t>(i)] = 0.5f * (left[i] + right[i]);
    }
    const float* mono = right != nullptr ? mixed.data() : left;
    PitchParams params;
    params.minHz = 60.0;
    params.maxHz = std::min(2000.0, rate / 4.0);
    int window = 2048;
    while (window < 2 * (static_cast<int>(std::ceil(rate / params.minHz)) + 1))
        window *= 2;
    params.windowSize = window;
    params.hopSize = window / 4;
    const auto analysis = analyzePitch(mono, frames, rate, params, cancel);
    std::vector<double> voiced;
    for (const auto& frame : analysis.frames)
        if (frame.voiced)
            voiced.push_back(frame.frequency);
    voicedFrames = static_cast<int>(voiced.size());
    if (voiced.size() < 3)
        return 0.0;
    std::nth_element(voiced.begin(), voiced.begin() + static_cast<std::ptrdiff_t>(voiced.size() / 2), voiced.end());
    return voiced[voiced.size() / 2];
}

double rounded(double value, double step) {
    return std::round(value / step) * step;
}

juce::var pitchParamsVar(const PitchParams& params) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("minHz", params.minHz);
    obj->setProperty("maxHz", params.maxHz);
    obj->setProperty("windowSize", params.windowSize);
    obj->setProperty("hopSize", params.hopSize);
    obj->setProperty("confidenceThreshold", params.confidenceThreshold);
    obj->setProperty("silenceDb", params.silenceDb);
    return juce::var(obj);
}

juce::var mappingSettingsVar(const PitchMapping& mapping) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("enabled", mapping.enabled);
    obj->setProperty("root", pitchClassName(mapping.key.root));
    obj->setProperty("scale", scaleTypeName(mapping.key.scale));
    obj->setProperty("scaleLabel", scaleTypeLabel(mapping.key.scale));
    obj->setProperty("tieBreak", tieBreakName(mapping.settings.tieBreak));
    obj->setProperty("toleranceCents", mapping.settings.toleranceCents);
    juce::Array<juce::var> classes;
    for (const int pc : keyPitchClasses(mapping.key))
        classes.add(pc);
    obj->setProperty("pitchClasses", classes);
    return juce::var(obj);
}

juce::var noteTargetsVar(const std::vector<NoteTarget>& targets) {
    juce::Array<juce::var> list;
    for (const auto& target : targets) {
        auto* item = new juce::DynamicObject();
        item->setProperty("clipId", juce::String::fromUTF8(target.clipId.c_str()));
        item->setProperty("sourceFileId", juce::String::fromUTF8(target.sourceFileId.c_str()));
        item->setProperty("sourceStart", target.sourceStart);
        item->setProperty("sourceEnd", target.sourceEnd);
        item->setProperty("originalMidi", target.originalMidi);
        item->setProperty("targetMidi", target.targetMidi);
        list.add(juce::var(item));
    }
    return list;
}

// Frames go out as parallel arrays to keep long analyses compact. Unvoiced frames carry
// frequency 0, midi -1, note "" and cents 0.
juce::var pitchResultVar(const PitchAnalysis& analysis, int jobId, const juce::String& trackId, const juce::String& clipId,
                         double clipStart, double seconds, double elapsed) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("v", 1);
    obj->setProperty("event", "pitchResult");
    obj->setProperty("jobId", jobId);
    obj->setProperty("status", !analysis.error.empty() ? "error" : analysis.cancelled ? "cancelled" : "done");
    obj->setProperty("error", juce::String::fromUTF8(analysis.error.c_str()));
    obj->setProperty("trackId", trackId);
    obj->setProperty("clipId", clipId);
    obj->setProperty("sampleRate", analysis.sampleRate);
    obj->setProperty("clipStart", clipStart);
    obj->setProperty("duration", seconds);
    obj->setProperty("params", pitchParamsVar(analysis.params));
    obj->setProperty("hopSeconds", analysis.params.hopSize / analysis.sampleRate);
    obj->setProperty("windowSeconds", analysis.params.windowSize / analysis.sampleRate);
    obj->setProperty("elapsedSeconds", elapsed);
    juce::Array<juce::var> time, frequency, midi, note, cents, confidence, voiced;
    int voicedCount = 0;
    std::vector<double> voicedMidi;
    for (const auto& frame : analysis.frames) {
        time.add(rounded(frame.time, 1.0e-5));
        frequency.add(rounded(frame.frequency, 1.0e-3));
        midi.add(frame.midi);
        note.add(juce::String(noteName(frame.midi)));
        cents.add(rounded(frame.cents, 0.01));
        confidence.add(rounded(frame.confidence, 1.0e-4));
        voiced.add(frame.voiced);
        if (frame.voiced) {
            ++voicedCount;
            voicedMidi.push_back(midiFromFrequency(frame.frequency));
        }
    }
    auto* frames = new juce::DynamicObject();
    frames->setProperty("time", time);
    frames->setProperty("frequency", frequency);
    frames->setProperty("midi", midi);
    frames->setProperty("note", note);
    frames->setProperty("cents", cents);
    frames->setProperty("confidence", confidence);
    frames->setProperty("voiced", voiced);
    obj->setProperty("frames", juce::var(frames));
    juce::Array<juce::var> notes;
    for (const auto& item : analysis.notes) {
        auto* entry = new juce::DynamicObject();
        entry->setProperty("start", rounded(item.start, 1.0e-5));
        entry->setProperty("end", rounded(item.end, 1.0e-5));
        entry->setProperty("midi", item.midi);
        entry->setProperty("name", juce::String(item.name));
        entry->setProperty("frequency", rounded(item.frequency, 1.0e-3));
        entry->setProperty("cents", rounded(item.cents, 0.01));
        entry->setProperty("confidence", rounded(item.confidence, 1.0e-4));
        entry->setProperty("frames", item.frames);
        notes.add(juce::var(entry));
    }
    obj->setProperty("notes", notes);
    auto* summary = new juce::DynamicObject();
    summary->setProperty("frames", static_cast<int>(analysis.frames.size()));
    summary->setProperty("voicedFrames", voicedCount);
    summary->setProperty("voicedRatio", analysis.frames.empty() ? 0.0 : static_cast<double>(voicedCount) / static_cast<double>(analysis.frames.size()));
    if (!voicedMidi.empty()) {
        std::nth_element(voicedMidi.begin(), voicedMidi.begin() + static_cast<std::ptrdiff_t>(voicedMidi.size() / 2), voicedMidi.end());
        const double median = voicedMidi[voicedMidi.size() / 2];
        summary->setProperty("medianMidi", static_cast<int>(std::lround(median)));
        summary->setProperty("medianNote", juce::String(noteName(static_cast<int>(std::lround(median)))));
        summary->setProperty("medianFrequency", rounded(440.0 * std::pow(2.0, (median - 69.0) / 12.0), 1.0e-3));
    }
    obj->setProperty("summary", juce::var(summary));
    return juce::var(obj);
}

juce::var tailVar(const TailSettings& tail) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("enabled", tail.enabled);
    obj->setProperty("maxSeconds", tail.maxSeconds);
    obj->setProperty("thresholdDb", tail.thresholdDb);
    return juce::var(obj);
}

// Reads {enabled?, maxSeconds?, thresholdDb?} over `tail`. Returns an error message or "".
juce::String readTail(const juce::var& value, TailSettings& tail) {
    auto* obj = value.getDynamicObject();
    if (obj == nullptr)
        return "Effect tail settings must be an object with enabled, maxSeconds and thresholdDb.";
    if (obj->hasProperty("enabled")) {
        if (!obj->getProperty("enabled").isBool())
            return "Effect tail enabled must be true or false.";
        tail.enabled = static_cast<bool>(obj->getProperty("enabled"));
    }
    if (obj->hasProperty("maxSeconds")) {
        if (!isNumber(obj->getProperty("maxSeconds")))
            return "Maximum tail length must be a number of seconds.";
        tail.maxSeconds = static_cast<double>(obj->getProperty("maxSeconds"));
    }
    if (obj->hasProperty("thresholdDb")) {
        if (!isNumber(obj->getProperty("thresholdDb")))
            return "Tail silence threshold must be a number in dBFS.";
        tail.thresholdDb = static_cast<double>(obj->getProperty("thresholdDb"));
    }
    return juce::String::fromUTF8(checkTailSettings(tail).c_str());
}
} // namespace

Engine::Engine() {
    scratchL.assign(kMaxInputBlock, 0.0f);
    scratchR.assign(kMaxInputBlock, 0.0f);
    virtualL.assign(kMaxInputBlock, 0.0f);
    virtualR.assign(kMaxInputBlock, 0.0f);
    inputGainL.assign(kMaxInputBlock, 0.0f);
    inputGainR.assign(kMaxInputBlock, 0.0f);
    silentInput.assign(kMaxInputBlock, 0.0f);
    liveL.assign(kMaxInputBlock, 0.0f);
    liveR.assign(kMaxInputBlock, 0.0f);
    monitorRawL.assign(kMaxInputBlock, 0.0f);
    monitorRawR.assign(kMaxInputBlock, 0.0f);
    monitorMixL.assign(kMaxInputBlock, 0.0f);
    monitorMixR.assign(kMaxInputBlock, 0.0f);
    processedL.assign(kMaxRecordTracks, std::vector<float>(kMaxInputBlock, 0.0f));
    processedR.assign(kMaxRecordTracks, std::vector<float>(kMaxInputBlock, 0.0f));
    for (int i = 0; i < kMaxRecordTracks; ++i) {
        processedPtrL.push_back(processedL[static_cast<size_t>(i)].data());
        processedPtrR.push_back(processedR[static_cast<size_t>(i)].data());
    }
    recordFolder = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
                       .getChildFile("Music Studio Pro")
                       .getChildFile("Recordings");
    processedFolder = recordFolder.getParentDirectory().getChildFile("Processed");
    recordingLatencyPrefsFile = recordFolder.getParentDirectory().getChildFile("recording-latency.json");
    loadRecordingLatencyProfiles();
    if (spectrumAnalyzer.prepare(kSpectrumFftSize).empty())
        spectrumPrepared = true;
}

void Engine::resolveSpectrumTapLocked() {
    const int kind = spectrumKind.load(std::memory_order_relaxed);
    if (kind == static_cast<int>(SpectrumTapKind::none) || spectrumTarget.empty()) {
        spectrumIndex.store(0, std::memory_order_relaxed);
        return;
    }
    if (kind == static_cast<int>(SpectrumTapKind::master)) {
        spectrumIndex.store(0, std::memory_order_relaxed);
        return;
    }
    const auto* head = mixHead.load(std::memory_order_relaxed);
    if (head == nullptr) {
        spectrumIndex.store(-1, std::memory_order_relaxed);
        return;
    }
    const auto& ids = kind == static_cast<int>(SpectrumTapKind::track) ? head->plan.sourceIds : head->plan.busIds;
    int found = -1;
    for (size_t i = 0; i < ids.size(); ++i) {
        if (ids[i] == spectrumOwnerId) {
            found = static_cast<int>(i);
            break;
        }
    }
    spectrumIndex.store(found, std::memory_order_relaxed);
}

Engine::~Engine() {
    stopLoudnessAnalysis();
    stopPitchAnalysis();
    if (!shuttingDown.exchange(true)) {
        stopTimer();
        devices.removeAudioCallback(this);
        devices.closeAudioDevice();
    }
}

void Engine::writeJson(const juce::var& value) {
    const auto line = juce::JSON::toString(value, true);
    std::lock_guard<std::mutex> lock(outMutex);
    std::cout << line << '\n';
    std::cout.flush();
}

void Engine::succeed(const juce::String& id, const juce::var& result) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("v", 1);
    obj->setProperty("id", id);
    obj->setProperty("ok", true);
    obj->setProperty("result", result);
    writeJson(juce::var(obj));
}

void Engine::fail(const juce::String& id, const juce::String& message) {
    if (id.isEmpty()) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("v", 1);
        obj->setProperty("event", "error");
        obj->setProperty("message", message);
        writeJson(juce::var(obj));
        return;
    }
    auto* obj = new juce::DynamicObject();
    obj->setProperty("v", 1);
    obj->setProperty("id", id);
    obj->setProperty("ok", false);
    obj->setProperty("error", message);
    writeJson(juce::var(obj));
}

void Engine::holdRetired(RetiredAudio retiredBuffers) {
    for (auto& chunk : retiredBuffers.chunks)
        retired.push_back(std::move(chunk));
}

juce::String Engine::startRecording(const juce::var& options) {
    if (recorder != nullptr)
        return "Already recording.";
    if (!deviceOpen.load())
        return deviceError.isNotEmpty() ? deviceError : juce::String("Recording needs an open audio device.");
    const auto mode = modeFromInt(transport.load());
    if (mode == TransportMode::playing)
        return "Stop or pause playback before recording.";
    std::vector<int> armed;
    int channelsNeeded = 0;
    for (int i = 0; i < static_cast<int>(session.tracks.size()); ++i) {
        const auto& track = session.tracks[static_cast<size_t>(i)];
        if (!track.used || !track.armed)
            continue;
        armed.push_back(i);
        channelsNeeded = std::max(channelsNeeded, track.recordInput == RecordInput::first ? 1 : 2);
    }
    if (armed.empty())
        return "Arm at least one track before recording.";
    if (!virtualOn.load() && inputChannels.load() < channelsNeeded)
        return "Recording needs an open input device with " + juce::String(channelsNeeded)
            + (channelsNeeded == 1 ? " channel" : " channels")
            + ". Choose an input in the audio device settings, or use the test signal input.";
    int slots = kDefaultRecordSlots;
    int writerDelay = 0;
    if (options.hasProperty("queueSlots")) {
        const auto value = options.getProperty("queueSlots", {});
        if (!isNumber(value) || static_cast<int>(value) < 2 || static_cast<int>(value) > 65536)
            return "queueSlots must be between 2 and 65536.";
        slots = static_cast<int>(value);
    }
    if (options.hasProperty("writerDelayMs")) {
        const auto value = options.getProperty("writerDelayMs", {});
        if (!isNumber(value) || static_cast<int>(value) < 0 || static_cast<int>(value) > 10000)
            return "writerDelayMs must be between 0 and 10000.";
        writerDelay = static_cast<int>(value);
    }
    if (!recordFolder.createDirectory().wasOk())
        return "Could not create the recording folder " + recordFolder.getFullPathName() + ".";

    std::vector<TakeSpec> specs;
    auto taken = [&](const juce::File& file) {
        return file.exists() || file.getSiblingFile(file.getFileName() + ".part").exists();
    };
    for (const int index : armed) {
        const auto& track = session.tracks[static_cast<size_t>(index)];
        const auto base = sanitizeFileName(track.name.empty() ? track.id : track.name);
        int number = 1;
        for (;; ++number) {
            const auto dry = recordFolder.getChildFile(base + " take " + juce::String(number) + ".wav");
            const auto wet = recordFolder.getChildFile(base + " take " + juce::String(number) + " (processed).wav");
            if (!taken(dry) && !taken(wet))
                break;
        }
        auto add = [&](bool processed) {
            TakeSpec spec;
            spec.trackId = track.id;
            spec.key = recordInputKey(track.id);
            spec.processed = processed;
            spec.input = static_cast<int>(track.recordInput);
            spec.channels = processed || track.recordInput == RecordInput::stereo ? 2 : 1;
            const auto name = base + " take " + juce::String(number) + (processed ? " (processed).wav" : ".wav");
            spec.path = recordFolder.getChildFile(name).getFullPathName().toStdString();
            specs.push_back(spec);
        };
        if (track.recordMode != RecordMode::processed)
            add(false);
        if (track.recordMode != RecordMode::dry)
            add(true);
    }
    auto next = std::make_unique<TakeRecorder>();
    const auto error = next->begin(specs, session.playbackRate, slots, writerDelay);
    if (!error.empty())
        return juce::String::fromUTF8(error.c_str());
    recorder = std::move(next);

    // Starting from Stop: fresh effect processors, as when playback starts.
    const auto* head = mixHead.load(std::memory_order_relaxed);
    if (mode == TransportMode::stopped && head != nullptr && !head->plan.effects.empty()) {
        publishMix();
        waitForAudioSnapshot();
    }
    const int64_t start = std::max<int64_t>(0, position.load());
    recordStart.store(start);
    recordEnd.store(start + kMaxRecordFrames);
    recordCaptured.store(0);
    recordSkipped.store(0);
    recordStopAck.store(false);
    recordStopRequest.store(false);
    lastTake = juce::var();
    recordLive.store(recorder.get(), std::memory_order_release);
    Clock clock;
    clock.mode = TransportMode::playing;
    clock.position = start;
    session.clock = clock;
    position.store(start, std::memory_order_relaxed);
    transport.store(static_cast<int>(TransportMode::playing), std::memory_order_release);
    return {};
}

std::string Engine::currentLatencyProfileKey() const {
    return recordingLatencyProfileKey(outputDeviceName.toStdString(),
                                      inputDeviceName.toStdString(),
                                      sampleRate.load(),
                                      bufferSize.load());
}

void Engine::loadRecordingLatencyProfiles() {
    recordingOffsetProfiles.clear();
    if (!recordingLatencyPrefsFile.existsAsFile())
        return;
    const auto parsed = juce::JSON::parse(recordingLatencyPrefsFile);
    if (!parsed.isObject())
        return;
    const auto profiles = parsed.getProperty("profiles", {});
    if (auto* obj = profiles.getDynamicObject()) {
        for (const auto& prop : obj->getProperties()) {
            if (isNumber(prop.value))
                recordingOffsetProfiles[prop.name.toString().toStdString()] = static_cast<double>(prop.value);
        }
    }
}

void Engine::saveRecordingLatencyProfiles() const {
    auto* root = new juce::DynamicObject();
    auto* profiles = new juce::DynamicObject();
    for (const auto& entry : recordingOffsetProfiles)
        profiles->setProperty(juce::String::fromUTF8(entry.first.c_str()), entry.second);
    root->setProperty("v", 1);
    root->setProperty("profiles", juce::var(profiles));
    recordingLatencyPrefsFile.getParentDirectory().createDirectory();
    recordingLatencyPrefsFile.replaceWithText(juce::JSON::toString(juce::var(root), true));
}

void Engine::applyLatencyProfileForDevices() {
    const auto key = currentLatencyProfileKey();
    const auto found = recordingOffsetProfiles.find(key);
    recordingOffsetMs = found != recordingOffsetProfiles.end()
                            ? std::clamp(found->second, -kMaxRecordingOffsetMs, kMaxRecordingOffsetMs)
                            : 0.0;
}

juce::var Engine::recordingLatencyVar() const {
    auto* obj = new juce::DynamicObject();
    const double rate = static_cast<double>(std::max(1, sampleRate.load()));
    const int64_t offsetSamples = recordingOffsetSamples(recordingOffsetMs, rate, kMaxRecordingOffsetMs);
    obj->setProperty("offsetMs", recordingOffsetMs);
    obj->setProperty("offsetSamples", static_cast<juce::int64>(offsetSamples));
    obj->setProperty("maxOffsetMs", kMaxRecordingOffsetMs);
    obj->setProperty("profileKey", juce::String::fromUTF8(currentLatencyProfileKey().c_str()));
    obj->setProperty("outputDevice", outputDeviceName);
    obj->setProperty("inputDevice", inputDeviceName);
    obj->setProperty("sampleRate", sampleRate.load());
    obj->setProperty("bufferSize", bufferSize.load());
    obj->setProperty("reportedOutputLatencyMs", outputLatencySamples.load() * 1000.0 / rate);
    obj->setProperty("reportedOutputLatencySamples", outputLatencySamples.load());
    obj->setProperty("method", latencyEstimateMethod);
    obj->setProperty("signConvention",
                     "Positive offsetMs places new takes later on the timeline; negative places them earlier. "
                     "If vocals sit late vs backing, use a negative offset. Existing takes are never moved.");
    obj->setProperty("notes",
                     "Offset applies only to new take placement. It does not compensate Live Auto-Tune DSP latency "
                     "(already present in recorded samples) and does not equal reported output-device latency.");
    if (hasLatencyEstimate) {
        auto* last = new juce::DynamicObject();
        last->setProperty("delayMs", lastLatencyEstimate.delayMs);
        last->setProperty("delaySamples", static_cast<juce::int64>(lastLatencyEstimate.delaySamples));
        last->setProperty("confidence", lastLatencyEstimate.confidence);
        last->setProperty("peakCorrelation", lastLatencyEstimate.peakCorrelation);
        last->setProperty("reliable", lastLatencyEstimate.reliable);
        last->setProperty("message", juce::String::fromUTF8(lastLatencyEstimate.message.c_str()));
        obj->setProperty("lastEstimate", juce::var(last));
    } else {
        obj->setProperty("lastEstimate", juce::var());
    }
    return juce::var(obj);
}

juce::var Engine::finishRecording() {
    if (recorder == nullptr)
        return {};
    recordStopRequest.store(true, std::memory_order_release);
    bool acknowledged = !callbackAttached || !deviceOpen.load();
    const double started = juce::Time::getMillisecondCounterHiRes();
    while (!acknowledged && juce::Time::getMillisecondCounterHiRes() - started < 1000.0) {
        if (recordStopAck.load(std::memory_order_acquire))
            acknowledged = true;
        else
            juce::Thread::sleep(1);
    }
    if (!acknowledged) {
        // The callback stalled: detaching waits for any running callback, so none can still push.
        detachAudioCallback();
        if (deviceOpen.load()) {
            callbackAttached = true;
            devices.addAudioCallback(this);
        }
    }
    recordLive.store(nullptr, std::memory_order_release);
    const int64_t captureStart = recordStart.load();
    const double rate = static_cast<double>(std::max(1, sampleRate.load()));
    // Placement offset for NEW takes only (Phase 2.7.4). Positive ms → later on the timeline.
    const int64_t offsetSamples = recordingOffsetSamples(recordingOffsetMs, rate, kMaxRecordingOffsetMs);
    const int64_t start = std::max<int64_t>(0, captureStart + offsetSamples);
    auto results = recorder->finish();
    const auto dropped = recorder->queue().droppedFrames();
    const auto overflows = recorder->queue().overflows();
    const auto skipped = recordSkipped.load();
    recorder.reset();
    recordStopRequest.store(false);
    recordStopAck.store(false);

    juce::Array<juce::var> takes;
    juce::Array<juce::var> warnings;
    std::vector<std::string> placed;
    for (const auto& take : results) {
        const int index = session.indexOf(take.spec.trackId);
        const auto label = juce::String::fromUTF8(index >= 0 && !session.tracks[static_cast<size_t>(index)].name.empty()
                                                      ? session.tracks[static_cast<size_t>(index)].name.c_str()
                                                      : take.spec.trackId.c_str());
        auto* item = new juce::DynamicObject();
        item->setProperty("trackId", juce::String::fromUTF8(take.spec.trackId.c_str()));
        item->setProperty("path", juce::String::fromUTF8(take.spec.path.c_str()));
        item->setProperty("kind", take.spec.processed ? "processed" : "dry");
        item->setProperty("channels", take.spec.channels);
        item->setProperty("frames", static_cast<juce::int64>(take.frames));
        item->setProperty("seconds", static_cast<double>(take.frames) / rate);
        item->setProperty("gapFrames", static_cast<juce::int64>(take.gapFrames));
        item->setProperty("error", juce::String::fromUTF8(take.error.c_str()));
        bool onTimeline = false;
        std::string takeId;
        // Dry takes come first. Each recording becomes a take (WAV preserved). The first take on a
        // track is also placed on the comp; later takes stay in lanes until the user comps regions.
        if (take.error.empty() && take.frames > 0 && std::find(placed.begin(), placed.end(), take.spec.trackId) == placed.end()) {
            const int trackIndex = session.indexOf(take.spec.trackId);
            const bool seedComp = trackIndex >= 0
                && session.tracks[static_cast<size_t>(trackIndex)].takes.empty()
                && session.tracks[static_cast<size_t>(trackIndex)].clips.empty();
            if (seedComp) {
                std::string clipId;
                auto imported = session.importClip(take.spec.trackId, take.spec.path, start, std::llround(0.002 * rate), &clipId);
                if (imported.error.empty()) {
                    holdRetired(std::move(imported));
                    placed.push_back(take.spec.trackId);
                    item->setProperty("clipId", juce::String::fromUTF8(clipId.c_str()));
                    onTimeline = true;
                    // Register the primary/extra source created by importClip as take 1.
                    auto& track = session.tracks[static_cast<size_t>(session.indexOf(take.spec.trackId))];
                    msp::Take registered;
                    registered.id = session.freshTakeId();
                    registered.name = "Take 1";
                    registered.sourceFileId = track.clips.empty() ? session.primarySourceId(track) : track.clips.back().sourceFileId;
                    registered.timelineStart = start;
                    registered.duration = session.sourceLength(track, registered.sourceFileId);
                    const auto regError = session.registerTake(take.spec.trackId, registered);
                    if (regError.empty())
                        takeId = registered.id;
                    else
                        warnings.add("Track " + label + ": recorded audio was placed, but the take lane was not created: "
                                     + juce::String::fromUTF8(regError.c_str()));
                } else {
                    warnings.add("The take on track " + label + " was saved but could not be placed on the timeline: "
                                 + juce::String::fromUTF8(imported.error.c_str())
                                 + " It will still be kept as a take lane.");
                    auto asTake = session.importTake(take.spec.trackId, take.spec.path, start, &takeId);
                    if (asTake.error.empty()) {
                        holdRetired(std::move(asTake));
                        placed.push_back(take.spec.trackId);
                    } else {
                        warnings.add("The take on track " + label + " could not be added as a take lane: "
                                     + juce::String::fromUTF8(asTake.error.c_str()));
                    }
                }
            } else {
                auto imported = session.importTake(take.spec.trackId, take.spec.path, start, &takeId);
                if (imported.error.empty()) {
                    holdRetired(std::move(imported));
                    placed.push_back(take.spec.trackId);
                } else {
                    warnings.add("The take on track " + label + " was saved but could not be added as a take lane: "
                                 + juce::String::fromUTF8(imported.error.c_str()));
                }
            }
        }
        if (!takeId.empty())
            item->setProperty("takeId", juce::String::fromUTF8(takeId.c_str()));
        item->setProperty("placed", onTimeline);
        if (!take.error.empty())
            warnings.add("Track " + label + ": " + juce::String::fromUTF8(take.error.c_str()));
        else if (take.frames == 0)
            warnings.add("Nothing was recorded on track " + label + ".");
        takes.add(juce::var(item));
    }
    if (dropped > 0)
        warnings.add("The recording queue overflowed " + juce::String(overflows) + " time(s): "
                     + juce::String(dropped) + " frames could not be written in time. They were replaced with silence so the take stays in time.");
    if (skipped > 0)
        warnings.add(juce::String(skipped) + " frames arrived in audio blocks larger than "
                     + juce::String(kMaxInputBlock) + " samples and were recorded as silence.");
    publishMix();
    auto* result = new juce::DynamicObject();
    result->setProperty("startSeconds", static_cast<double>(start) / rate);
    result->setProperty("startSamples", static_cast<juce::int64>(start));
    result->setProperty("captureStartSamples", static_cast<juce::int64>(captureStart));
    result->setProperty("placementOffsetMs", recordingOffsetMs);
    result->setProperty("placementOffsetSamples", static_cast<juce::int64>(offsetSamples));
    result->setProperty("takes", takes);
    result->setProperty("droppedFrames", static_cast<juce::int64>(dropped));
    result->setProperty("overflowEvents", static_cast<juce::int64>(overflows));
    result->setProperty("warnings", warnings);
    lastTake = juce::var(result);
    return lastTake;
}

juce::String Engine::startPitchAnalysis(const juce::String& requestId, const juce::var& options) {
    if (pitchJob != nullptr && !pitchJob->finished.load())
        return pitchJob->processing ? "Pitch processing is running. Cancel it or wait for it to finish before analysing."
                                    : "A pitch analysis is already running. Cancel it or wait for it to finish.";
    if (pitchJob != nullptr) {
        if (pitchJob->thread.joinable())
            pitchJob->thread.join();
        pitchJob.reset();
    }
    const auto trackVar = options.getProperty("trackId", {});
    const auto clipVar = options.getProperty("clipId", {});
    if (!trackVar.isString() || !clipVar.isString())
        return "analyzePitch needs a string trackId and clipId.";

    PitchParams params;
    double window = params.windowSize;
    double hop = params.hopSize;
    double frameDelayMs = 0.0;   // test hook: slows the worker down so cancellation can be exercised
    const std::pair<const char*, double*> fields[] = {
        { "minHz", &params.minHz }, { "maxHz", &params.maxHz }, { "windowSize", &window }, { "hopSize", &hop },
        { "confidenceThreshold", &params.confidenceThreshold }, { "silenceDb", &params.silenceDb }, { "frameDelayMs", &frameDelayMs },
    };
    for (const auto& [name, target] : fields) {
        const auto value = options.getProperty(name, {});
        if (value.isVoid())
            continue;
        if (!isNumber(value))
            return juce::String(name) + " must be a number.";
        *target = static_cast<double>(value);
    }
    if (!(window >= 0.0 && window <= 1.0e6 && hop >= 0.0 && hop <= 1.0e6) || window != std::floor(window) || hop != std::floor(hop))
        return "windowSize and hopSize must be whole numbers of samples.";
    params.windowSize = static_cast<int>(window);
    params.hopSize = static_cast<int>(hop);
    if (!(frameDelayMs >= 0.0 && frameDelayMs <= 100.0))
        return "frameDelayMs must be between 0 and 100.";

    std::vector<float> mono;
    double rate = 0.0;
    Clip clip;
    const auto copyError = session.copyClipMono(trackVar.toString().toStdString(), clipVar.toString().toStdString(),
                                                kPitchMaxSeconds, mono, rate, clip);
    if (!copyError.empty())
        return juce::String::fromUTF8(copyError.c_str());
    const auto paramError = checkPitchParams(params, rate);
    if (!paramError.empty())
        return juce::String::fromUTF8(paramError.c_str());
    const int64_t frames = pitchFrameCount(static_cast<int64_t>(mono.size()), params);
    if (frames == 0)
        return juce::String::fromUTF8(analyzePitch(mono.data(), static_cast<int64_t>(mono.size()), rate, params).error.c_str());
    if (frames > kPitchMaxFrames)
        return "This clip would need " + juce::String(frames) + " analysis frames; the limit is " + juce::String(kPitchMaxFrames)
            + ". Use a larger hop size.";

    auto job = std::make_unique<PitchJob>();
    job->id = nextPitchJob++;
    const double clipStart = static_cast<double>(clip.timelineStart) / session.playbackRate;
    const double seconds = static_cast<double>(mono.size()) / rate;
    auto* info = new juce::DynamicObject();
    info->setProperty("jobId", job->id);
    info->setProperty("trackId", trackVar.toString());
    info->setProperty("clipId", clipVar.toString());
    info->setProperty("sampleRate", rate);
    info->setProperty("duration", seconds);
    info->setProperty("clipStart", clipStart);
    info->setProperty("frames", static_cast<juce::int64>(frames));
    info->setProperty("params", pitchParamsVar(params));
    // Answer before the worker exists, so the job id always arrives before its events.
    succeed(requestId, juce::var(info));

    PitchSegments segmentInfo;
    segmentInfo.generation = projectGeneration;
    segmentInfo.trackId = trackVar.toString().toStdString();
    segmentInfo.clipId = clip.id;
    segmentInfo.sourceFileId = clip.sourceFileId;
    segmentInfo.sourceOffset = clip.sourceOffset;
    segmentInfo.duration = clip.duration;
    segmentInfo.playbackRate = session.playbackRate;
    segmentInfo.clipStart = clipStart;
    segmentInfo.sourceStart = static_cast<double>(clip.sourceOffset) / session.playbackRate;

    PitchJob* raw = job.get();
    job->thread = std::thread([this, raw, samples = std::move(mono), rate, params, frameDelayMs, seconds, clipStart, segmentInfo,
                               trackId = trackVar.toString(), clipId = clipVar.toString()]() mutable {
        const auto began = std::chrono::steady_clock::now();
        auto reported = began;
        auto progress = [&](int64_t done, int64_t total) {
            if (frameDelayMs > 0.0)
                std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int64_t>(frameDelayMs * 1000.0)));
            const auto now = std::chrono::steady_clock::now();
            if (done < total && now - reported < std::chrono::milliseconds(100))
                return;
            reported = now;
            auto* event = new juce::DynamicObject();
            event->setProperty("v", 1);
            event->setProperty("event", "pitchProgress");
            event->setProperty("jobId", raw->id);
            event->setProperty("done", static_cast<juce::int64>(done));
            event->setProperty("total", static_cast<juce::int64>(total));
            writeJson(juce::var(event));
        };
        auto analysis = analyzePitch(samples.data(), static_cast<int64_t>(samples.size()), rate, params, &raw->cancel, progress);
        std::vector<float>().swap(samples);
        if (analysis.error.empty() && !analysis.cancelled) {
            segmentInfo.jobId = raw->id;
            segmentInfo.hopSeconds = analysis.params.hopSize / analysis.sampleRate;
            segmentInfo.windowSeconds = analysis.params.windowSize / analysis.sampleRate;
            segmentInfo.params = analysis.params;
            segmentInfo.segments = segmentPitch(analysis.frames, segmentInfo.hopSeconds);
            segmentInfo.frames = analysis.frames;
            const std::lock_guard<std::mutex> lock(pitchSegmentsMutex);
            pitchSegments.push_back(std::move(segmentInfo));
            while (pitchSegments.size() > 4)
                pitchSegments.pop_front();
        }
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        writeJson(pitchResultVar(analysis, raw->id, trackId, clipId, clipStart, seconds, elapsed));
        raw->finished.store(true);
    });
    pitchJob = std::move(job);
    return {};
}

bool Engine::findPitchSegments(int jobId, PitchSegments& out) const {
    const std::lock_guard<std::mutex> lock(pitchSegmentsMutex);
    for (const auto& item : pitchSegments) {
        if (item.jobId == jobId) {
            out = item;
            return true;
        }
    }
    return false;
}

bool Engine::segmentsOutdated(const PitchSegments& info, const Clip** clip) const {
    if (clip != nullptr)
        *clip = nullptr;
    if (info.generation != projectGeneration)
        return true;
    const int index = session.indexOf(info.trackId);
    if (index < 0)
        return true;
    const auto& clips = session.tracks[static_cast<size_t>(index)].clips;
    const auto found = std::find_if(clips.begin(), clips.end(), [&](const Clip& item) { return item.id == info.clipId; });
    if (found == clips.end())
        return true;
    if (clip != nullptr)
        *clip = &*found;
    if (found->sourceFileId != info.sourceFileId)
        return true;
    if (session.playbackRate == info.playbackRate)
        return found->sourceOffset != info.sourceOffset || found->duration != info.duration;
    const double tolerance = 1.0e-3;
    return std::fabs(found->sourceOffset / session.playbackRate - info.sourceOffset / info.playbackRate) > tolerance
        || std::fabs(found->duration / session.playbackRate - info.duration / info.playbackRate) > tolerance;
}

SegmentTargets Engine::segmentTargets(const PitchSegments& info, const Clip* clip, bool outdated) const {
    SegmentTargets out;
    const auto& mapping = session.pitchMapping;
    const std::vector<NoteTarget> none;
    const auto& targets = clip != nullptr ? clip->noteTargets : none;
    OverrideMatch match;
    if (outdated) {
        match.segmentOverride.assign(info.segments.size(), -1);
        match.matched.assign(targets.size(), false);
    } else {
        match = matchOverrides(targets, info.clipId, info.sourceFileId, info.segments, info.sourceStart,
                               std::max(0.03, 2.0 * info.hopSeconds));
    }
    out.unmatchedOverrides = static_cast<int>(std::count(match.matched.begin(), match.matched.end(), false));
    for (size_t s = 0; s < info.segments.size(); ++s) {
        const int overrideIndex = match.segmentOverride[s];
        if (overrideIndex >= 0) {
            out.target.push_back(targets[static_cast<size_t>(overrideIndex)].targetMidi);
            out.manual.push_back(true);
            continue;
        }
        const auto suggestion = mapPitch(info.segments[s].medianMidi, true, mapping.key, mapping.settings);
        out.target.push_back(mapping.enabled ? suggestion.targetMidi : -1);
        out.manual.push_back(false);
    }
    return out;
}

juce::var Engine::pitchMappingVar(const PitchSegments& info) const {
    const Clip* clip = nullptr;
    const bool outdated = segmentsOutdated(info, &clip);
    const auto& mapping = session.pitchMapping;
    const auto targets = segmentTargets(info, clip, outdated);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("jobId", info.jobId);
    obj->setProperty("trackId", juce::String::fromUTF8(info.trackId.c_str()));
    obj->setProperty("clipId", juce::String::fromUTF8(info.clipId.c_str()));
    obj->setProperty("clipStart", info.clipStart);
    obj->setProperty("sourceStart", info.sourceStart);
    obj->setProperty("hopSeconds", info.hopSeconds);
    obj->setProperty("clipChanged", outdated);
    obj->setProperty("mapping", mappingSettingsVar(mapping));
    obj->setProperty("overrideCount", clip != nullptr ? static_cast<int>(clip->noteTargets.size()) : 0);
    obj->setProperty("unmatchedOverrides", targets.unmatchedOverrides);
    juce::Array<juce::var> list;
    for (size_t s = 0; s < info.segments.size(); ++s) {
        const auto& segment = info.segments[s];
        const auto suggestion = mapPitch(segment.medianMidi, true, mapping.key, mapping.settings);
        auto* item = new juce::DynamicObject();
        item->setProperty("index", segment.index);
        item->setProperty("start", rounded(segment.start, 1.0e-5));
        item->setProperty("end", rounded(segment.end, 1.0e-5));
        item->setProperty("timelineStart", rounded(info.clipStart + segment.start, 1.0e-5));
        item->setProperty("timelineEnd", rounded(info.clipStart + segment.end, 1.0e-5));
        item->setProperty("voicedFrames", segment.voicedFrames);
        item->setProperty("confidence", rounded(segment.confidence, 1.0e-4));
        item->setProperty("originalMidi", rounded(segment.medianMidi, 1.0e-4));
        item->setProperty("originalFrequency", rounded(segment.medianFrequency, 1.0e-3));
        item->setProperty("nearestMidi", suggestion.nearestMidi);
        item->setProperty("nearestName", juce::String(suggestion.nearestName));
        item->setProperty("nearestCents", rounded((segment.medianMidi - suggestion.nearestMidi) * 100.0, 0.01));
        const bool suggest = mapping.enabled && suggestion.targetMidi >= 0;
        item->setProperty("status", mapping.enabled ? mappingStatusName(suggestion.status) : "off");
        item->setProperty("suggestedMidi", suggest ? suggestion.targetMidi : -1);
        item->setProperty("suggestedName", suggest ? juce::String(suggestion.targetName) : juce::String());
        item->setProperty("suggestedCents", suggest ? rounded(suggestion.cents, 0.01) : 0.0);
        const int manual = targets.manual[s] ? targets.target[s] : -1;
        item->setProperty("overrideMidi", manual);
        item->setProperty("overrideName", manual >= 0 ? juce::String(noteName(manual)) : juce::String());
        const int target = manual >= 0 ? manual : suggest ? suggestion.targetMidi : -1;
        item->setProperty("targetSource", manual >= 0 ? "manual" : suggest ? "auto" : "none");
        item->setProperty("targetMidi", target);
        item->setProperty("targetName", target >= 0 ? juce::String(noteName(target)) : juce::String());
        item->setProperty("targetCents", target >= 0 ? rounded((target - segment.medianMidi) * 100.0, 0.01) : 0.0);
        item->setProperty("targetInKey", target >= 0 && inScale(target, mapping.key));
        list.add(juce::var(item));
    }
    obj->setProperty("segments", list);
    return juce::var(obj);
}

void Engine::stopPitchAnalysis() {
    if (pitchJob == nullptr)
        return;
    pitchJob->cancel.store(true);
    if (pitchJob->thread.joinable())
        pitchJob->thread.join();
    pitchJob.reset();
}

void Engine::stopLoudnessAnalysis() {
    if (loudnessJob == nullptr)
        return;
    loudnessJob->cancel.store(true);
    if (loudnessJob->thread.joinable())
        loudnessJob->thread.join();
    loudnessJob.reset();
}

juce::String Engine::startLoudnessAnalysis(const juce::String& requestId, const juce::var& options) {
    if (loudnessJob != nullptr && !loudnessJob->finished.load())
        return "A loudness analysis is already running. Cancel it or wait for it to finish.";
    if (loudnessJob != nullptr) {
        if (loudnessJob->thread.joinable())
            loudnessJob->thread.join();
        loudnessJob.reset();
    }
    const auto pathVar = options.getProperty("path", {});
    if (!pathVar.isString())
        return "analyzeLoudness needs a WAV file path.";
    const auto path = pathVar.toString().toStdString();
    double frameDelayMs = 0.0; // test hook for cancellation
    const auto delayVar = options.getProperty("frameDelayMs", {});
    if (!delayVar.isVoid()) {
        if (!isNumber(delayVar))
            return "frameDelayMs must be a number.";
        frameDelayMs = static_cast<double>(delayVar);
        if (!(frameDelayMs >= 0.0 && frameDelayMs <= 100.0))
            return "frameDelayMs must be between 0 and 100.";
    }

    auto job = std::make_unique<LoudnessJob>();
    job->id = nextLoudnessJob++;
    auto* info = new juce::DynamicObject();
    info->setProperty("jobId", job->id);
    info->setProperty("path", juce::String::fromUTF8(path.c_str()));
    info->setProperty("truePeakOversample", kTruePeakOversample);
    info->setProperty("standard", "ITU-R BS.1770-4 / EBU R128");
    succeed(requestId, juce::var(info));

    LoudnessJob* raw = job.get();
    job->thread = std::thread([this, raw, path, frameDelayMs]() {
        const auto began = std::chrono::steady_clock::now();
        auto reported = began;
        auto progress = [&](int64_t done, int64_t total) {
            if (frameDelayMs > 0.0)
                std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int64_t>(frameDelayMs * 1000.0)));
            const auto now = std::chrono::steady_clock::now();
            if (done < total && now - reported < std::chrono::milliseconds(100))
                return;
            reported = now;
            auto* event = new juce::DynamicObject();
            event->setProperty("v", 1);
            event->setProperty("event", "loudnessProgress");
            event->setProperty("jobId", raw->id);
            event->setProperty("done", static_cast<juce::int64>(done));
            event->setProperty("total", static_cast<juce::int64>(total));
            writeJson(juce::var(event));
        };
        auto analysis = analyzeLoudnessFile(path, &raw->cancel, progress);
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        auto* event = new juce::DynamicObject();
        event->setProperty("v", 1);
        event->setProperty("event", "loudnessResult");
        event->setProperty("jobId", raw->id);
        event->setProperty("path", juce::String::fromUTF8(analysis.path.c_str()));
        event->setProperty("ok", analysis.error.empty() && !analysis.cancelled);
        event->setProperty("available", analysis.available);
        event->setProperty("cancelled", analysis.cancelled);
        event->setProperty("error", juce::String::fromUTF8(analysis.error.c_str()));
        event->setProperty("sampleRate", analysis.sampleRate);
        event->setProperty("channels", analysis.channels);
        event->setProperty("frames", static_cast<juce::int64>(analysis.frames));
        event->setProperty("durationSeconds", analysis.durationSeconds);
        event->setProperty("elapsedSeconds", elapsed);
        event->setProperty("truePeakOversample", kTruePeakOversample);
        event->setProperty("standard", "ITU-R BS.1770-4 / EBU R128");
        auto setMetric = [&](const char* validName, const char* valueName, bool valid, double value) {
            event->setProperty(validName, valid);
            if (valid && std::isfinite(value))
                event->setProperty(valueName, value);
            else
                event->setProperty(valueName, juce::var());
        };
        setMetric("integratedValid", "integratedLufs", analysis.integratedValid, analysis.integratedLufs);
        setMetric("momentaryValid", "momentaryLufs", analysis.momentaryValid, analysis.momentaryLufs);
        setMetric("shortTermValid", "shortTermLufs", analysis.shortTermValid, analysis.shortTermLufs);
        setMetric("lraValid", "lraLu", analysis.lraValid, analysis.lraLu);
        setMetric("samplePeakValid", "samplePeakDbFs", analysis.samplePeakValid, analysis.samplePeakDbFs);
        setMetric("truePeakValid", "truePeakDbTp", analysis.truePeakValid, analysis.truePeakDbTp);
        event->setProperty("clippingSample", analysis.clippingSample);
        event->setProperty("clippingTruePeak", analysis.clippingTruePeak);
        writeJson(juce::var(event));
        raw->finished.store(true);
    });
    loudnessJob = std::move(job);
    return {};
}

juce::String Engine::startPitchProcess(const juce::String& requestId, const juce::var& options) {
    if (pitchJob != nullptr && !pitchJob->finished.load())
        return pitchJob->processing ? "Pitch processing is already running. Cancel it or wait for it to finish."
                                    : "A pitch analysis is running. Cancel it or wait for it to finish before processing.";
    if (pitchJob != nullptr) {
        if (pitchJob->thread.joinable())
            pitchJob->thread.join();
        pitchJob.reset();
    }
    const auto trackVar = options.getProperty("trackId", {});
    const auto clipVar = options.getProperty("clipId", {});
    if (!trackVar.isString() || !clipVar.isString())
        return "processPitch needs a string trackId and clipId.";
    const auto semitoneVar = options.getProperty("semitones", {});
    const auto centVar = options.getProperty("cents", {});
    if ((!semitoneVar.isVoid() && !isNumber(semitoneVar)) || (!centVar.isVoid() && !isNumber(centVar)))
        return "semitones and cents must be numbers.";
    const double semitoneValue = semitoneVar.isVoid() ? 0.0 : static_cast<double>(semitoneVar);
    if (!std::isfinite(semitoneValue) || semitoneValue != std::floor(semitoneValue) || std::abs(semitoneValue) > 1000.0)
        return "semitones must be a whole number between -12 and +12.";
    PitchShiftSettings settings;
    settings.semitones = static_cast<int>(semitoneValue);
    settings.cents = centVar.isVoid() ? 0.0 : static_cast<double>(centVar);
    const auto qualityError = parseVocalQuality(options, settings.quality);
    if (qualityError.isNotEmpty())
        return qualityError;
    double frameDelayMs = 0.0;   // test hook: slows the worker down so cancellation can be exercised
    const auto delayVar = options.getProperty("frameDelayMs", {});
    if (!delayVar.isVoid()) {
        if (!isNumber(delayVar) || !(static_cast<double>(delayVar) >= 0.0 && static_cast<double>(delayVar) <= 100.0))
            return "frameDelayMs must be between 0 and 100.";
        frameDelayMs = static_cast<double>(delayVar);
    }

    const auto trackId = trackVar.toString().toStdString();
    const auto clipId = clipVar.toString().toStdString();
    Session::ClipRegion region;
    const auto copyError = session.copyClipRegion(trackId, clipId, kPitchMaxSeconds, kPitchShiftContext, region);
    if (!copyError.empty())
        return juce::String::fromUTF8(copyError.c_str());
    const auto settingsError = checkPitchShift(settings, region.sampleRate, region.channels);
    if (!settingsError.empty())
        return juce::String::fromUTF8(settingsError.c_str());
    if (!processedFolder.createDirectory().wasOk())
        return "Could not create the processed-audio folder " + processedFolder.getFullPathName() + ".";

    const auto& track = session.tracks[static_cast<size_t>(session.indexOf(trackId))];
    PitchProcessed info;
    info.trackId = trackId;
    info.clipId = clipId;
    info.sourceFileId = region.clip.sourceFileId;
    info.sourceOffset = region.clip.sourceOffset;
    info.duration = region.clip.duration;
    info.shiftCents = settings.semitones * 100.0 + settings.cents;
    info.label = (shiftLabel(settings.semitones, settings.cents) + vocalLabel(settings.quality)).toStdString();
    const auto baseName = sanitizeFileName(track.name + " " + clipId) + " pitch " + shiftLabel(settings.semitones, settings.cents);
    const int64_t frames = static_cast<int64_t>(region.left.size()) - region.lead - region.tail;

    auto job = std::make_unique<PitchJob>();
    job->id = nextPitchJob++;
    job->processing = true;
    auto* reply = new juce::DynamicObject();
    reply->setProperty("jobId", job->id);
    reply->setProperty("trackId", trackVar.toString());
    reply->setProperty("clipId", clipVar.toString());
    reply->setProperty("semitones", settings.semitones);
    reply->setProperty("cents", settings.cents);
    reply->setProperty("ratio", pitchShiftRatio(settings));
    reply->setProperty("identity", isIdentityShift(settings));
    setVocalQuality(*reply, settings.quality);
    reply->setProperty("label", juce::String::fromUTF8(info.label.c_str()));
    reply->setProperty("sampleRate", region.sampleRate);
    reply->setProperty("channels", region.channels);
    reply->setProperty("duration", static_cast<double>(frames) / region.sampleRate);
    reply->setProperty("folder", processedFolder.getFullPathName());
    // Answer before the worker exists, so the job id always arrives before its events.
    succeed(requestId, juce::var(reply));

    PitchJob* raw = job.get();
    job->thread = std::thread([this, raw, region = std::move(region), settings, frameDelayMs, info, baseName,
                               folder = processedFolder, frames]() mutable {
        const auto began = std::chrono::steady_clock::now();
        const auto memoryBefore = processMemory();
        auto reported = began;
        auto event = new juce::DynamicObject();
        event->setProperty("v", 1);
        event->setProperty("event", "pitchProcessResult");
        event->setProperty("jobId", raw->id);
        event->setProperty("resultId", raw->id);
        event->setProperty("trackId", juce::String::fromUTF8(info.trackId.c_str()));
        event->setProperty("clipId", juce::String::fromUTF8(info.clipId.c_str()));
        event->setProperty("semitones", settings.semitones);
        event->setProperty("cents", settings.cents);
        event->setProperty("ratio", pitchShiftRatio(settings));
        event->setProperty("label", juce::String::fromUTF8(info.label.c_str()));
        setVocalQuality(*event, settings.quality);
        event->setProperty("sampleRate", region.sampleRate);
        event->setProperty("channels", region.channels);
        event->setProperty("frames", static_cast<juce::int64>(frames));
        event->setProperty("duration", static_cast<double>(frames) / region.sampleRate);
        auto finish = [&](const juce::String& status, const juce::String& error) {
            event->setProperty("status", status);
            event->setProperty("error", error);
            event->setProperty("elapsedSeconds", rounded(std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count(), 1.0e-4));
            writeJson(juce::var(event));
            raw->finished.store(true);
        };
        auto progress = [&](double fraction) {
            if (frameDelayMs > 0.0)
                std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int64_t>(frameDelayMs * 1000.0)));
            const auto now = std::chrono::steady_clock::now();
            if (fraction < 1.0 && now - reported < std::chrono::milliseconds(100))
                return;
            reported = now;
            auto* update = new juce::DynamicObject();
            update->setProperty("v", 1);
            update->setProperty("event", "pitchProcessProgress");
            update->setProperty("jobId", raw->id);
            update->setProperty("fraction", rounded(fraction, 1.0e-4));
            writeJson(juce::var(update));
        };

        auto shifted = pitchShift(region.left.data(), region.channels == 2 ? region.right.data() : nullptr,
                                  static_cast<int64_t>(region.left.size()), region.channels, region.sampleRate, settings,
                                  region.lead, region.tail, &raw->cancel, progress);
        if (shifted.cancelled || raw->cancel.load()) {
            finish("cancelled", {});
            return;
        }
        if (!shifted.error.empty()) {
            finish("error", juce::String::fromUTF8(shifted.error.c_str()));
            return;
        }

        const double shiftSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        const auto memoryAfter = processMemory();
        // Verification only (the audio is final): measured on the region in place, then freed.
        int originalVoiced = 0;
        int processedVoiced = 0;
        const double originalHz = medianPitch(region.left.data() + region.lead,
                                              region.channels == 2 ? region.right.data() + region.lead : nullptr,
                                              frames, region.sampleRate, &raw->cancel, originalVoiced);
        std::vector<float>().swap(region.left);
        std::vector<float>().swap(region.right);
        const double processedHz = medianPitch(shifted.left.data(), region.channels == 2 ? shifted.right.data() : nullptr,
                                               frames, region.sampleRate, &raw->cancel, processedVoiced);
        if (raw->cancel.load()) {
            finish("cancelled", {});
            return;
        }

        auto file = folder.getChildFile(baseName + ".wav");
        if (file.exists())
            file = file.getNonexistentSibling(true);
        const auto writeError = writeWavFile(file.getFullPathName().toStdString(), region.sampleRate, shifted.left.data(),
                                             region.channels == 2 ? shifted.right.data() : shifted.left.data(),
                                             frames, 32, region.channels);
        if (!writeError.empty()) {
            file.deleteFile();
            finish("error", "Could not write the processed audio: " + juce::String::fromUTF8(writeError.c_str()));
            return;
        }
        info.path = file.getFullPathName().toStdString();
        {
            std::lock_guard<std::mutex> lock(pitchProcessedMutex);
            pitchProcessed[raw->id] = info;
        }
        const double ratio = pitchShiftRatio(settings);
        event->setProperty("path", file.getFullPathName());
        event->setProperty("identity", shifted.identity);
        event->setProperty("gainReductionDb", rounded(shifted.gainReductionDb, 1.0e-3));
        event->setProperty("repairedSamples", static_cast<juce::int64>(shifted.repairedSamples));
        event->setProperty("inputPeak", rounded(shifted.inputPeak, 1.0e-5));
        event->setProperty("outputPeak", rounded(shifted.outputPeak, 1.0e-5));
        event->setProperty("originalHz", rounded(originalHz, 1.0e-3));
        event->setProperty("processedHz", rounded(processedHz, 1.0e-3));
        event->setProperty("originalVoicedFrames", originalVoiced);
        event->setProperty("processedVoicedFrames", processedVoiced);
        if (originalHz > 0.0 && processedHz > 0.0) {
            event->setProperty("expectedHz", rounded(originalHz * ratio, 1.0e-3));
            event->setProperty("deviationCents", rounded(1200.0 * std::log2(processedHz / (originalHz * ratio)), 0.01));
        } else {
            event->setProperty("expectedHz", juce::var());
            event->setProperty("deviationCents", juce::var());
        }
        const double audioSeconds = static_cast<double>(frames) / region.sampleRate;
        event->setProperty("envelopeFrames", static_cast<juce::int64>(shifted.envelopeFrames));
        event->setProperty("transients", shifted.transients);
        event->setProperty("processSeconds", rounded(shiftSeconds, 1.0e-4));
        event->setProperty("realtimeFactor", rounded(shiftSeconds > 0.0 ? audioSeconds / shiftSeconds : 0.0, 0.01));
        event->setProperty("workingMB", rounded(static_cast<double>(shifted.workingBytes) / 1048576.0, 0.01));
        event->setProperty("workingSetBeforeMB", rounded(static_cast<double>(memoryBefore.workingSetBytes) / 1048576.0, 0.01));
        event->setProperty("workingSetAfterMB", rounded(static_cast<double>(memoryAfter.workingSetBytes) / 1048576.0, 0.01));
        event->setProperty("peakWorkingSetMB", rounded(static_cast<double>(memoryAfter.peakWorkingSetBytes) / 1048576.0, 0.01));
        finish("done", {});
    });
    pitchJob = std::move(job);
    return {};
}

juce::String Engine::startPitchCorrection(const juce::String& requestId, const juce::var& options) {
    if (pitchJob != nullptr && !pitchJob->finished.load())
        return pitchJob->processing ? "Pitch processing is already running. Cancel it or wait for it to finish."
                                    : "A pitch analysis is running. Cancel it or wait for it to finish before correcting.";
    if (pitchJob != nullptr) {
        if (pitchJob->thread.joinable())
            pitchJob->thread.join();
        pitchJob.reset();
    }
    const auto jobVar = options.getProperty("jobId", {});
    if (!isNumber(jobVar))
        return "processAutoCorrection needs the numeric jobId of a pitch analysis.";
    const auto retuneVar = options.getProperty("retuneMs", {});
    const auto strengthVar = options.getProperty("strength", {});
    if (!isNumber(retuneVar) || !isNumber(strengthVar))
        return "processAutoCorrection needs a numeric retuneMs (0-200) and strength (0-100).";
    CorrectionSettings settings;
    settings.retuneMs = static_cast<double>(retuneVar);
    settings.strength = static_cast<double>(strengthVar) / 100.0;
    const auto qualityError = parseVocalQuality(options, settings.quality);
    if (qualityError.isNotEmpty())
        return qualityError;
    const auto settingsError = checkCorrectionSettings(settings);
    if (!settingsError.empty())
        return juce::String::fromUTF8(settingsError.c_str());
    double frameDelayMs = 0.0;   // test hook: slows the worker down so cancellation can be exercised
    const auto delayVar = options.getProperty("frameDelayMs", {});
    if (!delayVar.isVoid()) {
        if (!isNumber(delayVar) || !(static_cast<double>(delayVar) >= 0.0 && static_cast<double>(delayVar) <= 100.0))
            return "frameDelayMs must be between 0 and 100.";
        frameDelayMs = static_cast<double>(delayVar);
    }

    PitchSegments analysis;
    if (!findPitchSegments(static_cast<int>(jobVar), analysis))
        return "No pitch analysis with that jobId is available. Analyse the clip again.";
    const Clip* clip = nullptr;
    if (segmentsOutdated(analysis, &clip))
        return "The clip changed after it was analysed (trim, move to another source, processing or a new project). Analyse it again.";
    const auto& mapping = session.pitchMapping;
    const auto rootVar = options.getProperty("root", {});
    const auto scaleVar = options.getProperty("scale", {});
    if ((!rootVar.isVoid() && rootVar.toString() != juce::String(pitchClassName(mapping.key.root)))
        || (!scaleVar.isVoid() && scaleVar.toString() != juce::String(scaleTypeName(mapping.key.scale))))
        return "The key or scale changed since the targets were shown. Check the targets and try again.";
    const auto targets = segmentTargets(analysis, clip, false);
    const auto expectedVar = options.getProperty("targets", {});
    if (!expectedVar.isVoid()) {
        const auto* expected = expectedVar.getArray();
        if (expected == nullptr || expected->size() != static_cast<int>(targets.target.size()))
            return "The note targets changed since they were shown. Check the targets and try again.";
        for (int s = 0; s < expected->size(); ++s) {
            if (!isNumber((*expected)[s]) || static_cast<int>((*expected)[s]) != targets.target[static_cast<size_t>(s)])
                return "The note targets changed since they were shown (key, scale or manual targets). Check the targets and try again.";
        }
    }
    const int targetCount = static_cast<int>(std::count_if(targets.target.begin(), targets.target.end(), [](int t) { return t >= 0; }));
    if (targetCount == 0)
        return "There is nothing to correct: no note has a target. Turn on suggested targets or choose manual targets.";

    Session::ClipRegion region;
    const auto copyError = session.copyClipRegion(analysis.trackId, analysis.clipId, kPitchMaxSeconds, kPitchShiftContext, region);
    if (!copyError.empty())
        return juce::String::fromUTF8(copyError.c_str());
    if (region.clip.sourceFileId != analysis.sourceFileId || region.clip.sourceOffset != analysis.sourceOffset
        || region.clip.duration != analysis.duration)
        return "The clip changed after it was analysed. Analyse it again.";
    if (std::abs(region.sampleRate - analysis.params.windowSize / analysis.windowSeconds) > 0.5)
        return "The clip's source sample rate changed after it was analysed. Analyse it again.";
    if (!processedFolder.createDirectory().wasOk())
        return "Could not create the processed-audio folder " + processedFolder.getFullPathName() + ".";

    const double rate = region.sampleRate;
    const auto notes = correctionNotes(analysis.segments, targets.target,
                                       0.5 * (analysis.params.windowSize - analysis.params.hopSize) / rate);
    const auto& track = session.tracks[static_cast<size_t>(session.indexOf(analysis.trackId))];
    const auto keyText = juce::String(pitchClassName(mapping.key.root)) + " " + juce::String(scaleTypeLabel(mapping.key.scale));
    const auto strengthText = juce::String(static_cast<double>(strengthVar), 0) + "%";
    const auto retuneText = juce::String(settings.retuneMs, 0) + " ms";
    PitchProcessed info;
    info.trackId = analysis.trackId;
    info.clipId = analysis.clipId;
    info.sourceFileId = region.clip.sourceFileId;
    info.sourceOffset = region.clip.sourceOffset;
    info.duration = region.clip.duration;
    info.shiftCents = 0.0;
    info.label = ("Auto correction " + strengthText + " " + retuneText + " (" + keyText + ")" + vocalLabel(settings.quality)).toStdString();
    const auto baseName = sanitizeFileName(track.name + " " + analysis.clipId) + " autocorrect " + strengthText + " " + retuneText;
    const int64_t frames = static_cast<int64_t>(region.left.size()) - region.lead - region.tail;

    auto job = std::make_unique<PitchJob>();
    job->id = nextPitchJob++;
    job->processing = true;
    auto* reply = new juce::DynamicObject();
    reply->setProperty("jobId", job->id);
    reply->setProperty("analysisJobId", analysis.jobId);
    reply->setProperty("trackId", juce::String::fromUTF8(analysis.trackId.c_str()));
    reply->setProperty("clipId", juce::String::fromUTF8(analysis.clipId.c_str()));
    reply->setProperty("retuneMs", settings.retuneMs);
    reply->setProperty("strength", static_cast<double>(strengthVar));
    reply->setProperty("notes", static_cast<int>(notes.size()));
    reply->setProperty("sampleRate", rate);
    reply->setProperty("channels", region.channels);
    reply->setProperty("duration", static_cast<double>(frames) / rate);
    reply->setProperty("label", juce::String::fromUTF8(info.label.c_str()));
    setVocalQuality(*reply, settings.quality);
    reply->setProperty("folder", processedFolder.getFullPathName());
    // Answer before the worker exists, so the job id always arrives before its events.
    succeed(requestId, juce::var(reply));

    PitchJob* raw = job.get();
    job->thread = std::thread([this, raw, region = std::move(region), analysis = std::move(analysis), notes, settings, frameDelayMs,
                               info, baseName, folder = processedFolder, frames, rate]() mutable {
        const auto began = std::chrono::steady_clock::now();
        const auto memoryBefore = processMemory();
        auto reported = began;
        auto* event = new juce::DynamicObject();
        event->setProperty("v", 1);
        event->setProperty("event", "pitchCorrectResult");
        event->setProperty("jobId", raw->id);
        event->setProperty("resultId", raw->id);
        event->setProperty("trackId", juce::String::fromUTF8(info.trackId.c_str()));
        event->setProperty("clipId", juce::String::fromUTF8(info.clipId.c_str()));
        event->setProperty("retuneMs", settings.retuneMs);
        event->setProperty("strength", rounded(settings.strength * 100.0, 1.0e-3));
        event->setProperty("label", juce::String::fromUTF8(info.label.c_str()));
        setVocalQuality(*event, settings.quality);
        event->setProperty("sampleRate", rate);
        event->setProperty("channels", region.channels);
        event->setProperty("frames", static_cast<juce::int64>(frames));
        event->setProperty("duration", static_cast<double>(frames) / rate);
        auto finish = [&](const juce::String& status, const juce::String& error) {
            event->setProperty("status", status);
            event->setProperty("error", error);
            event->setProperty("elapsedSeconds", rounded(std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count(), 1.0e-4));
            writeJson(juce::var(event));
            raw->finished.store(true);
        };
        auto progress = [&](double fraction) {
            if (frameDelayMs > 0.0)
                std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int64_t>(frameDelayMs * 1000.0)));
            const auto now = std::chrono::steady_clock::now();
            if (fraction < 1.0 && now - reported < std::chrono::milliseconds(100))
                return;
            reported = now;
            auto* update = new juce::DynamicObject();
            update->setProperty("v", 1);
            update->setProperty("event", "pitchCorrectProgress");
            update->setProperty("jobId", raw->id);
            update->setProperty("fraction", rounded(fraction, 1.0e-4));
            writeJson(juce::var(update));
        };

        const auto curve = buildCorrectionCurve(analysis.frames, notes, settings, rate, static_cast<int64_t>(region.left.size()),
                                                static_cast<double>(region.lead) / rate);
        auto corrected = pitchCorrect(region.left.data(), region.channels == 2 ? region.right.data() : nullptr,
                                      static_cast<int64_t>(region.left.size()), region.channels, rate, curve,
                                      region.lead, region.tail, &raw->cancel, [&](double f) { progress(0.8 * f); });
        if (corrected.cancelled || raw->cancel.load()) {
            finish("cancelled", {});
            return;
        }
        if (!corrected.error.empty()) {
            finish("error", juce::String::fromUTF8(corrected.error.c_str()));
            return;
        }
        const double correctSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
        const auto memoryAfter = processMemory();
        std::vector<float>().swap(region.left);
        std::vector<float>().swap(region.right);

        // Measure the result with the analysis settings (verification only; the audio is final).
        std::vector<float> mono(corrected.left.size());
        for (size_t i = 0; i < mono.size(); ++i)
            mono[i] = region.channels == 2 ? 0.5f * (corrected.left[i] + corrected.right[i]) : corrected.left[i];
        auto check = analyzePitch(mono.data(), static_cast<int64_t>(mono.size()), rate, analysis.params, &raw->cancel,
                                  [&](int64_t done, int64_t total) { progress(0.8 + 0.2 * static_cast<double>(done) / std::max<int64_t>(1, total)); });
        std::vector<float>().swap(mono);
        if (check.cancelled || raw->cancel.load()) {
            finish("cancelled", {});
            return;
        }

        auto file = folder.getChildFile(baseName + ".wav");
        if (file.exists())
            file = file.getNonexistentSibling(true);
        const auto writeError = writeWavFile(file.getFullPathName().toStdString(), rate, corrected.left.data(),
                                             region.channels == 2 ? corrected.right.data() : corrected.left.data(),
                                             frames, 32, region.channels);
        if (!writeError.empty()) {
            file.deleteFile();
            finish("error", "Could not write the corrected audio: " + juce::String::fromUTF8(writeError.c_str()));
            return;
        }
        info.path = file.getFullPathName().toStdString();
        {
            std::lock_guard<std::mutex> lock(pitchProcessedMutex);
            pitchProcessed[raw->id] = info;
        }

        const double step = kCorrectionControlStep / rate;
        const double offset = static_cast<double>(region.lead) / rate;
        auto pointAt = [&](double t) {
            return static_cast<size_t>(std::clamp((t + offset) / step, 0.0, static_cast<double>(curve.cents.size() - 1)));
        };
        auto centsAt = [&](double t) { return static_cast<double>(curve.cents[pointAt(t)]); };
        auto goalAt = [&](double t) { return static_cast<double>(curve.goal[pointAt(t)]); };
        auto centralMedian = [](const std::vector<PitchFrame>& list, double from, double to) {
            std::vector<double> values;
            for (const auto& frame : list) {
                if (frame.voiced && frame.time >= from && frame.time <= to)
                    values.push_back(midiFromFrequency(frame.frequency));
            }
            if (values.size() < 3)
                return -1.0;
            std::sort(values.begin(), values.end());
            return values[values.size() / 2];
        };
        const double windowSeconds = analysis.windowSeconds;
        juce::Array<juce::var> list;
        double worstCents = 0.0;
        for (size_t noteIndex = 0; noteIndex < notes.size(); ++noteIndex) {
            const auto& note = notes[noteIndex];
            const bool glide = std::find(curve.glideNotes.begin(), curve.glideNotes.end(), noteIndex) != curve.glideNotes.end();
            const NoteSegment* segment = nullptr;
            for (const auto& item : analysis.segments)
                if (item.firstFrame == note.firstFrame && item.lastFrame == note.lastFrame)
                    segment = &item;
            if (segment == nullptr)
                continue;
            // Away from the edges: skip the retune transition at the start and one window at the end.
            const double from = segment->start + std::max(0.05, 1.2 * settings.retuneMs / 1000.0) + windowSeconds / 2.0;
            const double to = segment->end - 0.03 - windowSeconds / 2.0;
            auto* item = new juce::DynamicObject();
            item->setProperty("index", segment->index);
            item->setProperty("start", rounded(segment->start, 1.0e-5));
            item->setProperty("end", rounded(segment->end, 1.0e-5));
            item->setProperty("targetMidi", note.targetMidi);
            item->setProperty("targetName", juce::String(noteName(note.targetMidi)));
            item->setProperty("glide", glide);
            const double original = centralMedian(analysis.frames, from, to);
            const double result = centralMedian(check.frames, from, to);
            item->setProperty("measuredFrom", rounded(from, 1.0e-4));
            item->setProperty("measuredTo", rounded(to, 1.0e-4));
            if (original > 0.0 && result > 0.0) {
                const double expected = glide ? original : original + settings.strength * (note.targetMidi - original);
                const double remaining = (result - expected) * 100.0;
                item->setProperty("originalMidi", rounded(original, 1.0e-4));
                item->setProperty("expectedMidi", rounded(expected, 1.0e-4));
                item->setProperty("correctedMidi", rounded(result, 1.0e-4));
                item->setProperty("originalCents", rounded((original - note.targetMidi) * 100.0, 0.01));
                item->setProperty("correctedCents", rounded((result - note.targetMidi) * 100.0, 0.01));
                item->setProperty("remainingCents", rounded(remaining, 0.01));
                worstCents = std::max(worstCents, std::abs(remaining));
            } else {
                item->setProperty("remainingCents", juce::var());   // note too short to measure away from its edges
            }
            // transitionMs (settle time): for the curve to cover 95% of the change from the note
            // start to its middle. It includes the time the measured pitch itself takes to settle.
            const double centre = 0.5 * (segment->start + segment->end);
            const double c0 = centsAt(note.start);
            const double middle = centsAt(centre);
            double transition = 0.0;
            if (std::abs(middle - c0) > 0.5) {
                for (double t = note.start; t <= note.end; t += step) {
                    if (std::abs(centsAt(t) - c0) >= 0.95 * std::abs(middle - c0)) {
                        transition = t - note.start;
                        break;
                    }
                }
            }
            // responseMs: for the curve to come within 5% (at least 1 cent) of the wanted change
            // at the same moment - the retune speed as applied. goalSettleMs: the last time before
            // the middle that the wanted change itself (target - measured pitch) was more than 5%
            // away from its middle value - how long the measured pitch took to settle.
            double response = 0.0;
            double goalSettle = 0.0;
            const double goalMiddle = goalAt(centre);
            if (!glide) {
                // From the first curve point inside the note (the point at note.start may precede it).
                for (double t = note.start + step; t <= centre; t += step) {
                    const double g = goalAt(t);
                    if (std::abs(centsAt(t) - g) <= std::max(0.05 * std::abs(g), 1.0)) {
                        response = t - note.start;
                        break;
                    }
                }
                for (double t = note.start + step; t <= centre; t += step) {
                    if (std::abs(goalAt(t) - goalMiddle) > std::max(0.05 * std::abs(goalMiddle), 1.0))
                        goalSettle = t + step - note.start;
                }
            }
            item->setProperty("curveMiddleCents", rounded(middle, 0.01));
            item->setProperty("transitionMs", rounded(transition * 1000.0, 0.1));
            item->setProperty("responseMs", rounded(response * 1000.0, 0.1));
            item->setProperty("goalSettleMs", rounded(goalSettle * 1000.0, 0.1));
            list.add(juce::var(item));
        }
        const double audioSeconds = static_cast<double>(frames) / rate;
        event->setProperty("path", file.getFullPathName());
        event->setProperty("identity", corrected.identity);
        event->setProperty("notes", list);
        event->setProperty("worstRemainingCents", rounded(worstCents, 0.01));
        event->setProperty("maxCorrectionCents", rounded(curve.maxAbsCents, 0.01));
        event->setProperty("gainReductionDb", rounded(corrected.gainReductionDb, 1.0e-3));
        event->setProperty("repairedSamples", static_cast<juce::int64>(corrected.repairedSamples));
        event->setProperty("inputPeak", rounded(corrected.inputPeak, 1.0e-5));
        event->setProperty("outputPeak", rounded(corrected.outputPeak, 1.0e-5));
        event->setProperty("copiedSamples", static_cast<juce::int64>(corrected.copiedSamples));
        event->setProperty("vocoderFrames", static_cast<juce::int64>(corrected.vocoderFrames));
        event->setProperty("skippedFrames", static_cast<juce::int64>(corrected.skippedFrames));
        event->setProperty("envelopeFrames", static_cast<juce::int64>(corrected.envelopeFrames));
        event->setProperty("transients", corrected.transients);
        event->setProperty("glideNotes", static_cast<int>(curve.glideNotes.size()));
        event->setProperty("octaveFrames", curve.octaveFrames);
        event->setProperty("correctionSeconds", rounded(correctSeconds, 1.0e-4));
        event->setProperty("realtimeFactor", rounded(correctSeconds > 0.0 ? audioSeconds / correctSeconds : 0.0, 0.01));
        event->setProperty("workingMB", rounded(static_cast<double>(corrected.workingBytes) / 1048576.0, 0.01));
        event->setProperty("workingSetBeforeMB", rounded(static_cast<double>(memoryBefore.workingSetBytes) / 1048576.0, 0.01));
        event->setProperty("workingSetAfterMB", rounded(static_cast<double>(memoryAfter.workingSetBytes) / 1048576.0, 0.01));
        event->setProperty("peakWorkingSetMB", rounded(static_cast<double>(memoryAfter.peakWorkingSetBytes) / 1048576.0, 0.01));
        finish("done", {});
    });
    pitchJob = std::move(job);
    return {};
}

void Engine::endPitchPreview() {
    if (session.pitchPreview.trackId.empty())
        return;
    const int resultId = session.pitchPreview.resultId;
    const int index = session.indexOf(session.pitchPreview.trackId);
    holdRetired(session.endPitchPreview());
    publishMix();
    std::lock_guard<std::mutex> lock(pitchProcessedMutex);
    const auto found = pitchProcessed.find(resultId);
    if (found == pitchProcessed.end() || index < 0)
        return;
    const auto& extras = session.tracks[static_cast<size_t>(index)].extras;
    const bool kept = std::any_of(extras.begin(), extras.end(), [&](const Session::Track::ExtraSource& extra) { return extra.id == found->second.loadedId; });
    if (!kept)
        found->second.loadedId.clear();
}

juce::String Engine::processedClipError(const PitchProcessed& info) const {
    const int index = session.indexOf(info.trackId);
    if (index < 0)
        return "The track of this processed audio no longer exists.";
    const auto& clips = session.tracks[static_cast<size_t>(index)].clips;
    const auto clip = std::find_if(clips.begin(), clips.end(), [&](const Clip& item) { return item.id == info.clipId; });
    if (clip == clips.end())
        return "The clip of this processed audio no longer exists.";
    if (clip->sourceFileId != info.sourceFileId || clip->sourceOffset != info.sourceOffset || clip->duration != info.duration)
        return "The clip has changed since it was processed. Process it again.";
    return {};
}

juce::String Engine::loadProcessed(int resultId, bool preview, std::string& sourceId) {
    PitchProcessed info;
    {
        std::lock_guard<std::mutex> lock(pitchProcessedMutex);
        const auto found = pitchProcessed.find(resultId);
        if (found == pitchProcessed.end())
            return "That processed audio is not available. Process the clip again.";
        info = found->second;
    }
    const auto clipError = processedClipError(info);
    if (clipError.isNotEmpty())
        return clipError;
    const int index = session.indexOf(info.trackId);
    auto& extras = session.tracks[static_cast<size_t>(index)].extras;
    auto loaded = std::find_if(extras.begin(), extras.end(), [&](const Session::Track::ExtraSource& extra) {
        return !info.loadedId.empty() && extra.id == info.loadedId;
    });
    if (loaded == extras.end()) {
        const auto newId = "pitch-" + juce::Uuid().toString().substring(0, 12).toStdString() + "-src";
        const auto error = session.addExtraFile(info.trackId, newId, info.path);
        if (!error.empty()) {
            extras.erase(std::remove_if(extras.begin(), extras.end(), [&](const Session::Track::ExtraSource& extra) { return extra.id == newId; }), extras.end());
            return "Could not load the processed audio: " + juce::String::fromUTF8(error.c_str());
        }
        extras.back().preview = preview;
        info.loadedId = newId;
        std::lock_guard<std::mutex> lock(pitchProcessedMutex);
        pitchProcessed[resultId].loadedId = newId;
    } else if (!preview) {
        loaded->preview = false;
    }
    sourceId = info.loadedId;
    return {};
}

void Engine::captureRecording(TakeRecorder& take, const MixPlan& plan, int processedCount,
                              const float* in1, const float* in2, float* const* outL, float* const* outR,
                              int64_t at, int frames) {
    const int64_t takeFrame = at - recordStart.load(std::memory_order_relaxed);
    if (takeFrame < 0 || frames <= 0)
        return;
    auto& queue = take.queue();
    const auto& specs = take.specs();
    for (size_t s = 0; s < specs.size(); ++s) {
        const auto& spec = specs[s];
        if (spec.processed) {
            int found = -1;
            for (int k = 0; k < processedCount && k < static_cast<int>(plan.inputs.size()); ++k) {
                if (plan.inputs[static_cast<size_t>(k)].key == spec.key) {
                    found = k;
                    break;
                }
            }
            if (found < 0) {
                recordSkipped.fetch_add(frames, std::memory_order_relaxed);
                continue;
            }
            queue.push(static_cast<int>(s), takeFrame, outL[found], outR[found], 2, frames);
            continue;
        }
        const float* a = spec.input == 1 ? in2 : in1;
        const float* b = spec.input == 0 ? in1 : in2;
        if ((a == nullptr || b == nullptr) && frames > static_cast<int>(silentInput.size())) {
            recordSkipped.fetch_add(frames, std::memory_order_relaxed);
            continue;
        }
        queue.push(static_cast<int>(s), takeFrame, a != nullptr ? a : silentInput.data(), b != nullptr ? b : silentInput.data(),
                   spec.channels, frames);
    }
    recordCaptured.store(takeFrame + frames, std::memory_order_relaxed);
}

void Engine::publishMix() {
    auto snap = std::make_unique<MixSnapshot>();
    const auto* head = mixHead.load(std::memory_order_relaxed);
    snap->plan = session.buildPlan(head != nullptr ? &head->plan : nullptr);
    snap->state = std::make_unique<MixState>();
    prepareMixState(snap->plan, *snap->state);
    snap->timeline = session.timeline();
    snap->seq = nextSeq++;
    timelineSamples.store(snap->timeline, std::memory_order_release);
    mixHead.store(snap.get(), std::memory_order_release);
    mixHistory.push_back(std::move(snap));
    resolveSpectrumTapLocked();
    reclaimSnapshots();
}

void Engine::reclaimSnapshots() {
    const auto* head = mixHead.load(std::memory_order_relaxed);
    if (head == nullptr)
        return;
    const uint64_t inUse = callbackAttached ? audioSeq.load(std::memory_order_acquire) : head->seq;
    while (mixHistory.size() > 1 && mixHistory.front().get() != head && mixHistory.front()->seq < inUse)
        mixHistory.pop_front();
}

void Engine::detachAudioCallback() {
    // removeAudioCallback waits for a running callback to finish, so the audio thread
    // holds no snapshot pointer after this returns.
    devices.removeAudioCallback(this);
    callbackAttached = false;
    audioCurrent = nullptr;
}

namespace {
constexpr float kMeterDecay = 0.891f;   // 20 dB per second at the 50 ms meter interval
constexpr float kClipLevel = 1.0f;      // 0 dBFS
constexpr float kInputPeakHoldDecay = 0.92f; // slower than display decay for peak-hold needle
constexpr int kInputPeakHoldTicks = 20;      // ~1 s at 50 ms meter period before decaying

float dbToLinearGain(float db) {
    return std::pow(10.0f, db / 20.0f);
}

float linearToDbFS(float linear) {
    if (!(linear > 1.0e-12f))
        return -120.0f;
    return 20.0f * std::log10(linear);
}

juce::var levelVar(const juce::String& id, float peakL, float peakR, const MeterLevel& level,
                   float rmsL = 0.0f, float rmsR = 0.0f, float holdL = 0.0f, float holdR = 0.0f,
                   bool available = true) {
    auto* item = new juce::DynamicObject();
    if (id.isNotEmpty())
        item->setProperty("id", id);
    item->setProperty("available", available);
    item->setProperty("peakL", static_cast<double>(peakL));
    item->setProperty("peakR", static_cast<double>(peakR));
    item->setProperty("rmsL", static_cast<double>(rmsL));
    item->setProperty("rmsR", static_cast<double>(rmsR));
    item->setProperty("levelL", static_cast<double>(level.levelL));
    item->setProperty("levelR", static_cast<double>(level.levelR));
    item->setProperty("peakHoldL", static_cast<double>(holdL));
    item->setProperty("peakHoldR", static_cast<double>(holdR));
    item->setProperty("clip", level.clip);
    item->setProperty("peakDbFS", static_cast<double>(linearToDbFS(std::max(peakL, peakR))));
    item->setProperty("rmsDbFS", static_cast<double>(linearToDbFS(std::max(rmsL, rmsR))));
    return juce::var(item);
}

void updatePeakHold(PeakHoldState& hold, float peakL, float peakR, bool decay) {
    if (peakL >= hold.holdL) {
        hold.holdL = peakL;
        hold.ticks = kInputPeakHoldTicks;
    } else if (hold.ticks > 0) {
        --hold.ticks;
    } else if (decay) {
        hold.holdL *= kInputPeakHoldDecay;
    }
    if (peakR >= hold.holdR) {
        hold.holdR = peakR;
        hold.ticks = kInputPeakHoldTicks;
    } else if (hold.ticks <= 0 && decay) {
        hold.holdR *= kInputPeakHoldDecay;
    }
}

// Peaks gathered by one offline render, in the same shape as the live meter event.
juce::var renderedMeters(const MixPlan& plan, const MixState& state, float masterL, float masterR) {
    juce::Array<juce::var> tracks;
    juce::Array<juce::var> buses;
    auto entry = [](const std::string& id, float l, float r) {
        MeterLevel level;
        level.levelL = l;
        level.levelR = r;
        level.clip = l >= kClipLevel || r >= kClipLevel;
        return levelVar(juce::String::fromUTF8(id.c_str()), l, r, level);
    };
    for (size_t s = 0; s < plan.sources.size() && static_cast<int>(s) < state.sourceCount; ++s)
        tracks.add(entry(plan.sourceIds[s], state.sourcePeak[s * 2].load(), state.sourcePeak[s * 2 + 1].load()));
    for (size_t b = 0; b < plan.buses.size() && static_cast<int>(b) < state.busCount; ++b)
        buses.add(entry(plan.busIds[b], state.busPeak[b * 2].load(), state.busPeak[b * 2 + 1].load()));
    juce::Array<juce::var> effects;
    for (size_t e = 0; e < plan.effectIds.size() && static_cast<int>(e) < state.effectCount; ++e) {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", juce::String::fromUTF8(plan.effectIds[e].c_str()));
        item->setProperty("reduction", static_cast<double>(state.effectMeter[e].load()));
        effects.add(juce::var(item));
    }
    auto* obj = new juce::DynamicObject();
    obj->setProperty("tracks", tracks);
    obj->setProperty("buses", buses);
    obj->setProperty("effects", effects);
    obj->setProperty("master", entry({}, masterL, masterR));
    return juce::var(obj);
}
} // namespace

juce::var Engine::meterVar(bool decay) {
    struct FreshMeter {
        float peakL = 0.0f;
        float peakR = 0.0f;
        float sumSqL = 0.0f;
        float sumSqR = 0.0f;
        int samples = 0;
    };
    std::map<std::string, FreshMeter> fresh;
    auto takePeaks = [&](const std::string& key, std::atomic<float>& l, std::atomic<float>& r) {
        auto& slot = fresh[key];
        slot.peakL = std::max(slot.peakL, l.exchange(0.0f, std::memory_order_relaxed));
        slot.peakR = std::max(slot.peakR, r.exchange(0.0f, std::memory_order_relaxed));
    };
    auto takeRms = [&](const std::string& key, std::atomic<float>& sqL, std::atomic<float>& sqR, std::atomic<int>& samples) {
        auto& slot = fresh[key];
        slot.sumSqL += sqL.exchange(0.0f, std::memory_order_relaxed);
        slot.sumSqR += sqR.exchange(0.0f, std::memory_order_relaxed);
        slot.samples += samples.exchange(0, std::memory_order_relaxed);
    };
    for (auto& snap : mixHistory) {
        const auto& plan = snap->plan;
        auto& state = *snap->state;
        for (size_t s = 0; s < plan.sources.size() && static_cast<int>(s) < state.sourceCount; ++s) {
            const auto key = "t:" + plan.sourceIds[s];
            takePeaks(key, state.sourcePeak[s * 2], state.sourcePeak[s * 2 + 1]);
            if (state.sourceSumSq && state.sourceSamples)
                takeRms(key, state.sourceSumSq[s * 2], state.sourceSumSq[s * 2 + 1], state.sourceSamples[s]);
        }
        for (size_t b = 0; b < plan.buses.size() && static_cast<int>(b) < state.busCount; ++b) {
            const auto key = "b:" + plan.busIds[b];
            takePeaks(key, state.busPeak[b * 2], state.busPeak[b * 2 + 1]);
            if (state.busSumSq && state.busSamples)
                takeRms(key, state.busSumSq[b * 2], state.busSumSq[b * 2 + 1], state.busSamples[b]);
        }
        for (size_t e = 0; e < plan.effectIds.size() && static_cast<int>(e) < state.effectCount; ++e) {
            auto& slot = fresh["f:" + plan.effectIds[e]];
            slot.peakL = std::max(slot.peakL, state.effectMeter[e].exchange(0.0f, std::memory_order_relaxed));
        }
    }
    const float factor = decay ? kMeterDecay : 0.0f;
    auto update = [&](MeterLevel& level, float l, float r) {
        level.levelL = std::max(l, level.levelL * factor);
        level.levelR = std::max(r, level.levelR * factor);
        level.clip = level.clip || l >= kClipLevel || r >= kClipLevel;
    };
    juce::Array<juce::var> tracks;
    juce::Array<juce::var> buses;
    juce::Array<juce::var> effects;
    std::map<std::string, MeterLevel> kept;
    std::map<std::string, PeakHoldState> keptHolds;
    const bool metersAvailable = deviceOpen.load(std::memory_order_relaxed);
    if (const auto* head = mixHead.load(std::memory_order_relaxed)) {
        auto emit = [&](const std::string& prefix, const std::string& id, juce::Array<juce::var>& out) {
            const auto key = prefix + id;
            auto level = meterLevels[key];
            const auto& meter = fresh[key];
            update(level, meter.peakL, meter.peakR);
            kept[key] = level;
            auto hold = stripPeakHolds[key];
            updatePeakHold(hold, meter.peakL, meter.peakR, decay);
            keptHolds[key] = hold;
            const float rmsL = meter.samples > 0 ? std::sqrt(meter.sumSqL / static_cast<float>(meter.samples)) : 0.0f;
            const float rmsR = meter.samples > 0 ? std::sqrt(meter.sumSqR / static_cast<float>(meter.samples)) : 0.0f;
            out.add(levelVar(juce::String::fromUTF8(id.c_str()), meter.peakL, meter.peakR, level,
                             rmsL, rmsR, hold.holdL, hold.holdR, metersAvailable));
        };
        for (const auto& id : head->plan.sourceIds)
            emit("t:", id, tracks);
        for (const auto& id : head->plan.busIds)
            emit("b:", id, buses);
        for (const auto& id : head->plan.effectIds) {
            auto* item = new juce::DynamicObject();
            item->setProperty("id", juce::String::fromUTF8(id.c_str()));
            item->setProperty("reduction", static_cast<double>(fresh["f:" + id].peakL));
            effects.add(juce::var(item));
        }
    }
    meterLevels = std::move(kept);
    stripPeakHolds = std::move(keptHolds);
    const float masterL = peakL.exchange(0.0f);
    const float masterR = peakR.exchange(0.0f);
    const float masterSqL = masterSumSqL.exchange(0.0f, std::memory_order_relaxed);
    const float masterSqR = masterSumSqR.exchange(0.0f, std::memory_order_relaxed);
    const int masterSamples = masterMeterSamples.exchange(0, std::memory_order_relaxed);
    update(masterMeter, masterL, masterR);
    updatePeakHold(masterPeakHold, masterL, masterR, decay);
    const float masterRmsL = masterSamples > 0 ? std::sqrt(masterSqL / static_cast<float>(masterSamples)) : 0.0f;
    const float masterRmsR = masterSamples > 0 ? std::sqrt(masterSqR / static_cast<float>(masterSamples)) : 0.0f;

    // Input capture meter (post software input gain). RMS from summed squares / sample count.
    const float inPeakL = inputPeakL.exchange(0.0f, std::memory_order_relaxed);
    const float inPeakR = inputPeakR.exchange(0.0f, std::memory_order_relaxed);
    const float sumSqL = inputSumSqL.exchange(0.0f, std::memory_order_relaxed);
    const float sumSqR = inputSumSqR.exchange(0.0f, std::memory_order_relaxed);
    const int inSamples = inputMeterSamples.exchange(0, std::memory_order_relaxed);
    const bool inputAvailable = inputMeterAvailable.load(std::memory_order_relaxed);
    update(inputMeter, inPeakL, inPeakR);
    if (inPeakL >= inputPeakHoldL) {
        inputPeakHoldL = inPeakL;
        inputPeakHoldTicks = kInputPeakHoldTicks;
    } else if (inputPeakHoldTicks > 0) {
        --inputPeakHoldTicks;
    } else if (decay) {
        inputPeakHoldL *= kInputPeakHoldDecay;
    }
    if (inPeakR >= inputPeakHoldR) {
        inputPeakHoldR = inPeakR;
        inputPeakHoldTicks = kInputPeakHoldTicks;
    } else if (inputPeakHoldTicks <= 0 && decay) {
        inputPeakHoldR *= kInputPeakHoldDecay;
    }
    const float rmsL = inSamples > 0 ? std::sqrt(sumSqL / static_cast<float>(inSamples)) : 0.0f;
    const float rmsR = inSamples > 0 ? std::sqrt(sumSqR / static_cast<float>(inSamples)) : 0.0f;
    auto* inputObj = new juce::DynamicObject();
    inputObj->setProperty("available", inputAvailable);
    // Virtual test input is always stereo; otherwise report open device channel count.
    inputObj->setProperty("channels",
                          virtualOn.load(std::memory_order_relaxed)
                              ? 2
                              : inputChannels.load(std::memory_order_relaxed));
    inputObj->setProperty("peakL", static_cast<double>(inPeakL));
    inputObj->setProperty("peakR", static_cast<double>(inPeakR));
    inputObj->setProperty("rmsL", static_cast<double>(rmsL));
    inputObj->setProperty("rmsR", static_cast<double>(rmsR));
    inputObj->setProperty("levelL", static_cast<double>(inputMeter.levelL));
    inputObj->setProperty("levelR", static_cast<double>(inputMeter.levelR));
    inputObj->setProperty("peakHoldL", static_cast<double>(inputPeakHoldL));
    inputObj->setProperty("peakHoldR", static_cast<double>(inputPeakHoldR));
    inputObj->setProperty("clip", inputMeter.clip);
    inputObj->setProperty("peakDbFS", static_cast<double>(linearToDbFS(std::max(inPeakL, inPeakR))));
    inputObj->setProperty("rmsDbFS", static_cast<double>(linearToDbFS(std::max(rmsL, rmsR))));
    inputObj->setProperty("gainDb", static_cast<double>(inputGainDb.load(std::memory_order_relaxed)));

    auto* obj = new juce::DynamicObject();
    obj->setProperty("v", 1);
    obj->setProperty("event", "meter");
    obj->setProperty("peakL", static_cast<double>(masterL));
    obj->setProperty("peakR", static_cast<double>(masterR));
    obj->setProperty("master", levelVar({}, masterL, masterR, masterMeter,
                                        masterRmsL, masterRmsR, masterPeakHold.holdL, masterPeakHold.holdR,
                                        metersAvailable));
    obj->setProperty("tracks", tracks);
    obj->setProperty("buses", buses);
    obj->setProperty("effects", effects);
    obj->setProperty("input", juce::var(inputObj));

    // Phase 2.8.3 spectrum (control-thread FFT on captured post-insert samples).
    auto* spectrumObj = new juce::DynamicObject();
    const int tapKind = spectrumKind.load(std::memory_order_relaxed);
    const int tapIndex = spectrumIndex.load(std::memory_order_relaxed);
    const bool tapOk = tapKind != static_cast<int>(SpectrumTapKind::none)
        && (tapKind == static_cast<int>(SpectrumTapKind::master) || tapIndex >= 0)
        && metersAvailable && spectrumPrepared;
    bool haveSpectrum = false;
    if (tapOk)
        haveSpectrum = spectrumAnalyzer.process(spectrumCapture, static_cast<double>(std::max(1, sampleRate.load())),
                                                true, spectrumDb, spectrumHz);
    spectrumObj->setProperty("available", haveSpectrum);
    spectrumObj->setProperty("fftSize", kSpectrumFftSize);
    spectrumObj->setProperty("target", juce::String::fromUTF8(spectrumTarget.c_str()));
    spectrumObj->setProperty("ownerId", juce::String::fromUTF8(spectrumOwnerId.c_str()));
    spectrumObj->setProperty("tap", tapKind == static_cast<int>(SpectrumTapKind::track) ? "track-post-insert-pre-fader"
                               : tapKind == static_cast<int>(SpectrumTapKind::bus) ? "bus-post-insert-pre-fader"
                               : tapKind == static_cast<int>(SpectrumTapKind::master) ? "master-post-insert-pre-fader"
                               : "none");
    juce::Array<juce::var> mags;
    juce::Array<juce::var> freqs;
    if (haveSpectrum) {
        for (size_t i = 0; i < spectrumDb.size(); ++i) {
            mags.add(static_cast<double>(spectrumDb[i]));
            freqs.add(static_cast<double>(spectrumHz[i]));
        }
    }
    spectrumObj->setProperty("magnitudesDb", mags);
    spectrumObj->setProperty("frequenciesHz", freqs);
    obj->setProperty("spectrum", juce::var(spectrumObj));
    return juce::var(obj);
}

void Engine::openDevices(const juce::String& outputName, const juce::String& inputName, double requestedRate, int requestedBuffer) {
    detachAudioCallback();
    deviceOpen.store(false);
    deviceFault.store(false);
    spectrumCapture.clear();

    bool foundWasapi = false;
    for (auto* type : devices.getAvailableDeviceTypes()) {
        if (type != nullptr && type->getTypeName() == "Windows Audio")
            foundWasapi = true;
    }
    if (!foundWasapi) {
        // initialise() creates the platform device types the first time.
        devices.initialise(0, 0, nullptr, false);
        for (auto* type : devices.getAvailableDeviceTypes()) {
            if (type != nullptr && type->getTypeName() == "Windows Audio")
                foundWasapi = true;
        }
    }
    if (foundWasapi)
        devices.setCurrentAudioDeviceType("Windows Audio", true);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    setup.outputDeviceName = outputName;
    setup.inputDeviceName = inputName;
    setup.sampleRate = requestedRate;
    setup.bufferSize = requestedBuffer;
    setup.useDefaultInputChannels = true;
    setup.useDefaultOutputChannels = true;

    juce::String error = devices.initialise(2, 2, nullptr, true, {}, &setup);
    bool inputFallback = false;
    if (error.isNotEmpty()) {
        setup.inputDeviceName.clear();
        error = devices.initialise(0, 2, nullptr, true, {}, &setup);
        inputFallback = error.isEmpty();
    }

    auto* device = devices.getCurrentAudioDevice();
    if (error.isNotEmpty() || device == nullptr) {
        deviceError = error.isNotEmpty() ? error : juce::String("No audio output device is available.");
        deviceOpen.store(false);
        inputChannels.store(0);
        outputChannels.store(0);
        std::cerr << "Audio device: " << deviceError << '\n';
        return;
    }

    const int actualRate = static_cast<int>(std::lround(device->getCurrentSampleRate()));
    const int actualBuffer = device->getCurrentBufferSizeSamples();
    sampleRate.store(actualRate > 0 ? actualRate : 48000);
    bufferSize.store(actualBuffer > 0 ? actualBuffer : requestedBuffer);
    outputLatencySamples.store(device->getOutputLatencyInSamples());
    inputChannels.store(device->getActiveInputChannels().countNumberOfSetBits());
    outputChannels.store(device->getActiveOutputChannels().countNumberOfSetBits());
    outputDeviceName = device->getName();
    if (auto* type = devices.getCurrentDeviceTypeObject())
        inputDeviceName = inputFallback ? juce::String() : device->getName();
    // Input and output can be the same endpoint name under WASAPI shared mode.
    // Keep the requested input name when channels are open so the UI can show it.
    if (inputChannels.load() > 0 && inputName.isNotEmpty() && !inputFallback)
        inputDeviceName = inputName;
    else if (inputChannels.load() == 0)
        inputDeviceName.clear();

    if (std::abs(session.playbackRate - static_cast<double>(sampleRate.load())) > 0.5) {
        auto retiredBuffers = session.setPlaybackRate(static_cast<double>(sampleRate.load()));
        if (!retiredBuffers.error.empty()) {
            deviceError = juce::String::fromUTF8(retiredBuffers.error.c_str());
            devices.closeAudioDevice();
            deviceOpen.store(false);
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
    }

    deviceError.clear();
    if (inputFallback && inputName.isNotEmpty())
        deviceError = "The input device could not be opened. Output playback is still available and microphone monitoring stays off.";
    if (liveDspConfig.enabled) {
        const auto stageError = configureLiveDsp();
        if (stageError.isNotEmpty())
            std::cerr << "Live DSP stage: " << stageError << '\n';
    }
    if (livePitchConfig.enabled) {
        const auto pitchError = configureLivePitch();
        if (pitchError.isNotEmpty())
            std::cerr << "Live pitch: " << pitchError << '\n';
    }
    deviceOpen.store(true);
    callbackAttached = true;
    devices.addAudioCallback(this);
    applyLatencyProfileForDevices();
    std::cerr << "Audio device open: " << outputDeviceName
              << " rate=" << sampleRate.load()
              << " buffer=" << bufferSize.load()
              << " inCh=" << inputChannels.load()
              << " latencySamples=" << outputLatencySamples.load() << '\n';
}

void Engine::start() {
    session.playbackRate = 48000.0;
    publishMix();
    openDevices({}, {}, 48000.0, 512);
    startTimer(50);
    auto* ready = new juce::DynamicObject();
    ready->setProperty("v", 1);
    ready->setProperty("event", "ready");
    ready->setProperty("deviceOpen", deviceOpen.load());
    ready->setProperty("message", deviceError);
    writeJson(juce::var(ready));
}

juce::var Engine::stateVar() const {
    auto* obj = new juce::DynamicObject();
    const auto mode = modeFromInt(transport.load());
    const int rate = std::max(1, sampleRate.load());
    obj->setProperty("transport", modeName(mode));
    // During an effect tail the clock runs past the timeline; the UI sees it parked at the end.
    // While recording the timeline grows with the take.
    obj->setProperty("position", static_cast<double>(std::min(position.load(), displayTimeline())) / static_cast<double>(rate));
    obj->setProperty("duration", static_cast<double>(displayTimeline()) / static_cast<double>(rate));
    obj->setProperty("renderTail", tailVar(session.renderTail));
    obj->setProperty("sampleRate", sampleRate.load());
    obj->setProperty("bufferSize", bufferSize.load());
    obj->setProperty("masterGain", static_cast<double>(masterGain.load()));
    obj->setProperty("inputGainDb", static_cast<double>(inputGainDb.load(std::memory_order_relaxed)));
    obj->setProperty("monitor", monitor.load());
    obj->setProperty("deviceOpen", deviceOpen.load());
    obj->setProperty("outputDevice", outputDeviceName);
    obj->setProperty("inputDevice", inputDeviceName);
    obj->setProperty("inputChannels", inputChannels.load());
    obj->setProperty("outputChannels", outputChannels.load());
    obj->setProperty("reportedLatencyMs", outputLatencySamples.load() * 1000.0 / static_cast<double>(rate));
    obj->setProperty("deviceError", deviceFault.load() && faultMessage.isNotEmpty() ? faultMessage : deviceError);
    obj->setProperty("canUndo", session.canUndo());
    obj->setProperty("canRedo", session.canRedo());
    obj->setProperty("projectId", juce::String::fromUTF8(session.projectId.c_str()));
    obj->setProperty("projectName", juce::String::fromUTF8(session.projectName.c_str()));
    juce::Array<juce::var> tracks;
    for (const auto& track : session.tracks) {
        if (!track.used)
            continue;
        auto* item = new juce::DynamicObject();
        item->setProperty("id", juce::String::fromUTF8(track.id.c_str()));
        item->setProperty("name", juce::String::fromUTF8((track.name.empty() ? track.id : track.name).c_str()));
        item->setProperty("path", juce::String::fromUTF8(track.path.c_str()));
        item->setProperty("gain", track.gain);
        item->setProperty("pan", track.pan);
        item->setProperty("mute", track.mute);
        item->setProperty("solo", track.solo);
        item->setProperty("duration", track.sourceSampleRate > 0.0
                              ? static_cast<double>(track.sourceLeft.size()) / track.sourceSampleRate
                              : 0.0);
        item->setProperty("sourceSampleRate", track.sourceSampleRate);
        item->setProperty("channels", track.sourceChannels);
        item->setProperty("missing", track.missing);
        item->setProperty("error", juce::String::fromUTF8(track.error.c_str()));
        {
            juce::Array<juce::var> sources;
            auto* primary = new juce::DynamicObject();
            primary->setProperty("id", juce::String::fromUTF8((track.id + "-src").c_str()));
            primary->setProperty("path", juce::String::fromUTF8(track.path.c_str()));
            primary->setProperty("kind", "primary");
            primary->setProperty("missing", track.missing);
            primary->setProperty("error", juce::String::fromUTF8(track.error.c_str()));
            primary->setProperty("sampleRate", track.sourceSampleRate);
            primary->setProperty("channels", track.sourceChannels);
            primary->setProperty("duration", track.sourceSampleRate > 0.0
                                  ? static_cast<double>(track.sourceLeft.size()) / track.sourceSampleRate
                                  : 0.0);
            sources.add(juce::var(primary));
            for (const auto& extra : track.extras) {
                if (extra.preview)
                    continue;
                auto* src = new juce::DynamicObject();
                src->setProperty("id", juce::String::fromUTF8(extra.id.c_str()));
                src->setProperty("path", juce::String::fromUTF8(extra.path.c_str()));
                src->setProperty("kind", "extra");
                src->setProperty("missing", extra.missing);
                src->setProperty("error", juce::String::fromUTF8(extra.error.c_str()));
                src->setProperty("sampleRate", extra.sampleRate);
                src->setProperty("channels", extra.channels);
                src->setProperty("duration", extra.sampleRate > 0.0
                                      ? static_cast<double>(extra.originalLeft.size()) / extra.sampleRate
                                      : 0.0);
                sources.add(juce::var(src));
            }
            item->setProperty("sources", sources);
        }
        const double rate = std::max(1, sampleRate.load());
        juce::Array<juce::var> clips;
        for (const auto& clip : track.clips) {
            auto* clipObj = new juce::DynamicObject();
            clipObj->setProperty("id", juce::String::fromUTF8(clip.id.c_str()));
            clipObj->setProperty("sourceFileId", juce::String::fromUTF8(clip.sourceFileId.c_str()));
            clipObj->setProperty("timelineStart", static_cast<double>(clip.timelineStart) / rate);
            clipObj->setProperty("sourceOffset", static_cast<double>(clip.sourceOffset) / rate);
            clipObj->setProperty("duration", static_cast<double>(clip.duration) / rate);
            clipObj->setProperty("fadeIn", static_cast<double>(clip.fadeIn) / rate);
            clipObj->setProperty("fadeOut", static_cast<double>(clip.fadeOut) / rate);
            clipObj->setProperty("timelineStartSamples", clip.timelineStart);
            clipObj->setProperty("sourceOffsetSamples", clip.sourceOffset);
            clipObj->setProperty("durationSamples", clip.duration);
            clipObj->setProperty("fadeInSamples", clip.fadeIn);
            clipObj->setProperty("fadeOutSamples", clip.fadeOut);
            clipObj->setProperty("fadeInCurve", juce::String(msp::fadeCurveName(clip.fadeInCurve)));
            clipObj->setProperty("fadeOutCurve", juce::String(msp::fadeCurveName(clip.fadeOutCurve)));
            if (!clip.crossfadePartnerId.empty()) {
                clipObj->setProperty("crossfadePartnerId", juce::String::fromUTF8(clip.crossfadePartnerId.c_str()));
                clipObj->setProperty("crossfadeCurve", juce::String(msp::fadeCurveName(clip.crossfadeCurve)));
                clipObj->setProperty("crossfadeDuration", static_cast<double>(clip.crossfadeDuration) / rate);
                clipObj->setProperty("crossfadeDurationSamples", clip.crossfadeDuration);
            }
            clipObj->setProperty("gain", clip.gain);
            if (!clip.originalSourceFileId.empty()) {
                clipObj->setProperty("originalSourceFileId", juce::String::fromUTF8(clip.originalSourceFileId.c_str()));
                clipObj->setProperty("originalSourceOffset", static_cast<double>(clip.originalSourceOffset) / rate);
                clipObj->setProperty("pitchShiftCents", clip.pitchShiftCents);
                if (!clip.pitchLabel.empty())
                    clipObj->setProperty("pitchLabel", juce::String::fromUTF8(clip.pitchLabel.c_str()));
            }
            if (!clip.noteTargets.empty())
                clipObj->setProperty("noteTargets", noteTargetsVar(clip.noteTargets));
            if (!clip.timingMarkers.empty()) {
                juce::Array<juce::var> markers;
                for (const auto& marker : clip.timingMarkers) {
                    auto* item = new juce::DynamicObject();
                    item->setProperty("id", juce::String::fromUTF8(marker.id.c_str()));
                    item->setProperty("sourceSample", static_cast<juce::int64>(marker.sourceSample));
                    item->setProperty("timeline", static_cast<double>(clip.timelineStart + (marker.sourceSample - clip.sourceOffset)) / rate);
                    item->setProperty("manual", marker.manual);
                    markers.add(juce::var(item));
                }
                clipObj->setProperty("timingMarkers", markers);
            }
            if (!clip.timingOriginalSourceFileId.empty()) {
                clipObj->setProperty("timingOriginalSourceFileId", juce::String::fromUTF8(clip.timingOriginalSourceFileId.c_str()));
                clipObj->setProperty("timingOriginalSourceOffset", static_cast<double>(clip.timingOriginalSourceOffset) / rate);
                clipObj->setProperty("timingOriginalDuration", static_cast<double>(clip.timingOriginalDuration) / rate);
                if (!clip.timingLabel.empty())
                    clipObj->setProperty("timingLabel", juce::String::fromUTF8(clip.timingLabel.c_str()));
            }
            if (!clip.breathRegions.empty()) {
                juce::Array<juce::var> regions;
                for (const auto& region : clip.breathRegions) {
                    auto* item = new juce::DynamicObject();
                    item->setProperty("id", juce::String::fromUTF8(region.id.c_str()));
                    item->setProperty("sourceStart", static_cast<juce::int64>(region.sourceStart));
                    item->setProperty("sourceEnd", static_cast<juce::int64>(region.sourceEnd));
                    item->setProperty("timelineStart", static_cast<double>(clip.timelineStart + (region.sourceStart - clip.sourceOffset)) / rate);
                    item->setProperty("timelineEnd", static_cast<double>(clip.timelineStart + (region.sourceEnd - clip.sourceOffset)) / rate);
                    item->setProperty("kind", juce::String(msp::breathKindName(region.kind)));
                    item->setProperty("confidence", region.confidence);
                    item->setProperty("gainDb", region.gainDb);
                    item->setProperty("fadeIn", static_cast<double>(region.fadeIn) / rate);
                    item->setProperty("fadeOut", static_cast<double>(region.fadeOut) / rate);
                    item->setProperty("ignored", region.ignored);
                    item->setProperty("manual", region.manual);
                    regions.add(juce::var(item));
                }
                clipObj->setProperty("breathRegions", regions);
            }
            if (!clip.breathOriginalSourceFileId.empty()) {
                clipObj->setProperty("breathOriginalSourceFileId", juce::String::fromUTF8(clip.breathOriginalSourceFileId.c_str()));
                clipObj->setProperty("breathOriginalSourceOffset", static_cast<double>(clip.breathOriginalSourceOffset) / rate);
                clipObj->setProperty("breathOriginalDuration", static_cast<double>(clip.breathOriginalDuration) / rate);
                if (!clip.breathLabel.empty())
                    clipObj->setProperty("breathLabel", juce::String::fromUTF8(clip.breathLabel.c_str()));
            }
            if (!clip.stretchOriginalSourceFileId.empty() || !clip.stretchMode.empty()) {
                if (!clip.stretchMode.empty())
                    clipObj->setProperty("stretchMode", juce::String::fromUTF8(clip.stretchMode.c_str()));
                clipObj->setProperty("stretchRatio", clip.stretchRatio);
                if (!clip.stretchOriginalSourceFileId.empty()) {
                    clipObj->setProperty("stretchOriginalSourceFileId", juce::String::fromUTF8(clip.stretchOriginalSourceFileId.c_str()));
                    clipObj->setProperty("stretchOriginalSourceOffset", static_cast<double>(clip.stretchOriginalSourceOffset) / rate);
                    clipObj->setProperty("stretchOriginalDuration", static_cast<double>(clip.stretchOriginalDuration) / rate);
                }
                if (!clip.stretchLabel.empty())
                    clipObj->setProperty("stretchLabel", juce::String::fromUTF8(clip.stretchLabel.c_str()));
            }
            clips.add(juce::var(clipObj));
        }
        item->setProperty("clips", clips);
        item->setProperty("output", juce::String::fromUTF8(track.output.c_str()));
        juce::Array<juce::var> sends;
        for (const auto& send : track.sends) {
            auto* sendObj = new juce::DynamicObject();
            sendObj->setProperty("bus", juce::String::fromUTF8(send.bus.c_str()));
            sendObj->setProperty("level", send.level);
            sendObj->setProperty("preFader", send.preFader);
            sends.add(juce::var(sendObj));
        }
        item->setProperty("sends", sends);
        item->setProperty("effects", effectsVar(track.effects));
        item->setProperty("automation", automationVar(track.automation, rate));
        if (!track.vocalPresetId.empty()) {
            item->setProperty("vocalPresetId", juce::String::fromUTF8(track.vocalPresetId.c_str()));
            item->setProperty("vocalPresetBypassed", track.vocalPresetBypassed);
        }
        item->setProperty("armed", track.armed);
        item->setProperty("recordInput", recordInputName(track.recordInput));
        item->setProperty("recordMode", recordModeName(track.recordMode));
        item->setProperty("monitorInput", track.monitorInput);
        item->setProperty("takesExpanded", track.takesExpanded);
        item->setProperty("compCrossfadeMs", rate > 0
                              ? 1000.0 * static_cast<double>(session.compCrossfadeSamplesFor(track)) / static_cast<double>(rate)
                              : msp::kDefaultCompCrossfadeMs);
        item->setProperty("autoCrossfadeEnabled", track.autoCrossfadeEnabled);
        item->setProperty("autoCrossfadeMs", track.autoCrossfadeMs);
        item->setProperty("autoCrossfadeCurve", juce::String(msp::fadeCurveName(track.autoCrossfadeCurve)));
        juce::Array<juce::var> takes;
        for (const auto& take : track.takes) {
            auto* takeObj = new juce::DynamicObject();
            takeObj->setProperty("id", juce::String::fromUTF8(take.id.c_str()));
            takeObj->setProperty("name", juce::String::fromUTF8(take.name.c_str()));
            takeObj->setProperty("sourceFileId", juce::String::fromUTF8(take.sourceFileId.c_str()));
            takeObj->setProperty("timelineStart", static_cast<double>(take.timelineStart) / rate);
            takeObj->setProperty("duration", static_cast<double>(take.duration) / rate);
            takeObj->setProperty("timelineStartSamples", static_cast<juce::int64>(take.timelineStart));
            takeObj->setProperty("durationSamples", static_cast<juce::int64>(take.duration));
            takeObj->setProperty("muted", take.muted);
            takes.add(juce::var(takeObj));
        }
        item->setProperty("takes", takes);
        tracks.add(juce::var(item));
    }
    obj->setProperty("tracks", tracks);
    {
        juce::Array<juce::var> presets;
        for (const auto& preset : session.listVocalPresets()) {
            auto* presetObj = new juce::DynamicObject();
            presetObj->setProperty("id", juce::String::fromUTF8(preset.id.c_str()));
            presetObj->setProperty("name", juce::String::fromUTF8(preset.name.c_str()));
            presetObj->setProperty("factory", preset.factory);
            juce::Array<juce::var> chain;
            for (const auto& effect : preset.effects) {
                auto* effectObj = new juce::DynamicObject();
                effectObj->setProperty("type", effectTypeName(effect.type));
                effectObj->setProperty("enabled", effect.enabled);
                chain.add(juce::var(effectObj));
            }
            presetObj->setProperty("effects", chain);
            presets.add(juce::var(presetObj));
        }
        obj->setProperty("vocalPresets", presets);
    }
    obj->setProperty("masterEffects", effectsVar(session.masterEffects));
    obj->setProperty("masterAutomation", automationVar(session.masterAutomation, static_cast<double>(rate)));
    juce::Array<juce::var> buses;
    for (const auto& bus : session.buses) {
        auto* item = new juce::DynamicObject();
        item->setProperty("id", juce::String::fromUTF8(bus.id.c_str()));
        item->setProperty("name", juce::String::fromUTF8(bus.name.c_str()));
        item->setProperty("kind", busKindName(bus.kind));
        item->setProperty("gain", bus.gain);
        item->setProperty("mute", bus.mute);
        item->setProperty("solo", bus.solo);
        item->setProperty("output", juce::String::fromUTF8(bus.output.c_str()));
        item->setProperty("effects", effectsVar(bus.effects));
        item->setProperty("automation", automationVar(bus.automation, static_cast<double>(rate)));
        buses.add(juce::var(item));
    }
    obj->setProperty("buses", buses);
    auto* record = new juce::DynamicObject();
    const double recordRate = static_cast<double>(rate);
    record->setProperty("state", recorder != nullptr ? "recording" : "idle");
    record->setProperty("folder", recordFolder.getFullPathName());
    record->setProperty("startSeconds", recorder != nullptr ? static_cast<double>(recordStart.load()) / recordRate : 0.0);
    record->setProperty("elapsedSeconds", recorder != nullptr ? static_cast<double>(recordCaptured.load()) / recordRate : 0.0);
    record->setProperty("droppedFrames", recorder != nullptr ? static_cast<juce::int64>(recorder->queue().droppedFrames()) : static_cast<juce::int64>(0));
    record->setProperty("maxSeconds", static_cast<double>(kMaxRecordFrames) / recordRate);
    auto* virtualObj = new juce::DynamicObject();
    virtualObj->setProperty("enabled", virtualOn.load());
    virtualObj->setProperty("frequency", virtualFrequency.load());
    virtualObj->setProperty("level", static_cast<double>(virtualLevel.load()));
    record->setProperty("virtualInput", juce::var(virtualObj));
    record->setProperty("lastTake", lastTake);
    record->setProperty("latency", recordingLatencyVar());
    obj->setProperty("record", juce::var(record));
    auto* pitch = new juce::DynamicObject();
    pitch->setProperty("processedFolder", processedFolder.getFullPathName());
    if (session.pitchPreview.trackId.empty()) {
        pitch->setProperty("preview", juce::var());
    } else {
        auto* preview = new juce::DynamicObject();
        preview->setProperty("resultId", session.pitchPreview.resultId);
        preview->setProperty("trackId", juce::String::fromUTF8(session.pitchPreview.trackId.c_str()));
        preview->setProperty("clipId", juce::String::fromUTF8(session.pitchPreview.clipId.c_str()));
        preview->setProperty("sourceFileId", juce::String::fromUTF8(session.pitchPreview.sourceId.c_str()));
        pitch->setProperty("preview", juce::var(preview));
    }
    pitch->setProperty("mapping", mappingSettingsVar(session.pitchMapping));
    obj->setProperty("pitch", juce::var(pitch));
    // Phase 2.6.5 — vocal workflow status (derived; no schema change).
    {
        auto* workflow = new juce::DynamicObject();
        juce::Array<juce::var> order;
        for (const char* stage : { "record", "comp", "timing", "breath", "pitch", "presets", "mix" })
            order.add(juce::String(stage));
        workflow->setProperty("order", order);
        auto* previews = new juce::DynamicObject();
        previews->setProperty("pitch", !session.pitchPreview.trackId.empty());
        previews->setProperty("breath", !session.breathPreview.trackId.empty());
        previews->setProperty("preset", !session.vocalPresetPreview.trackId.empty());
        if (!session.pitchPreview.trackId.empty()) {
            previews->setProperty("pitchTrackId", juce::String::fromUTF8(session.pitchPreview.trackId.c_str()));
            previews->setProperty("pitchClipId", juce::String::fromUTF8(session.pitchPreview.clipId.c_str()));
        }
        if (!session.breathPreview.trackId.empty()) {
            previews->setProperty("breathTrackId", juce::String::fromUTF8(session.breathPreview.trackId.c_str()));
            previews->setProperty("breathClipId", juce::String::fromUTF8(session.breathPreview.clipId.c_str()));
        }
        if (!session.vocalPresetPreview.trackId.empty())
            previews->setProperty("presetTrackId", juce::String::fromUTF8(session.vocalPresetPreview.trackId.c_str()));
        workflow->setProperty("previews", juce::var(previews));
        workflow->setProperty("liveAutoTuneInExport", false);
        workflow->setProperty("note",
            "Processing order: source → comp → timing → breath → offline pitch → clip gain/fades → "
            "track FX/presets → mix/export. Live Auto-Tune is monitor/record only and is not exported.");
        obj->setProperty("vocalWorkflow", juce::var(workflow));
    }
    return juce::var(obj);
}

int64_t Engine::displayTimeline() const {
    const int64_t timeline = std::max<int64_t>(0, timelineSamples.load());
    if (recorder == nullptr)
        return timeline;
    return std::max(timeline, position.load());
}

void Engine::settleAudio() {
    // Waits until the audio thread has switched to the newest snapshot and has had time to
    // finish its 10 ms crossfades. Only needed while audio is actually flowing.
    const auto* head = mixHead.load(std::memory_order_relaxed);
    if (head == nullptr || !callbackAttached || !deviceOpen.load() || modeFromInt(transport.load()) != TransportMode::playing)
        return;
    const double started = juce::Time::getMillisecondCounterHiRes();
    while (audioSeq.load(std::memory_order_acquire) < head->seq && juce::Time::getMillisecondCounterHiRes() - started < 300.0)
        juce::Thread::sleep(1);
    const double blockMs = 1000.0 * bufferSize.load() / std::max(1, sampleRate.load());
    juce::Thread::sleep(static_cast<int>(std::ceil(12.0 + 2.0 * blockMs)));
}

void Engine::waitForAudioSnapshot() {
    // Waits (at most 300 ms) until the running callback has switched to the newest snapshot.
    const auto* head = mixHead.load(std::memory_order_relaxed);
    if (head == nullptr || !callbackAttached || !deviceOpen.load())
        return;
    const double started = juce::Time::getMillisecondCounterHiRes();
    while (audioSeq.load(std::memory_order_acquire) < head->seq && juce::Time::getMillisecondCounterHiRes() - started < 300.0)
        juce::Thread::sleep(1);
}

void Engine::endCapture() {
    captureOn.store(false);
    while (captureWriters.load() != 0)
        juce::Thread::sleep(1);
}

void Engine::retireLiveDsp() {
    // After the store no new callback can pick the processor up; a callback that already holds
    // it is counted in liveDspUsers and finishes within one block.
    liveDspLive.store(nullptr);
    while (liveDspUsers.load() != 0)
        juce::Thread::sleep(1);
    liveCorrection = nullptr;
    liveDsp.reset();
}

juce::String Engine::configureLiveDsp() {
    retireLiveDsp();
    liveDspSkipped.store(0);
    if (!liveDspConfig.enabled)
        return {};
    RealtimeOptions options;
    options.blockSize = liveDspConfig.correction ? 0 : liveDspConfig.blockSize;
    options.fadeMs = liveDspConfig.fadeMs;
    std::unique_ptr<RealtimeKernel> kernel;
    PitchCorrectionKernel* correction = nullptr;
    if (liveDspConfig.correction) {
        auto corrector = std::make_unique<PitchCorrectionKernel>(liveDspConfig.correctionSettings, liveDspConfig.correctionParams);
        correction = corrector.get();
        kernel = std::move(corrector);
    } else {
        kernel = std::make_unique<PassThroughKernel>(liveDspConfig.latencySamples);
    }
    auto processor = std::make_unique<RealtimeProcessor>(std::move(kernel), options);
    processor->setBypassed(liveDspConfig.bypassed);
    const int maxBlock = std::clamp(bufferSize.load(), 1, kMaxInputBlock);
    const auto error = processor->prepare(static_cast<double>(std::max(8000, sampleRate.load())), maxBlock, 2);
    if (!error.empty()) {
        liveDspConfig.enabled = false;
        liveDspConfig.correction = false;
        return juce::String::fromUTF8(error.c_str());
    }
    liveDsp = std::move(processor);
    liveCorrection = correction;
    // RAW track monitoring is delayed by the same DSP latency so mode switches stay time-aligned
    // with the corrected feed; recording still uses the post-stage buffers only.
    monitorRawDelay = AudioRing {};
    if (correction != nullptr) {
        const int latency = liveDsp->latencySamples();
        const auto delayError = monitorRawDelay.allocate(2, latency + maxBlock);
        if (!delayError.empty()) {
            retireLiveDsp();
            liveDspConfig.enabled = false;
            liveDspConfig.correction = false;
            return juce::String::fromUTF8(delayError.c_str());
        }
        if (latency > 0)
            monitorRawDelay.writeSilence(latency);
        monitorFadeSamples = std::max(1, liveDsp->fadeSamples());
        monitorMix = liveDspConfig.monitorMode == LiveDspConfig::MonitorMode::raw ? 0.0f : 1.0f;
        liveMonitorMode.store(liveDspConfig.monitorMode == LiveDspConfig::MonitorMode::raw ? 1 : 0, std::memory_order_release);
    } else {
        monitorFadeSamples = 1;
        monitorMix = 1.0f;
        liveMonitorMode.store(0, std::memory_order_release);
    }
    liveDspLive.store(liveDsp.get());
    return {};
}

juce::var Engine::liveDspVar() const {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("enabled", liveDspConfig.enabled && liveDsp != nullptr);
    obj->setProperty("bypassed", liveDspConfig.bypassed);
    obj->setProperty("processor", liveDspConfig.correction && liveDsp != nullptr ? "pitchCorrection" : "passThrough");
    obj->setProperty("point", "liveInput");
    obj->setProperty("configuredLatencySamples", liveDspConfig.latencySamples);
    obj->setProperty("blockSize", liveDspConfig.blockSize);
    obj->setProperty("fadeMs", liveDspConfig.fadeMs);
    obj->setProperty("skippedBlocks", static_cast<juce::int64>(liveDspSkipped.load()));
    // Reported by the device driver; not measured and not part of the DSP latency below.
    obj->setProperty("deviceOutputLatencySamples", outputLatencySamples.load());
    if (liveDsp == nullptr) {
        obj->setProperty("latencySamples", 0);
        obj->setProperty("latencyMs", 0.0);
        return juce::var(obj);
    }
    obj->setProperty("sampleRate", liveDsp->sampleRate());
    obj->setProperty("maxBlockSize", liveDsp->maxBlockSize());
    obj->setProperty("channels", liveDsp->channels());
    obj->setProperty("fadeSamples", liveDsp->fadeSamples());
    obj->setProperty("kernelLatencySamples", liveDsp->kernelLatencySamples());
    obj->setProperty("latencySamples", liveDsp->latencySamples());
    obj->setProperty("latencyMs", liveDsp->latencyMs());
    obj->setProperty("bufferBytes", static_cast<juce::int64>(liveDsp->bytes()));
    const auto stats = liveDsp->statistics();
    auto* s = new juce::DynamicObject();
    s->setProperty("calls", static_cast<juce::int64>(stats.calls));
    s->setProperty("samples", static_cast<juce::int64>(stats.samples));
    s->setProperty("lastMs", stats.lastMs);
    s->setProperty("averageMs", stats.averageMs);
    s->setProperty("peakMs", stats.peakMs);
    s->setProperty("averageLoad", stats.averageLoad);
    s->setProperty("peakLoad", stats.peakLoad);
    s->setProperty("overBudgetCalls", static_cast<juce::int64>(stats.overBudgetCalls));
    s->setProperty("oversizeCalls", static_cast<juce::int64>(stats.oversizeCalls));
    s->setProperty("sanitizedSamples", static_cast<juce::int64>(stats.sanitizedSamples));
    s->setProperty("underflowFrames", static_cast<juce::int64>(stats.underflowFrames));
    s->setProperty("overflowFrames", static_cast<juce::int64>(stats.overflowFrames));
    s->setProperty("resets", static_cast<juce::int64>(stats.resets));
    obj->setProperty("statistics", juce::var(s));
    return juce::var(obj);
}

juce::var Engine::liveCorrectionVar() const {
    const auto& cfg = liveDspConfig;
    const bool active = cfg.enabled && cfg.correction && liveDsp != nullptr && liveCorrection != nullptr;
    auto* obj = new juce::DynamicObject();
    obj->setProperty("enabled", active);
    obj->setProperty("bypassed", cfg.bypassed);
    obj->setProperty("analysis", juce::String(liveAnalysisModeName(cfg.correctionSettings.analysis)));
    obj->setProperty("input", juce::String(livePitchInputName(cfg.correctionSettings.input)));
    obj->setProperty("workerMarginMs", cfg.correctionSettings.workerMarginMs);
    obj->setProperty("root", juce::String(pitchClassName(cfg.correctionParams.root)));
    obj->setProperty("scale", juce::String(scaleTypeName(cfg.correctionParams.scale)));
    obj->setProperty("scaleLabel", juce::String(scaleTypeLabel(cfg.correctionParams.scale)));
    obj->setProperty("retuneMs", cfg.correctionParams.retuneMs);
    obj->setProperty("strength", rounded(cfg.correctionParams.strength * 100.0, 1.0e-3));
    obj->setProperty("formantPreservation", false);
    obj->setProperty("formantNote", "Formants move with the corrected pitch; live formant preservation is not implemented.");
    const bool monitorRaw = cfg.monitorMode == LiveDspConfig::MonitorMode::raw;
    auto* routing = new juce::DynamicObject();
    routing->setProperty("trackInputMonitoring", monitorRaw ? "raw" : "corrected");
    routing->setProperty("monitorMode", monitorRaw ? "raw" : "corrected");
    routing->setProperty("micMonitor", "raw");
    routing->setProperty("recording", "corrected");
    routing->setProperty("note", monitorRaw
        ? "Armed tracks record the corrected input. Track input monitoring hears the raw input delayed by the same DSP latency so mode switches stay aligned. Mic monitor stays raw and undelayed."
        : "Armed tracks record and monitor the corrected input, late by latencySamples (no delay compensation). The direct Mic monitor path plays the raw device input and is not corrected.");
    obj->setProperty("routing", juce::var(routing));
    obj->setProperty("monitorMode", monitorRaw ? "raw" : "corrected");
    juce::Array<juce::var> warnings;
    if (active && monitor.load()) {
        bool monitored = false;
        for (const auto& track : session.tracks)
            monitored = monitored || (track.used && track.armed && track.monitorInput);
        if (monitored)
            warnings.add(monitorRaw
                ? "Mic monitor and track input monitoring are both on: two raw paths can stack. Turn one of them off."
                : "Mic monitor and track input monitoring are both on: the raw and the corrected voice are heard together. Turn one of them off.");
    }
    obj->setProperty("warnings", warnings);
    // Reported by the device driver; not measured and not part of the DSP latency below.
    obj->setProperty("deviceOutputLatencySamples", outputLatencySamples.load());
    if (!active) {
        obj->setProperty("latencySamples", 0);
        obj->setProperty("latencyMs", 0.0);
        auto* monLat = new juce::DynamicObject();
        monLat->setProperty("dspSamples", 0);
        monLat->setProperty("dspMs", 0.0);
        monLat->setProperty("deviceOutputSamples", outputLatencySamples.load());
        monLat->setProperty("endToEndMs", juce::var());
        monLat->setProperty("endToEndNote", "End-to-end monitoring latency is unavailable: the engine does not measure device input latency.");
        monLat->setProperty("trackMonitoring", "off");
        obj->setProperty("monitoringLatency", juce::var(monLat));
        return juce::var(obj);
    }
    const double rate = liveDsp->sampleRate();
    auto ms = [rate](int samples) { return rounded(1000.0 * samples / rate, 1.0e-3); };
    obj->setProperty("sampleRate", rate);
    obj->setProperty("maxBlockSize", liveDsp->maxBlockSize());
    obj->setProperty("channels", liveDsp->channels());
    obj->setProperty("fadeSamples", liveDsp->fadeSamples());
    obj->setProperty("latencySamples", liveDsp->latencySamples());
    obj->setProperty("latencyMs", ms(liveDsp->latencySamples()));
    const auto& lat = liveCorrection->latency();
    auto* l = new juce::DynamicObject();
    l->setProperty("windowSize", lat.windowSize);
    l->setProperty("hopSize", lat.hopSize);
    l->setProperty("detectionSamples", lat.detection);
    l->setProperty("detectionMs", ms(lat.detection));
    l->setProperty("deliverySamples", lat.delivery);
    l->setProperty("deliveryMs", ms(lat.delivery));
    l->setProperty("shifterSamples", lat.shifter);
    l->setProperty("shifterMs", ms(lat.shifter));
    l->setProperty("bufferingSamples", liveDsp->blockSize());
    l->setProperty("totalSamples", liveDsp->latencySamples());
    l->setProperty("totalMs", ms(liveDsp->latencySamples()));
    obj->setProperty("latency", juce::var(l));
    auto* monLat = new juce::DynamicObject();
    monLat->setProperty("dspSamples", liveDsp->latencySamples());
    monLat->setProperty("dspMs", ms(liveDsp->latencySamples()));
    monLat->setProperty("deviceOutputSamples", outputLatencySamples.load());
    monLat->setProperty("deviceOutputMs", ms(outputLatencySamples.load()));
    monLat->setProperty("endToEndMs", juce::var());   // not measured: input device latency is unknown
    monLat->setProperty("endToEndNote", "End-to-end monitoring latency is unavailable: the engine does not measure device input latency.");
    monLat->setProperty("trackMonitoring", monitorRaw ? "rawAligned" : "corrected");
    obj->setProperty("monitoringLatency", juce::var(monLat));
    obj->setProperty("bufferBytes", static_cast<juce::int64>(liveDsp->bytes() + liveCorrection->bytes()));
    const auto stats = liveDsp->statistics();
    const auto k = liveCorrection->statistics();
    auto* s = new juce::DynamicObject();
    s->setProperty("calls", static_cast<juce::int64>(stats.calls));
    s->setProperty("samples", static_cast<juce::int64>(stats.samples));
    s->setProperty("averageMs", stats.averageMs);
    s->setProperty("peakMs", stats.peakMs);
    s->setProperty("averageLoad", stats.averageLoad);
    s->setProperty("peakLoad", stats.peakLoad);
    s->setProperty("overBudgetCalls", static_cast<juce::int64>(stats.overBudgetCalls));
    s->setProperty("sanitizedSamples", static_cast<juce::int64>(stats.sanitizedSamples));
    s->setProperty("skippedBlocks", static_cast<juce::int64>(liveDspSkipped.load()));
    s->setProperty("windows", static_cast<juce::int64>(k.windows));
    s->setProperty("voicedWindows", static_cast<juce::int64>(k.voicedWindows));
    s->setProperty("meanWindowMs", k.meanWindowMs);
    s->setProperty("maxWindowMs", k.maxWindowMs);
    s->setProperty("resultsReceived", static_cast<juce::int64>(k.resultsReceived));
    s->setProperty("lateResults", static_cast<juce::int64>(k.lateResults));
    s->setProperty("staleResults", static_cast<juce::int64>(k.staleResults));
    s->setProperty("resultsDropped", static_cast<juce::int64>(k.resultsDropped));
    s->setProperty("analysisDroppedFrames", static_cast<juce::int64>(k.analysisDroppedFrames));
    s->setProperty("analysisGaps", static_cast<juce::int64>(k.analysisGaps));
    s->setProperty("missingSamples", static_cast<juce::int64>(k.missingSamples));
    s->setProperty("correctedSamples", static_cast<juce::int64>(k.correctedSamples));
    s->setProperty("maxDeliveryLagSamples", static_cast<juce::int64>(k.maxDeliveryLag));
    s->setProperty("meanDeliveryLagSamples", k.meanDeliveryLag);
    s->setProperty("jumps", static_cast<juce::int64>(k.jumps));
    s->setProperty("recentres", static_cast<juce::int64>(k.recentres));
    s->setProperty("recoveries", static_cast<juce::int64>(k.recoveries));
    s->setProperty("resets", static_cast<juce::int64>(k.resets));
    obj->setProperty("statistics", juce::var(s));
    auto* c = new juce::DynamicObject();
    c->setProperty("inputMidi", rounded(k.inputMidi, 1.0e-3));
    c->setProperty("targetMidi", k.targetMidi);
    c->setProperty("targetName", juce::String(noteName(k.targetMidi)));
    c->setProperty("appliedCents", rounded(k.appliedCents, 1.0e-3));
    obj->setProperty("current", juce::var(c));
    return juce::var(obj);
}

namespace {
juce::var livePitchResultVar(const LivePitchResult& r, double rate, int64_t nowNs) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("sequence", static_cast<juce::int64>(r.sequence));
    obj->setProperty("windowStart", static_cast<juce::int64>(r.windowStart));
    obj->setProperty("windowEnd", static_cast<juce::int64>(r.windowEnd));
    obj->setProperty("inputTime", rounded((static_cast<double>(r.windowStart + r.windowEnd) * 0.5) / rate, 1.0e-5));
    obj->setProperty("arrivalNs", static_cast<juce::int64>(r.arrivalNs));
    obj->setProperty("dequeueNs", static_cast<juce::int64>(r.dequeueNs));
    obj->setProperty("startedNs", static_cast<juce::int64>(r.startedNs));
    obj->setProperty("completedNs", static_cast<juce::int64>(r.completedNs));
    obj->setProperty("ageMs", rounded(static_cast<double>(std::max<int64_t>(0, nowNs - r.completedNs)) / 1.0e6, 1.0e-3));
    obj->setProperty("voiced", r.voiced);
    obj->setProperty("invalid", r.invalid);
    obj->setProperty("gap", r.gap);
    obj->setProperty("frequency", rounded(r.frequency, 1.0e-3));
    obj->setProperty("midi", rounded(r.midi, 1.0e-4));
    obj->setProperty("nearestMidi", r.nearestMidi);
    obj->setProperty("nearestName", juce::String(noteName(r.nearestMidi)));
    obj->setProperty("cents", rounded(r.cents, 1.0e-2));
    obj->setProperty("confidence", rounded(r.confidence, 1.0e-4));
    obj->setProperty("levelDb", rounded(std::max(-200.0, r.levelDb), 1.0e-2));
    obj->setProperty("note", r.tracked.note);
    obj->setProperty("noteName", juce::String(noteName(r.tracked.note)));
    obj->setProperty("pitch", rounded(r.tracked.pitch, 1.0e-4));
    obj->setProperty("onset", r.tracked.onset);
    obj->setProperty("held", r.tracked.held);
    obj->setProperty("pending", r.tracked.pending);
    obj->setProperty("octaveCorrected", r.tracked.octaveCorrected);
    obj->setProperty("targetMidi", r.targetMidi);
    obj->setProperty("targetName", juce::String(noteName(r.targetMidi)));
    obj->setProperty("correctionCents", rounded(r.correctionCents, 1.0e-2));
    obj->setProperty("inTune", r.inTune);
    obj->setProperty("windowDelayMs", rounded(r.windowDelayMs, 1.0e-3));
    obj->setProperty("schedulingMs", rounded(r.schedulingMs, 1.0e-3));
    obj->setProperty("computeMs", rounded(r.computeMs, 1.0e-4));
    obj->setProperty("availabilityMs", rounded(r.availabilityMs, 1.0e-3));
    return juce::var(obj);
}
} // namespace

void Engine::retireLivePitch() {
    livePitchLive.store(nullptr);
    while (livePitchUsers.load() != 0)
        juce::Thread::sleep(1);
    livePitch.reset();
}

juce::String Engine::configureLivePitch() {
    retireLivePitch();
    if (!livePitchConfig.enabled)
        return {};
    auto detector = std::make_unique<LivePitchDetector>();
    const auto error = detector->start(static_cast<double>(std::max(8000, sampleRate.load())), livePitchConfig.settings,
                                       session.pitchMapping.key, session.pitchMapping.settings);
    if (!error.empty()) {
        livePitchConfig.enabled = false;
        return juce::String::fromUTF8(error.c_str());
    }
    livePitch = std::move(detector);
    livePitchLive.store(livePitch.get());
    return {};
}

juce::var Engine::livePitchVar(int recentCount) const {
    auto* obj = new juce::DynamicObject();
    const auto& config = livePitchConfig.settings;
    obj->setProperty("enabled", livePitchConfig.enabled && livePitch != nullptr);
    obj->setProperty("point", "liveInput");
    obj->setProperty("input", livePitchInputName(config.input));
    obj->setProperty("minHz", config.minHz);
    obj->setProperty("maxHz", config.maxHz);
    obj->setProperty("configuredWindowSize", config.windowSize);
    obj->setProperty("hopSize", config.hopSize);
    obj->setProperty("confidenceThreshold", config.confidenceThreshold);
    obj->setProperty("silenceDb", config.silenceDb);
    obj->setProperty("root", juce::String(pitchClassName(session.pitchMapping.key.root)));
    obj->setProperty("scale", juce::String(scaleTypeName(session.pitchMapping.key.scale)));
    obj->setProperty("scaleLabel", juce::String(scaleTypeLabel(session.pitchMapping.key.scale)));
    obj->setProperty("toleranceCents", session.pitchMapping.settings.toleranceCents);
    // Detection latency only; the device's input and output latency are not included.
    obj->setProperty("deviceOutputLatencySamples", outputLatencySamples.load());
    if (livePitch == nullptr)
        return juce::var(obj);
    const double rate = livePitch->sampleRate();
    const auto& params = livePitch->parameters();
    obj->setProperty("sampleRate", rate);
    obj->setProperty("windowSize", params.windowSize);
    obj->setProperty("windowMs", rounded(1000.0 * params.windowSize / rate, 1.0e-3));
    obj->setProperty("hopMs", rounded(1000.0 * params.hopSize / rate, 1.0e-3));
    const int64_t now = livePitchNowNs();
    LivePitchResult latest;
    if (livePitch->latest(latest))
        obj->setProperty("latest", livePitchResultVar(latest, rate, now));
    const auto history = livePitch->recent(kLivePitchHistory);
    if (recentCount > 0) {
        juce::Array<juce::var> items;
        const size_t first = history.size() > static_cast<size_t>(recentCount) ? history.size() - static_cast<size_t>(recentCount) : 0;
        for (size_t i = first; i < history.size(); ++i)
            items.add(livePitchResultVar(history[i], rate, now));
        obj->setProperty("recent", items);
    }
    const auto stats = livePitch->statistics();
    std::vector<double> availability;
    for (const auto& r : history)
        availability.push_back(r.availabilityMs);
    std::sort(availability.begin(), availability.end());
    auto* s = new juce::DynamicObject();
    s->setProperty("inputFrames", static_cast<juce::int64>(stats.inputFrames));
    s->setProperty("droppedFrames", static_cast<juce::int64>(stats.droppedFrames));
    s->setProperty("overflows", static_cast<juce::int64>(stats.overflows));
    s->setProperty("windows", static_cast<juce::int64>(stats.windows));
    s->setProperty("voicedWindows", static_cast<juce::int64>(stats.voicedWindows));
    s->setProperty("invalidWindows", static_cast<juce::int64>(stats.invalidWindows));
    s->setProperty("gaps", static_cast<juce::int64>(stats.gaps));
    s->setProperty("resets", static_cast<juce::int64>(stats.resets));
    s->setProperty("maxQueuedFrames", static_cast<juce::int64>(stats.maxQueuedFrames));
    s->setProperty("queueSlots", stats.queueSlots);
    s->setProperty("queueFrames", stats.queueFrames);
    s->setProperty("queueMs", rounded(1000.0 * stats.queueFrames / rate, 0.1));
    s->setProperty("bytes", static_cast<juce::int64>(stats.bytes));
    s->setProperty("windowDelayMs", rounded(stats.windowDelayMs, 1.0e-3));
    s->setProperty("meanSchedulingMs", rounded(stats.meanSchedulingMs, 1.0e-3));
    s->setProperty("maxSchedulingMs", rounded(stats.maxSchedulingMs, 1.0e-3));
    s->setProperty("meanComputeMs", rounded(stats.meanComputeMs, 1.0e-4));
    s->setProperty("maxComputeMs", rounded(stats.maxComputeMs, 1.0e-4));
    s->setProperty("meanAvailabilityMs", rounded(stats.meanAvailabilityMs, 1.0e-3));
    s->setProperty("maxAvailabilityMs", rounded(stats.maxAvailabilityMs, 1.0e-3));
    s->setProperty("p95AvailabilityMs", availability.empty() ? 0.0
        : rounded(availability[std::min(availability.size() - 1, availability.size() * 95 / 100)], 1.0e-3));
    s->setProperty("workerLoad", rounded(stats.meanComputeMs / (1000.0 * params.hopSize / rate), 1.0e-5));
    obj->setProperty("statistics", juce::var(s));
    return juce::var(obj);
}

void Engine::handleLine(const std::string& line) {
    if (shuttingDown.load())
        return;
    const auto trimmed = juce::String::fromUTF8(line.c_str()).trim();
    if (trimmed.isEmpty())
        return;
    const auto parsed = juce::JSON::parse(trimmed);
    if (!parsed.isObject()) {
        fail({}, "Command was not a JSON object.");
        return;
    }
    auto* obj = parsed.getDynamicObject();
    const auto idVar = obj->getProperty("id");
    const juce::String id = idVar.isString() ? idVar.toString() : juce::String();
    if (!idVar.isString() || id.isEmpty()) {
        fail({}, "Command is missing a string id.");
        return;
    }
    const auto version = obj->getProperty("v");
    if (!isNumber(version) || static_cast<int>(version) != 1) {
        fail(id, "Unsupported protocol version. This engine accepts version 1.");
        return;
    }
    const auto opVar = obj->getProperty("op");
    if (!opVar.isString()) {
        fail(id, "Command is missing an operation name.");
        return;
    }
    const auto op = opVar.toString();
    if (!session.pitchPreview.trackId.empty() && !keepsPitchPreview(op))
        endPitchPreview();
    // Stretch preview mutates clip duration — end it before unrelated edits (keep stretch IPC + getState).
    if (!session.stretchPreview.trackId.empty()
        && op != "previewClipStretch" && op != "cancelClipStretchPreview" && op != "applyClipStretch"
        && op != "getState" && op != "ping" && op != "listDevices" && op != "getMeters" && op != "waveform"
        && op != "transport")
        holdRetired(session.endClipStretchPreview());
    if (!session.crossfadePreview.trackId.empty()
        && op != "previewCrossfade" && op != "cancelCrossfadePreview" && op != "applyCrossfade"
        && op != "getState" && op != "ping" && op != "listDevices" && op != "getMeters" && op != "waveform"
        && op != "transport")
        holdRetired(session.endCrossfadePreview());

    if (op == "ping") {
        auto* result = new juce::DynamicObject();
        result->setProperty("pong", true);
        succeed(id, juce::var(result));
        return;
    }
    if (op == "shutdown") {
        auto* result = new juce::DynamicObject();
        result->setProperty("bye", true);
        succeed(id, juce::var(result));
        shutdown(false);
        return;
    }
    if (op == "getState") {
        succeed(id, stateVar());
        return;
    }
    if (op == "listDevices") {
        if (devices.getAvailableDeviceTypes().isEmpty())
            devices.initialise(0, 0, nullptr, false);
        if (auto* type = devices.getCurrentDeviceTypeObject())
            type->scanForDevices();
        juce::StringArray outputs;
        juce::StringArray inputs;
        juce::Array<double> rates;
        juce::Array<int> buffers;
        if (auto* type = devices.getCurrentDeviceTypeObject()) {
            outputs = type->getDeviceNames(false);
            inputs = type->getDeviceNames(true);
        }
        if (auto* device = devices.getCurrentAudioDevice()) {
            rates = device->getAvailableSampleRates();
            buffers = device->getAvailableBufferSizes();
        }
        if (rates.isEmpty()) {
            rates.add(44100.0);
            rates.add(48000.0);
            rates.add(96000.0);
        }
        if (buffers.isEmpty()) {
            for (int size : { 128, 256, 512, 1024, 2048 })
                buffers.add(size);
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("outputs", stringArray(outputs));
        result->setProperty("inputs", stringArray(inputs));
        result->setProperty("sampleRates", numberArray(rates));
        result->setProperty("bufferSizes", intArray(buffers));
        result->setProperty("current", stateVar());
        succeed(id, juce::var(result));
        return;
    }
    if ((op == "configure" || op == "loadProject") && recorder != nullptr) {
        fail(id, "Stop recording first.");
        return;
    }
    if ((op == "removeTrack" || op == "clearTrack") && recorder != nullptr) {
        const int index = session.indexOf(obj->getProperty("trackId").toString().toStdString());
        if (index >= 0 && session.tracks[static_cast<size_t>(index)].armed) {
            fail(id, "That track is recording. Stop recording before removing it.");
            return;
        }
    }
    if (op == "configure") {
        const auto rateVar = obj->getProperty("sampleRate");
        const auto bufferVar = obj->getProperty("bufferSize");
        double rate = rateVar.isVoid() ? static_cast<double>(sampleRate.load()) : static_cast<double>(rateVar);
        int buffer = bufferVar.isVoid() ? bufferSize.load() : static_cast<int>(bufferVar);
        if (!rateVar.isVoid() && (!isNumber(rateVar) || rate < 8000.0 || rate > 192000.0)) {
            fail(id, "Sample rate must be a number between 8000 and 192000.");
            return;
        }
        if (!bufferVar.isVoid() && (!isNumber(bufferVar) || buffer < 32 || buffer > 8192)) {
            fail(id, "Buffer size must be a number between 32 and 8192.");
            return;
        }
        const auto output = obj->hasProperty("outputDevice") ? obj->getProperty("outputDevice").toString() : outputDeviceName;
        const auto input = obj->hasProperty("inputDevice") ? obj->getProperty("inputDevice").toString() : inputDeviceName;
        if (obj->hasProperty("outputDevice") && !obj->getProperty("outputDevice").isString()) {
            fail(id, "Output device name must be a string.");
            return;
        }
        if (obj->hasProperty("inputDevice") && !obj->getProperty("inputDevice").isString()) {
            fail(id, "Input device name must be a string.");
            return;
        }
        openDevices(output, input, rate, buffer);
        if (!deviceOpen.load() && deviceError.isNotEmpty()) {
            fail(id, deviceError);
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "importTrack") {
        const auto trackId = obj->getProperty("trackId").toString().toStdString();
        const auto path = obj->getProperty("path").toString().toStdString();
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("path").isString()) {
            fail(id, "importTrack needs string trackId and path fields.");
            return;
        }
        auto retiredBuffers = session.importFile(trackId, path);
        if (!retiredBuffers.error.empty()) {
            fail(id, juce::String::fromUTF8(retiredBuffers.error.c_str()));
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "relinkMedia") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("path").isString()) {
            fail(id, "relinkMedia needs string trackId and path fields.");
            return;
        }
        const auto trackId = obj->getProperty("trackId").toString().toStdString();
        const auto path = obj->getProperty("path").toString().toStdString();
        const auto sourceFileId = obj->getProperty("sourceFileId").isString()
            ? obj->getProperty("sourceFileId").toString().toStdString()
            : std::string {};
        RetiredAudio retiredBuffers;
        const auto error = session.relinkSource(trackId, sourceFileId, path, retiredBuffers);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "probeWav") {
        if (!obj->getProperty("path").isString()) {
            fail(id, "probeWav needs a string path.");
            return;
        }
        const auto path = obj->getProperty("path").toString().toStdString();
        const auto info = probeWavFile(path);
        auto* result = new juce::DynamicObject();
        result->setProperty("path", juce::String::fromUTF8(path.c_str()));
        result->setProperty("ok", info.error.empty());
        result->setProperty("sampleRate", info.sampleRate);
        result->setProperty("channels", info.sourceChannels);
        result->setProperty("bitsPerSample", info.bitsPerSample);
        result->setProperty("frames", static_cast<double>(info.frames));
        result->setProperty("durationSeconds", info.durationSeconds);
        result->setProperty("fileBytes", static_cast<double>(info.fileBytes));
        if (!info.error.empty())
            result->setProperty("error", juce::String::fromUTF8(info.error.c_str()));
        succeed(id, juce::var(result));
        return;
    }
    if (op == "clearTrack") {
        const auto trackId = obj->getProperty("trackId").toString();
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "clearTrack needs a string trackId.");
            return;
        }
        auto retiredBuffers = session.clearTrack(trackId.toStdString());
        if (!retiredBuffers.error.empty()) {
            fail(id, juce::String::fromUTF8(retiredBuffers.error.c_str()));
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "setTrack") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "setTrack needs a string trackId.");
            return;
        }
        ProjectTrack values;
        values.id = obj->getProperty("trackId").toString().toStdString();
        bool setGain = false, setPan = false, setMute = false, setSolo = false;
        if (obj->hasProperty("gain")) {
            if (!isNumber(obj->getProperty("gain"))) {
                fail(id, "Gain must be a number.");
                return;
            }
            values.gain = static_cast<float>(static_cast<double>(obj->getProperty("gain")));
            setGain = true;
        }
        if (obj->hasProperty("pan")) {
            if (!isNumber(obj->getProperty("pan"))) {
                fail(id, "Pan must be a number.");
                return;
            }
            values.pan = static_cast<float>(static_cast<double>(obj->getProperty("pan")));
            setPan = true;
        }
        if (obj->hasProperty("mute")) {
            if (!obj->getProperty("mute").isBool()) {
                fail(id, "Mute must be true or false.");
                return;
            }
            values.mute = static_cast<bool>(obj->getProperty("mute"));
            setMute = true;
        }
        if (obj->hasProperty("solo")) {
            if (!obj->getProperty("solo").isBool()) {
                fail(id, "Solo must be true or false.");
                return;
            }
            values.solo = static_cast<bool>(obj->getProperty("solo"));
            setSolo = true;
        }
        const bool setOutput = obj->hasProperty("output");
        if (setOutput) {
            if (!obj->getProperty("output").isString()) {
                fail(id, "Output must be a bus id string.");
                return;
            }
            values.output = obj->getProperty("output").toString().toStdString();
            const auto routeError = checkTrackOutput(session.buses, values.output);
            if (!routeError.empty()) {
                fail(id, juce::String::fromUTF8(routeError.c_str()));
                return;
            }
        }
        auto error = session.setTrack(values.id, values, setGain, setPan, setMute, setSolo);
        if (error.empty() && setOutput)
            error = session.setTrackOutput(values.id, values.output);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "addBus") {
        const auto kindVar = obj->getProperty("kind");
        if (!kindVar.isString() || (kindVar.toString() != "group" && kindVar.toString() != "return")) {
            fail(id, "addBus needs kind \"group\" or \"return\".");
            return;
        }
        if (obj->hasProperty("name") && !obj->getProperty("name").isString()) {
            fail(id, "Bus name must be a string.");
            return;
        }
        std::string created;
        const auto error = session.addBus(kindVar.toString() == "return" ? BusKind::ret : BusKind::group,
                                          obj->getProperty("name").toString().trim().toStdString(), created);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        auto state = stateVar();
        state.getDynamicObject()->setProperty("createdBusId", juce::String::fromUTF8(created.c_str()));
        succeed(id, state);
        return;
    }
    if (op == "removeBus" || op == "renameBus" || op == "setBus") {
        if (!obj->getProperty("busId").isString()) {
            fail(id, op + " needs a string busId.");
            return;
        }
        const auto busId = obj->getProperty("busId").toString().toStdString();
        std::string error;
        if (op == "removeBus") {
            error = session.removeBus(busId);
        } else if (op == "renameBus") {
            if (!obj->getProperty("name").isString()) {
                fail(id, "renameBus needs a string name.");
                return;
            }
            error = session.renameBus(busId, obj->getProperty("name").toString().trim().toStdString());
        } else {
            ProjectBus values;
            const bool setGain = obj->hasProperty("gain");
            const bool setMute = obj->hasProperty("mute");
            const bool setSolo = obj->hasProperty("solo");
            const bool setOutput = obj->hasProperty("output");
            if (setGain && !isNumber(obj->getProperty("gain"))) {
                fail(id, "Bus gain must be a number.");
                return;
            }
            if ((setMute && !obj->getProperty("mute").isBool()) || (setSolo && !obj->getProperty("solo").isBool())) {
                fail(id, "Bus mute and solo must be true or false.");
                return;
            }
            if (setOutput && !obj->getProperty("output").isString()) {
                fail(id, "Bus output must be a bus id string.");
                return;
            }
            if (setGain)
                values.gain = static_cast<float>(static_cast<double>(obj->getProperty("gain")));
            if (setMute)
                values.mute = static_cast<bool>(obj->getProperty("mute"));
            if (setSolo)
                values.solo = static_cast<bool>(obj->getProperty("solo"));
            if (setOutput)
                values.output = obj->getProperty("output").toString().toStdString();
            error = session.setBus(busId, values, setGain, setMute, setSolo, setOutput);
        }
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "setSend" || op == "removeSend") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("busId").isString()) {
            fail(id, op + " needs string trackId and busId fields.");
            return;
        }
        const auto trackId = obj->getProperty("trackId").toString().toStdString();
        const auto busId = obj->getProperty("busId").toString().toStdString();
        std::string error;
        if (op == "removeSend") {
            error = session.removeSend(trackId, busId);
        } else {
            float level = 0.0f;
            bool pre = false;
            const bool hasLevel = obj->hasProperty("level");
            const bool hasPre = obj->hasProperty("preFader");
            if (hasLevel && !isNumber(obj->getProperty("level"))) {
                fail(id, "Send level must be a number.");
                return;
            }
            if (hasPre && !obj->getProperty("preFader").isBool()) {
                fail(id, "preFader must be true or false.");
                return;
            }
            if (hasLevel)
                level = static_cast<float>(static_cast<double>(obj->getProperty("level")));
            if (hasPre)
                pre = static_cast<bool>(obj->getProperty("preFader"));
            error = session.setSend(trackId, busId, hasLevel ? &level : nullptr, hasPre ? &pre : nullptr);
        }
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "addEffect") {
        const auto target = obj->getProperty("target");
        const auto typeVar = obj->getProperty("type");
        if (!target.isString()) {
            fail(id, "addEffect needs a target of \"track\", \"bus\", or \"master\".");
            return;
        }
        EffectType type;
        if (!typeVar.isString() || !effectTypeFromName(typeVar.toString().toStdString(), type)) {
            fail(id, "addEffect needs a type: eq, compressor, gate, reverb, delay, or limiter.");
            return;
        }
        if (target.toString() != "master" && !obj->getProperty("ownerId").isString()) {
            fail(id, "addEffect needs a string ownerId for a track or bus.");
            return;
        }
        int index = -1;
        if (obj->hasProperty("index")) {
            if (!isNumber(obj->getProperty("index"))) {
                fail(id, "Effect index must be a number.");
                return;
            }
            index = static_cast<int>(obj->getProperty("index"));
        }
        std::string created;
        const auto error = session.addEffect(target.toString().toStdString(), obj->getProperty("ownerId").toString().toStdString(), type, index, created);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        auto state = stateVar();
        state.getDynamicObject()->setProperty("createdEffectId", juce::String::fromUTF8(created.c_str()));
        succeed(id, state);
        return;
    }
    if (op == "removeEffect" || op == "setEffect" || op == "moveEffect") {
        if (!obj->getProperty("effectId").isString()) {
            fail(id, op + " needs a string effectId.");
            return;
        }
        const auto effectId = obj->getProperty("effectId").toString().toStdString();
        const auto found = session.findEffect(effectId);
        if (found.chain == nullptr) {
            fail(id, "No effect exists with that id.");
            return;
        }
        std::string error;
        if (op == "setEffect") {
            bool enabled = true;
            const bool hasEnabled = obj->hasProperty("enabled");
            if (hasEnabled && !obj->getProperty("enabled").isBool()) {
                fail(id, "Effect enabled must be true or false.");
                return;
            }
            if (hasEnabled)
                enabled = static_cast<bool>(obj->getProperty("enabled"));
            std::vector<std::pair<std::string, float>> params;
            const auto paramsVar = obj->getProperty("params");
            if (!paramsVar.isVoid()) {
                auto* paramsObj = paramsVar.getDynamicObject();
                if (paramsObj == nullptr) {
                    fail(id, "Effect params must be an object of name: number pairs.");
                    return;
                }
                for (const auto& entry : paramsObj->getProperties()) {
                    if (!isNumber(entry.value)) {
                        fail(id, "Effect parameter " + entry.name.toString() + " must be a number.");
                        return;
                    }
                    params.emplace_back(entry.name.toString().toStdString(), static_cast<float>(static_cast<double>(entry.value)));
                }
            }
            error = session.setEffect(effectId, hasEnabled ? &enabled : nullptr, params);
        } else {
            int index = 0;
            if (op == "moveEffect") {
                if (!isNumber(obj->getProperty("index"))) {
                    fail(id, "moveEffect needs a numeric index.");
                    return;
                }
                index = static_cast<int>(obj->getProperty("index"));
                if (index < 0 || index >= static_cast<int>(found.chain->size())) {
                    fail(id, "Effect position must be between 0 and " + juce::String(static_cast<int>(found.chain->size()) - 1) + ".");
                    return;
                }
            }
            // Fade the effect out to dry first, so removing or moving it does not click.
            auto& effect = (*found.chain)[static_cast<size_t>(found.index)];
            const bool wasEnabled = effect.enabled;
            if (wasEnabled && modeFromInt(transport.load()) == TransportMode::playing) {
                effect.enabled = false;
                publishMix();
                settleAudio();
                effect.enabled = true;
            }
            error = op == "removeEffect" ? session.removeEffect(effectId) : session.moveEffect(effectId, index);
        }
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "resetClips") {
        for (auto& entry : meterLevels)
            entry.second.clip = false;
        masterMeter.clip = false;
        inputMeter.clip = false;
        for (auto& entry : stripPeakHolds) {
            entry.second.holdL = 0.0f;
            entry.second.holdR = 0.0f;
            entry.second.ticks = 0;
        }
        masterPeakHold = {};
        succeed(id, stateVar());
        return;
    }
    if (op == "getMeters") {
        // Reads the same native peaks as the meter event without decay; used by tests.
        succeed(id, meterVar(false));
        return;
    }
    if (op == "setSpectrumTap") {
        // Phase 2.8.3 — select post-insert / pre-fader analyzer source. { enabled:false } clears.
        const bool enabled = obj->hasProperty("enabled") ? static_cast<bool>(obj->getProperty("enabled")) : true;
        if (!enabled) {
            spectrumKind.store(static_cast<int>(SpectrumTapKind::none), std::memory_order_relaxed);
            spectrumTarget.clear();
            spectrumOwnerId.clear();
            spectrumCapture.clear();
            succeed(id, stateVar());
            return;
        }
        if (!obj->getProperty("target").isString()) {
            fail(id, "setSpectrumTap needs target (track|bus|master).");
            return;
        }
        const auto target = obj->getProperty("target").toString().toStdString();
        if (target != "track" && target != "bus" && target != "master") {
            fail(id, "setSpectrumTap target must be track, bus, or master.");
            return;
        }
        std::string owner;
        if (target != "master") {
            if (!obj->getProperty("ownerId").isString()) {
                fail(id, "setSpectrumTap needs ownerId for track/bus taps.");
                return;
            }
            owner = obj->getProperty("ownerId").toString().toStdString();
        }
        spectrumTarget = target;
        spectrumOwnerId = owner;
        spectrumKind.store(target == "track" ? static_cast<int>(SpectrumTapKind::track)
                           : target == "bus" ? static_cast<int>(SpectrumTapKind::bus)
                                             : static_cast<int>(SpectrumTapKind::master),
                           std::memory_order_relaxed);
        spectrumCapture.clear();
        resolveSpectrumTapLocked();
        succeed(id, stateVar());
        return;
    }
    if (op == "getEqResponse") {
        // Analytic frequency response from the same coefficients as EqDsp (UI / tests).
        if (!obj->getProperty("effectId").isString() && !obj->hasProperty("params")) {
            fail(id, "getEqResponse needs effectId or params.");
            return;
        }
        EffectParams params = defaultEffectParams(EffectType::eq);
        double rate = static_cast<double>(std::max(1, sampleRate.load()));
        if (isNumber(obj->getProperty("sampleRate")))
            rate = static_cast<double>(obj->getProperty("sampleRate"));
        if (obj->getProperty("effectId").isString()) {
            const auto effectId = obj->getProperty("effectId").toString().toStdString();
            const auto found = session.findEffect(effectId);
            if (found.chain == nullptr || found.index < 0
                || (*found.chain)[static_cast<size_t>(found.index)].type != EffectType::eq) {
                fail(id, "getEqResponse needs an EQ effectId.");
                return;
            }
            params = (*found.chain)[static_cast<size_t>(found.index)].params;
        } else if (obj->getProperty("params").isObject()) {
            auto* paramsObj = obj->getProperty("params").getDynamicObject();
            const auto& spec = effectSpec(EffectType::eq);
            for (int i = 0; i < spec.paramCount; ++i) {
                const auto value = paramsObj->getProperty(spec.params[i].name);
                if (isNumber(value))
                    params[static_cast<size_t>(i)] = static_cast<float>(static_cast<double>(value));
            }
            sanitizeEffectParams(EffectType::eq, params);
        }
        constexpr int kPoints = 64;
        std::vector<double> hz(kPoints), db(kPoints);
        for (int i = 0; i < kPoints; ++i) {
            const double t = static_cast<double>(i) / static_cast<double>(kPoints - 1);
            hz[static_cast<size_t>(i)] = 20.0 * std::pow(1000.0, t); // 20 Hz … 20 kHz
        }
        if (!eqResponseCurve(params, rate, hz.data(), kPoints, db.data())) {
            fail(id, "Could not compute EQ response.");
            return;
        }
        auto* result = new juce::DynamicObject();
        juce::Array<juce::var> freqs, mags;
        for (int i = 0; i < kPoints; ++i) {
            freqs.add(hz[static_cast<size_t>(i)]);
            mags.add(db[static_cast<size_t>(i)]);
        }
        result->setProperty("frequenciesHz", freqs);
        result->setProperty("magnitudesDb", mags);
        result->setProperty("sampleRate", rate);
        succeed(id, juce::var(result));
        return;
    }
    if (op == "getDynamicsCurve") {
        // Steady-state input→output transfer for compressor or limiter (UI / tests).
        EffectType type = EffectType::compressor;
        EffectParams params = defaultEffectParams(type);
        if (obj->getProperty("effectId").isString()) {
            const auto effectId = obj->getProperty("effectId").toString().toStdString();
            const auto found = session.findEffect(effectId);
            if (found.chain == nullptr || found.index < 0) {
                fail(id, "getDynamicsCurve needs a compressor or limiter effectId.");
                return;
            }
            const auto& effect = (*found.chain)[static_cast<size_t>(found.index)];
            if (effect.type != EffectType::compressor && effect.type != EffectType::limiter) {
                fail(id, "getDynamicsCurve needs a compressor or limiter effectId.");
                return;
            }
            type = effect.type;
            params = effect.params;
        } else if (obj->getProperty("type").isString()
                   && effectTypeFromName(obj->getProperty("type").toString().toStdString(), type)
                   && (type == EffectType::compressor || type == EffectType::limiter)) {
            params = defaultEffectParams(type);
            if (obj->getProperty("params").isObject()) {
                auto* paramsObj = obj->getProperty("params").getDynamicObject();
                const auto& spec = effectSpec(type);
                for (int i = 0; i < spec.paramCount; ++i) {
                    const auto value = paramsObj->getProperty(spec.params[i].name);
                    if (isNumber(value))
                        params[static_cast<size_t>(i)] = static_cast<float>(static_cast<double>(value));
                }
                sanitizeEffectParams(type, params);
            }
        } else {
            fail(id, "getDynamicsCurve needs effectId or type (compressor|limiter).");
            return;
        }
        constexpr int kPoints = 65;
        constexpr double kMinIn = -60.0;
        constexpr double kMaxIn = 0.0;
        juce::Array<juce::var> inputs, outputs, reductions;
        for (int i = 0; i < kPoints; ++i) {
            const double t = static_cast<double>(i) / static_cast<double>(kPoints - 1);
            const double inDb = kMinIn + t * (kMaxIn - kMinIn);
            const double outDb = type == EffectType::limiter
                ? limiterTransferDb(params, inDb)
                : compressorTransferDb(params, inDb);
            const double gr = type == EffectType::limiter
                ? limiterGainReductionDb(params, inDb)
                : compressorGainReductionDb(params, inDb);
            inputs.add(inDb);
            outputs.add(outDb);
            reductions.add(gr);
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("type", effectTypeName(type));
        result->setProperty("inputDb", inputs);
        result->setProperty("outputDb", outputs);
        result->setProperty("reductionDb", reductions);
        result->setProperty("kind", type == EffectType::limiter ? "sample-peak" : "compressor");
        succeed(id, juce::var(result));
        return;
    }
    if (op == "setMaster") {
        if (!isNumber(obj->getProperty("gain"))) {
            fail(id, "Master gain must be a number.");
            return;
        }
        const float gainValue = static_cast<float>(static_cast<double>(obj->getProperty("gain")));
        if (!std::isfinite(gainValue) || gainValue < 0.0f || gainValue > 4.0f) {
            fail(id, "Master gain must be between 0 and 4.");
            return;
        }
        if (parameterAutomated(session.masterAutomation, "volume")) {
            fail(id, "Master volume is automated. Turn off its automation lane to set it by hand.");
            return;
        }
        session.masterGain = gainValue;
        masterGain.store(gainValue, std::memory_order_relaxed);
        succeed(id, stateVar());
        return;
    }
    if (op == "setMonitor") {
        if (!obj->getProperty("enabled").isBool()) {
            fail(id, "Microphone monitoring needs an enabled true or false value.");
            return;
        }
        const bool enabled = static_cast<bool>(obj->getProperty("enabled"));
        if (enabled && inputChannels.load() <= 0) {
            monitor.store(false, std::memory_order_relaxed);
            session.monitor = false;
            fail(id, "Microphone monitoring needs an open input device. Choose an input, apply it, then enable monitoring. It stays off so a live speaker cannot feed back.");
            return;
        }
        session.monitor = enabled;
        monitor.store(enabled, std::memory_order_relaxed);
        succeed(id, stateVar());
        return;
    }
    if (op == "setInputGain") {
        // Software input gain only (−24…+24 dB, unity 0 dB). Does not change track/master/monitor.
        // Cannot repair hardware ADC clipping already present in the captured samples.
        if (!isNumber(obj->getProperty("gainDb"))) {
            fail(id, "Input gain needs a gainDb number in dB.");
            return;
        }
        const float db = static_cast<float>(static_cast<double>(obj->getProperty("gainDb")));
        if (!std::isfinite(db) || db < -24.0f || db > 24.0f) {
            fail(id, "Input gain must be between -24 and +24 dB.");
            return;
        }
        inputGainDb.store(db, std::memory_order_relaxed);
        inputGainTarget.store(dbToLinearGain(db), std::memory_order_relaxed);
        succeed(id, stateVar());
        return;
    }
    if (op == "getRecordingLatency") {
        succeed(id, recordingLatencyVar());
        return;
    }
    if (op == "setRecordingOffset") {
        if (!isNumber(obj->getProperty("offsetMs"))) {
            fail(id, "Recording offset needs an offsetMs number in milliseconds.");
            return;
        }
        const double ms = static_cast<double>(obj->getProperty("offsetMs"));
        if (!std::isfinite(ms) || ms < -kMaxRecordingOffsetMs || ms > kMaxRecordingOffsetMs) {
            fail(id, "Recording offset must be between -500 and +500 ms.");
            return;
        }
        if (recorder != nullptr) {
            fail(id, "Stop recording before changing the recording latency offset.");
            return;
        }
        recordingOffsetMs = ms;
        recordingOffsetProfiles[currentLatencyProfileKey()] = ms;
        latencyEstimateMethod = "manual";
        saveRecordingLatencyProfiles();
        succeed(id, recordingLatencyVar());
        return;
    }
    if (op == "resetRecordingOffset") {
        if (recorder != nullptr) {
            fail(id, "Stop recording before resetting the recording latency offset.");
            return;
        }
        recordingOffsetMs = 0.0;
        recordingOffsetProfiles[currentLatencyProfileKey()] = 0.0;
        latencyEstimateMethod = "none";
        hasLatencyEstimate = false;
        lastLatencyEstimate = {};
        saveRecordingLatencyProfiles();
        succeed(id, recordingLatencyVar());
        return;
    }
    if (op == "estimateRecordingLatency") {
        // Offline correlation between a known reference pulse WAV and a recorded loopback WAV.
        // Control thread only. Does not auto-apply; caller must applyRecordingLatencyEstimate.
        if (!obj->getProperty("referencePath").isString() || !obj->getProperty("recordedPath").isString()) {
            fail(id, "estimateRecordingLatency needs referencePath and recordedPath WAV files.");
            return;
        }
        const auto reference = readWavFile(obj->getProperty("referencePath").toString().toStdString());
        const auto recorded = readWavFile(obj->getProperty("recordedPath").toString().toStdString());
        if (!reference.error.empty()) {
            fail(id, juce::String::fromUTF8(reference.error.c_str()));
            return;
        }
        if (!recorded.error.empty()) {
            fail(id, juce::String::fromUTF8(recorded.error.c_str()));
            return;
        }
        double rate = reference.sampleRate > 0.0 ? reference.sampleRate : static_cast<double>(sampleRate.load());
        if (recorded.sampleRate > 0.0 && std::abs(recorded.sampleRate - rate) > 0.5)
            rate = recorded.sampleRate;
        double maxLagMs = 500.0;
        if (obj->hasProperty("maxLagMs")) {
            if (!isNumber(obj->getProperty("maxLagMs"))) {
                fail(id, "maxLagMs must be a number.");
                return;
            }
            maxLagMs = static_cast<double>(obj->getProperty("maxLagMs"));
            if (!std::isfinite(maxLagMs) || maxLagMs < 1.0 || maxLagMs > 2000.0) {
                fail(id, "maxLagMs must be between 1 and 2000.");
                return;
            }
        }
        auto refMono = reference.left;
        if (reference.sourceChannels > 1 && !reference.right.empty()) {
            for (size_t i = 0; i < refMono.size() && i < reference.right.size(); ++i)
                refMono[i] = 0.5f * (reference.left[i] + reference.right[i]);
        }
        auto recMono = recorded.left;
        if (recorded.sourceChannels > 1 && !recorded.right.empty()) {
            for (size_t i = 0; i < recMono.size() && i < recorded.right.size(); ++i)
                recMono[i] = 0.5f * (recorded.left[i] + recorded.right[i]);
        }
        lastLatencyEstimate = estimateLatencyMono(refMono, recMono, rate, maxLagMs);
        hasLatencyEstimate = true;
        latencyEstimateMethod = "loopback-estimate";
        auto* result = new juce::DynamicObject();
        result->setProperty("delayMs", lastLatencyEstimate.delayMs);
        result->setProperty("delaySamples", static_cast<juce::int64>(lastLatencyEstimate.delaySamples));
        result->setProperty("confidence", lastLatencyEstimate.confidence);
        result->setProperty("peakCorrelation", lastLatencyEstimate.peakCorrelation);
        result->setProperty("reliable", lastLatencyEstimate.reliable);
        result->setProperty("message", juce::String::fromUTF8(lastLatencyEstimate.message.c_str()));
        result->setProperty("sampleRate", rate);
        result->setProperty("suggestedOffsetMs", -lastLatencyEstimate.delayMs);
        result->setProperty("suggestedOffsetNote",
                            "Suggested offsetMs = −delayMs so a late recording is placed earlier on the timeline.");
        result->setProperty("applied", false);
        succeed(id, juce::var(result));
        return;
    }
    if (op == "applyRecordingLatencyEstimate") {
        if (!hasLatencyEstimate) {
            fail(id, "No latency estimate is available. Run estimateRecordingLatency first.");
            return;
        }
        const auto forceVar = obj->getProperty("force");
        const bool forceApply = forceVar.isBool() && static_cast<bool>(forceVar);
        if (!lastLatencyEstimate.reliable && !forceApply) {
            fail(id, "The last estimate is not reliable enough to apply. Re-run calibration or pass force true after reviewing the result.");
            return;
        }
        if (recorder != nullptr) {
            fail(id, "Stop recording before applying a latency estimate.");
            return;
        }
        // Late recording (positive delay) → negative placement offset.
        const double ms = std::clamp(-lastLatencyEstimate.delayMs, -kMaxRecordingOffsetMs, kMaxRecordingOffsetMs);
        recordingOffsetMs = ms;
        recordingOffsetProfiles[currentLatencyProfileKey()] = ms;
        latencyEstimateMethod = "loopback-estimate";
        saveRecordingLatencyProfiles();
        succeed(id, recordingLatencyVar());
        return;
    }
    if (op == "transport") {
        const auto action = obj->getProperty("action").toString();
        if (!obj->getProperty("action").isString()) {
            fail(id, "Transport needs an action of play, pause, stop, or seek.");
            return;
        }
        if (!deviceOpen.load() && action != "stop" && action != "seek" && action != "pause") {
            fail(id, deviceError.isNotEmpty() ? deviceError : juce::String("Playback needs an open audio output device."));
            return;
        }
        juce::var take;
        if (recorder != nullptr) {
            if (action != "stop" && action != "pause") {
                fail(id, "Recording is running. Stop recording before you play or move the playhead.");
                return;
            }
            take = finishRecording();
        }
        Clock clock;
        clock.mode = modeFromInt(transport.load());
        clock.position = position.load();
        const auto timeline = timelineSamples.load();
        if (action == "play" && clock.mode == TransportMode::stopped) {
            // Starting from Stop: hand the callback clean effect processors prepared here, so
            // old reverb tails and delay lines are dropped without clearing them on the audio thread.
            const auto* head = mixHead.load(std::memory_order_relaxed);
            if (head != nullptr && !head->plan.effects.empty()) {
                publishMix();
                waitForAudioSnapshot();
            }
        }
        if (action == "play")
            clock = transportPlay(clock, timeline);
        else if (action == "pause")
            clock = transportPause(clock);
        else if (action == "stop")
            clock = transportStop();
        else if (action == "seek") {
            if (!isNumber(obj->getProperty("position"))) {
                fail(id, "Seek needs a position in seconds.");
                return;
            }
            clock = transportSeek(clock, static_cast<double>(obj->getProperty("position")), sampleRate.load(), timeline);
        } else {
            fail(id, "Unknown transport action. Use play, pause, stop, or seek.");
            return;
        }
        session.clock = clock;
        transport.store(static_cast<int>(clock.mode), std::memory_order_relaxed);
        position.store(clock.position, std::memory_order_relaxed);
        auto state = stateVar();
        if (!take.isVoid())
            state.getDynamicObject()->setProperty("take", take);
        succeed(id, state);
        return;
    }
    if (op == "exportWav") {
        if (!obj->getProperty("path").isString()) {
            fail(id, "Export needs a WAV file path.");
            return;
        }
        // End temporary previews so the exported mix matches committed clip/effect state.
        if (!session.pitchPreview.trackId.empty())
            endPitchPreview();
        if (!session.breathPreview.trackId.empty())
            holdRetired(session.endBreathPreview());
        if (!session.stretchPreview.trackId.empty())
            holdRetired(session.endClipStretchPreview());
        if (!session.vocalPresetPreview.trackId.empty())
            session.endVocalPresetPreview();
        double rate = static_cast<double>(sampleRate.load());
        if (obj->hasProperty("sampleRate")) {
            if (!isNumber(obj->getProperty("sampleRate"))) {
                fail(id, "Export sample rate must be a number.");
                return;
            }
            rate = static_cast<double>(obj->getProperty("sampleRate"));
        }
        TailSettings tail = session.renderTail;
        if (obj->hasProperty("tail")) {
            const auto tailError = readTail(obj->getProperty("tail"), tail);
            if (tailError.isNotEmpty()) {
                fail(id, tailError);
                return;
            }
        }
        const auto path = obj->getProperty("path").toString().toStdString();
        int64_t frames = 0;
        int64_t timelineFrames = 0;
        const auto error = session.exportMix(path, rate, &tail, &frames, &timelineFrames);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("path", obj->getProperty("path"));
        result->setProperty("sampleRate", rate);
        result->setProperty("channels", 2);
        result->setProperty("bitsPerSample", 24);
        result->setProperty("frames", static_cast<juce::int64>(frames));
        result->setProperty("timelineFrames", static_cast<juce::int64>(timelineFrames));
        result->setProperty("tailFrames", static_cast<juce::int64>(frames - timelineFrames));
        result->setProperty("tail", tailVar(tail));
        succeed(id, juce::var(result));
        return;
    }
    if (op == "analyzeLoudness") {
        const auto error = startLoudnessAnalysis(id, parsed);
        if (error.isNotEmpty())
            fail(id, error);
        return;
    }
    if (op == "cancelLoudnessAnalysis") {
        const bool running = loudnessJob != nullptr && !loudnessJob->finished.load();
        if (running)
            loudnessJob->cancel.store(true);
        auto* cancelled = new juce::DynamicObject();
        cancelled->setProperty("cancelling", running);
        cancelled->setProperty("jobId", running ? loudnessJob->id : 0);
        succeed(id, juce::var(cancelled));
        return;
    }
    if (op == "setRenderTail") {
        TailSettings tail = session.renderTail;
        const auto tailError = readTail(parsed, tail);
        if (tailError.isNotEmpty()) {
            fail(id, tailError);
            return;
        }
        session.renderTail = tail;
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "setAutomation" || op == "removeAutomation" || op == "addAutomationPoint"
        || op == "moveAutomationPoint" || op == "deleteAutomationPoint") {
        const auto targetVar = obj->getProperty("target");
        const auto paramVar = obj->getProperty("param");
        if (!targetVar.isString() || !paramVar.isString()) {
            fail(id, op + " needs a target (track, bus, or master) and a param.");
            return;
        }
        const auto target = targetVar.toString().toStdString();
        if (target != "master" && !obj->getProperty("ownerId").isString()) {
            fail(id, op + " needs a string ownerId for a track or bus.");
            return;
        }
        const auto ownerId = target == "master" ? std::string() : obj->getProperty("ownerId").toString().toStdString();
        const auto param = paramVar.toString().toStdString();
        const double rate = static_cast<double>(std::max(1, sampleRate.load()));
        const bool needsIndex = op == "moveAutomationPoint" || op == "deleteAutomationPoint";
        if (needsIndex && !isNumber(obj->getProperty("index"))) {
            fail(id, op + " needs the numeric index of the point.");
            return;
        }
        const int index = needsIndex ? static_cast<int>(obj->getProperty("index")) : -1;
        std::string error;
        int pointIndex = -1;
        if (op == "setAutomation") {
            bool enabled = true;
            const bool hasEnabled = obj->hasProperty("enabled");
            if (hasEnabled && !obj->getProperty("enabled").isBool()) {
                fail(id, "Automation enabled must be true or false.");
                return;
            }
            if (hasEnabled)
                enabled = static_cast<bool>(obj->getProperty("enabled"));
            std::vector<AutomationPoint> points;
            const bool hasPoints = obj->hasProperty("points");
            if (hasPoints) {
                const auto list = obj->getProperty("points");
                if (!list.isArray()) {
                    fail(id, "Automation points must be a list of {time, value, interpolation} objects.");
                    return;
                }
                for (const auto& item : *list.getArray()) {
                    AutomationPoint point;
                    const auto pointError = readPoint(item, rate, point);
                    if (pointError.isNotEmpty()) {
                        fail(id, pointError);
                        return;
                    }
                    points.push_back(point);
                }
            }
            error = session.setAutomation(target, ownerId, param, hasEnabled ? &enabled : nullptr, hasPoints ? &points : nullptr);
        } else if (op == "removeAutomation") {
            error = session.removeAutomation(target, ownerId, param);
        } else if (op == "deleteAutomationPoint") {
            error = session.deleteAutomationPoint(target, ownerId, param, index);
        } else {
            AutomationPoint point;
            bool hasInterpolation = false;
            const auto pointError = readPoint(parsed, rate, point, &hasInterpolation);
            if (pointError.isNotEmpty()) {
                fail(id, pointError);
                return;
            }
            if (op == "addAutomationPoint")
                error = session.addAutomationPoint(target, ownerId, param, point, pointIndex);
            else
                error = session.moveAutomationPoint(target, ownerId, param, index, point.time, point.value,
                                                    hasInterpolation ? &point.step : nullptr, pointIndex);
        }
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        auto state = stateVar();
        if (pointIndex >= 0)
            state.getDynamicObject()->setProperty("pointIndex", pointIndex);
        succeed(id, state);
        return;
    }
    if (op == "analyzePitch") {
        const auto error = startPitchAnalysis(id, parsed);
        if (error.isNotEmpty())
            fail(id, error);
        return;
    }
    if (op == "cancelPitchAnalysis" || op == "cancelPitchProcess") {
        const bool running = pitchJob != nullptr && !pitchJob->finished.load() && pitchJob->processing == (op == "cancelPitchProcess");
        if (running)
            pitchJob->cancel.store(true);
        auto* cancelled = new juce::DynamicObject();
        cancelled->setProperty("cancelling", running);
        cancelled->setProperty("jobId", running ? pitchJob->id : 0);
        succeed(id, juce::var(cancelled));
        return;
    }
    if (op == "processPitch") {
        const auto error = startPitchProcess(id, parsed);
        if (error.isNotEmpty())
            fail(id, error);
        return;
    }
    if (op == "processAutoCorrection") {
        const auto error = startPitchCorrection(id, parsed);
        if (error.isNotEmpty())
            fail(id, error);
        return;
    }
    if (op == "setProcessedFolder") {
        if (pitchJob != nullptr && !pitchJob->finished.load() && pitchJob->processing) {
            fail(id, "Wait for pitch processing to finish before changing the processed-audio folder.");
            return;
        }
        const auto pathVar = obj->getProperty("path");
        if (!pathVar.isString() || !juce::File::isAbsolutePath(pathVar.toString())) {
            fail(id, "setProcessedFolder needs an absolute folder path.");
            return;
        }
        const juce::File folder(pathVar.toString());
        if (!folder.createDirectory().wasOk()) {
            fail(id, "Could not create the processed-audio folder " + folder.getFullPathName() + ".");
            return;
        }
        processedFolder = folder;
        succeed(id, stateVar());
        return;
    }
    if (op == "previewPitch" || op == "applyPitch") {
        const auto resultVar = obj->getProperty("resultId");
        if (!isNumber(resultVar)) {
            fail(id, op + " needs a numeric resultId.");
            return;
        }
        const int resultId = static_cast<int>(resultVar);
        if (op == "previewPitch") {
            if (!obj->getProperty("enabled").isBool()) {
                fail(id, "previewPitch needs enabled true or false.");
                return;
            }
            if (!static_cast<bool>(obj->getProperty("enabled"))) {
                endPitchPreview();
                succeed(id, stateVar());
                return;
            }
            if (session.pitchPreview.resultId == resultId && !session.pitchPreview.trackId.empty()) {
                succeed(id, stateVar());
                return;
            }
            endPitchPreview();
            std::string sourceId;
            const auto error = loadProcessed(resultId, true, sourceId);
            if (error.isNotEmpty()) {
                fail(id, error);
                return;
            }
            PitchProcessed info;
            {
                std::lock_guard<std::mutex> lock(pitchProcessedMutex);
                info = pitchProcessed[resultId];
            }
            session.pitchPreview = Session::PitchPreview { info.trackId, info.clipId, sourceId, resultId };
            holdRetired(session.commitTrack(session.indexOf(info.trackId)));
            publishMix();
            succeed(id, stateVar());
            return;
        }
        std::string sourceId;
        const auto error = loadProcessed(resultId, false, sourceId);
        if (error.isNotEmpty()) {
            fail(id, error);
            return;
        }
        endPitchPreview();
        PitchProcessed info;
        {
            std::lock_guard<std::mutex> lock(pitchProcessedMutex);
            info = pitchProcessed[resultId];
        }
        RetiredAudio retiredBuffers;
        const auto applyError = session.applyPitchSource(info.trackId, info.clipId, sourceId, info.shiftCents, info.label, retiredBuffers);
        if (!applyError.empty()) {
            fail(id, juce::String::fromUTF8(applyError.c_str()));
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "revertPitch") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("clipId").isString()) {
            fail(id, "revertPitch needs a trackId and a clipId.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.revertPitchSource(obj->getProperty("trackId").toString().toStdString(),
                                                     obj->getProperty("clipId").toString().toStdString(), retiredBuffers);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "setPitchMapping") {
        PitchMapping next = session.pitchMapping;
        const auto enabled = obj->getProperty("enabled");
        const auto root = obj->getProperty("root");
        const auto scale = obj->getProperty("scale");
        const auto tie = obj->getProperty("tieBreak");
        const auto tolerance = obj->getProperty("toleranceCents");
        if (!enabled.isVoid()) {
            if (!enabled.isBool()) {
                fail(id, "enabled must be true or false.");
                return;
            }
            next.enabled = static_cast<bool>(enabled);
        }
        if (!root.isVoid()) {
            const int pc = root.isString() ? pitchClassFromName(root.toString().toStdString()) : -1;
            if (pc < 0) {
                fail(id, "root must be a note name such as \"C\", \"F#\" or \"Bb\".");
                return;
            }
            next.key.root = pc;
        }
        if (!scale.isVoid() && (!scale.isString() || !scaleTypeFromName(scale.toString().toStdString(), next.key.scale))) {
            fail(id, "scale must be major, naturalMinor, harmonicMinor, melodicMinor, majorPentatonic, minorPentatonic or chromatic.");
            return;
        }
        if (!tie.isVoid() && (!tie.isString() || !tieBreakFromName(tie.toString().toStdString(), next.settings.tieBreak))) {
            fail(id, "tieBreak must be \"lower\" or \"upper\".");
            return;
        }
        if (!tolerance.isVoid()) {
            next.settings.toleranceCents = isNumber(tolerance) ? static_cast<double>(tolerance) : -1.0;
            const auto error = checkMappingSettings(next.settings);
            if (!error.empty()) {
                fail(id, juce::String::fromUTF8(error.c_str()));
                return;
            }
        }
        session.pitchMapping = next;
        if (livePitch != nullptr)
            livePitch->setKey(next.key, next.settings);
        succeed(id, stateVar());
        return;
    }
    if (op == "getPitchMapping" || op == "setNoteTarget" || op == "resetNoteTarget") {
        const auto jobVar = obj->getProperty("jobId");
        if (!isNumber(jobVar) || static_cast<double>(jobVar) != std::floor(static_cast<double>(jobVar))) {
            fail(id, op + " needs the jobId of a finished pitch analysis.");
            return;
        }
        PitchSegments info;
        if (!findPitchSegments(static_cast<int>(static_cast<double>(jobVar)), info)) {
            fail(id, "No note segments are available for that analysis. Analyse the clip again.");
            return;
        }
        if (op == "getPitchMapping") {
            succeed(id, pitchMappingVar(info));
            return;
        }
        if (segmentsOutdated(info, nullptr)) {
            fail(id, "The clip changed after it was analysed. Analyse it again before choosing target notes.");
            return;
        }
        const auto segmentVar = obj->getProperty("segment");
        const double segmentValue = isNumber(segmentVar) ? static_cast<double>(segmentVar) : -1.0;
        if (!(segmentValue >= 0.0 && segmentValue < static_cast<double>(info.segments.size())) || segmentValue != std::floor(segmentValue)) {
            fail(id, "segment must be the index of a detected note.");
            return;
        }
        const auto& segment = info.segments[static_cast<size_t>(segmentValue)];
        const double start = info.sourceStart + segment.start;
        const double end = info.sourceStart + segment.end;
        const double tolerance = std::max(0.03, 2.0 * info.hopSeconds);
        auto matches = [&](const NoteTarget& target) {
            return overrideMatches(target, info.clipId, info.sourceFileId, start, end, segment.medianMidi, tolerance);
        };
        int targetMidi = -1;
        if (op == "setNoteTarget") {
            const auto midiVar = obj->getProperty("targetMidi");
            const double midiValue = isNumber(midiVar) ? static_cast<double>(midiVar) : -1.0;
            if (!(midiValue >= 0.0 && midiValue <= 127.0) || midiValue != std::floor(midiValue)) {
                fail(id, "targetMidi must be a whole MIDI note number from 0 to 127.");
                return;
            }
            targetMidi = static_cast<int>(midiValue);
        }
        const auto error = session.editNoteTargets(info.trackId, info.clipId, [&](Clip& clip) {
            auto& targets = clip.noteTargets;
            const auto before = targets.size();
            targets.erase(std::remove_if(targets.begin(), targets.end(), matches), targets.end());
            if (targetMidi < 0)
                return before == targets.size() ? std::string("That note has no manual target.") : std::string {};
            NoteTarget target;
            target.clipId = info.clipId;
            target.sourceFileId = info.sourceFileId;
            target.sourceStart = start;
            target.sourceEnd = end;
            target.originalMidi = segment.medianMidi;
            target.targetMidi = targetMidi;
            targets.push_back(target);
            return std::string {};
        });
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "clearNoteTargets") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("clipId").isString()) {
            fail(id, "clearNoteTargets needs a trackId and a clipId.");
            return;
        }
        const auto error = session.editNoteTargets(obj->getProperty("trackId").toString().toStdString(),
                                                   obj->getProperty("clipId").toString().toStdString(), [](Clip& clip) {
            if (clip.noteTargets.empty())
                return std::string("This clip has no manual target notes.");
            clip.noteTargets.clear();
            return std::string {};
        });
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "getRealtimeDsp") {
        succeed(id, liveDspVar());
        return;
    }
    if (op == "setRealtimeDsp") {
        if (liveDspConfig.enabled && liveDspConfig.correction) {
            fail(id, "Live pitch correction is using the live input stage. Turn it off with setLiveCorrection first.");
            return;
        }
        auto config = liveDspConfig;
        auto readBool = [&](const char* name, bool& out) {
            if (!obj->hasProperty(name))
                return true;
            if (!obj->getProperty(name).isBool())
                return false;
            out = static_cast<bool>(obj->getProperty(name));
            return true;
        };
        auto readInt = [&](const char* name, int low, int high, int& out) {
            if (!obj->hasProperty(name))
                return true;
            const auto value = obj->getProperty(name);
            if (!isNumber(value))
                return false;
            const double number = static_cast<double>(value);
            if (!(number >= low && number <= high) || number != std::floor(number))
                return false;
            out = static_cast<int>(number);
            return true;
        };
        bool resetStats = false;
        if (!readBool("enabled", config.enabled) || !readBool("bypassed", config.bypassed) || !readBool("resetStatistics", resetStats)) {
            fail(id, "enabled, bypassed and resetStatistics must be true or false.");
            return;
        }
        if (!readInt("latencySamples", 0, kRealtimeMaxLatency - kRealtimeMaxKernelBlock, config.latencySamples)) {
            fail(id, "latencySamples must be a whole number from 0 to " + juce::String(kRealtimeMaxLatency - kRealtimeMaxKernelBlock) + ".");
            return;
        }
        if (!readInt("blockSize", 0, kRealtimeMaxKernelBlock, config.blockSize)) {
            fail(id, "blockSize must be 0 (direct) or a whole number of samples up to " + juce::String(kRealtimeMaxKernelBlock) + ".");
            return;
        }
        if (obj->hasProperty("fadeMs")) {
            const auto value = obj->getProperty("fadeMs");
            if (!isNumber(value) || !(static_cast<double>(value) >= 0.0 && static_cast<double>(value) <= kRealtimeMaxFadeMs)) {
                fail(id, "fadeMs must be between 0 and 100.");
                return;
            }
            config.fadeMs = static_cast<double>(value);
        }
        const bool rebuild = config.enabled != liveDspConfig.enabled || config.latencySamples != liveDspConfig.latencySamples
            || config.blockSize != liveDspConfig.blockSize || config.fadeMs != liveDspConfig.fadeMs || (config.enabled && liveDsp == nullptr);
        if (rebuild && recorder != nullptr) {
            fail(id, "Stop recording before changing the live DSP stage (bypass can change while recording).");
            return;
        }
        liveDspConfig = config;
        if (rebuild) {
            const auto error = configureLiveDsp();
            if (error.isNotEmpty()) {
                fail(id, error);
                return;
            }
        } else if (liveDsp != nullptr) {
            liveDsp->setBypassed(config.bypassed);
        }
        if (resetStats && liveDsp != nullptr)
            liveDsp->requestStatisticsReset();
        succeed(id, liveDspVar());
        return;
    }
    if (op == "getLiveCorrection") {
        succeed(id, liveCorrectionVar());
        return;
    }
    if (op == "setLiveCorrection") {
        auto config = liveDspConfig;
        const bool wasOn = config.enabled && config.correction;
        bool enabled = wasOn;
        bool resetStats = false;
        auto readBool = [&](const char* name, bool& out) {
            if (!obj->hasProperty(name))
                return true;
            if (!obj->getProperty(name).isBool())
                return false;
            out = static_cast<bool>(obj->getProperty(name));
            return true;
        };
        auto readNumber = [&](const char* name, double low, double high, double& out) {
            if (!obj->hasProperty(name))
                return true;
            const auto value = obj->getProperty(name);
            if (!isNumber(value) || !(static_cast<double>(value) >= low && static_cast<double>(value) <= high))
                return false;
            out = static_cast<double>(value);
            return true;
        };
        if (!readBool("enabled", enabled) || !readBool("bypassed", config.bypassed) || !readBool("resetStatistics", resetStats)) {
            fail(id, "enabled, bypassed and resetStatistics must be true or false.");
            return;
        }
        auto& params = config.correctionParams;
        auto& settings = config.correctionSettings;
        if (obj->hasProperty("root")) {
            const auto value = obj->getProperty("root");
            const int pc = value.isString() ? pitchClassFromName(value.toString().toStdString()) : -1;
            if (pc < 0) {
                fail(id, "root must be a note name such as \"C\", \"F#\" or \"Bb\".");
                return;
            }
            params.root = pc;
        }
        if (obj->hasProperty("scale")) {
            const auto value = obj->getProperty("scale");
            if (!value.isString() || !scaleTypeFromName(value.toString().toStdString(), params.scale)) {
                fail(id, "scale must be major, naturalMinor, harmonicMinor, melodicMinor, majorPentatonic, minorPentatonic or chromatic.");
                return;
            }
        }
        double strengthPercent = params.strength * 100.0;
        if (!readNumber("retuneMs", 0.0, kLiveRetuneMaxMs, params.retuneMs)) {
            fail(id, "retuneMs must be a number from 0 to 200.");
            return;
        }
        if (!readNumber("strength", 0.0, 100.0, strengthPercent)) {
            fail(id, "strength must be a number from 0 to 100 (percent).");
            return;
        }
        params.strength = strengthPercent / 100.0;
        if (obj->hasProperty("analysis")) {
            const auto value = obj->getProperty("analysis");
            if (!value.isString() || !liveAnalysisModeFromName(value.toString().toStdString(), settings.analysis)) {
                fail(id, "analysis must be \"inCallback\" or \"worker\".");
                return;
            }
        }
        if (obj->hasProperty("input")) {
            const auto value = obj->getProperty("input");
            if (!value.isString() || !livePitchInputFromName(value.toString().toStdString(), settings.input)) {
                fail(id, "input must be \"input1\", \"input2\" or \"mix\".");
                return;
            }
        }
        if (!readNumber("workerMarginMs", 0.0, kLiveMaxWorkerMarginMs, settings.workerMarginMs)) {
            fail(id, "workerMarginMs must be a number from 0 to 200.");
            return;
        }
        if (obj->hasProperty("monitorMode")) {
            const auto value = obj->getProperty("monitorMode");
            if (!value.isString() || (value.toString() != "raw" && value.toString() != "corrected")) {
                fail(id, "monitorMode must be \"raw\" or \"corrected\".");
                return;
            }
            config.monitorMode = value.toString() == "raw" ? LiveDspConfig::MonitorMode::raw : LiveDspConfig::MonitorMode::corrected;
        }
        if (enabled && config.enabled && !config.correction) {
            fail(id, "The live input stage is in use by the pass-through processor. Turn it off with setRealtimeDsp first.");
            return;
        }
        const auto& old = liveDspConfig.correctionSettings;
        const bool rebuild = enabled != wasOn || (enabled && liveDsp == nullptr)
            || (enabled && (settings.analysis != old.analysis || settings.input != old.input || settings.workerMarginMs != old.workerMarginMs));
        if (rebuild && recorder != nullptr) {
            fail(id, "Stop recording before turning live pitch correction on or off or changing its analysis. "
                     "Key, scale, retune speed, strength, bypass and monitor mode can change while recording.");
            return;
        }
        if (!enabled && config.enabled && !config.correction && obj->hasProperty("bypassed")) {
            fail(id, "The pass-through live DSP stage is active; change its bypass with setRealtimeDsp.");
            return;
        }
        if (enabled)
            config.enabled = true;
        else if (wasOn)
            config.enabled = false;
        config.correction = enabled;
        liveDspConfig = config;
        if (rebuild) {
            const auto error = configureLiveDsp();
            if (error.isNotEmpty()) {
                fail(id, error);
                return;
            }
        } else if (liveCorrection != nullptr) {
            liveCorrection->setParams(params);
            liveDsp->setBypassed(config.bypassed);
            liveMonitorMode.store(config.monitorMode == LiveDspConfig::MonitorMode::raw ? 1 : 0, std::memory_order_release);
        } else {
            liveMonitorMode.store(0, std::memory_order_release);
        }
        if (resetStats && liveDsp != nullptr) {
            liveDsp->requestStatisticsReset();
            if (liveCorrection != nullptr)
                liveCorrection->requestStatisticsReset();
        }
        succeed(id, liveCorrectionVar());
        return;
    }
    if (op == "getLivePitch") {
        const auto recentVar = obj->getProperty("recent");
        int recent = 0;
        if (!recentVar.isVoid()) {
            const double value = isNumber(recentVar) ? static_cast<double>(recentVar) : -1.0;
            if (!(value >= 0.0 && value <= kLivePitchHistory) || value != std::floor(value)) {
                fail(id, "recent must be a whole number from 0 to " + juce::String(kLivePitchHistory) + ".");
                return;
            }
            recent = static_cast<int>(value);
        }
        succeed(id, livePitchVar(recent));
        return;
    }
    if (op == "setLivePitch") {
        auto config = livePitchConfig;
        auto readBool = [&](const char* name, bool& out) {
            if (!obj->hasProperty(name))
                return true;
            if (!obj->getProperty(name).isBool())
                return false;
            out = static_cast<bool>(obj->getProperty(name));
            return true;
        };
        auto readNumber = [&](const char* name, double& out) {
            if (!obj->hasProperty(name))
                return true;
            const auto value = obj->getProperty(name);
            if (!isNumber(value) || !std::isfinite(static_cast<double>(value)))
                return false;
            out = static_cast<double>(value);
            return true;
        };
        auto readWhole = [&](const char* name, int& out) {
            double value = out;
            if (!readNumber(name, value) || value != std::floor(value) || std::abs(value) > 1.0e6)
                return false;
            out = static_cast<int>(value);
            return true;
        };
        bool reset = false;
        bool resetStats = false;
        if (!readBool("enabled", config.enabled) || !readBool("reset", reset) || !readBool("resetStatistics", resetStats)) {
            fail(id, "enabled, reset and resetStatistics must be true or false.");
            return;
        }
        auto& s = config.settings;
        if (obj->hasProperty("input")) {
            const auto input = obj->getProperty("input");
            if (!input.isString() || !livePitchInputFromName(input.toString().toStdString(), s.input)) {
                fail(id, "input must be \"input1\", \"input2\" or \"mix\".");
                return;
            }
        }
        if (!readNumber("minHz", s.minHz) || !readNumber("maxHz", s.maxHz) || !readNumber("confidenceThreshold", s.confidenceThreshold)
            || !readNumber("silenceDb", s.silenceDb) || !readWhole("windowSize", s.windowSize) || !readWhole("hopSize", s.hopSize)) {
            fail(id, "minHz, maxHz, confidenceThreshold and silenceDb must be numbers; windowSize and hopSize whole numbers.");
            return;
        }
        const auto error = checkLivePitchSettings(s, static_cast<double>(std::max(8000, sampleRate.load())));
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        const auto& old = livePitchConfig.settings;
        const bool restart = config.enabled != livePitchConfig.enabled || (config.enabled && livePitch == nullptr)
            || s.input != old.input || s.minHz != old.minHz || s.maxHz != old.maxHz || s.windowSize != old.windowSize
            || s.hopSize != old.hopSize || s.confidenceThreshold != old.confidenceThreshold || s.silenceDb != old.silenceDb;
        livePitchConfig = config;
        if (restart) {
            const auto startError = configureLivePitch();
            if (startError.isNotEmpty()) {
                fail(id, startError);
                return;
            }
        } else if (livePitch != nullptr) {
            if (reset)
                livePitch->requestReset();
            if (resetStats)
                livePitch->resetStatistics();
        }
        succeed(id, livePitchVar(0));
        return;
    }
    if (op == "setVirtualInput") {
        if (recorder != nullptr) {
            fail(id, "Stop recording before changing the input.");
            return;
        }
        if (!obj->getProperty("enabled").isBool()) {
            fail(id, "setVirtualInput needs enabled true or false.");
            return;
        }
        double frequency = virtualFrequency.load();
        float level = virtualLevel.load();
        if (obj->hasProperty("frequency")) {
            const auto value = obj->getProperty("frequency");
            if (!isNumber(value) || !(static_cast<double>(value) >= 20.0 && static_cast<double>(value) <= 20000.0)) {
                fail(id, "Test signal frequency must be between 20 and 20000 Hz.");
                return;
            }
            frequency = static_cast<double>(value);
        }
        if (obj->hasProperty("level")) {
            const auto value = obj->getProperty("level");
            if (!isNumber(value) || !(static_cast<double>(value) >= 0.0 && static_cast<double>(value) <= 1.0)) {
                fail(id, "Test signal level must be between 0 and 1.");
                return;
            }
            level = static_cast<float>(static_cast<double>(value));
        }
        virtualFrequency.store(frequency);
        virtualLevel.store(level);
        virtualOn.store(static_cast<bool>(obj->getProperty("enabled")));
        succeed(id, stateVar());
        return;
    }
    if (op == "setRecordFolder") {
        if (recorder != nullptr) {
            fail(id, "Stop recording before changing the recording folder.");
            return;
        }
        const auto pathVar = obj->getProperty("path");
        if (!pathVar.isString() || !juce::File::isAbsolutePath(pathVar.toString())) {
            fail(id, "setRecordFolder needs an absolute folder path.");
            return;
        }
        const juce::File folder(pathVar.toString());
        if (!folder.createDirectory().wasOk()) {
            fail(id, "Could not create the recording folder " + folder.getFullPathName() + ".");
            return;
        }
        recordFolder = folder;
        succeed(id, stateVar());
        return;
    }
    if (op == "setTrackRecord") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "setTrackRecord needs a string trackId.");
            return;
        }
        const auto trackId = obj->getProperty("trackId").toString().toStdString();
        const int index = session.indexOf(trackId);
        if (index < 0) {
            fail(id, "No track is loaded with that id.");
            return;
        }
        bool armed = false;
        bool monitorInput = false;
        RecordInput input = RecordInput::first;
        RecordMode mode = RecordMode::dry;
        const bool hasArmed = obj->hasProperty("armed");
        const bool hasMonitor = obj->hasProperty("monitor");
        const bool hasInput = obj->hasProperty("input");
        const bool hasMode = obj->hasProperty("mode");
        if ((hasArmed && !obj->getProperty("armed").isBool()) || (hasMonitor && !obj->getProperty("monitor").isBool())) {
            fail(id, "Record arm and input monitoring must be true or false.");
            return;
        }
        if (hasInput && !recordInputFromName(obj->getProperty("input").toString().toStdString(), input)) {
            fail(id, "Record input must be \"1\", \"2\", or \"1+2\".");
            return;
        }
        if (hasMode && !recordModeFromName(obj->getProperty("mode").toString().toStdString(), mode)) {
            fail(id, "Record mode must be dry, processed, or both.");
            return;
        }
        if (recorder != nullptr && (hasArmed || hasInput || hasMode)) {
            fail(id, "Stop recording before changing which tracks record or how.");
            return;
        }
        if (hasArmed)
            armed = static_cast<bool>(obj->getProperty("armed"));
        if (hasMonitor)
            monitorInput = static_cast<bool>(obj->getProperty("monitor"));
        if (hasArmed && armed && !session.tracks[static_cast<size_t>(index)].armed) {
            int count = 0;
            for (const auto& track : session.tracks)
                count += track.used && track.armed ? 1 : 0;
            if (count >= kMaxRecordTracks) {
                fail(id, "At most " + juce::String(kMaxRecordTracks) + " tracks can be armed at once.");
                return;
            }
        }
        const auto error = session.setTrackRecord(trackId, hasArmed ? &armed : nullptr, hasInput ? &input : nullptr,
                                                  hasMode ? &mode : nullptr, hasMonitor ? &monitorInput : nullptr);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "record") {
        const auto action = obj->getProperty("action").toString();
        if (!obj->getProperty("action").isString() || (action != "start" && action != "stop")) {
            fail(id, "record needs an action of start or stop.");
            return;
        }
        if (action == "start") {
            const auto error = startRecording(parsed);
            if (error.isNotEmpty()) {
                fail(id, error);
                return;
            }
            succeed(id, stateVar());
            return;
        }
        if (recorder == nullptr) {
            fail(id, "Nothing is being recorded.");
            return;
        }
        const int64_t takeStart = recordStart.load();
        auto take = finishRecording();
        // The playhead returns to where the take starts.
        Clock stopped;
        stopped.position = takeStart;
        session.clock = stopped;
        transport.store(static_cast<int>(TransportMode::stopped), std::memory_order_relaxed);
        position.store(takeStart, std::memory_order_relaxed);
        auto state = stateVar();
        state.getDynamicObject()->setProperty("take", take);
        succeed(id, state);
        return;
    }
    if (op == "startCapture") {
        // Diagnostic: records what the audio callback renders while the transport plays.
        if (!isNumber(obj->getProperty("seconds")) || static_cast<double>(obj->getProperty("seconds")) <= 0.0
            || static_cast<double>(obj->getProperty("seconds")) > 120.0) {
            fail(id, "startCapture needs seconds between 0 and 120.");
            return;
        }
        endCapture();
        const auto frames = static_cast<size_t>(std::ceil(static_cast<double>(obj->getProperty("seconds")) * std::max(1, sampleRate.load())));
        captureL.assign(frames, 0.0f);
        captureR.assign(frames, 0.0f);
        captureEnd.store(0, std::memory_order_relaxed);
        captureWritten.store(0, std::memory_order_relaxed);
        captureOn.store(true, std::memory_order_release);
        auto* result = new juce::DynamicObject();
        result->setProperty("frames", static_cast<juce::int64>(frames));
        succeed(id, juce::var(result));
        return;
    }
    if (op == "stopCapture") {
        if (!obj->getProperty("path").isString()) {
            fail(id, "stopCapture needs a WAV file path.");
            return;
        }
        endCapture();
        const auto end = std::min<int64_t>(captureEnd.load(std::memory_order_acquire), static_cast<int64_t>(captureL.size()));
        const auto error = writeWavFile(obj->getProperty("path").toString().toStdString(), static_cast<double>(std::max(1, sampleRate.load())),
                                        captureL.data(), captureR.data(), end, 24);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("path", obj->getProperty("path"));
        result->setProperty("frames", static_cast<juce::int64>(end));
        result->setProperty("written", static_cast<juce::int64>(captureWritten.load(std::memory_order_acquire)));
        captureL = {};
        captureR = {};
        succeed(id, juce::var(result));
        return;
    }
    if (op == "renderPlayback") {
        // Diagnostic: runs the published realtime plan through mixRoute offline, as the audio callback does,
        // with its own ramp state and peak meters so the live callback is not disturbed.
        if (!obj->getProperty("path").isString()) {
            fail(id, "renderPlayback needs a WAV file path.");
            return;
        }
        const auto* snap = mixHead.load(std::memory_order_acquire);
        const int64_t timeline = snap != nullptr ? snap->timeline : 0;
        if (snap == nullptr || timeline <= 0) {
            fail(id, "There is nothing to render.");
            return;
        }
        MixPlan plan = snap->plan;
        if (obj->hasProperty("tail")) {
            TailSettings tail = session.renderTail;
            const auto tailError = readTail(obj->getProperty("tail"), tail);
            if (tailError.isNotEmpty()) {
                fail(id, tailError);
                return;
            }
            applyRenderTail(plan, tail);
        }
        const int64_t capacity = timeline + plan.tailMax;
        std::vector<float> outL(static_cast<size_t>(capacity), 0.0f), outR(static_cast<size_t>(capacity), 0.0f);
        Clock clock;
        clock.mode = TransportMode::playing;
        clock.position = 0;
        const float master = masterGain.load(std::memory_order_relaxed);
        MixState offline;
        prepareMixState(plan, offline);
        constexpr int block = 480;
        int64_t done = 0;
        int64_t length = timeline;
        float renderPeakL = 0.0f;
        float renderPeakR = 0.0f;
        while (done < capacity && clock.mode == TransportMode::playing) {
            const int n = static_cast<int>(std::min<int64_t>(block, capacity - done));
            const auto mixed = mixRoute(plan, offline, master, clock, timeline,
                                        outL.data() + done, outR.data() + done, n, nullptr, nullptr, false);
            renderPeakL = std::max(renderPeakL, mixed.peakL);
            renderPeakR = std::max(renderPeakR, mixed.peakR);
            clock = mixed.clock;
            done += n;
            if (mixed.end >= 0)
                length = std::clamp<int64_t>(mixed.end, timeline, capacity);
        }
        const auto path = obj->getProperty("path").toString().toStdString();
        const auto error = writeWavFile(path, session.playbackRate, outL.data(), outR.data(), length, 24);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("path", obj->getProperty("path"));
        result->setProperty("sampleRate", session.playbackRate);
        result->setProperty("samples", static_cast<juce::int64>(length));
        result->setProperty("timelineSamples", static_cast<juce::int64>(timeline));
        result->setProperty("tailSamples", static_cast<juce::int64>(length - timeline));
        result->setProperty("meters", renderedMeters(plan, offline, renderPeakL, renderPeakR));
        succeed(id, juce::var(result));
        return;
    }
    if (op == "newProject") {
        if (recorder != nullptr) {
            fail(id, "Stop recording before creating a new project.");
            return;
        }
        transport.store(static_cast<int>(TransportMode::stopped), std::memory_order_relaxed);
        position.store(0, std::memory_order_relaxed);
        session.clock = Clock {};
        std::vector<std::string> existingIds;
        for (const auto& existing : session.tracks)
            if (existing.used)
                existingIds.push_back(existing.id);
        for (const auto& existingId : existingIds)
            holdRetired(session.removeTrack(existingId));
        session.buses.clear();
        session.masterEffects.clear();
        session.masterAutomation.clear();
        session.customVocalPresets.clear();
        session.effectUndoStack.clear();
        session.effectRedoStack.clear();
        session.vocalPresetPreview = {};
        session.masterGain = 1.0f;
        masterGain.store(1.0f, std::memory_order_relaxed);
        session.renderTail = TailSettings {};
        session.projectId = makeProjectId();
        session.projectName = obj->getProperty("name").isString()
            ? obj->getProperty("name").toString().toStdString()
            : "Untitled";
        if (session.projectName.empty())
            session.projectName = "Untitled";
        ++projectGeneration;
        {
            const std::lock_guard<std::mutex> lock(pitchSegmentsMutex);
            pitchSegments.clear();
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "setProjectMeta") {
        if (obj->getProperty("name").isString()) {
            auto name = obj->getProperty("name").toString().toStdString();
            if (name.empty())
                name = "Untitled";
            session.projectName = name;
        }
        if (obj->getProperty("projectId").isString()) {
            const auto idValue = obj->getProperty("projectId").toString().toStdString();
            if (!idValue.empty())
                session.projectId = idValue;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "saveProject") {
        if (!obj->getProperty("path").isString()) {
            fail(id, "Save needs a project file path.");
            return;
        }
        if (session.projectId.empty())
            session.projectId = makeProjectId();
        if (obj->getProperty("name").isString()) {
            auto name = obj->getProperty("name").toString().toStdString();
            if (!name.empty())
                session.projectName = name;
        }
        const auto project = session.toProject(outputDeviceName.toStdString(), inputDeviceName.toStdString(), bufferSize.load());
        const auto error = saveProjectFile(obj->getProperty("path").toString().toStdString(), project);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        auto* result = new juce::DynamicObject();
        result->setProperty("path", obj->getProperty("path"));
        result->setProperty("version", project.version);
        result->setProperty("projectId", juce::String::fromUTF8(project.projectId.c_str()));
        result->setProperty("projectName", juce::String::fromUTF8(project.projectName.c_str()));
        succeed(id, juce::var(result));
        return;
    }
    if (op == "loadProject") {
        if (!obj->getProperty("path").isString()) {
            fail(id, "Load needs a project file path.");
            return;
        }
        auto project = loadProjectFile(obj->getProperty("path").toString().toStdString());
        if (!project.error.empty()) {
            fail(id, juce::String::fromUTF8(project.error.c_str()));
            return;
        }
        transport.store(static_cast<int>(TransportMode::stopped), std::memory_order_relaxed);
        position.store(0, std::memory_order_relaxed);
        session.clock = Clock {};
        openDevices(juce::String::fromUTF8(project.outputDevice.c_str()),
                    juce::String::fromUTF8(project.inputDevice.c_str()),
                    project.sampleRate,
                    project.bufferSize);
        session.masterGain = project.masterGain;
        masterGain.store(project.masterGain, std::memory_order_relaxed);
        session.projectId = project.projectId.empty() ? makeProjectId() : project.projectId;
        if (!project.projectName.empty()) {
            session.projectName = project.projectName;
        } else {
            const auto pathStr = obj->getProperty("path").toString();
            const auto stem = juce::File(pathStr).getFileNameWithoutExtension();
            session.projectName = stem.isNotEmpty() ? stem.toStdString() : "Untitled";
        }
        juce::Array<juce::var> warnings;
        if (!deviceOpen.load() && deviceError.isNotEmpty())
            warnings.add(deviceError);
        std::vector<std::string> existingIds;
        existingIds.reserve(session.tracks.size());
        for (const auto& existing : session.tracks)
            existingIds.push_back(existing.id);
        for (const auto& existingId : existingIds) {
            auto cleared = session.removeTrack(existingId);
            holdRetired(std::move(cleared));
        }
        session.buses = project.buses;
        for (auto& bus : session.buses)
            scaleAutomation(bus.automation, project.sampleRate, session.playbackRate);
        session.nextBusNumber = 1;
        session.masterEffects = project.masterEffects;
        session.masterAutomation = project.masterAutomation;
        scaleAutomation(session.masterAutomation, project.sampleRate, session.playbackRate);
        session.nextEffectNumber = 1;
        session.renderTail = project.renderTail;
        session.pitchMapping = project.pitchMapping;
        session.customVocalPresets = project.customVocalPresets;
        session.effectUndoStack.clear();
        session.effectRedoStack.clear();
        session.vocalPresetPreview = {};
        if (livePitch != nullptr)
            livePitch->setKey(session.pitchMapping.key, session.pitchMapping.settings);
        ++projectGeneration;
        {
            const std::lock_guard<std::mutex> lock(pitchSegmentsMutex);
            pitchSegments.clear();
        }
        for (const auto& track : project.tracks) {
            const bool fileExists = !track.path.empty() && juce::File(juce::String::fromUTF8(track.path.c_str())).existsAsFile();
            int trackIndex = -1;
            if (track.path.empty()) {
                trackIndex = session.claimTrack(track.id);
                session.tracks[static_cast<size_t>(trackIndex)].name = track.name;
            } else if (!fileExists) {
                auto missing = session.createMissingTrack(track.id, track.path, track.name);
                if (!missing.error.empty()) {
                    warnings.add(juce::String::fromUTF8(missing.error.c_str()));
                    continue;
                }
                warnings.add("Missing audio file: " + juce::String::fromUTF8(track.path.c_str()));
                trackIndex = missing.index;
                holdRetired(std::move(missing));
            } else {
                auto imported = session.importFile(track.id, track.path);
                if (!imported.error.empty()) {
                    warnings.add(juce::String::fromUTF8(imported.error.c_str()));
                    continue;
                }
                trackIndex = imported.index;
                holdRetired(std::move(imported));
            }
            if (!track.name.empty())
                session.tracks[static_cast<size_t>(trackIndex)].name = track.name;
            for (const auto& extra : track.extras) {
                const auto extraError = session.addExtraFile(track.id, extra.id, extra.path);
                if (!extraError.empty())
                    warnings.add(juce::String::fromUTF8(extraError.c_str()));
            }
            ProjectTrack controls = track;
            session.setTrack(track.id, controls, true, true, true, true);
            session.tracks[static_cast<size_t>(trackIndex)].output = track.output;
            session.tracks[static_cast<size_t>(trackIndex)].sends = track.sends;
            session.tracks[static_cast<size_t>(trackIndex)].effects = track.effects;
            {
                auto& loaded = session.tracks[static_cast<size_t>(trackIndex)];
                loaded.automation = track.automation;
                scaleAutomation(loaded.automation, project.sampleRate, session.playbackRate);
                loaded.vocalPresetId = track.vocalPresetId;
                loaded.vocalPresetBypassed = track.vocalPresetBypassed;
                loaded.vocalPresetPrevious = track.vocalPresetPrevious;
                loaded.armed = track.armed;
                loaded.recordInput = track.recordInput;
                loaded.recordMode = track.recordMode;
                loaded.monitorInput = track.monitorInput;
                if (loaded.monitorInput && inputChannels.load() <= 0 && !virtualOn.load()) {
                    loaded.monitorInput = false;
                    warnings.add("Track " + juce::String::fromUTF8(track.name.c_str())
                                 + " asked for input monitoring, but no input device is open. Monitoring stays off.");
                }
            }
            {
                auto& loaded = session.tracks[static_cast<size_t>(trackIndex)];
                loaded.takesExpanded = track.takesExpanded;
                if (session.playbackRate > 0.0)
                    loaded.compCrossfadeSamples = std::max<int64_t>(
                        0, static_cast<int64_t>(std::llround(session.playbackRate * track.compCrossfadeMs / 1000.0)));
                loaded.autoCrossfadeEnabled = track.autoCrossfadeEnabled;
                loaded.autoCrossfadeMs = track.autoCrossfadeMs;
                {
                    bool curveOk = true;
                    loaded.autoCrossfadeCurve = msp::fadeCurveFromName(track.autoCrossfadeCurve, &curveOk);
                }
                for (const auto& saved : track.takes) {
                    msp::Take take;
                    take.id = saved.id;
                    take.name = saved.name;
                    take.sourceFileId = saved.sourceFileId;
                    take.timelineStart = scaleSamples(saved.timelineStart, project.sampleRate, session.playbackRate);
                    take.duration = std::max<int64_t>(1, scaleSamples(saved.duration, project.sampleRate, session.playbackRate));
                    take.muted = saved.muted;
                    loaded.takes.push_back(take);
                    if (take.id.rfind("take-", 0) == 0) {
                        try {
                            const auto number = std::stoll(take.id.substr(5));
                            if (number >= session.nextTakeNumber)
                                session.nextTakeNumber = number + 1;
                        } catch (...) {
                        }
                    }
                }
            }
            if (track.explicitClips) {
                std::vector<Clip> clips;
                const double projectRate = project.sampleRate;
                const double deviceRate = session.playbackRate;
                for (const auto& saved : track.clips) {
                    Clip clip;
                    clip.id = saved.id;
                    clip.sourceFileId = saved.sourceFileId;
                    clip.timelineStart = scaleSamples(saved.timelineStart, projectRate, deviceRate);
                    clip.sourceOffset = scaleSamples(saved.sourceOffset, projectRate, deviceRate);
                    clip.duration = std::max<int64_t>(1, scaleSamples(saved.duration, projectRate, deviceRate));
                    clip.fadeIn = scaleSamples(saved.fadeIn, projectRate, deviceRate);
                    clip.fadeOut = scaleSamples(saved.fadeOut, projectRate, deviceRate);
                    {
                        bool ok = true;
                        clip.fadeInCurve = msp::fadeCurveFromName(saved.fadeInCurve, &ok);
                        clip.fadeOutCurve = msp::fadeCurveFromName(saved.fadeOutCurve, &ok);
                        clip.crossfadePartnerId = saved.crossfadePartnerId;
                        clip.crossfadeCurve = msp::fadeCurveFromName(saved.crossfadeCurve, &ok);
                        clip.crossfadeDuration = scaleSamples(saved.crossfadeDuration, projectRate, deviceRate);
                    }
                    clip.gain = saved.gain;
                    clip.originalSourceFileId = saved.originalSourceFileId;
                    clip.originalSourceOffset = scaleSamples(saved.originalSourceOffset, projectRate, deviceRate);
                    clip.pitchShiftCents = saved.pitchShiftCents;
                    clip.pitchLabel = saved.pitchLabel;
                    clip.noteTargets = saved.noteTargets;
                    clip.timingMarkers = saved.timingMarkers;
                    for (auto& marker : clip.timingMarkers)
                        marker.sourceSample = scaleSamples(marker.sourceSample, projectRate, deviceRate);
                    clip.timingOriginalSourceFileId = saved.timingOriginalSourceFileId;
                    clip.timingOriginalSourceOffset = scaleSamples(saved.timingOriginalSourceOffset, projectRate, deviceRate);
                    clip.timingOriginalDuration = scaleSamples(saved.timingOriginalDuration, projectRate, deviceRate);
                    clip.timingLabel = saved.timingLabel;
                    clip.breathRegions = saved.breathRegions;
                    for (auto& region : clip.breathRegions) {
                        region.sourceStart = scaleSamples(region.sourceStart, projectRate, deviceRate);
                        region.sourceEnd = scaleSamples(region.sourceEnd, projectRate, deviceRate);
                        region.fadeIn = scaleSamples(region.fadeIn, projectRate, deviceRate);
                        region.fadeOut = scaleSamples(region.fadeOut, projectRate, deviceRate);
                    }
                    clip.breathOriginalSourceFileId = saved.breathOriginalSourceFileId;
                    clip.breathOriginalSourceOffset = scaleSamples(saved.breathOriginalSourceOffset, projectRate, deviceRate);
                    clip.breathOriginalDuration = scaleSamples(saved.breathOriginalDuration, projectRate, deviceRate);
                    clip.breathLabel = saved.breathLabel;
                    clip.stretchMode = saved.stretchMode;
                    clip.stretchRatio = saved.stretchRatio;
                    clip.stretchOriginalSourceFileId = saved.stretchOriginalSourceFileId;
                    clip.stretchOriginalSourceOffset = scaleSamples(saved.stretchOriginalSourceOffset, projectRate, deviceRate);
                    clip.stretchOriginalDuration = scaleSamples(saved.stretchOriginalDuration, projectRate, deviceRate);
                    clip.stretchLabel = saved.stretchLabel;
                    const auto limit = session.sourceLength(session.tracks[static_cast<size_t>(trackIndex)], clip.sourceFileId);
                    if (limit >= 0 && clip.sourceOffset + clip.duration > limit)
                        clip.duration = std::max<int64_t>(1, limit - clip.sourceOffset);
                    clips.push_back(clip);
                }
                RetiredAudio retiredClips;
                const auto clipError = session.replaceClips(track.id, clips, retiredClips);
                if (!clipError.empty())
                    warnings.add(juce::String::fromUTF8(clipError.c_str()));
                else
                    holdRetired(std::move(retiredClips));
            }
        }
        std::vector<int> unnamed;
        for (const auto& track : project.tracks) {
            const int index = session.indexOf(track.id);
            if (track.name.empty() && index >= 0) {
                session.tracks[static_cast<size_t>(index)].name.clear();
                unnamed.push_back(index);
            }
        }
        for (const int index : unnamed)
            session.tracks[static_cast<size_t>(index)].name = session.autoTrackName(index + 1, index);
        std::vector<std::string> routingNotes = project.warnings;
        session.repairRouting(routingNotes);
        session.repairEffects(routingNotes);
        session.repairAutomation(routingNotes);
        int armedCount = 0;
        for (auto& loaded : session.tracks) {
            if (!loaded.used || !loaded.armed)
                continue;
            if (++armedCount > kMaxRecordTracks) {
                loaded.armed = false;
                routingNotes.push_back("Track " + loaded.name + " was disarmed: at most " + std::to_string(kMaxRecordTracks) + " tracks can be armed.");
            }
        }
        for (const auto& note : routingNotes)
            warnings.add(juce::String::fromUTF8(note.c_str()));
        publishMix();
        bool monitorOn = project.monitorEnabled;
        if (monitorOn && inputChannels.load() <= 0) {
            monitorOn = false;
            warnings.add("The project requested microphone monitoring, but no input device is open. Monitoring stays off.");
        }
        session.monitor = monitorOn;
        monitor.store(monitorOn, std::memory_order_relaxed);
        auto* result = new juce::DynamicObject();
        result->setProperty("state", stateVar());
        result->setProperty("warnings", warnings);
        succeed(id, juce::var(result));
        return;
    }

    const auto trackId = obj->getProperty("trackId").toString().toStdString();
    const auto clipId = obj->getProperty("clipId").toString().toStdString();
    const auto secondsToSamples = [&](const char* key) {
        return std::llround(static_cast<double>(obj->getProperty(key)) * std::max(1, sampleRate.load()));
    };
    auto finishEdit = [&](const std::string& error, RetiredAudio retiredBuffers) {
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        holdRetired(std::move(retiredBuffers));
        publishMix();
        succeed(id, stateVar());
    };
    if (op == "importClip" || op == "splitClip" || op == "moveClip" || op == "trimClip" || op == "deleteClip" || op == "duplicateClip" || op == "setClipGain" || op == "setClipFades") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "Clip editing needs a trackId.");
            return;
        }
    }
    if (op == "importClip") {
        if (!obj->getProperty("path").isString() || !isNumber(obj->getProperty("timelineStart"))) {
            fail(id, "importClip needs a path and a timelineStart in seconds.");
            return;
        }
        auto retiredBuffers = session.importClip(trackId, obj->getProperty("path").toString().toStdString(), secondsToSamples("timelineStart"));
        finishEdit(retiredBuffers.error, std::move(retiredBuffers));
        return;
    }
    if (op == "splitClip") {
        if (!obj->getProperty("clipId").isString() || !isNumber(obj->getProperty("position"))) {
            fail(id, "splitClip needs a clipId and a position in seconds.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.splitClipAt(trackId, clipId, secondsToSamples("position"), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "moveClip") {
        if (!obj->getProperty("clipId").isString() || !isNumber(obj->getProperty("timelineStart"))) {
            fail(id, "moveClip needs a clipId and a timelineStart in seconds.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.moveClipTo(trackId, clipId, secondsToSamples("timelineStart"), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "trimClip") {
        const auto edge = obj->getProperty("edge").toString();
        if (!obj->getProperty("clipId").isString() || (edge != "left" && edge != "right") || !isNumber(obj->getProperty("position"))) {
            fail(id, "trimClip needs clipId, edge left or right, and position in seconds.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.trimClipEdge(trackId, clipId, edge == "left", secondsToSamples("position"), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "deleteClip") {
        if (!obj->getProperty("clipId").isString()) {
            fail(id, "deleteClip needs a clipId.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.deleteClipById(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "duplicateClip") {
        if (!obj->getProperty("clipId").isString() || !isNumber(obj->getProperty("timelineStart"))) {
            fail(id, "duplicateClip needs a clipId and a timelineStart in seconds.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.duplicateClipAt(trackId, clipId, secondsToSamples("timelineStart"), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "setClipGain") {
        if (!obj->getProperty("clipId").isString() || !isNumber(obj->getProperty("gain"))) {
            fail(id, "setClipGain needs a clipId and a gain.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.setClipGainValue(trackId, clipId, static_cast<float>(static_cast<double>(obj->getProperty("gain"))), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "setClipFades") {
        if (!obj->getProperty("clipId").isString() || !isNumber(obj->getProperty("fadeIn")) || !isNumber(obj->getProperty("fadeOut"))) {
            fail(id, "setClipFades needs clipId, fadeIn, and fadeOut in seconds.");
            return;
        }
        FadeCurve fadeInCurve = FadeCurve::linear;
        FadeCurve fadeOutCurve = FadeCurve::linear;
        const FadeCurve* inPtr = nullptr;
        const FadeCurve* outPtr = nullptr;
        if (obj->getProperty("fadeInCurve").isString()) {
            bool ok = false;
            fadeInCurve = msp::fadeCurveFromName(obj->getProperty("fadeInCurve").toString().toStdString(), &ok);
            if (!ok) {
                fail(id, "fadeInCurve must be linear, equalPower, or sCurve.");
                return;
            }
            inPtr = &fadeInCurve;
        }
        if (obj->getProperty("fadeOutCurve").isString()) {
            bool ok = false;
            fadeOutCurve = msp::fadeCurveFromName(obj->getProperty("fadeOutCurve").toString().toStdString(), &ok);
            if (!ok) {
                fail(id, "fadeOutCurve must be linear, equalPower, or sCurve.");
                return;
            }
            outPtr = &fadeOutCurve;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.setClipFadeValues(trackId, clipId, std::max<int64_t>(0, secondsToSamples("fadeIn")),
                                                     std::max<int64_t>(0, secondsToSamples("fadeOut")), retiredBuffers,
                                                     inPtr, outPtr);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "previewCrossfade" || op == "applyCrossfade" || op == "revertCrossfade" || op == "cancelCrossfadePreview"
        || op == "setAutoCrossfade") {
        // Phase 2.8.2 crossfade IPC — validated below.
    }
    if (op == "previewCrossfade" || op == "applyCrossfade") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("leftClipId").isString()
            || !obj->getProperty("rightClipId").isString() || !isNumber(obj->getProperty("duration"))) {
            fail(id, op + " needs trackId, leftClipId, rightClipId, and duration (seconds).");
            return;
        }
        bool curveOk = true;
        FadeCurve curve = FadeCurve::linear;
        if (obj->getProperty("curve").isString())
            curve = msp::fadeCurveFromName(obj->getProperty("curve").toString().toStdString(), &curveOk);
        if (!curveOk) {
            fail(id, "curve must be linear, equalPower, or sCurve.");
            return;
        }
        const auto leftId = obj->getProperty("leftClipId").toString().toStdString();
        const auto rightId = obj->getProperty("rightClipId").toString().toStdString();
        const int64_t duration = std::max<int64_t>(0, secondsToSamples("duration"));
        RetiredAudio retiredBuffers;
        const auto error = op == "previewCrossfade"
            ? session.previewCrossfade(trackId, leftId, rightId, duration, curve, retiredBuffers)
            : session.applyCrossfade(trackId, leftId, rightId, duration, curve, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "cancelCrossfadePreview") {
        holdRetired(session.endCrossfadePreview());
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "revertCrossfade") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("leftClipId").isString()
            || !obj->getProperty("rightClipId").isString()) {
            fail(id, "revertCrossfade needs trackId, leftClipId, and rightClipId.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.revertCrossfade(trackId,
                                                   obj->getProperty("leftClipId").toString().toStdString(),
                                                   obj->getProperty("rightClipId").toString().toStdString(),
                                                   retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "setAutoCrossfade") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "setAutoCrossfade needs trackId.");
            return;
        }
        const bool enabled = obj->hasProperty("enabled") ? static_cast<bool>(obj->getProperty("enabled")) : false;
        double ms = msp::kDefaultAutoCrossfadeMs;
        if (obj->hasProperty("durationMs") && isNumber(obj->getProperty("durationMs")))
            ms = static_cast<double>(obj->getProperty("durationMs"));
        else if (obj->hasProperty("ms") && isNumber(obj->getProperty("ms")))
            ms = static_cast<double>(obj->getProperty("ms"));
        bool curveOk = true;
        FadeCurve curve = FadeCurve::linear;
        if (obj->getProperty("curve").isString())
            curve = msp::fadeCurveFromName(obj->getProperty("curve").toString().toStdString(), &curveOk);
        if (!curveOk) {
            fail(id, "curve must be linear, equalPower, or sCurve.");
            return;
        }
        const auto error = session.setAutoCrossfade(trackId, enabled, ms, curve);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "importTake" || op == "renameTake" || op == "removeTake" || op == "setTakeMuted" || op == "setTakesExpanded"
        || op == "setCompCrossfade" || op == "setCompRegion") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "Vocal take editing needs a trackId.");
            return;
        }
    }
    if (op == "importTake") {
        if (!obj->getProperty("path").isString() || !isNumber(obj->getProperty("timelineStart"))) {
            fail(id, "importTake needs a path and a timelineStart in seconds.");
            return;
        }
        std::string createdTakeId;
        auto retiredBuffers = session.importTake(trackId, obj->getProperty("path").toString().toStdString(),
                                                 secondsToSamples("timelineStart"), &createdTakeId);
        finishEdit(retiredBuffers.error, std::move(retiredBuffers));
        return;
    }
    if (op == "renameTake") {
        if (!obj->getProperty("takeId").isString() || !obj->getProperty("name").isString()) {
            fail(id, "renameTake needs takeId and name.");
            return;
        }
        const auto error = session.renameTake(trackId, obj->getProperty("takeId").toString().toStdString(),
                                              obj->getProperty("name").toString().toStdString());
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "removeTake") {
        if (!obj->getProperty("takeId").isString()) {
            fail(id, "removeTake needs a takeId.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.removeTake(trackId, obj->getProperty("takeId").toString().toStdString(), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "setTakeMuted") {
        if (!obj->getProperty("takeId").isString() || !obj->getProperty("muted").isBool()) {
            fail(id, "setTakeMuted needs takeId and muted.");
            return;
        }
        const auto error = session.setTakeMuted(trackId, obj->getProperty("takeId").toString().toStdString(),
                                                static_cast<bool>(obj->getProperty("muted")));
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "setTakesExpanded") {
        if (!obj->getProperty("expanded").isBool()) {
            fail(id, "setTakesExpanded needs expanded true or false.");
            return;
        }
        const auto error = session.setTakesExpanded(trackId, static_cast<bool>(obj->getProperty("expanded")));
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "setCompCrossfade") {
        if (!isNumber(obj->getProperty("ms"))) {
            fail(id, "setCompCrossfade needs ms (0 to 100).");
            return;
        }
        const auto error = session.setCompCrossfadeMs(trackId, static_cast<double>(obj->getProperty("ms")));
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "setCompRegion") {
        if (!obj->getProperty("takeId").isString() || !isNumber(obj->getProperty("timelineStart")) || !isNumber(obj->getProperty("timelineEnd"))) {
            fail(id, "setCompRegion needs takeId, timelineStart and timelineEnd in seconds.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.setCompRegion(trackId, obj->getProperty("takeId").toString().toStdString(),
                                                 secondsToSamples("timelineStart"), secondsToSamples("timelineEnd"), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "analyzeOnsets" || op == "addTimingMarker" || op == "removeTimingMarker" || op == "moveTimingMarker"
        || op == "applyTimingAlign" || op == "revertTimingAlign") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("clipId").isString()) {
            fail(id, "Vocal timing edits need trackId and clipId.");
            return;
        }
    }
    if (op == "analyzeOnsets") {
        RetiredAudio retiredBuffers;
        const auto error = session.analyzeClipOnsets(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "addTimingMarker") {
        if (!isNumber(obj->getProperty("timeline"))) {
            fail(id, "addTimingMarker needs timeline in seconds.");
            return;
        }
        const int trackIndex = session.indexOf(trackId);
        if (trackIndex < 0) {
            fail(id, "No track exists with that id.");
            return;
        }
        Clip* clip = nullptr;
        for (auto& item : session.tracks[static_cast<size_t>(trackIndex)].clips)
            if (item.id == clipId)
                clip = &item;
        if (clip == nullptr) {
            fail(id, "That clip is not on the track.");
            return;
        }
        const int64_t sourceSample = clip->sourceOffset + (secondsToSamples("timeline") - clip->timelineStart);
        std::string markerId;
        RetiredAudio retiredBuffers;
        const auto error = session.addTimingMarker(trackId, clipId, sourceSample, true, &markerId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "removeTimingMarker") {
        if (!obj->getProperty("markerId").isString()) {
            fail(id, "removeTimingMarker needs markerId.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.removeTimingMarker(trackId, clipId, obj->getProperty("markerId").toString().toStdString(), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "moveTimingMarker") {
        if (!obj->getProperty("markerId").isString() || !isNumber(obj->getProperty("timeline"))) {
            fail(id, "moveTimingMarker needs markerId and timeline in seconds.");
            return;
        }
        const int trackIndex = session.indexOf(trackId);
        if (trackIndex < 0) {
            fail(id, "No track exists with that id.");
            return;
        }
        Clip* clip = nullptr;
        for (auto& item : session.tracks[static_cast<size_t>(trackIndex)].clips)
            if (item.id == clipId)
                clip = &item;
        if (clip == nullptr) {
            fail(id, "That clip is not on the track.");
            return;
        }
        const int64_t sourceSample = clip->sourceOffset + (secondsToSamples("timeline") - clip->timelineStart);
        RetiredAudio retiredBuffers;
        const auto error = session.moveTimingMarker(trackId, clipId, obj->getProperty("markerId").toString().toStdString(),
                                                    sourceSample, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "applyTimingAlign") {
        if (!obj->getProperty("markerId").isString() || !isNumber(obj->getProperty("timeline"))) {
            fail(id, "applyTimingAlign needs markerId and timeline in seconds.");
            return;
        }
        const int trackIndex = session.indexOf(trackId);
        if (trackIndex < 0) {
            fail(id, "No track exists with that id.");
            return;
        }
        Clip* clip = nullptr;
        for (auto& item : session.tracks[static_cast<size_t>(trackIndex)].clips)
            if (item.id == clipId)
                clip = &item;
        if (clip == nullptr) {
            fail(id, "That clip is not on the track.");
            return;
        }
        const int64_t sourceSample = clip->sourceOffset + (secondsToSamples("timeline") - clip->timelineStart);
        RetiredAudio retiredBuffers;
        const auto error = session.applyTimingMarkerMove(trackId, clipId, obj->getProperty("markerId").toString().toStdString(),
                                                         sourceSample, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "revertTimingAlign") {
        RetiredAudio retiredBuffers;
        const auto error = session.revertTimingSource(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "analyzeBreath" || op == "addBreathRegion" || op == "removeBreathRegion" || op == "setBreathRegion"
        || op == "ignoreBreathRegion" || op == "previewBreath" || op == "cancelBreathPreview"
        || op == "applyBreath" || op == "revertBreath") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("clipId").isString()) {
            fail(id, "Breath/silence edits need trackId and clipId.");
            return;
        }
    }
    if (op == "analyzeBreath") {
        RetiredAudio retiredBuffers;
        const auto error = session.analyzeClipBreath(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "addBreathRegion") {
        if (!isNumber(obj->getProperty("timelineStart")) || !isNumber(obj->getProperty("timelineEnd"))) {
            fail(id, "addBreathRegion needs timelineStart and timelineEnd in seconds.");
            return;
        }
        const int trackIndex = session.indexOf(trackId);
        if (trackIndex < 0) {
            fail(id, "No track exists with that id.");
            return;
        }
        Clip* clip = nullptr;
        for (auto& item : session.tracks[static_cast<size_t>(trackIndex)].clips)
            if (item.id == clipId)
                clip = &item;
        if (clip == nullptr) {
            fail(id, "That clip is not on the track.");
            return;
        }
        msp::BreathRegion region;
        region.sourceStart = clip->sourceOffset + (secondsToSamples("timelineStart") - clip->timelineStart);
        region.sourceEnd = clip->sourceOffset + (secondsToSamples("timelineEnd") - clip->timelineStart);
        region.kind = msp::BreathKind::manual;
        region.manual = true;
        region.confidence = 1.0f;
        region.gainDb = obj->hasProperty("gainDb") && isNumber(obj->getProperty("gainDb"))
            ? static_cast<float>(static_cast<double>(obj->getProperty("gainDb")))
            : msp::kDefaultBreathGainDb;
        if (obj->hasProperty("fadeIn") && isNumber(obj->getProperty("fadeIn")))
            region.fadeIn = secondsToSamples("fadeIn");
        if (obj->hasProperty("fadeOut") && isNumber(obj->getProperty("fadeOut")))
            region.fadeOut = secondsToSamples("fadeOut");
        std::string regionId;
        RetiredAudio retiredBuffers;
        const auto error = session.addBreathRegion(trackId, clipId, region, &regionId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "removeBreathRegion") {
        if (!obj->getProperty("regionId").isString()) {
            fail(id, "removeBreathRegion needs regionId.");
            return;
        }
        RetiredAudio retiredBuffers;
        const auto error = session.removeBreathRegion(trackId, clipId, obj->getProperty("regionId").toString().toStdString(), retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "setBreathRegion") {
        if (!obj->getProperty("regionId").isString()) {
            fail(id, "setBreathRegion needs regionId.");
            return;
        }
        const int trackIndex = session.indexOf(trackId);
        if (trackIndex < 0) {
            fail(id, "No track exists with that id.");
            return;
        }
        Clip* clip = nullptr;
        for (auto& item : session.tracks[static_cast<size_t>(trackIndex)].clips)
            if (item.id == clipId)
                clip = &item;
        if (clip == nullptr) {
            fail(id, "That clip is not on the track.");
            return;
        }
        msp::BreathRegion* found = nullptr;
        const auto regionId = obj->getProperty("regionId").toString().toStdString();
        for (auto& item : clip->breathRegions)
            if (item.id == regionId)
                found = &item;
        if (found == nullptr) {
            fail(id, "No breath region exists with that id.");
            return;
        }
        msp::BreathRegion next = *found;
        if (isNumber(obj->getProperty("timelineStart")))
            next.sourceStart = clip->sourceOffset + (secondsToSamples("timelineStart") - clip->timelineStart);
        if (isNumber(obj->getProperty("timelineEnd")))
            next.sourceEnd = clip->sourceOffset + (secondsToSamples("timelineEnd") - clip->timelineStart);
        if (isNumber(obj->getProperty("gainDb")))
            next.gainDb = static_cast<float>(static_cast<double>(obj->getProperty("gainDb")));
        if (isNumber(obj->getProperty("fadeIn")))
            next.fadeIn = secondsToSamples("fadeIn");
        if (isNumber(obj->getProperty("fadeOut")))
            next.fadeOut = secondsToSamples("fadeOut");
        if (obj->hasProperty("ignored"))
            next.ignored = static_cast<bool>(obj->getProperty("ignored"));
        RetiredAudio retiredBuffers;
        const auto error = session.setBreathRegion(trackId, clipId, next, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "ignoreBreathRegion") {
        if (!obj->getProperty("regionId").isString()) {
            fail(id, "ignoreBreathRegion needs regionId.");
            return;
        }
        const bool ignored = !obj->hasProperty("ignored") || static_cast<bool>(obj->getProperty("ignored"));
        RetiredAudio retiredBuffers;
        const auto error = session.setBreathRegionIgnored(trackId, clipId,
                                                          obj->getProperty("regionId").toString().toStdString(),
                                                          ignored, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "previewBreath") {
        RetiredAudio retiredBuffers;
        const auto error = session.previewBreathEdits(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "cancelBreathPreview") {
        holdRetired(session.endBreathPreview());
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "applyBreath") {
        RetiredAudio retiredBuffers;
        const auto error = session.applyBreathEdits(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "revertBreath") {
        RetiredAudio retiredBuffers;
        const auto error = session.revertBreathEdits(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "previewClipStretch" || op == "cancelClipStretchPreview" || op == "applyClipStretch" || op == "revertClipStretch") {
        if (op != "cancelClipStretchPreview" && (!obj->getProperty("trackId").isString() || !obj->getProperty("clipId").isString())) {
            fail(id, "Clip stretch/speed needs trackId and clipId.");
            return;
        }
    }
    if (op == "previewClipStretch" || op == "applyClipStretch") {
        if (!obj->getProperty("mode").isString() || !isNumber(obj->getProperty("ratio"))) {
            fail(id, op + " needs mode (timeStretch|speed) and a numeric ratio.");
            return;
        }
        bool modeOk = false;
        const auto modeName = obj->getProperty("mode").toString().toStdString();
        const auto parsedMode = msp::clipStretchModeFromName(modeName, &modeOk);
        if (!modeOk) {
            fail(id, "mode must be timeStretch or speed.");
            return;
        }
        const auto mode = parsedMode == msp::ClipStretchMode::speed ? Session::ClipRateMode::speed : Session::ClipRateMode::timeStretch;
        const double ratio = static_cast<double>(obj->getProperty("ratio"));
        RetiredAudio retiredBuffers;
        const auto error = op == "previewClipStretch"
            ? session.previewClipStretch(trackId, clipId, mode, ratio, retiredBuffers)
            : session.applyClipStretch(trackId, clipId, mode, ratio, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "cancelClipStretchPreview") {
        holdRetired(session.endClipStretchPreview());
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "revertClipStretch") {
        RetiredAudio retiredBuffers;
        const auto error = session.revertClipStretch(trackId, clipId, retiredBuffers);
        finishEdit(error, std::move(retiredBuffers));
        return;
    }
    if (op == "previewVocalPreset" || op == "cancelVocalPresetPreview" || op == "applyVocalPreset"
        || op == "bypassVocalPreset" || op == "revertVocalPreset" || op == "saveCustomVocalPreset"
        || op == "renameCustomVocalPreset" || op == "deleteCustomVocalPreset" || op == "restoreFactoryVocalPresets") {
        // Handled below; shared validation where needed.
    }
    if (op == "previewVocalPreset") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("presetId").isString()) {
            fail(id, "previewVocalPreset needs trackId and presetId.");
            return;
        }
        const auto error = session.previewVocalPreset(trackId, obj->getProperty("presetId").toString().toStdString());
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "cancelVocalPresetPreview") {
        session.endVocalPresetPreview();
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "applyVocalPreset") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("presetId").isString()) {
            fail(id, "applyVocalPreset needs trackId and presetId.");
            return;
        }
        const auto error = session.applyVocalPreset(trackId, obj->getProperty("presetId").toString().toStdString());
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "bypassVocalPreset") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "bypassVocalPreset needs trackId.");
            return;
        }
        const bool bypassed = !obj->hasProperty("bypassed") || static_cast<bool>(obj->getProperty("bypassed"));
        const auto error = session.bypassVocalPreset(trackId, bypassed);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "revertVocalPreset") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "revertVocalPreset needs trackId.");
            return;
        }
        const auto error = session.revertVocalPreset(trackId);
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "saveCustomVocalPreset") {
        if (!obj->getProperty("name").isString()) {
            fail(id, "saveCustomVocalPreset needs a name.");
            return;
        }
        const auto name = obj->getProperty("name").toString().toStdString();
        std::string createdId;
        std::string error;
        if (obj->getProperty("trackId").isString() && obj->getProperty("trackId").toString().isNotEmpty())
            error = session.saveCustomVocalPresetFromTrack(obj->getProperty("trackId").toString().toStdString(), name, &createdId);
        else if (obj->getProperty("fromPresetId").isString())
            error = session.saveCustomVocalPreset(name, obj->getProperty("fromPresetId").toString().toStdString(), &createdId);
        else {
            fail(id, "saveCustomVocalPreset needs trackId or fromPresetId.");
            return;
        }
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "renameCustomVocalPreset") {
        if (!obj->getProperty("presetId").isString() || !obj->getProperty("name").isString()) {
            fail(id, "renameCustomVocalPreset needs presetId and name.");
            return;
        }
        const auto error = session.renameCustomVocalPreset(obj->getProperty("presetId").toString().toStdString(),
                                                           obj->getProperty("name").toString().toStdString());
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "deleteCustomVocalPreset") {
        if (!obj->getProperty("presetId").isString()) {
            fail(id, "deleteCustomVocalPreset needs presetId.");
            return;
        }
        const auto error = session.deleteCustomVocalPreset(obj->getProperty("presetId").toString().toStdString());
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "restoreFactoryVocalPresets") {
        session.restoreFactoryVocalPresets();
        succeed(id, stateVar());
        return;
    }
    if (op == "addTrack") {
        const auto name = obj->hasProperty("name") ? obj->getProperty("name").toString().toStdString() : std::string {};
        if (obj->hasProperty("name") && !obj->getProperty("name").isString()) {
            fail(id, "Track name must be a string.");
            return;
        }
        auto created = session.addTrack(name);
        if (!created.error.empty()) {
            fail(id, juce::String::fromUTF8(created.error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "removeTrack") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "removeTrack needs a string trackId.");
            return;
        }
        auto removed = session.removeTrack(obj->getProperty("trackId").toString().toStdString());
        if (!removed.error.empty()) {
            fail(id, juce::String::fromUTF8(removed.error.c_str()));
            return;
        }
        holdRetired(std::move(removed));
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "renameTrack") {
        if (!obj->getProperty("trackId").isString() || !obj->getProperty("name").isString()) {
            fail(id, "renameTrack needs a trackId and a name.");
            return;
        }
        const auto error = session.renameTrack(obj->getProperty("trackId").toString().toStdString(), obj->getProperty("name").toString().toStdString());
        if (!error.empty()) {
            fail(id, juce::String::fromUTF8(error.c_str()));
            return;
        }
        succeed(id, stateVar());
        return;
    }
    if (op == "duplicateTrack") {
        if (!obj->getProperty("trackId").isString()) {
            fail(id, "duplicateTrack needs a string trackId.");
            return;
        }
        auto copied = session.duplicateTrack(obj->getProperty("trackId").toString().toStdString());
        if (!copied.error.empty()) {
            fail(id, juce::String::fromUTF8(copied.error.c_str()));
            return;
        }
        publishMix();
        succeed(id, stateVar());
        return;
    }
    if (op == "undo") {
        RetiredAudio retiredBuffers;
        finishEdit(session.undoEdit(retiredBuffers), std::move(retiredBuffers));
        return;
    }
    if (op == "redo") {
        RetiredAudio retiredBuffers;
        finishEdit(session.redoEdit(retiredBuffers), std::move(retiredBuffers));
        return;
    }
    if (op == "waveform") {
        if (!obj->getProperty("trackId").isString() || !isNumber(obj->getProperty("start")) || !isNumber(obj->getProperty("end"))) {
            fail(id, "waveform needs trackId, start, and end in seconds.");
            return;
        }
        const int index = session.indexOf(trackId);
        if (index < 0) {
            fail(id, "No track is loaded with that id.");
            return;
        }
        const auto& track = session.tracks[static_cast<size_t>(index)];
        const auto sourceId = obj->getProperty("sourceFileId").toString().toStdString();
        const float* left = track.sourcePlayLeft.data();
        const float* right = track.sourcePlayRight.data();
        int64_t length = static_cast<int64_t>(track.sourcePlayLeft.size());
        if (!sourceId.empty() && sourceId != session.primarySourceId(track)) {
            const auto extra = std::find_if(track.extras.begin(), track.extras.end(), [&](const Session::Track::ExtraSource& item) { return item.id == sourceId; });
            if (extra == track.extras.end()) {
                fail(id, "That source is not loaded on the track.");
                return;
            }
            left = extra->playLeft.data();
            right = extra->playRight.data();
            length = static_cast<int64_t>(extra->playLeft.size());
        }
        const int buckets = obj->hasProperty("buckets") ? static_cast<int>(obj->getProperty("buckets")) : 256;
        const auto peaks = buildPeaks(left, right, length, secondsToSamples("start"), secondsToSamples("end"), buckets);
        if (!peaks.error.empty()) {
            fail(id, juce::String::fromUTF8(peaks.error.c_str()));
            return;
        }
        auto* result = new juce::DynamicObject();
        juce::Array<juce::var> minimum;
        juce::Array<juce::var> maximum;
        for (float value : peaks.minimum)
            minimum.add(value);
        for (float value : peaks.maximum)
            maximum.add(value);
        result->setProperty("min", minimum);
        result->setProperty("max", maximum);
        succeed(id, juce::var(result));
        return;
    }

    fail(id, "Unknown command: " + op);
}

void Engine::shutdown(bool respond) {
    if (shuttingDown.exchange(true))
        return;
    stopTimer();
    stopPitchAnalysis();
    if (recorder != nullptr)
        finishRecording();
    devices.removeAudioCallback(this);
    devices.closeAudioDevice();
    deviceOpen.store(false);
    retireLivePitch();
    if (respond)
        succeed({}, juce::var());
    std::cout.flush();
    std::exit(0);
}

void Engine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
    if (device == nullptr)
        return;
    const int rate = static_cast<int>(std::lround(device->getCurrentSampleRate()));
    if (rate > 0)
        sampleRate.store(rate, std::memory_order_relaxed);
    const int block = device->getCurrentBufferSizeSamples();
    if (block > 0)
        bufferSize.store(block, std::memory_order_relaxed);
    outputLatencySamples.store(device->getOutputLatencyInSamples(), std::memory_order_relaxed);
}

void Engine::audioDeviceStopped() {
    inputMeterAvailable.store(false, std::memory_order_relaxed);
}

void Engine::audioDeviceError(const juce::String& errorMessage) {
    // This may run off the message thread. Only store a flag here.
    // The message is copied on the timer, which is the message thread.
    juce::ignoreUnused(errorMessage);
    deviceFault.store(true, std::memory_order_relaxed);
}

void Engine::timerCallback() {
    const bool fault = deviceFault.exchange(false);
    if (fault && faultMessage.isEmpty())
        faultMessage = "The audio device reported an error while it was running.";
    if (recorder != nullptr && (fault || !deviceOpen.load() || modeFromInt(transport.load()) != TransportMode::playing)) {
        // The take ended on its own: the maximum length was reached or the device failed.
        const char* reason = fault || !deviceOpen.load() ? "device" : "length";
        auto take = finishRecording();
        auto* finished = new juce::DynamicObject();
        finished->setProperty("v", 1);
        finished->setProperty("event", "recordFinished");
        finished->setProperty("reason", reason);
        finished->setProperty("take", take);
        finished->setProperty("state", stateVar());
        writeJson(juce::var(finished));
    }
    const int rate = std::max(1, sampleRate.load());
    auto event = meterVar(true);
    auto* obj = event.getDynamicObject();
    obj->setProperty("position", static_cast<double>(std::min(position.load(), displayTimeline())) / static_cast<double>(rate));
    obj->setProperty("duration", static_cast<double>(displayTimeline()) / static_cast<double>(rate));
    obj->setProperty("recording", recorder != nullptr);
    obj->setProperty("transport", modeName(modeFromInt(transport.load())));
    obj->setProperty("monitor", monitor.load());
    obj->setProperty("deviceOpen", deviceOpen.load());
    writeJson(event);
    reclaimSnapshots();
}

void Engine::audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                              int numInputChannels,
                                              float* const* outputChannelData,
                                              int numOutputChannels,
                                              int numSamples,
                                              const juce::AudioIODeviceCallbackContext&) {
    juce::ScopedNoDenormals noDenormals;
    inputChannels.store(numInputChannels, std::memory_order_relaxed);
    if (outputChannelData == nullptr || numOutputChannels <= 0 || numSamples <= 0)
        return;
    for (int ch = 0; ch < numOutputChannels; ++ch) {
        if (outputChannelData[ch] != nullptr)
            std::memset(outputChannelData[ch], 0, sizeof(float) * static_cast<size_t>(numSamples));
    }

    Clock clock;
    clock.mode = modeFromInt(transport.load(std::memory_order_relaxed));
    clock.position = position.load(std::memory_order_relaxed);

    auto* snap = mixHead.load(std::memory_order_acquire);
    if (snap == nullptr || snap->state == nullptr)
        return;
    if (snap != audioCurrent) {
        // While stopped, the new snapshot's clean processors are used as they are.
        if (audioCurrent != nullptr)
            inheritMixState(audioCurrent->plan, *audioCurrent->state, snap->plan, *snap->state,
                            clock.mode != TransportMode::stopped);
        audioCurrent = snap;
        audioSeq.store(snap->seq, std::memory_order_release);
    }
    const MixPlan& plan = snap->plan;
    MixState& mixState = *snap->state;
    const bool playingNow = clock.mode == TransportMode::playing;

    // Recording: the timeline is extended so the transport keeps running past the last clip.
    // Once a stop is requested the recorder is acknowledged and never touched again.
    auto* rec = recordLive.load(std::memory_order_acquire);
    const bool recording = rec != nullptr;
    if (rec != nullptr && recordStopRequest.load(std::memory_order_acquire)) {
        recordStopAck.store(true, std::memory_order_release);
        rec = nullptr;
    }
    const int64_t timeline = recording ? std::max(snap->timeline, recordEnd.load(std::memory_order_relaxed)) : snap->timeline;

    // Record inputs: input channels 1 and 2, or the deterministic test signal while playing.
    const bool fits = numSamples <= kMaxInputBlock;
    const float* in1 = numInputChannels > 0 && inputChannelData != nullptr ? inputChannelData[0] : nullptr;
    const float* in2 = numInputChannels > 1 && inputChannelData != nullptr ? inputChannelData[1] : nullptr;
    if (virtualOn.load(std::memory_order_relaxed)) {
        in1 = nullptr;
        in2 = nullptr;
        if (fits) {
            VirtualInput source;
            source.enabled = true;
            source.frequency = virtualFrequency.load(std::memory_order_relaxed);
            source.level = virtualLevel.load(std::memory_order_relaxed);
            for (int i = 0; i < numSamples; ++i) {
                virtualL[static_cast<size_t>(i)] = playingNow ? virtualInputSample(source, plan.sampleRate, clock.position + i, 0) : 0.0f;
                virtualR[static_cast<size_t>(i)] = playingNow ? virtualInputSample(source, plan.sampleRate, clock.position + i, 1) : 0.0f;
            }
            in1 = virtualL.data();
            in2 = virtualR.data();
        }
    }
    // Software input gain (Phase 2.7.2): smoothed linear gain after capture, before Live DSP /
    // recording / input meters. Mic monitor below stays on raw device buffers (pre-gain).
    // No heap allocation; writes into preallocated inputGainL/R only.
    const bool haveInput = fits && (in1 != nullptr || in2 != nullptr);
    inputMeterAvailable.store(haveInput, std::memory_order_relaxed);
    if (haveInput) {
        const float target = inputGainTarget.load(std::memory_order_relaxed);
        const float sr = static_cast<float>(std::max(1, sampleRate.load(std::memory_order_relaxed)));
        const float alpha = 1.0f - std::exp(-1.0f / (0.010f * sr)); // ~10 ms smoothing
        float g = inputGainCurrent;
        float peakLLocal = 0.0f;
        float peakRLocal = 0.0f;
        float sumSqLLocal = 0.0f;
        float sumSqRLocal = 0.0f;
        for (int i = 0; i < numSamples; ++i) {
            g += alpha * (target - g);
            const float sampleL = in1 != nullptr ? in1[static_cast<size_t>(i)] * g : 0.0f;
            const float sampleR = in2 != nullptr ? in2[static_cast<size_t>(i)] * g : 0.0f;
            inputGainL[static_cast<size_t>(i)] = sampleL;
            inputGainR[static_cast<size_t>(i)] = sampleR;
            const float absL = std::fabs(sampleL);
            const float absR = std::fabs(sampleR);
            if (absL > peakLLocal)
                peakLLocal = absL;
            if (absR > peakRLocal)
                peakRLocal = absR;
            sumSqLLocal += sampleL * sampleL;
            sumSqRLocal += sampleR * sampleR;
        }
        inputGainCurrent = g;
        if (in1 != nullptr)
            in1 = inputGainL.data();
        if (in2 != nullptr)
            in2 = inputGainR.data();
        raisePeak(inputPeakL, peakLLocal);
        raisePeak(inputPeakR, peakRLocal);
        addAtomicFloat(inputSumSqL, sumSqLLocal);
        addAtomicFloat(inputSumSqR, sumSqRLocal);
        inputMeterSamples.fetch_add(numSamples, std::memory_order_relaxed);
    }
    // Live pitch detection copies the live input into its queue; the input is not changed.
    livePitchUsers.fetch_add(1);
    if (auto* detector = livePitchLive.load())
        detector->write(in1, in2, numSamples);
    livePitchUsers.fetch_sub(1);
    const float* monitor1 = nullptr;
    const float* monitor2 = nullptr;
    // Live input DSP stage. Off by default: then the input pointers are left exactly as they are.
    liveDspUsers.fetch_add(1);
    if (auto* live = liveDspLive.load()) {
        if (fits) {
            const float* source[2] = { in1 != nullptr ? in1 : silentInput.data(), in2 != nullptr ? in2 : silentInput.data() };
            float* processed[2] = { liveL.data(), liveR.data() };
            live->process(source, processed, numSamples);
            // RAW track monitoring: delay the pre-stage input by the same DSP latency, then
            // crossfade with the corrected feed when the mode changes. Recording always uses
            // the post-stage pointers below.
            if (liveCorrection != nullptr && monitorRawDelay.capacity() > 0) {
                const float* delayIn[2] = { source[0], source[1] };
                float* delayOut[2] = { monitorRawL.data(), monitorRawR.data() };
                monitorRawDelay.write(delayIn, numSamples);
                monitorRawDelay.read(delayOut, numSamples);
                const float target = liveMonitorMode.load(std::memory_order_acquire) == 0 ? 1.0f : 0.0f;
                const float step = 1.0f / static_cast<float>(std::max(1, monitorFadeSamples));
                for (int i = 0; i < numSamples; ++i) {
                    if (monitorMix < target)
                        monitorMix = std::min(target, monitorMix + step);
                    else if (monitorMix > target)
                        monitorMix = std::max(target, monitorMix - step);
                    const float wet = monitorMix;
                    const float dry = 1.0f - wet;
                    monitorMixL[static_cast<size_t>(i)] = wet * liveL[static_cast<size_t>(i)] + dry * monitorRawL[static_cast<size_t>(i)];
                    monitorMixR[static_cast<size_t>(i)] = wet * liveR[static_cast<size_t>(i)] + dry * monitorRawR[static_cast<size_t>(i)];
                }
                monitor1 = monitorMixL.data();
                monitor2 = monitorMixR.data();
            }
            if (in1 != nullptr)
                in1 = liveL.data();
            if (in2 != nullptr)
                in2 = liveR.data();
        } else {
            liveDspSkipped.fetch_add(1, std::memory_order_relaxed);
        }
    }
    liveDspUsers.fetch_sub(1);
    const int processedCount = fits ? std::min(static_cast<int>(plan.inputs.size()), kMaxRecordTracks) : 0;
    const bool micOn = monitor.load(std::memory_order_relaxed);
    const float* micL = (micOn && numInputChannels > 0 && inputChannelData != nullptr) ? inputChannelData[0] : nullptr;
    const float* micR = (micOn && numInputChannels > 1 && inputChannelData != nullptr) ? inputChannelData[1] : nullptr;
    const float master = masterGain.load(std::memory_order_relaxed);

    auto commit = [&](const MixResult& mixed, int64_t expectedPosition) {
        raisePeak(peakL, mixed.peakL);
        raisePeak(peakR, mixed.peakR);
        addAtomicFloat(masterSumSqL, mixed.sumSqL);
        addAtomicFloat(masterSumSqR, mixed.sumSqR);
        masterMeterSamples.fetch_add(mixed.meterSamples, std::memory_order_relaxed);
        if (clock.mode == TransportMode::playing) {
            if (position.compare_exchange_strong(expectedPosition, mixed.clock.position, std::memory_order_relaxed))
                transport.store(static_cast<int>(mixed.clock.mode), std::memory_order_relaxed);
        }
    };

    if (numOutputChannels >= 2 && outputChannelData[0] != nullptr && outputChannelData[1] != nullptr) {
        MixInputIO io;
        io.input1 = in1;
        io.input2 = in2;
        io.monitor1 = monitor1;
        io.monitor2 = monitor2;
        io.processedL = processedPtrL.data();
        io.processedR = processedPtrR.data();
        io.processedCount = processedCount;
        SpectrumTapRequest spectrumTap;
        spectrumTap.kind = static_cast<SpectrumTapKind>(spectrumKind.load(std::memory_order_relaxed));
        spectrumTap.index = spectrumIndex.load(std::memory_order_relaxed);
        spectrumTap.capture = (spectrumTap.kind != SpectrumTapKind::none && spectrumTap.index >= 0)
            || spectrumTap.kind == SpectrumTapKind::master ? &spectrumCapture : nullptr;
        if (spectrumTap.kind == SpectrumTapKind::master)
            spectrumTap.capture = &spectrumCapture;
        if (spectrumTap.kind != SpectrumTapKind::none && spectrumTap.kind != SpectrumTapKind::master && spectrumTap.index < 0)
            spectrumTap.capture = nullptr;
        const auto mixed = mixRoute(plan, mixState, master, clock, timeline,
                                    outputChannelData[0], outputChannelData[1], numSamples,
                                    micL, micR, micOn && micL != nullptr, &io, &spectrumTap);
        commit(mixed, clock.position);
        if (rec != nullptr && playingNow && mixed.played > 0) {
            if (fits)
                captureRecording(*rec, plan, processedCount, in1, in2, processedPtrL.data(), processedPtrR.data(), clock.position, mixed.played);
            else
                recordSkipped.fetch_add(mixed.played, std::memory_order_relaxed);
        }
        if (captureOn.load(std::memory_order_acquire) && clock.mode == TransportMode::playing && mixed.played > 0) {
            captureWriters.fetch_add(1);
            if (captureOn.load()) {
                const int64_t capacity = static_cast<int64_t>(captureL.size());
                const int64_t from = std::clamp<int64_t>(clock.position, 0, capacity);
                const int64_t to = std::clamp<int64_t>(clock.position + mixed.played, 0, capacity);
                if (to > from) {
                    const auto skip = static_cast<size_t>(from - clock.position);
                    std::memcpy(captureL.data() + from, outputChannelData[0] + skip, sizeof(float) * static_cast<size_t>(to - from));
                    std::memcpy(captureR.data() + from, outputChannelData[1] + skip, sizeof(float) * static_cast<size_t>(to - from));
                    captureEnd.store(std::max(captureEnd.load(std::memory_order_relaxed), to), std::memory_order_release);
                    captureWritten.fetch_add(to - from, std::memory_order_acq_rel);
                }
            }
            captureWriters.fetch_sub(1);
        }
        return;
    }

    if (outputChannelData[0] == nullptr)
        return;
    const int scratch = static_cast<int>(scratchL.size());
    int done = 0;
    Clock cursor = clock;
    while (done < numSamples) {
        const int n = std::min(numSamples - done, scratch);
        float* pieceL[kMaxRecordTracks];
        float* pieceR[kMaxRecordTracks];
        for (int k = 0; k < processedCount; ++k) {
            pieceL[k] = processedPtrL[static_cast<size_t>(k)] + done;
            pieceR[k] = processedPtrR[static_cast<size_t>(k)] + done;
        }
        MixInputIO io;
        io.input1 = in1 != nullptr ? in1 + done : nullptr;
        io.input2 = in2 != nullptr ? in2 + done : nullptr;
        io.monitor1 = monitor1 != nullptr ? monitor1 + done : nullptr;
        io.monitor2 = monitor2 != nullptr ? monitor2 + done : nullptr;
        io.processedL = pieceL;
        io.processedR = pieceR;
        io.processedCount = processedCount;
        SpectrumTapRequest spectrumTap;
        spectrumTap.kind = static_cast<SpectrumTapKind>(spectrumKind.load(std::memory_order_relaxed));
        spectrumTap.index = spectrumIndex.load(std::memory_order_relaxed);
        spectrumTap.capture = nullptr;
        if (spectrumTap.kind == SpectrumTapKind::master)
            spectrumTap.capture = &spectrumCapture;
        else if (spectrumTap.kind != SpectrumTapKind::none && spectrumTap.index >= 0)
            spectrumTap.capture = &spectrumCapture;
        const auto mixed = mixRoute(plan, mixState, master, cursor, timeline,
                                    scratchL.data(), scratchR.data(), n,
                                    micL != nullptr ? micL + done : nullptr,
                                    micR != nullptr ? micR + done : nullptr,
                                    micOn && micL != nullptr, &io, &spectrumTap);
        if (rec != nullptr && cursor.mode == TransportMode::playing && mixed.played > 0) {
            if (fits)
                captureRecording(*rec, plan, processedCount, io.input1, io.input2, pieceL, pieceR, cursor.position, mixed.played);
            else
                recordSkipped.fetch_add(mixed.played, std::memory_order_relaxed);
        }
        for (int i = 0; i < n; ++i)
            outputChannelData[0][done + i] = 0.5f * (scratchL[static_cast<size_t>(i)] + scratchR[static_cast<size_t>(i)]);
        cursor = mixed.clock;
        raisePeak(peakL, mixed.peakL);
        raisePeak(peakR, mixed.peakR);
        addAtomicFloat(masterSumSqL, mixed.sumSqL);
        addAtomicFloat(masterSumSqR, mixed.sumSqR);
        masterMeterSamples.fetch_add(mixed.meterSamples, std::memory_order_relaxed);
        done += n;
        if (cursor.mode != TransportMode::playing)
            break;
    }
    if (clock.mode == TransportMode::playing) {
        int64_t expected = clock.position;
        if (position.compare_exchange_strong(expected, cursor.position, std::memory_order_relaxed))
            transport.store(static_cast<int>(cursor.mode), std::memory_order_relaxed);
    }
}

} // namespace msp
