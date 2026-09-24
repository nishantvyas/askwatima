#!/usr/bin/env python3
"""Generates the hero photograph from the real product shot.

    export GEMINI_API_KEY=...            (or: set -a; . ../.gemini; set +a)
    python3 gen-hero.py [out.jpg]

Passes the Waveshare product photo in as a reference so the device in the
generated scene is the actual hardware rather than an invented gadget.
"""
import base64
import json
import mimetypes
import subprocess
import sys
import os

MODEL = os.environ.get("IMAGE_MODEL", "gemini-3-pro-image")
REF = os.environ.get("DEVICE_PHOTO",
                     os.path.expanduser("~/Desktop/61q1SHD+6AL._AC_SL1500_.jpg"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "public/hero.jpg"

PROMPT = """Wide banner photograph for the homepage of an educational device for
children. Cinematic 16:9.

COMPOSITION IS THE PRIORITY. The right third of the frame holds the child. The
left half must stay open, soft and uncluttered — a bright, gently out-of-focus
living room wall and window with plenty of empty light. Headline text will be
placed over that left half, so keep it calm, pale and free of detail or busy
pattern. Nothing important on the left.

THE CHILD: a boy about ten years old, sitting on a rug in a warm family living
room, positioned on the right of the frame. He holds a small round black object
up near his chin in one hand and is talking to it — mouth open mid-question,
head tilted slightly, eyes lit up with curiosity and delight. Caught in
conversation, not posing for a camera. He is looking at the object, not at us.

The object he holds is small, round, matte black and unremarkable — do not make
it the subject, do not add branding, screens full of imagery, or glowing
graphics. At most a faint soft green light at its centre. It should read as an
everyday thing in a child's hand.

BACKGROUND: further back and softly out of focus, two parents sit together on a
sofa, relaxed, smiling as they watch him. A mug of tea nearby. No phones, no
tablets, no television, no screens of any kind anywhere in the frame.

STYLE: natural editorial lifestyle photography, 50mm at f/2, warm late-afternoon
window light falling from the left. Airy and bright, gentle contrast. Honest
colour — cream, pale oak, muted sage, a little terracotta. A real lived-in home,
not a showroom. No text, no logos, no watermarks, no graphic overlays.
"""


def main():
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("set GEMINI_API_KEY first")
    if not os.path.exists(REF):
        sys.exit(f"reference photo not found: {REF}")

    mime = mimetypes.guess_type(REF)[0] or "image/jpeg"
    ref_b64 = base64.b64encode(open(REF, "rb").read()).decode()

    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"inlineData": {"mimeType": mime, "data": ref_b64}},
                {"text": PROMPT},
            ],
        }],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "16:9"},
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
            return
    sys.exit("no image in response: " + json.dumps(data)[:400])


if __name__ == "__main__":
    main()
