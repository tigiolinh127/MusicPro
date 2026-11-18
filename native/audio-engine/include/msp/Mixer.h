#pragma once

#include "msp/Automation.h"
#include "msp/Effects.h"
#include "msp/SpectrumAnalyzer.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace msp {

enum class TransportMode : int {
    stopped = 0,
    playing = 1,
    paused = 2
};

struct Clock {
    TransportMode mode = TransportMode::stopped;
    int64_t position = 0;
};

struct MixTrackView {
    const float* left = nullptr;
    const float* right = nullptr;
    int64_t length = 0;
    float gain = 1.0f;
    float pan = 0.0f;
    bool mute = false;
    bool solo = false;
    bool present = false;
};

struct MixResult {
    Clock clock;
    float peakL = 0.0f;
    float peakR = 0.0f;
    float sumSqL = 0.0f;      // master post-fader sum of squares (Phase 2.7.3 RMS)
    float sumSqR = 0.0f;
    int meterSamples = 0;     // samples included in sumSq*
    int played = 0;           // samples of this block rendered from the timeline or its effect tail
    int64_t end = -1;         // set when playback ended in this block: the last frame worth keeping
};

// Constant-power pan. pan -1 is hard left, 0 is equal power, +1 is hard right.
void panLaw(float pan, float& leftGain, float& rightGain);

// Realtime-safe: no allocation, locks, I/O, or logging.
// Track audio is read only while clock.mode == playing.
// Microphone mix is independent of transport and is then scaled by masterGain.
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
                   bool monitor);

// ---- Routed mix (Phase 2.1) -------------------------------------------------------------
// A MixPlan is built on the control thread and never changed after it is published.
// Every gain stage (fader, pan, mute, solo, send level, bus gain) is folded into the target
// gains of "feeds". The audio thread only ramps feed gains toward their targets and sums.

constexpr int kMixChunk = 512;
constexpr int kMasterDest = -1;

struct MixFeed {
    int dest = kMasterDest;   // bus index in MixPlan::buses, or kMasterDest
    uint64_t key = 0;         // stable identity used to carry gain ramps across plans
    float targetL = 0.0f;
    float targetR = 0.0f;
    // Automation. When gainLane or panLane is set, the target is recomputed every sample as
    // scale * gain(t) * panLaw(pan(t)); a parameter without a lane keeps its manual value below.
    // The gain still moves toward that target by at most rampStep per sample.
    int gainLane = -1;        // MixPlan::lanes index driving the track or bus fader
    int panLane = -1;
    float scale = 0.0f;       // everything except fader and pan: audibility, send level, bus mute
    float gain = 1.0f;        // manual fader
    float pan = 0.0f;         // manual pan
    bool panned = false;      // track main outputs and post-fader sends follow the pan
};

enum class LaneKind { gain, pan, effect };

// An active automation lane in a plan. Its points are MixPlan::points[firstPoint, firstPoint + pointCount).
struct MixLane {
    LaneKind kind = LaneKind::gain;
    int effect = -1;          // MixPlan::effects index (effect lanes)
    int param = -1;           // parameter index (effect lanes)
    float minimum = 0.0f;
    float maximum = 4.0f;
    int firstPoint = 0;
    int pointCount = 0;
};

// One insert effect in a plan. Parameters are targets; the DSP smooths toward them.
struct MixEffect {
    EffectType type = EffectType::eq;
    uint64_t key = 0;         // stable identity (effect id and type) used to carry DSP state across plans
    bool enabled = true;
    EffectParams params {};
    int firstLane = 0;        // automated parameters: MixPlan::lanes[firstLane, firstLane + laneCount)
    int laneCount = 0;
};

// A contiguous run of MixPlan::effects, processed in order.
struct MixChain {
    int first = 0;
    int count = 0;
};

struct MixSource {
    const float* left = nullptr;
    const float* right = nullptr;
    int64_t length = 0;
    int firstFeed = 0;
    int feedCount = 0;
    int meterFeed = -1;       // the main output feed: track meters are post-fader, post-pan
    MixChain chain;           // inserts run before the fader, pan and sends
    int monitorInput = -1;    // MixPlan::inputs index heard through this track's fader, pan and sends
};

