#include "msp/Mixer.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;

void clear(float* data, int n) {
    if (data != nullptr && n > 0)
        std::memset(data, 0, sizeof(float) * static_cast<size_t>(n));
}

void raise(std::atomic<float>& slot, float value) {
    float current = slot.load(std::memory_order_relaxed);
    while (value > current && !slot.compare_exchange_weak(current, value, std::memory_order_relaxed)) {
    }
}

void addAtomic(std::atomic<float>& slot, float value) {
    float current = slot.load(std::memory_order_relaxed);
    while (!slot.compare_exchange_weak(current, current + value, std::memory_order_relaxed)) {
    }
}

// Moves a gain toward its target by at most `step` per sample, for `samples` samples.
void advance(float& gain, float target, float step, int samples) {
    if (samples <= 0 || gain == target)
        return;
    const float reach = step * static_cast<float>(samples);
    const float delta = target - gain;
    gain = delta > reach ? gain + reach : (delta < -reach ? gain - reach : target);
}

void stepToward(float& gain, float target, float step) {
    const float delta = target - gain;
    gain = delta > step ? gain + step : (delta < -step ? gain - step : target);
}

// Adds src * ramped gain into dst for samples [0, n). Returns the contribution peaks and sum-of-squares.
void addRamped(const float* srcL, const float* srcR, float* dstL, float* dstR, int n,
               float& gainL, float& gainR, float targetL, float targetR, float step,
               float& peakL, float& peakR, float* sumSqL = nullptr, float* sumSqR = nullptr) {
    int i = 0;
    while (i < n && (gainL != targetL || gainR != targetR)) {
        stepToward(gainL, targetL, step);
        stepToward(gainR, targetR, step);
        const float l = srcL[i] * gainL;
        const float r = srcR[i] * gainR;
        dstL[i] += l;
        dstR[i] += r;
        peakL = std::max(peakL, std::fabs(l));
        peakR = std::max(peakR, std::fabs(r));
        if (sumSqL != nullptr)
            *sumSqL += l * l;
        if (sumSqR != nullptr)
            *sumSqR += r * r;
        ++i;
    }
    if (i >= n)
        return;
    if (gainL == 0.0f && gainR == 0.0f)
        return;
    for (; i < n; ++i) {
        const float l = srcL[i] * gainL;
        const float r = srcR[i] * gainR;
        dstL[i] += l;
        dstR[i] += r;
        peakL = std::max(peakL, std::fabs(l));
        peakR = std::max(peakR, std::fabs(r));
        if (sumSqL != nullptr)
            *sumSqL += l * l;
        if (sumSqR != nullptr)
            *sumSqR += r * r;
    }
}

bool stateMatches(const MixPlan& plan, const MixState& state) {
    return state.sourceCount == static_cast<int>(plan.sources.size())
        && state.busCount == static_cast<int>(plan.buses.size())
        && state.feedL.size() >= plan.feeds.size()
        && state.feedR.size() >= plan.feeds.size()
        && state.busL.size() >= plan.buses.size() * static_cast<size_t>(kMixChunk)
        && state.busR.size() >= plan.buses.size() * static_cast<size_t>(kMixChunk)
        && state.effectCount == static_cast<int>(plan.effects.size())
        && state.effects.size() == plan.effects.size()
        && state.effectWarm.size() == plan.effects.size()
        && state.effectParams.size() == plan.effects.size()
        && state.laneValue.size() >= plan.lanes.size() * static_cast<size_t>(kMixChunk)
        && state.lanePanL.size() >= plan.lanes.size() * static_cast<size_t>(kMixChunk)
        && state.lanePanR.size() >= plan.lanes.size() * static_cast<size_t>(kMixChunk)
        && state.inputL.size() >= plan.inputs.size() * static_cast<size_t>(kMixChunk)
        && state.inputR.size() >= plan.inputs.size() * static_cast<size_t>(kMixChunk)
        && state.insertL.size() >= static_cast<size_t>(kMixChunk);
}

bool feedAutomated(const MixFeed& feed) {
    return feed.gainLane >= 0 || feed.panLane >= 0;
}

// Lane values for positions [start, start + n), sample by sample, with the same arithmetic as laneValueAt.
void fillLane(const MixPlan& plan, const MixLane& lane, int64_t start, int n, float* out) {
    if (lane.pointCount <= 0) {
        for (int i = 0; i < n; ++i)
            out[i] = lane.minimum;
        return;
    }
    const auto* points = plan.points.data() + lane.firstPoint;
    const int count = lane.pointCount;
    int segment = automationSegment(points, count, start);
    for (int i = 0; i < n; ++i) {
        const int64_t at = start + i;
        while (segment + 1 < count && points[segment + 1].time <= at)
            ++segment;
        out[i] = std::clamp(static_cast<float>(automationSegmentValue(points, count, segment, at)), lane.minimum, lane.maximum);
    }
}

