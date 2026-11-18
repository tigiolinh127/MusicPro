#include "msp/Session.h"

#include "msp/BreathSilence.h"
#include "msp/ClipStretch.h"
#include "msp/Crossfade.h"
#include "msp/OnsetDetection.h"
#include "msp/PitchShift.h"
#include "msp/TimeStretch.h"
#include "msp/Timing.h"
#include "msp/VocalPresets.h"
#include "msp/WavIO.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>

namespace msp {
namespace {
Clip* findTrackClip(std::vector<Clip>& clips, const std::string& id) {
    for (auto& clip : clips) {
        if (clip.id == id)
            return &clip;
    }
    return nullptr;
}

void takeOld(Session::Track& track, RetiredAudio& retired) {
    if (!track.playLeft.empty())
        retired.chunks.push_back(std::move(track.playLeft));
    if (!track.playRight.empty())
        retired.chunks.push_back(std::move(track.playRight));
    track.playLeft.clear();
    track.playRight.clear();
}

std::string rangeText(float minimum, float maximum) {
    char text[96];
    std::snprintf(text, sizeof(text), "%g and %g", static_cast<double>(minimum), static_cast<double>(maximum));
    return text;
}

std::string checkPoint(const AutomationPoint& point, float minimum, float maximum) {
    if (point.time < 0)
        return "An automation point cannot be before the start of the timeline.";
    if (!std::isfinite(point.value) || point.value < minimum || point.value > maximum)
        return "Automation value must be between " + rangeText(minimum, maximum) + ".";
    return {};
}

void sortPoints(std::vector<AutomationPoint>& points) {
    std::stable_sort(points.begin(), points.end(), [](const AutomationPoint& a, const AutomationPoint& b) { return a.time < b.time; });
}

std::string automatedMessage(const std::string& what) {
    return what + " is automated. Turn off its automation lane to set it by hand.";
}

// Phase 2.6.5: when an upstream stage remaps the audible source, drop downstream provenance
// so analysis / applied results are never silently reused against the wrong audio.
void clearPitchProvenance(Clip& clip) {
    clip.originalSourceFileId.clear();
    clip.originalSourceOffset = 0;
    clip.pitchShiftCents = 0.0;
    clip.pitchLabel.clear();
    clip.noteTargets.clear();
}

void clearBreathProvenance(Clip& clip) {
    clip.breathRegions.clear();
    clip.breathOriginalSourceFileId.clear();
    clip.breathOriginalSourceOffset = 0;
    clip.breathOriginalDuration = 0;
    clip.breathLabel.clear();
}

void clearStretchProvenance(Clip& clip) {
    clip.stretchMode.clear();
    clip.stretchRatio = 1.0;
    clip.stretchOriginalSourceFileId.clear();
    clip.stretchOriginalSourceOffset = 0;
    clip.stretchOriginalDuration = 0;
    clip.stretchLabel.clear();
}

void clearTimingProvenance(Clip& clip) {
    clip.timingMarkers.clear();
    clip.timingOriginalSourceFileId.clear();
    clip.timingOriginalSourceOffset = 0;
    clip.timingOriginalDuration = 0;
    clip.timingLabel.clear();
}

bool hasPitchApplied(const Clip& clip) {
    return !clip.originalSourceFileId.empty();
}

bool hasBreathApplied(const Clip& clip) {
    return !clip.breathOriginalSourceFileId.empty();
}

bool hasStretchApplied(const Clip& clip) {
    return !clip.stretchOriginalSourceFileId.empty();
}

bool findPlayBuffers(const Session::Track& track, const std::string& sourceId, const std::string& primaryId,
                     const float*& playL, const float*& playR, int64_t& length, int& channels) {
    playL = nullptr;
    playR = nullptr;
    length = 0;
    channels = 1;
    if (sourceId == primaryId || sourceId.empty()) {
        if (track.sourcePlayLeft.empty())
            return false;
        playL = track.sourcePlayLeft.data();
        const bool stereo = !track.sourcePlayRight.empty() && track.sourcePlayRight.size() == track.sourcePlayLeft.size();
        playR = stereo ? track.sourcePlayRight.data() : track.sourcePlayLeft.data();
        length = static_cast<int64_t>(track.sourcePlayLeft.size());
        channels = stereo ? 2 : 1;
        return true;
    }
    for (const auto& extra : track.extras) {
        if (extra.id != sourceId)
            continue;
        if (extra.playLeft.empty())
            return false;
        playL = extra.playLeft.data();
        playR = extra.playRight.size() == extra.playLeft.size() ? extra.playRight.data() : extra.playLeft.data();
        length = static_cast<int64_t>(extra.playLeft.size());
        channels = extra.channels >= 2 && extra.playRight.size() == extra.playLeft.size() ? 2 : 1;
        return true;
    }
    return false;
}

} // namespace

int Session::indexOf(const std::string& id) const {
    for (int i = 0; i < static_cast<int>(tracks.size()); ++i) {
        if (tracks[static_cast<size_t>(i)].used && tracks[static_cast<size_t>(i)].id == id)
            return i;
    }
    return -1;
}

int Session::busIndexOf(const std::string& id) const {
    for (int i = 0; i < static_cast<int>(buses.size()); ++i) {
        if (buses[static_cast<size_t>(i)].id == id)
            return i;
    }
    return -1;
}

std::string Session::addBus(BusKind kind, const std::string& name, std::string& createdId) {
    if (static_cast<int>(buses.size()) >= kMaxBuses)
        return "A project can have at most " + std::to_string(kMaxBuses) + " buses.";
    if (name.size() > 64)
        return "Bus name must be 64 characters or fewer.";
    ProjectBus bus;
    bus.kind = kind;
    do {
        bus.id = "bus-" + std::to_string(nextBusNumber++);
    } while (busIndexOf(bus.id) >= 0);
    if (name.empty()) {
        const std::string base = kind == BusKind::ret ? "Return " : "Group ";
        int count = 1;
        for (const auto& existing : buses)
            count += existing.kind == kind ? 1 : 0;
        for (;; ++count) {
            const auto candidate = base + std::to_string(count);
            bool taken = false;
            for (const auto& existing : buses)
                taken = taken || existing.name == candidate;
            if (!taken) {
                bus.name = candidate;
                break;
            }
        }
    } else {
        bus.name = name;
    }
    buses.push_back(bus);
    createdId = bus.id;
    return {};
}

std::string Session::removeBus(const std::string& id) {
    const int index = busIndexOf(id);
    if (index < 0)
        return "No bus exists with that id.";
    const auto removed = buses[static_cast<size_t>(index)];
    // Anything that fed the removed bus moves to where that bus was going, so no audio is lost.
    const std::string replacement = removed.kind == BusKind::group ? removed.output : std::string(kMasterBusId);
    for (auto& track : tracks) {
        if (track.output == id)
            track.output = replacement;
        track.sends.erase(std::remove_if(track.sends.begin(), track.sends.end(),
                                         [&](const ProjectSend& send) { return send.bus == id; }),
                          track.sends.end());
    }
    for (auto& bus : buses) {
        if (bus.output == id)
            bus.output = replacement;
    }
    buses.erase(buses.begin() + index);
    return {};
}

std::string Session::renameBus(const std::string& id, const std::string& name) {
    const int index = busIndexOf(id);
    if (index < 0)
        return "No bus exists with that id.";
    if (name.empty() || name.size() > 64)
        return "Bus name must be 1 to 64 characters.";
    buses[static_cast<size_t>(index)].name = name;
    return {};
}

std::string Session::setBus(const std::string& id, const ProjectBus& values, bool setGain, bool setMute, bool setSolo, bool setOutput) {
    const int index = busIndexOf(id);
    if (index < 0)
        return "No bus exists with that id.";
    if (setGain && (!std::isfinite(values.gain) || values.gain < 0.0f || values.gain > 4.0f))
        return "Bus gain must be between 0 and 4.";
    if (setGain && parameterAutomated(buses[static_cast<size_t>(index)].automation, "volume"))
        return automatedMessage("Bus volume");
    if (setOutput) {
        const auto error = checkBusOutput(buses, id, values.output);
        if (!error.empty())
            return error;
    }
    auto& bus = buses[static_cast<size_t>(index)];
    if (setGain)
        bus.gain = values.gain;
    if (setMute)
        bus.mute = values.mute;
    if (setSolo)
        bus.solo = values.solo;
    if (setOutput)
        bus.output = values.output;
    return {};
}

std::string Session::setTrackOutput(const std::string& trackId, const std::string& output) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    const auto error = checkTrackOutput(buses, output);
    if (!error.empty())
        return error;
    tracks[static_cast<size_t>(index)].output = output;
    return {};
}

std::string Session::setSend(const std::string& trackId, const std::string& busId, const float* level, const bool* preFader) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    const auto error = checkSend(buses, busId);
    if (!error.empty())
        return error;
    if (level != nullptr && (!std::isfinite(*level) || *level < 0.0f || *level > 4.0f))
        return "Send level must be between 0 and 4.";
    auto& sends = tracks[static_cast<size_t>(index)].sends;
    auto found = std::find_if(sends.begin(), sends.end(), [&](const ProjectSend& send) { return send.bus == busId; });
    if (found == sends.end()) {
        ProjectSend send;
        send.bus = busId;
        sends.push_back(send);
        found = sends.end() - 1;
    }
    if (level != nullptr)
        found->level = *level;
    if (preFader != nullptr)
        found->preFader = *preFader;
    return {};
}

std::string Session::removeSend(const std::string& trackId, const std::string& busId) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    auto& sends = tracks[static_cast<size_t>(index)].sends;
    const auto before = sends.size();
    sends.erase(std::remove_if(sends.begin(), sends.end(), [&](const ProjectSend& send) { return send.bus == busId; }), sends.end());
    if (sends.size() == before)
        return "That track has no send to that bus.";
    return {};
}

void Session::repairRouting(std::vector<std::string>& warnings) {
    repairBuses(buses, warnings);
    for (auto& bus : buses) {
        const auto digits = bus.id.rfind("bus-", 0) == 0 ? bus.id.substr(4) : std::string();
        if (!digits.empty() && digits.size() < 12 && std::all_of(digits.begin(), digits.end(), [](unsigned char c) { return std::isdigit(c) != 0; }))
            nextBusNumber = std::max<int64_t>(nextBusNumber, std::stoll(digits) + 1);
    }
    for (auto& track : tracks) {
        if (!track.used)
            continue;
        const auto label = track.name.empty() ? track.id : track.name;
        if (!checkTrackOutput(buses, track.output).empty()) {
            warnings.push_back("Track " + label + " was routed to a missing or invalid bus (" + track.output + "). It now plays through the master.");
            track.output = kMasterBusId;
        }
        std::vector<ProjectSend> kept;
        for (const auto& send : track.sends) {
            bool duplicate = false;
            for (const auto& other : kept)
                duplicate = duplicate || other.bus == send.bus;
            if (!checkSend(buses, send.bus).empty() || duplicate) {
                warnings.push_back("Track " + label + " had a send to a missing or invalid return bus (" + send.bus + "). The send was removed.");
                continue;
            }
            kept.push_back(send);
        }
        track.sends = std::move(kept);
    }
}

std::vector<RouteTrack> Session::routeTracks() const {
    std::vector<RouteTrack> out;
    out.reserve(tracks.size());
    for (const auto& track : tracks) {
        if (!track.used)
            continue;
        RouteTrack item;
        item.id = track.id;
        if (!track.playLeft.empty() && !track.playRight.empty()) {
            item.left = track.playLeft.data();
            item.right = track.playRight.data();
            item.length = static_cast<int64_t>(track.playLeft.size());
        }
        item.gain = track.gain;
        item.pan = track.pan;
        item.mute = track.mute;
        item.solo = track.solo;
        item.output = track.output;
        item.sends = track.sends;
        item.effects = track.effects;
        item.automation = track.automation;
        item.armed = track.armed;
        item.recordInput = track.recordInput;
        item.processInput = track.armed && track.recordMode != RecordMode::dry;
        item.monitorInput = track.armed && track.monitorInput;
        out.push_back(std::move(item));
    }
    return out;
}

MixPlan Session::buildPlan(const MixPlan* previous) const {
    auto plan = buildMixPlan(routeTracks(), buses, playbackRate, previous, &masterEffects, &masterAutomation);
    applyRenderTail(plan, renderTail);
    return plan;
}

std::vector<AutomationLane>* Session::lanesFor(const std::string& target, const std::string& ownerId) {
    if (target == "master")
        return &masterAutomation;
    if (target == "track") {
        const int index = indexOf(ownerId);
        return index < 0 ? nullptr : &tracks[static_cast<size_t>(index)].automation;
    }
    if (target == "bus") {
        const int index = busIndexOf(ownerId);
        return index < 0 ? nullptr : &buses[static_cast<size_t>(index)].automation;
    }
    return nullptr;
}

std::string Session::checkAutomation(const std::string& target, const std::string& ownerId, const std::string& param,
                                     float& minimum, float& maximum) {
    auto* lanes = lanesFor(target, ownerId);
    auto* chain = chainFor(target, ownerId);
    if (lanes == nullptr || chain == nullptr)
        return target == "track" || target == "bus" || target == "master"
            ? "No " + target + " exists with that id."
            : "Automation target must be track, bus, or master.";
    if (!automationRange(target, param, *chain, minimum, maximum))
        return "That parameter cannot be automated here. Tracks automate volume and pan, buses and the master automate volume, "
               "and any track, bus or master can automate a continuous parameter of its own effects as fx:<effectId>:<parameter>.";
    return {};
}

std::string Session::setAutomation(const std::string& target, const std::string& ownerId, const std::string& param,
                                   const bool* enabled, const std::vector<AutomationPoint>* points) {
    float minimum = 0.0f;
    float maximum = 0.0f;
    const auto error = checkAutomation(target, ownerId, param, minimum, maximum);
    if (!error.empty())
        return error;
    std::vector<AutomationPoint> sorted;
    if (points != nullptr) {
        if (points->size() > static_cast<size_t>(kMaxAutomationPoints))
            return "An automation lane can hold at most " + std::to_string(kMaxAutomationPoints) + " points.";
        for (const auto& point : *points) {
            const auto pointError = checkPoint(point, minimum, maximum);
            if (!pointError.empty())
                return pointError;
        }
        sorted = *points;
        sortPoints(sorted);
    }
    auto& lanes = *lanesFor(target, ownerId);
    auto* lane = findAutomationLane(lanes, param);
    if (lane == nullptr) {
        lanes.push_back(AutomationLane {});
        lane = &lanes.back();
        lane->param = param;
    }
    if (enabled != nullptr)
        lane->enabled = *enabled;
    if (points != nullptr)
        lane->points = std::move(sorted);
    return {};
}

std::string Session::removeAutomation(const std::string& target, const std::string& ownerId, const std::string& param) {
    float minimum = 0.0f;
    float maximum = 0.0f;
    auto* lanes = lanesFor(target, ownerId);
    if (lanes == nullptr)
        return checkAutomation(target, ownerId, param, minimum, maximum);
    const auto before = lanes->size();
    lanes->erase(std::remove_if(lanes->begin(), lanes->end(), [&](const AutomationLane& lane) { return lane.param == param; }), lanes->end());
    if (lanes->size() == before)
        return "That parameter has no automation lane.";
    return {};
}

std::string Session::addAutomationPoint(const std::string& target, const std::string& ownerId, const std::string& param,
                                        const AutomationPoint& point, int& index) {
    float minimum = 0.0f;
    float maximum = 0.0f;
    auto error = checkAutomation(target, ownerId, param, minimum, maximum);
    if (error.empty())
        error = checkPoint(point, minimum, maximum);
    if (!error.empty())
        return error;
    auto& lanes = *lanesFor(target, ownerId);
    auto* lane = findAutomationLane(lanes, param);
    if (lane == nullptr) {
        lanes.push_back(AutomationLane {});
        lane = &lanes.back();
        lane->param = param;
    }
    if (lane->points.size() >= static_cast<size_t>(kMaxAutomationPoints))
        return "An automation lane can hold at most " + std::to_string(kMaxAutomationPoints) + " points.";
    index = automationInsertIndex(lane->points, point.time);
    lane->points.insert(lane->points.begin() + index, point);
    return {};
}

std::string Session::moveAutomationPoint(const std::string& target, const std::string& ownerId, const std::string& param,
                                         int index, int64_t time, double value, const bool* step, int& newIndex) {
    float minimum = 0.0f;
    float maximum = 0.0f;
    const auto error = checkAutomation(target, ownerId, param, minimum, maximum);
    if (!error.empty())
        return error;
    auto* lane = findAutomationLane(*lanesFor(target, ownerId), param);
    if (lane == nullptr)
        return "That parameter has no automation lane.";
    if (index < 0 || index >= static_cast<int>(lane->points.size()))
        return "That automation point does not exist.";
    AutomationPoint moved = lane->points[static_cast<size_t>(index)];
    moved.time = time;
    moved.value = value;
    if (step != nullptr)
        moved.step = *step;
    const auto pointError = checkPoint(moved, minimum, maximum);
    if (!pointError.empty())
        return pointError;
    lane->points.erase(lane->points.begin() + index);
    newIndex = automationInsertIndex(lane->points, moved.time);
    lane->points.insert(lane->points.begin() + newIndex, moved);
    return {};
}