// The live input of an armed track. Each block it reads the selected input channels; when
// `processed` is set it runs them through its own copy of the track's insert chain. That
// result (or the raw input) is written to MixInputIO::processed for recording and, when
// `monitor` is set, summed into the track after its clip inserts so it is heard like the track.
// Inputs are only processed while the transport plays.
struct MixInput {
    uint64_t key = 0;         // identifies the track for the recorder
    int channels = 0;         // 0 = input 1, 1 = input 2, 2 = inputs 1 and 2 as a stereo pair
    bool monitor = false;
    bool processed = false;
    MixChain chain;
};

// Input channels for one mixRoute call and, per plan input, a stereo buffer of numSamples
// that receives that input as it is recorded on the processed path.
// `input1`/`input2` feed recording and any input-effect chains. When `monitor1` is non-null,
// track input monitoring hears `monitor1`/`monitor2` instead (same channel mapping), so the
// monitor path can stay raw while recording stays corrected.
struct MixInputIO {
    const float* input1 = nullptr;
    const float* input2 = nullptr;
    const float* monitor1 = nullptr;
    const float* monitor2 = nullptr;
    float* const* processedL = nullptr;
    float* const* processedR = nullptr;
    int processedCount = 0;
};

struct MixBus {
    int firstFeed = 0;
    int feedCount = 0;
    int meterFeed = -1;       // the current output feed: bus meters are post bus gain and mute
    MixChain chain;           // inserts run on the summed bus before its gain
};

struct MixPlan {
    std::vector<MixSource> sources;
    std::vector<MixBus> buses;            // a bus only feeds buses with a larger index, or the master
    std::vector<MixFeed> feeds;
    std::vector<MixEffect> effects;
    std::vector<MixLane> lanes;
    std::vector<AutomationPoint> points;
    std::vector<MixInput> inputs;
    MixChain masterChain;                 // runs on the summed master before master gain
    int masterLane = -1;                  // MixPlan::lanes index (gain) that replaces the master gain
    float rampStep = 0.002f;              // largest linear gain change per sample
    double sampleRate = 48000.0;
    // Effect tail after the timeline (see applyRenderTail). tailMax == 0 stops at the timeline.
    int64_t tailMax = 0;                  // most samples rendered after the timeline
    int64_t tailHold = 1;                 // consecutive quiet samples that end the tail
    float tailFloor = 0.0f;               // linear level below which the master counts as quiet
    // Control-thread bookkeeping. The audio thread never reads these.
    std::vector<std::string> sourceIds;
    std::vector<std::string> busIds;
    std::vector<std::string> feedFrom;
    std::vector<std::string> feedTo;
    std::vector<int> feedAge;             // 0 = live feed, > 0 = feed fading out after a route change
    std::vector<std::string> effectIds;
};