// The target of an automated feed at one position.
void automatedTarget(const MixPlan& plan, const MixFeed& feed, int64_t position, float& left, float& right) {
    const float gain = feed.gainLane >= 0 ? laneValueAt(plan, plan.lanes[static_cast<size_t>(feed.gainLane)], position) : feed.gain;
    float panL = 1.0f;
    float panR = 1.0f;
    if (feed.panned)
        panLaw(feed.panLane >= 0 ? laneValueAt(plan, plan.lanes[static_cast<size_t>(feed.panLane)], position) : feed.pan, panL, panR);
    left = feed.scale * gain * panL;
    right = feed.scale * gain * panR;
}

// Like addRamped, for a feed whose target follows automation. Chunk sample i reads
// src[base + i] when first <= i < last; the gain keeps moving over all n samples.
void addAutomated(const MixState& state, const MixFeed& feed, const float* srcL, const float* srcR, int64_t base,
                  int first, int last, int n, float* dstL, float* dstR,
                  float& gainL, float& gainR, float step, float& peakL, float& peakR,
                  float* sumSqL = nullptr, float* sumSqR = nullptr) {
    const float* gains = feed.gainLane >= 0 ? state.laneValue.data() + static_cast<size_t>(feed.gainLane) * kMixChunk : nullptr;
    const float* pansL = feed.panLane >= 0 ? state.lanePanL.data() + static_cast<size_t>(feed.panLane) * kMixChunk : nullptr;
    const float* pansR = feed.panLane >= 0 ? state.lanePanR.data() + static_cast<size_t>(feed.panLane) * kMixChunk : nullptr;
    float fixedL = 1.0f;
    float fixedR = 1.0f;
    if (feed.panned && pansL == nullptr)
        panLaw(feed.pan, fixedL, fixedR);
    for (int i = 0; i < n; ++i) {
        const float gain = gains != nullptr ? gains[i] : feed.gain;
        float panL = 1.0f;
        float panR = 1.0f;
        if (feed.panned) {
            panL = pansL != nullptr ? pansL[i] : fixedL;
            panR = pansR != nullptr ? pansR[i] : fixedR;
        }
        stepToward(gainL, feed.scale * gain * panL, step);
        stepToward(gainR, feed.scale * gain * panR, step);
        if (i < first || i >= last)
            continue;
        const float l = srcL[base + i] * gainL;
        const float r = srcR[base + i] * gainR;
        dstL[i] += l;
        dstR[i] += r;
        peakL = std::max(peakL, std::fabs(l));
        peakR = std::max(peakR, std::fabs(r));
        if (sumSqL != nullptr)
            *sumSqL += l * l;
        if (sumSqR != nullptr)
            *sumSqR += r * r;
    }
}

// Runs one effect in place over n samples. It crossfades between its dry input and its
// processed output when it is enabled or bypassed, so neither change clicks.
// History is never cleared here: an effect that needs a clean start gets a clean processor
// prepared on the control thread (see inheritMixState).
float runEffect(const MixPlan& plan, MixState& state, size_t e, const EffectParams& params, float* left, float* right, int n, float step) {
    const auto& effect = plan.effects[e];
    auto* dsp = state.effects[e].get();
    float& mix = state.effectMix[e];
    float& warm = state.effectWarm[e];
    const float target = effect.enabled ? 1.0f : 0.0f;
    if (dsp == nullptr || (mix == 0.0f && target == 0.0f))
        return 0.0f;
    if (mix == 1.0f && target == 1.0f && warm == 1.0f)
        return dsp->process(params, left, right, n);
    std::memcpy(state.dryL.data(), left, sizeof(float) * static_cast<size_t>(n));
    std::memcpy(state.dryR.data(), right, sizeof(float) * static_cast<size_t>(n));
    if (warm != 1.0f) {
        for (int i = 0; i < n; ++i) {
            stepToward(warm, 1.0f, step);
            left[i] *= warm;
            right[i] *= warm;
        }
    }
    float reduction = dsp->process(params, left, right, n);
    for (int i = 0; i < n; ++i) {
        stepToward(mix, target, step);
        left[i] = state.dryL[static_cast<size_t>(i)] + mix * (left[i] - state.dryL[static_cast<size_t>(i)]);
        right[i] = state.dryR[static_cast<size_t>(i)] + mix * (right[i] - state.dryR[static_cast<size_t>(i)]);
    }
    return reduction * mix;
}

// Runs one insert chain in place over the n samples that start at timeline position `start`.
// An effect with automated parameters runs in pieces that end on multiples of
// kAutomationBlock; each piece uses the lane values at the start of its kAutomationBlock, so a
// block split by the buffer size still sees one set of values.
void runChain(const MixPlan& plan, MixState& state, const MixChain& chain, float* left, float* right, int n, float step, int64_t start) {
    for (int e = chain.first; e < chain.first + chain.count; ++e) {
        const auto index = static_cast<size_t>(e);
        const auto& effect = plan.effects[index];
        float reduction = 0.0f;
        if (effect.laneCount == 0) {
            reduction = runEffect(plan, state, index, effect.params, left, right, n, step);
        } else {
            auto& params = state.effectParams[index];
            int done = 0;
            while (done < n) {
                const int64_t at = start + done;
                const int64_t phase = ((at % kAutomationBlock) + kAutomationBlock) % kAutomationBlock;
                const int length = static_cast<int>(std::min<int64_t>(n - done, kAutomationBlock - phase));
                for (int l = effect.firstLane; l < effect.firstLane + effect.laneCount; ++l) {
                    const auto& lane = plan.lanes[static_cast<size_t>(l)];
                    params[static_cast<size_t>(lane.param)] = laneValueAt(plan, lane, at - phase);
                }
                reduction = std::max(reduction, runEffect(plan, state, index, params, left + done, right + done, length, step));
                done += length;
            }
        }
        raise(state.effectMeter[index], reduction);
    }
}
} // namespace