std::string Session::deleteAutomationPoint(const std::string& target, const std::string& ownerId, const std::string& param, int index) {
    float minimum = 0.0f;
    float maximum = 0.0f;
    const auto error = checkAutomation(target, ownerId, param, minimum, maximum);
    if (!error.empty())
        return error;
    auto* lane = findAutomationLane(*lanesFor(target, ownerId), param);
    if (lane == nullptr)
        return "That parameter has no automation lane.";
    if (index < 0 || index >= static_cast<int>(lane->points.size()))
        return "That automation point does not exist.";
    lane->points.erase(lane->points.begin() + index);
    return {};
}

void Session::repairAutomation(std::vector<std::string>& warnings) {
    auto repair = [&](std::vector<AutomationLane>& lanes, const std::string& kind, const std::vector<ProjectEffect>& effects, const std::string& owner) {
        std::vector<AutomationLane> kept;
        for (auto& lane : lanes) {
            float minimum = 0.0f;
            float maximum = 0.0f;
            if (!automationRange(kind, lane.param, effects, minimum, maximum)) {
                warnings.push_back(owner + " had automation for " + lane.param + ", which it cannot automate. The lane was removed.");
                continue;
            }
            if (findAutomationLane(kept, lane.param) != nullptr) {
                warnings.push_back(owner + " had two automation lanes for " + lane.param + ". The second was removed.");
                continue;
            }
            bool changed = false;
            std::vector<AutomationPoint> points;
            for (auto point : lane.points) {
                if (point.time < 0 || !std::isfinite(point.value)) {
                    changed = true;
                    continue;
                }
                const double limited = std::clamp(point.value, static_cast<double>(minimum), static_cast<double>(maximum));
                changed = changed || limited != point.value;
                point.value = limited;
                points.push_back(point);
            }
            if (points.size() > static_cast<size_t>(kMaxAutomationPoints)) {
                points.resize(static_cast<size_t>(kMaxAutomationPoints));
                changed = true;
            }
            sortPoints(points);
            if (changed)
                warnings.push_back(owner + " automation for " + lane.param + " had invalid points. They were limited or removed.");
            lane.points = std::move(points);
            kept.push_back(lane);
        }
        lanes = std::move(kept);
    };
    repair(masterAutomation, "master", masterEffects, "The master bus");
    for (auto& track : tracks) {
        if (track.used)
            repair(track.automation, "track", track.effects, "Track " + (track.name.empty() ? track.id : track.name));
    }
    for (auto& bus : buses)
        repair(bus.automation, "bus", bus.effects, "Bus " + bus.name);
}

std::string Session::setTrackRecord(const std::string& trackId, const bool* armed, const RecordInput* input,
                                    const RecordMode* mode, const bool* monitorInput) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    if (armed != nullptr)
        track.armed = *armed;
    if (input != nullptr)
        track.recordInput = *input;
    if (mode != nullptr)
        track.recordMode = *mode;
    if (monitorInput != nullptr)
        track.monitorInput = *monitorInput;
    return {};
}

std::vector<ProjectEffect>* Session::chainFor(const std::string& target, const std::string& ownerId) {
    if (target == "master")
        return &masterEffects;
    if (target == "track") {
        const int index = indexOf(ownerId);
        return index < 0 ? nullptr : &tracks[static_cast<size_t>(index)].effects;
    }
    if (target == "bus") {
        const int index = busIndexOf(ownerId);
        return index < 0 ? nullptr : &buses[static_cast<size_t>(index)].effects;
    }
    return nullptr;
}

Session::EffectLocation Session::findEffect(const std::string& id) {
    auto search = [&](std::vector<ProjectEffect>& chain) {
        for (size_t i = 0; i < chain.size(); ++i) {
            if (chain[i].id == id)
                return EffectLocation { &chain, static_cast<int>(i) };
        }
        return EffectLocation {};
    };
    auto found = search(masterEffects);
    for (auto& track : tracks) {
        if (found.chain == nullptr && track.used)
            found = search(track.effects);
    }
    for (auto& bus : buses) {
        if (found.chain == nullptr)
            found = search(bus.effects);
    }
    return found;
}

std::string Session::freshEffectId() {
    std::string id;
    do {
        id = "fx-" + std::to_string(nextEffectNumber++);
    } while (findEffect(id).chain != nullptr);
    return id;
}

std::string Session::addEffect(const std::string& target, const std::string& ownerId, EffectType type, int index, std::string& createdId) {
    auto* chain = chainFor(target, ownerId);
    if (chain == nullptr)
        return target == "track" || target == "bus" || target == "master"
            ? "No " + target + " exists with that id."
            : "Effect target must be track, bus, or master.";
    if (static_cast<int>(chain->size()) >= kMaxEffectsPerChain)
        return "A chain can hold at most " + std::to_string(kMaxEffectsPerChain) + " effects.";
    const int at = index < 0 || index > static_cast<int>(chain->size()) ? static_cast<int>(chain->size()) : index;
    auto effect = makeEffect(type, freshEffectId());
    createdId = effect.id;
    chain->insert(chain->begin() + at, effect);
    return {};
}

std::vector<AutomationLane>* Session::lanesForChain(const std::vector<ProjectEffect>* chain) {
    if (chain == &masterEffects)
        return &masterAutomation;
    for (auto& track : tracks) {
        if (track.used && chain == &track.effects)
            return &track.automation;
    }
    for (auto& bus : buses) {
        if (chain == &bus.effects)
            return &bus.automation;
    }
    return nullptr;
}

std::string Session::removeEffect(const std::string& id) {
    const auto found = findEffect(id);
    if (found.chain == nullptr)
        return "No effect exists with that id.";
    if (auto* lanes = lanesForChain(found.chain)) {
        const auto prefix = "fx:" + id + ":";
        lanes->erase(std::remove_if(lanes->begin(), lanes->end(), [&](const AutomationLane& lane) { return lane.param.rfind(prefix, 0) == 0; }),
                     lanes->end());
    }
    found.chain->erase(found.chain->begin() + found.index);
    return {};
}

std::string Session::setEffect(const std::string& id, const bool* enabled, const std::vector<std::pair<std::string, float>>& params) {
    const auto found = findEffect(id);
    if (found.chain == nullptr)
        return "No effect exists with that id.";
    auto& effect = (*found.chain)[static_cast<size_t>(found.index)];
    auto values = effect.params;
    const auto& spec = effectSpec(effect.type);
    const auto* lanes = lanesForChain(found.chain);
    for (const auto& [name, value] : params) {
        const int index = effectParamIndex(effect.type, name);
        if (index < 0)
            return std::string("The ") + spec.name + " effect has no parameter named " + name + ".";
        if (lanes != nullptr && parameterAutomated(*lanes, effectAutomationParam(id, name)))
            return automatedMessage(std::string("Effect parameter ") + name);
        const auto& p = spec.params[index];
        if (!std::isfinite(value) || value < p.minimum || value > p.maximum) {
            char range[96];
            std::snprintf(range, sizeof(range), "%g to %g", static_cast<double>(p.minimum), static_cast<double>(p.maximum));
            return std::string("Effect parameter ") + name + " must be between " + range + ".";
        }
        if (p.choice && value != std::round(value))
            return std::string("Effect parameter ") + name + " must be a whole number.";
        values[static_cast<size_t>(index)] = value;
    }
    effect.params = values;
    if (enabled != nullptr)
        effect.enabled = *enabled;
    return {};
}

std::string Session::moveEffect(const std::string& id, int index) {
    const auto found = findEffect(id);
    if (found.chain == nullptr)
        return "No effect exists with that id.";
    auto& chain = *found.chain;
    if (index < 0 || index >= static_cast<int>(chain.size()))
        return "Effect position must be between 0 and " + std::to_string(chain.size() - 1) + ".";
    auto effect = chain[static_cast<size_t>(found.index)];
    chain.erase(chain.begin() + found.index);
    chain.insert(chain.begin() + index, effect);
    return {};
}

void Session::repairEffects(std::vector<std::string>& warnings) {
    std::vector<std::string> seen;
    auto numbered = [&](const std::string& id) {
        const auto digits = id.rfind("fx-", 0) == 0 ? id.substr(3) : std::string();
        if (!digits.empty() && digits.size() < 12 && std::all_of(digits.begin(), digits.end(), [](unsigned char c) { return std::isdigit(c) != 0; }))
            nextEffectNumber = std::max<int64_t>(nextEffectNumber, std::stoll(digits) + 1);
    };
    auto visit = [&](std::vector<ProjectEffect>& chain, const std::string& owner) {
        if (static_cast<int>(chain.size()) > kMaxEffectsPerChain) {
            chain.resize(static_cast<size_t>(kMaxEffectsPerChain));
            warnings.push_back(owner + " had more than " + std::to_string(kMaxEffectsPerChain) + " effects. The extra effects were removed.");
        }
        for (auto& effect : chain) {
            if (!sanitizeEffectParams(effect.type, effect.params).empty())
                warnings.push_back(owner + " effect " + effectTypeName(effect.type) + " had values outside the allowed range. They were limited.");
            numbered(effect.id);
        }
    };
    visit(masterEffects, "The master bus");
    for (auto& track : tracks) {
        if (track.used)
            visit(track.effects, "Track " + (track.name.empty() ? track.id : track.name));
    }
    for (auto& bus : buses)
        visit(bus.effects, "Bus " + bus.name);
    // Give every effect a unique id; a missing or repeated id gets a fresh one.
    auto assign = [&](std::vector<ProjectEffect>& chain) {
        for (auto& effect : chain) {
            const bool repeated = std::find(seen.begin(), seen.end(), effect.id) != seen.end();
            if (effect.id.empty() || repeated) {
                if (repeated)
                    warnings.push_back("Effect id " + effect.id + " was used more than once. The copy was given a new id.");
                std::string id;
                do {
                    id = "fx-" + std::to_string(nextEffectNumber++);
                } while (std::find(seen.begin(), seen.end(), id) != seen.end());
                effect.id = id;
            }
            seen.push_back(effect.id);
        }
    };
    assign(masterEffects);
    for (auto& track : tracks) {
        if (track.used)
            assign(track.effects);
    }
    for (auto& bus : buses)
        assign(bus.effects);
}

int Session::claimTrack(const std::string& id) {
    const int existing = indexOf(id);
    if (existing >= 0)
        return existing;
    tracks.push_back(Track {});
    tracks.back().used = true;
    tracks.back().id = id;
    return static_cast<int>(tracks.size()) - 1;
}

bool Session::trackNameTaken(const std::string& name, int skipIndex) const {
    const auto lower = [](const std::string& text) {
        std::string out = text;
        std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) {
            return static_cast<char>(c < 128 ? std::tolower(c) : c);
        });
        return out;
    };
    const auto wanted = lower(name);
    for (int i = 0; i < static_cast<int>(tracks.size()); ++i) {
        const auto& track = tracks[static_cast<size_t>(i)];
        if (i != skipIndex && track.used && !track.name.empty() && lower(track.name) == wanted)
            return true;
    }
    return false;
}

std::string Session::uniqueTrackName(const std::string& base, int skipIndex) const {
    if (!trackNameTaken(base, skipIndex))
        return base;
    for (int number = 2;; ++number) {
        const auto candidate = base + " " + std::to_string(number);
        if (!trackNameTaken(candidate, skipIndex))
            return candidate;
    }
}

std::string Session::autoTrackName(int preferredNumber, int skipIndex) const {
    for (int number = std::max(1, preferredNumber);; ++number) {
        const auto candidate = "Track " + std::to_string(number);
        if (!trackNameTaken(candidate, skipIndex))
            return candidate;
    }
}

std::string Session::freshTrackId() {
    while (true) {
        const auto id = "track-" + std::to_string(nextTrackNumber++);
        if (indexOf(id) < 0)
            return id;
    }
}

int64_t Session::timeline() const {
    int64_t length = 0;
    for (const auto& track : tracks) {
        if (track.used)
            length = std::max<int64_t>(length, static_cast<int64_t>(track.playLeft.size()));
    }
    return length;
}

RetiredAudio Session::importFile(const std::string& id, const std::string& path) {
    RetiredAudio retired;
    if (id.empty() || id.size() > 64) {
        retired.error = "Track id must be 1 to 64 characters.";
        return retired;
    }
    auto decoded = readWavFile(path);
    if (!decoded.error.empty()) {
        retired.error = decoded.error;
        return retired;
    }
    auto playback = resampleStereo(decoded.left.data(),
                                   decoded.right.data(),
                                   static_cast<int64_t>(decoded.left.size()),
                                   decoded.sampleRate,
                                   playbackRate);
    if (!playback.error.empty()) {
        retired.error = playback.error;
        return retired;
    }

    const int index = claimTrack(id);
    auto& track = tracks[static_cast<size_t>(index)];
    takeOld(track, retired);
    const float gain = track.used ? track.gain : 1.0f;
    const float pan = track.used ? track.pan : 0.0f;
    const bool mute = track.used ? track.mute : false;
    const bool solo = track.used ? track.solo : false;
    const auto name = track.used && !track.name.empty() ? track.name : autoTrackName(index + 1, index);
    auto output = track.output;
    auto sends = track.sends;
    auto effects = track.effects;
    auto automation = track.automation;
    const bool armed = track.armed;
    const auto recordInput = track.recordInput;
    const auto recordMode = track.recordMode;
    const bool monitorInput = track.monitorInput;
    track = Track {};
    track.used = true;
    track.id = id;
    track.name = name;
    track.path = path;
    track.sourceSampleRate = decoded.sampleRate;
    track.sourceChannels = decoded.sourceChannels;
    track.sourceLeft = std::move(decoded.left);
    track.sourceRight = std::move(decoded.right);
    track.sourcePlayLeft = std::move(playback.left);
    track.sourcePlayRight = std::move(playback.right);
    track.gain = gain;
    track.pan = pan;
    track.mute = mute;
    track.solo = solo;
    track.output = std::move(output);
    track.sends = std::move(sends);
    track.effects = std::move(effects);
    track.automation = std::move(automation);
    track.armed = armed;
    track.recordInput = recordInput;
    track.recordMode = recordMode;
    track.monitorInput = monitorInput;
    Clip clip;
    clip.id = freshClipId();
    clip.sourceFileId = primarySourceId(track);
    clip.duration = static_cast<int64_t>(track.sourcePlayLeft.size());
    track.clips = { clip };
    arrangeInto(track);
    retired.index = index;
    return retired;
}

RetiredAudio Session::addTrack(const std::string& name) {
    RetiredAudio retired;
    if (name.size() > 64) {
        retired.error = "Track name must be 64 characters or fewer.";
        return retired;
    }
    Track track;
    track.used = true;
    track.id = freshTrackId();
    track.name = name.empty() ? autoTrackName(static_cast<int>(tracks.size()) + 1, -1) : name;
    tracks.push_back(std::move(track));
    retired.index = static_cast<int>(tracks.size()) - 1;
    return retired;
}

RetiredAudio Session::removeTrack(const std::string& id) {
    RetiredAudio retired;
    const int index = indexOf(id);
    if (index < 0) {
        retired.error = "No track is loaded with that id.";
        return retired;
    }
    takeOld(tracks[static_cast<size_t>(index)], retired);
    tracks.erase(tracks.begin() + index);
    return retired;
}

std::string Session::renameTrack(const std::string& id, const std::string& name) {
    const int index = indexOf(id);
    if (index < 0)
        return "No track is loaded with that id.";
    if (name.empty() || name.size() > 64)
        return "Track name must be 1 to 64 characters.";
    tracks[static_cast<size_t>(index)].name = name;
    return {};
}

RetiredAudio Session::duplicateTrack(const std::string& id) {
    RetiredAudio retired;
    const int index = indexOf(id);
    if (index < 0) {
        retired.error = "No track is loaded with that id.";
        return retired;
    }
    Track copy = tracks[static_cast<size_t>(index)];
    const std::string oldPrimary = primarySourceId(tracks[static_cast<size_t>(index)]);
    copy.id = freshTrackId();
    copy.name = tracks[static_cast<size_t>(index)].name.empty()
        ? autoTrackName(index + 2, -1)
        : uniqueTrackName(tracks[static_cast<size_t>(index)].name + " copy", -1);
    const std::string newPrimary = primarySourceId(copy);
    for (auto& extra : copy.extras) {
        const std::string oldId = extra.id;
        extra.id = freshClipId() + "-src";
        for (auto& clip : copy.clips) {
            if (clip.sourceFileId == oldId)
                clip.sourceFileId = extra.id;
        }
    }
    for (auto& clip : copy.clips) {
        if (clip.sourceFileId == oldPrimary)
            clip.sourceFileId = newPrimary;
        clip.id = freshClipId();
    }
    for (auto& effect : copy.effects) {
        const auto oldId = effect.id;
        effect.id = freshEffectId();
        for (auto& lane : copy.automation) {
            std::string laneEffect;
            std::string name;
            if (parseEffectAutomationParam(lane.param, laneEffect, name) && laneEffect == oldId)
                lane.param = effectAutomationParam(effect.id, name);
        }
    }
    copy.armed = false;
    copy.monitorInput = false;
    tracks.insert(tracks.begin() + index + 1, std::move(copy));
    retired.index = index + 1;
    return retired;
}

