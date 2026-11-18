#include "msp/Automation.h"

#include <algorithm>
#include <cmath>

namespace msp {

const AutomationLane* findAutomationLane(const std::vector<AutomationLane>& lanes, const std::string& param) {
    for (const auto& lane : lanes) {
        if (lane.param == param)
            return &lane;
    }
    return nullptr;
}

AutomationLane* findAutomationLane(std::vector<AutomationLane>& lanes, const std::string& param) {
    for (auto& lane : lanes) {
        if (lane.param == param)
            return &lane;
    }
    return nullptr;
}

bool parameterAutomated(const std::vector<AutomationLane>& lanes, const std::string& param) {
    const auto* lane = findAutomationLane(lanes, param);
    return lane != nullptr && automationActive(*lane);
}

std::string effectAutomationParam(const std::string& effectId, const std::string& parameterName) {
    return "fx:" + effectId + ":" + parameterName;
}

bool parseEffectAutomationParam(const std::string& param, std::string& effectId, std::string& parameterName) {
    if (param.rfind("fx:", 0) != 0)
        return false;
    const auto split = param.find(':', 3);
    if (split == std::string::npos || split == 3 || split + 1 >= param.size())
        return false;
    effectId = param.substr(3, split - 3);
    parameterName = param.substr(split + 1);
    return true;
}

int automationInsertIndex(const std::vector<AutomationPoint>& points, int64_t time) {
    const auto at = std::upper_bound(points.begin(), points.end(), time,
                                     [](int64_t t, const AutomationPoint& point) { return t < point.time; });
    return static_cast<int>(at - points.begin());
}

void scaleAutomation(std::vector<AutomationLane>& lanes, double fromRate, double toRate) {
    if (!(fromRate > 0.0) || !(toRate > 0.0) || std::abs(fromRate - toRate) < 0.5)
        return;
    for (auto& lane : lanes) {
        for (auto& point : lane.points)
            point.time = std::llround(static_cast<double>(point.time) * toRate / fromRate);
    }
}

} // namespace msp
