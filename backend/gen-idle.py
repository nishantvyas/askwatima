#!/usr/bin/env python3
"""Generates the default idle image shown on the device screen.

    export GEMINI_API_KEY=...            (or: set -a; . ../.gemini; set +a)
    python3 gen-idle.py [out.jpg]

The panel is a 466x466 ROUND AMOLED, so the image is generated square and the
corners are never seen - nothing that matters may live near them. It also has to
survive being shrunk to a 1.43 inch disc in a lit room, which rules out fine
detail and anything low in contrast.

Target is well under 100KB so it fits the same budget a parent's own upload gets.
"""
import base64
import json
import os
import subprocess
import sys

MODEL = os.environ.get("IMAGE_MODEL", "gemini-3-pro-image")
OUT = sys.argv[1] if len(sys.argv) > 1 else "public/idle-default.jpg"

PROMPT = """A square astrophotograph of a spiral galaxy, seen face on, centred
exactly in the frame.

COMPOSITION: the galaxy core sits dead centre and the spiral arms fade out well
before the edges. The image will be displayed inside a CIRCLE - the corners are
cut off and must contain nothing but empty space. Keep all structure within the
middle sixty percent of the frame.

THE GALAXY: a warm gold core falling to deep teal and violet arms, with dust
lanes visible against the glow. Scattered foreground stars, small and sharp, on
a near-black background. Rich but not garish - this sits in a child's bedroom and
glows in the dark.

STYLE: real astrophotography, the look of a long exposure through a good
telescope. Deep blacks, high contrast, luminous colour. Absolutely no text, no
labels, no constellation lines, no watermarks, no borders, no vignette ring, no
user interface of any kind. Nothing cartoonish.
"""


def main():
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("set GEMINI_API_KEY first")

    body = {
        "contents": [{"role": "user", "parts": [{"text": PROMPT}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "1:1"},
        },
    }

    # curl rather than urllib: the python.org build on macOS has no CA bundle.
    out = subprocess.run(
        ["curl", "-sS", "-X", "POST",
         f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
         "-H", f"x-goog-api-key: {key}",
         "-H", "Content-Type: application/json",
         "--data-binary", "@-"],
        input=json.dumps(body), capture_output=True, text=True, check=True,
    )

    data = json.loads(out.stdout)
    if "error" in data:
        sys.exit(f"{MODEL}: {data['error'].get('message')}")

    for part in data["candidates"][0]["content"]["parts"]:
        inline = part.get("inlineData") or part.get("inline_data")
        if inline:
            raw = base64.b64decode(inline["data"])
            with open(OUT, "wb") as f:
                f.write(raw)
            print(f"wrote {OUT}  ({len(raw)//1024} KB, {inline.get('mimeType')})")
            print("next: resize to 466x466 and re-encode under 100KB")
            return
    sys.exit("no image in response: " + json.dumps(data)[:400])


if __name__ == "__main__":
    main()
