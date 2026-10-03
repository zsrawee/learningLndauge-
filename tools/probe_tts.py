"""Verify edge-tts can produce Arabic commentary and Indonesian speech.

edge-tts is free and needs no API key, which is what makes the no-key path
possible. This proves both languages synthesize to real audio files.
"""
import asyncio
import subprocess
from pathlib import Path

import edge_tts

OUT = Path(r"D:\Projects\anything\voice-tutor\.probe")
OUT.mkdir(parents=True, exist_ok=True)


async def list_relevant():
    voices = await edge_tts.list_voices()
    ar = [v for v in voices if v["Locale"].startswith("ar")]
    idn = [v for v in voices if v["Locale"].startswith("id")]
    print(f"total voices: {len(voices)}")
    print(f"\nArabic ({len(ar)}):")
    for v in ar:
        print(f"  {v['ShortName']:28} {v['Gender']:7} {v['Locale']}")
    print(f"\nIndonesian ({len(idn)}):")
    for v in idn:
        print(f"  {v['ShortName']:28} {v['Gender']:7} {v['Locale']}")
    return voices


async def synth(text, voice, path):
    comm = edge_tts.Communicate(text, voice)
    await comm.save(str(path))
    return path.stat().st_size


async def main():
    await list_relevant()

    print("\n--- synthesis test ---")
    cases = [
        ("ar-EG-ShakirNeural", "هذه الجملة تعني: صباح الخير. وهي تحية شائعة في إندونيسيا.", "arabic.mp3"),
        ("id-ID-ArdiNeural", "Selamat pagi, nama saya Budi.", "indonesian.mp3"),
    ]
    for voice, text, name in cases:
        path = OUT / name
        try:
            size = await synth(text, voice, path)
            # Confirm it is real audio, not an error page.
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", str(path)],
                capture_output=True, text=True,
            )
            dur = probe.stdout.strip()
            print(f"  {voice:26} {size:7} bytes  {dur:>6}s  OK")
        except Exception as exc:  # noqa: BLE001
            print(f"  {voice:26} FAILED: {str(exc)[:70]}")


asyncio.run(main())
