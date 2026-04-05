#!/usr/bin/env python3
"""
Silero VAD subprocess for rolling-window speech activity detection.

Reads raw s16le PCM audio (16 kHz, mono) from stdin in 512-sample windows,
runs them through the official `silero_vad` package, and writes
newline-delimited events to stdout:

    READY
    speech_start
    speech_end

Usage:
    python silero_vad.py [--threshold 0.5] [--silence-duration 1.0]
"""

import argparse
import os
import sys

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Avoid importing this script itself when resolving the installed `silero_vad`
# package from the virtual environment.
sys.path = [
    path
    for path in sys.path
    if os.path.abspath(path or os.getcwd()) != SCRIPT_DIR
]

try:
    import torch
    from silero_vad import VADIterator, load_silero_vad
except ImportError:
    print(
        "[silero_vad] Missing dependency. Install bot requirements so the "
        "`silero-vad` package is available.",
        file=sys.stderr,
        flush=True,
    )
    raise


SAMPLE_RATE = 16000
CHUNK_SAMPLES = 512
CHUNK_BYTES = CHUNK_SAMPLES * 2


def pcm_to_float32(pcm_s16le: bytes) -> np.ndarray:
    samples = np.frombuffer(pcm_s16le, dtype=np.int16)
    return samples.astype(np.float32) / 32768.0


def create_vad_iterator(threshold: float, silence_duration: float) -> VADIterator:
    torch.set_num_threads(1)
    model = load_silero_vad(onnx=True)
    return VADIterator(
        model,
        threshold=threshold,
        sampling_rate=SAMPLE_RATE,
        min_silence_duration_ms=max(1, int(silence_duration * 1000)),
    )


def run(threshold: float, silence_duration: float) -> None:
    vad_iterator = create_vad_iterator(threshold, silence_duration)

    print("READY", flush=True)
    print(
        f"[silero_vad] threshold={threshold} silence_duration={silence_duration}",
        file=sys.stderr,
        flush=True,
    )

    in_speech = False
    buf = b""
    stdin_bin = sys.stdin.buffer

    while True:
        needed = CHUNK_BYTES - len(buf)
        try:
            chunk = stdin_bin.read(needed)
        except Exception:
            break

        if not chunk:
            break

        buf += chunk
        if len(buf) < CHUNK_BYTES:
            continue

        window = buf[:CHUNK_BYTES]
        buf = buf[CHUNK_BYTES:]

        try:
            event = vad_iterator(pcm_to_float32(window), return_seconds=True)
        except Exception as exc:
            print(f"[silero_vad] inference error: {exc}", file=sys.stderr, flush=True)
            continue

        if not event:
            continue

        if "start" in event and not in_speech:
            in_speech = True
            print("speech_start", flush=True)

        if "end" in event and in_speech:
            in_speech = False
            print("speech_end", flush=True)
            vad_iterator.reset_states()

print("hello, world")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Silero VAD subprocess")
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="Speech probability threshold (0-1, default 0.5)",
    )
    parser.add_argument(
        "--silence-duration",
        type=float,
        default=1.0,
        help="Seconds of silence that end an utterance (default 1.0)",
    )
    args = parser.parse_args()
    run(threshold=args.threshold, silence_duration=args.silence_duration)
