"""edge-tts worker: synthesize text to an mp3, or list available voices.

edge-tts is free and needs no API key, which is what makes the default path
work out of the box.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

# The parent reads UTF-8 JSON from this process, but Python defaults stdout to
# the console codepage. Arabic and Indonesian text would raise
# UnicodeEncodeError on a cp1256 machine, so pin the streams to UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable
        pass


def emit(payload: dict) -> None:
    sys.stdout.write("###RESULT###" + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def do_list() -> None:
    import edge_tts
    voices = await edge_tts.list_voices()
    emit({
        "ok": True,
        "voices": [
            {"name": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]}
            for v in voices
        ],
    })


async def do_speak(text: str, voice: str, out: str, rate: str) -> None:
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate)
    await comm.save(out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="")
    parser.add_argument("--voice", default="ar-EG-ShakirNeural")
    parser.add_argument("--out", default="")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    try:
        import edge_tts  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "message": "edge-tts is not installed. Run: pip install edge-tts", "detail": str(exc)})
        return 1

    try:
        if args.list:
            asyncio.run(do_list())
            return 0
        if not args.text.strip():
            emit({"ok": False, "message": "No text supplied."})
            return 1
        if not args.out:
            emit({"ok": False, "message": "No output path supplied."})
            return 1
        asyncio.run(do_speak(args.text, args.voice, args.out, args.rate))
        emit({"ok": True, "output": args.out, "voice": args.voice})
        return 0
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "message": f"edge-tts failed: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