RetiredAudio Session::clearTrack(const std::string& id) {
    return removeTrack(id);
}

RetiredAudio Session::setPlaybackRate(double sampleRate) {
    RetiredAudio retired;
    if (!(sampleRate >= 8000.0 && sampleRate <= 192000.0)) {
        retired.error = "Playback sample rate must be between 8000 and 192000 Hz.";
        return retired;
    }
    const double previousRate = playbackRate;
    playbackRate = sampleRate;
    scaleAutomation(masterAutomation, previousRate, playbackRate);
    for (auto& bus : buses)
        scaleAutomation(bus.automation, previousRate, playbackRate);
    for (auto& track : tracks) {
        if (track.used)
            scaleAutomation(track.automation, previousRate, playbackRate);
    }
    for (auto& track : tracks) {
        if (!track.used)
            continue;
        if (track.missing || track.sourceLeft.empty() || track.sourceSampleRate <= 0.0) {
            for (auto& clip : track.clips) {
                clip.timelineStart = scaleSamples(clip.timelineStart, previousRate, playbackRate);
                clip.sourceOffset = scaleSamples(clip.sourceOffset, previousRate, playbackRate);
                clip.duration = std::max<int64_t>(1, scaleSamples(clip.duration, previousRate, playbackRate));
                clip.fadeIn = scaleSamples(clip.fadeIn, previousRate, playbackRate);
                clip.fadeOut = scaleSamples(clip.fadeOut, previousRate, playbackRate);
                clip.crossfadeDuration = scaleSamples(clip.crossfadeDuration, previousRate, playbackRate);
                clip.originalSourceOffset = scaleSamples(clip.originalSourceOffset, previousRate, playbackRate);
            }
            arrangeInto(track);
            continue;
        }
        auto playback = resampleStereo(track.sourceLeft.data(),
                                       track.sourceRight.data(),
                                       static_cast<int64_t>(track.sourceLeft.size()),
                                       track.sourceSampleRate,
                                       playbackRate);
        if (!playback.error.empty()) {
            retired.error = playback.error;
            return retired;
        }
        takeOld(track, retired);
        track.sourcePlayLeft = std::move(playback.left);
        track.sourcePlayRight = std::move(playback.right);
        for (auto& extra : track.extras) {
            auto extraPlay = resampleStereo(extra.originalLeft.data(),
                                            extra.originalRight.data(),
                                            static_cast<int64_t>(extra.originalLeft.size()),
                                            extra.sampleRate,
                                            playbackRate);
            if (!extraPlay.error.empty()) {
                retired.error = extraPlay.error;
                return retired;
            }
            extra.playLeft = std::move(extraPlay.left);
            extra.playRight = std::move(extraPlay.right);
        }
        for (auto& clip : track.clips) {
            clip.timelineStart = scaleSamples(clip.timelineStart, previousRate, playbackRate);
            clip.sourceOffset = scaleSamples(clip.sourceOffset, previousRate, playbackRate);
            clip.duration = scaleSamples(clip.duration, previousRate, playbackRate);
            clip.fadeIn = scaleSamples(clip.fadeIn, previousRate, playbackRate);
            clip.fadeOut = scaleSamples(clip.fadeOut, previousRate, playbackRate);
            clip.crossfadeDuration = scaleSamples(clip.crossfadeDuration, previousRate, playbackRate);
            clip.originalSourceOffset = scaleSamples(clip.originalSourceOffset, previousRate, playbackRate);
            const auto limit = sourceLength(track, clip.sourceFileId);
            if (limit >= 0 && clip.sourceOffset + clip.duration > limit)
                clip.duration = std::max<int64_t>(1, limit - clip.sourceOffset);
        }
        arrangeInto(track);
    }
    return retired;
}

std::string Session::setTrack(const std::string& id,
                              const ProjectTrack& values,
                              bool setGain,
                              bool setPan,
                              bool setMute,
                              bool setSolo) {
    const int index = indexOf(id);
    if (index < 0)
        return "No track is loaded with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    if (setGain && parameterAutomated(track.automation, "volume"))
        return automatedMessage("Track volume");
    if (setPan && parameterAutomated(track.automation, "pan"))
        return automatedMessage("Track pan");
    if (setGain) {
        if (!std::isfinite(values.gain) || values.gain < 0.0f || values.gain > 4.0f)
            return "Gain must be between 0 and 4.";
        track.gain = values.gain;
    }
    if (setPan) {
        if (!std::isfinite(values.pan) || values.pan < -1.0f || values.pan > 1.0f)
            return "Pan must be between -1 and 1.";
        track.pan = values.pan;
    }
    if (setMute)
        track.mute = values.mute;
    if (setSolo)
        track.solo = values.solo;
    return {};
}

void Session::render(float* outL, float* outR, int numSamples, const float* micL, const float* micR) {
    const auto plan = buildPlan(nullptr);
    MixState state;
    prepareMixState(plan, state);
    const auto mixed = mixRoute(plan, state, masterGain, clock, timeline(), outL, outR, numSamples, micL, micR, monitor);
    clock = mixed.clock;
    lastPeakL = mixed.peakL;
    lastPeakR = mixed.peakR;
}

std::string Session::exportMix(const std::string& path, double sampleRate, const TailSettings* tail,
                               int64_t* frames, int64_t* timelineFrames) const {
    if (!(sampleRate >= 8000.0 && sampleRate <= 192000.0))
        return "Export sample rate must be between 8000 and 192000 Hz.";
    const TailSettings tailSettings = tail != nullptr ? *tail : renderTail;
    const auto tailError = checkTailSettings(tailSettings);
    if (!tailError.empty())
        return tailError;

    struct RenderTrack {
        std::vector<float> left;
        std::vector<float> right;
        RouteTrack view;
    };
    std::vector<RenderTrack> renderTracks;
    int64_t timeline = 0;
    for (const auto& track : tracks) {
        if (!track.used)
            continue;
        std::vector<SourceSpan> spans;
        std::vector<std::vector<float>> ownedLeft;
        std::vector<std::vector<float>> ownedRight;
        ownedLeft.reserve(8);
        ownedRight.reserve(8);
        spans.reserve(8);
        auto addOwned = [&](const std::string& sourceId, const std::vector<float>& originalLeft, const std::vector<float>& originalRight, double sourceRate, bool missing) -> std::string {
            if (missing || originalLeft.empty() || sourceRate <= 0.0) {
                ownedLeft.emplace_back();
                ownedRight.emplace_back();
                SourceSpan span;
                span.id = sourceId;
                span.missing = true;
                spans.push_back(span);
                return {};
            }
            auto playback = resampleStereo(originalLeft.data(),
                                           originalRight.data(),
                                           static_cast<int64_t>(originalLeft.size()),
                                           sourceRate > 0.0 ? sourceRate : sampleRate,
                                           sampleRate);
            if (!playback.error.empty())
                return playback.error;
            ownedLeft.push_back(std::move(playback.left));
            ownedRight.push_back(std::move(playback.right));
            SourceSpan span;
            span.id = sourceId;
            span.missing = missing || originalLeft.empty();
            span.left = ownedLeft.back().data();
            span.right = ownedRight.back().data();
            span.length = static_cast<int64_t>(ownedLeft.back().size());
            spans.push_back(span);
            return {};
        };
        auto sourceError = addOwned(primarySourceId(track), track.sourceLeft, track.sourceRight, track.sourceSampleRate, track.missing);
        if (!sourceError.empty())
            return sourceError;
        for (const auto& extra : track.extras) {
            sourceError = addOwned(extra.id, extra.originalLeft, extra.originalRight, extra.sampleRate, extra.missing);
            if (!sourceError.empty())
                return sourceError;
        }
        std::vector<Clip> exportClips = track.clips;
        if (exportClips.empty() && !ownedLeft.empty()) {
            Clip whole;
            whole.id = track.id + "-whole";
            whole.sourceFileId = primarySourceId(track);
            whole.duration = static_cast<int64_t>(ownedLeft.front().size());
            exportClips = { whole };
        }
        for (auto& clip : exportClips) {
            clip.timelineStart = scaleSamples(clip.timelineStart, playbackRate, sampleRate);
            clip.sourceOffset = scaleSamples(clip.sourceOffset, playbackRate, sampleRate);
            clip.duration = scaleSamples(clip.duration, playbackRate, sampleRate);
            clip.fadeIn = scaleSamples(clip.fadeIn, playbackRate, sampleRate);
            clip.fadeOut = scaleSamples(clip.fadeOut, playbackRate, sampleRate);
        }
        std::vector<float> arrangedLeft;
        std::vector<float> arrangedRight;
        renderArrangement(exportClips, spans, arrangedLeft, arrangedRight);
        RenderTrack item;
        item.left = std::move(arrangedLeft);
        item.right = std::move(arrangedRight);
        item.view.id = track.id;
        item.view.length = static_cast<int64_t>(item.left.size());
        item.view.gain = track.gain;
        item.view.pan = track.pan;
        item.view.mute = track.mute;
        item.view.solo = track.solo;
        item.view.output = track.output;
        item.view.sends = track.sends;
        item.view.effects = track.effects;
        item.view.automation = track.automation;
        scaleAutomation(item.view.automation, playbackRate, sampleRate);
        timeline = std::max(timeline, item.view.length);
        renderTracks.push_back(std::move(item));
    }
    std::vector<RouteTrack> views;
    views.reserve(renderTracks.size());
    for (auto& item : renderTracks) {
        item.view.left = item.left.empty() ? nullptr : item.left.data();
        item.view.right = item.right.empty() ? nullptr : item.right.data();
        views.push_back(item.view);
    }
    auto exportBuses = buses;
    for (auto& bus : exportBuses)
        scaleAutomation(bus.automation, playbackRate, sampleRate);
    auto exportMaster = masterAutomation;
    scaleAutomation(exportMaster, playbackRate, sampleRate);
    auto plan = buildMixPlan(views, exportBuses, sampleRate, nullptr, &masterEffects, &exportMaster);
    applyRenderTail(plan, tailSettings);
    MixState state;
    prepareMixState(plan, state);

    const int64_t capacity = timeline > 0 ? timeline + plan.tailMax : 0;
    std::vector<float> outL(static_cast<size_t>(capacity), 0.0f);
    std::vector<float> outR(outL.size(), 0.0f);
    Clock cursor;
    cursor.mode = timeline > 0 ? TransportMode::playing : TransportMode::stopped;

    int64_t done = 0;
    int64_t length = std::max<int64_t>(timeline, 0);
    while (done < capacity) {
        const int n = static_cast<int>(std::min<int64_t>(1024, capacity - done));
        const auto mixed = mixRoute(plan,
                                    state,
                                    masterGain,
                                    cursor,
                                    timeline,
                                    outL.data() + done,
                                    outR.data() + done,
                                    n,
                                    nullptr,
                                    nullptr,
                                    false);
        cursor = mixed.clock;
        done += n;
        if (mixed.end >= 0)
            length = std::clamp<int64_t>(mixed.end, std::max<int64_t>(timeline, 0), capacity);
        if (cursor.mode != TransportMode::playing)
            break;
    }
    if (frames != nullptr)
        *frames = length;
    if (timelineFrames != nullptr)
        *timelineFrames = std::max<int64_t>(timeline, 0);
    return writeWavFile(path, sampleRate, outL.data(), outR.data(), length, 24);
}

ProjectData Session::toProject(const std::string& outputDevice,
                               const std::string& inputDevice,
                               int bufferSize) const {
    ProjectData project;
    project.version = kCurrentProjectVersion;
    project.masterGain = masterGain;
    project.buses = buses;
    project.masterEffects = masterEffects;
    project.masterAutomation = masterAutomation;
    project.renderTail = renderTail;
    project.pitchMapping = pitchMapping;
    project.customVocalPresets = customVocalPresets;
    project.monitorEnabled = monitor;
    project.sampleRate = playbackRate;
    project.bufferSize = bufferSize;
    project.outputDevice = outputDevice;
    project.inputDevice = inputDevice;
    project.projectId = projectId.empty() ? makeProjectId() : projectId;
    project.projectName = projectName.empty() ? "Untitled" : projectName;
    for (const auto& track : tracks) {
        if (!track.used)
            continue;
        ProjectTrack item;
        item.id = track.id;
        item.name = track.name.empty() ? track.id : track.name;
        item.path = track.path;
        item.gain = track.gain;
        item.pan = track.pan;
        item.mute = track.mute;
        item.solo = track.solo;
        item.output = track.output;
        item.sends = track.sends;
        item.effects = track.effects;
        item.automation = track.automation;
        item.vocalPresetId = track.vocalPresetId;
        item.vocalPresetBypassed = track.vocalPresetBypassed;
        item.vocalPresetPrevious = track.vocalPresetPrevious;
        item.armed = track.armed;
        item.recordInput = track.recordInput;
        item.recordMode = track.recordMode;
        item.monitorInput = track.monitorInput;
        item.takesExpanded = track.takesExpanded;
        item.compCrossfadeMs = playbackRate > 0.0
            ? 1000.0 * static_cast<double>(compCrossfadeSamplesFor(track)) / playbackRate
            : kDefaultCompCrossfadeMs;
        item.autoCrossfadeEnabled = track.autoCrossfadeEnabled;
        item.autoCrossfadeMs = track.autoCrossfadeMs;
        item.autoCrossfadeCurve = fadeCurveName(track.autoCrossfadeCurve);
        for (const auto& take : track.takes) {
            ProjectTake saved;
            saved.id = take.id;
            saved.name = take.name;
            saved.sourceFileId = take.sourceFileId;
            saved.timelineStart = take.timelineStart;
            saved.duration = take.duration;
            saved.muted = take.muted;
            item.takes.push_back(saved);
        }
        item.explicitClips = true;
        for (const auto& clip : track.clips) {
            ProjectClip saved;
            saved.id = clip.id;
            saved.sourceFileId = clip.sourceFileId;
            saved.timelineStart = clip.timelineStart;
            saved.sourceOffset = clip.sourceOffset;
            saved.duration = clip.duration;
            saved.fadeIn = clip.fadeIn;
            saved.fadeOut = clip.fadeOut;
            if (clip.fadeInCurve != FadeCurve::linear)
                saved.fadeInCurve = fadeCurveName(clip.fadeInCurve);
            if (clip.fadeOutCurve != FadeCurve::linear)
                saved.fadeOutCurve = fadeCurveName(clip.fadeOutCurve);
            saved.crossfadePartnerId = clip.crossfadePartnerId;
            if (clip.crossfadeCurve != FadeCurve::linear || !clip.crossfadePartnerId.empty())
                saved.crossfadeCurve = fadeCurveName(clip.crossfadeCurve);
            saved.crossfadeDuration = clip.crossfadeDuration;
            saved.gain = clip.gain;
            saved.originalSourceFileId = clip.originalSourceFileId;
            saved.originalSourceOffset = clip.originalSourceOffset;
            saved.pitchShiftCents = clip.pitchShiftCents;
            saved.pitchLabel = clip.pitchLabel;
            saved.noteTargets = clip.noteTargets;
            saved.timingMarkers = clip.timingMarkers;
            saved.timingOriginalSourceFileId = clip.timingOriginalSourceFileId;
            saved.timingOriginalSourceOffset = clip.timingOriginalSourceOffset;
            saved.timingOriginalDuration = clip.timingOriginalDuration;
            saved.timingLabel = clip.timingLabel;
            saved.breathRegions = clip.breathRegions;
            saved.breathOriginalSourceFileId = clip.breathOriginalSourceFileId;
            saved.breathOriginalSourceOffset = clip.breathOriginalSourceOffset;
            saved.breathOriginalDuration = clip.breathOriginalDuration;
            saved.breathLabel = clip.breathLabel;
            saved.stretchMode = clip.stretchMode;
            saved.stretchRatio = clip.stretchRatio;
            saved.stretchOriginalSourceFileId = clip.stretchOriginalSourceFileId;
            saved.stretchOriginalSourceOffset = clip.stretchOriginalSourceOffset;
            saved.stretchOriginalDuration = clip.stretchOriginalDuration;
            saved.stretchLabel = clip.stretchLabel;
            item.clips.push_back(saved);
        }
        for (const auto& extra : track.extras) {
            if (extra.preview)
                continue;
            ProjectSource saved;
            saved.id = extra.id;
            saved.path = extra.path;
            item.extras.push_back(saved);
        }
        project.tracks.push_back(item);
    }
    return project;
}

std::string Session::freshClipId() {
    return "clip-" + std::to_string(nextClipNumber++);
}

std::string Session::freshTakeId() {
    return "take-" + std::to_string(nextTakeNumber++);
}

const Take* Session::findTake(const Track& track, const std::string& takeId) const {
    for (const auto& take : track.takes)
        if (take.id == takeId)
            return &take;
    return nullptr;
}

Take* Session::findTake(Track& track, const std::string& takeId) {
    for (auto& take : track.takes)
        if (take.id == takeId)
            return &take;
    return nullptr;
}

int64_t Session::compCrossfadeSamplesFor(const Track& track) const {
    if (track.compCrossfadeSamples > 0)
        return track.compCrossfadeSamples;
    if (playbackRate <= 0.0)
        return 0;
    return std::max<int64_t>(0, static_cast<int64_t>(std::llround(playbackRate * kDefaultCompCrossfadeMs / 1000.0)));
}

