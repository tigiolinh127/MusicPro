// Test executable only: replaces the global allocation functions so a test can count the heap
// allocations made by the calling thread (used to verify that real-time process() calls never
// allocate). Behaviour is otherwise the same as the default allocator.

#include <cstdint>
#include <cstdlib>
#include <malloc.h>
#include <new>

namespace {
thread_local int64_t gThreadAllocations = 0;

void* allocate(std::size_t size) {
    ++gThreadAllocations;
    return std::malloc(size == 0 ? 1 : size);
}

void* allocateAligned(std::size_t size, std::align_val_t alignment) {
    ++gThreadAllocations;
    return _aligned_malloc(size == 0 ? 1 : size, static_cast<std::size_t>(alignment));
}
} // namespace

int64_t threadAllocationCount() {
    return gThreadAllocations;
}

void* operator new(std::size_t size) {
    if (void* p = allocate(size))
        return p;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (void* p = allocate(size))
        return p;
    throw std::bad_alloc();
}

void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
    return allocate(size);
}

void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
    return allocate(size);
}

void* operator new(std::size_t size, std::align_val_t alignment) {
    if (void* p = allocateAligned(size, alignment))
        return p;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size, std::align_val_t alignment) {
    if (void* p = allocateAligned(size, alignment))
        return p;
    throw std::bad_alloc();
}

void* operator new(std::size_t size, std::align_val_t alignment, const std::nothrow_t&) noexcept {
    return allocateAligned(size, alignment);
}

void* operator new[](std::size_t size, std::align_val_t alignment, const std::nothrow_t&) noexcept {
    return allocateAligned(size, alignment);
}

void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }
void operator delete(void* p, const std::nothrow_t&) noexcept { std::free(p); }
void operator delete[](void* p, const std::nothrow_t&) noexcept { std::free(p); }
void operator delete(void* p, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete[](void* p, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete(void* p, std::size_t, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete[](void* p, std::size_t, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete(void* p, std::align_val_t, const std::nothrow_t&) noexcept { _aligned_free(p); }
void operator delete[](void* p, std::align_val_t, const std::nothrow_t&) noexcept { _aligned_free(p); }
