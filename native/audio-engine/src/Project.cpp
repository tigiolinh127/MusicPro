#include "msp/Project.h"

#include <juce_core/juce_core.h>

#include <cmath>

namespace msp {
namespace {
constexpr const char* kFormat = "music-studio-pro-project";

bool finiteInRange(double value, double minValue, double maxValue) {
    return std::isfinite(value) && value >= minValue && value <= maxValue;
}

juce::var effectsToVar(const std::vector<ProjectEffect>& effects) {
    juce::Array<juce::var> list;
    for (const auto& effect : effects) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", juce::String::fromUTF8(effect.id.c_str()));
        obj->setProperty("type", effectTypeName(effect.type));
        obj->setProperty("enabled", effect.enabled);
        auto* params = new juce::DynamicObject();
        const auto& spec = effectSpec(effect.type);
        for (int i = 0; i < spec.paramCount; ++i)
            params->setProperty(spec.params[i].name, static_cast<double>(effect.params[static_cast<size_t>(i)]));
        obj->setProperty("params", juce::var(params));
        list.add(juce::var(obj));
    }
    return list;
}

juce::var automationToVar(const std::vector<AutomationLane>& lanes) {
    juce::Array<juce::var> list;
    for (const auto& lane : lanes) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("param", juce::String::fromUTF8(lane.param.c_str()));
        obj->setProperty("enabled", lane.enabled);
        juce::Array<juce::var> points;
        for (const auto& point : lane.points) {
            auto* pointObj = new juce::DynamicObject();
            pointObj->setProperty("time", static_cast<juce::int64>(point.time));
            pointObj->setProperty("value", point.value);
            pointObj->setProperty("interpolation", point.step ? "step" : "linear");
            points.add(juce::var(pointObj));
        }
        obj->setProperty("points", points);
        list.add(juce::var(obj));
    }
    return list;
}

juce::var trackToVar(const ProjectTrack& track) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", juce::String::fromUTF8(track.id.c_str()));
    obj->setProperty("name", juce::String::fromUTF8(track.name.c_str()));
    obj->setProperty("path", juce::String::fromUTF8(track.path.c_str()));
    obj->setProperty("gain", track.gain);
    obj->setProperty("pan", track.pan);
    obj->setProperty("mute", track.mute);
    obj->setProperty("solo", track.solo);
    juce::Array<juce::var> clips;
    for (const auto& clip : track.clips) {
        auto* clipObj = new juce::DynamicObject();
        clipObj->setProperty("id", juce::String::fromUTF8(clip.id.c_str()));
        clipObj->setProperty("sourceFileId", juce::String::fromUTF8(clip.sourceFileId.c_str()));
        clipObj->setProperty("timelineStart", clip.timelineStart);
        clipObj->setProperty("sourceOffset", clip.sourceOffset);
        clipObj->setProperty("duration", clip.duration);
        clipObj->setProperty("fadeIn", clip.fadeIn);
        clipObj->setProperty("fadeOut", clip.fadeOut);
        if (!clip.fadeInCurve.empty())
            clipObj->setProperty("fadeInCurve", juce::String::fromUTF8(clip.fadeInCurve.c_str()));
        if (!clip.fadeOutCurve.empty())
            clipObj->setProperty("fadeOutCurve", juce::String::fromUTF8(clip.fadeOutCurve.c_str()));
        if (!clip.crossfadePartnerId.empty()) {
            clipObj->setProperty("crossfadePartnerId", juce::String::fromUTF8(clip.crossfadePartnerId.c_str()));
            if (!clip.crossfadeCurve.empty())
                clipObj->setProperty("crossfadeCurve", juce::String::fromUTF8(clip.crossfadeCurve.c_str()));
            clipObj->setProperty("crossfadeDuration", clip.crossfadeDuration);
        }
        clipObj->setProperty("gain", clip.gain);
        if (!clip.originalSourceFileId.empty()) {
            clipObj->setProperty("originalSourceFileId", juce::String::fromUTF8(clip.originalSourceFileId.c_str()));
            clipObj->setProperty("originalSourceOffset", clip.originalSourceOffset);
            clipObj->setProperty("pitchShiftCents", clip.pitchShiftCents);
            if (!clip.pitchLabel.empty())
                clipObj->setProperty("pitchLabel", juce::String::fromUTF8(clip.pitchLabel.c_str()));
        }
        if (!clip.noteTargets.empty()) {
            juce::Array<juce::var> targets;
            for (const auto& target : clip.noteTargets) {
                auto* item = new juce::DynamicObject();
                item->setProperty("clipId", juce::String::fromUTF8(target.clipId.c_str()));
                item->setProperty("sourceFileId", juce::String::fromUTF8(target.sourceFileId.c_str()));
                item->setProperty("sourceStart", target.sourceStart);
                item->setProperty("sourceEnd", target.sourceEnd);
                item->setProperty("originalMidi", target.originalMidi);
                item->setProperty("targetMidi", target.targetMidi);
                targets.add(juce::var(item));
            }
            clipObj->setProperty("noteTargets", targets);
        }
        if (!clip.timingMarkers.empty()) {
            juce::Array<juce::var> markers;
            for (const auto& marker : clip.timingMarkers) {
                auto* item = new juce::DynamicObject();
                item->setProperty("id", juce::String::fromUTF8(marker.id.c_str()));
                item->setProperty("sourceSample", static_cast<juce::int64>(marker.sourceSample));
                item->setProperty("manual", marker.manual);
                markers.add(juce::var(item));
            }
            clipObj->setProperty("timingMarkers", markers);
        }
        if (!clip.timingOriginalSourceFileId.empty()) {
            clipObj->setProperty("timingOriginalSourceFileId", juce::String::fromUTF8(clip.timingOriginalSourceFileId.c_str()));
            clipObj->setProperty("timingOriginalSourceOffset", static_cast<juce::int64>(clip.timingOriginalSourceOffset));
            clipObj->setProperty("timingOriginalDuration", static_cast<juce::int64>(clip.timingOriginalDuration));
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
                item->setProperty("kind", juce::String(breathKindName(region.kind)));
                item->setProperty("confidence", region.confidence);
                item->setProperty("gainDb", region.gainDb);
                item->setProperty("fadeIn", static_cast<juce::int64>(region.fadeIn));
                item->setProperty("fadeOut", static_cast<juce::int64>(region.fadeOut));
                item->setProperty("ignored", region.ignored);
                item->setProperty("manual", region.manual);
                regions.add(juce::var(item));
            }
            clipObj->setProperty("breathRegions", regions);
        }
        if (!clip.breathOriginalSourceFileId.empty()) {
            clipObj->setProperty("breathOriginalSourceFileId", juce::String::fromUTF8(clip.breathOriginalSourceFileId.c_str()));
            clipObj->setProperty("breathOriginalSourceOffset", static_cast<juce::int64>(clip.breathOriginalSourceOffset));
            clipObj->setProperty("breathOriginalDuration", static_cast<juce::int64>(clip.breathOriginalDuration));
            if (!clip.breathLabel.empty())
                clipObj->setProperty("breathLabel", juce::String::fromUTF8(clip.breathLabel.c_str()));
        }
        if (!clip.stretchOriginalSourceFileId.empty()) {
            clipObj->setProperty("stretchMode", juce::String::fromUTF8(clip.stretchMode.c_str()));
            clipObj->setProperty("stretchRatio", clip.stretchRatio);
            clipObj->setProperty("stretchOriginalSourceFileId", juce::String::fromUTF8(clip.stretchOriginalSourceFileId.c_str()));
            clipObj->setProperty("stretchOriginalSourceOffset", static_cast<juce::int64>(clip.stretchOriginalSourceOffset));
            clipObj->setProperty("stretchOriginalDuration", static_cast<juce::int64>(clip.stretchOriginalDuration));
            if (!clip.stretchLabel.empty())
                clipObj->setProperty("stretchLabel", juce::String::fromUTF8(clip.stretchLabel.c_str()));
        }
        clips.add(juce::var(clipObj));
    }
    obj->setProperty("clips", clips);
    juce::Array<juce::var> extras;
    for (const auto& extra : track.extras) {
        auto* extraObj = new juce::DynamicObject();
        extraObj->setProperty("id", juce::String::fromUTF8(extra.id.c_str()));
        extraObj->setProperty("path", juce::String::fromUTF8(extra.path.c_str()));
        extras.add(juce::var(extraObj));
    }
    obj->setProperty("extras", extras);
    obj->setProperty("output", juce::String::fromUTF8(track.output.c_str()));
    juce::Array<juce::var> sends;
    for (const auto& send : track.sends) {
        auto* sendObj = new juce::DynamicObject();
        sendObj->setProperty("bus", juce::String::fromUTF8(send.bus.c_str()));
        sendObj->setProperty("level", send.level);
        sendObj->setProperty("preFader", send.preFader);
        sends.add(juce::var(sendObj));
    }
    obj->setProperty("sends", sends);
    obj->setProperty("effects", effectsToVar(track.effects));
    obj->setProperty("automation", automationToVar(track.automation));
    if (!track.vocalPresetId.empty()) {
        obj->setProperty("vocalPresetId", juce::String::fromUTF8(track.vocalPresetId.c_str()));
        obj->setProperty("vocalPresetBypassed", track.vocalPresetBypassed);
        if (!track.vocalPresetPrevious.empty())
            obj->setProperty("vocalPresetPrevious", effectsToVar(track.vocalPresetPrevious));
    }
    auto* record = new juce::DynamicObject();
    record->setProperty("armed", track.armed);
    record->setProperty("input", recordInputName(track.recordInput));
    record->setProperty("mode", recordModeName(track.recordMode));
    record->setProperty("monitor", track.monitorInput);
    obj->setProperty("record", juce::var(record));
    juce::Array<juce::var> takes;
    for (const auto& take : track.takes) {
        auto* takeObj = new juce::DynamicObject();
        takeObj->setProperty("id", juce::String::fromUTF8(take.id.c_str()));
        takeObj->setProperty("name", juce::String::fromUTF8(take.name.c_str()));
        takeObj->setProperty("sourceFileId", juce::String::fromUTF8(take.sourceFileId.c_str()));
        takeObj->setProperty("timelineStart", static_cast<juce::int64>(take.timelineStart));
        takeObj->setProperty("duration", static_cast<juce::int64>(take.duration));
        takeObj->setProperty("muted", take.muted);
        takes.add(juce::var(takeObj));
    }
    obj->setProperty("takes", takes);
    obj->setProperty("takesExpanded", track.takesExpanded);
    obj->setProperty("compCrossfadeMs", track.compCrossfadeMs);
    if (track.autoCrossfadeEnabled || track.autoCrossfadeMs != 20.0 || !track.autoCrossfadeCurve.empty()) {
        obj->setProperty("autoCrossfadeEnabled", track.autoCrossfadeEnabled);
        obj->setProperty("autoCrossfadeMs", track.autoCrossfadeMs);
        if (!track.autoCrossfadeCurve.empty())
            obj->setProperty("autoCrossfadeCurve", juce::String::fromUTF8(track.autoCrossfadeCurve.c_str()));
    }
    return juce::var(obj);
}

