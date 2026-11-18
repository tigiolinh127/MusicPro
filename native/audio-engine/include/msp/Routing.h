#pragma once

#include "msp/Mixer.h"
#include "msp/Project.h"

#include <string>
#include <vector>

namespace msp {

constexpr int kMaxBuses = 64;

// One track as the router sees it. Audio pointers may be null for tracks without audio;
// those tracks still take part in solo decisions.
struct RouteTrack {
    std::string id;
    const float* left = nullptr;
    const float* right = nullptr;
    int64_t length = 0;
    float gain = 1.0f;
    float pan = 0.0f;
    bool mute = false;
    bool solo = false;
    std::string output = kMasterBusId;
    std::vector<ProjectSend> sends;
    std::vector<ProjectEffect> effects;
    std::vector<AutomationLane> automation;
    // An armed track takes part in the plan even without audio, so its input can be monitored
    // and recorded through its inserts.
    bool armed = false;
    RecordInput recordInput = RecordInput::first;
    bool processInput = false;            // run the input through a copy of the inserts
    bool monitorInput = false;
};

const ProjectBus* findBus(const std::vector<ProjectBus>& buses, const std::string& id);

// MixInput::key of a track's record input.
uint64_t recordInputKey(const std::string& trackId);

// Each check returns a user-facing error, or an empty string when the route is allowed.
// Tracks feed the master or a group bus. Return buses are reached only through sends.
std::string checkTrackOutput(const std::vector<ProjectBus>& buses, const std::string& output);
// Buses feed the master or a group bus, never themselves, never a return, never a loop.
std::string checkBusOutput(const std::vector<ProjectBus>& buses, const std::string& busId, const std::string& output);
std::string checkSend(const std::vector<ProjectBus>& buses, const std::string& busId);

// Fixes duplicate ids, self routes, missing destinations and loops. Buses are never deleted
// for a routing problem; their output is moved to the master instead.
void repairBuses(std::vector<ProjectBus>& buses, std::vector<std::string>& warnings);

// Compiles the mix into a plan for mixRoute. `previous` lets feeds that disappeared because of
// a route change fade out instead of cutting off. Track, bus and master insert chains are
// copied into the plan in order; at most kMaxEffectsPerChain effects per chain are used.
// Active automation lanes of tracks, buses and the master (`masterAutomation`) become plan lanes.
MixPlan buildMixPlan(const std::vector<RouteTrack>& tracks,
                     const std::vector<ProjectBus>& buses,
                     double sampleRate,
                     const MixPlan* previous,
                     const std::vector<ProjectEffect>* masterEffects = nullptr,
                     const std::vector<AutomationLane>* masterAutomation = nullptr);

// Value range of an automatable parameter on a "track" (volume, pan, effects), "bus" (volume,
// effects) or "master" (effects). False for anything else, including choice parameters such as
// the EQ band type.
bool automationRange(const std::string& ownerKind, const std::string& param, const std::vector<ProjectEffect>& effects,
                     float& minimum, float& maximum);

} // namespace msp
