#!/usr/bin/env python3
"""
Always-on wake word detector using openWakeWord.

Listens to the microphone continuously and prints "WAKE" (flushed) to stdout
each time the configured wake word is detected.  The Bun backend spawns this
process on startup and reads its stdout to trigger the voice-command pipeline.

Install deps:
    pip install openwakeword pyaudio numpy

The first run downloads the TFLite model (~2 MB) and caches it locally.
"""

import sys
import time
import numpy as np
import pyaudio
import openwakeword.utils
from openwakeword.model import Model

# ── Configuration ────────────────────────────────────────────────────────────
# openWakeWord ships several built-in models.  "hey_jarvis" is a solid default;
# swap for any name listed in openwakeword.utils.list_models() or point to a
# local .tflite file path for a custom wake word.
WAKE_WORD_MODEL   = "hey_jarvis"
DETECTION_THRESHOLD = 0.5   # 0–1; lower = more sensitive, more false triggers
COOLDOWN_S        = 2.0     # seconds to suppress re-triggers after a detection

# Audio capture settings (must match openWakeWord expectations)
SAMPLE_RATE  = 16000
CHUNK_FRAMES = 1280   # 80 ms at 16 kHz — recommended by openWakeWord docs
# ─────────────────────────────────────────────────────────────────────────────


def main() -> None:
    print(f"[wake_word] Loading model '{WAKE_WORD_MODEL}'…", file=sys.stderr, flush=True)
    openwakeword.utils.download_models()
    model = Model(wakeword_models=[WAKE_WORD_MODEL], inference_framework="onnx")

    audio = pyaudio.PyAudio()
    stream = audio.open(
        rate=SAMPLE_RATE,
        channels=1,
        format=pyaudio.paInt16,
        input=True,
        frames_per_buffer=CHUNK_FRAMES,
    )

    print("[wake_word] Listening…", file=sys.stderr, flush=True)
    last_trigger = 0.0

    try:
        while True:
            raw = stream.read(CHUNK_FRAMES, exception_on_overflow=False)
            samples = np.frombuffer(raw, dtype=np.int16)
            scores = model.predict(samples)

            for score in scores.values():
                if score >= DETECTION_THRESHOLD:
                    now = time.monotonic()
                    if now - last_trigger >= COOLDOWN_S:
                        last_trigger = now
                        print("WAKE", flush=True)   # backend reads this line
                    break
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop_stream()
        stream.close()
        audio.terminate()


if __name__ == "__main__":
    main()
