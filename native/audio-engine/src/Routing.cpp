#include "msp/Routing.h"

#include <algorithm>
#include <cmath>

namespace msp {
namespace {
constexpr int kFadeGenerations = 4;

uint64_t hashKey(const std::string& text) {
    uint64_t hash = 1469598103934665603ull;
    for (unsigned char c : text) {
        hash ^= c;
        hash *= 1099511628211ull;
    }
    return hash;
}

int busIndex(const std::vector<ProjectBus>& buses, const std::string& id) {
    for (size_t i = 0; i < buses.size(); ++i) {
        if (buses[i].id == id)
            return static_cast<int>(i);
    }
    return -1;
}

// True when following outputs from `start` reaches `target`.
bool reaches(const std::vector<ProjectBus>& buses, const std::string& start, const std::string& target) {
    std::string at = start;
    for (size_t steps = 0; steps <= buses.size(); ++steps) {
        if (at == target)
            return true;
        const auto* bus = findBus(buses, at);
        if (bus == nullptr)
            return false;
        at = bus->output;
    }
    return true;
}
} // namespace

uint64_t recordInputKey(const std::string& trackId) {
    return hashKey("t:" + trackId);
}

const ProjectBus* findBus(const std::vector<ProjectBus>& buses, const std::string& id) {
    const int index = busIndex(buses, id);
    return index < 0 ? nullptr : &buses[static_cast<size_t>(index)];
}

std::string checkTrackOutput(const std::vector<ProjectBus>& buses, const std::string& output) {
    if (output == kMasterBusId)
        return {};
    const auto* bus = findBus(buses, output);
    if (bus == nullptr)
        return "No bus exists with that id.";
    if (bus->kind == BusKind::ret)
        return "Tracks reach return buses through sends, not through their main output.";
    return {};
}

std::string checkBusOutput(const std::vector<ProjectBus>& buses, const std::string& busId, const std::string& output) {
    if (findBus(buses, busId) == nullptr)
        return "No bus exists with that id.";
    if (output == kMasterBusId)
        return {};
    if (output == busId)
        return "A bus cannot route to itself.";
    const auto* target = findBus(buses, output);
    if (target == nullptr)
        return "No bus exists with that id.";
    if (target->kind == BusKind::ret)
        return "Buses can only route to a group bus or the master.";
    if (reaches(buses, output, busId))
        return "That route would create a feedback loop.";
    return {};
}

std::string checkSend(const std::vector<ProjectBus>& buses, const std::string& busId) {
    const auto* bus = findBus(buses, busId);
    if (bus == nullptr || bus->kind != BusKind::ret)
        return "Sends can only target a return bus.";
    return {};
}

void repairBuses(std::vector<ProjectBus>& buses, std::vector<std::string>& warnings) {
    std::vector<ProjectBus> unique;
    for (auto& bus : buses) {
        if (findBus(unique, bus.id) != nullptr) {
            warnings.push_back("Bus " + bus.id + " was listed twice. The second copy was removed.");
            continue;
        }
        if (static_cast<int>(unique.size()) >= kMaxBuses) {
            warnings.push_back("The project has more than " + std::to_string(kMaxBuses) + " buses. Bus " + bus.id + " was removed.");
            continue;
        }
        unique.push_back(bus);
    }
    buses = std::move(unique);
    for (auto& bus : buses) {
        if (bus.output == kMasterBusId)
            continue;
        const auto* target = findBus(buses, bus.output);
        if (bus.output == bus.id || target == nullptr || target->kind == BusKind::ret) {
            warnings.push_back("Bus " + bus.name + " had an invalid output (" + bus.output + "). It was routed to the master.");
            bus.output = kMasterBusId;
        }
    }
    // Break loops one bus at a time; each fix removes at least one edge.
    for (auto& bus : buses) {
        if (bus.output != kMasterBusId && reaches(buses, bus.output, bus.id)) {
            warnings.push_back("Bus " + bus.name + " was part of a routing loop. It was routed to the master.");
            bus.output = kMasterBusId;
        }
    }
}

bool automationRange(const std::string& ownerKind, const std::string& param, const std::vector<ProjectEffect>& effects,
                     float& minimum, float& maximum) {
    if (param == "volume" && (ownerKind == "track" || ownerKind == "bus" || ownerKind == "master")) {
        minimum = 0.0f;
        maximum = 4.0f;
        return true;
    }
    if (param == "pan" && ownerKind == "track") {
        minimum = -1.0f;
        maximum = 1.0f;
        return true;
    }
    std::string effectId;
    std::string name;
    if (!parseEffectAutomationParam(param, effectId, name))
        return false;
    for (const auto& effect : effects) {
        if (effect.id != effectId)
            continue;
        const int index = effectParamIndex(effect.type, name);
        if (index < 0)
            return false;
        const auto& spec = effectSpec(effect.type).params[index];
        if (spec.choice)
            return false;
        minimum = spec.minimum;
        maximum = spec.maximum;
        return true;
    }
    return false;
}

MixPlan buildMixPlan(const std::vector<RouteTrack>& tracks,
                     const std::vector<ProjectBus>& buses,
                     double sampleRate,
                     const MixPlan* previous,
                     const std::vector<ProjectEffect>* masterEffects,
                     const std::vector<AutomationLane>* masterAutomation) {
    MixPlan plan;
    const double rate = sampleRate > 0.0 ? sampleRate : 48000.0;
    plan.rampStep = static_cast<float>(1.0 / (0.010 * rate));
    plan.sampleRate = rate;
    auto addLane = [&](const AutomationLane& lane, LaneKind kind, int effect, int param, float minimum, float maximum) {
        MixLane item;
        item.kind = kind;
        item.effect = effect;
        item.param = param;
        item.minimum = minimum;
        item.maximum = maximum;
        item.firstPoint = static_cast<int>(plan.points.size());
        const size_t count = std::min<size_t>(lane.points.size(), static_cast<size_t>(kMaxAutomationPoints));
        plan.points.insert(plan.points.end(), lane.points.begin(), lane.points.begin() + static_cast<std::ptrdiff_t>(count));
        item.pointCount = static_cast<int>(count);
        plan.lanes.push_back(item);
        return static_cast<int>(plan.lanes.size()) - 1;
    };
    auto activeLane = [](const std::vector<AutomationLane>& lanes, const std::string& param) -> const AutomationLane* {
        const auto* lane = findAutomationLane(lanes, param);
        return lane != nullptr && automationActive(*lane) ? lane : nullptr;
    };
    // `prefix` keeps the record-input copy of a track chain apart from the chain itself.
    auto addChain = [&](const std::vector<ProjectEffect>& effects, const std::vector<AutomationLane>* lanes, const std::string& prefix) {
        MixChain chain;
        chain.first = static_cast<int>(plan.effects.size());
        for (const auto& effect : effects) {
            if (chain.count >= kMaxEffectsPerChain)
                break;
            MixEffect item;
            item.type = effect.type;
            item.key = hashKey(prefix + "fx:" + effect.id + ":" + effectTypeName(effect.type));
            item.enabled = effect.enabled;
            item.params = effect.params;
            sanitizeEffectParams(item.type, item.params);
            item.firstLane = static_cast<int>(plan.lanes.size());
            if (lanes != nullptr) {
                const auto& spec = effectSpec(effect.type);
                for (const auto& lane : *lanes) {
                    std::string effectId;
                    std::string name;
                    if (!automationActive(lane) || !parseEffectAutomationParam(lane.param, effectId, name) || effectId != effect.id)
                        continue;
                    const int param = effectParamIndex(effect.type, name);
                    if (param < 0 || spec.params[param].choice)
                        continue;
                    addLane(lane, LaneKind::effect, static_cast<int>(plan.effects.size()), param,
                            spec.params[param].minimum, spec.params[param].maximum);
                    ++item.laneCount;
                }
            }
            plan.effects.push_back(item);
            plan.effectIds.push_back(prefix.empty() ? effect.id : prefix + effect.id);
            ++chain.count;
        }
        return chain;
    };
    if (masterEffects != nullptr)
        plan.masterChain = addChain(*masterEffects, masterAutomation, {});
    if (masterAutomation != nullptr) {
        if (const auto* lane = activeLane(*masterAutomation, "volume"))
            plan.masterLane = addLane(*lane, LaneKind::gain, -1, -1, 0.0f, 4.0f);
    }

    const size_t busCount = std::min<size_t>(buses.size(), static_cast<size_t>(kMaxBuses));
    std::vector<ProjectBus> active(buses.begin(), buses.begin() + static_cast<std::ptrdiff_t>(busCount));

    // Resolved output per bus (-1 = master). Anything invalid falls back to the master.
    std::vector<int> output(busCount, -1);
    for (size_t i = 0; i < busCount; ++i) {
        if (checkBusOutput(active, active[i].id, active[i].output).empty() && active[i].output != kMasterBusId)
            output[i] = busIndex(active, active[i].output);
    }

    // Extra edges for bus outputs that are fading out after a route change.
    struct FadeEdge { int from; int to; size_t feed; };
    std::vector<FadeEdge> fadeEdges;
    auto reachable = [&](int start, int target) {
        std::vector<int> stack { start };
        std::vector<char> seen(busCount, 0);
        while (!stack.empty()) {
            const int at = stack.back();
            stack.pop_back();
            if (at == target)
                return true;
            if (at < 0 || seen[static_cast<size_t>(at)])
                continue;
            seen[static_cast<size_t>(at)] = 1;
            stack.push_back(output[static_cast<size_t>(at)]);
            for (const auto& edge : fadeEdges) {
                if (edge.from == at)
                    stack.push_back(edge.to);
            }
        }
        return false;
    };
    if (previous != nullptr) {
        for (size_t f = 0; f < previous->feeds.size() && f < previous->feedFrom.size(); ++f) {
            const auto& from = previous->feedFrom[f];
            if (from.rfind("b:", 0) != 0 || previous->feedAge[f] >= kFadeGenerations)
                continue;
            const int a = busIndex(active, from.substr(2));
            const int b = busIndex(active, previous->feedTo[f]);
            if (a < 0 || b < 0 || output[static_cast<size_t>(a)] == b)
                continue;
            if (!reachable(b, a))
                fadeEdges.push_back({ a, b, f });
        }
    }

    // Topological order: a bus is processed after everything that feeds it.
    std::vector<int> indegree(busCount, 0);
    for (size_t i = 0; i < busCount; ++i) {
        if (output[i] >= 0)
            ++indegree[static_cast<size_t>(output[i])];
    }
    for (const auto& edge : fadeEdges)
        ++indegree[static_cast<size_t>(edge.to)];
    std::vector<int> order;
    std::vector<char> placed(busCount, 0);
    while (order.size() < busCount) {
        bool progressed = false;
        for (size_t i = 0; i < busCount; ++i) {
            if (placed[i] || indegree[i] != 0)
                continue;
            placed[i] = 1;
            order.push_back(static_cast<int>(i));
            progressed = true;
            if (output[i] >= 0)
                --indegree[static_cast<size_t>(output[i])];
            for (const auto& edge : fadeEdges) {
                if (edge.from == static_cast<int>(i))
                    --indegree[static_cast<size_t>(edge.to)];
            }
        }
        if (!progressed) {
            // Unreachable after the checks above; route the remainder straight to the master.
            for (size_t i = 0; i < busCount; ++i) {
                if (!placed[i]) {
                    placed[i] = 1;
                    output[i] = -1;
                    order.push_back(static_cast<int>(i));
                }
            }
        }
    }
    std::vector<int> slot(busCount, -1);
    for (size_t k = 0; k < order.size(); ++k)
        slot[static_cast<size_t>(order[k])] = static_cast<int>(k);
    auto destSlot = [&](const std::string& id) {
        if (id == kMasterBusId)
            return kMasterDest;
        const int index = busIndex(active, id);
        return index < 0 ? -2 : slot[static_cast<size_t>(index)];
    };

    bool anySolo = false;
    for (const auto& track : tracks)
        anySolo = anySolo || track.solo;
    for (const auto& bus : active)
        anySolo = anySolo || bus.solo;

    auto addFeed = [&](const std::string& from, const std::string& to, int dest, uint64_t key, float l, float r, int age) {
        MixFeed feed;
        feed.dest = dest;
        feed.key = key;
        feed.targetL = l;
        feed.targetR = r;
        plan.feeds.push_back(feed);
        plan.feedFrom.push_back(from);
        plan.feedTo.push_back(to);
        plan.feedAge.push_back(age);
    };
    auto addFading = [&](const std::string& from, int sourceSlot, bool isBus) {
        if (previous == nullptr)
            return;
        for (size_t f = 0; f < previous->feeds.size() && f < previous->feedFrom.size(); ++f) {
            if (previous->feedFrom[f] != from || previous->feedAge[f] >= kFadeGenerations)
                continue;
            const auto key = previous->feeds[f].key;
            bool live = false;
            for (size_t g = 0; g < plan.feeds.size(); ++g)
                live = live || (plan.feeds[g].key == key && plan.feedFrom[g] == from);
            if (live)
                continue;
            const int dest = destSlot(previous->feedTo[f]);
            if (dest == -2 || (isBus && dest != kMasterDest && dest <= sourceSlot))
                continue;
            addFeed(from, previous->feedTo[f], dest, key, 0.0f, 0.0f, previous->feedAge[f] + 1);
        }
    };

    for (const auto& track : tracks) {
        const bool hasAudio = track.left != nullptr && track.right != nullptr && track.length > 0;
        if (!hasAudio && !track.armed)
            continue;
        bool included = track.solo;
        std::string at = track.output;
        for (size_t steps = 0; steps <= busCount && !included && at != kMasterBusId; ++steps) {
            const int index = busIndex(active, at);
            if (index < 0)
                break;
            included = active[static_cast<size_t>(index)].solo;
            at = active[static_cast<size_t>(index)].output;
        }
        const bool audible = !track.mute && (!anySolo || included);
        float panL = 1.0f;
        float panR = 1.0f;
        panLaw(track.pan, panL, panR);
        const float fader = std::isfinite(track.gain) ? std::clamp(track.gain, 0.0f, 4.0f) : 0.0f;

        MixSource source;
        source.left = hasAudio ? track.left : nullptr;
        source.right = hasAudio ? track.right : nullptr;
        source.length = hasAudio ? track.length : 0;
        source.chain = addChain(track.effects, &track.automation, {});
        if (track.armed) {
            MixInput input;
            input.key = recordInputKey(track.id);
            input.channels = static_cast<int>(track.recordInput);
            input.monitor = track.monitorInput;
            input.processed = track.processInput || track.monitorInput;
            if (input.processed)
                input.chain = addChain(track.effects, &track.automation, "rec:" + track.id + ":");
            if (input.monitor)
                source.monitorInput = static_cast<int>(plan.inputs.size());
            plan.inputs.push_back(input);
        }
        const auto* gainSource = activeLane(track.automation, "volume");
        const auto* panSource = activeLane(track.automation, "pan");
        const int gainLane = gainSource != nullptr ? addLane(*gainSource, LaneKind::gain, -1, -1, 0.0f, 4.0f) : -1;
        const int panLane = panSource != nullptr ? addLane(*panSource, LaneKind::pan, -1, -1, -1.0f, 1.0f) : -1;
        auto followFader = [&](float scale) {
            auto& feed = plan.feeds.back();
            feed.gainLane = gainLane;
            feed.panLane = panLane;
            feed.scale = scale;
            feed.gain = fader;
            feed.pan = std::isfinite(track.pan) ? std::clamp(track.pan, -1.0f, 1.0f) : 0.0f;
            feed.panned = true;
        };
        source.firstFeed = static_cast<int>(plan.feeds.size());
        const std::string from = "t:" + track.id;
        const std::string mainTo = checkTrackOutput(active, track.output).empty() ? track.output : std::string(kMasterBusId);
        source.meterFeed = static_cast<int>(plan.feeds.size());
        addFeed(from, mainTo, destSlot(mainTo), hashKey(from + ">" + mainTo),
                audible ? fader * panL : 0.0f, audible ? fader * panR : 0.0f, 0);
        followFader(audible ? 1.0f : 0.0f);
        std::vector<std::string> used;
        for (const auto& send : track.sends) {
            if (!checkSend(active, send.bus).empty() || std::find(used.begin(), used.end(), send.bus) != used.end())
                continue;
            used.push_back(send.bus);
            const auto* bus = findBus(active, send.bus);
            const bool open = !track.mute && (!anySolo || included || bus->solo);
            const float level = std::isfinite(send.level) ? std::clamp(send.level, 0.0f, 4.0f) : 0.0f;
            const float l = open ? (send.preFader ? level : level * fader * panL) : 0.0f;
            const float r = open ? (send.preFader ? level : level * fader * panR) : 0.0f;
            addFeed(from, send.bus, destSlot(send.bus), hashKey("s:" + track.id + ">" + send.bus), l, r, 0);
            if (!send.preFader)
                followFader(open ? level : 0.0f);
        }
        addFading(from, -1, false);
        source.feedCount = static_cast<int>(plan.feeds.size()) - source.firstFeed;
        plan.sources.push_back(source);
        plan.sourceIds.push_back(track.id);
    }

    for (size_t k = 0; k < order.size(); ++k) {
        const auto& bus = active[static_cast<size_t>(order[k])];
        const int target = output[static_cast<size_t>(order[k])];
        const std::string to = target < 0 ? std::string(kMasterBusId) : active[static_cast<size_t>(target)].id;
        const std::string from = "b:" + bus.id;
        const float gain = bus.mute || !std::isfinite(bus.gain) ? 0.0f : std::clamp(bus.gain, 0.0f, 4.0f);
        MixBus mixBus;
        mixBus.chain = addChain(bus.effects, &bus.automation, {});
        mixBus.firstFeed = static_cast<int>(plan.feeds.size());
        mixBus.meterFeed = mixBus.firstFeed;
        addFeed(from, to, destSlot(to), hashKey(from + ">" + to), gain, gain, 0);
        if (const auto* lane = activeLane(bus.automation, "volume")) {
            auto& feed = plan.feeds.back();
            feed.gainLane = addLane(*lane, LaneKind::gain, -1, -1, 0.0f, 4.0f);
            feed.scale = bus.mute ? 0.0f : 1.0f;
            feed.gain = std::isfinite(bus.gain) ? std::clamp(bus.gain, 0.0f, 4.0f) : 0.0f;
            feed.panned = false;
        }
        addFading(from, static_cast<int>(k), true);
        mixBus.feedCount = static_cast<int>(plan.feeds.size()) - mixBus.firstFeed;
        plan.buses.push_back(mixBus);
        plan.busIds.push_back(bus.id);
    }
    return plan;
}

} // namespace msp
