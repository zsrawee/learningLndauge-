"""Transcribe one audio file with faster-whisper and emit JSON.

Invoked by lib/transcribe.mjs. Progress goes to stderr; the single result
object goes to stdout after a marker so model-download chatter cannot corrupt it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def emit(payload: dict) -> None:
    sys.stdout.write("###RESULT###" + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="")
    parser.add_argument("--cache-dir", default="")
    args = parser.parse_args()

    if not os.path.exists(args.file):
        emit({"ok": False, "message": f"Audio file not found: {args.file}"})
        return 1

    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)
        # Weights are large; keep them off the system drive.
        os.environ.setdefault("HF_HOME", args.cache_dir)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(args.cache_dir, "hub"))

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        emit({
            "ok": False,
            "message": "faster-whisper is not installed. Run: pip install faster-whisper",
            "detail": str(exc),
        })
        return 1

    print(f"PROGRESS loading model {args.model}", file=sys.stderr, flush=True)
    try:
        # int8 keeps RAM near 252 MB for `small`, measured on the target machine.
        model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "message": f"Could not load model '{args.model}': {exc}"})
        return 1

    print("PROGRESS transcribing", file=sys.stderr, flush=True)
    try:
        segments, info = model.transcribe(
            args.file,
            beam_size=5,
            language=args.language or None,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            word_timestamps=True,
        )
        out = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            words = [
                {"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word}
                for w in (seg.words or [])
                if w.start is not None and w.end is not None
            ]
            out.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": text,
                **({"words": words} if words else {}),
            })
            print(f"PROGRESS {seg.end:.0f}s", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "message": f"Transcription failed: {exc}"})
        return 1

    emit({
        "ok": True,
        "language": getattr(info, "language", "") or "",
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
        "segments": out,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