std::string Session::registerTake(const std::string& trackId, Take take) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    if (take.id.empty())
        take.id = freshTakeId();
    if (findTake(track, take.id) != nullptr)
        return "A take with that id already exists.";
    if (take.sourceFileId.empty())
        return "A take needs a source file id.";
    if (sourceLength(track, take.sourceFileId) <= 0)
        return "The take's audio source is missing or empty.";
    if (take.duration <= 0)
        take.duration = sourceLength(track, take.sourceFileId);
    if (take.name.empty())
        take.name = "Take " + std::to_string(track.takes.size() + 1);
    track.takes.push_back(std::move(take));
    return {};
}

std::string Session::renameTake(const std::string& trackId, const std::string& takeId, const std::string& name) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto* take = findTake(tracks[static_cast<size_t>(index)], takeId);
    if (take == nullptr)
        return "No take exists with that id.";
    const auto trimmed = [&] {
        size_t begin = 0;
        while (begin < name.size() && (name[begin] == ' ' || name[begin] == '\t'))
            ++begin;
        size_t end = name.size();
        while (end > begin && (name[end - 1] == ' ' || name[end - 1] == '\t'))
            --end;
        return name.substr(begin, end - begin);
    }();
    if (trimmed.empty())
        return "A take name cannot be empty.";
    if (trimmed.size() > 64)
        return "A take name cannot be longer than 64 characters.";
    rememberUndo();
    take->name = trimmed;
    return {};
}

std::string Session::setTakeMuted(const std::string& trackId, const std::string& takeId, bool muted) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto* take = findTake(tracks[static_cast<size_t>(index)], takeId);
    if (take == nullptr)
        return "No take exists with that id.";
    rememberUndo();
    take->muted = muted;
    return {};
}

std::string Session::removeTake(const std::string& trackId, const std::string& takeId, RetiredAudio& retired) {
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    const auto* take = findTake(track, takeId);
    if (take == nullptr) {
        retired.error = "No take exists with that id.";
        return retired.error;
    }
    for (const auto& clip : track.clips) {
        if (clip.sourceFileId == take->sourceFileId) {
            retired.error = "Remove or replace the comp regions that use this take before deleting it.";
            return retired.error;
        }
    }
    rememberUndo();
    track.takes.erase(std::remove_if(track.takes.begin(), track.takes.end(),
                                     [&](const Take& item) { return item.id == takeId; }),
                      track.takes.end());
    // Source WAV stays on disk and may remain as an extra; take metadata only is removed.
    return {};
}

std::string Session::setTakesExpanded(const std::string& trackId, bool expanded) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    rememberUndo();
    tracks[static_cast<size_t>(index)].takesExpanded = expanded;
    return {};
}

std::string Session::setCompCrossfadeMs(const std::string& trackId, double ms) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    if (!(ms >= 0.0 && ms <= kMaxCompCrossfadeMs) || !std::isfinite(ms))
        return "Comp crossfade must be between 0 and 100 milliseconds.";
    rememberUndo();
    auto& track = tracks[static_cast<size_t>(index)];
    track.compCrossfadeSamples = playbackRate > 0.0
        ? std::max<int64_t>(0, static_cast<int64_t>(std::llround(playbackRate * ms / 1000.0)))
        : 0;
    return {};
}

std::string Session::setCompRegion(const std::string& trackId, const std::string& takeId,
                                   int64_t timelineStart, int64_t timelineEnd, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        const auto* take = findTake(track, takeId);
        if (take == nullptr)
            return std::string("No take exists with that id.");
        return msp::setCompRegion(track.clips, *take, timelineStart, timelineEnd, compCrossfadeSamplesFor(track),
                                  freshClipId(),
                                  [&] { return freshClipId(); },
                                  [&](const std::string& sourceId) { return sourceLength(track, sourceId); });
    }, retired);
}

RetiredAudio Session::importTake(const std::string& trackId, const std::string& path, int64_t timelineStart,
                                 std::string* takeId) {
    RetiredAudio retired;
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired;
    }
    if (timelineStart < 0) {
        retired.error = "A take cannot start before the timeline.";
        return retired;
    }
    auto decoded = readWavFile(path);
    if (!decoded.error.empty()) {
        retired.error = decoded.error;
        return retired;
    }
    auto playback = resampleStereo(decoded.left.data(), decoded.right.data(),
                                   static_cast<int64_t>(decoded.left.size()), decoded.sampleRate, playbackRate);
    if (!playback.error.empty()) {
        retired.error = playback.error;
        return retired;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    rememberUndo();
    std::string sourceId;
    if (track.path.empty() && !track.missing && track.extras.empty() && track.clips.empty() && track.takes.empty()) {
        track.path = path;
        track.sourceSampleRate = decoded.sampleRate;
        track.sourceChannels = decoded.sourceChannels;
        track.sourceLeft = std::move(decoded.left);
        track.sourceRight = std::move(decoded.right);
        track.sourcePlayLeft = std::move(playback.left);
        track.sourcePlayRight = std::move(playback.right);
        track.error.clear();
        sourceId = primarySourceId(track);
    } else {
        sourceId = freshClipId() + "-src";
        Track::ExtraSource extra;
        extra.id = sourceId;
        extra.path = path;
        extra.sampleRate = decoded.sampleRate;
        extra.channels = decoded.sourceChannels;
        extra.originalLeft = std::move(decoded.left);
        extra.originalRight = std::move(decoded.right);
        extra.playLeft = std::move(playback.left);
        extra.playRight = std::move(playback.right);
        track.extras.push_back(std::move(extra));
    }
    Take take;
    take.id = freshTakeId();
    take.name = "Take " + std::to_string(track.takes.size() + 1);
    take.sourceFileId = sourceId;
    take.timelineStart = timelineStart;
    take.duration = sourceLength(track, sourceId);
    track.takes.push_back(take);
    if (takeId != nullptr)
        *takeId = take.id;
    retired = commitTrack(index);
    return retired;
}

std::string Session::primarySourceId(const Track& track) const {
    return track.id + "-src";
}

int64_t Session::sourceLength(const Track& track, const std::string& sourceId) const {
    if (sourceId == primarySourceId(track))
        return track.missing ? -1 : static_cast<int64_t>(track.sourcePlayLeft.size());
    for (const auto& extra : track.extras) {
        if (extra.id == sourceId)
            return extra.missing ? -1 : static_cast<int64_t>(extra.playLeft.size());
    }
    return -1;
}

std::string Session::copyClipMono(const std::string& trackId, const std::string& clipId, double maxSeconds,
                                  std::vector<float>& mono, double& sourceRate, Clip& clip) const {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    const auto& track = tracks[static_cast<size_t>(index)];
    const auto found = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& item) { return item.id == clipId; });
    if (found == track.clips.end())
        return "That clip is not on the track.";
    clip = *found;
    SourceAudio audio;
    const auto sourceError = findSourceAudio(track, clip.sourceFileId, audio);
    if (!sourceError.empty())
        return sourceError;
    if (audio.missing || audio.left->empty() || audio.sampleRate <= 0.0)
        return "The clip's source file is missing, so it cannot be analysed.";
    const std::vector<float>* left = audio.left;
    const std::vector<float>* right = audio.right;
    sourceRate = audio.sampleRate;
    const int64_t length = static_cast<int64_t>(left->size());
    const int64_t start = std::clamp<int64_t>(scaleSamples(clip.sourceOffset, playbackRate, sourceRate), 0, length);
    const int64_t end = std::clamp<int64_t>(scaleSamples(clip.sourceOffset + clip.duration, playbackRate, sourceRate), start, length);
    if (static_cast<double>(end - start) > maxSeconds * sourceRate) {
        char limit[32];
        std::snprintf(limit, sizeof(limit), "%.0f", maxSeconds);
        return std::string("The clip is too long to analyse. The limit is ") + limit + " seconds of audio.";
    }
    mono.resize(static_cast<size_t>(end - start));
    const bool stereo = right->size() == left->size();
    for (int64_t i = start; i < end; ++i) {
        const float l = (*left)[static_cast<size_t>(i)];
        mono[static_cast<size_t>(i - start)] = stereo ? 0.5f * (l + (*right)[static_cast<size_t>(i)]) : l;
    }
    return {};
}

std::vector<SourceSpan> Session::spansFor(const Track& track, double) const {
    std::vector<SourceSpan> spans;
    spans.reserve(1 + track.extras.size());
    SourceSpan primary;
    primary.id = primarySourceId(track);
    primary.left = track.sourcePlayLeft.data();
    primary.right = track.sourcePlayRight.data();
    primary.length = static_cast<int64_t>(track.sourcePlayLeft.size());
    primary.missing = track.missing;
    spans.push_back(primary);
    for (const auto& extra : track.extras) {
        SourceSpan span;
        span.id = extra.id;
        span.left = extra.playLeft.data();
        span.right = extra.playRight.data();
        span.length = static_cast<int64_t>(extra.playLeft.size());
        span.missing = extra.missing;
        spans.push_back(span);
    }
    return spans;
}

std::string Session::findSourceAudio(const Track& track, const std::string& sourceId, SourceAudio& audio) const {
    if (sourceId == primarySourceId(track)) {
        audio.left = &track.sourceLeft;
        audio.right = &track.sourceRight;
        audio.sampleRate = track.sourceSampleRate;
        audio.channels = track.sourceChannels;
        audio.missing = track.missing;
        return {};
    }
    const auto extra = std::find_if(track.extras.begin(), track.extras.end(), [&](const Track::ExtraSource& item) { return item.id == sourceId; });
    if (extra == track.extras.end())
        return "The clip's source audio is not loaded.";
    audio.left = &extra->originalLeft;
    audio.right = &extra->originalRight;
    audio.sampleRate = extra->sampleRate;
    audio.channels = extra->channels;
    audio.missing = extra->missing;
    return {};
}

std::string Session::copyClipRegion(const std::string& trackId, const std::string& clipId, double maxSeconds,
                                    int64_t context, ClipRegion& region) const {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    const auto& track = tracks[static_cast<size_t>(index)];
    const auto found = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& item) { return item.id == clipId; });
    if (found == track.clips.end())
        return "That clip is not on the track.";
    region.clip = *found;
    SourceAudio audio;
    const auto sourceError = findSourceAudio(track, found->sourceFileId, audio);
    if (!sourceError.empty())
        return sourceError;
    if (audio.missing || audio.left->empty() || audio.sampleRate <= 0.0)
        return "The clip's source file is missing, so it cannot be processed.";
    const int64_t length = static_cast<int64_t>(audio.left->size());
    const int64_t start = std::clamp<int64_t>(scaleSamples(found->sourceOffset, playbackRate, audio.sampleRate), 0, length);
    const int64_t end = std::clamp<int64_t>(scaleSamples(found->sourceOffset + found->duration, playbackRate, audio.sampleRate), start, length);
    if (end <= start)
        return "The clip has no audio to process.";
    if (static_cast<double>(end - start) > maxSeconds * audio.sampleRate) {
        char limit[32];
        std::snprintf(limit, sizeof(limit), "%.0f", maxSeconds);
        return std::string("The clip is too long to process. The limit is ") + limit + " seconds of audio.";
    }
    const int64_t from = std::max<int64_t>(0, start - std::max<int64_t>(0, context));
    const int64_t to = std::min<int64_t>(length, end + std::max<int64_t>(0, context));
    const bool stereo = audio.channels >= 2 && audio.right->size() == audio.left->size();
    region.sampleRate = audio.sampleRate;
    region.channels = stereo ? 2 : 1;
    region.lead = start - from;
    region.tail = to - end;
    region.left.assign(audio.left->begin() + from, audio.left->begin() + to);
    if (stereo)
        region.right.assign(audio.right->begin() + from, audio.right->begin() + to);
    else
        region.right.clear();
    return {};
}

void Session::arrangeInto(Track& track) {
    const auto spans = spansFor(track, playbackRate);
    auto applyPreview = [&](const std::string& clipId, const std::string& sourceId) {
        auto clips = track.clips;
        const auto limit = sourceLength(track, sourceId);
        for (auto& clip : clips) {
            if (clip.id != clipId || limit <= 0)
                continue;
            clip.sourceFileId = sourceId;
            clip.sourceOffset = 0;
            clip.duration = std::min(clip.duration, limit);
        }
        renderArrangement(clips, spans, track.playLeft, track.playRight);
    };
    if (!pitchPreview.trackId.empty() && pitchPreview.trackId == track.id) {
        applyPreview(pitchPreview.clipId, pitchPreview.sourceId);
        return;
    }
    if (!breathPreview.trackId.empty() && breathPreview.trackId == track.id) {
        applyPreview(breathPreview.clipId, breathPreview.sourceId);
        return;
    }
    renderArrangement(track.clips, spans, track.playLeft, track.playRight);
}

RetiredAudio Session::endPitchPreview() {
    RetiredAudio retired;
    if (pitchPreview.trackId.empty())
        return retired;
    const int index = indexOf(pitchPreview.trackId);
    pitchPreview = PitchPreview {};
    if (index < 0)
        return retired;
    retired = commitTrack(index);
    // Sources are only read while arranging on this thread, never by the audio callback.
    auto& extras = tracks[static_cast<size_t>(index)].extras;
    extras.erase(std::remove_if(extras.begin(), extras.end(), [](const Track::ExtraSource& extra) { return extra.preview; }), extras.end());
    return retired;
}

std::string Session::applyPitchSource(const std::string& trackId, const std::string& clipId, const std::string& sourceId,
                                      double shiftCents, const std::string& label, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        const auto found = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& item) { return item.id == clipId; });
        if (found == track.clips.end())
            return std::string("That clip is not on the track.");
        const auto limit = sourceLength(track, sourceId);
        if (limit <= 0)
            return std::string("The processed audio is not loaded on the track.");
        Clip next = *found;
        if (next.originalSourceFileId.empty()) {
            next.originalSourceFileId = found->sourceFileId;
            next.originalSourceOffset = found->sourceOffset;
            next.pitchShiftCents = 0.0;
            next.pitchLabel.clear();
        } else {
            next.originalSourceOffset += found->sourceOffset;
        }
        next.pitchShiftCents += shiftCents;
        if (!label.empty())
            next.pitchLabel = next.pitchLabel.empty() ? label : next.pitchLabel + " + " + label;
        next.sourceFileId = sourceId;
        next.sourceOffset = 0;
        next.duration = std::min(found->duration, limit);
        const auto error = validateClip(next, limit);
        if (!error.empty())
            return error;
        *found = next;
        return std::string {};
    }, retired);
}

std::string Session::revertPitchSource(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        const auto found = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& item) { return item.id == clipId; });
        if (found == track.clips.end())
            return std::string("That clip is not on the track.");
        if (found->originalSourceFileId.empty())
            return std::string("This clip has no pitch processing to revert.");
        const auto limit = sourceLength(track, found->originalSourceFileId);
        if (limit <= 0)
            return std::string("The clip's original audio is missing, so it cannot be restored.");
        Clip next = *found;
        next.sourceFileId = found->originalSourceFileId;
        next.sourceOffset = found->originalSourceOffset + found->sourceOffset;
        next.originalSourceFileId.clear();
        next.originalSourceOffset = 0;
        next.pitchShiftCents = 0.0;
        next.pitchLabel.clear();
        if (next.sourceOffset >= limit)
            return std::string("The clip's original audio is shorter than expected, so it cannot be restored.");
        next.duration = std::min(next.duration, limit - next.sourceOffset);
        const auto error = validateClip(next, limit);
        if (!error.empty())
            return error;
        *found = next;
        return std::string {};
    }, retired);
}

void Session::rememberUndo() {
    redoStack.clear();
    std::vector<ClipHistory> snapshot;
    snapshot.reserve(tracks.size());
    for (const auto& track : tracks) {
        if (!track.used)
            continue;
        ClipHistory item;
        item.trackId = track.id;
        item.clips = track.clips;
        item.takes = track.takes;
        item.takesExpanded = track.takesExpanded;
        item.compCrossfadeSamples = track.compCrossfadeSamples;
        snapshot.push_back(std::move(item));
    }
    undoStack.push_back(std::move(snapshot));
    if (undoStack.size() > 64)
        undoStack.erase(undoStack.begin());
}

RetiredAudio Session::commitTrack(int index) {
    RetiredAudio retired;
    auto& track = tracks[static_cast<size_t>(index)];
    takeOld(track, retired);
    arrangeInto(track);
    retired.index = index;
    return retired;
}

std::string Session::editClip(const std::string& trackId, const std::function<std::string(Track&)>& edit, RetiredAudio& retired) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    rememberUndo();
    auto& track = tracks[static_cast<size_t>(index)];
    const auto previous = track.clips;
    const auto error = edit(track);
    if (!error.empty()) {
        track.clips = previous;
        if (!undoStack.empty())
            undoStack.pop_back();
        return error;
    }
    retired = commitTrack(index);
    return {};
}

