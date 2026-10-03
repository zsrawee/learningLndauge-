"""Persistent transcription server.

Loading faster-whisper costs ~27s on this machine (12.7s interpreter+import,
14.1s model load). Running it per job threw that away every time.

This process loads the model ONCE and then answers requests over stdin/stdout,
so only the transcribe step is paid per job.

Protocol (newline-delimited JSON):
  -> {"id":"1","file":"...","language":"id","model":"small"}
  <- {"id":"1","ok":true,"language":"id","segments":[...]}
  <- {"id":"1","ok":false,"message":"..."}
  -> {"id":"2","cmd":"shutdown"}
"""
from __future__ import annotations

import json
import os
import sys
import time

# The protocol is UTF-8 JSON over a pipe, but Python picks the console codepage
# for stdout by default. On a Windows machine set to cp1256 that turns any
# transcript character outside the codepage into a UnicodeEncodeError that kills
# the process mid-job. Pin both streams to UTF-8 before writing anything.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable
        pass

_models: dict[str, object] = {}


def log(msg: str) -> None:
    print(f"[whisper-server] {msg}", file=sys.stderr, flush=True)


def get_model(size: str):
    """Load a model once and keep it resident."""
    if size not in _models:
        from faster_whisper import WhisperModel
        t0 = time.time()
        log(f"loading '{size}' (first use)")
        _models[size] = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=4)
        log(f"loaded '{size}' in {time.time() - t0:.1f}s")
    return _models[size]


def handle(req: dict) -> dict:
    rid = req.get("id")
    if req.get("cmd") == "shutdown":
        return {"id": rid, "ok": True, "shutdown": True}

    if req.get("cmd") == "ping":
        return {"id": rid, "ok": True, "loaded": list(_models.keys())}

    path = req.get("file", "")
    if not path or not os.path.exists(path):
        return {"id": rid, "ok": False, "message": f"Audio file not found: {path}"}

    model_size = req.get("model", "base")
    beam = int(req.get("beamSize", 1) or 1)
    try:
        model = get_model(model_size)
    except Exception as exc:  # noqa: BLE001
        return {"id": rid, "ok": False, "message": f"Could not load model '{model_size}': {exc}"}

    try:
        t0 = time.time()
        # word_timestamps is deliberately OFF: per-word alignment roughly
        # doubles transcribe time on this CPU, and the only timestamps the
        # edit needs are segment boundaries. The hard vocabulary list comes
        # from the language model, not from word alignment.
        segments, info = model.transcribe(
            path,
            beam_size=beam,
            language=req.get("language") or None,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            word_timestamps=False,
        )
        out = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            out.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": text,
            })
        elapsed = time.time() - t0
        log(f"transcribed {len(out)} segments in {elapsed:.1f}s")
        return {
            "id": rid,
            "ok": True,
            "language": getattr(info, "language", "") or "",
            "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
            "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
            "segments": out,
            "computeSeconds": round(elapsed, 2),
        }
    except Exception as exc:  # noqa: BLE001
        return {"id": rid, "ok": False, "message": f"Transcription failed: {exc}"}


def main() -> int:
    # Warm the default model immediately so the first real request is fast.
    warm = os.environ.get("VOICE_TUTOR_WARM_MODEL", "small")
    if warm:
        try:
            get_model(warm)
        except Exception as exc:  # noqa: BLE001
            log(f"warm-up failed: {exc}")

    print(json.dumps({"ready": True, "models": list(_models.keys())}), flush=True)
    log("ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "message": f"bad request: {exc}"}), flush=True)
            continue

        response = handle(req)
        print(json.dumps(response, ensure_ascii=False), flush=True)
        if response.get("shutdown"):
            break

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