struct MixState {
    std::vector<float> busL;
    std::vector<float> busR;
    std::vector<float> feedL;
    std::vector<float> feedR;
    float master = 1.0f;
    bool primed = false;
    int64_t tailQuiet = 0;                // consecutive quiet master samples after the timeline
    int64_t tailLoud = -1;                // last position after the timeline at or above tailFloor
    int sourceCount = 0;
    int busCount = 0;
    int effectCount = 0;
    std::unique_ptr<std::atomic<float>[]> sourcePeak;   // 2 per source (L, R) — post-fader / post-pan
    std::unique_ptr<std::atomic<float>[]> busPeak;      // 2 per bus (L, R) — post bus gain/mute, after inserts
    // Sum-of-squares + sample counts for RMS (Phase 2.7.3). Audio thread accumulates; timer exchanges.
    std::unique_ptr<std::atomic<float>[]> sourceSumSq;  // 2 per source
    std::unique_ptr<std::atomic<float>[]> busSumSq;     // 2 per bus
    std::unique_ptr<std::atomic<int>[]> sourceSamples;  // 1 per source
    std::unique_ptr<std::atomic<int>[]> busSamples;     // 1 per bus
    // One prepared processor per plan effect. The audio thread swaps processors between
    // states (never allocates or frees them); the control thread frees them with the snapshot.
    std::vector<std::unique_ptr<EffectDsp>> effects;
    std::vector<float> effectMix;                       // bypass crossfade: 1 = processed, 0 = dry
    // Input gain into each processor. A processor that starts while audio is flowing begins at 0
    // and ramps to 1 in 10 ms, so its delay lines, combs and filters fill without a hard edge.
    std::vector<float> effectWarm;
    std::unique_ptr<std::atomic<float>[]> effectMeter;  // largest gain reduction (dB) per effect
    std::vector<float> insertL;
    std::vector<float> insertR;
    std::vector<float> dryL;
    std::vector<float> dryR;
    // Automation: one chunk of values per gain/pan lane (pan lanes also keep their pan-law gains),
    // and the parameters each effect actually runs with.
    std::vector<float> laneValue;
    std::vector<float> lanePanL;
    std::vector<float> lanePanR;
    std::vector<EffectParams> effectParams;
    std::vector<float> inputL;            // one chunk per plan input
    std::vector<float> inputR;
};

// Allocates buffers and effect processors sized for the plan. Control thread only.
void prepareMixState(const MixPlan& plan, MixState& state);

// Copies current ramp positions from the plan the audio thread was using. Feeds that are new
// in `to` start at silence and ramp in. Effect processors with the same key and sample rate are
// swapped into `toState` while they are audible (mix > 0), so delay lines, reverb tails and
// filter history continue. A fully bypassed processor has stopped running and its history is
// stale, so it is not carried: like a new effect, `toState` keeps the clean processor prepared
// on the control thread, which starts dry, warms up its input and crossfades in.
// With keepEffects false (transport stopped) no processor is carried over and the clean ones
// start at their enabled/bypassed mix. No allocation, no buffer clearing. Safe on the audio thread.
void inheritMixState(const MixPlan& from, MixState& fromState, const MixPlan& to, MixState& toState, bool keepEffects = true);

// Sets the plan's tail fields. The tail is only rendered when an enabled reverb or delay exists.
// It ends after `tailHold` quiet samples (at least 200 ms, and 50 ms longer than the longest
// enabled delay time so a gap between echoes is not mistaken for the end) or at maxSeconds.
void applyRenderTail(MixPlan& plan, const TailSettings& tail);

// Realtime-safe routed mix with the same transport, microphone and master rules as mixBlock.
// When the plan has a tail, playback continues past the timeline (clock.position runs into
// [timeline, timeline + tailMax)) with silent sources, so effects ring out. The tail ends on the
// first sample that completes `tailHold` quiet samples on the master (after master inserts,
// before the microphone and master gain), or at tailMax; the clock then stops at the timeline
// and MixResult::end is the frame after the last loud sample (or timeline + tailMax).
// Automation lanes are evaluated at each sample's timeline position, including during the tail,
// so a block size never changes the result. `inputs` (optional) feeds the plan's record inputs.
// `spectrum` (optional): post-insert / pre-fader tap for the analyzer (Phase 2.8.3).
struct SpectrumTapRequest {
    SpectrumTapKind kind = SpectrumTapKind::none;
    int index = 0;                 // source or bus index in the plan
    SpectrumCapture* capture = nullptr;
};

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
                   const MixInputIO* inputs = nullptr,
                   const SpectrumTapRequest* spectrum = nullptr);

// Current value of an automation lane in a plan (clamped to the lane's range).
float laneValueAt(const MixPlan& plan, const MixLane& lane, int64_t position);

Clock transportPlay(Clock clock, int64_t timeline);
Clock transportPause(Clock clock);
Clock transportStop();
Clock transportSeek(Clock clock, double seconds, int sampleRate, int64_t timeline);

} // namespace msp
