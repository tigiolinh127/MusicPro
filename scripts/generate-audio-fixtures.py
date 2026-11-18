"""Write the Phase 0 stereo PCM listening fixtures and decode them back."""

import math
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 48_000
SECONDS = 10
CHANNELS = 2
AMPLITUDE = 0.5
OUT_DIR = Path(r"D:\MusicStudioPro\fixtures\audio")
FILES = (
    ("test_music_440hz.wav", 440.0),
    ("test_music_880hz.wav", 880.0),
)


def write_tone(path: Path, frequency: float) -> None:
    frames = SAMPLE_RATE * SECONDS
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        chunks = []
        for index in range(frames):
            sample = AMPLITUDE * math.sin(2.0 * math.pi * frequency * index / SAMPLE_RATE)
            packed = struct.pack("<h", max(-32767, min(32767, round(sample * 32767))))
            chunks.append(packed * CHANNELS)
        wav.writeframes(b"".join(chunks))


def dominant_frequency(samples: list[int], sample_rate: int) -> float:
    if len(samples) < 2:
        return 0.0
    crossings = 0
    for previous, current in zip(samples, samples[1:]):
        if previous <= 0 < current:
            crossings += 1
    duration = (len(samples) - 1) / sample_rate
    return crossings / duration if duration else 0.0


def verify(path: Path, frequency: float) -> None:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != CHANNELS:
            raise SystemExit(f"{path.name} is not stereo")
        if wav.getsampwidth() != 2:
            raise SystemExit(f"{path.name} is not 16-bit PCM")
        if wav.getframerate() != SAMPLE_RATE:
            raise SystemExit(f"{path.name} is not {SAMPLE_RATE} Hz")
        if wav.getcomptype() != "NONE":
            raise SystemExit(f"{path.name} is not uncompressed PCM")
        frame_count = wav.getnframes()
        if frame_count != SAMPLE_RATE * SECONDS:
            raise SystemExit(f"{path.name} is not {SECONDS} seconds")
        raw = wav.readframes(frame_count)
    decoded = struct.unpack("<" + "h" * (len(raw) // 2), raw)
    left = decoded[0::2]
    right = decoded[1::2]
    if left != right:
        raise SystemExit(f"{path.name} stereo channels differ")
    if max(abs(sample) for sample in left) <= 0:
        raise SystemExit(f"{path.name} decoded as silence")
    measured = dominant_frequency(list(left), SAMPLE_RATE)
    if abs(measured - frequency) > 1.0:
        raise SystemExit(f"{path.name} measured {measured:.2f} Hz, expected {frequency:.0f} Hz")
    print(f"DECODED {path} frames={frame_count} rate={SAMPLE_RATE} channels=2 bits=16 freq={measured:.2f}Hz")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, frequency in FILES:
        path = OUT_DIR / name
        write_tone(path, frequency)
        verify(path, frequency)


if __name__ == "__main__":
    main()