float laneValueAt(const MixPlan& plan, const MixLane& lane, int64_t position) {
    if (lane.pointCount <= 0 || lane.firstPoint < 0 || lane.firstPoint + lane.pointCount > static_cast<int>(plan.points.size()))
        return lane.minimum;
    const double value = automationValueAt(plan.points.data() + lane.firstPoint, lane.pointCount, position);
    return std::clamp(static_cast<float>(value), lane.minimum, lane.maximum);
}

void prepareMixState(const MixPlan& plan, MixState& state) {
    state.sourceCount = static_cast<int>(plan.sources.size());
    state.busCount = static_cast<int>(plan.buses.size());
    state.busL.assign(plan.buses.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.busR.assign(plan.buses.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.feedL.assign(plan.feeds.size(), 0.0f);
    state.feedR.assign(plan.feeds.size(), 0.0f);
    state.master = 1.0f;
    state.primed = false;
    const size_t sourceSlots = std::max<size_t>(1, plan.sources.size() * 2);
    const size_t busSlots = std::max<size_t>(1, plan.buses.size() * 2);
    state.sourcePeak = std::make_unique<std::atomic<float>[]>(sourceSlots);
    state.busPeak = std::make_unique<std::atomic<float>[]>(busSlots);
    state.sourceSumSq = std::make_unique<std::atomic<float>[]>(sourceSlots);
    state.busSumSq = std::make_unique<std::atomic<float>[]>(busSlots);
    state.sourceSamples = std::make_unique<std::atomic<int>[]>(std::max<size_t>(1, plan.sources.size()));
    state.busSamples = std::make_unique<std::atomic<int>[]>(std::max<size_t>(1, plan.buses.size()));
    for (size_t i = 0; i < sourceSlots; ++i) {
        state.sourcePeak[i].store(0.0f, std::memory_order_relaxed);
        state.sourceSumSq[i].store(0.0f, std::memory_order_relaxed);
    }
    for (size_t i = 0; i < busSlots; ++i) {
        state.busPeak[i].store(0.0f, std::memory_order_relaxed);
        state.busSumSq[i].store(0.0f, std::memory_order_relaxed);
    }
    for (size_t i = 0; i < plan.sources.size(); ++i)
        state.sourceSamples[i].store(0, std::memory_order_relaxed);
    for (size_t i = 0; i < plan.buses.size(); ++i)
        state.busSamples[i].store(0, std::memory_order_relaxed);
    state.effectCount = static_cast<int>(plan.effects.size());
    state.effects.clear();
    state.effects.reserve(plan.effects.size());
    for (const auto& effect : plan.effects)
        state.effects.push_back(createEffectDsp(effect.type, plan.sampleRate, effect.params));
    state.effectMix.assign(plan.effects.size(), 0.0f);
    state.effectWarm.assign(plan.effects.size(), 1.0f);
    const size_t effectSlots = std::max<size_t>(1, plan.effects.size());
    state.effectMeter = std::make_unique<std::atomic<float>[]>(effectSlots);
    for (size_t i = 0; i < effectSlots; ++i)
        state.effectMeter[i].store(0.0f, std::memory_order_relaxed);
    state.insertL.assign(kMixChunk, 0.0f);
    state.insertR.assign(kMixChunk, 0.0f);
    state.dryL.assign(kMixChunk, 0.0f);
    state.dryR.assign(kMixChunk, 0.0f);
    state.effectParams.clear();
    state.effectParams.reserve(plan.effects.size());
    for (const auto& effect : plan.effects)
        state.effectParams.push_back(effect.params);
    state.laneValue.assign(plan.lanes.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.lanePanL.assign(plan.lanes.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.lanePanR.assign(plan.lanes.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.inputL.assign(plan.inputs.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.inputR.assign(plan.inputs.size() * static_cast<size_t>(kMixChunk), 0.0f);
    state.tailQuiet = 0;
    state.tailLoud = -1;
}

void applyRenderTail(MixPlan& plan, const TailSettings& tail) {
    plan.tailMax = 0;
    plan.tailHold = 1;
    plan.tailFloor = 0.0f;
    bool rings = false;
    double longestDelayMs = 0.0;
    for (const auto& effect : plan.effects) {
        if (!effect.enabled)
            continue;
        if (effect.type == EffectType::reverb)
            rings = true;
        if (effect.type == EffectType::delay) {
            rings = true;
            longestDelayMs = std::max(longestDelayMs, static_cast<double>(effect.params[fx::delayTime]));
            for (int l = effect.firstLane; l < effect.firstLane + effect.laneCount; ++l) {
                const auto& lane = plan.lanes[static_cast<size_t>(l)];
                if (lane.param != fx::delayTime)
                    continue;
                for (int p = lane.firstPoint; p < lane.firstPoint + lane.pointCount; ++p)
                    longestDelayMs = std::max(longestDelayMs, std::clamp(plan.points[static_cast<size_t>(p)].value,
                                                                         static_cast<double>(lane.minimum), static_cast<double>(lane.maximum)));
            }
        }
    }
    if (!tail.enabled || !rings || !checkTailSettings(tail).empty() || tail.maxSeconds <= 0.0)
        return;
    plan.tailMax = static_cast<int64_t>(std::llround(tail.maxSeconds * plan.sampleRate));
    plan.tailHold = std::max<int64_t>(1, std::llround(std::max(0.2, longestDelayMs * 0.001 + 0.05) * plan.sampleRate));
    plan.tailFloor = static_cast<float>(std::pow(10.0, tail.thresholdDb / 20.0));
}

void inheritMixState(const MixPlan& from, MixState& fromState, const MixPlan& to, MixState& toState, bool keepEffects) {
    if (!fromState.primed || !stateMatches(to, toState))
        return;
    const size_t fromEffects = keepEffects ? std::min(from.effects.size(), fromState.effects.size()) : 0;
    for (size_t i = 0; i < to.effects.size(); ++i) {
        toState.effectMix[i] = keepEffects ? 0.0f : (to.effects[i].enabled ? 1.0f : 0.0f);
        toState.effectWarm[i] = keepEffects ? 0.0f : 1.0f;
        for (size_t j = 0; j < fromEffects; ++j) {
            auto& old = fromState.effects[j];
            if (from.effects[j].key != to.effects[i].key || old == nullptr || toState.effects[i] == nullptr)
                continue;
            if (old->type() != to.effects[i].type || old->sampleRate() != to.sampleRate)
                continue;
            if (fromState.effectMix[j] == 0.0f)
                break;   // fully bypassed: stale history, keep the clean processor
            std::swap(toState.effects[i], old);
            toState.effectMix[i] = fromState.effectMix[j];
            toState.effectWarm[i] = fromState.effectWarm[j];
            fromState.effectMix[j] = 0.0f;
            break;
        }
    }
    toState.tailQuiet = fromState.tailQuiet;
    toState.tailLoud = fromState.tailLoud;
    const size_t fromCount = std::min(from.feeds.size(), fromState.feedL.size());
    for (size_t i = 0; i < to.feeds.size(); ++i) {
        float l = 0.0f;
        float r = 0.0f;
        for (size_t j = 0; j < fromCount; ++j) {
            if (from.feeds[j].key == to.feeds[i].key) {
                l = fromState.feedL[j];
                r = fromState.feedR[j];
                break;
            }
        }
        toState.feedL[i] = l;
        toState.feedR[i] = r;
    }
    toState.master = fromState.master;
    toState.primed = true;
}

MixResult mixRoute(const MixPlan& plan,
                   MixState& state,
                   float masterGain,
                   Clock clock,
                   int64_t timeline,
                   float* outL,
                   float* outR,
                   int numSamples,
                   const float* micL,
                   const float* micR,
                   bool monitor,
                   const MixInputIO* inputs,
                   const SpectrumTapRequest* spectrum) {
    MixResult result;
    result.clock = clock;
    if (outL == nullptr || outR == nullptr || outL == outR || numSamples <= 0)
        return result;
    // Flush denormals here too, so offline renders match the audio callback.
    juce::ScopedNoDenormals noDenormals;
    const bool usable = stateMatches(plan, state);
    const float masterTarget = std::clamp(masterGain, 0.0f, 4.0f);
    const MixLane* masterLane = usable && plan.masterLane >= 0 && plan.masterLane < static_cast<int>(plan.lanes.size())
        ? &plan.lanes[static_cast<size_t>(plan.masterLane)]
        : nullptr;
    const float step = plan.rampStep > 0.0f ? plan.rampStep : 1.0f;
    const bool playing = clock.mode == TransportMode::playing;
    const int64_t tailMax = usable ? std::max<int64_t>(0, plan.tailMax) : 0;
    const int64_t renderEnd = timeline > 0 ? timeline + tailMax : 0;
    int64_t playSamples = 0;
    if (playing && timeline > 0 && clock.position < renderEnd)
        playSamples = std::min<int64_t>(numSamples, renderEnd - clock.position);
    if (clock.position < timeline) {
        state.tailQuiet = 0;
        state.tailLoud = -1;
    }
    bool tailEnded = false;

    if (usable && (!state.primed || playSamples <= 0)) {
        // Nothing is flowing through the feeds, so they can jump to their targets without a click.
        for (size_t i = 0; i < plan.feeds.size(); ++i) {
            state.feedL[i] = plan.feeds[i].targetL;
            state.feedR[i] = plan.feeds[i].targetR;
            if (feedAutomated(plan.feeds[i]))
                automatedTarget(plan, plan.feeds[i], clock.position, state.feedL[i], state.feedR[i]);
        }
        for (size_t e = 0; e < plan.effects.size(); ++e) {
            state.effectMix[e] = plan.effects[e].enabled ? 1.0f : 0.0f;
            state.effectWarm[e] = 1.0f;
        }
        if (!state.primed)
            state.master = masterLane != nullptr ? laneValueAt(plan, *masterLane, clock.position) : masterTarget;
        state.primed = true;
    }

    float masterPeakL = 0.0f;
    float masterPeakR = 0.0f;
    float masterSumSqL = 0.0f;
    float masterSumSqR = 0.0f;
    int masterSampleCount = 0;
    for (int offset = 0; offset < numSamples; offset += kMixChunk) {
        const int n = std::min(kMixChunk, numSamples - offset);
        float* oL = outL + offset;
        float* oR = outR + offset;
        clear(oL, n);
        clear(oR, n);
        const int chunkPlay = usable && !tailEnded ? static_cast<int>(std::clamp<int64_t>(playSamples - offset, 0, n)) : 0;
        if (chunkPlay > 0) {
            for (size_t b = 0; b < plan.buses.size(); ++b) {
                clear(state.busL.data() + b * kMixChunk, chunkPlay);
                clear(state.busR.data() + b * kMixChunk, chunkPlay);
            }
            const int64_t chunkStart = clock.position + offset;
            for (size_t l = 0; l < plan.lanes.size(); ++l) {
                const auto& lane = plan.lanes[l];
                if (lane.kind == LaneKind::effect)
                    continue;
                float* values = state.laneValue.data() + l * kMixChunk;
                fillLane(plan, lane, chunkStart, chunkPlay, values);
                if (lane.kind == LaneKind::pan) {
                    float* panL = state.lanePanL.data() + l * kMixChunk;
                    float* panR = state.lanePanR.data() + l * kMixChunk;
                    for (int i = 0; i < chunkPlay; ++i)
                        panLaw(values[i], panL[i], panR[i]);
                }
            }
            for (size_t k = 0; k < plan.inputs.size(); ++k) {
                const auto& input = plan.inputs[k];
                float* iL = state.inputL.data() + k * kMixChunk;
                float* iR = state.inputR.data() + k * kMixChunk;
                const float* a = nullptr;
                const float* b = nullptr;
                if (inputs != nullptr) {
                    a = input.channels == 1 ? inputs->input2 : inputs->input1;
                    b = input.channels == 0 ? inputs->input1 : inputs->input2;
                }
                if (a != nullptr)
                    std::memcpy(iL, a + offset, sizeof(float) * static_cast<size_t>(chunkPlay));
                else
                    clear(iL, chunkPlay);
                if (b != nullptr)
                    std::memcpy(iR, b + offset, sizeof(float) * static_cast<size_t>(chunkPlay));
                else
                    clear(iR, chunkPlay);
                if (input.processed && input.chain.count > 0)
                    runChain(plan, state, input.chain, iL, iR, chunkPlay, step, chunkStart);
                if (inputs != nullptr && static_cast<int>(k) < inputs->processedCount
                    && inputs->processedL != nullptr && inputs->processedR != nullptr
                    && inputs->processedL[k] != nullptr && inputs->processedR[k] != nullptr) {
                    std::memcpy(inputs->processedL[k] + offset, iL, sizeof(float) * static_cast<size_t>(chunkPlay));
                    std::memcpy(inputs->processedR[k] + offset, iR, sizeof(float) * static_cast<size_t>(chunkPlay));
                }
            }
            for (size_t s = 0; s < plan.sources.size(); ++s) {
                const auto& source = plan.sources[s];
                float peakL = 0.0f;
                float peakR = 0.0f;
                float sumSqL = 0.0f;
                float sumSqR = 0.0f;
                int first = 0;
                int last = 0;
                if (source.left != nullptr && source.right != nullptr && source.length > 0) {
                    first = static_cast<int>(std::clamp<int64_t>(-chunkStart, 0, chunkPlay));
                    last = static_cast<int>(std::clamp<int64_t>(source.length - chunkStart, first, chunkPlay));
                }
                const float* readL = source.left;
                const float* readR = source.right;
                int64_t readBase = chunkStart;
                if (source.chain.count > 0) {
                    // Inserts process the whole chunk, including silence after the clip, so
                    // reverb and delay tails keep sounding to the timeline end and through the tail.
                    float* iL = state.insertL.data();
                    float* iR = state.insertR.data();
                    clear(iL, chunkPlay);
                    clear(iR, chunkPlay);
                    if (last > first) {
                        std::memcpy(iL + first, source.left + chunkStart + first, sizeof(float) * static_cast<size_t>(last - first));
                        std::memcpy(iR + first, source.right + chunkStart + first, sizeof(float) * static_cast<size_t>(last - first));
                    }
                    runChain(plan, state, source.chain, iL, iR, chunkPlay, step, chunkStart);
                    // Post-insert / pre-fader spectrum tap (actual mixed samples — never fabricated).
                    if (spectrum != nullptr && spectrum->capture != nullptr
                        && spectrum->kind == SpectrumTapKind::track
                        && spectrum->index == static_cast<int>(s))
                        spectrum->capture->writeStereo(iL, iR, chunkPlay);
                    readL = iL;
                    readR = iR;
                    readBase = 0;
                    first = 0;
                    last = chunkPlay;
                } else if (spectrum != nullptr && spectrum->capture != nullptr
                           && spectrum->kind == SpectrumTapKind::track
                           && spectrum->index == static_cast<int>(s)
                           && last > first && source.left != nullptr && source.right != nullptr) {
                    spectrum->capture->writeStereo(source.left + chunkStart + first,
                                                   source.right + chunkStart + first, last - first);
                }
                if (source.monitorInput >= 0 && source.monitorInput < static_cast<int>(plan.inputs.size())) {
                    float* iL = state.insertL.data();
                    float* iR = state.insertR.data();
                    if (source.chain.count == 0) {
                        clear(iL, chunkPlay);
                        clear(iR, chunkPlay);
                        if (last > first) {
                            std::memcpy(iL + first, source.left + chunkStart + first, sizeof(float) * static_cast<size_t>(last - first));
                            std::memcpy(iR + first, source.right + chunkStart + first, sizeof(float) * static_cast<size_t>(last - first));
                        }
                    }
                    const auto& monitored = plan.inputs[static_cast<size_t>(source.monitorInput)];
                    if (inputs != nullptr && inputs->monitor1 != nullptr) {
                        const float* a = monitored.channels == 1 ? inputs->monitor2 : inputs->monitor1;
                        const float* b = monitored.channels == 0 ? inputs->monitor1 : inputs->monitor2;
                        for (int i = 0; i < chunkPlay; ++i) {
                            iL[i] += a != nullptr ? a[offset + i] : 0.0f;
                            iR[i] += b != nullptr ? b[offset + i] : 0.0f;
                        }
                    } else {
                        const float* mL = state.inputL.data() + static_cast<size_t>(source.monitorInput) * kMixChunk;
                        const float* mR = state.inputR.data() + static_cast<size_t>(source.monitorInput) * kMixChunk;
                        for (int i = 0; i < chunkPlay; ++i) {
                            iL[i] += mL[i];
                            iR[i] += mR[i];
                        }
                    }
                    readL = iL;
                    readR = iR;
                    readBase = 0;
                    first = 0;
                    last = chunkPlay;
                }
                for (int f = source.firstFeed; f < source.firstFeed + source.feedCount; ++f) {
                    const auto& feed = plan.feeds[static_cast<size_t>(f)];
                    float* dL = feed.dest == kMasterDest ? oL : state.busL.data() + static_cast<size_t>(feed.dest) * kMixChunk;
                    float* dR = feed.dest == kMasterDest ? oR : state.busR.data() + static_cast<size_t>(feed.dest) * kMixChunk;
                    float& gL = state.feedL[static_cast<size_t>(f)];
                    float& gR = state.feedR[static_cast<size_t>(f)];
                    const bool meterThis = f == source.meterFeed;
                    if (feedAutomated(feed)) {
                        float pL = 0.0f;
                        float pR = 0.0f;
                        float sL = 0.0f;
                        float sR = 0.0f;
                        addAutomated(state, feed, readL, readR, readBase, first, last, chunkPlay, dL, dR, gL, gR, step, pL, pR,
                                     meterThis ? &sL : nullptr, meterThis ? &sR : nullptr);
                        if (meterThis) {
                            peakL = pL;
                            peakR = pR;
                            sumSqL = sL;
                            sumSqR = sR;
                        }
                        continue;
                    }
                    advance(gL, feed.targetL, step, first);
                    advance(gR, feed.targetR, step, first);
                    float pL = 0.0f;
                    float pR = 0.0f;
                    float sL = 0.0f;
                    float sR = 0.0f;
                    if (last > first) {
                        const int64_t at = readBase + first;
                        addRamped(readL + at, readR + at, dL + first, dR + first, last - first,
                                  gL, gR, feed.targetL, feed.targetR, step, pL, pR,
                                  meterThis ? &sL : nullptr, meterThis ? &sR : nullptr);
                    }
                    advance(gL, feed.targetL, step, chunkPlay - last);
                    advance(gR, feed.targetR, step, chunkPlay - last);
                    if (meterThis) {
                        peakL = pL;
                        peakR = pR;
                        sumSqL = sL;
                        sumSqR = sR;
                    }
                }
                raise(state.sourcePeak[s * 2], peakL);
                raise(state.sourcePeak[s * 2 + 1], peakR);
                addAtomic(state.sourceSumSq[s * 2], sumSqL);
                addAtomic(state.sourceSumSq[s * 2 + 1], sumSqR);
                state.sourceSamples[s].fetch_add(chunkPlay, std::memory_order_relaxed);
            }
            for (size_t b = 0; b < plan.buses.size(); ++b) {
                const auto& bus = plan.buses[b];
                float* sL = state.busL.data() + b * kMixChunk;
                float* sR = state.busR.data() + b * kMixChunk;
                if (bus.chain.count > 0)
                    runChain(plan, state, bus.chain, sL, sR, chunkPlay, step, chunkStart);
                if (spectrum != nullptr && spectrum->capture != nullptr
                    && spectrum->kind == SpectrumTapKind::bus
                    && spectrum->index == static_cast<int>(b))
                    spectrum->capture->writeStereo(sL, sR, chunkPlay);
                float peakL = 0.0f;
                float peakR = 0.0f;
                float sumSqL = 0.0f;
                float sumSqR = 0.0f;
                for (int f = bus.firstFeed; f < bus.firstFeed + bus.feedCount; ++f) {
                    const auto& feed = plan.feeds[static_cast<size_t>(f)];
                    // Plans are ordered so a bus never feeds itself or an earlier bus.
                    if (feed.dest != kMasterDest && feed.dest <= static_cast<int>(b))
                        continue;
                    float* dL = feed.dest == kMasterDest ? oL : state.busL.data() + static_cast<size_t>(feed.dest) * kMixChunk;
                    float* dR = feed.dest == kMasterDest ? oR : state.busR.data() + static_cast<size_t>(feed.dest) * kMixChunk;
                    float pL = 0.0f;
                    float pR = 0.0f;
                    float sqL = 0.0f;
                    float sqR = 0.0f;
                    const bool meterThis = f == bus.meterFeed;
                    if (feedAutomated(feed))
                        addAutomated(state, feed, sL, sR, 0, 0, chunkPlay, chunkPlay, dL, dR,
                                     state.feedL[static_cast<size_t>(f)], state.feedR[static_cast<size_t>(f)], step, pL, pR,
                                     meterThis ? &sqL : nullptr, meterThis ? &sqR : nullptr);
                    else
                        addRamped(sL, sR, dL, dR, chunkPlay,
                                  state.feedL[static_cast<size_t>(f)], state.feedR[static_cast<size_t>(f)],
                                  feed.targetL, feed.targetR, step, pL, pR,
                                  meterThis ? &sqL : nullptr, meterThis ? &sqR : nullptr);
                    if (meterThis) {
                        peakL = pL;
                        peakR = pR;
                        sumSqL = sqL;
                        sumSqR = sqR;
                    }
                }
                raise(state.busPeak[b * 2], peakL);
                raise(state.busPeak[b * 2 + 1], peakR);
                addAtomic(state.busSumSq[b * 2], sumSqL);
                addAtomic(state.busSumSq[b * 2 + 1], sumSqR);
                state.busSamples[b].fetch_add(chunkPlay, std::memory_order_relaxed);
            }
            if (plan.masterChain.count > 0)
                runChain(plan, state, plan.masterChain, oL, oR, chunkPlay, step, chunkStart);
            if (spectrum != nullptr && spectrum->capture != nullptr
                && spectrum->kind == SpectrumTapKind::master)
                spectrum->capture->writeStereo(oL, oR, chunkPlay);
            if (tailMax > 0 && chunkStart + chunkPlay > timeline) {
                // Per sample, so the end of the tail does not depend on the block size.
                const float quietBelow = plan.tailFloor;
                const int64_t hold = std::max<int64_t>(1, plan.tailHold);
                for (int i = static_cast<int>(std::max<int64_t>(0, timeline - chunkStart)); i < chunkPlay; ++i) {
                    if (std::fabs(oL[i]) >= quietBelow || std::fabs(oR[i]) >= quietBelow) {
                        state.tailLoud = chunkStart + i;
                        state.tailQuiet = 0;
                    } else if (++state.tailQuiet >= hold) {
                        clear(oL + i + 1, n - i - 1);
                        clear(oR + i + 1, n - i - 1);
                        playSamples = offset + i + 1;
                        tailEnded = true;
                        break;
                    }
                }
            }
        }

        if (monitor && micL != nullptr) {
            for (int i = 0; i < n; ++i) {
                oL[i] += micL[offset + i];
                oR[i] += micR != nullptr ? micR[offset + i] : micL[offset + i];
            }
        }

        if (!usable)
            state.master = masterTarget;
        if (masterLane != nullptr) {
            // Played samples follow the lane per sample; the rest of the chunk holds the value where playback is.
            const float* values = state.laneValue.data() + static_cast<size_t>(plan.masterLane) * kMixChunk;
            const float held = chunkPlay < n ? laneValueAt(plan, *masterLane, clock.position + (playing ? offset + chunkPlay : 0)) : 0.0f;
            for (int i = 0; i < n; ++i) {
                stepToward(state.master, i < chunkPlay ? values[i] : held, step);
                oL[i] *= state.master;
                oR[i] *= state.master;
                masterPeakL = std::max(masterPeakL, std::fabs(oL[i]));
                masterPeakR = std::max(masterPeakR, std::fabs(oR[i]));
                masterSumSqL += oL[i] * oL[i];
                masterSumSqR += oR[i] * oR[i];
            }
        } else {
            for (int i = 0; i < n; ++i) {
                stepToward(state.master, masterTarget, step);
                oL[i] *= state.master;
                oR[i] *= state.master;
                masterPeakL = std::max(masterPeakL, std::fabs(oL[i]));
                masterPeakR = std::max(masterPeakR, std::fabs(oR[i]));
                masterSumSqL += oL[i] * oL[i];
                masterSumSqR += oR[i] * oR[i];
            }
        }
        masterSampleCount += n;
    }
    result.peakL = masterPeakL;
    result.peakR = masterPeakR;
    result.sumSqL = masterSumSqL;
    result.sumSqR = masterSumSqR;
    result.meterSamples = masterSampleCount;
    result.played = static_cast<int>(playSamples);

    if (playing) {
        if (timeline <= 0) {
            result.clock.position = clock.position;
            result.clock.mode = TransportMode::playing;
        } else {
            const int64_t reached = clock.position + playSamples;
            if (tailEnded || reached >= renderEnd) {
                result.clock.position = timeline;
                result.clock.mode = TransportMode::stopped;
                if (tailEnded)
                    result.end = state.tailLoud >= timeline ? state.tailLoud + 1 : timeline;
                else
                    result.end = renderEnd;
            } else {
                result.clock.position = reached;
                result.clock.mode = TransportMode::playing;
            }
        }
    }
    return result;
}

void panLaw(float pan, float& leftGain, float& rightGain) {
    const float clamped = std::clamp(pan, -1.0f, 1.0f);
    const double angle = (static_cast<double>(clamped) + 1.0) * (kPi * 0.25);
    leftGain = static_cast<float>(std::cos(angle));
    rightGain = static_cast<float>(std::sin(angle));
}

MixResult mixBlock(const MixTrackView* tracks,
                   int numTracks,
                   float masterGain,
                   Clock clock,
                   int64_t timeline,
                   float* outL,
                   float* outR,
                   int numSamples,
                   const float* micL,
                   const float* micR,
                   bool monitor) {
    MixResult result;
    result.clock = clock;
    if (outL == nullptr || outR == nullptr || numSamples <= 0)
        return result;

    clear(outL, numSamples);
    if (outR != outL)
        clear(outR, numSamples);

    const float master = std::clamp(masterGain, 0.0f, 4.0f);
    bool anySolo = false;
    for (int t = 0; t < numTracks; ++t) {
        if (tracks[t].present && tracks[t].solo)
            anySolo = true;
    }

    const bool playing = clock.mode == TransportMode::playing;
    int64_t playSamples = 0;
    if (playing && timeline > 0 && clock.position < timeline)
        playSamples = std::min<int64_t>(numSamples, timeline - clock.position);

    if (playing && playSamples > 0) {
        for (int t = 0; t < numTracks; ++t) {
            const auto& track = tracks[t];
            if (!track.present || track.mute)
                continue;
            if (anySolo && !track.solo)
                continue;
            if (track.left == nullptr || track.right == nullptr || track.length <= 0)
                continue;

            float panL = 1.0f;
            float panR = 1.0f;
            panLaw(track.pan, panL, panR);
            const float gain = std::clamp(track.gain, 0.0f, 4.0f);
            const float gL = gain * panL;
            const float gR = gain * panR;
            const int64_t start = clock.position;
            const int frames = static_cast<int>(playSamples);
            for (int i = 0; i < frames; ++i) {
                const int64_t p = start + i;
                if (p < 0 || p >= track.length)
                    continue;
                outL[i] += track.left[p] * gL;
                outR[i] += track.right[p] * gR;
            }
        }
    }

    if (monitor && micL != nullptr) {
        for (int i = 0; i < numSamples; ++i) {
            outL[i] += micL[i];
            outR[i] += micR != nullptr ? micR[i] : micL[i];
        }
    }

    float peakL = 0.0f;
    float peakR = 0.0f;
    for (int i = 0; i < numSamples; ++i) {
        outL[i] *= master;
        outR[i] *= master;
        peakL = std::max(peakL, std::fabs(outL[i]));
        peakR = std::max(peakR, std::fabs(outR[i]));
    }
    result.peakL = peakL;
    result.peakR = peakR;

    if (playing) {
        if (timeline <= 0) {
            result.clock.position = clock.position;
            result.clock.mode = TransportMode::playing;
        } else if (clock.position >= timeline) {
            result.clock.position = timeline;
            result.clock.mode = TransportMode::stopped;
        } else {
            result.clock.position = clock.position + playSamples;
            result.clock.mode = result.clock.position >= timeline ? TransportMode::stopped
                                                                  : TransportMode::playing;
        }
    }
    return result;
}

Clock transportPlay(Clock clock, int64_t timeline) {
    if (clock.mode == TransportMode::paused) {
        clock.mode = TransportMode::playing;
        return clock;
    }
    if (timeline > 0 && clock.position >= timeline)
        clock.position = 0;
    clock.mode = TransportMode::playing;
    return clock;
}

Clock transportPause(Clock clock) {
    if (clock.mode == TransportMode::playing)
        clock.mode = TransportMode::paused;
    return clock;
}

Clock transportStop() {
    return Clock {};
}

Clock transportSeek(Clock clock, double seconds, int sampleRate, int64_t timeline) {
    if (!(seconds >= 0.0) || sampleRate <= 0) {
        clock.position = 0;
    } else {
        const double frames = seconds * static_cast<double>(sampleRate);
        clock.position = static_cast<int64_t>(frames);
    }
    if (clock.position < 0)
        clock.position = 0;
    if (timeline >= 0 && clock.position > timeline)
        clock.position = timeline;
    if (timeline > 0 && clock.position >= timeline)
        clock.mode = TransportMode::stopped;
    return clock;
}

} // namespace msp
