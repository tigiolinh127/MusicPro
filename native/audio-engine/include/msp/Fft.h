#pragma once

#include <complex>
#include <string>
#include <vector>

namespace msp {

// In-place radix-2 complex FFT. prepare() allocates; transform() does not allocate, lock or
// perform I/O. The inverse transform is scaled by 1/size.
class Fft {
public:
    // `size` must be a power of two between 2 and 2^20.
    std::string prepare(int size);
    void transform(std::vector<std::complex<double>>& data, bool inverse) const;
    int size() const { return n; }

private:
    int n = 0;
    std::vector<std::complex<double>> twiddles;
    std::vector<int> bitReverse;
};

} // namespace msp