std::string Session::editNoteTargets(const std::string& trackId, const std::string& clipId,
                                     const std::function<std::string(Clip&)>& edit) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    auto& clips = tracks[static_cast<size_t>(index)].clips;
    const auto found = std::find_if(clips.begin(), clips.end(), [&](const Clip& item) { return item.id == clipId; });
    if (found == clips.end())
        return "That clip is not on the track.";
    Clip next = *found;
    const auto error = edit(next);
    if (!error.empty())
        return error;
    rememberUndo();
    const auto position = std::find_if(clips.begin(), clips.end(), [&](const Clip& item) { return item.id == clipId; });
    position->noteTargets = next.noteTargets;
    return {};
}

RetiredAudio Session::importClip(const std::string& trackId, const std::string& path, int64_t timelineStart,
                                 int64_t fade, std::string* clipId) {
    RetiredAudio retired;
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "Import a track before adding another clip to it.";
        return retired;
    }
    if (timelineStart < 0) {
        retired.error = "A clip cannot start before the timeline.";
        return retired;
    }
    auto decoded = readWavFile(path);
    if (!decoded.error.empty()) {
        retired.error = decoded.error;
        return retired;
    }
    auto playback = resampleStereo(decoded.left.data(),
                                   decoded.right.data(),
                                   static_cast<int64_t>(decoded.left.size()),
                                   decoded.sampleRate,
                                   playbackRate);
    if (!playback.error.empty()) {
        retired.error = playback.error;
        return retired;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    rememberUndo();
    if (track.path.empty() && !track.missing && track.extras.empty() && track.clips.empty()) {
        track.path = path;
        track.sourceSampleRate = decoded.sampleRate;
        track.sourceChannels = decoded.sourceChannels;
        track.sourceLeft = std::move(decoded.left);
        track.sourceRight = std::move(decoded.right);
        track.sourcePlayLeft = std::move(playback.left);
        track.sourcePlayRight = std::move(playback.right);
        track.error.clear();
    }
    const std::string sourceId = track.path == path ? primarySourceId(track) : freshClipId() + "-src";
    if (sourceId != primarySourceId(track)) {
        Track::ExtraSource extra;
        extra.id = sourceId;
        extra.path = path;
        extra.sampleRate = decoded.sampleRate;
        extra.channels = decoded.sourceChannels;
        extra.originalLeft = std::move(decoded.left);
        extra.originalRight = std::move(decoded.right);
        extra.playLeft = std::move(playback.left);
        extra.playRight = std::move(playback.right);
        track.extras.push_back(std::move(extra));
    }
    Clip clip;
    clip.id = freshClipId();
    clip.sourceFileId = sourceId;
    clip.timelineStart = timelineStart;
    clip.duration = sourceLength(track, sourceId);
    if (fade > 0) {
        clip.fadeIn = std::min<int64_t>(fade, clip.duration / 2);
        clip.fadeOut = clip.fadeIn;
    }
    const auto error = validateClip(clip, sourceLength(track, sourceId));
    if (!error.empty()) {
        retired.error = error;
        if (!undoStack.empty())
            undoStack.pop_back();
        return retired;
    }
    if (clipId != nullptr)
        *clipId = clip.id;
    track.clips.push_back(clip);
    retired = commitTrack(index);
    return retired;
}

std::string Session::splitClipAt(const std::string& trackId, const std::string& clipId, int64_t position, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        return splitClip(track.clips, clipId, position, freshClipId(), sourceLength(track, [&]() {
            for (const auto& clip : track.clips)
                if (clip.id == clipId)
                    return clip.sourceFileId;
            return std::string {};
        }()));
    }, retired);
}

std::string Session::moveClipTo(const std::string& trackId, const std::string& clipId, int64_t timelineStart, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        const auto error = moveClip(track.clips, clipId, timelineStart);
        if (!error.empty())
            return error;
        reconcileCrossfadeLinks(track.clips);
        if (track.autoCrossfadeEnabled) {
            const int64_t duration = playbackRate > 0.0
                ? std::max<int64_t>(0, static_cast<int64_t>(std::llround(playbackRate * track.autoCrossfadeMs / 1000.0)))
                : 0;
            return applyAutoCrossfades(track.clips, duration, track.autoCrossfadeCurve);
        }
        return std::string {};
    }, retired);
}

std::string Session::trimClipEdge(const std::string& trackId, const std::string& clipId, bool leftEdge, int64_t edge, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        std::string sourceId;
        for (const auto& clip : track.clips)
            if (clip.id == clipId)
                sourceId = clip.sourceFileId;
        const auto error = trimClip(track.clips, clipId, leftEdge, edge, sourceLength(track, sourceId));
        if (!error.empty())
            return error;
        reconcileCrossfadeLinks(track.clips);
        if (track.autoCrossfadeEnabled) {
            const int64_t duration = playbackRate > 0.0
                ? std::max<int64_t>(0, static_cast<int64_t>(std::llround(playbackRate * track.autoCrossfadeMs / 1000.0)))
                : 0;
            return applyAutoCrossfades(track.clips, duration, track.autoCrossfadeCurve);
        }
        return std::string {};
    }, retired);
}

std::string Session::deleteClipById(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) { return deleteClip(track.clips, clipId); }, retired);
}

std::string Session::duplicateClipAt(const std::string& trackId, const std::string& clipId, int64_t timelineStart, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        std::string sourceId;
        for (const auto& clip : track.clips)
            if (clip.id == clipId)
                sourceId = clip.sourceFileId;
        return duplicateClip(track.clips, clipId, timelineStart, freshClipId(), sourceLength(track, sourceId));
    }, retired);
}

std::string Session::setClipGainValue(const std::string& trackId, const std::string& clipId, float gain, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) { return setClipGain(track.clips, clipId, gain); }, retired);
}

std::string Session::setClipFadeValues(const std::string& trackId, const std::string& clipId, int64_t fadeIn, int64_t fadeOut, RetiredAudio& retired,
                                       const FadeCurve* fadeInCurve, const FadeCurve* fadeOutCurve) {
    return editClip(trackId, [&](Track& track) {
        return setClipFades(track.clips, clipId, fadeIn, fadeOut, fadeInCurve, fadeOutCurve);
    }, retired);
}

std::string Session::previewCrossfade(const std::string& trackId, const std::string& leftClipId, const std::string& rightClipId,
                                      int64_t durationSamples, FadeCurve curve, RetiredAudio& retired) {
    endCrossfadePreview();
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    auto* left = findTrackClip(track.clips, leftClipId);
    auto* right = findTrackClip(track.clips, rightClipId);
    if (left == nullptr || right == nullptr) {
        retired.error = "Both clips must exist on the track for a crossfade.";
        return retired.error;
    }
    crossfadePreview.trackId = trackId;
    crossfadePreview.leftClipId = leftClipId;
    crossfadePreview.rightClipId = rightClipId;
    crossfadePreview.previousLeft = *left;
    crossfadePreview.previousRight = *right;
    const auto error = applyCrossfadePair(track.clips, leftClipId, rightClipId, durationSamples, curve);
    if (!error.empty()) {
        crossfadePreview = CrossfadePreview {};
        retired.error = error;
        return error;
    }
    retired = commitTrack(index);
    return {};
}

RetiredAudio Session::endCrossfadePreview() {
    RetiredAudio retired;
    if (crossfadePreview.trackId.empty())
        return retired;
    const int index = indexOf(crossfadePreview.trackId);
    const auto leftId = crossfadePreview.leftClipId;
    const auto rightId = crossfadePreview.rightClipId;
    const Clip previousLeft = crossfadePreview.previousLeft;
    const Clip previousRight = crossfadePreview.previousRight;
    crossfadePreview = CrossfadePreview {};
    if (index < 0)
        return retired;
    auto& track = tracks[static_cast<size_t>(index)];
    if (auto* left = findTrackClip(track.clips, leftId))
        *left = previousLeft;
    if (auto* right = findTrackClip(track.clips, rightId))
        *right = previousRight;
    retired = commitTrack(index);
    return retired;
}

std::string Session::applyCrossfade(const std::string& trackId, const std::string& leftClipId, const std::string& rightClipId,
                                    int64_t durationSamples, FadeCurve curve, RetiredAudio& retired) {
    if (!crossfadePreview.trackId.empty() && crossfadePreview.trackId == trackId
        && crossfadePreview.leftClipId == leftClipId && crossfadePreview.rightClipId == rightClipId) {
        const int index = indexOf(trackId);
        if (index < 0) {
            retired.error = "No track exists with that id.";
            return retired.error;
        }
        auto& track = tracks[static_cast<size_t>(index)];
        auto* left = findTrackClip(track.clips, leftClipId);
        auto* right = findTrackClip(track.clips, rightClipId);
        if (left == nullptr || right == nullptr) {
            retired.error = "Both clips must exist on the track for a crossfade.";
            return retired.error;
        }
        const Clip committedLeft = *left;
        const Clip committedRight = *right;
        *left = crossfadePreview.previousLeft;
        *right = crossfadePreview.previousRight;
        rememberUndo();
        *left = committedLeft;
        *right = committedRight;
        crossfadePreview = CrossfadePreview {};
        retired = commitTrack(index);
        return {};
    }
    endCrossfadePreview();
    return editClip(trackId, [&](Track& track) {
        return applyCrossfadePair(track.clips, leftClipId, rightClipId, durationSamples, curve);
    }, retired);
}

std::string Session::revertCrossfade(const std::string& trackId, const std::string& leftClipId, const std::string& rightClipId,
                                     RetiredAudio& retired) {
    endCrossfadePreview();
    return editClip(trackId, [&](Track& track) {
        return clearCrossfadePair(track.clips, leftClipId, rightClipId);
    }, retired);
}

std::string Session::setAutoCrossfade(const std::string& trackId, bool enabled, double ms, FadeCurve curve) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    if (!std::isfinite(ms) || ms < 0.0 || ms > kMaxCrossfadeMs)
        return "Auto-crossfade duration must be between 0 and 5000 ms.";
    auto& track = tracks[static_cast<size_t>(index)];
    track.autoCrossfadeEnabled = enabled;
    track.autoCrossfadeMs = ms;
    track.autoCrossfadeCurve = curve;
    return {};
}

std::string Session::replaceClips(const std::string& trackId, std::vector<Clip> clips, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        for (const auto& clip : clips) {
            const auto error = validateClip(clip, sourceLength(track, clip.sourceFileId));
            if (!error.empty())
                return error;
        }
        track.clips = std::move(clips);
        return std::string {};
    }, retired);
}

std::string Session::addExtraFile(const std::string& trackId, const std::string& sourceId, const std::string& path) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    Track::ExtraSource extra;
    extra.id = sourceId;
    extra.path = path;
    auto decoded = readWavFile(path);
    if (!decoded.error.empty()) {
        extra.missing = true;
        extra.error = decoded.error;
        track.extras.push_back(std::move(extra));
        return decoded.error;
    }
    auto playback = resampleStereo(decoded.left.data(), decoded.right.data(), static_cast<int64_t>(decoded.left.size()), decoded.sampleRate, playbackRate);
    if (!playback.error.empty())
        return playback.error;
    extra.sampleRate = decoded.sampleRate;
    extra.channels = decoded.sourceChannels;
    extra.originalLeft = std::move(decoded.left);
    extra.originalRight = std::move(decoded.right);
    extra.playLeft = std::move(playback.left);
    extra.playRight = std::move(playback.right);
    track.extras.push_back(std::move(extra));
    return {};
}

std::string Session::relinkSource(const std::string& trackId, const std::string& sourceFileId, const std::string& path,
                                  RetiredAudio& retired) {
    retired = RetiredAudio {};
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track is loaded with that id.";
    if (path.empty())
        return "A file path is required to relink media.";
    auto decoded = readWavFile(path);
    if (!decoded.error.empty())
        return decoded.error;
    auto playback = resampleStereo(decoded.left.data(),
                                   decoded.right.data(),
                                   static_cast<int64_t>(decoded.left.size()),
                                   decoded.sampleRate,
                                   playbackRate);
    if (!playback.error.empty())
        return playback.error;

    auto& track = tracks[static_cast<size_t>(index)];
    const std::string primary = primarySourceId(track);
    if (sourceFileId.empty() || sourceFileId == primary) {
        takeOld(track, retired);
        track.path = path;
        track.sourceSampleRate = decoded.sampleRate;
        track.sourceChannels = decoded.sourceChannels;
        track.sourceLeft = std::move(decoded.left);
        track.sourceRight = std::move(decoded.right);
        track.sourcePlayLeft = std::move(playback.left);
        track.sourcePlayRight = std::move(playback.right);
        track.missing = false;
        track.error.clear();
        retired = commitTrack(index);
        return {};
    }

    auto extra = std::find_if(track.extras.begin(), track.extras.end(),
                              [&](const Track::ExtraSource& item) { return item.id == sourceFileId; });
    if (extra == track.extras.end())
        return "That media source is not registered on the track.";

    extra->path = path;
    extra->sampleRate = decoded.sampleRate;
    extra->channels = decoded.sourceChannels;
    extra->originalLeft = std::move(decoded.left);
    extra->originalRight = std::move(decoded.right);
    extra->playLeft = std::move(playback.left);
    extra->playRight = std::move(playback.right);
    extra->missing = false;
    extra->error.clear();
    retired = commitTrack(index);
    return {};
}

RetiredAudio Session::createMissingTrack(const std::string& id, const std::string& path, const std::string& name) {
    RetiredAudio retired;
    if (id.empty() || id.size() > 64) {
        retired.error = "Track id must be 1 to 64 characters.";
        return retired;
    }
    const int index = claimTrack(id);
    auto& track = tracks[static_cast<size_t>(index)];
    takeOld(track, retired);
    track = Track {};
    track.used = true;
    track.missing = true;
    track.id = id;
    track.name = name.empty() ? autoTrackName(index + 1, index) : name;
    track.path = path;
    track.error = "Audio file not found: " + path;
    retired.index = index;
    return retired;
}

std::string Session::applyClipHistory(const std::vector<ClipHistory>& snapshot, RetiredAudio& retired) {
    retired.chunks.clear();
    for (const auto& item : snapshot) {
        const int index = indexOf(item.trackId);
        if (index < 0)
            continue;
        auto& track = tracks[static_cast<size_t>(index)];
        track.clips = item.clips;
        track.takes = item.takes;
        track.takesExpanded = item.takesExpanded;
        track.compCrossfadeSamples = item.compCrossfadeSamples;
        auto committed = commitTrack(index);
        for (auto& chunk : committed.chunks)
            retired.chunks.push_back(std::move(chunk));
    }
    return {};
}

namespace {
Session::ClipHistory historyOf(const Session::Track& track) {
    Session::ClipHistory item;
    item.trackId = track.id;
    item.clips = track.clips;
    item.takes = track.takes;
    item.takesExpanded = track.takesExpanded;
    item.compCrossfadeSamples = track.compCrossfadeSamples;
    return item;
}
} // namespace

std::string Session::undoEdit(RetiredAudio& retired) {
    if (!undoStack.empty()) {
        std::vector<ClipHistory> current;
        current.reserve(tracks.size());
        for (const auto& track : tracks) {
            if (track.used)
                current.push_back(historyOf(track));
        }
        redoStack.push_back(std::move(current));
        const auto snapshot = std::move(undoStack.back());
        undoStack.pop_back();
        return applyClipHistory(snapshot, retired);
    }
    const auto error = undoEffectEdit();
    retired.error = error;
    return error;
}

std::string Session::redoEdit(RetiredAudio& retired) {
    if (!redoStack.empty()) {
        std::vector<ClipHistory> current;
        current.reserve(tracks.size());
        for (const auto& track : tracks) {
            if (track.used)
                current.push_back(historyOf(track));
        }
        undoStack.push_back(std::move(current));
        const auto snapshot = std::move(redoStack.back());
        redoStack.pop_back();
        return applyClipHistory(snapshot, retired);
    }
    const auto error = redoEffectEdit();
    retired.error = error;
    return error;
}

std::string Session::freshTimingMarkerId() {
    return "tm-" + std::to_string(nextTimingMarkerNumber++);
}

std::string Session::analyzeClipOnsets(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        SourceAudio audio;
        const auto sourceError = findSourceAudio(track, clip->sourceFileId, audio);
        if (!sourceError.empty())
            return sourceError;
        if (audio.missing || audio.left == nullptr || audio.left->empty() || audio.sampleRate <= 0.0)
            return std::string("The clip's source file is missing, so onsets cannot be analysed.");
        const int64_t length = static_cast<int64_t>(audio.left->size());
        const int64_t start = std::clamp<int64_t>(scaleSamples(clip->sourceOffset, playbackRate, audio.sampleRate), 0, length);
        const int64_t end = std::clamp<int64_t>(scaleSamples(clip->sourceOffset + clip->duration, playbackRate, audio.sampleRate), start, length);
        if (end <= start)
            return std::string("The clip has no audio to analyse.");
        const float* left = audio.left->data() + start;
        const float* right = audio.channels >= 2 && audio.right != nullptr && audio.right->size() == audio.left->size()
            ? audio.right->data() + start : nullptr;
        const int channels = right != nullptr ? 2 : 1;
        auto detected = detectOnsets(left, right, end - start, channels, audio.sampleRate, {});
        if (!detected.error.empty())
            return detected.error;
        std::vector<TimingMarker> manual;
        for (const auto& marker : clip->timingMarkers)
            if (marker.manual)
                manual.push_back(marker);
        clip->timingMarkers = std::move(manual);
        const int64_t separation = std::max<int64_t>(1, static_cast<int64_t>(std::llround(playbackRate * 0.04)));
        for (int64_t at : detected.samples) {
            TimingMarker marker;
            marker.id = freshTimingMarkerId();
            marker.manual = false;
            marker.sourceSample = clip->sourceOffset + scaleSamples(at, audio.sampleRate, playbackRate);
            if (validateTimingMarker(marker, clip->sourceOffset, clip->duration).empty())
                clip->timingMarkers.push_back(marker);
        }
        dedupeTimingMarkers(clip->timingMarkers, separation);
        return std::string {};
    }, retired);
}

