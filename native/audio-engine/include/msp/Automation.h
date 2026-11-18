#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

constexpr int kMaxAutomationPoints = 10000;
// Effect-parameter automation is applied at absolute positions that are multiples of this,
// so playback and export see the same parameter values whatever their block size.
constexpr int kAutomationBlock = 32;

struct AutomationPoint {
    int64_t time = 0;     // samples at the session sample rate (project files: the saved sampleRate)
    double value = 0.0;
    bool step = false;    // hold this value until the next point instead of ramping toward it
};

// One automated parameter. `param` is "volume", "pan", or "fx:<effectId>:<parameterName>".
// A lane is active when it is enabled and has at least one point. An active lane overrides the
// manual value of its parameter in playback, recording and export; turning it off (or deleting
// its points) returns the parameter to its manual value.
struct AutomationLane {
    std::string param;
    bool enabled = true;
    std::vector<AutomationPoint> points;   // sorted by time; equal times keep insertion order
};

inline bool automationActive(const AutomationLane& lane) {
    return lane.enabled && !lane.points.empty();
}

// Index of the last point with time <= `time`, or -1 before the first point.
inline int automationSegment(const AutomationPoint* points, int count, int64_t time) {
    int lo = 0;
    int hi = count;
    while (lo < hi) {
        const int mid = lo + (hi - lo) / 2;
        if (points[mid].time <= time)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo - 1;
}

// Value at `time` given its segment (see automationSegment). Before the first point the lane
// holds the first value, after the last point the last value. Between two points it ramps
// linearly, or holds the earlier point's value when that point is a step point.
inline double automationSegmentValue(const AutomationPoint* points, int count, int segment, int64_t time) {
    if (segment < 0)
        return points[0].value;
    if (segment >= count - 1)
        return points[count - 1].value;
    const auto& a = points[segment];
    const auto& b = points[segment + 1];
    if (a.step || b.time <= a.time)
        return a.value;
    const double t = static_cast<double>(time - a.time) / static_cast<double>(b.time - a.time);
    return a.value + (b.value - a.value) * t;
}

inline double automationValueAt(const AutomationPoint* points, int count, int64_t time) {
    return automationSegmentValue(points, count, automationSegment(points, count, time), time);
}

inline double automationValueAt(const AutomationLane& lane, int64_t time) {
    return automationValueAt(lane.points.data(), static_cast<int>(lane.points.size()), time);
}

const AutomationLane* findAutomationLane(const std::vector<AutomationLane>& lanes, const std::string& param);
AutomationLane* findAutomationLane(std::vector<AutomationLane>& lanes, const std::string& param);
// True when `lanes` has an active lane for `param`.
bool parameterAutomated(const std::vector<AutomationLane>& lanes, const std::string& param);

std::string effectAutomationParam(const std::string& effectId, const std::string& parameterName);
// Splits "fx:<effectId>:<parameterName>". Returns false for any other form.
bool parseEffectAutomationParam(const std::string& param, std::string& effectId, std::string& parameterName);

// Index at which a point at `time` is inserted: after every point with an equal or earlier time.
int automationInsertIndex(const std::vector<AutomationPoint>& points, int64_t time);

// Multiplies every point time by to/from (rounded), for sample-rate changes and export.
void scaleAutomation(std::vector<AutomationLane>& lanes, double fromRate, double toRate);

} // namespace msp
