#pragma once

#include <cstdint>

namespace msp {

struct ProcessMemory {
    int64_t workingSetBytes = 0;
    int64_t peakWorkingSetBytes = 0;   // since the process started
};

// Memory of this process (zeros where the platform does not report it).
ProcessMemory processMemory();

} // namespace msp