std::string Session::addTimingMarker(const std::string& trackId, const std::string& clipId, int64_t sourceSample,
                                     bool manual, std::string* markerId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        TimingMarker marker;
        marker.id = freshTimingMarkerId();
        marker.sourceSample = sourceSample;
        marker.manual = manual;
        const auto error = validateTimingMarker(marker, clip->sourceOffset, clip->duration);
        if (!error.empty())
            return error;
        clip->timingMarkers.push_back(marker);
        dedupeTimingMarkers(clip->timingMarkers, std::max<int64_t>(1, static_cast<int64_t>(std::llround(playbackRate * 0.005))));
        if (markerId != nullptr)
            *markerId = marker.id;
        return std::string {};
    }, retired);
}

std::string Session::removeTimingMarker(const std::string& trackId, const std::string& clipId, const std::string& markerId,
                                        RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        const auto before = clip->timingMarkers.size();
        clip->timingMarkers.erase(std::remove_if(clip->timingMarkers.begin(), clip->timingMarkers.end(),
                                                 [&](const TimingMarker& item) { return item.id == markerId; }),
                                  clip->timingMarkers.end());
        if (clip->timingMarkers.size() == before)
            return std::string("No timing marker exists with that id.");
        return std::string {};
    }, retired);
}

std::string Session::moveTimingMarker(const std::string& trackId, const std::string& clipId, const std::string& markerId,
                                      int64_t sourceSample, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        TimingMarker* marker = nullptr;
        for (auto& item : clip->timingMarkers)
            if (item.id == markerId)
                marker = &item;
        if (marker == nullptr)
            return std::string("No timing marker exists with that id.");
        TimingMarker next = *marker;
        next.sourceSample = sourceSample;
        next.manual = true;
        const auto error = validateTimingMarker(next, clip->sourceOffset, clip->duration);
        if (!error.empty())
            return error;
        *marker = next;
        sortTimingMarkers(clip->timingMarkers);
        return std::string {};
    }, retired);
}

std::string Session::applyTimingSource(const std::string& trackId, const std::string& clipId, const std::string& sourceId,
                                       const std::string& label, const std::vector<TimingMarker>& markers,
                                       RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        const auto limit = sourceLength(track, sourceId);
        if (limit <= 0)
            return std::string("The processed timing audio is not loaded on the track.");
        Clip next = *clip;
        if (next.timingOriginalSourceFileId.empty()) {
            next.timingOriginalSourceFileId = clip->sourceFileId;
            next.timingOriginalSourceOffset = clip->sourceOffset;
            next.timingOriginalDuration = clip->duration;
        }
        next.sourceFileId = sourceId;
        next.sourceOffset = 0;
        next.duration = std::min(clip->duration, limit);
        next.timingLabel = label.empty() ? "timing" : label;
        next.timingMarkers = markers;
        for (auto& marker : next.timingMarkers)
            marker.sourceSample = std::clamp(marker.sourceSample, next.sourceOffset, next.sourceOffset + next.duration);
        sortTimingMarkers(next.timingMarkers);
        // Timing remaps the audible source — invalidate breath + offline pitch (prefer reanalysis).
        clearBreathProvenance(next);
        clearPitchProvenance(next);
        const auto error = validateClip(next, limit);
        if (!error.empty())
            return error;
        *clip = next;
        return std::string {};
    }, retired);
}

std::string Session::revertTimingSource(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        if (clip->timingOriginalSourceFileId.empty())
            return std::string("This clip has no timing processing to revert.");
        if (hasPitchApplied(*clip))
            return std::string("Revert offline pitch before reverting timing.");
        if (hasBreathApplied(*clip))
            return std::string("Revert breath/silence edits before reverting timing.");
        const auto limit = sourceLength(track, clip->timingOriginalSourceFileId);
        if (limit <= 0)
            return std::string("The clip's original audio is missing, so timing cannot be restored.");
        Clip next = *clip;
        next.sourceFileId = clip->timingOriginalSourceFileId;
        next.sourceOffset = clip->timingOriginalSourceOffset;
        next.duration = std::min(clip->timingOriginalDuration, limit - next.sourceOffset);
        next.timingOriginalSourceFileId.clear();
        next.timingOriginalSourceOffset = 0;
        next.timingOriginalDuration = 0;
        next.timingLabel.clear();
        // Keep markers remapped into the restored source domain when possible.
        for (auto& marker : next.timingMarkers)
            marker.sourceSample = std::clamp(marker.sourceSample - clip->sourceOffset + next.sourceOffset,
                                             next.sourceOffset, next.sourceOffset + next.duration);
        clearBreathProvenance(next);
        clearPitchProvenance(next);
        const auto error = validateClip(next, limit);
        if (!error.empty())
            return error;
        *clip = next;
        return std::string {};
    }, retired);
}

std::string Session::applyTimingMarkerMove(const std::string& trackId, const std::string& clipId,
                                           const std::string& markerId, int64_t newSourceSample,
                                           RetiredAudio& retired) {
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    auto* clip = findTrackClip(track.clips, clipId);
    if (clip == nullptr) {
        retired.error = "That clip is not on the track.";
        return retired.error;
    }
    TimingMarker* marker = nullptr;
    for (auto& item : clip->timingMarkers)
        if (item.id == markerId)
            marker = &item;
    if (marker == nullptr) {
        retired.error = "No timing marker exists with that id.";
        return retired.error;
    }
    if (newSourceSample == marker->sourceSample)
        return {};
    const auto boundError = validateTimingMarker(TimingMarker { markerId, newSourceSample, true }, clip->sourceOffset, clip->duration);
    if (!boundError.empty()) {
        retired.error = boundError;
        return retired.error;
    }

    // Build elastic breaks in play-buffer coordinates (clip-local).
    std::vector<int64_t> locals;
    locals.push_back(0);
    for (const auto& item : clip->timingMarkers)
        locals.push_back(item.sourceSample - clip->sourceOffset);
    locals.push_back(clip->duration);
    std::sort(locals.begin(), locals.end());
    locals.erase(std::unique(locals.begin(), locals.end()), locals.end());

    const int64_t oldLocal = marker->sourceSample - clip->sourceOffset;
    const int64_t newLocal = newSourceSample - clip->sourceOffset;
    size_t markerIndex = 0;
    for (size_t i = 0; i < locals.size(); ++i)
        if (locals[i] == oldLocal)
            markerIndex = i;
    if (markerIndex == 0 || markerIndex + 1 >= locals.size()) {
        retired.error = "A timing marker on the clip edge cannot be stretched.";
        return retired.error;
    }
    const int64_t leftBound = locals[markerIndex - 1];
    const int64_t rightBound = locals[markerIndex + 1];
    if (newLocal <= leftBound || newLocal >= rightBound) {
        retired.error = "A timing marker cannot cross its neighbouring markers.";
        return retired.error;
    }

    const float* playL = nullptr;
    const float* playR = nullptr;
    int64_t playLen = 0;
    bool stereo = false;
    if (clip->sourceFileId == primarySourceId(track)) {
        playL = track.sourcePlayLeft.data();
        playR = track.sourcePlayRight.data();
        playLen = static_cast<int64_t>(track.sourcePlayLeft.size());
        stereo = !track.sourcePlayRight.empty() && track.sourcePlayRight.size() == track.sourcePlayLeft.size();
    } else {
        for (const auto& extra : track.extras) {
            if (extra.id != clip->sourceFileId)
                continue;
            playL = extra.playLeft.data();
            playR = extra.playRight.data();
            playLen = static_cast<int64_t>(extra.playLeft.size());
            stereo = !extra.playRight.empty() && extra.playRight.size() == extra.playLeft.size();
            break;
        }
    }
    if (playL == nullptr || playLen <= 0) {
        retired.error = "The clip's playback audio is missing.";
        return retired.error;
    }
    const int64_t from = std::clamp(clip->sourceOffset, int64_t { 0 }, playLen);
    const int64_t to = std::clamp(clip->sourceOffset + clip->duration, from, playLen);
    if (to - from != clip->duration) {
        retired.error = "The clip region does not fit inside its source audio.";
        return retired.error;
    }
    const int ch = stereo ? 2 : 1;
    const int64_t ctx = pitchShiftFrameSize(playbackRate);
    const int64_t lead = std::min(ctx, from);
    const int64_t tail = std::min(ctx, playLen - to);
    std::vector<float> regionL(playL + (from - lead), playL + (to + tail));
    std::vector<float> regionR;
    if (stereo)
        regionR.assign(playR + (from - lead), playR + (to + tail));

    std::vector<int64_t> srcBreaks { 0 };
    if (leftBound > 0)
        srcBreaks.push_back(leftBound);
    srcBreaks.push_back(oldLocal);
    if (rightBound < (to - from))
        srcBreaks.push_back(rightBound);
    srcBreaks.push_back(to - from);
    std::vector<int64_t> dstLens;
    for (size_t i = 0; i + 1 < srcBreaks.size(); ++i) {
        const int64_t a = srcBreaks[i];
        const int64_t b = srcBreaks[i + 1];
        int64_t da = a;
        int64_t db = b;
        if (a == leftBound && b == oldLocal) {
            da = leftBound;
            db = newLocal;
        } else if (a == oldLocal && b == rightBound) {
            da = newLocal;
            db = rightBound;
        }
        const double ratio = static_cast<double>(db - da) / static_cast<double>(std::max<int64_t>(1, b - a));
        if (ratio < kTimeStretchMinRatio || ratio > kTimeStretchMaxRatio) {
            retired.error = "That timing move needs a stretch outside 0.75x–1.25x. Move the marker less far.";
            return retired.error;
        }
        dstLens.push_back(std::max<int64_t>(1, db - da));
    }
    std::vector<int64_t> withCtx = srcBreaks;
    for (auto& b : withCtx)
        b += lead;
    auto warped = timeWarpSegments(regionL.data(), stereo ? regionR.data() : nullptr,
                                   static_cast<int64_t>(regionL.size()), ch, playbackRate,
                                   withCtx, dstLens, lead, tail);
    if (!warped.error.empty()) {
        retired.error = warped.error;
        return retired.error;
    }
    if (static_cast<int64_t>(warped.left.size()) != clip->duration) {
        // Pad or crop to keep clip duration exact (elastic audio).
        warped.left.resize(static_cast<size_t>(clip->duration), 0.0f);
        if (stereo)
            warped.right.resize(static_cast<size_t>(clip->duration), 0.0f);
    }

    rememberUndo();
    const std::string sourceId = freshClipId() + "-timing";
    const auto cachePath = (std::filesystem::temp_directory_path() / (sourceId + ".wav")).string();
    const auto writeError = writeWavFile(cachePath, playbackRate, warped.left.data(),
                                         stereo ? warped.right.data() : warped.left.data(),
                                         static_cast<int64_t>(warped.left.size()), 24, ch);
    if (!writeError.empty()) {
        if (!undoStack.empty())
            undoStack.pop_back();
        retired.error = writeError;
        return retired.error;
    }
    Track::ExtraSource extra;
    extra.id = sourceId;
    extra.path = cachePath;
    extra.sampleRate = playbackRate;
    extra.channels = ch;
    extra.originalLeft = warped.left;
    extra.originalRight = stereo ? warped.right : warped.left;
    extra.playLeft = warped.left;
    extra.playRight = stereo ? warped.right : warped.left;
    track.extras.push_back(std::move(extra));

    Clip next = *clip;
    if (next.timingOriginalSourceFileId.empty()) {
        next.timingOriginalSourceFileId = clip->sourceFileId;
        next.timingOriginalSourceOffset = clip->sourceOffset;
        next.timingOriginalDuration = clip->duration;
    }
    next.sourceFileId = sourceId;
    next.sourceOffset = 0;
    next.duration = clip->duration;
    next.timingLabel = "timing warp";
    next.timingMarkers = clip->timingMarkers;
    for (auto& item : next.timingMarkers) {
        if (item.id == markerId) {
            item.sourceSample = newSourceSample - clip->sourceOffset; // now relative to new source at 0
            item.manual = true;
        } else {
            item.sourceSample = item.sourceSample - clip->sourceOffset;
        }
    }
    // After apply, sourceOffset is 0 so markers are clip-local absolute in new source.
    for (auto& item : next.timingMarkers)
        item.sourceSample = std::clamp(item.sourceSample, int64_t { 0 }, next.duration);
    sortTimingMarkers(next.timingMarkers);
    clearBreathProvenance(next);
    clearPitchProvenance(next);
    const auto error = validateClip(next, sourceLength(track, sourceId));
    if (!error.empty()) {
        track.extras.pop_back();
        if (!undoStack.empty())
            undoStack.pop_back();
        retired.error = error;
        return error;
    }
    *clip = next;
    retired = commitTrack(index);
    return {};
}

std::string Session::freshBreathRegionId() {
    return "breath-" + std::to_string(nextBreathRegionNumber++);
}

namespace {

struct ClipPlayAudio {
    const float* left = nullptr;
    const float* right = nullptr;
    int64_t length = 0;
    bool stereo = false;
};

ClipPlayAudio clipPlayAudio(const Session::Track& track, const std::string& sourceId,
                            const std::string& primaryId) {
    ClipPlayAudio out;
    if (sourceId == primaryId) {
        out.left = track.sourcePlayLeft.data();
        out.right = track.sourcePlayRight.data();
        out.length = static_cast<int64_t>(track.sourcePlayLeft.size());
        out.stereo = !track.sourcePlayRight.empty() && track.sourcePlayRight.size() == track.sourcePlayLeft.size();
        return out;
    }
    for (const auto& extra : track.extras) {
        if (extra.id != sourceId)
            continue;
        out.left = extra.playLeft.data();
        out.right = extra.playRight.data();
        out.length = static_cast<int64_t>(extra.playLeft.size());
        out.stereo = !extra.playRight.empty() && extra.playRight.size() == extra.playLeft.size();
        break;
    }
    return out;
}

std::string bakeBreathExtra(Session::Track& track, const Clip& clip, double playbackRate,
                            const std::string& primaryId, bool preview,
                            Session::Track::ExtraSource& extraOut) {
    const auto play = clipPlayAudio(track, clip.sourceFileId, primaryId);
    if (play.left == nullptr || play.length <= 0)
        return "The clip's playback audio is missing.";
    const int64_t from = std::clamp(clip.sourceOffset, int64_t { 0 }, play.length);
    const int64_t to = std::clamp(clip.sourceOffset + clip.duration, from, play.length);
    if (to - from != clip.duration)
        return "The clip region does not fit inside its source audio.";
    std::vector<float> left(play.left + from, play.left + to);
    std::vector<float> right;
    if (play.stereo)
        right.assign(play.right + from, play.right + to);
    // Region coordinates are absolute in the current source; buffer starts at clip.sourceOffset.
    const auto gainError = applyBreathGains(left.data(), play.stereo ? right.data() : nullptr,
                                            static_cast<int64_t>(left.size()), play.stereo ? 2 : 1,
                                            playbackRate, clip.sourceOffset, clip.breathRegions);
    if (!gainError.empty())
        return gainError;
    const std::string sourceId = preview ? ("breath-preview-" + clip.id) : (clip.id + "-breath");
    const auto cachePath = (std::filesystem::temp_directory_path() / (sourceId + ".wav")).string();
    const int ch = play.stereo ? 2 : 1;
    const auto writeError = writeWavFile(cachePath, playbackRate, left.data(),
                                         play.stereo ? right.data() : left.data(),
                                         static_cast<int64_t>(left.size()), 24, ch);
    if (!writeError.empty())
        return writeError;
    extraOut = {};
    extraOut.id = sourceId;
    extraOut.path = cachePath;
    extraOut.sampleRate = playbackRate;
    extraOut.channels = ch;
    extraOut.preview = preview;
    extraOut.originalLeft = left;
    extraOut.originalRight = play.stereo ? right : left;
    extraOut.playLeft = left;
    extraOut.playRight = play.stereo ? right : left;
    return {};
}

} // namespace

