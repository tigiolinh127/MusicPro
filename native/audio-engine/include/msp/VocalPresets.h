#pragma once

#include "msp/Effects.h"

#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace msp {

// Phase 2.6.4 — non-destructive vocal processing presets (effect chains only).
// Factory presets are immutable code definitions. Custom presets are user-authored copies.

struct VocalPresetEffect {
    EffectType type = EffectType::eq;
    bool enabled = true;
    EffectParams params {};
};

struct VocalPresetDefinition {
    std::string id;
    std::string name;
    bool factory = false;
    std::vector<VocalPresetEffect> effects;
};

inline constexpr const char* kFactoryCleanVocal = "factory-clean-vocal";
inline constexpr const char* kFactoryWarmVocal = "factory-warm-vocal";
inline constexpr const char* kFactoryBrightVocal = "factory-bright-vocal";
inline constexpr const char* kFactorySoftBallad = "factory-soft-ballad";
inline constexpr const char* kFactoryPodcastVoice = "factory-podcast-voice";
inline constexpr const char* kFactoryVocalReverb = "factory-vocal-reverb";

// Returns the six immutable factory presets (validated).
std::vector<VocalPresetDefinition> factoryVocalPresets();
const VocalPresetDefinition* findFactoryVocalPreset(const std::string& id);

std::string validateVocalPreset(const VocalPresetDefinition& preset);
// Builds ProjectEffect instances with fresh ids via `nextId()`. Params are sanitized.
std::string instantiateVocalPreset(const VocalPresetDefinition& preset,
                                   const std::function<std::string()>& nextId,
                                   std::vector<ProjectEffect>& out);

VocalPresetEffect vocalPresetEffect(EffectType type, std::initializer_list<std::pair<const char*, float>> values);

} // namespace msp