juce::var busToVar(const ProjectBus& bus) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", juce::String::fromUTF8(bus.id.c_str()));
    obj->setProperty("name", juce::String::fromUTF8(bus.name.c_str()));
    obj->setProperty("kind", busKindName(bus.kind));
    obj->setProperty("gain", bus.gain);
    obj->setProperty("mute", bus.mute);
    obj->setProperty("solo", bus.solo);
    obj->setProperty("output", juce::String::fromUTF8(bus.output.c_str()));
    obj->setProperty("effects", effectsToVar(bus.effects));
    obj->setProperty("automation", automationToVar(bus.automation));
    return juce::var(obj);
}

bool isNumberVar(const juce::var& value) {
    return value.isDouble() || value.isInt() || value.isInt64();
}

// Version 5 automation lanes. Structural damage drops the entry with a warning; whether a
// parameter exists and its value range are checked by the session after effects are loaded.
std::vector<AutomationLane> readAutomation(const juce::var& list, const std::string& owner, ProjectData& project) {
    std::vector<AutomationLane> lanes;
    if (list.isVoid())
        return lanes;
    if (!list.isArray()) {
        project.warnings.push_back(owner + " had an invalid automation list. Its automation was removed.");
        return lanes;
    }
    for (const auto& item : *list.getArray()) {
        const auto param = item.getProperty("param", {});
        const auto points = item.getProperty("points", {});
        if (!item.isObject() || !param.isString() || param.toString().isEmpty() || !points.isArray()) {
            project.warnings.push_back(owner + " had an automation lane without a parameter or point list. It was removed.");
            continue;
        }
        AutomationLane lane;
        lane.param = param.toString().toStdString();
        const auto enabled = item.getProperty("enabled", {});
        lane.enabled = !enabled.isBool() || static_cast<bool>(enabled);
        bool damaged = !enabled.isVoid() && !enabled.isBool();
        for (const auto& pointVar : *points.getArray()) {
            const auto time = pointVar.getProperty("time", {});
            const auto value = pointVar.getProperty("value", {});
            const auto interpolation = pointVar.getProperty("interpolation", {}).toString();
            if (!pointVar.isObject() || !isNumberVar(time) || !isNumberVar(value)
                || !std::isfinite(static_cast<double>(time)) || static_cast<double>(time) < 0.0) {
                damaged = true;
                continue;
            }
            AutomationPoint point;
            point.time = static_cast<int64_t>(std::llround(static_cast<double>(time)));
            point.value = static_cast<double>(value);
            point.step = interpolation == "step";
            damaged = damaged || (interpolation != "step" && interpolation != "linear");
            lane.points.push_back(point);
        }
        if (damaged)
            project.warnings.push_back(owner + " automation for " + lane.param + " had unreadable points or settings. They were removed or reset.");
        lanes.push_back(std::move(lane));
    }
    return lanes;
}

