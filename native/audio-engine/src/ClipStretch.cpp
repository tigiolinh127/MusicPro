#include "msp/ClipStretch.h"
#include "msp/WavIO.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace msp {
namespace {

std::string number(double value, int digits) {
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.*f", digits, value);
    return buffer;
}

bool cancelled(const std::atomic<bool>* cancel) {
    return cancel != nullptr && cancel->load(std::memory_order_relaxed);
}

TimeStretchResult copyIdentity(const float* left, const float* right, int64_t frames, int channels, double ratioOrSpeed) {
    TimeStretchResult out;
    out.identity = true;
    out.ratio = ratioOrSpeed;
    out.inputFrames = frames;
    out.outputFrames = frames;
    out.left.assign(left, left + frames);
    if (channels == 2 && right != nullptr)
        out.right.assign(right, right + frames);
    for (int64_t i = 0; i < frames; ++i) {
        out.inputPeak = std::max(out.inputPeak, static_cast<double>(std::abs(left[i])));
        if (channels == 2 && right != nullptr)
            out.inputPeak = std::max(out.inputPeak, static_cast<double>(std::abs(right[i])));
    }
    out.outputPeak = out.inputPeak;
    return out;
}

} // namespace

std::string clipStretchModeName(ClipStretchMode mode) {
    return mode == ClipStretchMode::speed ? "speed" : "timeStretch";
}

ClipStretchMode clipStretchModeFromName(const std::string& name, bool* ok) {
    if (name == "speed") {
        if (ok != nullptr) *ok = true;
        return ClipStretchMode::speed;
    }
    if (name == "timeStretch" || name == "stretch" || name.empty()) {
        if (ok != nullptr) *ok = true;
        return ClipStretchMode::timeStretch;
    }
    if (ok != nullptr) *ok = false;
    return ClipStretchMode::timeStretch;
}

std::string checkClipDurationRatio(double ratio) {
    if (!std::isfinite(ratio) || ratio < kClipDurationRatioMin || ratio > kClipDurationRatioMax)
        return "Duration ratio must be between " + number(kClipDurationRatioMin, 2) + "x and "
            + number(kClipDurationRatioMax, 2) + "x (output duration / original duration).";
    return {};
}

std::string checkClipSpeed(double speed) {
    if (!std::isfinite(speed) || speed < kClipSpeedMin || speed > kClipSpeedMax)
        return "Speed must be between " + number(kClipSpeedMin, 2) + "x and " + number(kClipSpeedMax, 2)
            + "x (2.0x = twice as fast, half duration).";
    return {};
}

int64_t expectedFramesForDurationRatio(int64_t inputFrames, double durationRatio) {
    if (inputFrames <= 0 || !(durationRatio > 0.0) || !std::isfinite(durationRatio))
        return 0;
    return std::max<int64_t>(1, static_cast<int64_t>(std::llround(static_cast<double>(inputFrames) * durationRatio)));
}

int64_t expectedFramesForSpeed(int64_t inputFrames, double speed) {
    if (inputFrames <= 0 || !(speed > 0.0) || !std::isfinite(speed))
        return 0;
    return std::max<int64_t>(1, static_cast<int64_t>(std::llround(static_cast<double>(inputFrames) / speed)));
}