std::string Session::analyzeClipBreath(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        SourceAudio audio;
        const auto sourceError = findSourceAudio(track, clip->sourceFileId, audio);
        if (!sourceError.empty())
            return sourceError;
        if (audio.missing || audio.left == nullptr || audio.left->empty() || audio.sampleRate <= 0.0)
            return std::string("The clip's source file is missing, so breath/silence cannot be analysed.");
        const int64_t length = static_cast<int64_t>(audio.left->size());
        const int64_t start = std::clamp<int64_t>(scaleSamples(clip->sourceOffset, playbackRate, audio.sampleRate), 0, length);
        const int64_t end = std::clamp<int64_t>(scaleSamples(clip->sourceOffset + clip->duration, playbackRate, audio.sampleRate), start, length);
        if (end <= start)
            return std::string("The clip has no audio to analyse.");
        const float* left = audio.left->data() + start;
        const float* right = audio.channels >= 2 && audio.right != nullptr && audio.right->size() == audio.left->size()
            ? audio.right->data() + start : nullptr;
        const int channels = right != nullptr ? 2 : 1;
        auto silence = detectSilence(left, right, end - start, channels, audio.sampleRate, {});
        if (!silence.error.empty())
            return silence.error;
        auto breaths = detectBreathCandidates(left, right, end - start, channels, audio.sampleRate, {}, {});
        if (!breaths.error.empty())
            return breaths.error;

        std::vector<BreathRegion> kept;
        for (const auto& region : clip->breathRegions)
            if (region.manual)
                kept.push_back(region);
        clip->breathRegions = std::move(kept);

        auto addRegion = [&](int64_t localStart, int64_t localEnd, BreathKind kind, float confidence, float gainDb) {
            BreathRegion region;
            region.id = freshBreathRegionId();
            region.sourceStart = clip->sourceOffset + scaleSamples(localStart, audio.sampleRate, playbackRate);
            region.sourceEnd = clip->sourceOffset + scaleSamples(localEnd, audio.sampleRate, playbackRate);
            region.kind = kind;
            region.confidence = confidence;
            region.gainDb = gainDb;
            region.fadeIn = std::max<int64_t>(0, static_cast<int64_t>(std::llround(playbackRate * kDefaultBreathFadeMs / 1000.0)));
            region.fadeOut = region.fadeIn;
            region.ignored = false;
            region.manual = false;
            if (region.sourceEnd <= region.sourceStart)
                return;
            if (!validateBreathRegion(region, clip->sourceOffset, clip->duration).empty())
                return;
            clip->breathRegions.push_back(region);
        };

        for (const auto& item : silence.regions)
            addRegion(item.first, item.second, BreathKind::silence, 0.9f, kDefaultSilenceGainDb);
        for (const auto& item : breaths.candidates)
            addRegion(item.start, item.end, BreathKind::breath, item.confidence, kDefaultBreathGainDb);

        // Drop breath candidates that overlap silence (silence wins); then drop other overlaps.
        sortBreathRegions(clip->breathRegions);
        std::vector<BreathRegion> filtered;
        for (const auto& region : clip->breathRegions) {
            bool overlaps = false;
            for (const auto& keptRegion : filtered) {
                if (region.sourceStart < keptRegion.sourceEnd && region.sourceEnd > keptRegion.sourceStart) {
                    overlaps = true;
                    break;
                }
            }
            if (!overlaps)
                filtered.push_back(region);
        }
        clip->breathRegions = std::move(filtered);
        return checkBreathRegionOverlaps(clip->breathRegions);
    }, retired);
}

std::string Session::addBreathRegion(const std::string& trackId, const std::string& clipId, BreathRegion region,
                                     std::string* regionId, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        if (region.id.empty())
            region.id = freshBreathRegionId();
        region.manual = true;
        if (region.kind != BreathKind::silence && region.kind != BreathKind::breath)
            region.kind = BreathKind::manual;
        if (region.confidence <= 0.0f)
            region.confidence = 1.0f;
        const auto error = validateBreathRegion(region, clip->sourceOffset, clip->duration);
        if (!error.empty())
            return error;
        auto next = clip->breathRegions;
        next.push_back(region);
        const auto overlap = checkBreathRegionOverlaps(next);
        if (!overlap.empty())
            return overlap;
        sortBreathRegions(next);
        clip->breathRegions = std::move(next);
        if (regionId != nullptr)
            *regionId = region.id;
        return std::string {};
    }, retired);
}

std::string Session::removeBreathRegion(const std::string& trackId, const std::string& clipId, const std::string& regionId,
                                        RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        const auto before = clip->breathRegions.size();
        clip->breathRegions.erase(std::remove_if(clip->breathRegions.begin(), clip->breathRegions.end(),
                                                 [&](const BreathRegion& item) { return item.id == regionId; }),
                                  clip->breathRegions.end());
        if (clip->breathRegions.size() == before)
            return std::string("No breath region exists with that id.");
        return std::string {};
    }, retired);
}

std::string Session::setBreathRegion(const std::string& trackId, const std::string& clipId, const BreathRegion& region,
                                     RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        BreathRegion* found = nullptr;
        for (auto& item : clip->breathRegions)
            if (item.id == region.id)
                found = &item;
        if (found == nullptr)
            return std::string("No breath region exists with that id.");
        BreathRegion next = region;
        next.manual = found->manual || next.manual;
        const auto error = validateBreathRegion(next, clip->sourceOffset, clip->duration);
        if (!error.empty())
            return error;
        auto copy = clip->breathRegions;
        for (auto& item : copy)
            if (item.id == next.id)
                item = next;
        const auto overlap = checkBreathRegionOverlaps(copy);
        if (!overlap.empty())
            return overlap;
        sortBreathRegions(copy);
        clip->breathRegions = std::move(copy);
        return std::string {};
    }, retired);
}

std::string Session::setBreathRegionIgnored(const std::string& trackId, const std::string& clipId,
                                            const std::string& regionId, bool ignored, RetiredAudio& retired) {
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        for (auto& item : clip->breathRegions) {
            if (item.id != regionId)
                continue;
            item.ignored = ignored;
            return checkBreathRegionOverlaps(clip->breathRegions);
        }
        return std::string("No breath region exists with that id.");
    }, retired);
}

std::string Session::previewBreathEdits(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    endBreathPreview();
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    auto* clip = findTrackClip(track.clips, clipId);
    if (clip == nullptr) {
        retired.error = "That clip is not on the track.";
        return retired.error;
    }
    Track::ExtraSource extra;
    const auto error = bakeBreathExtra(track, *clip, playbackRate, primarySourceId(track), true, extra);
    if (!error.empty()) {
        retired.error = error;
        return error;
    }
    // Replace any previous preview extra with the same id.
    track.extras.erase(std::remove_if(track.extras.begin(), track.extras.end(),
                                      [&](const Track::ExtraSource& item) { return item.id == extra.id; }),
                       track.extras.end());
    track.extras.push_back(std::move(extra));
    breathPreview.trackId = trackId;
    breathPreview.clipId = clipId;
    breathPreview.sourceId = track.extras.back().id;
    retired = commitTrack(index);
    return {};
}

RetiredAudio Session::endBreathPreview() {
    RetiredAudio retired;
    if (breathPreview.trackId.empty())
        return retired;
    const int index = indexOf(breathPreview.trackId);
    const std::string previewId = breathPreview.sourceId;
    breathPreview = BreathPreview {};
    if (index < 0)
        return retired;
    auto& extras = tracks[static_cast<size_t>(index)].extras;
    extras.erase(std::remove_if(extras.begin(), extras.end(),
                                [&](const Track::ExtraSource& extra) {
                                    return extra.preview && (previewId.empty() || extra.id == previewId);
                                }),
                 extras.end());
    retired = commitTrack(index);
    return retired;
}

std::string Session::applyBreathEdits(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    endBreathPreview();
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    auto* clip = findTrackClip(track.clips, clipId);
    if (clip == nullptr) {
        retired.error = "That clip is not on the track.";
        return retired.error;
    }
    const auto overlap = checkBreathRegionOverlaps(clip->breathRegions);
    if (!overlap.empty()) {
        retired.error = overlap;
        return overlap;
    }
    bool any = false;
    for (const auto& region : clip->breathRegions)
        if (!region.ignored && std::fabs(region.gainDb) >= 1.0e-4f)
            any = true;
    if (!any) {
        retired.error = "No active breath/silence gains to apply. Adjust gain or un-ignore a region.";
        return retired.error;
    }

    // Re-apply from the pre-breath source when already processed.
    Clip base = *clip;
    if (!clip->breathOriginalSourceFileId.empty()) {
        base.sourceFileId = clip->breathOriginalSourceFileId;
        base.sourceOffset = clip->breathOriginalSourceOffset;
        base.duration = clip->breathOriginalDuration;
        // Regions were stored against the processed (offset 0) domain after a prior apply —
        // remap them back onto the original source domain for re-bake.
        for (auto& region : base.breathRegions) {
            region.sourceStart = region.sourceStart - clip->sourceOffset + base.sourceOffset;
            region.sourceEnd = region.sourceEnd - clip->sourceOffset + base.sourceOffset;
        }
    }

    Track::ExtraSource extra;
    const auto bakeError = bakeBreathExtra(track, base, playbackRate, primarySourceId(track), false, extra);
    if (!bakeError.empty()) {
        retired.error = bakeError;
        return bakeError;
    }
    rememberUndo();
    // Ensure unique id.
    extra.id = freshClipId() + "-breath";
    const auto renamed = (std::filesystem::temp_directory_path() / (extra.id + ".wav")).string();
    std::error_code ec;
    std::filesystem::rename(extra.path, renamed, ec);
    if (!ec)
        extra.path = renamed;
    track.extras.push_back(std::move(extra));

    Clip next = *clip;
    if (next.breathOriginalSourceFileId.empty()) {
        next.breathOriginalSourceFileId = base.sourceFileId;
        next.breathOriginalSourceOffset = base.sourceOffset;
        next.breathOriginalDuration = base.duration;
    }
    next.sourceFileId = track.extras.back().id;
    next.sourceOffset = 0;
    next.duration = base.duration;
    next.breathLabel = "breath/silence";
    next.breathRegions = base.breathRegions;
    for (auto& region : next.breathRegions) {
        region.sourceStart = std::clamp(region.sourceStart - base.sourceOffset, int64_t { 0 }, next.duration);
        region.sourceEnd = std::clamp(region.sourceEnd - base.sourceOffset, region.sourceStart, next.duration);
    }
    sortBreathRegions(next.breathRegions);
    // Breath remaps the audible source — offline pitch analysis/apply must be recomputed.
    clearPitchProvenance(next);
    const auto error = validateClip(next, sourceLength(track, next.sourceFileId));
    if (!error.empty()) {
        track.extras.pop_back();
        if (!undoStack.empty())
            undoStack.pop_back();
        retired.error = error;
        return error;
    }
    *clip = next;
    retired = commitTrack(index);
    return {};
}

std::string Session::revertBreathEdits(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    endBreathPreview();
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        if (clip->breathOriginalSourceFileId.empty())
            return std::string("This clip has no breath/silence processing to revert.");
        if (hasPitchApplied(*clip))
            return std::string("Revert offline pitch before reverting breath/silence edits.");
        const auto limit = sourceLength(track, clip->breathOriginalSourceFileId);
        if (limit <= 0)
            return std::string("The clip's original audio is missing, so breath edits cannot be restored.");
        Clip next = *clip;
        next.sourceFileId = clip->breathOriginalSourceFileId;
        next.sourceOffset = clip->breathOriginalSourceOffset;
        next.duration = std::min(clip->breathOriginalDuration, limit - next.sourceOffset);
        for (auto& region : next.breathRegions) {
            region.sourceStart = std::clamp(region.sourceStart - clip->sourceOffset + next.sourceOffset,
                                            next.sourceOffset, next.sourceOffset + next.duration);
            region.sourceEnd = std::clamp(region.sourceEnd - clip->sourceOffset + next.sourceOffset,
                                          region.sourceStart, next.sourceOffset + next.duration);
        }
        next.breathOriginalSourceFileId.clear();
        next.breathOriginalSourceOffset = 0;
        next.breathOriginalDuration = 0;
        next.breathLabel.clear();
        const auto error = validateClip(next, limit);
        if (!error.empty())
            return error;
        *clip = next;
        return std::string {};
    }, retired);
}

namespace {

std::string bakeClipStretch(Session::Track& track, const Clip& base, double playbackRate, const std::string& primaryId,
                            Session::ClipRateMode mode, double ratio, bool preview, Session::Track::ExtraSource& extra,
                            TimeStretchResult* metrics) {
    const float* playL = nullptr;
    const float* playR = nullptr;
    int64_t length = 0;
    int channels = 1;
    if (!findPlayBuffers(track, base.sourceFileId, primaryId, playL, playR, length, channels))
        return "The clip's audio is not loaded for stretch/speed processing.";
    const int64_t start = std::clamp<int64_t>(base.sourceOffset, 0, length);
    const int64_t end = std::clamp<int64_t>(base.sourceOffset + base.duration, start, length);
    const int64_t frames = end - start;
    if (frames <= 0)
        return "The clip has no audio to process.";
    if (frames < 32 && mode == Session::ClipRateMode::timeStretch)
        return "That clip is too short to time-stretch safely (need at least 32 samples).";

    TimeStretchResult processed;
    if (mode == Session::ClipRateMode::speed)
        processed = speedChangeClip(playL + start, channels == 2 ? playR + start : nullptr, frames, channels,
                                    playbackRate, ratio, nullptr);
    else
        processed = timeStretchClip(playL + start, channels == 2 ? playR + start : nullptr, frames, channels,
                                    playbackRate, ratio, nullptr, {});
    if (!processed.error.empty())
        return processed.error;
    if (processed.left.empty())
        return "Processing produced no audio.";

    const std::string tag = mode == Session::ClipRateMode::speed ? "speed" : "stretch";
    extra.id = (preview ? "preview-" : "") + std::string("clip-") + tag;
    extra.path = (std::filesystem::temp_directory_path() / (extra.id + ".wav")).string();
    extra.sampleRate = playbackRate;
    extra.channels = channels;
    extra.preview = preview;
    extra.originalLeft = processed.left;
    extra.originalRight = channels == 2 ? processed.right : processed.left;
    extra.playLeft = processed.left;
    extra.playRight = channels == 2 ? processed.right : processed.left;
    const auto writeError = writeWavFile(extra.path, playbackRate, processed.left.data(),
                                         channels == 2 ? processed.right.data() : processed.left.data(),
                                         static_cast<int64_t>(processed.left.size()), 24, channels);
    if (!writeError.empty())
        return writeError;
    if (metrics != nullptr)
        *metrics = std::move(processed);
    return {};
}

void applyStretchToClip(Clip& next, const Clip& base, const std::string& sourceId, int64_t newDuration,
                        Session::ClipRateMode mode, double ratio) {
    if (next.stretchOriginalSourceFileId.empty()) {
        next.stretchOriginalSourceFileId = base.sourceFileId;
        next.stretchOriginalSourceOffset = base.sourceOffset;
        next.stretchOriginalDuration = base.duration;
    }
    next.sourceFileId = sourceId;
    next.sourceOffset = 0;
    next.duration = newDuration;
    next.fadeIn = std::min(next.fadeIn, newDuration);
    next.fadeOut = std::min(next.fadeOut, newDuration);
    next.stretchMode = mode == Session::ClipRateMode::speed ? "speed" : "timeStretch";
    next.stretchRatio = ratio;
    next.stretchLabel = mode == Session::ClipRateMode::speed
        ? ("speed " + std::to_string(ratio) + "x")
        : ("stretch " + std::to_string(ratio) + "x");
    // Remapped audible source — invalidate downstream / incompatible provenance.
    clearTimingProvenance(next);
    clearBreathProvenance(next);
    clearPitchProvenance(next);
}

} // namespace

std::string Session::previewClipStretch(const std::string& trackId, const std::string& clipId, ClipRateMode mode,
                                        double ratio, RetiredAudio& retired) {
    endClipStretchPreview();
    endBreathPreview();
    endPitchPreview();
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    auto* clip = findTrackClip(track.clips, clipId);
    if (clip == nullptr) {
        retired.error = "That clip is not on the track.";
        return retired.error;
    }
    if (hasPitchApplied(*clip)) {
        retired.error = "Revert offline pitch before previewing stretch/speed.";
        return retired.error;
    }
    if (hasBreathApplied(*clip)) {
        retired.error = "Revert breath/silence edits before previewing stretch/speed.";
        return retired.error;
    }

    Clip base = *clip;
    if (!clip->stretchOriginalSourceFileId.empty()) {
        base.sourceFileId = clip->stretchOriginalSourceFileId;
        base.sourceOffset = clip->stretchOriginalSourceOffset;
        base.duration = clip->stretchOriginalDuration;
    }

    Track::ExtraSource extra;
    TimeStretchResult metrics;
    const auto error = bakeClipStretch(track, base, playbackRate, primarySourceId(track), mode, ratio, true, extra, &metrics);
    if (!error.empty()) {
        retired.error = error;
        return error;
    }
    extra.id = freshClipId() + (mode == ClipRateMode::speed ? "-speed-preview" : "-stretch-preview");
    const auto renamed = (std::filesystem::temp_directory_path() / (extra.id + ".wav")).string();
    std::error_code ec;
    std::filesystem::rename(extra.path, renamed, ec);
    if (!ec)
        extra.path = renamed;

    stretchPreview.previous = *clip;
    stretchPreview.trackId = trackId;
    stretchPreview.clipId = clipId;
    stretchPreview.sourceId = extra.id;
    track.extras.push_back(std::move(extra));

    Clip next = *clip;
    applyStretchToClip(next, base, stretchPreview.sourceId, static_cast<int64_t>(track.extras.back().playLeft.size()),
                       mode, ratio);
    // Preview keeps stretchOriginal only as labels for UI; revert path uses stretchPreview.previous.
    const auto validate = validateClip(next, sourceLength(track, stretchPreview.sourceId));
    if (!validate.empty()) {
        track.extras.pop_back();
        stretchPreview = StretchPreview {};
        retired.error = validate;
        return validate;
    }
    *clip = next;
    retired = commitTrack(index);
    return {};
}