void readTrackRecord(juce::DynamicObject* trackObj, ProjectTrack& track, ProjectData& project) {
    const auto record = trackObj->getProperty("record");
    if (record.isVoid())
        return;
    auto* obj = record.getDynamicObject();
    if (obj == nullptr) {
        project.warnings.push_back("Track " + track.id + " had unreadable recording settings. They were reset.");
        return;
    }
    bool damaged = false;
    const auto armed = obj->getProperty("armed");
    const auto monitor = obj->getProperty("monitor");
    track.armed = armed.isBool() && static_cast<bool>(armed);
    track.monitorInput = monitor.isBool() && static_cast<bool>(monitor);
    damaged = (!armed.isVoid() && !armed.isBool()) || (!monitor.isVoid() && !monitor.isBool());
    const auto input = obj->getProperty("input");
    if (!input.isVoid() && !recordInputFromName(input.toString().toStdString(), track.recordInput))
        damaged = true;
    const auto mode = obj->getProperty("mode");
    if (!mode.isVoid() && !recordModeFromName(mode.toString().toStdString(), track.recordMode))
        damaged = true;
    if (damaged)
        project.warnings.push_back("Track " + track.id + " had invalid recording settings. They were reset to their defaults.");
}

// Version 4 effect chains. Damaged entries are repaired or dropped with a warning; an effect
// problem never stops the project from loading. Missing ids are filled in by the session.
std::vector<ProjectEffect> readEffects(const juce::var& list, const std::string& owner, ProjectData& project) {
    std::vector<ProjectEffect> effects;
    if (list.isVoid())
        return effects;
    if (!list.isArray()) {
        project.warnings.push_back(owner + " had an invalid effect list. Its effects were removed.");
        return effects;
    }
    for (const auto& item : *list.getArray()) {
        if (!item.isObject()) {
            project.warnings.push_back(owner + " had an effect entry that was not an object. It was removed.");
            continue;
        }
        EffectType type;
        const auto typeName = item.getProperty("type", {}).toString().toStdString();
        if (!effectTypeFromName(typeName, type)) {
            project.warnings.push_back(owner + " had an effect of unknown type \"" + typeName + "\". It was removed.");
            continue;
        }
        if (static_cast<int>(effects.size()) >= kMaxEffectsPerChain) {
            project.warnings.push_back(owner + " had more than " + std::to_string(kMaxEffectsPerChain) + " effects. The extra effects were removed.");
            break;
        }
        ProjectEffect effect = makeEffect(type, item.getProperty("id", {}).toString().toStdString());
        if (effect.id.size() > 64)
            effect.id.clear();
        const auto enabled = item.getProperty("enabled", {});
        effect.enabled = !enabled.isBool() || static_cast<bool>(enabled);
        const auto params = item.getProperty("params", {});
        const auto& spec = effectSpec(type);
        std::vector<std::string> bad;
        if (!enabled.isVoid() && !enabled.isBool())
            bad.push_back("enabled");
        for (int i = 0; i < spec.paramCount; ++i) {
            const auto value = params.getProperty(spec.params[i].name, {});
            if (value.isVoid())
                continue;
            if (isNumberVar(value))
                effect.params[static_cast<size_t>(i)] = static_cast<float>(static_cast<double>(value));
            else
                bad.push_back(spec.params[i].name);
        }
        for (const auto& name : sanitizeEffectParams(type, effect.params))
            bad.push_back(name);
        if (!bad.empty()) {
            std::string names;
            for (const auto& name : bad)
                names += (names.empty() ? "" : ", ") + name;
            project.warnings.push_back(owner + " effect " + typeName + " had invalid values (" + names + "). They were reset or limited to the allowed range.");
        }
        effects.push_back(effect);
    }
    return effects;
}

// Version 3 mixer data is repaired rather than rejected so a damaged routing table never drops clips.
void readBuses(const juce::var& list, ProjectData& project) {
    if (list.isVoid())
        return;
    if (!list.isArray()) {
        project.warnings.push_back("The project bus list was not a list. All tracks were routed to the master.");
        return;
    }
    for (const auto& item : *list.getArray()) {
        if (!item.isObject()) {
            project.warnings.push_back("A bus entry was not an object and was removed.");
            continue;
        }
        ProjectBus bus;
        bus.id = item.getProperty("id", {}).toString().toStdString();
        bus.name = item.getProperty("name", {}).toString().toStdString();
        const auto kind = item.getProperty("kind", {}).toString();
        if (bus.id.empty() || bus.id.size() > 64 || bus.id == kMasterBusId) {
            project.warnings.push_back("A bus had a missing or reserved id and was removed.");
            continue;
        }
        if (kind == "group")
            bus.kind = BusKind::group;
        else if (kind == "return")
            bus.kind = BusKind::ret;
        else {
            project.warnings.push_back("Bus " + bus.id + " had an unknown kind and was removed.");
            continue;
        }
        bool duplicate = false;
        for (const auto& existing : project.buses)
            duplicate = duplicate || existing.id == bus.id;
        if (duplicate) {
            project.warnings.push_back("Bus " + bus.id + " was listed twice. The second copy was removed.");
            continue;
        }
        const auto gain = item.getProperty("gain", {});
        if (isNumberVar(gain) && finiteInRange(static_cast<double>(gain), 0.0, 4.0))
            bus.gain = static_cast<float>(static_cast<double>(gain));
        else
            project.warnings.push_back("Bus " + bus.id + " had an invalid gain. It was reset to 0 dB.");
        const auto mute = item.getProperty("mute", {});
        const auto solo = item.getProperty("solo", {});
        bus.mute = mute.isBool() && static_cast<bool>(mute);
        bus.solo = solo.isBool() && static_cast<bool>(solo);
        const auto output = item.getProperty("output", {});
        bus.output = output.isString() && output.toString().isNotEmpty() ? output.toString().toStdString() : std::string(kMasterBusId);
        if (bus.name.empty())
            bus.name = bus.id;
        if (project.version >= 4)
            bus.effects = readEffects(item.getProperty("effects", {}), "Bus " + bus.name, project);
        if (project.version >= 5)
            bus.automation = readAutomation(item.getProperty("automation", {}), "Bus " + bus.name, project);
        project.buses.push_back(bus);
    }
}

