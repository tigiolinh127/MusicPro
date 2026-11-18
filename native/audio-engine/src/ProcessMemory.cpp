#include "msp/ProcessMemory.h"

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#endif

namespace msp {

ProcessMemory processMemory() {
    ProcessMemory memory;
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS counters {};
    counters.cb = sizeof(counters);
    if (K32GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters))) {
        memory.workingSetBytes = static_cast<int64_t>(counters.WorkingSetSize);
        memory.peakWorkingSetBytes = static_cast<int64_t>(counters.PeakWorkingSetSize);
    }
#endif
    return memory;
}

} // namespace msp
