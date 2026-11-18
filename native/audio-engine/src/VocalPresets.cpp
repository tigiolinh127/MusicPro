#include "msp/VocalPresets.h"

#include <algorithm>
#include <cmath>

namespace msp {
namespace {

VocalPresetDefinition makeFactory(const char* id, const char* name, std::vector<VocalPresetEffect> effects) {
    VocalPresetDefinition preset;
    preset.id = id;
    preset.name = name;
    preset.factory = true;
    preset.effects = std::move(effects);
    return preset;
}

} // namespace

VocalPresetEffect vocalPresetEffect(EffectType type, std::initializer_list<std::pair<const char*, float>> values) {
    VocalPresetEffect effect;
    effect.type = type;
    effect.enabled = true;
    effect.params = defaultEffectParams(type);
    for (const auto& [name, value] : values) {
        const int index = effectParamIndex(type, name);
        if (index >= 0)
            effect.params[static_cast<size_t>(index)] = value;
    }
    sanitizeEffectParams(type, effect.params);
    return effect;
}

std::string validateVocalPreset(const VocalPresetDefinition& preset) {
    if (preset.id.empty())
        return "A vocal preset needs an id.";
    if (preset.name.empty())
        return "A vocal preset needs a name.";
    if (preset.name.size() > 80)
        return "Vocal preset names must be at most 80 characters.";
    if (preset.effects.empty())
        return "A vocal preset needs at least one effect.";
    if (static_cast<int>(preset.effects.size()) > kMaxEffectsPerChain)
        return "A vocal preset can hold at most " + std::to_string(kMaxEffectsPerChain) + " effects.";
    for (const auto& effect : preset.effects) {
        auto params = effect.params;
        const auto fixed = sanitizeEffectParams(effect.type, params);
        for (size_t i = 0; i < params.size(); ++i) {
            if (!std::isfinite(params[i]))
                return "Vocal preset \"" + preset.name + "\" has a non-finite parameter.";
        }
        (void)fixed;
    }
    return {};
}

std::string instantiateVocalPreset(const VocalPresetDefinition& preset,
                                   const std::function<std::string()>& nextId,
                                   std::vector<ProjectEffect>& out) {
    const auto error = validateVocalPreset(preset);
    if (!error.empty())
        return error;
    if (!nextId)
        return "Vocal preset instantiation needs an id factory.";
    out.clear();
    out.reserve(preset.effects.size());
    for (const auto& item : preset.effects) {
        ProjectEffect effect = makeEffect(item.type, nextId());
        effect.enabled = item.enabled;
        effect.params = item.params;
        sanitizeEffectParams(effect.type, effect.params);
        out.push_back(std::move(effect));
    }
    return {};
}

std::vector<VocalPresetDefinition> factoryVocalPresets() {
    // Conservative starting points — not automatic mastering.
    std::vector<VocalPresetDefinition> list;
    list.push_back(makeFactory(kFactoryCleanVocal, "Clean Vocal", {
        vocalPresetEffect(EffectType::gate, {
            { "threshold", -48.0f }, { "attack", 1.0f }, { "hold", 30.0f }, { "release", 120.0f }, { "range", -48.0f }
        }),
        vocalPresetEffect(EffectType::compressor, {
            { "threshold", -20.0f }, { "ratio", 2.5f }, { "attack", 12.0f }, { "release", 140.0f }, { "makeup", 2.0f }
        }),
        vocalPresetEffect(EffectType::eq, {
            { "band1Type", 0.0f }, { "band1Freq", 90.0f }, { "band1Gain", -2.0f }, { "band1Q", 0.7f },
            { "band2Type", 1.0f }, { "band2Freq", 250.0f }, { "band2Gain", -1.0f }, { "band2Q", 1.0f },
            { "band3Type", 1.0f }, { "band3Freq", 3200.0f }, { "band3Gain", 1.5f }, { "band3Q", 1.1f },
            { "band4Type", 2.0f }, { "band4Freq", 10000.0f }, { "band4Gain", 1.0f }, { "band4Q", 0.7f },
            { "outputGain", 0.0f }
        })
    }));
    list.push_back(makeFactory(kFactoryWarmVocal, "Warm Vocal", {
        vocalPresetEffect(EffectType::eq, {
            { "band1Type", 0.0f }, { "band1Freq", 120.0f }, { "band1Gain", 2.0f }, { "band1Q", 0.7f },
            { "band2Type", 1.0f }, { "band2Freq", 350.0f }, { "band2Gain", 1.0f }, { "band2Q", 0.9f },
            { "band3Type", 1.0f }, { "band3Freq", 2500.0f }, { "band3Gain", -1.0f }, { "band3Q", 1.0f },
            { "band4Type", 2.0f }, { "band4Freq", 9000.0f }, { "band4Gain", -2.0f }, { "band4Q", 0.7f },
            { "outputGain", 0.0f }
        }),
        vocalPresetEffect(EffectType::compressor, {
            { "threshold", -18.0f }, { "ratio", 3.0f }, { "attack", 18.0f }, { "release", 180.0f }, { "makeup", 1.5f }
        })
    }));
    list.push_back(makeFactory(kFactoryBrightVocal, "Bright Vocal", {
        vocalPresetEffect(EffectType::eq, {
            { "band1Type", 0.0f }, { "band1Freq", 100.0f }, { "band1Gain", -1.5f }, { "band1Q", 0.7f },
            { "band2Type", 1.0f }, { "band2Freq", 400.0f }, { "band2Gain", 0.0f }, { "band2Q", 1.0f },
            { "band3Type", 1.0f }, { "band3Freq", 4500.0f }, { "band3Gain", 2.5f }, { "band3Q", 1.2f },
            { "band4Type", 2.0f }, { "band4Freq", 11000.0f }, { "band4Gain", 2.0f }, { "band4Q", 0.7f },
            { "outputGain", 0.0f }
        }),
        vocalPresetEffect(EffectType::compressor, {
            { "threshold", -22.0f }, { "ratio", 2.5f }, { "attack", 8.0f }, { "release", 120.0f }, { "makeup", 2.0f }
        })
    }));
    list.push_back(makeFactory(kFactorySoftBallad, "Soft Ballad", {
        vocalPresetEffect(EffectType::compressor, {
            { "threshold", -24.0f }, { "ratio", 2.0f }, { "attack", 25.0f }, { "release", 220.0f }, { "makeup", 1.0f }
        }),
        vocalPresetEffect(EffectType::eq, {
            { "band1Type", 0.0f }, { "band1Freq", 110.0f }, { "band1Gain", 1.5f }, { "band1Q", 0.7f },
            { "band2Type", 1.0f }, { "band2Freq", 300.0f }, { "band2Gain", 0.5f }, { "band2Q", 0.9f },
            { "band3Type", 1.0f }, { "band3Freq", 2800.0f }, { "band3Gain", 0.5f }, { "band3Q", 1.0f },
            { "band4Type", 2.0f }, { "band4Freq", 8000.0f }, { "band4Gain", -1.0f }, { "band4Q", 0.7f },
            { "outputGain", 0.0f }
        }),
        vocalPresetEffect(EffectType::reverb, {
            { "roomSize", 0.35f }, { "damping", 0.55f }, { "mix", 0.18f }
        })
    }));
    list.push_back(makeFactory(kFactoryPodcastVoice, "Podcast Voice", {
        vocalPresetEffect(EffectType::gate, {
            { "threshold", -42.0f }, { "attack", 0.8f }, { "hold", 40.0f }, { "release", 100.0f }, { "range", -60.0f }
        }),
        vocalPresetEffect(EffectType::eq, {
            { "band1Type", 0.0f }, { "band1Freq", 80.0f }, { "band1Gain", -3.0f }, { "band1Q", 0.7f },
            { "band2Type", 1.0f }, { "band2Freq", 200.0f }, { "band2Gain", -1.5f }, { "band2Q", 1.0f },
            { "band3Type", 1.0f }, { "band3Freq", 2500.0f }, { "band3Gain", 2.0f }, { "band3Q", 1.0f },
            { "band4Type", 2.0f }, { "band4Freq", 7500.0f }, { "band4Gain", -1.5f }, { "band4Q", 0.8f },
            { "outputGain", 1.0f }
        }),
        vocalPresetEffect(EffectType::compressor, {
            { "threshold", -16.0f }, { "ratio", 4.0f }, { "attack", 6.0f }, { "release", 90.0f }, { "makeup", 3.0f }
        })
    }));
    list.push_back(makeFactory(kFactoryVocalReverb, "Vocal Reverb", {
        vocalPresetEffect(EffectType::eq, {
            { "band1Type", 0.0f }, { "band1Freq", 100.0f }, { "band1Gain", -1.0f }, { "band1Q", 0.7f },
            { "band2Type", 1.0f }, { "band2Freq", 400.0f }, { "band2Gain", 0.0f }, { "band2Q", 1.0f },
            { "band3Type", 1.0f }, { "band3Freq", 3000.0f }, { "band3Gain", 1.0f }, { "band3Q", 1.0f },
            { "band4Type", 2.0f }, { "band4Freq", 9000.0f }, { "band4Gain", 0.5f }, { "band4Q", 0.7f },
            { "outputGain", 0.0f }
        }),
        vocalPresetEffect(EffectType::compressor, {
            { "threshold", -20.0f }, { "ratio", 2.5f }, { "attack", 12.0f }, { "release", 150.0f }, { "makeup", 1.5f }
        }),
        vocalPresetEffect(EffectType::reverb, {
            { "roomSize", 0.55f }, { "damping", 0.4f }, { "mix", 0.28f }
        })
    }));
    for (auto& preset : list) {
        const auto error = validateVocalPreset(preset);
        if (!error.empty())
            preset.effects.clear(); // should never happen for factories
    }
    return list;
}

const VocalPresetDefinition* findFactoryVocalPreset(const std::string& id) {
    static const auto factories = factoryVocalPresets();
    for (const auto& preset : factories) {
        if (preset.id == id)
            return &preset;
    }
    return nullptr;
}

} // namespace msp