RetiredAudio Session::endClipStretchPreview() {
    RetiredAudio retired;
    if (stretchPreview.trackId.empty())
        return retired;
    const int index = indexOf(stretchPreview.trackId);
    const std::string previewId = stretchPreview.sourceId;
    const std::string clipId = stretchPreview.clipId;
    const Clip previous = stretchPreview.previous;
    stretchPreview = StretchPreview {};
    if (index < 0)
        return retired;
    auto& track = tracks[static_cast<size_t>(index)];
    if (auto* clip = findTrackClip(track.clips, clipId))
        *clip = previous;
    track.extras.erase(std::remove_if(track.extras.begin(), track.extras.end(),
                                      [&](const Track::ExtraSource& extra) {
                                          return extra.preview && (previewId.empty() || extra.id == previewId);
                                      }),
                       track.extras.end());
    retired = commitTrack(index);
    return retired;
}

std::string Session::applyClipStretch(const std::string& trackId, const std::string& clipId, ClipRateMode mode,
                                      double ratio, RetiredAudio& retired) {
    // Promote an active matching preview into a committed edit.
    if (!stretchPreview.trackId.empty() && stretchPreview.trackId == trackId && stretchPreview.clipId == clipId) {
        const int index = indexOf(trackId);
        if (index < 0) {
            retired.error = "No track exists with that id.";
            return retired.error;
        }
        auto& track = tracks[static_cast<size_t>(index)];
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr) {
            retired.error = "That clip is not on the track.";
            return retired.error;
        }
        // Snapshot pre-preview onto the undo stack, then keep the processed clip.
        const Clip committed = *clip;
        *clip = stretchPreview.previous;
        rememberUndo();
        *clip = committed;
        for (auto& extra : track.extras) {
            if (extra.id == stretchPreview.sourceId)
                extra.preview = false;
        }
        stretchPreview = StretchPreview {};
        retired = commitTrack(index);
        return {};
    }

    endClipStretchPreview();
    endBreathPreview();
    endPitchPreview();
    const int index = indexOf(trackId);
    if (index < 0) {
        retired.error = "No track exists with that id.";
        return retired.error;
    }
    auto& track = tracks[static_cast<size_t>(index)];
    auto* clip = findTrackClip(track.clips, clipId);
    if (clip == nullptr) {
        retired.error = "That clip is not on the track.";
        return retired.error;
    }
    if (hasPitchApplied(*clip)) {
        retired.error = "Revert offline pitch before applying stretch/speed.";
        return retired.error;
    }
    if (hasBreathApplied(*clip)) {
        retired.error = "Revert breath/silence edits before applying stretch/speed.";
        return retired.error;
    }

    Clip base = *clip;
    if (!clip->stretchOriginalSourceFileId.empty()) {
        base.sourceFileId = clip->stretchOriginalSourceFileId;
        base.sourceOffset = clip->stretchOriginalSourceOffset;
        base.duration = clip->stretchOriginalDuration;
    }

    if (mode == ClipRateMode::timeStretch) {
        const auto check = checkClipDurationRatio(ratio);
        if (!check.empty()) {
            retired.error = check;
            return check;
        }
    } else {
        const auto check = checkClipSpeed(ratio);
        if (!check.empty()) {
            retired.error = check;
            return check;
        }
    }
    if (std::fabs(ratio - 1.0) < 1.0e-9 && clip->stretchOriginalSourceFileId.empty()) {
        // Identity with no prior stretch — nothing to do.
        return {};
    }

    Track::ExtraSource extra;
    TimeStretchResult metrics;
    const auto bakeError = bakeClipStretch(track, base, playbackRate, primarySourceId(track), mode, ratio, false, extra, &metrics);
    if (!bakeError.empty()) {
        retired.error = bakeError;
        return bakeError;
    }
    rememberUndo();
    extra.id = freshClipId() + (mode == ClipRateMode::speed ? "-speed" : "-stretch");
    const auto renamed = (std::filesystem::temp_directory_path() / (extra.id + ".wav")).string();
    std::error_code ec;
    std::filesystem::rename(extra.path, renamed, ec);
    if (!ec)
        extra.path = renamed;
    track.extras.push_back(std::move(extra));

    Clip next = *clip;
    applyStretchToClip(next, base, track.extras.back().id, static_cast<int64_t>(track.extras.back().playLeft.size()),
                       mode, ratio);
    const auto validate = validateClip(next, sourceLength(track, track.extras.back().id));
    if (!validate.empty()) {
        track.extras.pop_back();
        if (!undoStack.empty())
            undoStack.pop_back();
        retired.error = validate;
        return validate;
    }
    *clip = next;
    retired = commitTrack(index);
    return {};
}

std::string Session::revertClipStretch(const std::string& trackId, const std::string& clipId, RetiredAudio& retired) {
    endClipStretchPreview();
    return editClip(trackId, [&](Track& track) {
        auto* clip = findTrackClip(track.clips, clipId);
        if (clip == nullptr)
            return std::string("That clip is not on the track.");
        if (clip->stretchOriginalSourceFileId.empty())
            return std::string("This clip has no stretch/speed processing to revert.");
        if (hasPitchApplied(*clip))
            return std::string("Revert offline pitch before reverting stretch/speed.");
        if (hasBreathApplied(*clip))
            return std::string("Revert breath/silence edits before reverting stretch/speed.");
        const auto limit = sourceLength(track, clip->stretchOriginalSourceFileId);
        if (limit <= 0)
            return std::string("The clip's original audio is missing, so stretch/speed cannot be restored.");
        Clip next = *clip;
        next.sourceFileId = clip->stretchOriginalSourceFileId;
        next.sourceOffset = clip->stretchOriginalSourceOffset;
        next.duration = std::min(clip->stretchOriginalDuration, limit - next.sourceOffset);
        next.fadeIn = std::min(next.fadeIn, next.duration);
        next.fadeOut = std::min(next.fadeOut, next.duration);
        clearStretchProvenance(next);
        clearTimingProvenance(next);
        clearBreathProvenance(next);
        clearPitchProvenance(next);
        const auto error = validateClip(next, limit);
        if (!error.empty())
            return error;
        *clip = next;
        return std::string {};
    }, retired);
}

const VocalPresetDefinition* Session::findVocalPreset(const std::string& id) const {
    if (const auto* factory = findFactoryVocalPreset(id))
        return factory;
    for (const auto& preset : customVocalPresets) {
        if (preset.id == id)
            return &preset;
    }
    return nullptr;
}

std::vector<VocalPresetDefinition> Session::listVocalPresets() const {
    auto list = factoryVocalPresets();
    for (const auto& preset : customVocalPresets)
        list.push_back(preset);
    return list;
}

void Session::rememberEffectUndo(const std::string& trackId) {
    const int index = indexOf(trackId);
    if (index < 0)
        return;
    const auto& track = tracks[static_cast<size_t>(index)];
    EffectHistory item;
    item.trackId = track.id;
    item.effects = track.effects;
    item.vocalPresetId = track.vocalPresetId;
    item.vocalPresetBypassed = track.vocalPresetBypassed;
    item.vocalPresetPrevious = track.vocalPresetPrevious;
    effectUndoStack.push_back(std::move(item));
    if (effectUndoStack.size() > 64)
        effectUndoStack.erase(effectUndoStack.begin());
    effectRedoStack.clear();
}

std::string Session::undoEffectEdit() {
    if (effectUndoStack.empty())
        return "Nothing to undo.";
    const auto snapshot = std::move(effectUndoStack.back());
    effectUndoStack.pop_back();
    const int index = indexOf(snapshot.trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    EffectHistory current;
    current.trackId = track.id;
    current.effects = track.effects;
    current.vocalPresetId = track.vocalPresetId;
    current.vocalPresetBypassed = track.vocalPresetBypassed;
    current.vocalPresetPrevious = track.vocalPresetPrevious;
    effectRedoStack.push_back(std::move(current));
    track.effects = snapshot.effects;
    track.vocalPresetId = snapshot.vocalPresetId;
    track.vocalPresetBypassed = snapshot.vocalPresetBypassed;
    track.vocalPresetPrevious = snapshot.vocalPresetPrevious;
    return {};
}

std::string Session::redoEffectEdit() {
    if (effectRedoStack.empty())
        return "Nothing to redo.";
    const auto snapshot = std::move(effectRedoStack.back());
    effectRedoStack.pop_back();
    const int index = indexOf(snapshot.trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    EffectHistory current;
    current.trackId = track.id;
    current.effects = track.effects;
    current.vocalPresetId = track.vocalPresetId;
    current.vocalPresetBypassed = track.vocalPresetBypassed;
    current.vocalPresetPrevious = track.vocalPresetPrevious;
    effectUndoStack.push_back(std::move(current));
    track.effects = snapshot.effects;
    track.vocalPresetId = snapshot.vocalPresetId;
    track.vocalPresetBypassed = snapshot.vocalPresetBypassed;
    track.vocalPresetPrevious = snapshot.vocalPresetPrevious;
    return {};
}

namespace {

void pruneEffectAutomation(std::vector<AutomationLane>& lanes, const std::vector<ProjectEffect>& effects) {
    std::vector<std::string> keep;
    keep.reserve(effects.size());
    for (const auto& effect : effects)
        keep.push_back("fx:" + effect.id + ":");
    lanes.erase(std::remove_if(lanes.begin(), lanes.end(), [&](const AutomationLane& lane) {
        if (lane.param.rfind("fx:", 0) != 0)
            return false;
        for (const auto& prefix : keep) {
            if (lane.param.rfind(prefix, 0) == 0)
                return false;
        }
        return true;
    }), lanes.end());
}

} // namespace

std::string Session::endVocalPresetPreview() {
    if (vocalPresetPreview.trackId.empty())
        return {};
    const int index = indexOf(vocalPresetPreview.trackId);
    const auto previous = std::move(vocalPresetPreview);
    vocalPresetPreview = VocalPresetPreview {};
    if (index < 0)
        return {};
    auto& track = tracks[static_cast<size_t>(index)];
    track.effects = previous.previous;
    track.vocalPresetId = previous.previousPresetId;
    track.vocalPresetBypassed = previous.previousBypassed;
    track.vocalPresetPrevious = previous.previousPresetPrevious;
    pruneEffectAutomation(track.automation, track.effects);
    return {};
}

std::string Session::previewVocalPreset(const std::string& trackId, const std::string& presetId) {
    endVocalPresetPreview();
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    const auto* preset = findVocalPreset(presetId);
    if (preset == nullptr)
        return "No vocal preset exists with that id.";
    std::vector<ProjectEffect> chain;
    const auto error = instantiateVocalPreset(*preset, [this] { return freshEffectId(); }, chain);
    if (!error.empty())
        return error;
    auto& track = tracks[static_cast<size_t>(index)];
    vocalPresetPreview.trackId = trackId;
    vocalPresetPreview.previous = track.effects;
    vocalPresetPreview.previousPresetId = track.vocalPresetId;
    vocalPresetPreview.previousBypassed = track.vocalPresetBypassed;
    vocalPresetPreview.previousPresetPrevious = track.vocalPresetPrevious;
    track.effects = std::move(chain);
    track.vocalPresetBypassed = false;
    pruneEffectAutomation(track.automation, track.effects);
    return {};
}

std::string Session::applyVocalPreset(const std::string& trackId, const std::string& presetId) {
    endVocalPresetPreview();
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    const auto* preset = findVocalPreset(presetId);
    if (preset == nullptr)
        return "No vocal preset exists with that id.";
    std::vector<ProjectEffect> chain;
    const auto error = instantiateVocalPreset(*preset, [this] { return freshEffectId(); }, chain);
    if (!error.empty())
        return error;
    rememberEffectUndo(trackId);
    auto& track = tracks[static_cast<size_t>(index)];
    // Repeated Apply of the same/different preset replaces the chain (no stacking / duplication).
    if (track.vocalPresetPrevious.empty() && track.vocalPresetId.empty())
        track.vocalPresetPrevious = track.effects;
    track.effects = std::move(chain);
    track.vocalPresetId = presetId;
    track.vocalPresetBypassed = false;
    pruneEffectAutomation(track.automation, track.effects);
    return {};
}

std::string Session::bypassVocalPreset(const std::string& trackId, bool bypassed) {
    endVocalPresetPreview();
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    if (track.vocalPresetId.empty())
        return "This track has no vocal preset to bypass.";
    if (track.vocalPresetBypassed == bypassed)
        return {};
    rememberEffectUndo(trackId);
    track.vocalPresetBypassed = bypassed;
    for (auto& effect : track.effects)
        effect.enabled = !bypassed;
    return {};
}

std::string Session::revertVocalPreset(const std::string& trackId) {
    endVocalPresetPreview();
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    auto& track = tracks[static_cast<size_t>(index)];
    if (track.vocalPresetId.empty() && track.vocalPresetPrevious.empty())
        return "This track has no vocal preset to revert.";
    rememberEffectUndo(trackId);
    track.effects = track.vocalPresetPrevious;
    track.vocalPresetPrevious.clear();
    track.vocalPresetId.clear();
    track.vocalPresetBypassed = false;
    pruneEffectAutomation(track.automation, track.effects);
    return {};
}

std::string Session::saveCustomVocalPreset(const std::string& name, const std::string& fromPresetId, std::string* createdId) {
    const auto* source = findVocalPreset(fromPresetId);
    if (source == nullptr)
        return "No vocal preset exists with that id.";
    VocalPresetDefinition custom = *source;
    custom.factory = false;
    custom.id = "custom-" + std::to_string(nextEffectNumber++);
    custom.name = name;
    const auto error = validateVocalPreset(custom);
    if (!error.empty())
        return error;
    for (const auto& existing : customVocalPresets) {
        if (existing.name == custom.name)
            return "A custom vocal preset named \"" + custom.name + "\" already exists.";
    }
    if (createdId != nullptr)
        *createdId = custom.id;
    customVocalPresets.push_back(std::move(custom));
    return {};
}

std::string Session::saveCustomVocalPresetFromTrack(const std::string& trackId, const std::string& name, std::string* createdId) {
    const int index = indexOf(trackId);
    if (index < 0)
        return "No track exists with that id.";
    const auto& track = tracks[static_cast<size_t>(index)];
    if (track.effects.empty())
        return "The track has no effects to save as a preset.";
    VocalPresetDefinition custom;
    custom.factory = false;
    custom.id = "custom-" + std::to_string(nextEffectNumber++);
    custom.name = name;
    for (const auto& effect : track.effects) {
        VocalPresetEffect item;
        item.type = effect.type;
        item.enabled = effect.enabled;
        item.params = effect.params;
        custom.effects.push_back(item);
    }
    const auto error = validateVocalPreset(custom);
    if (!error.empty())
        return error;
    for (const auto& existing : customVocalPresets) {
        if (existing.name == custom.name)
            return "A custom vocal preset named \"" + custom.name + "\" already exists.";
    }
    if (createdId != nullptr)
        *createdId = custom.id;
    customVocalPresets.push_back(std::move(custom));
    return {};
}

std::string Session::renameCustomVocalPreset(const std::string& id, const std::string& name) {
    if (findFactoryVocalPreset(id) != nullptr)
        return "Factory vocal presets cannot be renamed.";
    if (name.empty() || name.size() > 80)
        return "Vocal preset names must be between 1 and 80 characters.";
    for (auto& preset : customVocalPresets) {
        if (preset.id != id)
            continue;
        for (const auto& existing : customVocalPresets) {
            if (existing.id != id && existing.name == name)
                return "A custom vocal preset named \"" + name + "\" already exists.";
        }
        preset.name = name;
        return {};
    }
    return "No custom vocal preset exists with that id.";
}

std::string Session::deleteCustomVocalPreset(const std::string& id) {
    if (findFactoryVocalPreset(id) != nullptr)
        return "Factory vocal presets cannot be deleted.";
    const auto before = customVocalPresets.size();
    customVocalPresets.erase(std::remove_if(customVocalPresets.begin(), customVocalPresets.end(),
                                            [&](const VocalPresetDefinition& preset) { return preset.id == id; }),
                             customVocalPresets.end());
    if (customVocalPresets.size() == before)
        return "No custom vocal preset exists with that id.";
    for (auto& track : tracks) {
        if (track.vocalPresetId == id)
            track.vocalPresetId.clear();
    }
    return {};
}

std::string Session::restoreFactoryVocalPresets() {
    // Factories are immutable code definitions. Drop any custom presets that collide with factory ids.
    customVocalPresets.erase(std::remove_if(customVocalPresets.begin(), customVocalPresets.end(),
                                            [](const VocalPresetDefinition& preset) {
                                                return findFactoryVocalPreset(preset.id) != nullptr;
                                            }),
                             customVocalPresets.end());
    return {};
}

} // namespace msp


