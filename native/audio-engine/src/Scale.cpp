#include "msp/Scale.h"

#include "msp/Pitch.h"

#include <algorithm>
#include <cctype>
#include <cmath>

namespace msp {
namespace {
struct ScaleSpec {
    ScaleType type;
    const char* name;
    const char* label;
    std::vector<int> intervals;
};

const std::vector<ScaleSpec>& specs() {
    static const std::vector<ScaleSpec> table = {
        { ScaleType::major, "major", "Major", { 0, 2, 4, 5, 7, 9, 11 } },
        { ScaleType::naturalMinor, "naturalMinor", "Natural minor", { 0, 2, 3, 5, 7, 8, 10 } },
        { ScaleType::harmonicMinor, "harmonicMinor", "Harmonic minor", { 0, 2, 3, 5, 7, 8, 11 } },
        { ScaleType::melodicMinor, "melodicMinor", "Melodic minor (ascending)", { 0, 2, 3, 5, 7, 9, 11 } },
        { ScaleType::majorPentatonic, "majorPentatonic", "Major pentatonic", { 0, 2, 4, 7, 9 } },
        { ScaleType::minorPentatonic, "minorPentatonic", "Minor pentatonic", { 0, 3, 5, 7, 10 } },
        { ScaleType::chromatic, "chromatic", "Chromatic", { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
    };
    return table;
}

const ScaleSpec& spec(ScaleType type) {
    for (const auto& item : specs())
        if (item.type == type)
            return item;
    return specs().front();
}

int pitchClassOf(int midi) {
    return ((midi % 12) + 12) % 12;
}
} // namespace

const char* scaleTypeName(ScaleType type) { return spec(type).name; }
const char* scaleTypeLabel(ScaleType type) { return spec(type).label; }
const std::vector<int>& scaleIntervals(ScaleType type) { return spec(type).intervals; }

ScaleType scaleTypeAt(int index) {
    const auto& table = specs();
    return index >= 0 && index < static_cast<int>(table.size()) ? table[static_cast<size_t>(index)].type : ScaleType::major;
}

bool scaleTypeFromName(const std::string& name, ScaleType& type) {
    for (const auto& item : specs()) {
        if (name == item.name) {
            type = item.type;
            return true;
        }
    }
    return false;
}

int pitchClassFromName(const std::string& name) {
    if (name.empty() || name.size() > 2)
        return -1;
    static const int naturals[7] = { 9, 11, 0, 2, 4, 5, 7 };   // A B C D E F G
    const char letter = static_cast<char>(std::toupper(static_cast<unsigned char>(name[0])));
    if (letter < 'A' || letter > 'G')
        return -1;
    int pc = naturals[letter - 'A'];
    if (name.size() == 2) {
        if (name[1] == '#')
            pc += 1;
        else if (name[1] == 'b')
            pc -= 1;
        else
            return -1;
    }
    return pitchClassOf(pc);
}

const char* pitchClassName(int pitchClass) {
    static const char* const names[12] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    return pitchClass >= 0 && pitchClass < 12 ? names[pitchClass] : "";
}

bool inScale(int midi, const MusicalKey& key) {
    const int degree = pitchClassOf(midi - key.root);
    for (const int interval : scaleIntervals(key.scale))
        if (interval == degree)
            return true;
    return false;
}

std::vector<int> keyPitchClasses(const MusicalKey& key) {
    std::vector<int> out;
    for (const int interval : scaleIntervals(key.scale))
        out.push_back(pitchClassOf(key.root + interval));
    return out;
}

const char* tieBreakName(TieBreak tie) { return tie == TieBreak::upper ? "upper" : "lower"; }

bool tieBreakFromName(const std::string& name, TieBreak& tie) {
    if (name == "lower" || name == "upper") {
        tie = name == "upper" ? TieBreak::upper : TieBreak::lower;
        return true;
    }
    return false;
}

std::string checkMappingSettings(const MappingSettings& settings) {
    if (!std::isfinite(settings.toleranceCents) || settings.toleranceCents < 0.0 || settings.toleranceCents > 50.0)
        return "The in-tune tolerance must be between 0 and 50 cents.";
    return {};
}

const char* mappingStatusName(MappingStatus status) {
    switch (status) {
        case MappingStatus::unvoiced: return "unvoiced";
        case MappingStatus::invalid: return "invalid";
        case MappingStatus::inTune: return "inTune";
        case MappingStatus::needsCorrection: return "needsCorrection";
    }
    return "invalid";
}

NoteMapping mapPitch(double midi, bool voiced, const MusicalKey& key, const MappingSettings& settings) {
    NoteMapping out;
    out.originalMidi = midi;
    if (!voiced) {
        out.status = MappingStatus::unvoiced;
        return out;
    }
    if (!std::isfinite(midi) || midi < kMappingLowestMidi || midi > kMappingHighestMidi || key.root < 0 || key.root > 11) {
        out.status = MappingStatus::invalid;
        return out;
    }
    out.nearestMidi = static_cast<int>(std::clamp<long>(std::lround(midi), 0, 127));
    out.nearestName = noteName(out.nearestMidi);

    // Closest allowed notes at or below and at or above the unrounded pitch. Every scale has a note
    // in each octave, so both searches end within 12 steps.
    int lower = static_cast<int>(std::floor(midi));
    while (!inScale(lower, key))
        --lower;
    int upper = static_cast<int>(std::ceil(midi));
    while (!inScale(upper, key))
        ++upper;
    const double below = midi - lower;
    const double above = upper - midi;
    int target = 0;
    if (lower == upper)
        target = lower;
    else if (std::fabs(below - above) <= 1e-9)
        target = settings.tieBreak == TieBreak::upper ? upper : lower;
    else
        target = below < above ? lower : upper;
    if (target < 0)
        target = upper;
    if (target > 127)
        target = lower;
    while (target > 127 || !inScale(target, key))
        --target;   // only reached at the top of the MIDI range
    while (target < 0 || !inScale(target, key))
        ++target;   // only reached at the bottom of the MIDI range

    out.targetMidi = target;
    out.targetName = noteName(target);
    out.cents = (target - midi) * 100.0;
    out.status = std::fabs(out.cents) <= settings.toleranceCents ? MappingStatus::inTune : MappingStatus::needsCorrection;
    return out;
}

NoteMapping mapFrequency(double hz, bool voiced, const MusicalKey& key, const MappingSettings& settings) {
    if (!std::isfinite(hz)) {
        NoteMapping out;
        out.status = voiced ? MappingStatus::invalid : MappingStatus::unvoiced;
        return out;
    }
    if (!(hz > 0.0))
        return mapPitch(0.0, false, key, settings);
    return mapPitch(midiFromFrequency(hz), voiced, key, settings);
}

} // namespace msp
