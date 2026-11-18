#include "msp/Fft.h"

#include <utility>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;
} // namespace

std::string Fft::prepare(int size) {
    if (size < 2 || size > (1 << 20) || (size & (size - 1)) != 0)
        return "The FFT size must be a power of two between 2 and 1048576.";
    n = size;
    twiddles.resize(static_cast<size_t>(n / 2));
    for (int k = 0; k < n / 2; ++k)
        twiddles[static_cast<size_t>(k)] = std::polar(1.0, -2.0 * kPi * k / n);
    bitReverse.resize(static_cast<size_t>(n));
    int bits = 0;
    while ((1 << bits) < n)
        ++bits;
    for (int i = 0; i < n; ++i) {
        int reversed = 0;
        for (int b = 0; b < bits; ++b)
            reversed |= ((i >> b) & 1) << (bits - 1 - b);
        bitReverse[static_cast<size_t>(i)] = reversed;
    }
    return {};
}

void Fft::transform(std::vector<std::complex<double>>& data, bool inverse) const {
    for (int i = 0; i < n; ++i) {
        const int j = bitReverse[static_cast<size_t>(i)];
        if (i < j)
            std::swap(data[static_cast<size_t>(i)], data[static_cast<size_t>(j)]);
    }
    for (int len = 2; len <= n; len <<= 1) {
        const int half = len / 2;
        const int step = n / len;
        for (int i = 0; i < n; i += len) {
            for (int k = 0; k < half; ++k) {
                auto w = twiddles[static_cast<size_t>(k * step)];
                if (inverse)
                    w = std::conj(w);
                const auto u = data[static_cast<size_t>(i + k)];
                const auto v = data[static_cast<size_t>(i + k + half)] * w;
                data[static_cast<size_t>(i + k)] = u + v;
                data[static_cast<size_t>(i + k + half)] = u - v;
            }
        }
    }
    if (inverse) {
        const double scale = 1.0 / n;
        for (auto& value : data)
            value *= scale;
    }
}

} // namespace msp