void readTrackRouting(juce::DynamicObject* trackObj, ProjectTrack& track, ProjectData& project) {
    const auto output = trackObj->getProperty("output");
    if (output.isString() && output.toString().isNotEmpty())
        track.output = output.toString().toStdString();
    else if (!output.isVoid())
        project.warnings.push_back("Track " + track.id + " had an invalid output. It was routed to the master.");
    const auto sends = trackObj->getProperty("sends");
    if (sends.isVoid())
        return;
    if (!sends.isArray()) {
        project.warnings.push_back("Track " + track.id + " had an invalid send list. Its sends were removed.");
        return;
    }
    for (const auto& item : *sends.getArray()) {
        ProjectSend send;
        const auto level = item.getProperty("level", {});
        const auto pre = item.getProperty("preFader", {});
        send.bus = item.getProperty("bus", {}).toString().toStdString();
        if (!item.isObject() || send.bus.empty() || !isNumberVar(level) || !finiteInRange(static_cast<double>(level), 0.0, 4.0)) {
            project.warnings.push_back("Track " + track.id + " had an invalid send. It was removed.");
            continue;
        }
        send.level = static_cast<float>(static_cast<double>(level));
        send.preFader = pre.isBool() && static_cast<bool>(pre);
        track.sends.push_back(send);
    }
}
} // namespace

const char* busKindName(BusKind kind) {
    return kind == BusKind::ret ? "return" : "group";
}

const char* recordInputName(RecordInput input) {
    switch (input) {
        case RecordInput::first: return "1";
        case RecordInput::second: return "2";
        case RecordInput::stereo: return "1+2";
    }
    return "1";
}

bool recordInputFromName(const std::string& name, RecordInput& input) {
    if (name == "1")
        input = RecordInput::first;
    else if (name == "2")
        input = RecordInput::second;
    else if (name == "1+2")
        input = RecordInput::stereo;
    else
        return false;
    return true;
}

const char* recordModeName(RecordMode mode) {
    switch (mode) {
        case RecordMode::dry: return "dry";
        case RecordMode::processed: return "processed";
        case RecordMode::both: return "both";
    }
    return "dry";
}

bool recordModeFromName(const std::string& name, RecordMode& mode) {
    if (name == "dry")
        mode = RecordMode::dry;
    else if (name == "processed")
        mode = RecordMode::processed;
    else if (name == "both")
        mode = RecordMode::both;
    else
        return false;
    return true;
}

std::string makeProjectId() {
    return juce::Uuid().toDashedString().toStdString();
}

std::string saveProjectFile(const std::string& path, const ProjectData& project) {
    auto* root = new juce::DynamicObject();
    root->setProperty("format", kFormat);
    root->setProperty("version", project.version);
    root->setProperty("masterGain", project.masterGain);
    root->setProperty("monitorEnabled", project.monitorEnabled);
    root->setProperty("sampleRate", project.sampleRate);
    root->setProperty("bufferSize", project.bufferSize);
    root->setProperty("outputDevice", juce::String::fromUTF8(project.outputDevice.c_str()));
    root->setProperty("inputDevice", juce::String::fromUTF8(project.inputDevice.c_str()));
    if (!project.projectId.empty())
        root->setProperty("projectId", juce::String::fromUTF8(project.projectId.c_str()));
    if (!project.projectName.empty())
        root->setProperty("projectName", juce::String::fromUTF8(project.projectName.c_str()));
    juce::Array<juce::var> tracks;
    for (const auto& track : project.tracks)
        tracks.add(trackToVar(track));
    root->setProperty("tracks", tracks);
    juce::Array<juce::var> buses;
    for (const auto& bus : project.buses)
        buses.add(busToVar(bus));
    root->setProperty("buses", buses);
    root->setProperty("masterEffects", effectsToVar(project.masterEffects));
    root->setProperty("masterAutomation", automationToVar(project.masterAutomation));
    auto* tail = new juce::DynamicObject();
    tail->setProperty("enabled", project.renderTail.enabled);
    tail->setProperty("maxSeconds", project.renderTail.maxSeconds);
    tail->setProperty("thresholdDb", project.renderTail.thresholdDb);
    root->setProperty("renderTail", juce::var(tail));
    auto* mapping = new juce::DynamicObject();
    mapping->setProperty("enabled", project.pitchMapping.enabled);
    mapping->setProperty("root", pitchClassName(project.pitchMapping.key.root));
    mapping->setProperty("scale", scaleTypeName(project.pitchMapping.key.scale));
    mapping->setProperty("tieBreak", tieBreakName(project.pitchMapping.settings.tieBreak));
    mapping->setProperty("toleranceCents", project.pitchMapping.settings.toleranceCents);
    root->setProperty("pitchMapping", juce::var(mapping));
    if (!project.customVocalPresets.empty()) {
        juce::Array<juce::var> customs;
        for (const auto& preset : project.customVocalPresets) {
            auto* presetObj = new juce::DynamicObject();
            presetObj->setProperty("id", juce::String::fromUTF8(preset.id.c_str()));
            presetObj->setProperty("name", juce::String::fromUTF8(preset.name.c_str()));
            presetObj->setProperty("factory", false);
            juce::Array<juce::var> effects;
            for (const auto& effect : preset.effects) {
                auto* effectObj = new juce::DynamicObject();
                effectObj->setProperty("type", effectTypeName(effect.type));
                effectObj->setProperty("enabled", effect.enabled);
                auto* params = new juce::DynamicObject();
                const auto& spec = effectSpec(effect.type);
                for (int i = 0; i < spec.paramCount; ++i)
                    params->setProperty(spec.params[i].name, static_cast<double>(effect.params[static_cast<size_t>(i)]));
                effectObj->setProperty("params", juce::var(params));
                effects.add(juce::var(effectObj));
            }
            presetObj->setProperty("effects", effects);
            customs.add(juce::var(presetObj));
        }
        root->setProperty("customVocalPresets", customs);
    }

    juce::File file(juce::String::fromUTF8(path.c_str()));
    auto parent = file.getParentDirectory();
    if (!parent.exists() && !parent.createDirectory())
        return "Could not create the project folder.";
    const auto json = juce::JSON::toString(juce::var(root), true);
    // Validate serialization before publishing (malformed DynamicObject would fail parse).
    if (!juce::JSON::parse(json).isObject())
        return "Could not serialize a valid project document.";
    // Atomic publish: write a sibling temp file, then replace the destination.
    const auto temp = parent.getChildFile(file.getFileName() + ".msp-tmp-" + juce::Uuid().toString().substring(0, 8));
    if (!temp.replaceWithText(json))
        return "Could not write the temporary project file.";
    if (file.existsAsFile() && !file.deleteFile()) {
        temp.deleteFile();
        return "Could not replace the existing project file.";
    }
    if (!temp.moveFileTo(file)) {
        // Fallback: copy then delete temp (cross-volume rename).
        if (!temp.copyFileTo(file)) {
            temp.deleteFile();
            return "Could not write the project file.";
        }
        temp.deleteFile();
    }
    return {};
}

