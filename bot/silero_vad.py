#!/usr/bin/env python3
"""
Silero VAD subprocess — rolling-window speech activity detection.

Reads raw s16le PCM audio (16 kHz, mono) from stdin in 512-sample windows,
runs them through Silero VAD via onnxruntime (no torch required), and writes
newline-delimited events to stdout:

    READY          — model loaded, ready to receive audio
    speech_start   — speech onset detected
    speech_end     — silence detected after speech (stop recording)

Usage:
    python silero_vad.py [--threshold 0.5] [--silence-duration 1.0]

The 512-sample window is the minimum chunk for Silero VAD at 16 kHz (~32 ms).
"""

import sys
import os
import argparse
import urllib.request
import numpy as np
import onnxruntime as ort

# ── Constants ─────────────────────────────────────────────────────────────────

SAMPLE_RATE   = 16000
CHUNK_SAMPLES = 512          # minimum VAD window at 16 kHz (~32 ms)
CHUNK_BYTES   = CHUNK_SAMPLES * 2  # s16le → 2 bytes per sample

MODEL_URL  = "https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx"
CACHE_DIR  = os.path.join(os.path.expanduser("~"), ".cache", "silero_vad")
MODEL_PATH = os.path.join(CACHE_DIR, "silero_vad.onnx")

# ── Model download ─────────────────────────────────────────────────────────────

def ensure_model() -> str:
    if os.path.exists(MODEL_PATH):
        return MODEL_PATH
    os.makedirs(CACHE_DIR, exist_ok=True)
    print(f"[silero_vad] Downloading model to {MODEL_PATH} …", file=sys.stderr, flush=True)
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print("[silero_vad] Download complete.", file=sys.stderr, flush=True)
    return MODEL_PATH

# ── ONNX wrapper ───────────────────────────────────────────────────────────────

class SileroVAD:
    """Stateful Silero VAD inference via onnxruntime (no torch dependency)."""

    def __init__(self, model_path: str) -> None:
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(
            model_path,
            providers=["CPUExecutionProvider"],
            sess_options=opts,
        )
        self._reset_states()

    def _reset_states(self) -> None:
        self._h = np.zeros((2, 1, 64), dtype=np.float32)
        self._c = np.zeros((2, 1, 64), dtype=np.float32)

    def reset(self) -> None:
        self._reset_states()

    def __call__(self, pcm_s16le: bytes) -> float:
        """
        Accept exactly CHUNK_BYTES of raw s16le audio and return a speech
        probability in [0, 1].
        """
        samples = np.frombuffer(pcm_s16le, dtype=np.int16).astype(np.float32) / 32768.0
        x = samples[np.newaxis, :]  # shape: (1, 512)

        ort_inputs = {
            "input": x,
            "sr":    np.array(SAMPLE_RATE, dtype=np.int64),
            "h":     self._h,
            "c":     self._c,
        }
        out, self._h, self._c = self.session.run(None, ort_inputs)
        # out is either a scalar or shape (1, 1)
        prob = float(np.squeeze(out))
        return prob

# ── Rolling-window state machine ───────────────────────────────────────────────

def run(threshold: float, silence_duration: float) -> None:
    """Main loop: read PCM from stdin, emit events to stdout."""

    model_path = ensure_model()
    vad = SileroVAD(model_path)

    # Number of consecutive below-threshold frames to confirm speech end
    silence_frames = max(1, int(silence_duration * SAMPLE_RATE / CHUNK_SAMPLES))
    # Number of consecutive above-threshold frames to confirm speech start
    speech_start_frames = max(1, int(0.1 * SAMPLE_RATE / CHUNK_SAMPLES))  # ~100 ms

    print("READY", flush=True)
    print(
        f"[silero_vad] threshold={threshold} silence_frames={silence_frames} "
        f"speech_start_frames={speech_start_frames}",
        file=sys.stderr,
        flush=True,
    )

    in_speech        = False
    speech_counter   = 0  # consecutive above-threshold frames (while waiting for start)
    silence_counter  = 0  # consecutive below-threshold frames (while in speech)
    buf              = b""

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
        buf    = buf[CHUNK_BYTES:]

        try:
            prob = vad(window)
        except Exception as exc:
            print(f"[silero_vad] inference error: {exc}", file=sys.stderr, flush=True)
            continue

        if not in_speech:
            if prob >= threshold:
                speech_counter += 1
                if speech_counter >= speech_start_frames:
                    in_speech      = True
                    speech_counter = 0
                    silence_counter = 0
                    print("speech_start", flush=True)
            else:
                speech_counter = 0
        else:
            if prob < threshold:
                silence_counter += 1
                if silence_counter >= silence_frames:
                    in_speech       = False
                    silence_counter = 0
                    print("speech_end", flush=True)
                    # Reset LSTM states for the next utterance
                    vad.reset()
            else:
                silence_counter = 0


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Silero VAD subprocess")
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="Speech probability threshold (0–1, default 0.5)",
    )
    parser.add_argument(
        "--silence-duration",
        type=float,
        default=1.0,
        help="Seconds of silence that end an utterance (default 1.0)",
    )
    args = parser.parse_args()
    run(threshold=args.threshold, silence_duration=args.silence_duration)
