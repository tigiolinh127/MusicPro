"""Baseline check: import the Phase 0 fixtures, export, and round-trip a project."""

import json
import struct
import subprocess
import wave
from pathlib import Path

ENGINE = Path(r"D:\MusicStudioPro\build\MusicStudioEngine.exe")
A = Path(r"D:\MusicStudioPro\fixtures\audio\test_music_440hz.wav")
B = Path(r"D:\MusicStudioPro\fixtures\audio\test_music_880hz.wav")
OUT = Path(r"D:\MusicStudioPro\fixtures\audio\_baseline_export.wav")
PROJECT = Path(r"D:\MusicStudioPro\fixtures\audio\_baseline_project.json")


def goertzel(samples, freq, rate):
    import math
    omega = 2.0 * math.pi * freq / rate
    coeff = 2.0 * math.cos(omega)
    s0 = s1 = s2 = 0.0
    for sample in samples:
        s0 = sample + coeff * s1 - s2
        s2 = s1
        s1 = s0
    real = s1 - s2 * math.cos(omega)
    imag = s2 * math.sin(omega)
    return math.sqrt(real * real + imag * imag) * 2.0 / len(samples)


def main():
    proc = subprocess.Popen(
        [str(ENGINE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
    )
    seq = 0

    def request(op, **payload):
        nonlocal seq
        seq += 1
        ident = f"b{seq}"
        proc.stdin.write(json.dumps({"v": 1, "id": ident, "op": op, **payload}) + "\n")
        proc.stdin.flush()
        while True:
            line = proc.stdout.readline()
            if not line:
                raise SystemExit(f"engine closed during {op}")
            message = json.loads(line)
            if message.get("id") == ident:
                if not message.get("ok"):
                    raise SystemExit(f"{op} failed: {message.get('error')}")
                return message["result"]

    request("importTrack", trackId="track-1", path=str(A))
    request("importTrack", trackId="track-2", path=str(B))
    request("setTrack", trackId="track-1", pan=-1)
    request("setTrack", trackId="track-2", pan=1)
    request("exportWav", path=str(OUT), sampleRate=48000)
    with wave.open(str(OUT), "rb") as wav:
        if wav.getnchannels() != 2 or wav.getframerate() != 48000 or wav.getsampwidth() != 3:
            raise SystemExit(f"unexpected export format ch={wav.getnchannels()} rate={wav.getframerate()} width={wav.getsampwidth()}")
        raw = wav.readframes(wav.getnframes())
    samples = []
    for index in range(0, len(raw), 3):
        value = int.from_bytes(raw[index:index + 3], "little", signed=True)
        samples.append(value / 8388607.0)
    left = samples[0::2]
    right = samples[1::2]
    left_440 = goertzel(left, 440, 48000)
    right_880 = goertzel(right, 880, 48000)
    if left_440 < 0.2 or right_880 < 0.15:
        raise SystemExit(f"export tones weak L440={left_440:.3f} R880={right_880:.3f}")
    request("saveProject", path=str(PROJECT))
    saved = json.loads(PROJECT.read_text(encoding="utf-8"))
    if saved.get("version") not in (1, 2, 3, 4, 5) or len(saved.get("tracks", [])) != 2:
        raise SystemExit(f"project schema unexpected: {saved.get('version')} tracks={len(saved.get('tracks', []))}")
    request("loadProject", path=str(PROJECT))
    state = request("getState")
    if len(state["tracks"]) != 2:
        raise SystemExit("load did not restore two tracks")
    proc.stdin.write(json.dumps({"v": 1, "id": "bye", "op": "shutdown"}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=5)
    print(f"BASELINE_EXPORT_OK left440={left_440:.3f} right880={right_880:.3f} frames={len(left)}")
    print(f"BASELINE_PROJECT_OK version={saved['version']} tracks=2")


if __name__ == "__main__":
    main()