ProjectData loadProjectFile(const std::string& path) {
    ProjectData project;
    juce::File file(juce::String::fromUTF8(path.c_str()));
    if (!file.existsAsFile()) {
        project.error = "Project file not found: " + path;
        return project;
    }
    const auto text = file.loadFileAsString();
    const auto parsed = juce::JSON::parse(text);
    if (!parsed.isObject()) {
        project.error = "Project file is not valid JSON.";
        return project;
    }
    auto* obj = parsed.getDynamicObject();
    if (obj->getProperty("format").toString() != kFormat) {
        project.error = "This file is not a Music Studio Pro project.";
        return project;
    }
    const auto version = obj->getProperty("version");
    if (!version.isInt() && !version.isInt64() && !version.isDouble()) {
        project.error = "Project version is missing.";
        return project;
    }
    project.version = static_cast<int>(version);
    if (project.version < 1 || project.version > kCurrentProjectVersion) {
        project.error = "Unsupported project version. This build opens project versions 1 to 6.";
        return project;
    }

    const double master = obj->getProperty("masterGain");
    const double rate = obj->getProperty("sampleRate");
    const double buffer = obj->getProperty("bufferSize");
    const double panCheck = 0.0;
    (void) panCheck;
    if (!finiteInRange(master, 0.0, 4.0)) {
        project.error = "Project master gain must be between 0 and 4.";
        return project;
    }
    if (!finiteInRange(rate, 8000.0, 192000.0)) {
        project.error = "Project sample rate is invalid.";
        return project;
    }
    if (!finiteInRange(buffer, 32.0, 8192.0)) {
        project.error = "Project buffer size is invalid.";
        return project;
    }
    project.masterGain = static_cast<float>(master);
    project.sampleRate = rate;
    project.bufferSize = static_cast<int>(buffer);
    const auto monitor = obj->getProperty("monitorEnabled");
    if (!monitor.isBool()) {
        project.error = "Project monitor flag is missing.";
        return project;
    }
    project.monitorEnabled = static_cast<bool>(monitor);
    project.outputDevice = obj->getProperty("outputDevice").toString().toStdString();
    project.inputDevice = obj->getProperty("inputDevice").toString().toStdString();
    if (obj->hasProperty("projectId") && obj->getProperty("projectId").isString())
        project.projectId = obj->getProperty("projectId").toString().toStdString();
    if (obj->hasProperty("projectName") && obj->getProperty("projectName").isString())
        project.projectName = obj->getProperty("projectName").toString().toStdString();
    if (project.projectId.empty())
        project.projectId = makeProjectId();

    const auto tracks = obj->getProperty("tracks");
    if (!tracks.isArray()) {
        project.error = "Project tracks must be a list.";
        return project;
    }
    for (const auto& item : *tracks.getArray()) {
        if (!item.isObject()) {
            project.error = "A project track entry is not an object.";
            return project;
        }
        auto* trackObj = item.getDynamicObject();
        ProjectTrack track;
        track.id = trackObj->getProperty("id").toString().toStdString();
        track.path = trackObj->getProperty("path").toString().toStdString();
        if (track.id.empty() || (track.path.empty() && project.version < 2)) {
            project.error = "Each project track needs an id and a file path.";
            return project;
        }
        const double gain = trackObj->getProperty("gain");
        const double pan = trackObj->getProperty("pan");
        if (!finiteInRange(gain, 0.0, 4.0) || !finiteInRange(pan, -1.0, 1.0)) {
            project.error = "A project track has a gain or pan value outside the allowed range.";
            return project;
        }
        if (!trackObj->getProperty("mute").isBool() || !trackObj->getProperty("solo").isBool()) {
            project.error = "A project track is missing mute or solo.";
            return project;
        }
        track.gain = static_cast<float>(gain);
        track.pan = static_cast<float>(pan);
        track.mute = static_cast<bool>(trackObj->getProperty("mute"));
        track.solo = static_cast<bool>(trackObj->getProperty("solo"));
        track.name = trackObj->getProperty("name").toString().toStdString();
        if (project.version >= 2) {
            track.explicitClips = true;
            const auto clips = trackObj->getProperty("clips");
            if (!clips.isArray()) {
                project.error = "A version 2 track is missing its clip list.";
                return project;
            }
            for (const auto& clipVar : *clips.getArray()) {
                if (!clipVar.isObject()) {
                    project.error = "A clip entry is not an object.";
                    return project;
                }
                auto* clipObj = clipVar.getDynamicObject();
                ProjectClip clip;
                clip.id = clipObj->getProperty("id").toString().toStdString();
                clip.sourceFileId = clipObj->getProperty("sourceFileId").toString().toStdString();
                if (clip.id.empty() || clip.sourceFileId.empty()) {
                    project.error = "Each clip needs an id and a source file id.";
                    return project;
                }
                clip.timelineStart = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("timelineStart")));
                clip.sourceOffset = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("sourceOffset")));
                clip.duration = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("duration")));
                clip.fadeIn = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("fadeIn")));
                clip.fadeOut = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("fadeOut")));
                {
                    const auto inCurve = clipObj->getProperty("fadeInCurve");
                    if (inCurve.isString())
                        clip.fadeInCurve = inCurve.toString().substring(0, 32).toStdString();
                    const auto outCurve = clipObj->getProperty("fadeOutCurve");
                    if (outCurve.isString())
                        clip.fadeOutCurve = outCurve.toString().substring(0, 32).toStdString();
                    const auto partner = clipObj->getProperty("crossfadePartnerId");
                    if (partner.isString())
                        clip.crossfadePartnerId = partner.toString().toStdString();
                    const auto xfCurve = clipObj->getProperty("crossfadeCurve");
                    if (xfCurve.isString())
                        clip.crossfadeCurve = xfCurve.toString().substring(0, 32).toStdString();
                    const auto xfDur = clipObj->getProperty("crossfadeDuration");
                    if (isNumberVar(xfDur))
                        clip.crossfadeDuration = static_cast<int64_t>(static_cast<double>(xfDur));
                }
                clip.gain = static_cast<float>(static_cast<double>(clipObj->getProperty("gain")));
                if (clip.timelineStart < 0 || clip.sourceOffset < 0 || clip.duration <= 0 || clip.fadeIn < 0 || clip.fadeOut < 0) {
                    project.error = "A clip has a negative position, fade, or duration.";
                    return project;
                }
                const auto original = clipObj->getProperty("originalSourceFileId");
                if (original.isString() && original.toString().isNotEmpty()) {
                    clip.originalSourceFileId = original.toString().toStdString();
                    clip.originalSourceOffset = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("originalSourceOffset")));
                    clip.pitchShiftCents = static_cast<double>(clipObj->getProperty("pitchShiftCents"));
                    const auto label = clipObj->getProperty("pitchLabel");
                    if (label.isString())
                        clip.pitchLabel = label.toString().substring(0, 200).toStdString();
                    if (clip.originalSourceOffset < 0 || !std::isfinite(clip.pitchShiftCents)) {
                        project.warnings.push_back("Clip " + clip.id + " had invalid pitch-processing data; it plays its processed audio and cannot be reverted.");
                        clip.originalSourceFileId.clear();
                        clip.originalSourceOffset = 0;
                        clip.pitchShiftCents = 0.0;
                        clip.pitchLabel.clear();
                    }
                }
                const auto targets = clipObj->getProperty("noteTargets");
                if (targets.isArray()) {
                    int dropped = 0;
                    for (const auto& item : *targets.getArray()) {
                        NoteTarget target;
                        target.clipId = item.getProperty("clipId", {}).toString().toStdString();
                        target.sourceFileId = item.getProperty("sourceFileId", {}).toString().toStdString();
                        const auto start = item.getProperty("sourceStart", {});
                        const auto end = item.getProperty("sourceEnd", {});
                        const auto originalPitch = item.getProperty("originalMidi", {});
                        const auto midi = item.getProperty("targetMidi", {});
                        const bool numbers = isNumberVar(start) && isNumberVar(end) && isNumberVar(originalPitch) && isNumberVar(midi);
                        const double midiValue = numbers ? static_cast<double>(midi) : -1.0;
                        if (numbers) {
                            target.sourceStart = static_cast<double>(start);
                            target.sourceEnd = static_cast<double>(end);
                            target.originalMidi = static_cast<double>(originalPitch);
                        }
                        if (!numbers || target.clipId.empty() || target.sourceFileId.empty() || !std::isfinite(target.sourceStart)
                            || !std::isfinite(target.sourceEnd) || target.sourceStart < 0.0 || target.sourceEnd <= target.sourceStart
                            || !std::isfinite(target.originalMidi) || !(midiValue >= 0.0 && midiValue <= 127.0)
                            || midiValue != std::floor(midiValue)) {
                            ++dropped;
                            continue;
                        }
                        target.targetMidi = static_cast<int>(midiValue);
                        clip.noteTargets.push_back(target);
                    }
                    if (dropped > 0)
                        project.warnings.push_back("Clip " + clip.id + ": " + std::to_string(dropped) + " invalid manual target note(s) were ignored.");
                }
                const auto timingMarkers = clipObj->getProperty("timingMarkers");
                if (timingMarkers.isArray()) {
                    for (const auto& item : *timingMarkers.getArray()) {
                        if (!item.isObject())
                            continue;
                        TimingMarker marker;
                        marker.id = item.getProperty("id", {}).toString().toStdString();
                        const auto sample = item.getProperty("sourceSample", {});
                        if (marker.id.empty() || !isNumberVar(sample) || static_cast<double>(sample) < 0.0)
                            continue;
                        marker.sourceSample = static_cast<int64_t>(static_cast<double>(sample));
                        marker.manual = static_cast<bool>(item.getProperty("manual", false));
                        clip.timingMarkers.push_back(marker);
                    }
                    sortTimingMarkers(clip.timingMarkers);
                }
                const auto timingOriginal = clipObj->getProperty("timingOriginalSourceFileId");
                if (timingOriginal.isString() && timingOriginal.toString().isNotEmpty()) {
                    clip.timingOriginalSourceFileId = timingOriginal.toString().toStdString();
                    clip.timingOriginalSourceOffset = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("timingOriginalSourceOffset")));
                    clip.timingOriginalDuration = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("timingOriginalDuration")));
                    const auto timingLabel = clipObj->getProperty("timingLabel");
                    if (timingLabel.isString())
                        clip.timingLabel = timingLabel.toString().substring(0, 200).toStdString();
                    if (clip.timingOriginalSourceOffset < 0 || clip.timingOriginalDuration <= 0) {
                        project.warnings.push_back("Clip " + clip.id + " had invalid timing-processing data; markers were kept but revert may be unavailable.");
                        clip.timingOriginalSourceFileId.clear();
                        clip.timingOriginalSourceOffset = 0;
                        clip.timingOriginalDuration = 0;
                        clip.timingLabel.clear();
                    }
                }
                const auto breathRegions = clipObj->getProperty("breathRegions");
                if (breathRegions.isArray()) {
                    for (const auto& item : *breathRegions.getArray()) {
                        if (!item.isObject())
                            continue;
                        BreathRegion region;
                        region.id = item.getProperty("id", {}).toString().toStdString();
                        const auto start = item.getProperty("sourceStart", {});
                        const auto end = item.getProperty("sourceEnd", {});
                        if (region.id.empty() || !isNumberVar(start) || !isNumberVar(end))
                            continue;
                        region.sourceStart = static_cast<int64_t>(static_cast<double>(start));
                        region.sourceEnd = static_cast<int64_t>(static_cast<double>(end));
                        region.kind = breathKindFromName(item.getProperty("kind", "manual").toString().toStdString());
                        region.confidence = static_cast<float>(static_cast<double>(item.getProperty("confidence", 1.0)));
                        region.gainDb = static_cast<float>(static_cast<double>(item.getProperty("gainDb", 0.0)));
                        region.fadeIn = static_cast<int64_t>(static_cast<double>(item.getProperty("fadeIn", 0)));
                        region.fadeOut = static_cast<int64_t>(static_cast<double>(item.getProperty("fadeOut", 0)));
                        region.ignored = static_cast<bool>(item.getProperty("ignored", false));
                        region.manual = static_cast<bool>(item.getProperty("manual", false));
                        if (region.sourceEnd > region.sourceStart && std::isfinite(region.gainDb)
                            && std::isfinite(region.confidence))
                            clip.breathRegions.push_back(region);
                    }
                    sortBreathRegions(clip.breathRegions);
                }
                const auto breathOriginal = clipObj->getProperty("breathOriginalSourceFileId");
                if (breathOriginal.isString() && breathOriginal.toString().isNotEmpty()) {
                    clip.breathOriginalSourceFileId = breathOriginal.toString().toStdString();
                    clip.breathOriginalSourceOffset = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("breathOriginalSourceOffset")));
                    clip.breathOriginalDuration = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("breathOriginalDuration")));
                    const auto breathLabel = clipObj->getProperty("breathLabel");
                    if (breathLabel.isString())
                        clip.breathLabel = breathLabel.toString().substring(0, 200).toStdString();
                    if (clip.breathOriginalSourceOffset < 0 || clip.breathOriginalDuration <= 0) {
                        project.warnings.push_back("Clip " + clip.id + " had invalid breath-processing data; regions were kept but revert may be unavailable.");
                        clip.breathOriginalSourceFileId.clear();
                        clip.breathOriginalSourceOffset = 0;
                        clip.breathOriginalDuration = 0;
                        clip.breathLabel.clear();
                    }
                }
                const auto stretchOriginal = clipObj->getProperty("stretchOriginalSourceFileId");
                if (stretchOriginal.isString() && stretchOriginal.toString().isNotEmpty()) {
                    clip.stretchOriginalSourceFileId = stretchOriginal.toString().toStdString();
                    clip.stretchOriginalSourceOffset = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("stretchOriginalSourceOffset")));
                    clip.stretchOriginalDuration = static_cast<int64_t>(static_cast<double>(clipObj->getProperty("stretchOriginalDuration")));
                    {
                        const auto ratioVar = clipObj->getProperty("stretchRatio");
                        clip.stretchRatio = isNumberVar(ratioVar) ? static_cast<double>(ratioVar) : 1.0;
                    }
                    const auto stretchMode = clipObj->getProperty("stretchMode");
                    if (stretchMode.isString())
                        clip.stretchMode = stretchMode.toString().substring(0, 32).toStdString();
                    const auto stretchLabel = clipObj->getProperty("stretchLabel");
                    if (stretchLabel.isString())
                        clip.stretchLabel = stretchLabel.toString().substring(0, 200).toStdString();
                    if (clip.stretchOriginalSourceOffset < 0 || clip.stretchOriginalDuration <= 0 || !std::isfinite(clip.stretchRatio)) {
                        project.warnings.push_back("Clip " + clip.id + " had invalid stretch/speed data; revert may be unavailable.");
                        clip.stretchOriginalSourceFileId.clear();
                        clip.stretchOriginalSourceOffset = 0;
                        clip.stretchOriginalDuration = 0;
                        clip.stretchRatio = 1.0;
                        clip.stretchMode.clear();
                        clip.stretchLabel.clear();
                    }
                }
                track.clips.push_back(clip);
            }
            const auto extras = trackObj->getProperty("extras");
            if (extras.isArray()) {
                for (const auto& extraVar : *extras.getArray()) {
                    if (!extraVar.isObject()) {
                        project.error = "An extra source entry is not an object.";
                        return project;
                    }
                    ProjectSource extra;
                    extra.id = extraVar.getProperty("id", {}).toString().toStdString();
                    extra.path = extraVar.getProperty("path", {}).toString().toStdString();
                    if (extra.id.empty() || extra.path.empty()) {
                        project.error = "An extra source needs an id and a path.";
                        return project;
                    }
                    track.extras.push_back(extra);
                }
            }
        }
        if (project.version >= 3)
            readTrackRouting(trackObj, track, project);
        if (project.version >= 4)
            track.effects = readEffects(trackObj->getProperty("effects"), "Track " + (track.name.empty() ? track.id : track.name), project);
        if (project.version >= 5) {
            track.automation = readAutomation(trackObj->getProperty("automation"), "Track " + (track.name.empty() ? track.id : track.name), project);
            readTrackRecord(trackObj, track, project);
        }
        if (project.version >= 6) {
            track.takesExpanded = static_cast<bool>(trackObj->getProperty("takesExpanded"));
            const auto crossfade = trackObj->getProperty("compCrossfadeMs");
            if (isNumberVar(crossfade) && static_cast<double>(crossfade) >= 0.0 && static_cast<double>(crossfade) <= kMaxCompCrossfadeMs)
                track.compCrossfadeMs = static_cast<double>(crossfade);
            else if (trackObj->hasProperty("compCrossfadeMs"))
                project.warnings.push_back("Track " + (track.name.empty() ? track.id : track.name)
                                           + ": comp crossfade was not readable; using " + std::to_string(kDefaultCompCrossfadeMs) + " ms.");
            else
                track.compCrossfadeMs = kDefaultCompCrossfadeMs;
            track.autoCrossfadeEnabled = static_cast<bool>(trackObj->getProperty("autoCrossfadeEnabled"));
            {
                const auto autoMs = trackObj->getProperty("autoCrossfadeMs");
                if (isNumberVar(autoMs) && static_cast<double>(autoMs) >= 0.0 && static_cast<double>(autoMs) <= 5000.0)
                    track.autoCrossfadeMs = static_cast<double>(autoMs);
                const auto autoCurve = trackObj->getProperty("autoCrossfadeCurve");
                if (autoCurve.isString())
                    track.autoCrossfadeCurve = autoCurve.toString().substring(0, 32).toStdString();
            }
            const auto takes = trackObj->getProperty("takes");
            if (takes.isArray()) {
                for (const auto& takeVar : *takes.getArray()) {
                    if (!takeVar.isObject()) {
                        project.warnings.push_back("Track " + (track.name.empty() ? track.id : track.name)
                                                   + ": a take entry was ignored because it was not an object.");
                        continue;
                    }
                    ProjectTake take;
                    take.id = takeVar.getProperty("id", {}).toString().toStdString();
                    take.name = takeVar.getProperty("name", {}).toString().toStdString();
                    take.sourceFileId = takeVar.getProperty("sourceFileId", {}).toString().toStdString();
                    const auto start = takeVar.getProperty("timelineStart", {});
                    const auto duration = takeVar.getProperty("duration", {});
                    if (take.id.empty() || take.sourceFileId.empty() || !isNumberVar(start) || !isNumberVar(duration)
                        || static_cast<double>(start) < 0.0 || static_cast<double>(duration) <= 0.0) {
                        project.warnings.push_back("Track " + (track.name.empty() ? track.id : track.name)
                                                   + ": an invalid take was ignored.");
                        continue;
                    }
                    take.timelineStart = static_cast<int64_t>(static_cast<double>(start));
                    take.duration = static_cast<int64_t>(static_cast<double>(duration));
                    take.muted = takeVar.getProperty("muted", false);
                    if (take.name.empty())
                        take.name = take.id;
                    track.takes.push_back(take);
                }
            }
            const auto vocalPresetId = trackObj->getProperty("vocalPresetId");
            if (vocalPresetId.isString() && vocalPresetId.toString().isNotEmpty()) {
                track.vocalPresetId = vocalPresetId.toString().toStdString();
                track.vocalPresetBypassed = static_cast<bool>(trackObj->getProperty("vocalPresetBypassed"));
                if (trackObj->hasProperty("vocalPresetPrevious"))
                    track.vocalPresetPrevious = readEffects(trackObj->getProperty("vocalPresetPrevious"),
                                                            "Track " + (track.name.empty() ? track.id : track.name) + " vocalPresetPrevious",
                                                            project);
            }
        }
        project.tracks.push_back(track);
    }
    if (project.version >= 3)
        readBuses(obj->getProperty("buses"), project);
    if (project.version >= 4)
        project.masterEffects = readEffects(obj->getProperty("masterEffects"), "The master bus", project);
    if (project.version >= 5)
        project.masterAutomation = readAutomation(obj->getProperty("masterAutomation"), "The master bus", project);
    if (project.version >= 4 && obj->hasProperty("renderTail")) {
        const auto tail = obj->getProperty("renderTail");
        const TailSettings defaults;
        auto* tailObj = tail.getDynamicObject();
        if (tailObj == nullptr) {
            project.warnings.push_back("The effect tail settings were not readable. The defaults are used.");
        } else {
            const auto enabled = tailObj->getProperty("enabled");
            const auto maxSeconds = tailObj->getProperty("maxSeconds");
            const auto threshold = tailObj->getProperty("thresholdDb");
            const bool maxOk = isNumberVar(maxSeconds) && static_cast<double>(maxSeconds) >= 0.0 && static_cast<double>(maxSeconds) <= kMaxTailSeconds;
            const bool thresholdOk = isNumberVar(threshold) && static_cast<double>(threshold) >= kMinTailThresholdDb && static_cast<double>(threshold) <= kMaxTailThresholdDb;
            project.renderTail.enabled = enabled.isBool() ? static_cast<bool>(enabled) : defaults.enabled;
            project.renderTail.maxSeconds = maxOk ? static_cast<double>(maxSeconds) : defaults.maxSeconds;
            project.renderTail.thresholdDb = thresholdOk ? static_cast<double>(threshold) : defaults.thresholdDb;
            if (!enabled.isBool() || !maxOk || !thresholdOk)
                project.warnings.push_back("Some effect tail settings were invalid and were reset to their defaults (on, 10 s, -90 dBFS).");
        }
    }
    if (obj->hasProperty("pitchMapping")) {
        const auto mappingVar = obj->getProperty("pitchMapping");
        const PitchMapping defaults;
        auto* mappingObj = mappingVar.getDynamicObject();
        if (mappingObj == nullptr) {
            project.warnings.push_back("The key and scale settings were not readable. The defaults are used.");
        } else {
            const auto enabled = mappingObj->getProperty("enabled");
            const int root = pitchClassFromName(mappingObj->getProperty("root").toString().toStdString());
            ScaleType scale = defaults.key.scale;
            const bool scaleOk = scaleTypeFromName(mappingObj->getProperty("scale").toString().toStdString(), scale);
            TieBreak tie = defaults.settings.tieBreak;
            const bool tieOk = tieBreakFromName(mappingObj->getProperty("tieBreak").toString().toStdString(), tie);
            const auto tolerance = mappingObj->getProperty("toleranceCents");
            MappingSettings settings;
            settings.tieBreak = tie;
            settings.toleranceCents = isNumberVar(tolerance) ? static_cast<double>(tolerance) : -1.0;
            const bool toleranceOk = checkMappingSettings(settings).empty();
            project.pitchMapping.enabled = enabled.isBool() ? static_cast<bool>(enabled) : defaults.enabled;
            project.pitchMapping.key.root = root >= 0 ? root : defaults.key.root;
            project.pitchMapping.key.scale = scale;
            project.pitchMapping.settings.tieBreak = tie;
            project.pitchMapping.settings.toleranceCents = toleranceOk ? settings.toleranceCents : defaults.settings.toleranceCents;
            if (!enabled.isBool() || root < 0 || !scaleOk || !tieOk || !toleranceOk)
                project.warnings.push_back("Some key and scale settings were invalid and were reset to their defaults (C major, off).");
        }
    }
    if (obj->hasProperty("customVocalPresets")) {
        const auto customs = obj->getProperty("customVocalPresets");
        if (customs.isArray()) {
            for (const auto& item : *customs.getArray()) {
                if (!item.isObject()) {
                    project.warnings.push_back("A custom vocal preset entry was ignored because it was not an object.");
                    continue;
                }
                VocalPresetDefinition preset;
                preset.factory = false;
                preset.id = item.getProperty("id", {}).toString().toStdString();
                preset.name = item.getProperty("name", {}).toString().toStdString();
                const auto effects = item.getProperty("effects", {});
                if (effects.isArray()) {
                    for (const auto& effectVar : *effects.getArray()) {
                        if (!effectVar.isObject())
                            continue;
                        EffectType type = EffectType::eq;
                        if (!effectTypeFromName(effectVar.getProperty("type", {}).toString().toStdString(), type))
                            continue;
                        VocalPresetEffect effect;
                        effect.type = type;
                        const auto enabledVar = effectVar.getProperty("enabled", {});
                        effect.enabled = enabledVar.isBool() ? static_cast<bool>(enabledVar) : true;
                        effect.params = defaultEffectParams(type);
                        const auto params = effectVar.getProperty("params", {});
                        if (params.isObject()) {
                            auto* paramsObj = params.getDynamicObject();
                            const auto& spec = effectSpec(type);
                            for (int i = 0; i < spec.paramCount; ++i) {
                                const auto value = paramsObj->getProperty(spec.params[i].name);
                                if (isNumberVar(value))
                                    effect.params[static_cast<size_t>(i)] = static_cast<float>(static_cast<double>(value));
                            }
                        }
                        sanitizeEffectParams(type, effect.params);
                        preset.effects.push_back(effect);
                    }
                }
                const auto error = validateVocalPreset(preset);
                if (!error.empty() || findFactoryVocalPreset(preset.id) != nullptr) {
                    project.warnings.push_back("Custom vocal preset \"" + preset.name + "\" was ignored (" +
                                               (error.empty() ? "factory id collision" : error) + ").");
                    continue;
                }
                project.customVocalPresets.push_back(std::move(preset));
            }
        } else {
            project.warnings.push_back("customVocalPresets was not an array and was ignored.");
        }
    }
    return project;
}

} // namespace msp