TimeStretchResult timeStretchClip(const float* left, const float* right, int64_t frames, int channels,
                                  double sampleRate, double durationRatio,
                                  const std::atomic<bool>* cancel,
                                  const std::function<void(double)>& progress) {
    TimeStretchResult out;
    out.error = checkClipDurationRatio(durationRatio);
    if (!out.error.empty())
        return out;
    if (left == nullptr || frames <= 0 || (channels == 2 && right == nullptr)) {
        out.error = "No audio was given to time stretch.";
        return out;
    }
    if (channels != 1 && channels != 2) {
        out.error = "Time stretching supports mono and stereo audio.";
        return out;
    }
    if (std::fabs(durationRatio - 1.0) < 1.0e-9)
        return copyIdentity(left, right, frames, channels, durationRatio);

    // Chain validated single-pass stretches. Never call timeStretch outside 0.75–1.25.
    std::vector<float> curL(left, left + frames);
    std::vector<float> curR;
    if (channels == 2)
        curR.assign(right, right + frames);
    double remaining = durationRatio;
    int passes = 0;
    const int maxPasses = 8;
    while (passes < maxPasses) {
        if (cancelled(cancel)) {
            out.cancelled = true;
            out.error = "Time stretch was cancelled.";
            return out;
        }
        double step = remaining;
        if (step > kTimeStretchMaxRatio)
            step = kTimeStretchMaxRatio;
        else if (step < kTimeStretchMinRatio)
            step = kTimeStretchMinRatio;
        if (std::fabs(step - 1.0) < 1.0e-9)
            break;

        auto pass = timeStretch(curL.data(), channels == 2 ? curR.data() : nullptr,
                                static_cast<int64_t>(curL.size()), channels, sampleRate, step,
                                0, 0, cancel, progress);
        if (!pass.error.empty() || pass.cancelled) {
            out = std::move(pass);
            return out;
        }
        curL = std::move(pass.left);
        if (channels == 2)
            curR = std::move(pass.right);
        out.repairedSamples += pass.repairedSamples;
        out.inputPeak = std::max(out.inputPeak, pass.inputPeak);
        out.outputPeak = pass.outputPeak;
        out.gainReductionDb = pass.gainReductionDb;
        remaining /= step;
        ++passes;
        if (std::fabs(remaining - 1.0) < 1.0e-6)
            break;
        // After a max/min step, remaining may still be slightly outside [0.75,1.25] for the
        // final pass — clamp into the validated window for one last pass.
        if (passes >= maxPasses - 1) {
            remaining = std::clamp(remaining, kTimeStretchMinRatio, kTimeStretchMaxRatio);
        }
    }

    out.ratio = durationRatio;
    out.inputFrames = frames;
    out.outputFrames = static_cast<int64_t>(curL.size());
    out.left = std::move(curL);
    if (channels == 2)
        out.right = std::move(curR);
    // Nudge length to the analytically expected count when within a few samples (vocoder hop).
    const int64_t expected = expectedFramesForDurationRatio(frames, durationRatio);
    if (expected > 0 && std::llabs(out.outputFrames - expected) <= 8) {
        out.left.resize(static_cast<size_t>(expected), 0.0f);
        if (channels == 2)
            out.right.resize(static_cast<size_t>(expected), 0.0f);
        out.outputFrames = expected;
    }
    return out;
}

TimeStretchResult speedChangeClip(const float* left, const float* right, int64_t frames, int channels,
                                  double sampleRate, double speed,
                                  const std::atomic<bool>* cancel) {
    TimeStretchResult out;
    out.error = checkClipSpeed(speed);
    if (!out.error.empty())
        return out;
    if (left == nullptr || frames <= 0 || (channels == 2 && right == nullptr)) {
        out.error = "No audio was given for speed change.";
        return out;
    }
    if (channels != 1 && channels != 2) {
        out.error = "Speed change supports mono and stereo audio.";
        return out;
    }
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0) {
        out.error = "Speed change supports sample rates from 8 kHz to 192 kHz.";
        return out;
    }
    out.ratio = speed;
    out.inputFrames = frames;
    if (std::fabs(speed - 1.0) < 1.0e-9)
        return copyIdentity(left, right, frames, channels, speed);
    if (cancelled(cancel)) {
        out.cancelled = true;
        out.error = "Speed change was cancelled.";
        return out;
    }

    // destRate = sampleRate / speed → output frames ≈ frames * (sampleRate/destRate) wait:
    // resampleStereo maps sourceRate→destRate length ≈ frames * destRate/sourceRate.
    // We want output_duration = input_duration / speed, so output_frames = frames / speed
    // at the same sample rate → resample as if destRate = sampleRate / speed.
    const double destRate = sampleRate / speed;
    auto pcm = resampleStereo(left, channels == 2 ? right : left, frames, sampleRate, destRate);
    if (!pcm.error.empty()) {
        out.error = pcm.error;
        return out;
    }
    if (pcm.left.empty()) {
        out.error = "Speed change produced no audio.";
        return out;
    }
    out.left = std::move(pcm.left);
    if (channels == 2)
        out.right = std::move(pcm.right);
    else
        out.right.clear();
    out.outputFrames = static_cast<int64_t>(out.left.size());
    const int64_t expected = expectedFramesForSpeed(frames, speed);
    if (expected > 0 && std::llabs(out.outputFrames - expected) <= 8) {
        out.left.resize(static_cast<size_t>(expected), 0.0f);
        if (channels == 2)
            out.right.resize(static_cast<size_t>(expected), 0.0f);
        out.outputFrames = expected;
    }
    for (size_t i = 0; i < out.left.size(); ++i) {
        out.outputPeak = std::max(out.outputPeak, static_cast<double>(std::abs(out.left[i])));
        if (channels == 2 && i < out.right.size())
            out.outputPeak = std::max(out.outputPeak, static_cast<double>(std::abs(out.right[i])));
    }
    for (int64_t i = 0; i < frames; ++i) {
        out.inputPeak = std::max(out.inputPeak, static_cast<double>(std::abs(left[i])));
        if (channels == 2)
            out.inputPeak = std::max(out.inputPeak, static_cast<double>(std::abs(right[i])));
    }
    return out;
}

} // namespace msp
