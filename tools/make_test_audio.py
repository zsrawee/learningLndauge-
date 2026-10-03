"""Build a realistic Indonesian test clip using edge-tts neural voices.

The Windows SAPI voice is robotic and Whisper mangles it, which made the
pipeline look worse than it is. edge-tts produces natural speech, so this is a
fair test of what the user will actually feed in.
"""
import asyncio
import subprocess
import sys
from pathlib import Path

import edge_tts

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\Projects\anything\voice-tutor\data\tmp")
OUT.mkdir(parents=True, exist_ok=True)

PASSAGE = """
Selamat pagi semuanya. Nama saya Budi dan saya tinggal di Jakarta.
Hari ini saya ingin bercerita tentang kehidupan di kota besar.
Setiap pagi, jutaan orang berangkat kerja menggunakan kereta listrik.
Namun kemarahan lalu lintas tetap menjadi masalah yang rumit.
Pemerintah berusaha mengatasi hal ini dengan membangun jalan tol baru.
Meskipun demikian, banyak warga yang memilih bersepeda ke kantor.
""".strip()

async def main():
    voice = "id-ID-ArdiNeural"
    mp3 = OUT / "indonesian-natural.mp3"
    print(f"synthesizing with {voice} ...")
    await edge_tts.Communicate(PASSAGE, voice, rate="-10%").save(str(mp3))
    print(f"  wrote {mp3.stat().st_size} bytes")

    # Whisper and the slicer both want 16 kHz mono.
    wav = OUT / "indonesian-natural.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(mp3), "-ar", "16000", "-ac", "1", str(wav)],
        capture_output=True, check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(wav)],
        capture_output=True, text=True,
    )
    print(f"  normalized: {wav.stat().st_size} bytes, {probe.stdout.strip()}s")

asyncio.run(main())
