#!/usr/bin/env python3
"""
Persistent Whisper STT service.
Protocol (newline-delimited JSON over stdin/stdout):
  in:  {"path": "/absolute/path/to/audio.wav"}
  out: {"transcript": "..."} | {"error": "..."}
Writes READY\n to stdout once the model is loaded.
"""
import json
import sys
import traceback


def main() -> None:
    from faster_whisper import WhisperModel

    print("[whisper_stt] Loading faster-whisper base.en ...", file=sys.stderr, flush=True)
    try:
        model = WhisperModel("base.en", device="cpu", compute_type="int8")
    except Exception as exc:
        print(f"[whisper_stt] FATAL: could not load model: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)

    print("[whisper_stt] Model ready.", file=sys.stderr, flush=True)
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            path: str = req["path"]
        except (json.JSONDecodeError, KeyError) as exc:
            _reply({"error": f"bad request: {exc}"})
            continue

        try:
            segments, _ = model.transcribe(
                path,
                language="en",
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            _reply({"transcript": text})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _reply({"error": str(exc)})


def _reply(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
