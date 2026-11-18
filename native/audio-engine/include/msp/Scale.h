#pragma once

#include <string>
#include <vector>

namespace msp {

// Musical keys, scales and nearest-allowed-note mapping. Pure functions: no audio, no state.
// Pitch classes are 0..11 with C = 0. Names are spelled with sharps ("C#", never "Db"); flats are
// accepted on input and mapped to the same pitch class, so enharmonic spellings are equivalent.

enum class ScaleType { major, naturalMinor, harmonicMinor, melodicMinor, majorPentatonic, minorPentatonic, chromatic };
inline constexpr int kScaleTypeCount = 7;

const char* scaleTypeName(ScaleType type);    // protocol name, e.g. "harmonicMinor"
const char* scaleTypeLabel(ScaleType type);   // display name, e.g. "Harmonic minor"
bool scaleTypeFromName(const std::string& name, ScaleType& type);
ScaleType scaleTypeAt(int index);              // 0..kScaleTypeCount-1 in declaration order
// Semitones above the root, ascending, starting with 0.
const std::vector<int>& scaleIntervals(ScaleType type);

// "C", "C#", "Db", "B#", "Cb", ... (case-insensitive letter, '#' or 'b'). Returns -1 when invalid.
int pitchClassFromName(const std::string& name);
const char* pitchClassName(int pitchClass);    // sharps; "" outside 0..11

struct MusicalKey {
    int root = 0;                              // pitch class 0..11
    ScaleType scale = ScaleType::major;
};

bool inScale(int midi, const MusicalKey& key);
// The key's pitch classes in ascending order from the root.
std::vector<int> keyPitchClasses(const MusicalKey& key);

// A pitch exactly halfway between two allowed notes goes to the lower or the upper one.
enum class TieBreak { lower, upper };
const char* tieBreakName(TieBreak tie);
bool tieBreakFromName(const std::string& name, TieBreak& tie);

struct MappingSettings {
    TieBreak tieBreak = TieBreak::lower;
    double toleranceCents = 10.0;              // |correction| at or below this counts as in tune (0..50)
};

// Project-wide target mapping settings.
struct PitchMapping {
    bool enabled = false;
    MusicalKey key;
    MappingSettings settings;
};

std::string checkMappingSettings(const MappingSettings& settings);

enum class MappingStatus { unvoiced, invalid, inTune, needsCorrection };
const char* mappingStatusName(MappingStatus status);

struct NoteMapping {
    MappingStatus status = MappingStatus::unvoiced;
    double originalMidi = 0.0;                 // the input, unrounded
    int nearestMidi = -1;                      // nearest chromatic note (display only; -1 when no pitch)
    std::string nearestName;
    int targetMidi = -1;                       // nearest allowed note; -1 when no pitch
    std::string targetName;
    double cents = 0.0;                        // shift needed: (targetMidi - originalMidi) * 100
};

inline constexpr double kMappingLowestMidi = -0.5;
inline constexpr double kMappingHighestMidi = 127.5;

// Maps a fractional MIDI pitch to the nearest note of the key, across octave boundaries, using
// the unrounded pitch. Unvoiced input gives no target; non-finite or out-of-range input is invalid.
NoteMapping mapPitch(double midi, bool voiced, const MusicalKey& key, const MappingSettings& settings);
// Same for a frequency in Hz (frequencies <= 0 are unvoiced).
NoteMapping mapFrequency(double hz, bool voiced, const MusicalKey& key, const MappingSettings& settings);

} // namespace msp
